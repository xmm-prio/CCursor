/**
 * Routes payload — the single wire format of the BYOK delivery channel.
 *
 * Three consumers have to agree on "where is the server" plus "which requests
 * belong to it": the renderer hook (injected into workbench*.main.js), the
 * node HTTP/1.1 routers (injected into every extension host) and the extension
 * itself. Instead of each of them deriving its own subset from routes.json,
 * everything is projected once into a RoutesPayload here, and that payload is
 * what travels over /byok/events.
 *
 * This module is intentionally free of fs / vscode / fastify imports so the
 * projection and its serialization stay unit-testable.
 */
import type { ByokMode, RoutesConfig } from '../data/defaults'
import { ROUTES_PAYLOAD_VERSION, SSE_EVENT_ROUTES, SSE_EVENT_ROUTES_LEGACY } from '../data/defaults'

const REST_PREFIX = 'REST:'

export interface RoutesWhitelist {
  /** REST paths, `REST:` prefix stripped, e.g. `/auth/poll` */
  rest: string[]
  /** Whole ConnectRPC services, e.g. `aiserver.v1.AuthService` */
  services: string[]
  /** Single ConnectRPC methods, e.g. `aiserver.v1.AiService/AvailableModels` */
  methods: string[]
}

export interface RoutesPayload extends RoutesWhitelist {
  v: number
  byokMode: ByokMode
  server: {
    host: string
    port: number
    /** Local address of the server, always present. */
    url: string
    /** Forwarded address for remote extension hosts, null when not applicable. */
    externalUrl: string | null
  }
}

/** Compose an http origin, bracketing bare IPv6 literals. */
export function buildServerUrl(host: string, port: number): string {
  const literal = String(host || '').trim()
  const bracketed = literal.includes(':') && !literal.startsWith('[') ? `[${literal}]` : literal
  return `http://${bracketed}:${port}`
}

/** Partition a routes.json `redirect` array into the three whitelist kinds. */
export function splitRedirect(redirect: readonly string[]): RoutesWhitelist {
  const rest: string[] = []
  const services: string[] = []
  const methods: string[] = []
  for (const rule of redirect) {
    if (typeof rule !== 'string' || rule.length === 0)
      continue
    if (rule.startsWith(REST_PREFIX))
      rest.push(rule.slice(REST_PREFIX.length))
    else if (rule.includes('/'))
      methods.push(rule)
    else
      services.push(rule)
  }
  return { rest, services, methods }
}

export function buildRoutesPayload(routes: RoutesConfig): RoutesPayload {
  const { host, port } = routes.server
  const externalUrl = typeof routes.server.externalUrl === 'string' && routes.server.externalUrl
    ? routes.server.externalUrl
    : null
  return {
    v: ROUTES_PAYLOAD_VERSION,
    byokMode: routes.byokMode,
    server: { host, port, url: buildServerUrl(host, port), externalUrl },
    ...splitRedirect(routes.redirect),
  }
}

/**
 * Render both SSE frames for one payload.
 *
 * The legacy `routes` frame keeps its historic shape (bare REST path array):
 * hooks injected by an older installer replace `_restPaths` with whatever they
 * parse, so changing that payload in place would silently disable their REST
 * redirects. New consumers ignore it and read `routes-v2` instead.
 */
export function serializeRoutesFrames(payload: RoutesPayload): string {
  return `event: ${SSE_EVENT_ROUTES_LEGACY}\ndata: ${JSON.stringify(payload.rest)}\n\n`
    + `event: ${SSE_EVENT_ROUTES}\ndata: ${JSON.stringify(payload)}\n\n`
}

/**
 * Reduce an asExternalUri() result to a usable origin, or null.
 *
 * asExternalUri is allowed to return the input unchanged (no remote in play),
 * an http(s) address on a random forwarded local port, or a tunnel host. Only
 * an address that actually differs from the local one is worth publishing;
 * anything else would just duplicate `server.url`.
 */
export function normalizeExternalUrl(localUrl: string, external: string | null | undefined): string | null {
  if (!external)
    return null
  let parsed: URL
  let local: URL
  try {
    parsed = new URL(external)
    local = new URL(localUrl)
  }
  catch {
    return null
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:')
    return null
  const path = parsed.pathname.replace(/\/+$/, '')
  const normalized = `${parsed.origin}${path}`
  if (normalized === `${local.origin}${local.pathname.replace(/\/+$/, '')}`)
    return null
  return normalized
}
