/**
 * Client-facing transport tuning — one home for every knob that decides how
 * long a Cursor client may hold a stream open against this server.
 *
 * The hop this file is about is *client → server*, not server → provider. An
 * agent turn is a single in-flight HTTP request that can stay open for many
 * minutes, and between frames the server is legitimately silent while the
 * model thinks or a tool runs. Three different layers can decide that such a
 * connection is dead, and each needs an explicit answer here rather than a
 * literal sprinkled over the Fastify setup:
 *
 *   - Node's per-request deadline (`requestTimeout`) would cut the turn off
 *     mid-stream no matter how many heartbeats travelled over it.
 *   - Node's idle keep-alive reaper (`keepAliveTimeout`) closes pooled sockets
 *     between requests; over a forwarded port the extra latency makes the
 *     "server closed it just as the client reused it" race much more likely,
 *     which surfaces as intermittent ECONNRESET rather than as a timeout.
 *   - The path itself. In SSH Remote / WSL / dev-container windows the
 *     connection traverses VS Code's port forwarding tunnel, plus whatever NAT
 *     sits in between, and those drop idle *TCP* flows. Application heartbeats
 *     do not help once the flow is gone, so the accepted sockets need OS-level
 *     keepalive probes of their own.
 */
import type { Server } from 'node:http'

/**
 * Idle keep-alive window for a pooled connection between two requests.
 *
 * Node's 5s default (Fastify raises it to 72s) is short enough that a tunnel
 * round trip can land inside the close race. Five minutes costs nothing here:
 * dead flows are reaped by the TCP keepalive probes below instead.
 */
export const KEEP_ALIVE_TIMEOUT_MS = 300_000

/**
 * Deadline for receiving a complete request head.
 *
 * Node requires this to exceed `keepAliveTimeout`, otherwise a socket that was
 * idle for almost the whole keep-alive window is torn down while its next
 * request head is still arriving.
 */
export const HEADERS_TIMEOUT_MS = KEEP_ALIVE_TIMEOUT_MS + 10_000

/**
 * Delay before the first TCP keepalive probe on an accepted socket.
 *
 * Short enough to keep NAT and SSH port-forwarding mappings warm through the
 * long silent windows of an agent turn, long enough to be free for the short
 * REST polls that make up most of the traffic.
 */
export const TCP_KEEPALIVE_DELAY_MS = 15_000

/**
 * Fastify options that disable every whole-request deadline.
 *
 * Both are already the Fastify 5 defaults; they are stated explicitly because
 * "a streaming turn has no duration limit" is a property of this server, not
 * something to inherit from a framework default that may change.
 */
export const STREAMING_TRANSPORT_OPTIONS = {
  /** 0 = no limit on how long one request may take, including the response. */
  requestTimeout: 0,
  /** 0 = no limit on how long a socket may live. */
  connectionTimeout: 0,
  keepAliveTimeout: KEEP_ALIVE_TIMEOUT_MS,
} as const

/**
 * Apply the settings that Fastify does not expose as constructor options.
 *
 * Call once on the raw `http.Server` before listening.
 */
export function tuneStreamingTransport(server: Server): void {
  server.headersTimeout = HEADERS_TIMEOUT_MS
  server.on('connection', (socket) => {
    // Streaming frames are small and latency-sensitive: Nagle would hold a
    // heartbeat back waiting for more bytes that are not coming.
    socket.setNoDelay(true)
    socket.setKeepAlive(true, TCP_KEEPALIVE_DELAY_MS)
  })
}
