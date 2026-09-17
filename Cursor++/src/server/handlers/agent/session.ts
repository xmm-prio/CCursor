/**
 * Agent Session 管理
 *
 * SSE 降级模式下，Client 通过两个独立通道通信:
 *   - BidiAppend (unary) — 发送 AgentClientMessage (data=base64 proto)
 *   - RunSSE (server_streaming) — 接收 AgentServerMessage 流
 *
 * 两者通过 requestId 关联。Session 维护一个 per-requestId 的消息队列，
 * BidiAppend 写入消息，RunSSE 消费消息并驱动 LLM 调用。
 */
import { fromBinary, toJson } from '@bufbuild/protobuf';
import { AgentClientMessageSchema } from '../../gen/agent_v1_pb';
import { logger } from '../../logger';
import {
    acquireExecWaiter,
    clearExecChannels,
    createExecChannelRegistry,
    releaseExecWaiter,
    routeExecEvent,
    takeExecEvent,
    type ExecChannel,
} from './execChannels';
import {
    createLinkHealth,
    isLinkLost,
    linkHealthSnapshot,
    msUntilLinkLoss,
    observeAppend,
    reportLinkLoss,
    type LinkHealth,
} from './linkHealth';

/**
 * 后台 job 登记项。
 *
 * Shell 转后台(ShellStreamBackgrounded)与 Subagent 转后台(SubagentSuccess.backgroundReason)后,
 * LLM 会在后续轮次调用 AwaitShell(task_id=...) 轮询其状态。AwaitShell 需要据 task_id 区分:
 *   - shell  : 走 readArgs 通道, 读取 {terminalsFolder}/{shellId}.txt 终端文件
 *   - subagent: 走 subagentAwaitArgs 通道 (agentId)
 * 因此必须在转后台时按 task_id 登记 kind + 路由所需信息。
 *
 * 作用域选择: 后台 shell 的 AwaitShell 轮询发生在 **同一个 agent run** 的后续工具调用里,
 * 与转后台事件共享同一 requestId/session(handleConversationRun 单次调用贯穿全部 round)。
 * 故注册表挂在 session 上, 而非全局 Map。
 */
export interface BackgroundJob {
    kind: 'shell' | 'subagent';
    /** shell job: 执行侧回报的 shell_id (AwaitShell 的 task_id) */
    shellId?: number;
    /** subagent job: SubagentSuccess.agentId (AwaitShell 的 task_id) */
    agentId?: string;
    /** shell job: 终端输出文件所在目录 (env.terminalsFolder), 文件为 {terminalsFolder}/{shellId}.txt */
    terminalsFolder?: string;
    /** subagent job: transcript 文件路径 (SubagentSuccess.transcriptPath), 供日志/降级使用 */
    transcriptPath?: string;
    command?: string;
}

export interface AgentSession {
    requestId: string;
    messages: Array<Record<string, unknown>>;
    /**
     * Per-exec event buffers (see execChannels.ts). Exec-addressed client messages never
     * enter `messages`; they are routed here so that each exec owns an isolated,
     * bounded stream of events.
     */
    execChannels: Map<number, ExecChannel>;
    /**
     * Continuity tracking of the BidiAppend uplink (see linkHealth.ts). Drives the only
     * escape hatch out of an otherwise unbounded wait.
     */
    linkHealth: LinkHealth;
    /** @deprecated 保留向后兼容，新代码使用 listeners */
    notify: (() => void) | null;
    listeners: Set<() => void>;
    closed: boolean;
    /**
     * 后台 job 注册表 (key = task_id 字符串形式: shell 用 shellId, subagent 用 agentId)。
     * 转后台时登记, AwaitShell 据此分流 readArgs / subagentAwaitArgs。
     */
    backgroundJobs: Map<string, BackgroundJob>;
    /** env.terminalsFolder — 用于构造后台 shell 的终端文件路径 {terminalsFolder}/{shellId}.txt */
    terminalsFolder?: string;
    /**
     * 客户端 cancelAction 携带的 reason;一经设置即表示本 run 已被客户端中断。
     *
     * 客户端中断当前生成 (点停止、提交新消息抢占、steer 降级后升级为 interrupt)
     * 时,ControlledConversationActionManager.abort() 会往同一条 BiDi 客户端流
     * 发 ConversationAction{cancelAction},随后才本地 abort。这是服务端唯一能
     * 感知"该停了"的信号 —— 不消费它,旧 run 会一直跑到 LLM 流自然结束,
     * 表现为"发新消息时前一条没有被终止"。
     *
     * 与 closed 的区别: closed 是传输层断开,cancelled 是应用层中断,
     * 后者到达时连接仍然活着(客户端还要用它接收后续帧)。
     */
    cancelledReason?: string;
}

export function createEphemeralSession(requestId: string): AgentSession {
    return {
        requestId,
        messages: [],
        execChannels: createExecChannelRegistry(),
        linkHealth: createLinkHealth(),
        notify: null,
        listeners: new Set(),
        closed: false,
        backgroundJobs: new Map(),
    };
}

/**
 * 判定一条 AgentClientMessage 是否为 steer 的运行中上下文注入。
 *
 * injectContextAction 与 userMessageAction / cancelAction 平级挂在
 * ConversationAction 上,走同一条 BiDi 客户端流发来。
 */
function isContextInjection(json: Record<string, unknown>): boolean {
    const action = json.conversationAction as Record<string, unknown> | undefined;
    return action !== undefined && 'injectContextAction' in action;
}

/**
 * 判定一条 AgentClientMessage 是否为客户端中断信号,并取出 reason。
 *
 * 判据是 cancelAction 存不存在,不是 reason 有没有值 —— proto3 里空字符串
 * 与缺省不可区分,而客户端确实可能发不带 reason 的中断。
 *
 * 实测 reason (3.17.19):
 *   "new_message_submitted"    submitChatMaybeAbortCurrent,提交新消息抢占当前生成
 *   "user_stopped_generation"  用户点停止按钮
 */
function extractCancelReason(json: Record<string, unknown>): string | undefined {
    const action = json.conversationAction as Record<string, unknown> | undefined;
    if (!action || !('cancelAction' in action))
        return undefined;
    const cancel = action.cancelAction as Record<string, unknown> | undefined;
    const reason = cancel?.reason;
    return typeof reason === 'string' && reason ? reason : 'cancelled';
}

/**
 * 消息入队的统一入口。两条上行通道 (bidi 的 pushSessionMessage、SSE 降级的
 * appendMessage) 都经过这里,保证不论客户端走哪条路都是同一套处理。
 *
 * 四类去向:
 *   injectContextAction — 丢弃 (见下)
 *   cancelAction        — 记为中断信号
 *   exec 相关消息       — 进 execChannels 的 per-exec 缓冲 (见 execChannels.ts)
 *   其余                — 进 messages 供 waitForMessageMatching 消费
 *
 * 丢弃注入的理由: 我们不支持运行中注入,而客户端对"服务端没有应答"本就有兜底 ——
 * run 结束时 reconcileSteerItemsWhenIdle 会撤掉乐观气泡、把消息退回队列,
 * 随后 tryDispatchNextQueueItem 自动发出,消息不会丢。但它没有任何
 * waitForMessageMatching 的 predicate 会匹配,留在 messages 里只会无限堆积。
 */
function ingestSessionMessage(session: AgentSession, json: Record<string, unknown>): void {
    if (isContextInjection(json)) {
        logger.debug({ requestId: session.requestId }, '[SESSION] dropping context injection (run-time injection unsupported)');
        return;
    }
    const cancelReason = extractCancelReason(json);
    if (cancelReason !== undefined) {
        // 只认第一次 —— 客户端可能重复发,reason 以最先到达的为准
        if (session.cancelledReason === undefined) {
            session.cancelledReason = cancelReason;
            logger.info({ requestId: session.requestId, reason: cancelReason }, '[CANCEL] client cancelled the run');
        }
    }
    else if (!routeExecEvent(session, json)) {
        session.messages.push(json);
    }
    notifyAll(session);
}

/** 客户端是否已中断本 run。 */
export function isSessionCancelled(session: AgentSession): boolean {
    return session.cancelledReason !== undefined;
}

/** 登记一个后台 job, 供后续 AwaitShell 分流。key = task_id 字符串形式。 */
export function registerBackgroundJob(session: AgentSession, taskId: string, job: BackgroundJob): void {
    session.backgroundJobs.set(taskId, job);
    logger.info({ requestId: session.requestId, taskId, kind: job.kind }, '[SESSION] background job registered');
}

/** 按 task_id 查找已登记的后台 job。 */
export function getBackgroundJob(session: AgentSession, taskId: string): BackgroundJob | undefined {
    return session.backgroundJobs.get(taskId);
}

/**
 * Drop every background job registration of this run.
 *
 * Called when the run is cancelled: the registry only exists to route later AwaitShell
 * polls of the same run, so once the run is over the entries can only mislead.
 */
export function clearBackgroundJobs(session: AgentSession): BackgroundJob[] {
    const jobs = [...session.backgroundJobs.values()];
    if (jobs.length === 0) return jobs;
    session.backgroundJobs.clear();
    logger.info({ requestId: session.requestId, jobs: jobs.length }, '[SESSION] background job registry cleared');
    return jobs;
}

function notifyAll(session: AgentSession): void {
    session.notify?.();
    for (const fn of session.listeners) fn();
}

export function pushSessionMessage(session: AgentSession, json: Record<string, unknown>): void {
    ingestSessionMessage(session, json);
}

export function markSessionClosed(session: AgentSession): void {
    session.closed = true;
    notifyAll(session);
}

/**
 * Registry entry of one requestId.
 *
 * `lease` is the ownership token of the RunSSE stream currently driving this
 * requestId, or null while the session only exists because BidiAppend arrived
 * first (the normal SSE handshake order) and no stream has claimed it yet.
 */
interface SessionEntry {
    session: AgentSession;
    lease: number | null;
}

const sessions = new Map<string, SessionEntry>();

let leaseCounter = 0;

/** RunSSE streams that had to take a requestId away from a still-running stream. */
let reclaimCount = 0;

/**
 * Ownership handle a RunSSE stream holds over its requestId.
 *
 * `release()` is deliberately not "close this requestId": it only tears the
 * session down while this lease is still the current one. A stream whose
 * socket died can take an arbitrarily long time to unwind (it may be parked on
 * an in-flight LLM stream), so its teardown can land *after* the client has
 * reconnected and a newer stream has claimed the same requestId. Tearing the
 * session down at that point would silently kill the live run.
 */
export interface SessionLease {
    session: AgentSession;
    release: () => void;
}

/** End a session for good: wake every waiter, drop the per-exec buffers. */
function endSession(session: AgentSession, cancelledReason?: string): void {
    if (cancelledReason !== undefined && session.cancelledReason === undefined)
        session.cancelledReason = cancelledReason;
    session.closed = true;
    notifyAll(session);
    clearExecChannels(session);
}

export function getOrCreateSession(requestId: string): AgentSession {
    let entry = sessions.get(requestId);
    if (!entry) {
        // 复用 createEphemeralSession —— 两处各自写字面量时,新增字段容易只补一处
        entry = { session: createEphemeralSession(requestId), lease: null };
        sessions.set(requestId, entry);
        logger.debug({ requestId }, '[SESSION] created');
    }
    return entry.session;
}

/**
 * Bind a RunSSE stream to its requestId and take ownership of the session.
 *
 * Three cases, and the third is the one that matters over a remote tunnel:
 *
 *   1. Nothing registered yet — create the session, the stream owns it.
 *   2. Registered but unclaimed — BidiAppend queued the runRequest before the
 *      stream arrived, which is the normal SSE handshake. Adopt that session
 *      so the queued messages are not lost.
 *   3. Already claimed by another stream — the only way a second RunSSE can
 *      appear for a live requestId is a reconnect after the first stream's
 *      socket died (SSH port forwarding / NAT drop). The old run is writing
 *      into a dead socket, so it is cancelled and a fresh session is handed to
 *      the reconnecting stream, carrying over whatever the old run had not
 *      consumed yet.
 */
export function claimSession(requestId: string): SessionLease {
    const previous = sessions.get(requestId);
    let session: AgentSession;

    if (!previous) {
        session = createEphemeralSession(requestId);
        logger.debug({ requestId }, '[SESSION] created');
    }
    else if (previous.lease === null) {
        session = previous.session;
    }
    else {
        reclaimCount++;
        session = createEphemeralSession(requestId);
        session.messages = previous.session.messages.splice(0);
        session.terminalsFolder = previous.session.terminalsFolder;
        logger.warn(
            { requestId, carriedMessages: session.messages.length },
            '[SESSION] RunSSE reclaimed a live requestId — treating it as a reconnect and cancelling the abandoned run',
        );
        endSession(previous.session, 'superseded by a reconnect of the same requestId');
    }

    const lease = ++leaseCounter;
    sessions.set(requestId, { session, lease });

    return {
        session,
        release: () => {
            const current = sessions.get(requestId);
            if (!current || current.lease !== lease) {
                logger.debug({ requestId }, '[SESSION] release skipped — requestId already owned by a newer stream');
                return;
            }
            sessions.delete(requestId);
            endSession(session);
            logger.debug({ requestId }, '[SESSION] closed');
        },
    };
}

/**
 * BidiAppend 调用时，将消息推入 session 队列。
 *
 * `seqno` is the transport's own numbering of this append; it is fed to the link health
 * tracker before ingestion so that a waiter woken by this message already sees an
 * up-to-date view of the uplink. Pass it through verbatim — linkHealth.ts decides on its
 * own whether the numbering is trustworthy.
 */
export function appendMessage(requestId: string, data: string, seqno?: number | bigint): void {
    const session = getOrCreateSession(requestId);
    observeAppend(session, seqno);

    // data 是 proto string 类型，实际承载的是 protobuf binary 的 hex 字符串表示。
    // "0ad88200a00012..." → hex decode → protobuf bytes
    try {
        const bytes = Buffer.from(data, 'hex');
        const clientMsg = fromBinary(AgentClientMessageSchema, bytes);
        const json = toJson(AgentClientMessageSchema, clientMsg) as Record<string, unknown>;
        const keys = Object.keys(json);
        logger.debug({ requestId, keys, protoBytes: bytes.length }, '[SESSION] appendMessage');
        ingestSessionMessage(session, json);
    } catch (e) {
        logger.warn({ requestId, dataLen: data.length, error: (e as Error).message }, '[SESSION] proto decode failed');
    }
}

/** 等待下一条消息（任意类型） */
export async function waitForMessage(
    session: AgentSession,
    timeoutMs: number | null = 30_000,
): Promise<Record<string, unknown> | null> {
    return waitForMessageMatching(session, () => true, timeoutMs);
}

/**
 * 等待匹配特定条件的消息
 *
 * 不匹配的消息会被跳过（留在队列中供后续消费）。
 * 用于在 tool call 场景下等待 execClientMessage，
 * 而不被 kvClientMessage/clientHeartbeat 干扰。
 */
export async function waitForMessageMatching(
    session: AgentSession,
    predicate: (msg: Record<string, unknown>) => boolean,
    timeoutMs: number | null = 30_000,
): Promise<Record<string, unknown> | null> {
    const outcome = await waitForEvent(session, () => {
        const idx = session.messages.findIndex(predicate);
        return idx >= 0 ? session.messages.splice(idx, 1)[0] : null;
    }, timeoutMs);
    return outcome.kind === 'event' ? outcome.event : null;
}

/**
 * How a park on the session ended.
 *
 * `ended` folds together close / cancel / timeout — three ways of saying "no event is
 * coming", all of which the callers already handle identically. `linkLost` is kept apart
 * because it is the one outcome that must not be silently absorbed: it means a client
 * message was dropped in transit, and the run has to surface a retryable error rather
 * than pretend the tool returned nothing.
 */
export type WaitOutcome =
    | { kind: 'event'; event: Record<string, unknown> }
    | { kind: 'ended' }
    | { kind: 'linkLost' };

/**
 * Wait for an event of a single exec, consumed from that exec's own channel.
 *
 * Same parking semantics as waitForMessageMatching, but the search space is one exec's
 * buffer instead of the shared queue (so two concurrently running execs can never consume
 * each other's events), and the outcome is reported in full rather than collapsed to null.
 */
export async function waitForExecEventMatching(
    session: AgentSession,
    execMessageId: number,
    predicate: (msg: Record<string, unknown>) => boolean,
    timeoutMs: number | null = 30_000,
): Promise<WaitOutcome> {
    acquireExecWaiter(session, execMessageId);
    try {
        return await waitForEvent(
            session,
            () => takeExecEvent(session, execMessageId, predicate),
            timeoutMs,
            { execMessageId },
        );
    } finally {
        releaseExecWaiter(session, execMessageId);
    }
}

/**
 * Shared wait primitive: park on the session's listener set until `take` yields an
 * event, the session ends (closed / cancelled), the timeout elapses, or the uplink is
 * ruled lost.
 *
 * `take` owns where the event comes from and removes it from its buffer; this function
 * owns only the parking and wake-up.
 *
 * The link-loss arm is the reason an unbounded wait is now safe. It is armed off
 * linkHealth's deadline rather than off a wall-clock budget of its own, so a wait only
 * ever ends early when there is positive evidence (a seqno gap that survived both grace
 * windows) that the message it is waiting for will never arrive.
 */
function waitForEvent(
    session: AgentSession,
    take: () => Record<string, unknown> | null,
    timeoutMs: number | null,
    logContext: Record<string, unknown> = {},
): Promise<WaitOutcome> {
    // 先检查缓冲里是否已有匹配消息
    const buffered = take();
    if (buffered) return Promise.resolve({ kind: 'event', event: buffered });
    // cancelled 与 closed 同样立即结束等待 —— 调用方 (wait.ts) 据
    // session.cancelledReason 区分二者,把前者转成 AgentRunAbortedError
    if (session.closed || session.cancelledReason !== undefined) return Promise.resolve({ kind: 'ended' });
    if (isLinkLost(session.linkHealth)) {
        reportLinkLoss(session, logContext);
        return Promise.resolve({ kind: 'linkLost' });
    }

    return new Promise<WaitOutcome>((resolve) => {
        let resolved = false;
        let linkTimer: ReturnType<typeof setTimeout> | null = null;

        const cleanup = () => {
            resolved = true;
            if (timer != null)
                clearTimeout(timer);
            if (linkTimer != null)
                clearTimeout(linkTimer);
            session.listeners.delete(listener);
        };

        const timer = timeoutMs == null ? null : setTimeout(() => {
            if (resolved)
                return;
            cleanup();
            logger.warn({ requestId: session.requestId, timeoutMs, ...logContext }, '[SESSION] waitForMessage timeout');
            resolve({ kind: 'ended' });
        }, timeoutMs);

        /** Re-evaluate the uplink verdict and (re-)arm the wake-up for its deadline. */
        const watchLink = () => {
            if (resolved)
                return;
            const remainingMs = msUntilLinkLoss(session.linkHealth);
            if (linkTimer != null) {
                clearTimeout(linkTimer);
                linkTimer = null;
            }
            if (remainingMs === null)
                return;
            if (remainingMs <= 0) {
                cleanup();
                reportLinkLoss(session, logContext);
                resolve({ kind: 'linkLost' });
                return;
            }
            linkTimer = setTimeout(watchLink, remainingMs);
        };

        const listener = () => {
            if (resolved)
                return;
            const event = take();
            if (event) {
                cleanup();
                resolve({ kind: 'event', event });
                return;
            }
            if (session.closed || session.cancelledReason !== undefined) {
                cleanup();
                resolve({ kind: 'ended' });
                return;
            }
            watchLink();
        };

        session.listeners.add(listener);
        watchLink();
    });
}

export async function waitForInteractionResponse(
    session: AgentSession,
    id: number,
    expectedCase: string,
    timeoutMs: number | null = 60_000,
): Promise<Record<string, unknown> | null> {
    return waitForMessageMatching(
        session,
        (msg) => {
            if (!('interactionResponse' in msg)) return false;
            const response = msg.interactionResponse as Record<string, unknown> | undefined;
            if (!response) return false;
            const responseId = typeof response.id === 'number' ? response.id : Number(response.id);
            return responseId === id && expectedCase in response;
        },
        timeoutMs,
    );
}

/**
 * Unconditional teardown of a requestId, regardless of who owns it.
 *
 * Streams must use the lease returned by claimSession() instead — see the
 * SessionLease docstring for why an unconditional close from a stream is a
 * bug. This entry point remains for callers that legitimately have no lease.
 */
export function closeSession(requestId: string): void {
    const entry = sessions.get(requestId);
    if (entry) {
        sessions.delete(requestId);
        endSession(entry.session);
        logger.debug({ requestId }, '[SESSION] closed');
    }
}

/**
 * Live view of the agent uplink, for /byok/debug.
 *
 * The three numbers that matter when a turn looks stuck are: is the uplink numbering
 * intact (seqno gaps), did we give up on it (link losses), and is the client still holding
 * execs open. `reclaims` is here too because a reclaim means the downlink socket died and
 * the client reconnected — a different failure with the same symptom.
 */
export function agentLinkDiagnostics(): {
    reclaims: number;
    sessions: Array<{ requestId: string; claimed: boolean; activeExecChannels: number; queuedMessages: number } & ReturnType<typeof linkHealthSnapshot>>;
} {
    return {
        reclaims: reclaimCount,
        sessions: [...sessions.values()].map(({ session, lease }) => ({
            requestId: session.requestId,
            claimed: lease !== null,
            activeExecChannels: session.execChannels.size,
            queuedMessages: session.messages.length,
            ...linkHealthSnapshot(session.linkHealth),
        })),
    };
}
