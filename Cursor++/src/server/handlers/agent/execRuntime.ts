import type { AgentServerMessage } from '../../gen/agent_v1_pb';
import { logger } from '../../logger';
import type { ProviderRoundContext } from '../llm/providerRuntime';
import type { LLMContentBlock, LLMMessage } from '../llm/types';
import {
    buildExecToolResult,
    buildShellToolResult,
    type ToolResultEnvelope,
} from './toolResults';
import { finalizeToolCall } from './toolLifecycle';
import { execAbort, shellToolCallStderrDelta, shellToolCallStdoutDelta } from './stream';
import { clearBackgroundJobs, registerBackgroundJob, type AgentSession } from './session';
import { activeExecMessageIds, closeExecChannel } from './execChannels';
import { createBoundedOutputBuffer } from './toolkit/results/shellOutputBuffer';
import type { ShellStreamFailureReason } from './toolkit/results/shellToolResults';
import type { ReadContextState } from './contextCatalog';
import {
    isAgentRunAbortedError,
    releaseExec,
    waitForExecClientMessageWithHeartbeat,
    waitForExecStreamCloseWithHeartbeat,
    waitForShellExecEventWithHeartbeat,
} from './wait';

/**
 * 归一化 ShellBackgroundReason(toJson 后可能是 enum 字符串名或数字)。
 * 0=UNSPECIFIED, 1=TIMEOUT, 2=USER_REQUEST (gen: agent.v1.ShellBackgroundReason)。
 */
function normalizeShellBackgroundReason(value: unknown): number | undefined {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value !== 'string') return undefined;
    switch (value.trim()) {
        case 'SHELL_BACKGROUND_REASON_UNSPECIFIED':
        case 'UNSPECIFIED':
            return 0;
        case 'SHELL_BACKGROUND_REASON_TIMEOUT':
        case 'TIMEOUT':
            return 1;
        case 'SHELL_BACKGROUND_REASON_USER_REQUEST':
        case 'USER_REQUEST':
            return 2;
        default: {
            const parsed = Number(value);
            return Number.isFinite(parsed) ? parsed : undefined;
        }
    }
}

/**
 * Ask the client to abort every exec still in flight and forget this run's background
 * job registrations.
 *
 * The server never owns a process, so "reclaiming" an exec means telling the executor
 * that runs it to stop: `ExecServerControlMessage.abort` is the only termination
 * capability the protocol exposes. Channels are closed right after, because nobody will
 * consume their events once the run is over.
 *
 * Note that already-backgrounded shells are out of reach: their exec has ended, and the
 * protocol offers no shell_id-addressed kill.
 */
export function* abortInFlightExecs(
    session: AgentSession,
    reason: string,
): Generator<AgentServerMessage, void, void> {
    const execMessageIds = activeExecMessageIds(session);
    for (const execMessageId of execMessageIds) {
        yield execAbort(execMessageId);
        closeExecChannel(session, execMessageId);
    }
    const backgroundJobs = clearBackgroundJobs(session);
    if (execMessageIds.length > 0 || backgroundJobs.length > 0) {
        logger.info({
            requestId: session.requestId,
            reason,
            abortedExecs: execMessageIds,
            backgroundJobs: backgroundJobs.length,
        }, '[EXEC] aborting in-flight execs after run interruption');
    }
}

export interface FinalizeExecToolParams {
    session: AgentSession;
    toolName: string;
    callId: string;
    cursorToolType: string;
    execMessageId: number;
    modelCallId: string;
    startedArgs: Record<string, unknown>;
    input: Record<string, unknown>;
    roundContext: Pick<ProviderRoundContext, 'createToolResult' | 'recordToolResult'>;
    messages: LLMMessage[];
    imageCollector?: LLMContentBlock[];
    readContext?: ReadContextState;
}

/**
 * Drive one exec to completion: stream its events, build the tool result, emit the
 * completion frame.
 *
 * Wraps the exec lifecycle so that whatever happens the exec's event channel is
 * released, and an interrupted run reclaims every exec still in flight.
 */
export async function* finalizeExecTool(
    params: FinalizeExecToolParams,
): AsyncGenerator<AgentServerMessage, AgentServerMessage, void> {
    try {
        return yield* runExecToCompletion(params);
    } catch (error) {
        if (isAgentRunAbortedError(error)) {
            // An error carrying an execMessageId is the client telling us it already gave
            // up on that exec — only the other in-flight execs still need reclaiming.
            if (error.execMessageId !== undefined)
                releaseExec(params.session, error.execMessageId);
            yield* abortInFlightExecs(params.session, error.message);
        }
        throw error;
    } finally {
        releaseExec(params.session, params.execMessageId);
    }
}

async function* runExecToCompletion(
    params: FinalizeExecToolParams,
): AsyncGenerator<AgentServerMessage, AgentServerMessage, void> {
    let toolResult: ToolResultEnvelope = { result: { case: 'error', value: { message: 'no result' } } };
    let completedFrame: AgentServerMessage | null = null;

    if (params.cursorToolType === 'shellToolCall') {
        // Bounded accumulation (see shellOutputBuffer.ts) — a chatty command must not be
        // able to grow the run's heap without limit.
        const stdoutBuffer = createBoundedOutputBuffer();
        const stderrBuffer = createBoundedOutputBuffer();
        let exitCode = 0;
        let cwd = '';
        let localExecTime = 0;
        let rejected: { reason?: string } | undefined;
        let permissionDenied: { command?: string; workingDirectory?: string; error?: string } | undefined;
        let backgrounded: { shellId: number; pid?: number; msToWait?: number; reason?: number; terminalsFolder?: string } | undefined;
        /**
         * Explicit terminal state. Only exit / backgrounded / rejected / permissionDenied
         * are terminal; a stream that ends any other way leaves the exit status unknown
         * and must not be reported as exitCode=0 success.
         */
        let terminalState: 'exit' | 'backgrounded' | 'rejected' | 'permissionDenied' | null = null;
        let streamFailure: { reason: ShellStreamFailureReason } | undefined;

        const processShellMessage = function* (shellMsg: Record<string, unknown>): Generator<AgentServerMessage, void, void> {
            if ('execClientMessage' in shellMsg) {
                const ecm = shellMsg.execClientMessage as Record<string, unknown>;
                const ss = ecm.shellStream as Record<string, unknown> | undefined;
                if (ss?.stdout) {
                    const chunk = String((ss.stdout as Record<string, unknown>).data ?? '');
                    stdoutBuffer.append(chunk);
                    if (chunk) yield shellToolCallStdoutDelta(params.callId, chunk, params.modelCallId);
                }
                if (ss?.stderr) {
                    const chunk = String((ss.stderr as Record<string, unknown>).data ?? '');
                    stderrBuffer.append(chunk);
                    if (chunk) yield shellToolCallStderrDelta(params.callId, chunk, params.modelCallId);
                }
                if (ss?.permissionDenied) {
                    const denied = ss.permissionDenied as Record<string, unknown>;
                    permissionDenied = {
                        command: typeof denied.command === 'string' ? denied.command : undefined,
                        workingDirectory: typeof denied.workingDirectory === 'string' ? denied.workingDirectory : undefined,
                        error: typeof denied.error === 'string' ? denied.error : undefined,
                    };
                    terminalState = 'permissionDenied';
                }
                if (ss?.rejected) {
                    const rejectedPayload = ss.rejected as Record<string, unknown>;
                    rejected = { reason: typeof rejectedPayload.reason === 'string' ? rejectedPayload.reason : undefined };
                    terminalState = 'rejected';
                }
                if (ss?.backgrounded) {
                    // 命令转后台 (ShellStreamBackgrounded)。执行侧主导转后台,server 是接收方:
                    // 提取 shellId/pid/msToWait/reason, 登记后台 job 供后续 AwaitShell 分流,
                    // 并据此构造"已转后台"结果(而非误把片段输出当 exitCode=0 成功)。
                    const bg = ss.backgrounded as Record<string, unknown>;
                    const shellId = typeof bg.shellId === 'number' ? bg.shellId : Number(bg.shellId);
                    const pid = typeof bg.pid === 'number' ? bg.pid : undefined;
                    const msToWait = typeof bg.msToWait === 'number' ? bg.msToWait : undefined;
                    const reason = normalizeShellBackgroundReason(bg.reason);
                    const terminalsFolder = params.session.terminalsFolder;
                    backgrounded = {
                        shellId,
                        ...(pid !== undefined ? { pid } : {}),
                        ...(msToWait !== undefined ? { msToWait } : {}),
                        ...(reason !== undefined ? { reason } : {}),
                        ...(terminalsFolder ? { terminalsFolder } : {}),
                    };
                    if (Number.isFinite(shellId)) {
                        registerBackgroundJob(params.session, String(shellId), {
                            kind: 'shell',
                            shellId,
                            terminalsFolder,
                            command: typeof bg.command === 'string' ? bg.command : (typeof params.input.command === 'string' ? params.input.command : undefined),
                        });
                    }
                    logger.info({ tool: params.toolName, callId: params.callId, shellId, reason, msToWait }, '[TOOL] shell moved to background');
                    terminalState = 'backgrounded';
                }
                if (ss?.exit) {
                    const exit = ss.exit as Record<string, unknown>;
                    cwd = typeof exit.cwd === 'string' ? exit.cwd : '';
                    localExecTime = typeof exit.localExecutionTimeMs === 'number' ? exit.localExecutionTimeMs : 0;
                    exitCode = typeof exit.code === 'number' ? (exit.code | 0) : 0;
                    terminalState = 'exit';
                }
            }
            if ('execClientControlMessage' in shellMsg) {
                const ctrl = shellMsg.execClientControlMessage as Record<string, unknown>;
                // streamClose ends the stream whatever state we are in, but it is not a
                // terminal event: arriving before exit means the command's fate is unknown.
                if (ctrl.streamClose && terminalState === null)
                    streamFailure = { reason: 'streamClosedBeforeExit' };
            }
        };

        logger.info({ tool: params.toolName, callId: params.callId }, '[TOOL] waiting for shell approval/execution start');
        while (terminalState === null && streamFailure === undefined) {
            const shellMsg = yield* waitForShellExecEventWithHeartbeat(params.session, params.execMessageId, null);
            if (!shellMsg) {
                // Cancellation surfaces as AgentRunAbortedError from the waiter, so a null
                // here is a dropped/timed-out stream, not a user interrupt.
                streamFailure = { reason: 'streamEndedWithoutExit' };
                break;
            }
            yield* processShellMessage(shellMsg);
        }

        if (streamFailure) {
            logger.warn({
                tool: params.toolName,
                callId: params.callId,
                execMessageId: params.execMessageId,
                reason: streamFailure.reason,
                stdoutChars: stdoutBuffer.totalChars,
                stderrChars: stderrBuffer.totalChars,
            }, '[TOOL] shell stream ended without a terminal event');
        }

        const finalized = finalizeToolCall({
            roundContext: params.roundContext,
            messages: params.messages,
                        cursorToolType: params.cursorToolType,
            toolName: params.toolName,
            callId: params.callId,
            startedArgs: params.startedArgs,
            rawToolResult: buildShellToolResult(params.input, {
                stdout: stdoutBuffer.text,
                stderr: stderrBuffer.text,
                exitCode,
                cwd,
                localExecutionTimeMs: localExecTime,
                rejected,
                permissionDenied,
                backgrounded,
                streamFailure,
            }),
            input: params.input,
            modelCallId: params.modelCallId,
        });
        toolResult = finalized.toolResult;
        completedFrame = finalized.frame;
        if (finalized.imageBlock && params.imageCollector)
            params.imageCollector.push(finalized.imageBlock);
        logger.info({
            tool: params.toolName,
            terminalState: terminalState ?? 'none',
            stdoutChars: stdoutBuffer.totalChars,
            stderrChars: stderrBuffer.totalChars,
            elidedChars: stdoutBuffer.elidedChars + stderrBuffer.elidedChars,
            exitCode,
            execTime: localExecTime,
        }, '[TOOL] shell exec completed');
    } else {
        const execResult = yield* waitForExecClientMessageWithHeartbeat(
            params.session,
            params.execMessageId,
            null,
        );
        if (execResult && 'execClientMessage' in execResult) {
            const ecm = execResult.execClientMessage as Record<string, unknown>;
            const finalized = finalizeToolCall({
                roundContext: params.roundContext,
                messages: params.messages,
                                cursorToolType: params.cursorToolType,
                toolName: params.toolName,
                callId: params.callId,
                startedArgs: params.startedArgs,
                rawToolResult: buildExecToolResult(params.cursorToolType, ecm, params.input),
                input: params.input,
                modelCallId: params.modelCallId,
                readContext: params.readContext,
            });
            toolResult = finalized.toolResult;
            completedFrame = finalized.frame;
            if (finalized.imageBlock && params.imageCollector)
                params.imageCollector.push(finalized.imageBlock);
            logger.info({ tool: params.toolName }, '[TOOL] exec result received');
        } else {
            // The generic `no result` fallback must never be what the model sees: say
            // which exec ended and how, so the failure is diagnosable from the transcript.
            toolResult = {
                result: {
                    case: 'error',
                    value: {
                        message: `Exec stream for ${params.toolName} ended without a result `
                            + '(the client closed the stream or the wait timed out).',
                    },
                },
            };
            logger.warn({
                tool: params.toolName,
                callId: params.callId,
                execMessageId: params.execMessageId,
            }, '[TOOL] exec ended without result');
        }

        yield* waitForExecStreamCloseWithHeartbeat(
            params.session,
            params.execMessageId,
            null,
        );
    }

    if (!completedFrame) {
        const finalized = finalizeToolCall({
            roundContext: params.roundContext,
            messages: params.messages,
                        cursorToolType: params.cursorToolType,
            toolName: params.toolName,
            callId: params.callId,
            startedArgs: params.startedArgs,
            rawToolResult: toolResult,
            input: params.input,
            modelCallId: params.modelCallId,
        });
        completedFrame = finalized.frame;
    }

    yield completedFrame;
    return completedFrame;
}
