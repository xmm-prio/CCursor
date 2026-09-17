/**
 * Per-exec event channels.
 *
 * Every exec-addressed client message (`exec_client_message` and
 * `exec_client_control_message`) carries the `exec_message_id` of the exec it belongs to.
 * Keeping all of them in one shared session queue has three defects:
 *   - cross-talk: a waiter scans (and may splice) events belonging to another exec;
 *   - leaks: events nobody matches stay in the queue for the whole run;
 *   - unboundedness: a chatty long-running exec grows the queue without limit.
 *
 * A channel is the isolated event buffer of a single exec. It is created when the first
 * event for that id arrives (or when its owner opens it up front), consumed by exactly
 * one waiter at a time, bounded in size, and destroyed when its owner closes it.
 *
 * The registry lives on the session (one run = one set of execs), so channels die with
 * the run even if an owner forgets to close one.
 */
import { logger } from '../../logger';

/** Maximum events buffered per exec. Beyond it the oldest event is dropped. */
export const EXEC_CHANNEL_MAX_EVENTS = 512;

export interface ExecChannel {
    execMessageId: number;
    /** Buffered, not-yet-consumed events for this exec, oldest first. */
    events: Array<Record<string, unknown>>;
    /** Number of waiters currently parked on this channel (expected: 0 or 1). */
    waiters: number;
    /** Events discarded because the buffer hit EXEC_CHANNEL_MAX_EVENTS. */
    droppedEvents: number;
}

/**
 * Structural host of the channel registry.
 *
 * Declared here rather than importing AgentSession so that session.ts can depend on this
 * module without a cycle.
 */
export interface ExecChannelHost {
    requestId: string;
    execChannels: Map<number, ExecChannel>;
}

export function createExecChannelRegistry(): Map<number, ExecChannel> {
    return new Map();
}

function numericId(value: unknown): number | null {
    const id = typeof value === 'number' ? value : Number(value);
    return Number.isFinite(id) ? id : null;
}

/**
 * The exec this client message belongs to, or null when it is not exec-addressed.
 *
 * Control messages (`streamClose` / `throw` / `heartbeat`) carry the id inside the
 * payload; `execClientMessage` carries it at the top level.
 */
export function execMessageIdOf(msg: Record<string, unknown>): number | null {
    if ('execClientMessage' in msg) {
        const ecm = msg.execClientMessage as Record<string, unknown> | undefined;
        return ecm ? numericId(ecm.id) : null;
    }
    if ('execClientControlMessage' in msg) {
        const ctrl = msg.execClientControlMessage as Record<string, unknown> | undefined;
        if (!ctrl) return null;
        for (const key of ['streamClose', 'throw', 'heartbeat']) {
            const payload = ctrl[key] as Record<string, unknown> | undefined;
            if (payload) return numericId(payload.id);
        }
    }
    return null;
}

/** True for exec heartbeats — pure keepalive, never awaited, so never buffered. */
function isExecHeartbeat(msg: Record<string, unknown>): boolean {
    const ctrl = msg.execClientControlMessage as Record<string, unknown> | undefined;
    return !!ctrl?.heartbeat;
}

export function openExecChannel(host: ExecChannelHost, execMessageId: number): ExecChannel {
    let channel = host.execChannels.get(execMessageId);
    if (!channel) {
        channel = { execMessageId, events: [], waiters: 0, droppedEvents: 0 };
        host.execChannels.set(execMessageId, channel);
    }
    return channel;
}

/**
 * Route an incoming client message into its exec channel.
 *
 * Returns false when the message is not exec-addressed — the caller then keeps it in the
 * generic session queue.
 */
export function routeExecEvent(host: ExecChannelHost, msg: Record<string, unknown>): boolean {
    const execMessageId = execMessageIdOf(msg);
    if (execMessageId === null) return false;
    if (isExecHeartbeat(msg)) return true;

    const channel = openExecChannel(host, execMessageId);
    channel.events.push(msg);
    while (channel.events.length > EXEC_CHANNEL_MAX_EVENTS) {
        channel.events.shift();
        channel.droppedEvents++;
        if (channel.droppedEvents === 1 || channel.droppedEvents % 100 === 0) {
            logger.warn({
                requestId: host.requestId,
                execMessageId,
                buffered: channel.events.length,
                droppedEvents: channel.droppedEvents,
            }, '[EXEC-CHANNEL] buffer overflow, dropping oldest event');
        }
    }
    return true;
}

/** Take the first buffered event of this exec matching the predicate, if any. */
export function takeExecEvent(
    host: ExecChannelHost,
    execMessageId: number,
    predicate: (msg: Record<string, unknown>) => boolean,
): Record<string, unknown> | null {
    const channel = host.execChannels.get(execMessageId);
    if (!channel) return null;
    const index = channel.events.findIndex(predicate);
    return index >= 0 ? channel.events.splice(index, 1)[0] : null;
}

/**
 * Register a waiter on a channel.
 *
 * An exec is owned by exactly one tool call, so a second concurrent waiter means two
 * owners are racing for the same stream — the events would be split between them at
 * random. We cannot arbitrate that here, but it must not stay invisible.
 */
export function acquireExecWaiter(host: ExecChannelHost, execMessageId: number): void {
    const channel = openExecChannel(host, execMessageId);
    channel.waiters++;
    if (channel.waiters > 1) {
        logger.warn({
            requestId: host.requestId,
            execMessageId,
            waiters: channel.waiters,
        }, '[EXEC-CHANNEL] concurrent waiters on a single exec — events will be split between them');
    }
}

export function releaseExecWaiter(host: ExecChannelHost, execMessageId: number): void {
    const channel = host.execChannels.get(execMessageId);
    if (channel && channel.waiters > 0) channel.waiters--;
}

/** Destroy a channel once its exec is over. Late events for it are then routed to a fresh, unread buffer. */
export function closeExecChannel(host: ExecChannelHost, execMessageId: number): void {
    const channel = host.execChannels.get(execMessageId);
    if (!channel) return;
    host.execChannels.delete(execMessageId);
    if (channel.events.length > 0 || channel.droppedEvents > 0) {
        logger.debug({
            requestId: host.requestId,
            execMessageId,
            unconsumed: channel.events.length,
            droppedEvents: channel.droppedEvents,
        }, '[EXEC-CHANNEL] closed with unconsumed events');
    }
}

/** Exec ids that still have a live channel — i.e. execs the client may still be running. */
export function activeExecMessageIds(host: ExecChannelHost): number[] {
    return [...host.execChannels.keys()];
}

export function clearExecChannels(host: ExecChannelHost): void {
    if (host.execChannels.size === 0) return;
    logger.debug({
        requestId: host.requestId,
        channels: host.execChannels.size,
    }, '[EXEC-CHANNEL] clearing all channels');
    host.execChannels.clear();
}
