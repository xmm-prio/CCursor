import { describe, expect, it } from 'vitest'
import {
  activeExecMessageIds,
  closeExecChannel,
  EXEC_CHANNEL_MAX_EVENTS,
  execMessageIdOf,
  takeExecEvent,
} from '../handlers/agent/execChannels'
import { createEphemeralSession, pushSessionMessage, waitForExecEventMatching } from '../handlers/agent/session'

/**
 * exec 事件隔离。
 *
 * 所有 exec 消息曾共用 session.messages 一个队列: 等待者按 execMessageId 线性
 * 扫描并 splice,未匹配的消息无人清理、无上限。改为每个 exec 一个独立缓冲后,
 * 两个并发 exec 不可能消费到对方的事件。
 */

function shellChunk(execMessageId: number, data: string): Record<string, unknown> {
  return { execClientMessage: { id: execMessageId, shellStream: { stdout: { data } } } }
}

describe('execMessageIdOf', () => {
  it('识别 execClientMessage 与三类控制消息的归属 exec', () => {
    expect(execMessageIdOf(shellChunk(3, 'x'))).toBe(3)
    expect(execMessageIdOf({ execClientControlMessage: { streamClose: { id: 4 } } })).toBe(4)
    expect(execMessageIdOf({ execClientControlMessage: { throw: { id: 5, error: 'boom' } } })).toBe(5)
    expect(execMessageIdOf({ execClientControlMessage: { heartbeat: { id: 6 } } })).toBe(6)
    expect(execMessageIdOf({ interactionResponse: { id: 7 } })).toBeNull()
  })
})

describe('c3 per-exec 事件缓冲', () => {
  it('exec 消息不进共享队列,按 id 分流到各自的通道', () => {
    const session = createEphemeralSession('channels-1')
    pushSessionMessage(session, shellChunk(1, 'a'))
    pushSessionMessage(session, shellChunk(2, 'b'))
    pushSessionMessage(session, { interactionResponse: { id: 9 } })

    expect(session.messages).toHaveLength(1)
    expect(activeExecMessageIds(session).sort()).toEqual([1, 2])
    expect(session.execChannels.get(1)?.events).toHaveLength(1)
    expect(session.execChannels.get(2)?.events).toHaveLength(1)
  })

  it('一个 exec 的等待者拿不到另一个 exec 的事件', async () => {
    const session = createEphemeralSession('channels-2')
    const pending = waitForExecEventMatching(session, 1, () => true, 1000)

    pushSessionMessage(session, shellChunk(2, 'other exec'))
    pushSessionMessage(session, shellChunk(1, 'mine'))

    const got = await pending
    expect(got.kind).toBe('event')
    const ecm = (got as { event: Record<string, unknown> }).event.execClientMessage as Record<string, unknown>
    expect(ecm.id).toBe(1)
    // 另一个 exec 的事件原封不动留在它自己的缓冲里
    expect(session.execChannels.get(2)?.events).toHaveLength(1)
  })

  it('心跳不占缓冲 —— 没有任何等待者会消费它', () => {
    const session = createEphemeralSession('channels-3')
    pushSessionMessage(session, { execClientControlMessage: { heartbeat: { id: 1 } } })
    expect(session.execChannels.get(1)).toBeUndefined()
    expect(session.messages).toHaveLength(0)
  })

  it('缓冲超上限时丢弃最旧事件,保留最新的一批', () => {
    const session = createEphemeralSession('channels-4')
    for (let i = 0; i < EXEC_CHANNEL_MAX_EVENTS + 10; i++)
      pushSessionMessage(session, shellChunk(1, `chunk-${i}`))

    const channel = session.execChannels.get(1)!
    expect(channel.events).toHaveLength(EXEC_CHANNEL_MAX_EVENTS)
    expect(channel.droppedEvents).toBe(10)
    const oldest = takeExecEvent(session, 1, () => true)!
    const stream = (oldest.execClientMessage as Record<string, unknown>).shellStream as Record<string, unknown>
    expect((stream.stdout as Record<string, unknown>).data).toBe('chunk-10')
  })

  it('重复 waiter 会被记账,便于发现两个 owner 抢同一条流', async () => {
    const session = createEphemeralSession('channels-5')
    const first = waitForExecEventMatching(session, 1, () => true, 50)
    const second = waitForExecEventMatching(session, 1, () => true, 50)
    expect(session.execChannels.get(1)?.waiters).toBe(2)
    await Promise.all([first, second])
    expect(session.execChannels.get(1)?.waiters).toBe(0)
  })

  it('exec 结束后通道被销毁,不再滞留未消费事件', () => {
    const session = createEphemeralSession('channels-6')
    pushSessionMessage(session, shellChunk(1, 'leftover'))
    closeExecChannel(session, 1)
    expect(session.execChannels.size).toBe(0)
  })
})
