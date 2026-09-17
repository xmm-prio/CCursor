/**
 * Uplink loss detection for the BidiAppend channel.
 *
 * Every wait in the agent runtime is allowed to park forever (`timeoutMs = null`), because
 * a tool call may legitimately sit for an hour waiting for the user to approve a shell
 * command. That is the right default right up until the client message carrying the result
 * never arrives: the waiter then parks for good while heartbeats keep flowing, and the user
 * sees a "healthy" stream that never advances.
 *
 * `BidiAppendRequest.append_seqno` is the only hard evidence we have that a message was
 * lost rather than merely slow. Tracking its continuity lets us distinguish the two without
 * guessing at client heartbeat cadence and without ever penalising a long approval wait.
 *
 * ## Why this degrades instead of trusting the field
 *
 * `append_seqno` is a plain proto3 `int64`, so an absent field is indistinguishable from
 * zero, and nothing in the wire contract promises it is per-requestId or even monotonic.
 * Detection is therefore *opt-in by observation*: a session only starts declaring faults
 * after it has seen `SEQNO_TRUST_THRESHOLD` strictly consecutive appends. A stream that is
 * always zero, globally numbered, or out of order never reaches that bar, and this module
 * then reports "nothing to see" forever — i.e. exactly the pre-existing behaviour of
 * parking indefinitely.
 *
 * ## Grace, in two stages
 *
 * A gap is not a loss. Appends are unary HTTP requests that can be in flight concurrently,
 * so seqno N+1 can genuinely land before N. A gap therefore first serves
 * `SEQNO_REORDER_GRACE_MS` in which a late arrival can fill it, and only then does it start
 * the `LINK_FAULT_GRACE_MS` window given to the waiters. Both must elapse before a parked
 * waiter is woken with a loss verdict.
 *
 * Pure state plus functions, hosted on the session (same shape as execChannels.ts), so the
 * lifetime of the tracking is the lifetime of the run.
 */
import { logger } from '../../logger';

/**
 * Consecutive in-order appends required before gaps are believed.
 *
 * Three is enough to rule out a constant-zero or globally-shared counter while still being
 * reached within the opening handshake of any real turn.
 */
export const SEQNO_TRUST_THRESHOLD = 3;

/** How long a missing seqno may be explained by concurrent appends arriving out of order. */
export const SEQNO_REORDER_GRACE_MS = 2_000;

/** How long waiters keep parking after a gap has been ruled a real fault. */
export const LINK_FAULT_GRACE_MS = 15_000;

export interface LinkHealth {
    /** Highest seqno observed so far; the frontier gaps are measured against. */
    highestSeqno: number;
    /** Consecutive appends seen at exactly `highestSeqno + 1`. */
    contiguousAppends: number;
    /** True once the seqno stream has proven itself per-request and monotonic. */
    trusted: boolean;
    /** Missing seqno → the moment it was first noticed missing. */
    gaps: Map<number, number>;
    /** Gaps ever opened (including ones later filled by a reordered append). */
    observedGaps: number;
    /** Times a waiter was woken because a gap outlived both grace windows. */
    lossReports: number;
}

/**
 * Structural host of the tracker.
 *
 * Declared here rather than importing AgentSession so that session.ts can depend on this
 * module without a cycle.
 */
export interface LinkHealthHost {
    requestId: string;
    linkHealth: LinkHealth;
}

export function createLinkHealth(): LinkHealth {
    return {
        highestSeqno: -1,
        contiguousAppends: 0,
        trusted: false,
        gaps: new Map(),
        observedGaps: 0,
        lossReports: 0,
    };
}

function toSeqno(value: number | bigint | undefined): number | null {
    if (value === undefined) return null;
    const seqno = typeof value === 'bigint' ? Number(value) : value;
    return Number.isSafeInteger(seqno) && seqno >= 0 ? seqno : null;
}

/**
 * Record the arrival of one BidiAppend.
 *
 * Call before the message is ingested, so that a waiter woken by the ingest already sees
 * the updated gap set.
 */
export function observeAppend(host: LinkHealthHost, rawSeqno: number | bigint | undefined): void {
    const health = host.linkHealth;
    const seqno = toSeqno(rawSeqno);
    if (seqno === null) {
        // Unusable value — treat the whole stream as unnumbered from here on.
        health.trusted = false;
        health.contiguousAppends = 0;
        health.gaps.clear();
        return;
    }

    // A late arrival closes its own gap regardless of trust state.
    health.gaps.delete(seqno);

    if (health.highestSeqno < 0) {
        health.highestSeqno = seqno;
        return;
    }

    if (seqno === health.highestSeqno + 1) {
        health.contiguousAppends++;
        if (!health.trusted && health.contiguousAppends >= SEQNO_TRUST_THRESHOLD) {
            health.trusted = true;
            logger.debug({
                requestId: host.requestId,
                seqno,
            }, '[LINK] append_seqno looks monotonic — uplink loss detection enabled');
        }
    }
    else {
        health.contiguousAppends = 0;
        // Gaps are only meaningful once the numbering has proven itself; recording them
        // before that would also let an untrusted stream grow the map without bound.
        if (health.trusted && seqno > health.highestSeqno + 1) {
            const now = Date.now();
            for (let missing = health.highestSeqno + 1; missing < seqno; missing++) {
                health.gaps.set(missing, now);
                health.observedGaps++;
            }
            logger.warn({
                requestId: host.requestId,
                expectedSeqno: health.highestSeqno + 1,
                receivedSeqno: seqno,
                pendingGaps: health.gaps.size,
            }, '[LINK] gap in append_seqno — uplink message may have been dropped');
        }
    }

    if (seqno > health.highestSeqno) health.highestSeqno = seqno;
}

/**
 * Milliseconds until the oldest unfilled gap counts as a confirmed loss.
 *
 * `null` means there is nothing to wait for — no gap, or a stream whose numbering was never
 * trustworthy. A value `<= 0` means the loss is already confirmed.
 */
export function msUntilLinkLoss(health: LinkHealth, now: number = Date.now()): number | null {
    if (!health.trusted || health.gaps.size === 0) return null;
    let oldest = Number.POSITIVE_INFINITY;
    for (const firstMissingAt of health.gaps.values())
        oldest = Math.min(oldest, firstMissingAt);
    return oldest + SEQNO_REORDER_GRACE_MS + LINK_FAULT_GRACE_MS - now;
}

/** True once the oldest unfilled gap has outlived both grace windows. */
export function isLinkLost(health: LinkHealth, now: number = Date.now()): boolean {
    const remaining = msUntilLinkLoss(health, now);
    return remaining !== null && remaining <= 0;
}

/**
 * Note that a waiter is being given up on because of a confirmed loss.
 *
 * The gaps are deliberately kept: the run is being torn down, and every other waiter of the
 * same session must reach the same verdict rather than park on a link we no longer believe.
 */
export function reportLinkLoss(host: LinkHealthHost, context: Record<string, unknown> = {}): void {
    host.linkHealth.lossReports++;
    logger.warn({
        requestId: host.requestId,
        pendingGaps: host.linkHealth.gaps.size,
        observedGaps: host.linkHealth.observedGaps,
        lossReports: host.linkHealth.lossReports,
        ...context,
    }, '[LINK] uplink message confirmed lost — waking waiter instead of parking forever');
}

/** Diagnostics view for /byok/debug. */
export function linkHealthSnapshot(health: LinkHealth): {
    trusted: boolean;
    highestSeqno: number;
    observedGaps: number;
    pendingGaps: number;
    lossReports: number;
} {
    return {
        trusted: health.trusted,
        highestSeqno: health.highestSeqno,
        observedGaps: health.observedGaps,
        pendingGaps: health.gaps.size,
        lossReports: health.lossReports,
    };
}
