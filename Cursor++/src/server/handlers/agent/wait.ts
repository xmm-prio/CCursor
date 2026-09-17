import { closeExecChannel } from './execChannels';
import { waitForExecEventMatching, type AgentSession } from './session';

export class AgentRunAbortedError extends Error {
    readonly execMessageId?: number;
    readonly clientStackTrace?: string;

    constructor(message: string, opts?: { execMessageId?: number; clientStackTrace?: string }) {
        super(message);
        this.name = 'AgentRunAbortedError';
        this.execMessageId = opts?.execMessageId;
        this.clientStackTrace = opts?.clientStackTrace;
    }
}

export function isAgentRunAbortedError(error: unknown): error is AgentRunAbortedError {
    return error instanceof AgentRunAbortedError;
}

/**
 * A client message this exec was waiting for is provably gone (see linkHealth.ts).
 *
 * Distinct from AgentRunAbortedError on purpose: an abort is the client saying "stop",
 * and the run ends quietly; a lost uplink is a transport failure the user can recover
 * from by retrying, so it has to travel up to AgentService and become a retryable
 * ConnectError with a banner.
 */
export class ExecLinkLostError extends Error {
    readonly execMessageId: number;

    constructor(execMessageId: number) {
        super(
            `the client message for exec ${execMessageId} was lost in transit `
            + '(a gap in the BidiAppend sequence was never filled)',
        );
        this.name = 'ExecLinkLostError';
        this.execMessageId = execMessageId;
    }
}

export function isExecLinkLostError(error: unknown): error is ExecLinkLostError {
    return error instanceof ExecLinkLostError;
}

/**
 * 客户端已发 cancelAction 则抛出中断,把控制权交回 conversationRuntime /
 * agentOrchestrator 的 isAgentRunAbortedError 分支干净收尾。
 *
 * 放在每个可能长时间停留的位置调用: 工具等待返回后、LLM 流每个事件、
 * round 边界。中断粒度因此收敛到单个事件而非整轮。
 */
export function throwIfSessionCancelled(session: AgentSession): void {
    if (session.cancelledReason === undefined)
        return;
    throw new AgentRunAbortedError(`client cancelled the run: ${session.cancelledReason}`);
}

/**
 * Release the event channel of an exec — call once the tool call owning it is done,
 * whether it completed, failed, or was aborted.
 */
export function releaseExec(session: AgentSession, execMessageId: number): void {
    closeExecChannel(session, execMessageId);
}

export function isExecClientMessageForId(msg: Record<string, unknown>, execMessageId: number): boolean {
    return 'execClientMessage' in msg
        && Number((msg.execClientMessage as Record<string, unknown>).id) === execMessageId;
}

export function isExecStreamCloseForId(msg: Record<string, unknown>, execMessageId: number): boolean {
    if (!('execClientControlMessage' in msg)) return false;
    const ctrl = msg.execClientControlMessage as Record<string, unknown>;
    const streamClose = ctrl.streamClose as Record<string, unknown> | undefined;
    return Number(streamClose?.id) === execMessageId;
}

function getExecThrowForId(msg: Record<string, unknown>, execMessageId: number): Record<string, unknown> | null {
    if (!('execClientControlMessage' in msg)) return null;
    const ctrl = msg.execClientControlMessage as Record<string, unknown>;
    const thrown = ctrl.throw as Record<string, unknown> | undefined;
    if (!thrown) return null;
    return Number(thrown.id) === execMessageId ? thrown : null;
}

function buildExecAbortError(execThrow: Record<string, unknown>, execMessageId: number): AgentRunAbortedError {
    const error = typeof execThrow.error === 'string' && execThrow.error.trim().length > 0
        ? execThrow.error
        : 'exec client aborted the current run';
    const clientStackTrace = typeof execThrow.stackTrace === 'string' ? execThrow.stackTrace : undefined;
    return new AgentRunAbortedError(error, { execMessageId, clientStackTrace });
}

export async function waitForExecMessageMatching(
    session: AgentSession,
    execMessageId: number,
    predicate: (msg: Record<string, unknown>) => boolean,
    timeoutMs: number | null,
): Promise<Record<string, unknown> | null> {
    const outcome = await waitForExecEventMatching(
        session,
        execMessageId,
        (candidate) => predicate(candidate) || !!getExecThrowForId(candidate, execMessageId),
        timeoutMs,
    );
    // 客户端中断 (cancelAction) 会让等待立即结束。
    // 转成 AgentRunAbortedError,与 exec throw 走同一条干净收尾路径 ——
    // 否则工具会拿着 null 结果继续往下跑。
    throwIfSessionCancelled(session);
    // A lost uplink must not look like "the tool returned nothing": that would be written
    // into the transcript as a real (empty) result and the model would carry on.
    if (outcome.kind === 'linkLost') throw new ExecLinkLostError(execMessageId);
    if (outcome.kind === 'ended') return null;

    const msg = outcome.event;
    const execThrow = getExecThrowForId(msg, execMessageId);
    if (execThrow) {
        throw buildExecAbortError(execThrow, execMessageId);
    }
    return msg;
}

/**
 * Wait for this exec's result message.
 *
 * Callers used to wrap every one of these in a heartbeat-emitting generator. Keeping the
 * connection alive is now the turn envelope's job (turnKeepAlive.ts), so these are plain
 * promises again and the call sites are plain `await`s.
 */
export function waitForExecClientMessage(
    session: AgentSession,
    execMessageId: number,
    timeoutMs: number | null = null,
): Promise<Record<string, unknown> | null> {
    return waitForExecMessageMatching(
        session,
        execMessageId,
        (msg) => isExecClientMessageForId(msg, execMessageId),
        timeoutMs,
    );
}

/** 等待 exec 的 streamClose 控制消息。 */
export function waitForExecStreamClose(
    session: AgentSession,
    execMessageId: number,
    timeoutMs: number | null = null,
): Promise<Record<string, unknown> | null> {
    return waitForExecMessageMatching(
        session,
        execMessageId,
        (msg) => isExecStreamCloseForId(msg, execMessageId),
        timeoutMs,
    );
}

/** 等待 shell exec 的下一个事件 —— 结果或流关闭,先到者返回。 */
export function waitForShellExecEvent(
    session: AgentSession,
    execMessageId: number,
    timeoutMs: number | null = null,
): Promise<Record<string, unknown> | null> {
    return waitForExecMessageMatching(
        session,
        execMessageId,
        (msg) => isExecClientMessageForId(msg, execMessageId) || isExecStreamCloseForId(msg, execMessageId),
        timeoutMs,
    );
}

/** 等待 exec result + stream close（Promise 形式，用于 Promise.all 并发） */
export async function awaitExecResultAndClose(
    session: AgentSession,
    execMessageId: number,
    timeoutMs: number | null = null,
): Promise<Record<string, unknown> | null> {
    try {
        const execResult = await waitForExecMessageMatching(
            session,
            execMessageId,
            msg => isExecClientMessageForId(msg, execMessageId),
            timeoutMs,
        );
        await waitForExecMessageMatching(
            session,
            execMessageId,
            msg => isExecStreamCloseForId(msg, execMessageId),
            5_000,
        ).catch(() => {});
        return execResult;
    } finally {
        releaseExec(session, execMessageId);
    }
}
