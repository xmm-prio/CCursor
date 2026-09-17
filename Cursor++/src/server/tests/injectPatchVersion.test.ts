import { describe, expect, it } from 'vitest'
/**
 * Renderer hook classification.
 *
 * This is what decides whether a fix reaches an existing installation. A
 * bundle patched by an older installer is fully functional, so the tempting
 * answer is "already patched" — and that is precisely how a shipped change
 * silently never arrives. The three facts below are kept apart because they
 * fail independently and call for different actions: re-patch, upgrade the
 * payload, or refuse to touch a half-applied install.
 */
// @ts-expect-error — plain-JS sibling package, deliberately untyped
import { buildHookPayload, inspectInjectPatch, isInjectPatched } from '../../../../installer/src/patch-inject.js'
// @ts-expect-error — plain-JS sibling package, deliberately untyped
import { RENDERER_CHANNEL_VERSION_MARKER } from '../../../../installer/src/routes-channel.js'

const CALL_SITE = 'typeof globalThis.__byokWrapTransport==="function"?globalThis.__byokWrapTransport('

function bundle({ payload = false, callSite = false, channel = false } = {}): string {
  const head = payload
    ? `/* CURSOR-BYOK-HOOK-START */${channel ? `/* ${RENDERER_CHANNEL_VERSION_MARKER} */` : ''}(function(){})();/* CURSOR-BYOK-HOOK-END */;`
    : ''
  return `${head}function w(s,t){return d(s,${callSite ? CALL_SITE : ''}t)}`
}

describe('inspectInjectPatch', () => {
  it('reports a pristine bundle as untouched', () => {
    expect(inspectInjectPatch(bundle())).toMatchObject({
      payload: false,
      callSite: false,
      consistent: true,
      upToDate: false,
    })
  })

  it('reports a current install as up to date', () => {
    const code = bundle({ payload: true, callSite: true, channel: true })
    expect(inspectInjectPatch(code)).toMatchObject({ consistent: true, upToDate: true })
    expect(isInjectPatched(code)).toBe(true)
  })

  it('separates "patched by an older installer" from "not patched"', () => {
    const stale = inspectInjectPatch(bundle({ payload: true, callSite: true }))
    expect(stale).toMatchObject({
      payload: true,
      callSite: true,
      currentChannel: false,
      consistent: true,
      upToDate: false,
    })
    expect(isInjectPatched(bundle({ payload: true, callSite: true }))).toBe(false)
  })

  it('flags a half-applied patch either way round', () => {
    expect(inspectInjectPatch(bundle({ payload: true }))).toMatchObject({ consistent: false })
    expect(inspectInjectPatch(bundle({ callSite: true }))).toMatchObject({ consistent: false })
  })

  it('only trusts a payload that sits at the head of the bundle', () => {
    // The payload is prepended; the same marker appearing megabytes in is a
    // string in someone else's code, not our hook.
    const farAway = `${'/*pad*/'.repeat(30000)}/* CURSOR-BYOK-HOOK-START *//* ${RENDERER_CHANNEL_VERSION_MARKER} */`
    expect(inspectInjectPatch(`${farAway}${CALL_SITE}`).payload).toBe(false)
  })
})

describe('in-place upgrade', () => {
  const payload: string = buildHookPayload(false)

  it('is one self-guarding IIFE, which is what makes prepending safe', () => {
    // Upgrading does not remove the old payload, it puts a new one in front.
    // That only works because whichever copy runs first claims __byokReady and
    // the other returns before touching anything.
    expect(payload.startsWith('(function(){if(globalThis.__byokReady)return;globalThis.__byokReady=true;')).toBe(true)
    expect(payload.endsWith('})()')).toBe(true)
  })

  it('classifies a stale bundle as up to date once the fresh payload is prepended', () => {
    const stale = bundle({ payload: true, callSite: true })
    const upgraded = `/* CURSOR-BYOK-HOOK-START */${payload}/* CURSOR-BYOK-HOOK-END */;${stale}`

    expect(isInjectPatched(stale)).toBe(false)
    expect(isInjectPatched(upgraded)).toBe(true)
  })
})
