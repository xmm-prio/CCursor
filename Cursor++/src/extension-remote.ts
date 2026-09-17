/**
 * Entry point of the headless remote companion (`cursor2plus-remote`).
 *
 * Why a second identity exists: VS Code picks exactly one running location per
 * extension, and `extensionKind` is a priority list rather than a fan-out, so
 * the `ui` control extension can never also run on a Remote SSH host. The
 * routers injected into `cursor-agent-host` / `cursor-agent-exec` /
 * `cursor-agent-worker` do run there (their manifests have a `main` and no
 * `extensionKind`, which VS Code deduces as `workspace`), and they dial the
 * BYOK server through the remote loopback. This companion is what answers.
 *
 * It shares the whole activation path with the control identity — same server,
 * same config stores, same peer/takeover handling — and differs only in that
 * its manifest contributes no commands, view or settings, so nothing collides
 * with the control extension inside the same window.
 */
import type * as vscode from 'vscode'
import { bootstrap, deactivate } from './extension'

export function activate(context: vscode.ExtensionContext): Promise<void> {
  return bootstrap(context, 'worker')
}

export { deactivate }
