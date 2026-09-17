/**
 * First-run guidance for a host that owns a BYOK server but no credentials.
 *
 * `~/.ccursor/providers.json` is per-machine: the remote companion seeds an
 * empty file on the remote box and would otherwise fail every request with a
 * "no such model" style error that says nothing about the real cause. The
 * control identity needs no such nudge — it ships the panel, which already
 * shows an empty provider list — so the notice is deliberately scoped to hosts
 * that have no user interface of their own.
 */
import type { ProvidersConfig } from '../data/defaults'
import type { HostTopology } from './hostTopology'

export interface ProviderSetupNotice {
  message: string
  detail: string
}

/** A provider is only useful once it exposes at least one model. */
export function hasUsableProvider(config: ProvidersConfig): boolean {
  return config.providers.some(p => Array.isArray(p.models) && p.models.length > 0)
}

export function buildProviderSetupNotice(
  topology: HostTopology,
  config: ProvidersConfig,
  providersPath: string,
): ProviderSetupNotice | null {
  if (topology.ownsUserInterface || hasUsableProvider(config))
    return null
  const where = topology.remoteName ? `remote host (${topology.remoteName})` : 'this host'
  return {
    message: `Cursor++ is running on the ${where} without any BYOK provider configured.`,
    detail: `Agent requests made from the ${where} will fail until ${providersPath} lists a provider with at least one model. `
      + 'Credentials are not copied across machines: edit that file over there, or copy your local ~/.ccursor/providers.json to it.',
  }
}
