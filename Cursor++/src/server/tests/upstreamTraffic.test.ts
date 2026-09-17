/**
 * Upstream stream accounting.
 *
 * The point of this layer is that it stays a pure observer: the numbers it
 * reports must match the time a socket is actually held, and no stream may be
 * delayed, reordered or swallowed on the way through.
 */
import type { LLMProvider, LLMStreamEvent } from '../handlers/llm/types'
import { beforeEach, describe, expect, it } from 'vitest'
import { UPSTREAM_MAX_CONNECTIONS_PER_ORIGIN } from '../config/upstreamTuning'
import {
  resetUpstreamTrafficForTests,
  upstreamOriginOf,
  upstreamTrafficSnapshot,
  withUpstreamAccounting,
} from '../handlers/llm/upstreamTraffic'

const request = { model: 'claude-sonnet-4', messages: [] }

/** A provider whose stream stays open until the test releases it. */
function controllableProvider(name = 'test'): { provider: LLMProvider, release: () => void, fail: (error: Error) => void } {
  let release!: () => void
  let fail!: (error: Error) => void
  const gate = new Promise<void>((resolve, reject) => {
    release = resolve
    fail = reject
  })
  return {
    release: () => release(),
    fail: (error: Error) => fail(error),
    provider: {
      name,
      async* stream(): AsyncIterable<LLMStreamEvent> {
        yield { type: 'text_delta', text: 'hi' }
        await gate
      },
    },
  }
}

function originOf(name: string) {
  return upstreamTrafficSnapshot().origins.find(entry => entry.origin === name)
}

/** Start consuming and stop at the first event, leaving the stream open. */
async function openStream(provider: LLMProvider) {
  const iterator = provider.stream(request)[Symbol.asyncIterator]()
  await iterator.next()
  return iterator
}

beforeEach(() => {
  resetUpstreamTrafficForTests()
})

describe('upstreamOriginOf', () => {
  it('groups providers the way undici pools sockets — by origin', () => {
    expect(upstreamOriginOf('https://api.anthropic.com/v1', 'entry-a')).toBe('https://api.anthropic.com')
    expect(upstreamOriginOf('https://api.anthropic.com', 'entry-b')).toBe('https://api.anthropic.com')
  })

  it('keeps unparseable and synthetic entries visible under their own id', () => {
    expect(upstreamOriginOf('', 'synthetic-anthropic')).toBe('synthetic-anthropic')
    expect(upstreamOriginOf(undefined, 'synthetic-openai')).toBe('synthetic-openai')
    expect(upstreamOriginOf('not a url', 'broken-entry')).toBe('broken-entry')
  })
})

describe('in-flight accounting', () => {
  it('counts a stream for exactly as long as it is open', async () => {
    const upstream = controllableProvider()
    const provider = withUpstreamAccounting(upstream.provider, 'https://api.example.com')

    expect(upstreamTrafficSnapshot().inFlight).toBe(0)

    const iterator = await openStream(provider)
    expect(originOf('https://api.example.com')).toMatchObject({ inFlight: 1, started: 1, completed: 0 })

    upstream.release()
    await iterator.next()

    expect(originOf('https://api.example.com')).toMatchObject({ inFlight: 0, started: 1, completed: 1 })
  })

  it('adds up concurrent streams and remembers the peak', async () => {
    const first = controllableProvider()
    const second = controllableProvider()
    const a = withUpstreamAccounting(first.provider, 'https://api.example.com')
    const b = withUpstreamAccounting(second.provider, 'https://api.example.com')

    const iterA = await openStream(a)
    const iterB = await openStream(b)
    expect(originOf('https://api.example.com')).toMatchObject({ inFlight: 2, peakInFlight: 2 })

    first.release()
    await iterA.next()
    second.release()
    await iterB.next()

    expect(originOf('https://api.example.com')).toMatchObject({ inFlight: 0, peakInFlight: 2, completed: 2 })
  })

  it('keeps origins apart, because each has its own socket pool', async () => {
    const first = controllableProvider()
    const second = controllableProvider()
    await openStream(withUpstreamAccounting(first.provider, 'https://a.example.com'))
    await openStream(withUpstreamAccounting(second.provider, 'https://b.example.com'))

    expect(originOf('https://a.example.com')).toMatchObject({ inFlight: 1 })
    expect(originOf('https://b.example.com')).toMatchObject({ inFlight: 1 })
    expect(upstreamTrafficSnapshot().inFlight).toBe(2)
  })

  it('releases the count when the stream throws, and rethrows unchanged', async () => {
    const upstream = controllableProvider()
    const provider = withUpstreamAccounting(upstream.provider, 'https://api.example.com')
    const iterator = await openStream(provider)

    const boom = new Error('socket hang up')
    upstream.fail(boom)
    await expect(iterator.next()).rejects.toBe(boom)

    expect(originOf('https://api.example.com')).toMatchObject({ inFlight: 0, failed: 1, completed: 0 })
  })

  it('releases the count when the consumer abandons the stream', async () => {
    const upstream = controllableProvider()
    const provider = withUpstreamAccounting(upstream.provider, 'https://api.example.com')
    const iterator = await openStream(provider)

    // What `for await (...) { break }` does — the socket is released here.
    await iterator.return?.()

    expect(originOf('https://api.example.com')).toMatchObject({ inFlight: 0 })
  })

  it('passes every event through untouched', async () => {
    const provider = withUpstreamAccounting({
      name: 'passthrough',
      async* stream(): AsyncIterable<LLMStreamEvent> {
        yield { type: 'text_delta', text: 'a' }
        yield { type: 'text_delta', text: 'b' }
        yield { type: 'done', usage: { inputTokens: 1, outputTokens: 2 }, stopReason: 'end_turn' }
      },
    }, 'https://api.example.com')

    const seen: LLMStreamEvent[] = []
    for await (const event of provider.stream(request)) seen.push(event)

    expect(seen).toEqual([
      { type: 'text_delta', text: 'a' },
      { type: 'text_delta', text: 'b' },
      { type: 'done', usage: { inputTokens: 1, outputTokens: 2 }, stopReason: 'end_turn' },
    ])
  })
})

describe('pool saturation', () => {
  it('records one episode per crossing of the pool ceiling, not one per stream', async () => {
    const opened: Array<AsyncIterator<LLMStreamEvent>> = []
    const gates: Array<() => void> = []
    for (let i = 0; i < UPSTREAM_MAX_CONNECTIONS_PER_ORIGIN + 2; i++) {
      const upstream = controllableProvider(`p${i}`)
      gates.push(upstream.release)
      opened.push(await openStream(withUpstreamAccounting(upstream.provider, 'https://busy.example.com')))
    }

    expect(originOf('https://busy.example.com')).toMatchObject({
      inFlight: UPSTREAM_MAX_CONNECTIONS_PER_ORIGIN + 2,
      saturationEpisodes: 1,
    })

    // Drain below the ceiling and saturate again — that is a second episode.
    for (const release of gates.slice(0, 3)) release()
    for (const iterator of opened.slice(0, 3)) await iterator.next()
    expect(originOf('https://busy.example.com')!.inFlight).toBe(UPSTREAM_MAX_CONNECTIONS_PER_ORIGIN - 1)

    const extra = controllableProvider('extra')
    await openStream(withUpstreamAccounting(extra.provider, 'https://busy.example.com'))

    expect(originOf('https://busy.example.com')).toMatchObject({ saturationEpisodes: 2 })
  })

  it('reports the ceiling every count is measured against', () => {
    expect(upstreamTrafficSnapshot().connectionsPerOrigin).toBe(UPSTREAM_MAX_CONNECTIONS_PER_ORIGIN)
  })
})
