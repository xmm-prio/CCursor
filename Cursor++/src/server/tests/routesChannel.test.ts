import type { PortStatus } from '../config/portSelection'
/**
 * Routes delivery channel — payload projection, wire format and port fallback.
 *
 * These cover the parts three processes have to agree on: what the renderer
 * hook and the node routers receive over /byok/events, and which port the
 * server ends up claiming when its preferred one is taken.
 */
import type { RoutesConfig } from '../data/defaults'
import { describe, expect, it } from 'vitest'
import { selectServerPort } from '../config/portSelection'
import {
  buildRoutesPayload,
  buildServerUrl,
  normalizeExternalUrl,
  serializeRoutesFrames,
  splitRedirect,
} from '../config/routesPayload'
import { ROUTES_PAYLOAD_VERSION, SSE_EVENT_ROUTES, SSE_EVENT_ROUTES_LEGACY } from '../data/defaults'

function routes(overrides: Partial<RoutesConfig> = {}): RoutesConfig {
  return {
    $schemaVersion: 1,
    byokMode: 1,
    server: { host: '127.0.0.1', port: 39831 },
    collector: { host: '127.0.0.1', port: 14800 },
    redirect: [
      'REST:/auth/poll',
      'aiserver.v1.AuthService',
      'aiserver.v1.AiService/AvailableModels',
    ],
    ...overrides,
  }
}

describe('splitRedirect', () => {
  it('partitions REST paths, whole services and single methods', () => {
    expect(splitRedirect(routes().redirect)).toEqual({
      rest: ['/auth/poll'],
      services: ['aiserver.v1.AuthService'],
      methods: ['aiserver.v1.AiService/AvailableModels'],
    })
  })

  it('ignores empty and non-string entries', () => {
    const result = splitRedirect(['', 'aiserver.v1.AuthService', null as unknown as string])
    expect(result).toEqual({ rest: [], services: ['aiserver.v1.AuthService'], methods: [] })
  })
})

describe('buildServerUrl', () => {
  it('composes an http origin', () => {
    expect(buildServerUrl('127.0.0.1', 39831)).toBe('http://127.0.0.1:39831')
  })

  it('brackets a bare IPv6 literal', () => {
    expect(buildServerUrl('::1', 39831)).toBe('http://[::1]:39831')
    expect(buildServerUrl('[::1]', 39831)).toBe('http://[::1]:39831')
  })
})

describe('buildRoutesPayload', () => {
  it('carries endpoint, mode and the full whitelist', () => {
    const payload = buildRoutesPayload(routes())
    expect(payload.v).toBe(ROUTES_PAYLOAD_VERSION)
    expect(payload.byokMode).toBe(1)
    expect(payload.server).toEqual({
      host: '127.0.0.1',
      port: 39831,
      url: 'http://127.0.0.1:39831',
      externalUrl: null,
    })
    expect(payload.rest).toEqual(['/auth/poll'])
    expect(payload.services).toEqual(['aiserver.v1.AuthService'])
    expect(payload.methods).toEqual(['aiserver.v1.AiService/AvailableModels'])
  })

  it('reports a shifted port so consumers can follow it', () => {
    const payload = buildRoutesPayload(routes({ server: { host: '127.0.0.1', port: 39834 } }))
    expect(payload.server.port).toBe(39834)
    expect(payload.server.url).toBe('http://127.0.0.1:39834')
  })

  it('passes a forwarded address through when the host is remote', () => {
    const payload = buildRoutesPayload(routes({
      server: { host: '127.0.0.1', port: 39831, externalUrl: 'https://abcd-39831.tunnel.example.dev' },
    }))
    expect(payload.server.externalUrl).toBe('https://abcd-39831.tunnel.example.dev')
    expect(payload.server.url).toBe('http://127.0.0.1:39831')
  })

  it('treats an empty externalUrl as absent', () => {
    const payload = buildRoutesPayload(routes({
      server: { host: '127.0.0.1', port: 39831, externalUrl: '' },
    }))
    expect(payload.server.externalUrl).toBeNull()
  })
})

describe('serializeRoutesFrames', () => {
  const frames = serializeRoutesFrames(buildRoutesPayload(routes()))

  it('keeps the legacy frame a bare REST path array', () => {
    // Renderer hooks injected by an older installer assign the parsed value
    // straight into _restPaths; any other shape silently kills their redirects.
    const legacy = frames.match(new RegExp(`event: ${SSE_EVENT_ROUTES_LEGACY}\\ndata: (.*)\\n\\n`))
    expect(legacy).not.toBeNull()
    expect(JSON.parse(legacy![1])).toEqual(['/auth/poll'])
  })

  it('emits the full payload on the versioned event', () => {
    const v2 = frames.match(new RegExp(`event: ${SSE_EVENT_ROUTES}\\ndata: (.*)\\n\\n`))
    expect(v2).not.toBeNull()
    expect(JSON.parse(v2![1])).toEqual(buildRoutesPayload(routes()))
  })

  it('ships both frames in one write, legacy first', () => {
    expect(frames.indexOf(`event: ${SSE_EVENT_ROUTES_LEGACY}`))
      .toBeLessThan(frames.indexOf(`event: ${SSE_EVENT_ROUTES}`))
    expect(frames.endsWith('\n\n')).toBe(true)
  })

  it('contains no bare newline that would break SSE framing', () => {
    expect(frames.split('\n\n').filter(Boolean)).toHaveLength(2)
  })
})

describe('normalizeExternalUrl', () => {
  const local = 'http://127.0.0.1:39831'

  it('returns null when asExternalUri handed back the local address', () => {
    expect(normalizeExternalUrl(local, local)).toBeNull()
    expect(normalizeExternalUrl(local, `${local}/`)).toBeNull()
  })

  it('accepts a forwarded localhost port', () => {
    expect(normalizeExternalUrl(local, 'http://127.0.0.1:52341')).toBe('http://127.0.0.1:52341')
  })

  it('accepts a tunnel host and strips the trailing slash', () => {
    expect(normalizeExternalUrl(local, 'https://abcd-39831.tunnel.example.dev/'))
      .toBe('https://abcd-39831.tunnel.example.dev')
  })

  it('keeps a path prefix a tunnel may require', () => {
    expect(normalizeExternalUrl(local, 'https://tunnel.example.dev/proxy/39831/'))
      .toBe('https://tunnel.example.dev/proxy/39831')
  })

  it('falls back to null on missing, malformed or non-http results', () => {
    expect(normalizeExternalUrl(local, null)).toBeNull()
    expect(normalizeExternalUrl(local, undefined)).toBeNull()
    expect(normalizeExternalUrl(local, '')).toBeNull()
    expect(normalizeExternalUrl(local, 'not a url')).toBeNull()
    expect(normalizeExternalUrl(local, 'vscode://anysphere.cursor/tunnel')).toBeNull()
  })
})

describe('selectServerPort', () => {
  function prober(statuses: Record<number, PortStatus>) {
    const probed: number[] = []
    const probe = async (port: number) => {
      probed.push(port)
      return statuses[port] ?? 'free'
    }
    return { probe, probed }
  }

  it('keeps the preferred port when it is free', async () => {
    const { probe, probed } = prober({})
    await expect(selectServerPort(39831, 8, probe)).resolves.toEqual({
      port: 39831,
      status: 'free',
      shifted: false,
    })
    expect(probed).toEqual([39831])
  })

  it('walks upwards past foreign processes', async () => {
    const { probe, probed } = prober({ 39831: 'occupied', 39832: 'occupied' })
    await expect(selectServerPort(39831, 8, probe)).resolves.toEqual({
      port: 39833,
      status: 'free',
      shifted: true,
    })
    expect(probed).toEqual([39831, 39832, 39833])
  })

  it('stops at a Cursor++ peer instead of claiming another port', async () => {
    const { probe } = prober({ 39831: 'occupied', 39832: 'byok' })
    await expect(selectServerPort(39831, 8, probe)).resolves.toEqual({
      port: 39832,
      status: 'byok',
      shifted: true,
    })
  })

  it('gives up when the whole span is occupied', async () => {
    const statuses: Record<number, PortStatus> = {}
    for (let port = 39831; port < 39831 + 8; port++) statuses[port] = 'occupied'
    const { probe, probed } = prober(statuses)
    await expect(selectServerPort(39831, 8, probe)).resolves.toBeNull()
    expect(probed).toHaveLength(8)
  })

  it('never probes beyond the span', async () => {
    const { probe, probed } = prober({ 39831: 'occupied', 39832: 'occupied' })
    await expect(selectServerPort(39831, 2, probe)).resolves.toBeNull()
    expect(probed).toEqual([39831, 39832])
  })

  it('stops at the end of the port range', async () => {
    const { probe, probed } = prober({ 65535: 'occupied' })
    await expect(selectServerPort(65535, 8, probe)).resolves.toBeNull()
    expect(probed).toEqual([65535])
  })

  it('always probes at least the preferred port', async () => {
    const { probed, probe } = prober({})
    await selectServerPort(39831, 0, probe)
    expect(probed).toEqual([39831])
  })
})
