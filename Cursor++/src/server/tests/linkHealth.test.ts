import { expect, it, vi } from 'vitest'
import {
  createLinkHealth,
  isLinkLost,
  LINK_FAULT_GRACE_MS,
  linkHealthSnapshot,
  msUntilLinkLoss,
  observeAppend,
  SEQNO_REORDER_GRACE_MS,
  SEQNO_TRUST_THRESHOLD,
} from '../handlers/agent/linkHealth'
import { appendMessage, claimSession, waitForExecEventMatching } from '../handlers/agent/session'
import { ExecLinkLostError, waitForExecClientMessage } from '../handlers/agent/wait'

/** Total silence a gap must survive before it counts as a confirmed loss. */
const LOSS_AFTER_MS = SEQNO_REORDER_GRACE_MS + LINK_FAULT_GRACE_MS

function trustedHost(requestId = 'link-test'): { requestId: string, linkHealth: ReturnType<typeof createLinkHealth> } {
  const host = { requestId, linkHealth: createLinkHealth() }
  for (let seqno = 1; seqno <= SEQNO_TRUST_THRESHOLD + 1; seqno++)
    observeAppend(host, seqno)
  return host
}

it('does not trust a seqno stream until it has proven itself contiguous', () => {
  const host = { requestId: 'untrusted', linkHealth: createLinkHealth() }
  observeAppend(host, 1)
  observeAppend(host, 2)
  expect(host.linkHealth.trusted).toBe(false)
  observeAppend(host, 3)
  observeAppend(host, 4)
  expect(host.linkHealth.trusted).toBe(true)
})

it('never declares a fault when append_seqno is absent (always zero)', () => {
  const host = { requestId: 'zero-seqno', linkHealth: createLinkHealth() }
  for (let i = 0; i < 50; i++)
    observeAppend(host, 0n)

  expect(host.linkHealth.trusted).toBe(false)
  expect(host.linkHealth.observedGaps).toBe(0)
  expect(msUntilLinkLoss(host.linkHealth)).toBeNull()
  expect(isLinkLost(host.linkHealth, Date.now() + 10 * LOSS_AFTER_MS)).toBe(false)
})

it('never declares a fault when the seqno stream is not monotonic', () => {
  const host = { requestId: 'shuffled', linkHealth: createLinkHealth() }
  for (const seqno of [10, 4, 77, 5, 900, 12, 3, 1000])
    observeAppend(host, seqno)

  expect(host.linkHealth.trusted).toBe(false)
  expect(host.linkHealth.gaps.size).toBe(0)
  expect(msUntilLinkLoss(host.linkHealth)).toBeNull()
})

it('tolerates a reordered append that fills its own gap', () => {
  const host = trustedHost('reorder')
  const beforeGap = host.linkHealth.highestSeqno

  observeAppend(host, beforeGap + 2)
  expect(host.linkHealth.gaps.size).toBe(1)
  expect(host.linkHealth.observedGaps).toBe(1)

  observeAppend(host, beforeGap + 1)
  expect(host.linkHealth.gaps.size).toBe(0)
  expect(msUntilLinkLoss(host.linkHealth)).toBeNull()
})

it('escalates an unfilled gap to a loss only after both grace windows', () => {
  const host = trustedHost('escalate')
  const openedAt = Date.now()
  observeAppend(host, host.linkHealth.highestSeqno + 2)

  expect(isLinkLost(host.linkHealth, openedAt + SEQNO_REORDER_GRACE_MS)).toBe(false)
  expect(isLinkLost(host.linkHealth, openedAt + LOSS_AFTER_MS - 1)).toBe(false)
  expect(isLinkLost(host.linkHealth, openedAt + LOSS_AFTER_MS + 1)).toBe(true)
})

it('keeps a contiguous stream loss-free forever', () => {
  const host = trustedHost('contiguous')
  for (let i = 0; i < 200; i++)
    observeAppend(host, host.linkHealth.highestSeqno + 1)

  expect(linkHealthSnapshot(host.linkHealth)).toMatchObject({
    trusted: true,
    observedGaps: 0,
    pendingGaps: 0,
    lossReports: 0,
  })
  expect(isLinkLost(host.linkHealth, Date.now() + 10 * LOSS_AFTER_MS)).toBe(false)
})

it('wakes a parked waiter once the grace period of a real gap expires', async () => {
  vi.useFakeTimers()
  try {
    const lease = claimSession('link-lost-waiter')
    const session = lease.session
    for (let seqno = 1; seqno <= SEQNO_TRUST_THRESHOLD + 1; seqno++)
      appendMessage(session.requestId, '', seqno)

    const parked = waitForExecEventMatching(session, 99, () => false, null)
    // Seqno 6 is dropped in transit; 7 arriving is what exposes it.
    appendMessage(session.requestId, '', session.linkHealth.highestSeqno + 2)

    await vi.advanceTimersByTimeAsync(LOSS_AFTER_MS + 10)
    expect(await parked).toEqual({ kind: 'linkLost' })
    expect(session.linkHealth.lossReports).toBe(1)

    lease.release()
  }
  finally {
    vi.useRealTimers()
  }
})

it('surfaces a confirmed loss to exec waiters as ExecLinkLostError', async () => {
  vi.useFakeTimers()
  try {
    const lease = claimSession('link-lost-exec')
    const session = lease.session
    for (let seqno = 1; seqno <= SEQNO_TRUST_THRESHOLD + 1; seqno++)
      appendMessage(session.requestId, '', seqno)

    // The assertion has to be attached before time moves, otherwise the rejection lands
    // while nothing is listening and vitest reports an unhandled rejection.
    const rejects = expect(waitForExecClientMessage(session, 42, null)).rejects.toBeInstanceOf(ExecLinkLostError)
    appendMessage(session.requestId, '', session.linkHealth.highestSeqno + 2)

    await vi.advanceTimersByTimeAsync(LOSS_AFTER_MS + 10)
    await rejects

    lease.release()
  }
  finally {
    vi.useRealTimers()
  }
})

it('leaves a waiter parked when the uplink is healthy', async () => {
  vi.useFakeTimers()
  try {
    const lease = claimSession('link-healthy-waiter')
    const session = lease.session
    for (let seqno = 1; seqno <= 20; seqno++)
      appendMessage(session.requestId, '', seqno)

    let settled = false
    const parked = waitForExecEventMatching(session, 7, () => false, null)
    void parked.then(() => {
      settled = true
    })

    await vi.advanceTimersByTimeAsync(10 * LOSS_AFTER_MS)
    expect(settled).toBe(false)

    // Only the session ending releases it — exactly today's behaviour.
    lease.release()
    expect(await parked).toEqual({ kind: 'ended' })
  }
  finally {
    vi.useRealTimers()
  }
})
