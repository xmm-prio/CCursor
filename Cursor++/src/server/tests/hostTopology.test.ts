import type { ProvidersConfig } from '../data/defaults'
import { describe, expect, it } from 'vitest'
import { resolveHostTopology } from '../config/hostTopology'
import { buildProviderSetupNotice, hasUsableProvider } from '../config/providerOnboarding'

const PROVIDERS_PATH = '/home/dev/.ccursor/providers.json'

function providers(models: string[]): ProvidersConfig {
  return {
    $schemaVersion: 1,
    providers: [{
      id: 'p',
      name: 'p',
      type: 'openai-chat',
      baseUrl: 'https://example.invalid',
      auth: { kind: 'apiKey', value: 'k' },
      models: models.map(id => ({ id, apiModel: id, displayName: id, thinking: false })),
    }],
  }
}

describe('resolveHostTopology', () => {
  it('treats an absent remoteName as the user machine', () => {
    const topology = resolveHostTopology({ role: 'control' })
    expect(topology.side).toBe('local')
    expect(topology.remoteName).toBeNull()
    expect(topology.ownsUserInterface).toBe(true)
    expect(topology.publishesExternalUrl).toBe(false)
  })

  it('treats an empty remoteName as the user machine as well', () => {
    expect(resolveHostTopology({ role: 'control', remoteName: '' }).side).toBe('local')
    expect(resolveHostTopology({ role: 'control', remoteName: null }).side).toBe('local')
  })

  it('marks a host with a remote authority as remote', () => {
    const topology = resolveHostTopology({ role: 'worker', remoteName: 'ssh-remote' })
    expect(topology.side).toBe('remote')
    expect(topology.remoteName).toBe('ssh-remote')
    expect(topology.publishesExternalUrl).toBe(true)
  })

  it('ties the user interface to the identity, not to the machine', () => {
    // The ui extension stays local even in a Remote SSH window, and the
    // headless companion must never register contributions it does not own.
    expect(resolveHostTopology({ role: 'worker', remoteName: 'ssh-remote' }).ownsUserInterface).toBe(false)
    expect(resolveHostTopology({ role: 'worker' }).ownsUserInterface).toBe(false)
    expect(resolveHostTopology({ role: 'control', remoteName: 'wsl' }).ownsUserInterface).toBe(true)
  })

  it('labels both axes for logs', () => {
    expect(resolveHostTopology({ role: 'worker', remoteName: 'ssh-remote' }).label)
      .toBe('worker identity on remote extension host (ssh-remote)')
    expect(resolveHostTopology({ role: 'control' }).label)
      .toBe('control identity on local extension host')
  })
})

describe('provider onboarding', () => {
  it('counts a provider as usable only once it exposes a model', () => {
    expect(hasUsableProvider(providers([]))).toBe(false)
    expect(hasUsableProvider({ $schemaVersion: 1, providers: [] })).toBe(false)
    expect(hasUsableProvider(providers(['gpt-x']))).toBe(true)
  })

  it('stays silent on the control identity, which has a panel', () => {
    const topology = resolveHostTopology({ role: 'control' })
    expect(buildProviderSetupNotice(topology, providers([]), PROVIDERS_PATH)).toBeNull()
  })

  it('guides a headless remote host that has no credentials yet', () => {
    const topology = resolveHostTopology({ role: 'worker', remoteName: 'ssh-remote' })
    const notice = buildProviderSetupNotice(topology, providers([]), PROVIDERS_PATH)
    expect(notice).not.toBeNull()
    expect(notice!.message).toContain('ssh-remote')
    expect(notice!.detail).toContain(PROVIDERS_PATH)
  })

  it('stays silent once the remote host is configured', () => {
    const topology = resolveHostTopology({ role: 'worker', remoteName: 'ssh-remote' })
    expect(buildProviderSetupNotice(topology, providers(['gpt-x']), PROVIDERS_PATH)).toBeNull()
  })
})
