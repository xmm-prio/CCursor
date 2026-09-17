import type { AgentServerMessage } from '../gen/agent_v1_pb'
import { expect, it, vi } from 'vitest'
import { textDelta } from '../handlers/agent/stream'
import { withTurnKeepAlive } from '../handlers/agent/turnKeepAlive'

const INTERVAL_MS = 1_000

function frameCase(frame: AgentServerMessage): string {
  if (frame.message.case !== 'interactionUpdate')
    return frame.message.case ?? 'unknown'
  return frame.message.value.message.case ?? 'unknown'
}

/**
 * Pull one value, nudging fake time forward in small steps until it settles.
 *
 * Stepping matters: advancing a whole silent window in one jump would fire the inner
 * stream's timers in the same tick as the keep-alive's, and the heartbeats under test
 * would never be observed separately.
 */
async function pull(
  iterator: AsyncIterator<AgentServerMessage>,
): Promise<IteratorResult<AgentServerMessage>> {
  const settled = iterator.next().then(
    result => ({ ok: true as const, result }),
    error => ({ ok: false as const, error }),
  )
  let done = false
  void settled.then(() => {
    done = true
  })
  while (true) {
    if (done)
      break
    await vi.advanceTimersByTimeAsync(INTERVAL_MS / 4)
  }
  const outcome = await settled
  if (!outcome.ok)
    throw outcome.error
  return outcome.result
}

/** Collect the whole wrapped stream while driving fake time forward. */
async function drain(frames: AsyncIterable<AgentServerMessage>): Promise<string[]> {
  const iterator = withTurnKeepAlive(frames, INTERVAL_MS)[Symbol.asyncIterator]()
  const cases: string[] = []
  while (true) {
    const next = await pull(iterator)
    if (next.done)
      return cases
    cases.push(frameCase(next.value))
  }
}

it('fills a silent window with one heartbeat per interval', async () => {
  vi.useFakeTimers()
  try {
    async function* silentThenOneFrame(): AsyncIterable<AgentServerMessage> {
      await new Promise(resolve => setTimeout(resolve, INTERVAL_MS * 3 + INTERVAL_MS / 2))
      yield textDelta('hello')
    }

    const cases = await drain(silentThenOneFrame())
    expect(cases).toEqual(['heartbeat', 'heartbeat', 'heartbeat', 'textDelta'])
  }
  finally {
    vi.useRealTimers()
  }
})

it('does not insert heartbeats while frames keep arriving', async () => {
  vi.useFakeTimers()
  try {
    async function* chatty(): AsyncIterable<AgentServerMessage> {
      for (let i = 0; i < 5; i++) {
        await new Promise(resolve => setTimeout(resolve, INTERVAL_MS / 10))
        yield textDelta(`chunk-${i}`)
      }
    }

    const cases = await drain(chatty())
    expect(cases).toEqual(Array.from({ length: 5 }).fill('textDelta'))
  }
  finally {
    vi.useRealTimers()
  }
})

it('leaves no timer armed once the inner stream ends', async () => {
  vi.useFakeTimers()
  try {
    async function* twoFrames(): AsyncIterable<AgentServerMessage> {
      yield textDelta('a')
      await new Promise(resolve => setTimeout(resolve, INTERVAL_MS * 2))
      yield textDelta('b')
    }

    await drain(twoFrames())
    expect(vi.getTimerCount()).toBe(0)
  }
  finally {
    vi.useRealTimers()
  }
})

it('disarms the keep-alive timer when the consumer breaks out early', async () => {
  vi.useFakeTimers()
  try {
    let innerClosed = false
    async function* neverEnds(): AsyncIterable<AgentServerMessage> {
      try {
        while (true) {
          await new Promise(resolve => setTimeout(resolve, INTERVAL_MS * 10))
          yield textDelta('tick')
        }
      }
      finally {
        innerClosed = true
      }
    }

    const iterator = withTurnKeepAlive(neverEnds(), INTERVAL_MS)[Symbol.asyncIterator]()
    expect(frameCase((await pull(iterator)).value as AgentServerMessage)).toBe('heartbeat')

    // The inner generator only observes the return once its own sleep resolves.
    const returned = iterator.return?.(undefined as never)
    await vi.advanceTimersByTimeAsync(INTERVAL_MS * 10)
    await returned
    expect(innerClosed).toBe(true)
    expect(vi.getTimerCount()).toBe(0)
  }
  finally {
    vi.useRealTimers()
  }
})

it('propagates an inner failure instead of heartbeating forever', async () => {
  vi.useFakeTimers()
  try {
    async function* failing(): AsyncIterable<AgentServerMessage> {
      await new Promise(resolve => setTimeout(resolve, INTERVAL_MS * 2 + INTERVAL_MS / 2))
      yield textDelta('partial')
      throw new Error('upstream exploded')
    }

    const iterator = withTurnKeepAlive(failing(), INTERVAL_MS)[Symbol.asyncIterator]()
    const cases: string[] = []
    await expect((async () => {
      while (true) {
        const next = await pull(iterator)
        if (next.done)
          return
        cases.push(frameCase(next.value))
      }
    })()).rejects.toThrow('upstream exploded')
    expect(cases).toEqual(['heartbeat', 'heartbeat', 'textDelta'])
    expect(vi.getTimerCount()).toBe(0)
  }
  finally {
    vi.useRealTimers()
  }
})
