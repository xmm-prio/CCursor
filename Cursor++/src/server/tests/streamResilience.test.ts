import type { AgentServerMessage } from '../gen/agent_v1_pb'
import type { ToolCallInfo } from '../handlers/agent/tools'
import type { StreamRetryPolicy } from '../handlers/llm/retryPolicy'
import type { LLMContentBlock, LLMProvider, LLMStreamEvent, LLMStreamRequest } from '../handlers/llm/types'
import { describe, expect, it } from 'vitest'
import { discardRestartedRoundState } from '../handlers/agent/conversationRuntime'
import { translateStream } from '../handlers/agent/stream'
import { withStreamResilience } from '../handlers/llm/resilientProvider'
import { STREAM_RETRY_POLICY } from '../handlers/llm/retryPolicy'

/**
 * Stream resilience — provider 层重试装饰器 + 下游 stream_restart 消费。
 *
 * 断连是这条链路里唯一无法用真实上游复现的输入,所以全部用脚本化的假 provider
 * 驱动: 每个 attempt 声明"先吐哪些事件, 再以什么方式失败", 装饰器的重试决策
 * 与下游的状态丢弃都在同一条流里被观察。
 */

/** 单次 attempt 的脚本: 先按序吐 events, 若 failWith 非空则随后抛出 */
interface AttemptScript {
  events: LLMStreamEvent[]
  failWith?: unknown
}

interface FakeProvider extends LLMProvider {
  /** inner.stream() 被调用的次数 = 实际发生的 attempt 数 */
  readonly attempts: number
  /** 内层 iterator 走到 finally 的次数 —— 用于验证消费者 break 时连接被关闭 */
  readonly closedIterators: number
  /** 每个 attempt 实际 yield 出去的事件数 */
  readonly emittedPerAttempt: number[]
}

function createFakeProvider(scripts: AttemptScript[], name = 'fake-provider'): FakeProvider {
  let attempts = 0
  let closedIterators = 0
  const emittedPerAttempt: number[] = []

  return {
    name,
    get attempts() {
      return attempts
    },
    get closedIterators() {
      return closedIterators
    },
    emittedPerAttempt,
    stream(_request: LLMStreamRequest): AsyncIterable<LLMStreamEvent> {
      const script = scripts[attempts] ?? scripts[scripts.length - 1]!
      attempts++
      const slot = emittedPerAttempt.push(0) - 1
      return (async function* () {
        try {
          for (const event of script.events) {
            emittedPerAttempt[slot]!++
            yield event
          }
          if (script.failWith !== undefined)
            throw script.failWith
        }
        finally {
          closedIterators++
        }
      })()
    },
  }
}

function recordingSleep(): { delays: number[], sleep: (ms: number) => Promise<void> } {
  const delays: number[] = []
  return {
    delays,
    sleep: async (ms: number) => {
      delays.push(ms)
    },
  }
}

const REQUEST: LLMStreamRequest = {
  model: 'test-model',
  messages: [{ role: 'user', content: 'hello' }],
}

async function collect(stream: AsyncIterable<LLMStreamEvent>): Promise<LLMStreamEvent[]> {
  const events: LLMStreamEvent[] = []
  for await (const event of stream)
    events.push(event)
  return events
}

/** undici/SDK 侧的瞬时断连 —— `terminated` 命中 TRANSIENT_MESSAGE_PATTERNS */
function transientError(label = 'terminated'): Error {
  return new Error(label)
}

function socketError(): Error {
  return Object.assign(new Error('socket reset by peer'), { code: 'ECONNRESET' })
}

function unauthorizedError(): Error {
  return Object.assign(new Error('401 Unauthorized: invalid api key'), { status: 401 })
}

function invalidRequestError(): Error {
  return new Error('invalid_request_error: tool name does not match schema')
}

function userAbortError(): Error {
  return Object.assign(new Error('Request was aborted.'), { name: 'APIUserAbortError' })
}

describe('withStreamResilience', () => {
  it('首个事件前断连时静默重跑, 下游只看到一条完整的流', async () => {
    const inner = createFakeProvider([
      { events: [], failWith: socketError() },
      { events: [{ type: 'text_delta', text: 'hello' }, { type: 'done', usage: { inputTokens: 1, outputTokens: 1 }, stopReason: 'end_turn' }] },
    ])
    const { delays, sleep } = recordingSleep()

    const events = await collect(withStreamResilience(inner, STREAM_RETRY_POLICY, { sleep }).stream(REQUEST))

    expect(inner.attempts).toBe(2)
    expect(delays).toHaveLength(1)
    expect(events.map(event => event.type)).toEqual(['text_delta', 'done'])
    expect(events.some(event => event.type === 'stream_restart')).toBe(false)
  })

  it('已吐字后断连时先发 stream_restart, 再完整重放第二次 attempt', async () => {
    const inner = createFakeProvider([
      {
        events: [{ type: 'text_delta', text: 'partial' }],
        failWith: transientError(),
      },
      {
        events: [
          { type: 'text_delta', text: 'complete' },
          { type: 'done', usage: { inputTokens: 2, outputTokens: 3 }, stopReason: 'end_turn' },
        ],
      },
    ])
    const { sleep } = recordingSleep()

    const events = await collect(withStreamResilience(inner, STREAM_RETRY_POLICY, { sleep }).stream(REQUEST))

    expect(events.map(event => event.type)).toEqual(['text_delta', 'stream_restart', 'text_delta', 'done'])
    const restart = events[1]
    expect(restart).toEqual({ type: 'stream_restart', attempt: 2, reason: 'terminated' })
    expect(events.slice(2)).toEqual([
      { type: 'text_delta', text: 'complete' },
      { type: 'done', usage: { inputTokens: 2, outputTokens: 3 }, stopReason: 'end_turn' },
    ])
  })

  it.each([
    ['401 鉴权错', unauthorizedError],
    ['invalid_request_error 请求体校验错', invalidRequestError],
    ['用户中断 (APIUserAbortError)', userAbortError],
  ])('%s 不重试, 原样抛出', async (_label, makeError) => {
    const failure = makeError()
    const inner = createFakeProvider([
      { events: [{ type: 'text_delta', text: 'partial' }], failWith: failure },
      { events: [{ type: 'done', usage: { inputTokens: 0, outputTokens: 0 }, stopReason: 'end_turn' }] },
    ])
    const { delays, sleep } = recordingSleep()

    await expect(collect(withStreamResilience(inner, STREAM_RETRY_POLICY, { sleep }).stream(REQUEST)))
      .rejects
      .toBe(failure)
    expect(inner.attempts).toBe(1)
    expect(delays).toEqual([])
  })

  it('重试次数耗尽后抛出最后一次的错误', async () => {
    const failures = [transientError('terminated #1'), transientError('terminated #2'), transientError('terminated #3'), transientError('terminated #4')]
    const inner = createFakeProvider(failures.map(failWith => ({ events: [], failWith })))
    const { delays, sleep } = recordingSleep()

    await expect(collect(withStreamResilience(inner, STREAM_RETRY_POLICY, { sleep }).stream(REQUEST)))
      .rejects
      .toBe(failures[STREAM_RETRY_POLICY.maxAttempts - 1])
    expect(inner.attempts).toBe(STREAM_RETRY_POLICY.maxAttempts)
    expect(delays).toHaveLength(STREAM_RETRY_POLICY.maxAttempts - 1)
  })

  it('退避时长按默认策略指数增长, 且落在 jitter 区间内', async () => {
    const inner = createFakeProvider([{ events: [], failWith: transientError() }])
    const { delays, sleep } = recordingSleep()

    await expect(collect(withStreamResilience(inner, STREAM_RETRY_POLICY, { sleep }).stream(REQUEST))).rejects.toThrow()

    const expectedBase = [500, 1000, 2000]
    expect(delays).toHaveLength(expectedBase.length)
    delays.forEach((delay, index) => {
      const base = expectedBase[index]!
      expect(delay).toBeGreaterThanOrEqual(Math.round(base * (1 - STREAM_RETRY_POLICY.jitterRatio)) - 1)
      expect(delay).toBeLessThanOrEqual(Math.round(base * (1 + STREAM_RETRY_POLICY.jitterRatio)) + 1)
    })
  })

  it('退避时长被 maxDelayMs 夹住 (零 jitter 下可精确断言)', async () => {
    const policy: StreamRetryPolicy = { maxAttempts: 5, baseDelayMs: 1000, maxDelayMs: 3000, jitterRatio: 0 }
    const inner = createFakeProvider([{ events: [], failWith: transientError() }])
    const { delays, sleep } = recordingSleep()

    await expect(collect(withStreamResilience(inner, policy, { sleep }).stream(REQUEST))).rejects.toThrow()

    expect(delays).toEqual([1000, 2000, 3000, 3000])
  })

  it('消费者 break 时关闭内层 iterator 且不触发重试', async () => {
    const inner = createFakeProvider([
      {
        events: [
          { type: 'text_delta', text: 'first' },
          { type: 'text_delta', text: 'second' },
          { type: 'done', usage: { inputTokens: 1, outputTokens: 1 }, stopReason: 'end_turn' },
        ],
      },
    ])
    const { delays, sleep } = recordingSleep()

    // 模拟客户端中断: 消费者拿到第一个事件就跳出 for-await (走 return() 而非 throw())
    const stopAfter = 1
    const seen: LLMStreamEvent[] = []
    for await (const event of withStreamResilience(inner, STREAM_RETRY_POLICY, { sleep }).stream(REQUEST)) {
      seen.push(event)
      if (seen.length >= stopAfter)
        break
    }

    expect(seen).toEqual([{ type: 'text_delta', text: 'first' }])
    expect(inner.attempts).toBe(1)
    // 只吐了 1/3 个事件就走完 finally —— 说明内层 generator 被提前关闭, SSE 连接不会泄漏
    expect(inner.emittedPerAttempt).toEqual([1])
    expect(inner.closedIterators).toBe(1)
    expect(delays).toEqual([])
  })

  it('消费者 throw() 注入的错误不算上游断连, 不重试', async () => {
    const inner = createFakeProvider([
      { events: [{ type: 'text_delta', text: 'first' }, { type: 'done', usage: { inputTokens: 1, outputTokens: 1 }, stopReason: 'end_turn' }] },
    ])
    const { delays, sleep } = recordingSleep()

    const injected = transientError('terminated by consumer')
    const iterator = withStreamResilience(inner, STREAM_RETRY_POLICY, { sleep }).stream(REQUEST)[Symbol.asyncIterator]()
    await iterator.next()

    await expect(iterator.throw?.(injected)).rejects.toBe(injected)
    expect(inner.attempts).toBe(1)
    expect(inner.closedIterators).toBe(1)
    expect(delays).toEqual([])
  })
})

/**
 * Agent 侧的丢弃语义。
 *
 * 完整驱动 `handleConversationRun` 需要一个成型的 ParsedRunRequest、session、
 * sqlite checkpoint 与真实 provider 路由, 与本用例要验证的那一件事(restart 后
 * 轮次累积物为空)不成比例。这里改走它的两个真实缝隙:
 *   - `translateStream` —— 负责把 stream_restart 翻成客户端可消化的帧
 *   - `discardRestartedRoundState` —— 负责清空轮次累积物
 * onEvent 里的累积逻辑按 conversationRuntime 的同名分支等价复刻。
 */
/** 与 conversationRuntime 的同名常量保持一致 (那边是模块私有的) */
const EDIT_TOOL_NAMES = new Set(['ApplyPatch', 'Edit', 'Write', 'EditNotebook'])

function frameCases(frames: AgentServerMessage[]): string[] {
  return frames.map((frame) => {
    if (frame.message.case !== 'interactionUpdate')
      return frame.message.case ?? 'unknown'
    return frame.message.value.message.case ?? 'unknown'
  })
}

describe('stream_restart 的 agent 侧消费', () => {
  it('restart 后本轮累积的 assistant 内容不含第一次 attempt 的任何产物', async () => {
    const inner = createFakeProvider([
      {
        events: [
          { type: 'thinking_delta', text: 'FIRST-THINKING' },
          { type: 'text_delta', text: 'FIRST-TEXT' },
          { type: 'tool_use_start', id: 'call-first', name: 'Write' },
        ],
        failWith: transientError(),
      },
      {
        events: [
          { type: 'text_delta', text: 'SECOND-TEXT' },
          { type: 'tool_use_start', id: 'call-second', name: 'Read' },
          { type: 'tool_use_done', id: 'call-second', arguments: '{"path":"a.ts"}' },
          { type: 'done', usage: { inputTokens: 5, outputTokens: 7 }, stopReason: 'tool_use' },
        ],
      },
    ])
    const { sleep } = recordingSleep()
    const provider = withStreamResilience(inner, STREAM_RETRY_POLICY, { sleep })

    const roundAssistantBlocks: LLMContentBlock[] = []
    const pendingToolCalls: ToolCallInfo[] = []
    const inflightToolCalls = new Map<string, { name: string, input: string }>()
    const attemptEditCallIds = new Set<string>()
    let currentThinking = ''
    let currentText = ''

    const flushPrefix = (): void => {
      if (currentThinking) {
        roundAssistantBlocks.push({ type: 'thinking', text: currentThinking })
        currentThinking = ''
      }
      if (currentText) {
        roundAssistantBlocks.push({ type: 'text', text: currentText })
        currentText = ''
      }
    }

    const frames: AgentServerMessage[] = []
    const translated = translateStream(provider.stream(REQUEST), '1', (event) => {
      switch (event.type) {
        case 'thinking_delta':
          currentThinking += event.text
          break
        case 'text_delta':
          currentText += event.text
          break
        case 'tool_use_start':
          flushPrefix()
          inflightToolCalls.set(event.id, { name: event.name, input: '' })
          if (EDIT_TOOL_NAMES.has(event.name))
            attemptEditCallIds.add(event.id)
          break
        case 'tool_use_done': {
          attemptEditCallIds.delete(event.id)
          const inflight = inflightToolCalls.get(event.id)
          if (inflight) {
            const input = JSON.parse(event.arguments ?? '{}') as Record<string, unknown>
            pendingToolCalls.push({ callId: event.id, name: inflight.name, input })
            roundAssistantBlocks.push({ type: 'tool_use', id: event.id, name: inflight.name, input })
            inflightToolCalls.delete(event.id)
          }
          break
        }
        case 'stream_restart':
          ;({ currentThinking, currentText } = discardRestartedRoundState({
            pendingToolCalls,
            inflightToolCalls,
            roundAssistantBlocks,
            attemptEditCallIds,
          }))
          break
        case 'done':
          flushPrefix()
          break
      }
    })

    for await (const frame of translated)
      frames.push(frame)

    // 第一次 attempt 的 thinking / text / tool call 一个都不能留下
    expect(JSON.stringify(roundAssistantBlocks)).not.toMatch(/FIRST/)
    expect(roundAssistantBlocks).toEqual([
      { type: 'text', text: 'SECOND-TEXT' },
      { type: 'tool_use', id: 'call-second', name: 'Read', input: { path: 'a.ts' } },
    ])
    expect(pendingToolCalls).toEqual([{ callId: 'call-second', name: 'Read', input: { path: 'a.ts' } }])
    expect(inflightToolCalls.size).toBe(0)
    expect(attemptEditCallIds.size).toBe(0)
    expect(currentThinking).toBe('')
    expect(currentText).toBe('')

    // translateStream 侧: 收掉半截思考块, 再用 heartbeat 把客户端推回 inference
    const cases = frameCases(frames)
    const restartAt = cases.indexOf('thinkingCompleted')
    expect(restartAt).toBeGreaterThanOrEqual(0)
    expect(cases[restartAt + 1]).toBe('heartbeat')
    expect(cases).not.toContain('turnEnded')
    expect(cases.filter(name => name === 'stepCompleted')).toHaveLength(1)
  })
})
