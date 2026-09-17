/**
 * AwaitShell — background shell polling.
 *
 * A backgrounded shell keeps writing to `{terminalsFolder}/{shellId}.txt`; the file
 * header carries `pid` / `running_for_ms` and, once the command is over, a footer with
 * `exit_code` and `elapsed_ms` is appended. AwaitShell is the model's only way to follow
 * that file, and the tool contract says it blocks for up to `block_until_ms`.
 *
 * Reading the file exactly once (as the tool used to do) breaks that contract in the
 * worst possible way: the model gets a snapshot that is already stale by the time it is
 * rendered, concludes the command is stuck, and polls again — burning a round trip per
 * poll. This module instead keeps reading the file inside the single tool call until the
 * command finishes, the caller's regex matches, or the budget runs out, and labels the
 * returned snapshot accordingly.
 */
import type { AgentServerMessage } from '../../gen/agent_v1_pb';
import { logger } from '../../logger';
import type { ProviderRoundContext } from '../llm/providerRuntime';
import type { LLMContentBlock, LLMMessage } from '../llm/types';
import type { AgentSession } from './session';
import { execMessage } from './stream';
import { finalizeToolCall } from './toolLifecycle';
import { buildExecToolResult, type ToolResultEnvelope } from './toolResults';
import { annotateShellAwaitResult } from './toolkit/results/awaitToolResults';
import { awaitExecResultAndClose, throwIfSessionCancelled } from './wait';

/** Upper bound of a single AwaitShell call, whatever the model asks for. */
const MAX_BLOCK_UNTIL_MS = 600_000;
const DEFAULT_BLOCK_UNTIL_MS = 30_000;
/** A single terminal-file read should be near-instant; do not let one hang the poll loop. */
const READ_TIMEOUT_MS = 30_000;
const MIN_POLL_INTERVAL_MS = 500;
const MAX_POLL_INTERVAL_MS = 5_000;

/** Why the poll loop stopped. */
export type AwaitOutcome = 'completed' | 'patternMatched' | 'stillRunning' | 'unreadable';

/**
 * True once the terminal file carries the completion footer.
 *
 * The footer is the executor's own end-of-command marker (`exit_code` + `elapsed_ms`),
 * which is why we key on it rather than on the output going quiet.
 */
export function hasTerminalFooter(content: string): boolean {
    return /^\s*exit_code:\s*-?\d+\s*$/m.test(content);
}

/**
 * Backoff between two reads: fast while output keeps arriving, exponential once the file
 * goes quiet (the schedule the tool description tells the model to use).
 */
export function nextPollDelayMs(idlePolls: number): number {
    return Math.min(MAX_POLL_INTERVAL_MS, MIN_POLL_INTERVAL_MS * 2 ** Math.max(0, idlePolls));
}

export function clampBlockUntilMs(value: unknown): number {
    if (typeof value !== 'number' || !Number.isFinite(value)) return DEFAULT_BLOCK_UNTIL_MS;
    return Math.min(MAX_BLOCK_UNTIL_MS, Math.max(0, Math.trunc(value)));
}

/** Compile the caller's `pattern`; an unusable regex is ignored rather than failing the call. */
function compilePattern(pattern: string | undefined, callId: string): RegExp | null {
    if (!pattern) return null;
    try {
        return new RegExp(pattern, 'm');
    } catch (e) {
        logger.warn({ callId, pattern, error: (e as Error).message }, '[TOOL] AwaitShell pattern is not a valid regex, ignoring');
        return null;
    }
}

/** Terminal file text of a readResult, or null when the read did not return text. */
function extractTerminalSnapshot(execClientMsg: Record<string, unknown> | null): string | null {
    const readResult = execClientMsg?.readResult as Record<string, unknown> | undefined;
    const success = readResult?.success as Record<string, unknown> | undefined;
    return typeof success?.content === 'string' ? success.content : null;
}

function delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

export interface ShellAwaitParams {
    session: AgentSession;
    toolName: string;
    callId: string;
    cursorToolType: string;
    modelCallId: string;
    startedArgs: Record<string, unknown>;
    input: Record<string, unknown>;
    /** readArgs payload of one poll (path / offset / limit / toolCallId). */
    readArgs: Record<string, unknown>;
    blockUntilMs: number;
    pattern?: string;
    allocateExecMessageId: () => number;
    roundContext: Pick<ProviderRoundContext, 'createToolResult' | 'recordToolResult'>;
    messages: LLMMessage[];
    imageCollector?: LLMContentBlock[];
}

/**
 * Poll the terminal file until the command completes, the pattern matches, or the
 * `block_until_ms` budget is exhausted, then finalize the tool call with the last
 * snapshot read.
 */
export async function* finalizeShellAwaitTool(
    params: ShellAwaitParams,
): AsyncGenerator<AgentServerMessage, void, void> {
    const startedAt = Date.now();
    const deadline = startedAt + params.blockUntilMs;
    const pattern = compilePattern(params.pattern, params.callId);

    let polls = 0;
    let idlePolls = 0;
    let lastSnapshotLength = -1;
    let lastExecClientMsg: Record<string, unknown> | null = null;
    let outcome: AwaitOutcome = 'unreadable';

    for (;;) {
        polls++;
        const execMessageId = params.allocateExecMessageId();
        yield execMessage(execMessageId, `${params.callId}-exec-${polls}`, 'readArgs', params.readArgs);
        const frame = await awaitExecResultAndClose(params.session, execMessageId, READ_TIMEOUT_MS);
        const execClientMsg = frame && 'execClientMessage' in frame
            ? frame.execClientMessage as Record<string, unknown>
            : null;
        if (execClientMsg) lastExecClientMsg = execClientMsg;

        const snapshot = extractTerminalSnapshot(execClientMsg);
        if (snapshot !== null) {
            if (hasTerminalFooter(snapshot)) {
                outcome = 'completed';
                break;
            }
            if (pattern?.test(snapshot)) {
                outcome = 'patternMatched';
                break;
            }
            idlePolls = snapshot.length > lastSnapshotLength ? 0 : idlePolls + 1;
            lastSnapshotLength = snapshot.length;
            outcome = 'stillRunning';
        }

        const remainingMs = deadline - Date.now();
        if (remainingMs <= 0) break;
        await delay(Math.min(remainingMs, nextPollDelayMs(idlePolls)));
        throwIfSessionCancelled(params.session);
    }

    const waitedMs = Date.now() - startedAt;
    logger.info({
        tool: params.toolName,
        callId: params.callId,
        outcome,
        polls,
        waitedMs,
        blockUntilMs: params.blockUntilMs,
    }, '[TOOL] AwaitShell polling finished');

    const rawToolResult: ToolResultEnvelope = lastExecClientMsg
        ? annotateShellAwaitResult(
            buildExecToolResult(params.cursorToolType, lastExecClientMsg, params.input),
            { outcome, polls, waitedMs },
        )
        : {
            result: {
                case: 'error',
                value: {
                    error: `AwaitShell could not read the terminal output file after ${polls} attempt(s) `
                        + `over ${waitedMs}ms; the background job may no longer exist.`,
                },
            },
        };

    const finalized = finalizeToolCall({
        roundContext: params.roundContext,
        messages: params.messages,
        cursorToolType: params.cursorToolType,
        toolName: params.toolName,
        callId: params.callId,
        startedArgs: params.startedArgs,
        rawToolResult,
        input: params.input,
        modelCallId: params.modelCallId,
    });
    if (finalized.imageBlock && params.imageCollector)
        params.imageCollector.push(finalized.imageBlock);
    yield finalized.frame;
}
