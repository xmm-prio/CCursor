import type { RoutesConfig } from '../data/defaults'
/**
 * Push channel — subscription bookkeeping, backpressure and the two transports.
 *
 * The behaviours pinned here are the ones that only go wrong once several
 * windows are subscribed at the same time: a stalled subscriber must not make
 * the shared process buffer without limit, a dead subscriber must be dropped
 * rather than retried forever, and shutting down must actually hang up so the
 * port is free for a peer window to take over.
 */
import type { ChannelFrame, ChannelSink } from '../pushChannel'
import { beforeEach, describe, expect, it } from 'vitest'
import { buildRoutesPayload } from '../config/routesPayload'
import { SSE_EVENT_ROUTES, SSE_EVENT_ROUTES_LEGACY } from '../data/defaults'
import {
  addEventSink,
  addLogSink,
  broadcastLog,
  closeAllSinks,
  createSseSink,
  createWebSocketSink,
  emitEvent,
  emitLog,
  emitShutdown,
  hasLogSink,
  LOG_BACKPRESSURE_LIMIT_BYTES,
  pushChannelDiagnostics,
  resetPushChannelForTests,
} from '../pushChannel'

function routesPayload() {
  const config: RoutesConfig = {
    $schemaVersion: 1,
    byokMode: 1,
    server: { host: '127.0.0.1', port: 39831 },
    collector: { host: '127.0.0.1', port: 14800 },
    redirect: ['REST:/auth/poll', 'aiserver.v1.AuthService'],
  }
  return buildRoutesPayload(config)
}

/** A sink that records everything, with a settable backlog. */
function fakeSink(transport: 'sse' | 'ws' = 'sse') {
  const state = {
    frames: [] as ChannelFrame[],
    buffered: 0,
    alive: true,
    closed: false,
  }
  const sink: ChannelSink = {
    transport,
    bufferedBytes: () => state.buffered,
    write(frame) {
      if (!state.alive)
        return false
      state.frames.push(frame)
      return true
    },
    close() {
      state.closed = true
    },
  }
  return { sink, state }
}

beforeEach(() => {
  resetPushChannelForTests()
})

describe('event channel', () => {
  it('broadcasts to every subscriber and reports the delivery count', () => {
    const a = fakeSink()
    const b = fakeSink('ws')
    addEventSink(a.sink)
    addEventSink(b.sink)

    expect(emitEvent({ kind: 'refresh' })).toBe(2)
    expect(a.state.frames).toEqual([{ kind: 'refresh' }])
    expect(b.state.frames).toEqual([{ kind: 'refresh' }])
  })

  it('drops a subscriber whose write failed instead of retrying it', () => {
    const dead = fakeSink()
    const live = fakeSink()
    addEventSink(dead.sink)
    addEventSink(live.sink)
    dead.state.alive = false

    expect(emitEvent({ kind: 'refresh' })).toBe(1)
    expect(emitEvent({ kind: 'refresh' })).toBe(1)
    expect(live.state.frames).toHaveLength(2)
    expect(pushChannelDiagnostics().events.subscribers).toBe(1)
  })

  it('stops delivering after unsubscribe', () => {
    const sink = fakeSink()
    const unsubscribe = addEventSink(sink.sink)
    unsubscribe()
    unsubscribe() // idempotent

    expect(emitEvent({ kind: 'refresh' })).toBe(0)
    expect(pushChannelDiagnostics().events.subscribers).toBe(0)
  })

  it('counts subscribers per transport', () => {
    addEventSink(fakeSink('sse').sink)
    addEventSink(fakeSink('ws').sink)
    addEventSink(fakeSink('ws').sink)

    expect(pushChannelDiagnostics().events.byTransport).toEqual({ sse: 1, ws: 2 })
  })
})

describe('log channel', () => {
  it('addresses entries to one window only', () => {
    const one = fakeSink()
    const two = fakeSink()
    addLogSink(1, one.sink)
    addLogSink(2, two.sink)

    emitLog(1, { level: 'info', msg: 'hello' })

    expect(one.state.frames).toHaveLength(1)
    expect(two.state.frames).toHaveLength(0)
  })

  it('broadcasts context-free entries to every window', () => {
    const one = fakeSink()
    const two = fakeSink()
    addLogSink(1, one.sink)
    addLogSink(2, two.sink)

    broadcastLog({ level: 'warn', msg: 'server restarting' })

    expect(one.state.frames).toHaveLength(1)
    expect(two.state.frames).toHaveLength(1)
  })

  it('reports whether a window is subscribed, so orphan logs can spill to disk', () => {
    const sink = fakeSink()
    const unsubscribe = addLogSink(7, sink.sink)
    expect(hasLogSink(7)).toBe(true)
    unsubscribe()
    expect(hasLogSink(7)).toBe(false)
  })
})

describe('backpressure', () => {
  it('drops log frames for a subscriber that stopped reading', () => {
    const stalled = fakeSink()
    addLogSink(1, stalled.sink)
    stalled.state.buffered = LOG_BACKPRESSURE_LIMIT_BYTES + 1

    for (let i = 0; i < 100; i++)
      emitLog(1, { level: 'info', msg: `line ${i}` })

    expect(stalled.state.frames).toHaveLength(0)
    expect(pushChannelDiagnostics().logs[0]).toMatchObject({ windowId: 1, droppedTotal: 100 })
  })

  it('tells the window how much it missed once it drains', () => {
    const stalled = fakeSink()
    addLogSink(1, stalled.sink)
    stalled.state.buffered = LOG_BACKPRESSURE_LIMIT_BYTES + 1
    emitLog(1, { level: 'info', msg: 'lost' })
    emitLog(1, { level: 'info', msg: 'lost too' })

    stalled.state.buffered = 0
    emitLog(1, { level: 'info', msg: 'back' })

    expect(stalled.state.frames).toHaveLength(2)
    const [notice, delivered] = stalled.state.frames
    expect(notice).toMatchObject({ kind: 'log', entry: { level: 'warn' } })
    expect((notice as { entry: { msg: string } }).entry.msg).toContain('2 log line(s) dropped')
    expect(delivered).toMatchObject({ kind: 'log', entry: { msg: 'back' } })
  })

  it('never drops event frames — they carry state the consumer cannot re-derive', () => {
    const stalled = fakeSink()
    addEventSink(stalled.sink)
    stalled.state.buffered = LOG_BACKPRESSURE_LIMIT_BYTES * 10

    expect(emitEvent({ kind: 'routes', payload: routesPayload() })).toBe(1)
    expect(stalled.state.frames).toHaveLength(1)
  })
})

describe('shutdown', () => {
  it('reaches both channels and then hangs up on everyone', () => {
    const event = fakeSink()
    const log = fakeSink()
    addEventSink(event.sink)
    addLogSink(3, log.sink)

    expect(emitShutdown()).toBe(2)
    expect(event.state.frames).toEqual([{ kind: 'shutdown' }])
    expect(log.state.frames).toEqual([{ kind: 'shutdown' }])

    closeAllSinks()

    expect(event.state.closed).toBe(true)
    expect(log.state.closed).toBe(true)
    expect(pushChannelDiagnostics().events.subscribers).toBe(0)
    expect(pushChannelDiagnostics().logs).toHaveLength(0)
  })

  it('survives a sink that throws on close', () => {
    const throwing: ChannelSink = {
      transport: 'sse',
      bufferedBytes: () => 0,
      write: () => true,
      close() {
        throw new Error('socket already gone')
      },
    }
    const healthy = fakeSink()
    addEventSink(throwing)
    addEventSink(healthy.sink)

    expect(() => closeAllSinks()).not.toThrow()
    expect(healthy.state.closed).toBe(true)
  })
})

describe('sse transport', () => {
  function fakeResponse() {
    const written: string[] = []
    return {
      written,
      raw: {
        writableLength: 0,
        destroyed: false,
        write(chunk: string) {
          written.push(chunk)
          return true
        },
        end() {
          this.destroyed = true
        },
      },
    }
  }

  it('emits both routes frames so hooks from an older installer keep working', () => {
    const response = fakeResponse()
    createSseSink(response.raw).write({ kind: 'routes', payload: routesPayload() })

    const frames = response.written.join('')
    expect(frames).toContain(`event: ${SSE_EVENT_ROUTES_LEGACY}`)
    expect(frames).toContain(`event: ${SSE_EVENT_ROUTES}`)
  })

  it('encodes refresh, shutdown, log and comment frames', () => {
    const response = fakeResponse()
    const sink = createSseSink(response.raw)
    sink.write({ kind: 'refresh' })
    sink.write({ kind: 'shutdown' })
    sink.write({ kind: 'log', entry: { level: 'info', msg: 'hi' } })
    sink.write({ kind: 'comment', text: 'connected' })

    expect(response.written).toEqual([
      'event: refresh\ndata: {}\n\n',
      'event: shutdown\ndata: {}\n\n',
      `data: ${JSON.stringify({ level: 'info', msg: 'hi' })}\n\n`,
      ': connected\n\n',
    ])
  })

  it('reports the peer as gone once the response is destroyed', () => {
    const response = fakeResponse()
    const sink = createSseSink(response.raw)
    sink.close()
    expect(sink.write({ kind: 'refresh' })).toBe(false)
  })

  it('surfaces the socket backlog as buffered bytes', () => {
    const response = fakeResponse()
    response.raw.writableLength = 4096
    expect(createSseSink(response.raw).bufferedBytes()).toBe(4096)
  })
})

describe('websocket transport', () => {
  function fakeSocket(readyState = 1) {
    const sent: string[] = []
    return {
      sent,
      socket: {
        readyState,
        bufferedAmount: 0,
        send(data: string) {
          sent.push(data)
        },
        close() {
          this.readyState = 3
        },
      },
    }
  }

  it('carries the routes payload plus the legacy REST array in one message', () => {
    const peer = fakeSocket()
    createWebSocketSink(peer.socket).write({ kind: 'routes', payload: routesPayload() })

    expect(peer.sent).toHaveLength(1)
    const message = JSON.parse(peer.sent[0])
    expect(message.event).toBe(SSE_EVENT_ROUTES)
    expect(message.data).toEqual(routesPayload())
    expect(message.legacy).toEqual({ event: SSE_EVENT_ROUTES_LEGACY, data: ['/auth/poll'] })
  })

  it('skips SSE keep-alive comments, which have no meaning in a framed protocol', () => {
    const peer = fakeSocket()
    expect(createWebSocketSink(peer.socket).write({ kind: 'comment', text: 'connected' })).toBe(true)
    expect(peer.sent).toHaveLength(0)
  })

  it('reports a socket that is not open as gone', () => {
    const peer = fakeSocket(3)
    expect(createWebSocketSink(peer.socket).write({ kind: 'refresh' })).toBe(false)
  })
})
