/**
 * Upstream stream accounting — how many turns are talking to a provider right now.
 *
 * One BYOK server serves every Cursor window on the machine, and one in-flight
 * turn holds exactly one socket of its provider's pool for its whole duration.
 * When more turns stream at once than the pool has sockets
 * (UPSTREAM_MAX_CONNECTIONS_PER_ORIGIN), undici parks the surplus in an internal
 * queue that has no deadline, emits no event and shows up in no log — the turn
 * just produces nothing until an earlier one finishes.
 *
 * This module does not change that behaviour, it makes it *visible*. It is a
 * pure observer: it never delays, reorders or rejects a stream. Its whole job is
 * to answer two questions that were previously unanswerable from outside the
 * process:
 *
 *   - how many upstream streams are open right now, per provider origin;
 *   - did we ever reach the point where undici must have started queueing.
 *
 * Counting happens here rather than around `fetch` because `fetch` resolves at
 * the response headers while the socket stays occupied for the whole body. The
 * provider's async iterable is the only handle whose lifetime matches the
 * socket's. For the same reason the decorator is applied *inside*
 * withStreamResilience at the single place providers are instantiated
 * (providerRuntime.ts): each retry attempt is its own socket, and the backoff
 * sleep between them holds none.
 */
import type { LLMProvider, LLMStreamEvent, LLMStreamRequest } from './types'
import { UPSTREAM_MAX_CONNECTIONS_PER_ORIGIN } from '../../config/upstreamTuning'
import { logger } from '../../logger'

export interface UpstreamOriginTraffic {
  /** Pool key: the origin undici groups sockets by, or a provider-id fallback. */
  origin: string
  /** Streams open right now — one socket each. */
  inFlight: number
  /** Highest `inFlight` observed since the process started. */
  peakInFlight: number
  /** Streams started, including retries by withStreamResilience. */
  started: number
  /** Streams that ran to completion. */
  completed: number
  /** Streams that ended by throwing (network error, abort, provider error). */
  failed: number
  /**
   * How many times this origin went from "below the pool ceiling" to "at or
   * above it" — i.e. how many distinct episodes of invisible undici queueing
   * this server has caused.
   */
  saturationEpisodes: number
}

export interface UpstreamTrafficSnapshot {
  /** The per-origin socket ceiling every entry below is measured against. */
  connectionsPerOrigin: number
  /** Sum of `inFlight` across origins. */
  inFlight: number
  origins: UpstreamOriginTraffic[]
}

const traffic = new Map<string, UpstreamOriginTraffic>()

function trackerFor(origin: string): UpstreamOriginTraffic {
  let entry = traffic.get(origin)
  if (!entry) {
    entry = {
      origin,
      inFlight: 0,
      peakInFlight: 0,
      started: 0,
      completed: 0,
      failed: 0,
      saturationEpisodes: 0,
    }
    traffic.set(origin, entry)
  }
  return entry
}

/**
 * The pool key undici will group this provider's sockets under.
 *
 * undici pools by origin, so two provider entries pointing at the same host
 * compete for the same sockets and must be counted together. A baseUrl that
 * cannot be parsed (empty for the synthetic entries, or malformed config) falls
 * back to the provider id, which keeps the entry visible instead of silently
 * merging unrelated providers under one bucket.
 */
export function upstreamOriginOf(baseUrl: string | undefined, fallback: string): string {
  if (!baseUrl)
    return fallback
  try {
    return new URL(baseUrl).origin
  }
  catch {
    return fallback
  }
}

function onStreamStart(entry: UpstreamOriginTraffic, providerName: string, model: string): void {
  const wasBelowCeiling = entry.inFlight < UPSTREAM_MAX_CONNECTIONS_PER_ORIGIN
  entry.started++
  entry.inFlight++
  if (entry.inFlight > entry.peakInFlight)
    entry.peakInFlight = entry.inFlight

  // Log the transition, not the state: once saturated, every further start
  // would otherwise produce a line, and the interesting moment is the crossing.
  if (wasBelowCeiling && entry.inFlight >= UPSTREAM_MAX_CONNECTIONS_PER_ORIGIN) {
    entry.saturationEpisodes++
    logger.warn({
      origin: entry.origin,
      provider: providerName,
      model,
      inFlight: entry.inFlight,
      connectionsPerOrigin: UPSTREAM_MAX_CONNECTIONS_PER_ORIGIN,
      episode: entry.saturationEpisodes,
    }, '[UPSTREAM] connection pool saturated — further turns to this origin will wait for a free socket')
  }
}

function onStreamEnd(entry: UpstreamOriginTraffic, failed: boolean): void {
  entry.inFlight = Math.max(0, entry.inFlight - 1)
  if (failed)
    entry.failed++
  else
    entry.completed++
}

/**
 * Wrap a provider so every stream it opens is counted for the whole time its
 * socket is held. Returns a new object; `inner` is untouched.
 */
export function withUpstreamAccounting(inner: LLMProvider, origin: string): LLMProvider {
  return {
    name: inner.name,
    stream: (request: LLMStreamRequest) => accountedStream(inner, request, origin),
  }
}

async function* accountedStream(
  inner: LLMProvider,
  request: LLMStreamRequest,
  origin: string,
): AsyncIterable<LLMStreamEvent> {
  const entry = trackerFor(origin)
  onStreamStart(entry, inner.name, request.model)
  let failed = false
  try {
    yield* inner.stream(request)
  }
  catch (error) {
    failed = true
    throw error
  }
  finally {
    // Covers the early-`break` path too: a consumer abandoning the iterator runs
    // this finally via the generator's return(), which is exactly when the
    // socket is released.
    onStreamEnd(entry, failed)
  }
}

export function upstreamTrafficSnapshot(): UpstreamTrafficSnapshot {
  const origins = [...traffic.values()].map(entry => ({ ...entry }))
  return {
    connectionsPerOrigin: UPSTREAM_MAX_CONNECTIONS_PER_ORIGIN,
    inFlight: origins.reduce((total, entry) => total + entry.inFlight, 0),
    origins,
  }
}

export function resetUpstreamTrafficForTests(): void {
  traffic.clear()
}
