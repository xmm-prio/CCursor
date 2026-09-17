import { parse } from 'acorn'
import { describe, expect, it } from 'vitest'
/**
 * Renderer channel payload — the source the installer prepends to workbench.js.
 *
 * It is generated as a string and only ever runs inside Cursor, so nothing else
 * catches a mistake in it. What is pinned here is the contract it shares with
 * this server (endpoint paths, event names) and the discipline that keeps one
 * window's permanently open channel from starving every other window's
 * requests: prefer WebSocket, fall back to SSE, hold exactly one link.
 */
// @ts-expect-error — plain-JS sibling package, deliberately untyped
import { buildHookPayload } from '../../../../installer/src/patch-inject.js'
// @ts-expect-error — plain-JS sibling package, deliberately untyped
import { buildRendererChannelSource, CHANNEL_WS_PATH, RENDERER_CHANNEL_VERSION_MARKER } from '../../../../installer/src/routes-channel.js'
import { SSE_EVENT_ROUTES } from '../data/defaults'

const source: string = buildRendererChannelSource({
  candidates: ['http://127.0.0.1:39831'],
  byokRedirect: ['REST:/auth/poll', 'aiserver.v1.AuthService', 'agent.v1.AgentService/RunSSE'],
})

describe('transport preference', () => {
  it('opens a WebSocket first — an SSE stream would hold one of the renderer\'s six sockets forever', () => {
    expect(source).toContain('new WebSocket(_byokWsUrl(base))')
    expect(source).toContain('if(_byokNoWs||typeof WebSocket==="undefined"){_byokConnectSse(base)}else{_byokConnectWs(base)}')
  })

  it('derives the WebSocket URL from the discovered endpoint, so a shifted port is followed', () => {
    expect(source).toContain(`String(base).replace(/^http/,"ws")+${JSON.stringify(CHANNEL_WS_PATH)}`)
  })

  it('falls back to SSE when the upgrade never opens, and stays there for the session', () => {
    // A CSP that forbids ws: does not change at runtime; re-probing every
    // reconnect would only add latency to a channel that is already degraded.
    expect(source).toContain('if(!opened){_byokNoWs=true')
    expect(source).toContain('_byokConnectSse(base);return}')
  })

  it('keeps the SSE fallback a full peer, not a stub', () => {
    expect(source).toContain('new EventSource(base+"/byok/events")')
    for (const event of ['"refresh"', '"shutdown"', JSON.stringify(SSE_EVENT_ROUTES)])
      expect(source).toContain(`es.addEventListener(${event}`)
  })
})

describe('wire contract with the server', () => {
  it('reads the same event names off both transports', () => {
    expect(source).toContain('if(m.event==="shutdown")')
    expect(source).toContain('if(m.event==="refresh")')
    expect(source).toContain(`if(m.event===${JSON.stringify(SSE_EVENT_ROUTES)})`)
  })

  it('probes /health the same way the extension does', () => {
    expect(source).toContain('_origFetch(base+"/health"')
    expect(source).toContain('d.mode==="byok"')
  })

  it('carries the version stamp the installer uses to detect a stale payload', () => {
    expect(source).toContain(`/* ${RENDERER_CHANNEL_VERSION_MARKER} */`)
  })
})

describe('link discipline', () => {
  it('holds one link at a time, whatever its transport', () => {
    expect(source).toContain('function _byokConnect(base){_byokDropLink();')
    expect(source).toContain('function _byokSchedule(){if(_byokLink||_byokProbing||_byokTimer)return;')
  })

  it('ignores a superseded link, so a dead one cannot schedule reconnects', () => {
    expect(source).toContain('function _byokLinkLost(link,reason){if(_byokLink!==link)return;')
    expect(source).toContain('ws.addEventListener("close",function(){if(_byokLink!==link)return;')
  })

  it('restarts discovery from scratch on shutdown — the next owner may hold another port', () => {
    expect(source).toContain('if(reason==="shutdown"){_byokRetry=1000')
    expect(source).toContain('function _byokDiscover(){if(_byokProbing||_byokLink)return;')
  })

  it('caps the reconnect backoff', () => {
    expect(source).toContain('_byokRetry=Math.min(_byokRetry*2,10000)')
  })
})

describe('readiness gate', () => {
  it('suspends only the BYOK whitelist, never login or the always-on stubs', () => {
    expect(source).toContain('var _gateRest=["/auth/poll"]')
    expect(source).toContain('_gateSvc=new Set(["aiserver.v1.AuthService"])')
    expect(source).toContain('_gateMtd=new Set(["agent.v1.AgentService/RunSSE"])')
  })

  it('always releases, so a server that never answers cannot freeze the UI', () => {
    expect(source).toContain('_byokRelease("timeout after')
  })
})

describe('emitted source shape', () => {
  it('stays ES5-compatible — it is prepended to a minified production bundle', () => {
    expect(source).not.toMatch(/=>/)
    expect(source).not.toMatch(/\?\./)
    expect(source).not.toMatch(/`/)
    expect(source).not.toMatch(/\bconst\b|\blet\b/)
  })

  it('parses inside the full hook payload, in both workbench variants', () => {
    // The channel is concatenated into one IIFE with the rest of the hook, and
    // a syntax error there takes the whole workbench bundle down. Nothing else
    // parses this before it is written into Cursor's own files.
    for (const hasGlass of [true, false]) {
      const payload: string = buildHookPayload(hasGlass)
      expect(payload).toContain(RENDERER_CHANNEL_VERSION_MARKER)
      expect(() => parse(payload, { ecmaVersion: 2022, sourceType: 'script' })).not.toThrow()
    }
  })
})
