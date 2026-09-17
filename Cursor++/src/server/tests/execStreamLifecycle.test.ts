import type { LLMMessage, LLMToolResultBlock } from '../handlers/llm/types'
import { describe, expect, it } from 'vitest'
import { abortInFlightExecs, finalizeExecTool } from '../handlers/agent/execRuntime'
import { createEphemeralSession, pushSessionMessage, registerBackgroundJob } from '../handlers/agent/session'
import { buildShellToolResult, buildToolResultText } from '../handlers/agent/toolResults'
import { isAgentRunAbortedError } from '../handlers/agent/wait'
import { anthropicStateStrategy } from '../handlers/llm/stateStrategy'

/**
 * Shell exec 流的终态判定。
 *
 * 只有 exit / backgrounded / rejected / permissionDenied 是协议的终态事件。
 * streamClose 先于 exit 到达、或等待直接断流时,命令的退出状态是未知的 ——
 * 此时 exitCode 停在初始值 0 而产出 success,等于把"不知道"谎报成"成功了"。
 */

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

function shellExecParams(session: ReturnType<typeof createEphemeralSession>, execMessageId: number) {
  const roundContext = createTestRoundContext()
  const messages: LLMMessage[] = []
  return {
    roundContext,
    messages,
    params: {
      session,
      toolName: 'Shell',
      callId: `call-${execMessageId}`,
      cursorToolType: 'shellToolCall',
      execMessageId,
      modelCallId: `model-${execMessageId}`,
      startedArgs: { command: 'pnpm build', toolCallId: `call-${execMessageId}` },
      input: { command: 'pnpm build' },
      roundContext,
      messages,
    },
  }
}

describe('c1 流终结条件', () => {
  it('streamClose 先于 exit 到达时产出明确错误,而不是 exitCode=0 假成功', async () => {
    const session = createEphemeralSession('shell-stream-close')
    pushSessionMessage(session, {
      execClientMessage: { id: 31, shellStream: { stdout: { data: 'partial output\n' } } },
    })
    pushSessionMessage(session, { execClientControlMessage: { streamClose: { id: 31 } } })

    const { roundContext, params } = shellExecParams(session, 31)
    const iterator = finalizeExecTool(params)
    let next = await iterator.next()
    while (!next.done) next = await iterator.next()

    const toolResult = roundContext.pendingToolResults[0]
    expect(toolResult.isError).toBe(true)
    expect(toolResult.content).toMatch(/Shell stream aborted/)
    expect(toolResult.content).toMatch(/exit status is unknown/)
    // 中断前收集到的输出必须带回去,否则排查时什么都不剩
    expect(toolResult.content).toMatch(/partial output/)
  })

  it('正常 exit 仍然产出成功结果', async () => {
    const session = createEphemeralSession('shell-exit')
    pushSessionMessage(session, {
      execClientMessage: { id: 32, shellStream: { stdout: { data: 'built ok\n' } } },
    })
    pushSessionMessage(session, {
      execClientMessage: { id: 32, shellStream: { exit: { code: 0, cwd: '/repo', localExecutionTimeMs: 12 } } },
    })

    const { roundContext, params } = shellExecParams(session, 32)
    const iterator = finalizeExecTool(params)
    let next = await iterator.next()
    while (!next.done) next = await iterator.next()

    const toolResult = roundContext.pendingToolResults[0]
    expect(toolResult.isError).toBeFalsy()
    expect(toolResult.content).toMatch(/exit_code: 0/)
    expect(toolResult.content).toMatch(/built ok/)
  })

  it('断流(等待返回 null)与 streamClose 给出不同的失败原因', () => {
    const closed = buildShellToolResult({ command: 'sleep 100' }, {
      stdout: '',
      stderr: '',
      exitCode: 0,
      streamFailure: { reason: 'streamClosedBeforeExit' },
    })
    const dropped = buildShellToolResult({ command: 'sleep 100' }, {
      stdout: '',
      stderr: '',
      exitCode: 0,
      streamFailure: { reason: 'streamEndedWithoutExit' },
    })

    expect(closed.result.case).toBe('spawnError')
    expect(dropped.result.case).toBe('spawnError')
    expect(buildToolResultText('shellToolCall', closed, { command: 'sleep 100' }))
      .toMatch(/closed the exec stream before reporting an exit status/)
    expect(buildToolResultText('shellToolCall', dropped, { command: 'sleep 100' }))
      .toMatch(/transport closed or wait timed out/)
  })
})

describe('c5 取消时回收在途 exec', () => {
  it('对每个在途 exec 下发 abort 控制消息并清空后台 job 登记', () => {
    const session = createEphemeralSession('abort-inflight')
    pushSessionMessage(session, { execClientMessage: { id: 41, shellStream: { stdout: { data: 'x' } } } })
    pushSessionMessage(session, { execClientMessage: { id: 42, shellStream: { stdout: { data: 'y' } } } })
    registerBackgroundJob(session, '7', { kind: 'shell', shellId: 7 })

    const frames = [...abortInFlightExecs(session, 'user_stopped_generation')]

    expect(frames).toHaveLength(2)
    const abortedIds = frames.map((frame) => {
      expect(frame.message.case).toBe('execServerControlMessage')
      if (frame.message.case !== 'execServerControlMessage')
        throw new Error('unexpected frame')
      expect(frame.message.value.message.case).toBe('abort')
      return frame.message.value.message.value?.id
    })
    expect(abortedIds.sort()).toEqual([41, 42])
    expect(session.backgroundJobs.size).toBe(0)
    expect(session.execChannels.size).toBe(0)
  })

  it('run 被取消时,正在等待的 shell exec 先收到 abort 再抛出中断', async () => {
    const session = createEphemeralSession('abort-on-cancel')
    const { params } = shellExecParams(session, 51)
    const iterator = finalizeExecTool(params)

    // 先让生成器进入等待 (此时通道已建立),再发中断
    const pending = iterator.next()
    await new Promise(resolve => setTimeout(resolve, 10))
    pushSessionMessage(session, { conversationAction: { cancelAction: { reason: 'user_stopped_generation' } } })

    const frames = []
    try {
      let next = await pending
      while (!next.done) {
        frames.push(next.value)
        next = await iterator.next()
      }
      expect.unreachable('should have thrown')
    }
    catch (error) {
      expect(isAgentRunAbortedError(error)).toBe(true)
    }

    const abortFrames = frames.filter(frame => frame.message.case === 'execServerControlMessage')
    expect(abortFrames).toHaveLength(1)
  })
})
