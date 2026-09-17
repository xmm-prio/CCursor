/**
 * AwaitShell (awaitToolCall) 结果构造
 *
 * AwaitShell 按后台 job 类型走两个 exec 通道,回传两种结果:
 *   - shell job  : readArgs → readResult (读取 {terminalsFolder}/{shellId}.txt 终端文件)
 *   - subagent job: subagentAwaitArgs → subagentAwaitResult
 *       oneof: complete{agentId, transcriptPath, toolCallCount, finalMessage}
 *            / still_running{agentId, transcriptPath}
 *            / not_found{agentId}
 *            / error{agentId, error}
 *   (gen: agent.v1.SubagentAwaitResult, main.unminify.js:30043)
 *
 * 终端文件读取的结果与 readToolCall 一致 (readResult),
 * 因此 shell 分支复用 file 结果链路;本模块仅新增 subagentAwaitResult 处理。
 */
import {
    bool,
    num,
    obj,
    resultCase,
    str,
    truncate,
    type ToolResultEnvelope,
} from './shared';

/**
 * 把 awaitToolCall 的 exec 结果转成 ToolResultEnvelope。
 *
 * 返回 null 表示这不是一个 await 能处理的结果 (交给调用链下游)。
 */
export function buildAwaitExecToolResult(
    cursorToolType: string,
    execClientMsg: Record<string, unknown>,
    input: Record<string, unknown>,
): ToolResultEnvelope | null {
    if (cursorToolType !== 'awaitToolCall') return null;

    // subagent await 通道
    if (execClientMsg.subagentAwaitResult !== undefined) {
        const sar = obj(execClientMsg.subagentAwaitResult);
        const rc = resultCase(sar); // { case: 'complete'|'stillRunning'|'notFound'|'error', value }
        if (rc) {
            return { result: { case: rc.case, value: rc.value } };
        }
        return { result: { case: 'error', value: { error: 'empty subagent await result' } } };
    }

    // shell await 通道: 终端文件读取 (readResult)
    if (execClientMsg.readResult !== undefined) {
        const rr = obj(execClientMsg.readResult);
        if (rr.success) {
            const success = obj(rr.success);
            const output = success.data !== undefined
                ? { case: 'data', value: success.data }
                : { case: 'content', value: str(success.content) };
            return {
                result: {
                    case: 'success',
                    value: {
                        path: str(success.path, str(input.path)),
                        totalLines: num(success.totalLines),
                        fileSize: success.fileSize ?? 0,
                        truncated: bool(success.truncated),
                        rangeApplied: bool(success.rangeApplied),
                        ...(success.outputBlobId ? { outputBlobId: success.outputBlobId } : {}),
                        ...(success.readRange ? { readRange: obj(success.readRange) } : {}),
                        output,
                    },
                },
            };
        }
        const rc = resultCase(rr);
        return rc ? { result: rc } : { result: { case: 'error', value: { path: str(input.path), error: 'no result' } } };
    }

    return null;
}

/** How a bounded AwaitShell poll loop ended (see awaitRuntime.ts). */
export interface ShellAwaitStatus {
    outcome: 'completed' | 'patternMatched' | 'stillRunning' | 'unreadable';
    polls: number;
    waitedMs: number;
}

function buildAwaitStatusNote(status: ShellAwaitStatus): string {
    const waited = `after polling for ${status.waitedMs}ms (${status.polls} read${status.polls === 1 ? '' : 's'})`;
    switch (status.outcome) {
        case 'completed':
            return `[AwaitShell] The command finished ${waited}; the exit_code footer above is final.`;
        case 'patternMatched':
            return `[AwaitShell] The requested pattern matched ${waited}; the command is still running.`;
        default:
            return `[AwaitShell] The command is still running ${waited}; `
                + 'this is a snapshot, not the final output. Poll again to keep monitoring.';
    }
}

/**
 * Append the poll-loop verdict to a terminal-file snapshot.
 *
 * Without it the model cannot tell "finished" from "still running" — both come back as
 * a successful file read — which is exactly how a stale snapshot gets mistaken for the
 * final output.
 */
export function annotateShellAwaitResult(
    envelope: ToolResultEnvelope,
    status: ShellAwaitStatus,
): ToolResultEnvelope {
    const value = obj(envelope.result?.value);
    const output = obj(value.output);
    if (envelope.result?.case !== 'success' || output.case !== 'content') return envelope;
    return {
        result: {
            case: 'success',
            value: {
                ...value,
                output: { case: 'content', value: `${str(output.value)}\n\n${buildAwaitStatusNote(status)}` },
            },
        },
    };
}

export function normalizeAwaitToolResult(
    cursorToolType: string,
    resultCaseName: string,
    value: Record<string, unknown>,
): ToolResultEnvelope | null {
    if (cursorToolType !== 'awaitToolCall') return null;
    // await 结果原样保留 (case 形态已规整)。
    return { result: { case: resultCaseName || 'error', value } };
}

export function buildAwaitToolResultText(
    cursorToolType: string,
    resultCaseName: string,
    value: Record<string, unknown>,
): string | null {
    if (cursorToolType !== 'awaitToolCall') return null;

    switch (resultCaseName) {
        // ── subagent await ──
        case 'complete': {
            const finalMessage = str(value.finalMessage).trim();
            const transcriptPath = str(value.transcriptPath).trim();
            const parts: string[] = [];
            if (finalMessage) parts.push(finalMessage);
            if (transcriptPath) parts.push(`[Subagent transcript: ${transcriptPath}]`);
            const body = parts.join('\n\n').trim();
            return body || `Subagent completed${str(value.agentId) ? `: ${str(value.agentId)}` : ''}`;
        }
        case 'stillRunning': {
            const transcriptPath = str(value.transcriptPath).trim();
            return `Subagent ${str(value.agentId)} is still running.`
                + (transcriptPath ? ` [transcript: ${transcriptPath}]` : '')
                + ' Poll again with AwaitShell to keep monitoring.';
        }
        case 'notFound':
            return `No background job found for id ${str(value.agentId)}.`;
        case 'error':
            return `Await error${str(value.agentId) ? ` for ${str(value.agentId)}` : ''}: ${str(value.error, 'unknown error')}`;
        // ── shell await: 终端文件内容 (success = readResult) ──
        case 'success': {
            const output = obj(value.output);
            if (output.case === 'content' && typeof output.value === 'string') return truncate(output.value, 12000);
            if (typeof output.content === 'string') return truncate(output.content, 12000);
            return truncate(JSON.stringify(value));
        }
        default:
            return `Await ${resultCaseName || 'error'}: ${JSON.stringify(value)}`;
    }
}
