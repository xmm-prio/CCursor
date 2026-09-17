import type { AgentServerMessage } from '../gen/agent_v1_pb'
import type { LLMMessage, LLMToolResultBlock } from '../handlers/llm/types'
import { describe, expect, it } from 'vitest'
import {
  clampBlockUntilMs,
  finalizeShellAwaitTool,
  hasTerminalFooter,
  nextPollDelayMs,
} from '../handlers/agent/awaitRuntime'
import { createEphemeralSession, pushSessionMessage } from '../handlers/agent/session'
import { anthropicStateStrategy } from '../handlers/llm/stateStrategy'

/**
 * AwaitShell 的等待语义。
 *
 * 后台 shell 的终端文件持续增长,读一次拿到的快照在渲染出来时就已经过时。
 * 轮询要发生在这一次工具调用内部,直到终态 footer 出现或预算耗尽。
 */

const RUNNING_SNAPSHOT = [
  '---',
  'pid: 4242',
  'running_for_ms: 1500',
  '---',
  'compiling...',
].join('\n')

const FINISHED_SNAPSHOT = [
  RUNNING_SNAPSHOT,
  'done',
  '---',
  'exit_code: 0',
  'elapsed_ms: 2500',
  '---',
].join('\n')

describe('终态与退避的判定', () => {
  it('footer 里的 exit_code 才算终态', () => {
    expect(hasTerminalFooter(RUNNING_SNAPSHOT)).toBe(false)
    expect(hasTerminalFooter(FINISHED_SNAPSHOT)).toBe(true)
    // 命令自己打印的文字不能被误认成 footer
    expect(hasTerminalFooter('echo "exit_code: 0 is what we want"')).toBe(false)
  })

  it('空闲越久退避越长,并有上限', () => {
    expect(nextPollDelayMs(0)).toBe(500)
    expect(nextPollDelayMs(1)).toBe(1000)
    expect(nextPollDelayMs(2)).toBe(2000)
    expect(nextPollDelayMs(10)).toBe(5000)
  })

  it('block_until_ms 缺省为 30s,并被夹到合法区间', () => {
    expect(clampBlockUntilMs(undefined)).toBe(30_000)
    expect(clampBlockUntilMs('soon')).toBe(30_000)
    expect(clampBlockUntilMs(0)).toBe(0)
    expect(clampBlockUntilMs(-5)).toBe(0)
    expect(clampBlockUntilMs(99_999_999)).toBe(600_000)
  })
})

function createTestRoundContext() {
  const pendingToolResults: LLMToolResultBlock[] = []
  return {
    pendingToolResults,
    createToolResult: anthropicStateStrategy.createToolResult.bind(anthropicStateStrategy),
    recordToolResult(messages: LLMMessage[], result: LLMToolResultBlock) {
      anthropicStateStrategy.addToolResult(messages, pendingToolResults, result)
    },
  }
}

function readExecMessageId(frame: AgentServerMessage): number | null {
  return frame.message.case === 'execServerMessage' ? frame.message.value.id : null
}

/**
 * 驱动轮询生成器,按顺序用 `snapshots` 应答每一次 readArgs。
 * 用尽后继续重复最后一份快照。
 */
async function runAwait(blockUntilMs: number, snapshots: string[], pattern?: string) {
  const session = createEphemeralSession(`await-${blockUntilMs}-${snapshots.length}`)
  const roundContext = createTestRoundContext()
  let nextExecMessageId = 1
  let reads = 0

  const iterator = finalizeShellAwaitTool({
    session,
    toolName: 'AwaitShell',
    callId: 'call-await',
    cursorToolType: 'awaitToolCall',
    modelCallId: 'model-await',
    startedArgs: { taskId: '7' },
    input: { task_id: '7' },
    readArgs: { path: '/terminals/7.txt', toolCallId: 'call-await' },
    blockUntilMs,
    pattern,
    allocateExecMessageId: () => nextExecMessageId++,
    roundContext,
    messages: [],
  })

  let next = await iterator.next()
  while (!next.done) {
    const execMessageId = readExecMessageId(next.value)
    if (execMessageId !== null) {
      const content = snapshots[Math.min(reads, snapshots.length - 1)]
      reads++
      pushSessionMessage(session, {
        execClientMessage: {
          id: execMessageId,
          readResult: { success: { path: '/terminals/7.txt', content, totalLines: 5 } },
        },
      })
      pushSessionMessage(session, { execClientControlMessage: { streamClose: { id: execMessageId } } })
    }
    next = await iterator.next()
  }

  return { reads, content: roundContext.pendingToolResults[0]?.content ?? '', session }
}

describe('c2 有界轮询', () => {
  it('持续重读直到 footer 出现,并标注命令已结束', async () => {
    const { reads, content } = await runAwait(5000, [RUNNING_SNAPSHOT, RUNNING_SNAPSHOT, FINISHED_SNAPSHOT])

    expect(reads).toBe(3)
    expect(content).toMatch(/exit_code: 0/)
    expect(content).toMatch(/\[AwaitShell\] The command finished/)
  })

  it('预算耗尽时返回当前快照并标注仍在运行', async () => {
    const { reads, content } = await runAwait(0, [RUNNING_SNAPSHOT])

    // block_until_ms=0 = 非阻塞状态检查: 只读一次
    expect(reads).toBe(1)
    expect(content).toMatch(/compiling\.\.\./)
    expect(content).toMatch(/still running/)
    expect(content).toMatch(/snapshot, not the final output/)
  })

  it('pattern 命中即提前返回', async () => {
    const running = `${RUNNING_SNAPSHOT}\n`
    const listening = `${running}Server listening on :3000\n`
    const { reads, content } = await runAwait(5000, [running, listening], '^Server listening')

    expect(reads).toBe(2)
    expect(content).toMatch(/\[AwaitShell\] The requested pattern matched/)
  })

  it('终端文件读失败时原样透出错误,不标成"仍在运行"', async () => {
    const session = createEphemeralSession('await-unreadable')
    const roundContext = createTestRoundContext()
    let nextExecMessageId = 1

    const iterator = finalizeShellAwaitTool({
      session,
      toolName: 'AwaitShell',
      callId: 'call-await-missing',
      cursorToolType: 'awaitToolCall',
      modelCallId: 'model-await-missing',
      startedArgs: { taskId: '9' },
      input: { task_id: '9' },
      readArgs: { path: '/terminals/9.txt', toolCallId: 'call-await-missing' },
      blockUntilMs: 0,
      allocateExecMessageId: () => nextExecMessageId++,
      roundContext,
      messages: [],
    })

    let next = await iterator.next()
    while (!next.done) {
      const execMessageId = readExecMessageId(next.value)
      if (execMessageId !== null) {
        pushSessionMessage(session, {
          execClientMessage: {
            id: execMessageId,
            readResult: { error: { path: '/terminals/9.txt', error: 'ENOENT' } },
          },
        })
        pushSessionMessage(session, { execClientControlMessage: { streamClose: { id: execMessageId } } })
      }
      next = await iterator.next()
    }

    const toolResult = roundContext.pendingToolResults[0]
    expect(toolResult.isError).toBe(true)
    expect(toolResult.content).toMatch(/ENOENT/)
    expect(toolResult.content).not.toMatch(/still running/)
  })
})
