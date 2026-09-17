/**
 * Upstream transport tuning — the server → LLM provider hop.
 *
 * The mirror image of connectionTuning.ts, which owns the client → server hop.
 * Both files exist for the same reason: an agent turn is one HTTP request that
 * stays open for minutes and is legitimately silent between frames, so every
 * layer that could decide such a connection is dead needs an explicit answer
 * rather than a framework default.
 *
 * What makes this hop different is *who shares it*. There is exactly one BYOK
 * server per machine — the first Cursor window to bind the port owns it and
 * every other window becomes a peer routing into it — so this connection pool
 * is shared by every conversation of every workspace, plus every subagent they
 * spawn. A limit sized for one window silently becomes a machine-wide queue.
 */
import type { Agent } from 'undici'

/**
 * Per-origin socket pool size.
 *
 * One in-flight turn occupies one socket for its entire duration, so this
 * number is the ceiling on how many turns may stream from the same provider at
 * once, across every Cursor window on the machine. Exceeding it does not fail
 * and does not warn: undici parks the request in an internal queue with no
 * deadline of its own, so the turn simply produces nothing until an earlier one
 * finishes. That invisible wait is what "the agent is stuck before the first
 * token" looks like from the UI.
 *
 * The earlier value of 8 was sized for a single window. It is raised here so
 * the binding constraint becomes the provider's own rate limiter — which
 * answers with a 429 that retryPolicy.ts already classifies as retryable and
 * backs off from — instead of a local queue nobody can observe. Sockets are
 * created lazily, so a high ceiling costs nothing while the server is idle; it
 * only stops a burst of windows and subagents from serialising behind itself.
 */
export const UPSTREAM_MAX_CONNECTIONS_PER_ORIGIN = 64

/**
 * Dispatcher options shared by the direct and the proxied transport.
 *
 * An LLM stream is a single POST whose response body stays open for minutes and
 * whose chunks arrive in irregular bursts, so undici's request/response oriented
 * defaults are a poor fit. Every value below is chosen for that shape:
 *
 * - `connectTimeout` 15s: undici defaults to 10s, which is tight for a TLS
 *   handshake through a corporate proxy on a congested link. Still far below the
 *   point where a user would rather see an error than keep waiting.
 * - `headersTimeout` 120s: time to the first response byte. A healthy endpoint
 *   answers within seconds even when the prompt is large; 2 minutes of silence
 *   means the request is lost, and failing then is better than the 300s default
 *   because the application retry layer can start a new attempt sooner.
 * - `bodyTimeout` 600s: undici enforces this *between* body chunks, so the 300s
 *   default silently tears down sockets when a long-thinking model pauses. It is
 *   not disabled entirely: an upstream that wedges without closing the TCP
 *   connection must eventually surface as an error instead of hanging the turn.
 * - `keepAliveTimeout` 60s: how long an idle pooled socket is kept for reuse.
 *   The 4s default means nearly every follow-up round (tool call → next request)
 *   redials and repeats the TLS handshake — extra latency and one more chance to
 *   fail. 60s covers the think/tool-execution gaps of an agent loop.
 * - `keepAliveMaxTimeout` 600s: ceiling applied when the server advertises a
 *   larger keep-alive hint, so a generous upstream cannot pin sockets forever.
 * - `connections`: see UPSTREAM_MAX_CONNECTIONS_PER_ORIGIN.
 * - `pipelining` 1: never multiplex requests onto one HTTP/1.1 socket. A stalled
 *   stream would head-of-line block every request queued behind it.
 * - `autoSelectFamily` (Happy Eyeballs, RFC 8305): the common failure mode on
 *   consumer and corporate networks is an advertised but black-holed IPv6 route;
 *   without this the connection hangs until `connectTimeout`. Node enables it by
 *   default since v20, but undici only forwards it when it is set explicitly, so
 *   we state it rather than inherit it.
 * - `autoSelectFamilyAttemptTimeout` 500ms: Node's 250ms default gives up on a
 *   slow-but-working IPv6 path too eagerly; 500ms still costs at most half a
 *   second before falling back to IPv4.
 */
export const UPSTREAM_DISPATCHER_OPTIONS = {
  connectTimeout: 15_000,
  headersTimeout: 120_000,
  bodyTimeout: 600_000,
  keepAliveTimeout: 60_000,
  keepAliveMaxTimeout: 600_000,
  connections: UPSTREAM_MAX_CONNECTIONS_PER_ORIGIN,
  pipelining: 1,
  autoSelectFamily: true,
  autoSelectFamilyAttemptTimeout: 500,
} satisfies Agent.Options

/**
 * Socket-level options handed to undici's connector.
 *
 * TCP keep-alive probes are the backstop for `bodyTimeout`: during a long
 * thinking pause no application bytes flow, and a NAT/firewall in the middle
 * will happily drop an idle mapping. Probing every 30s keeps the mapping warm
 * and makes a peer that died mid-stream surface as ECONNRESET/ETIMEDOUT quickly
 * instead of after ten minutes of silence.
 *
 * `autoSelectFamily` is repeated here because ProxyAgent installs its own
 * connect function, which bypasses the dispatcher-level option.
 */
export const UPSTREAM_SOCKET_OPTIONS = {
  keepAlive: true,
  keepAliveInitialDelay: 30_000,
  autoSelectFamily: UPSTREAM_DISPATCHER_OPTIONS.autoSelectFamily,
  autoSelectFamilyAttemptTimeout: UPSTREAM_DISPATCHER_OPTIONS.autoSelectFamilyAttemptTimeout,
}
