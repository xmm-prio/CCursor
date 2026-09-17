import { describe, expect, it } from 'vitest'
import {
  claimSession,
  getOrCreateSession,
  isSessionCancelled,
  pushSessionMessage,
  waitForMessage,
} from '../handlers/agent/session'

describe('session lease', () => {
  it('adopts the session BidiAppend created before the stream arrived', () => {
    const queued = getOrCreateSession('lease-handshake')
    const lease = claimSession('lease-handshake')
    expect(lease.session).toBe(queued)
    lease.release()
  })

  it('hands a reconnecting stream a live session and cancels the abandoned run', () => {
    const first = claimSession('lease-reconnect')
    const second = claimSession('lease-reconnect')

    expect(second.session).not.toBe(first.session)
    expect(first.session.closed).toBe(true)
    expect(isSessionCancelled(first.session)).toBe(true)
    expect(second.session.closed).toBe(false)

    second.release()
  })

  it('carries messages the abandoned run never consumed over to the reconnect', () => {
    const first = claimSession('lease-carry')
    first.session.messages.push({ runRequest: {} })

    const second = claimSession('lease-carry')
    expect(second.session.messages).toEqual([{ runRequest: {} }])
    expect(first.session.messages).toEqual([])

    second.release()
  })

  it('ignores a late release from a stream that was already superseded', async () => {
    const first = claimSession('lease-late-release')
    const second = claimSession('lease-late-release')

    first.release()

    expect(second.session.closed).toBe(false)
    // The registry still routes BidiAppend to the live session, so the
    // reconnecting stream keeps being fed.
    expect(getOrCreateSession('lease-late-release')).toBe(second.session)
    const pending = waitForMessage(second.session, 1000)
    pushSessionMessage(second.session, { runRequest: {} })
    await expect(pending).resolves.toEqual({ runRequest: {} })

    second.release()
  })

  it('tears the session down once the owning stream releases it', () => {
    const lease = claimSession('lease-owner-release')
    lease.release()
    expect(lease.session.closed).toBe(true)
    expect(claimSession('lease-owner-release').session).not.toBe(lease.session)
  })
})
