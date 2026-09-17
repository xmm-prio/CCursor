/**
 * Push channel — who is subscribed to the server, and what reaches them.
 *
 * Two independent channels leave this server without being asked for:
 *
 *   - the **event channel**: routes updates, model-refresh signals and the
 *     shutdown notice, broadcast to every renderer and every injected node
 *     router;
 *   - the **log channel**: structured log entries, addressed to the one window
 *     that produced them (see logger.ts).
 *
 * They used to be two ad-hoc sets of hijacked Fastify replies inside index.ts,
 * written to with a bare `reply.raw.write()`. That had two defects which only
 * appear once several windows are active at the same time:
 *
 *   - **No backpressure.** `write()` returning false was ignored, so a window
 *     whose socket stalls (a suspended laptop, a saturated SSH tunnel) makes
 *     Node buffer every subsequent log line in memory, without limit, inside a
 *     process shared by every other window.
 *   - **One transport only.** SSE runs on plain HTTP/1.1, and Chromium gives a
 *     renderer six sockets per origin *for the whole application*. Each window
 *     permanently spends one of them on its event stream, so from a handful of
 *     windows on, ordinary requests to the BYOK port queue behind streams that
 *     never end. WebSocket connections come from a different, far larger pool,
 *     which is why the event channel must be able to speak both.
 *
 * This module owns the subscriber registries and the delivery discipline; each
 * transport owns only its own wire format, behind the ChannelSink interface.
 * Nothing here imports fastify or ws, so the whole delivery path is testable
 * with plain objects.
 */
import type { RoutesPayload } from './config/routesPayload'
import type { LogEntry } from './logger'
import { serializeRoutesFrames } from './config/routesPayload'
import { SSE_EVENT_ROUTES, SSE_EVENT_ROUTES_LEGACY } from './data/defaults'

/**
 * How many bytes may sit unsent for one subscriber before log frames are
 * dropped instead of queued.
 *
 * Only the log channel is subject to this: it is the only high-volume one, and
 * a dropped log line costs nothing but a gap. Event frames are rare, small and
 * carry state the consumer cannot re-derive, so they are always queued.
 *
 * 1 MiB is far more than a healthy consumer ever accumulates — a local SSE
 * reader drains within a tick — so crossing it means the peer has stopped
 * reading rather than that it is momentarily behind.
 */
export const LOG_BACKPRESSURE_LIMIT_BYTES = 1024 * 1024

export type SinkTransport = 'sse' | 'ws'

/** One frame of either channel, before any transport has serialized it. */
export type ChannelFrame
  = | { kind: 'routes', payload: RoutesPayload }
    | { kind: 'refresh' }
    | { kind: 'shutdown' }
    | { kind: 'log', entry: LogEntry }
    | { kind: 'comment', text: string }

/**
 * A connected subscriber, reduced to what delivery needs to know.
 *
 * Structural on purpose: the SSE adapter wraps a hijacked Fastify reply and the
 * WebSocket adapter wraps a `ws` socket, but neither type appears here.
 */
export interface ChannelSink {
  readonly transport: SinkTransport
  /** Bytes accepted from us but not yet handed to the OS. */
  bufferedBytes: () => number
  /** Serialize and send one frame. False means the peer is gone. */
  write: (frame: ChannelFrame) => boolean
  /** Hang up from our side. Must be safe to call on an already dead peer. */
  close: () => void
}

interface SinkState {
  sink: ChannelSink
  /** Log frames dropped since the last time this sink drained. */
  droppedSinceDrain: number
  /** Log frames dropped over the lifetime of this subscription. */
  droppedTotal: number
}

const eventSinks = new Set<SinkState>()
const logSinks = new Map<number, Set<SinkState>>()

function track(sink: ChannelSink): SinkState {
  return { sink, droppedSinceDrain: 0, droppedTotal: 0 }
}

// ── subscription ────────────────────────────────────────────────

/**
 * Subscribe to the event channel. The returned function unsubscribes and is
 * safe to call more than once.
 */
export function addEventSink(sink: ChannelSink): () => void {
  const state = track(sink)
  eventSinks.add(state)
  return () => {
    eventSinks.delete(state)
  }
}

/** Subscribe to the log channel of one window. */
export function addLogSink(windowId: number, sink: ChannelSink): () => void {
  const state = track(sink)
  let sinks = logSinks.get(windowId)
  if (!sinks) {
    sinks = new Set()
    logSinks.set(windowId, sinks)
  }
  sinks.add(state)
  return () => {
    const current = logSinks.get(windowId)
    if (!current)
      return
    current.delete(state)
    if (current.size === 0)
      logSinks.delete(windowId)
  }
}

/**
 * Does this window have a live log subscriber?
 *
 * Editor windows subscribe from their extension host; Agent Windows have no
 * extension host of their own, and logger.ts spills their entries to disk
 * instead (see writeOrphanLog).
 */
export function hasLogSink(windowId: number): boolean {
  const sinks = logSinks.get(windowId)
  return !!sinks && sinks.size > 0
}

// ── delivery ────────────────────────────────────────────────────

function deliver(state: SinkState, frame: ChannelFrame, sinks: Set<SinkState>): boolean {
  if (!state.sink.write(frame)) {
    sinks.delete(state)
    return false
  }
  return true
}

/**
 * Deliver a log frame under the backpressure budget.
 *
 * Nothing in here may call `logger` — every log line travels through this
 * function, so a log statement on this path would recurse. Drops are therefore
 * reported two other ways: through pushChannelDiagnostics() for /byok/debug,
 * and as a synthetic frame written into the sink itself once it drains, so the
 * gap is visible in the window's own output.
 */
function deliverLog(state: SinkState, frame: ChannelFrame, sinks: Set<SinkState>): void {
  if (state.sink.bufferedBytes() > LOG_BACKPRESSURE_LIMIT_BYTES) {
    state.droppedSinceDrain++
    state.droppedTotal++
    return
  }
  if (state.droppedSinceDrain > 0) {
    const dropped = state.droppedSinceDrain
    state.droppedSinceDrain = 0
    deliver(state, {
      kind: 'log',
      entry: { level: 'warn', msg: `[SRV] ${dropped} log line(s) dropped — this window stopped reading its log stream` },
    }, sinks)
  }
  deliver(state, frame, sinks)
}

/** Broadcast one frame to every event subscriber. Returns how many took it. */
export function emitEvent(frame: ChannelFrame): number {
  let delivered = 0
  for (const state of [...eventSinks]) {
    if (deliver(state, frame, eventSinks))
      delivered++
  }
  return delivered
}

/** Send a log entry to the subscribers of one window. */
export function emitLog(windowId: number, entry: LogEntry): void {
  const sinks = logSinks.get(windowId)
  if (!sinks || sinks.size === 0)
    return
  const frame: ChannelFrame = { kind: 'log', entry }
  for (const state of [...sinks])
    deliverLog(state, frame, sinks)
}

/** Send a log entry to every window — used for logs with no request context. */
export function broadcastLog(entry: LogEntry): void {
  const frame: ChannelFrame = { kind: 'log', entry }
  for (const sinks of [...logSinks.values()]) {
    for (const state of [...sinks])
      deliverLog(state, frame, sinks)
  }
}

/** Tell both channels the server is going away, so peers can take over. */
export function emitShutdown(): number {
  const frame: ChannelFrame = { kind: 'shutdown' }
  let delivered = emitEvent(frame)
  for (const sinks of [...logSinks.values()]) {
    for (const state of [...sinks]) {
      if (deliver(state, frame, sinks))
        delivered++
    }
  }
  return delivered
}

/**
 * Hang up on every subscriber.
 *
 * A push subscription is an HTTP request that never completes, so `close()` on
 * the underlying server would wait for it forever. Shutting the sinks down
 * first is what lets the owner window release the port promptly — and the port
 * being released promptly is what lets a peer window take the server over
 * instead of every window sitting there with no BYOK endpoint.
 */
export function closeAllSinks(): void {
  const all = [...eventSinks, ...[...logSinks.values()].flatMap(sinks => [...sinks])]
  eventSinks.clear()
  logSinks.clear()
  for (const state of all) {
    try {
      state.sink.close()
    }
    catch { /* the peer is already gone, which is the desired end state */ }
  }
}

// ── transports ──────────────────────────────────────────────────

/** Minimal shape of the raw response behind a hijacked Fastify reply. */
export interface RawResponseLike {
  write: (chunk: string) => boolean
  end: () => void
  readonly writableLength?: number
  readonly destroyed?: boolean
}

/**
 * Serialize a frame as Server-Sent Events.
 *
 * `routes` expands to two frames — see serializeRoutesFrames() for why the
 * legacy one must stay on the wire.
 */
function toSseFrame(frame: ChannelFrame): string {
  switch (frame.kind) {
    case 'routes':
      return serializeRoutesFrames(frame.payload)
    case 'refresh':
      return 'event: refresh\ndata: {}\n\n'
    case 'shutdown':
      return 'event: shutdown\ndata: {}\n\n'
    case 'log':
      return `data: ${JSON.stringify(frame.entry)}\n\n`
    case 'comment':
      return `: ${frame.text}\n\n`
  }
}

export function createSseSink(raw: RawResponseLike): ChannelSink {
  return {
    transport: 'sse',
    bufferedBytes: () => raw.writableLength ?? 0,
    write(frame) {
      if (raw.destroyed)
        return false
      try {
        raw.write(toSseFrame(frame))
        return true
      }
      catch {
        return false
      }
    },
    close() {
      if (!raw.destroyed)
        raw.end()
    },
  }
}

/** Minimal shape of a `ws` WebSocket, so this module stays free of that import. */
export interface WebSocketLike {
  send: (data: string) => void
  close: () => void
  readonly bufferedAmount?: number
  readonly readyState?: number
}

/** `ws` / DOM WebSocket readyState for an open connection. */
const WS_OPEN = 1

/**
 * Serialize a frame as one JSON message.
 *
 * The event names match the SSE ones so a consumer can share its handlers; the
 * legacy bare-REST-array frame has no WebSocket equivalent because only hooks
 * predating this transport need it.
 */
function toWebSocketFrame(frame: ChannelFrame): string | null {
  switch (frame.kind) {
    case 'routes':
      return JSON.stringify({ event: SSE_EVENT_ROUTES, data: frame.payload, legacy: { event: SSE_EVENT_ROUTES_LEGACY, data: frame.payload.rest } })
    case 'refresh':
      return JSON.stringify({ event: 'refresh', data: {} })
    case 'shutdown':
      return JSON.stringify({ event: 'shutdown', data: {} })
    case 'log':
      return JSON.stringify({ event: 'log', data: frame.entry })
    case 'comment':
      // SSE keep-alive comments have no place in a framed protocol.
      return null
  }
}

export function createWebSocketSink(socket: WebSocketLike): ChannelSink {
  return {
    transport: 'ws',
    bufferedBytes: () => socket.bufferedAmount ?? 0,
    write(frame) {
      if (socket.readyState !== undefined && socket.readyState !== WS_OPEN)
        return false
      const payload = toWebSocketFrame(frame)
      if (payload === null)
        return true
      try {
        socket.send(payload)
        return true
      }
      catch {
        return false
      }
    },
    close() {
      socket.close()
    },
  }
}

// ── diagnostics ─────────────────────────────────────────────────

export interface PushChannelDiagnostics {
  logBackpressureLimitBytes: number
  events: {
    subscribers: number
    byTransport: Record<SinkTransport, number>
  }
  logs: Array<{
    windowId: number
    subscribers: number
    bufferedBytes: number
    droppedTotal: number
  }>
}

export function pushChannelDiagnostics(): PushChannelDiagnostics {
  const byTransport: Record<SinkTransport, number> = { sse: 0, ws: 0 }
  for (const state of eventSinks)
    byTransport[state.sink.transport]++

  return {
    logBackpressureLimitBytes: LOG_BACKPRESSURE_LIMIT_BYTES,
    events: { subscribers: eventSinks.size, byTransport },
    logs: [...logSinks.entries()].map(([windowId, sinks]) => ({
      windowId,
      subscribers: sinks.size,
      bufferedBytes: [...sinks].reduce((total, state) => total + state.sink.bufferedBytes(), 0),
      droppedTotal: [...sinks].reduce((total, state) => total + state.droppedTotal, 0),
    })),
  }
}

export function resetPushChannelForTests(): void {
  eventSinks.clear()
  logSinks.clear()
}
