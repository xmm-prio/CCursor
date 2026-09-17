/**
 * Host topology — the single place that answers "which extension host am I,
 * and what does that make me responsible for".
 *
 * Cursor runs Cursor++ next to two families of injected HTTP routers:
 *
 *   - `cursor-always-local` declares `extensionKind: ["ui"]`, so it always
 *     lives on the user's machine, even in a Remote SSH window.
 *   - `cursor-agent-host` / `cursor-agent-exec` / `cursor-agent-worker` declare
 *     no `extensionKind` at all, and VS Code deduces `["workspace"]` for any
 *     manifest with a `main`. In a Remote SSH window they therefore run on the
 *     remote box, read the remote `~/.ccursor/routes.json` and dial the remote
 *     `127.0.0.1:<port>`.
 *
 * A single extension identity cannot cover both: `pickExtensionHostKind`
 * returns exactly one running location per extension, and the `extensionKind`
 * array is a priority list, not a fan-out. Covering both sides means shipping
 * two identities — the `ui` control identity the user interacts with, and a
 * headless `workspace` worker installed on the remote host — each owning the
 * BYOK server of its own machine.
 *
 * This module turns "which identity + which machine" into one value instead of
 * letting `vscode.env.remoteName` checks accumulate across the codebase. It is
 * free of vscode / fs imports so the decision stays unit-testable.
 */

/**
 * Deployment identity, fixed by the bundle entry point that was loaded.
 *
 * - `control` — the `ui` extension: full command surface, status bar, panel.
 * - `worker`  — the headless `workspace` companion: server and config only.
 */
export type HostRole = 'control' | 'worker'

/** Which machine this extension host process runs on, relative to the user. */
export type HostSide = 'local' | 'remote'

export interface HostTopologyInput {
  role: HostRole
  /** `vscode.env.remoteName`: set only when this host runs off the user's box. */
  remoteName?: string | null
}

export interface HostTopology {
  role: HostRole
  side: HostSide
  /** The resolved remote authority kind (`ssh-remote`, `wsl`, ...) or null. */
  remoteName: string | null
  /** Only the control identity contributes commands, status bar and panel. */
  ownsUserInterface: boolean
  /**
   * Whether asking `asExternalUri` for a renderer-facing address is meaningful.
   * On a local host the answer is always "no" and the call is skipped entirely,
   * which is what keeps the local topology byte-for-byte unchanged.
   */
  publishesExternalUrl: boolean
  /** Short human-readable form, used in logs and onboarding copy. */
  label: string
}

export function resolveHostTopology(input: HostTopologyInput): HostTopology {
  const remoteName = typeof input.remoteName === 'string' && input.remoteName.length > 0
    ? input.remoteName
    : null
  const side: HostSide = remoteName ? 'remote' : 'local'
  return {
    role: input.role,
    side,
    remoteName,
    ownsUserInterface: input.role === 'control',
    publishesExternalUrl: side === 'remote',
    label: remoteName
      ? `${input.role} identity on remote extension host (${remoteName})`
      : `${input.role} identity on local extension host`,
  }
}
