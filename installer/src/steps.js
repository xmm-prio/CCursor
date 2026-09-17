/**
 * Patch step registry — the single ordered description of everything this
 * installer does to a Cursor install tree.
 *
 * Every step states what it needs from the tree (capabilities from profile.js,
 * plus an optional on-disk availability probe) and exposes the same four
 * operations: install, inspect, check, restore. install/status/check/uninstall
 * walk this list instead of knowing which files a given install shape owns, so
 * supporting a new shape (the REH server root) is a matter of the profile
 * reporting different capabilities — not of adding conditionals to commands.
 *
 * Order is install order; uninstall walks it in reverse.
 */
import { existsSync, readFileSync } from 'fs';
import { restoreBackup } from './backup.js';
import { installExtension, isExtensionInstalled, removeExtension } from './extension-embed.js';
import { checkGlassExtensionAllowlist, inspectInjectPatch, patchInject } from './patch-inject.js';
import { checkAlwaysLocalPatch, inspectAlwaysLocalPatch, patchAlwaysLocal } from './patch-always-local.js';
import { checkSigBypass, inspectSigBypass, patchSigBypass, SIG_BYPASS_TAG } from './patch-sig-bypass.js';
import { checkAgentHostPatch, getAgentHostBackupTargets, inspectAgentHostPatch, patchAgentHost } from './patch-agent-host.js';
import { checkProxy39Patch, getProxy39BackupTargets, inspectProxy39Patch, patchProxy39 } from './patch-proxy-39.js';
import { needsKatexPatch, patchKatex } from './patch-katex.js';
import {
  CAP_EXTENSION_HOST,
  CAP_RENDERER,
  CAP_UTILITY_PROCESS,
  CAP_WORKBENCH_HTML,
  extensionRunsHere,
} from './profile.js';

/** Line states understood by the reporting commands. */
const OK = 'ok';
const FAIL = 'fail';
const NA = 'na';

const line = (state, text) => ({ state, text });
const allOk = lines => lines.every(l => l.state !== FAIL);

function hostsUiExtensions(profile) {
  return profile.hostRoles.includes('ui');
}

export const PATCH_STEPS = [
  {
    id: 'extension',
    tag: 'extension',
    title: 'Cursor++ extension',
    requires: [],
    // The bundled VSIX is the UI half of Cursor++ (panel, commands, settings).
    // A tree that runs no UI extensions must not receive it; the remote half
    // is the separate cursor2plus-remote VSIX, installed by the user through
    // the Extensions view so that Cursor registers it for the remote host.
    available: profile => hostsUiExtensions(profile),
    skipNote: 'Bundled cursor2plus is a UI extension — install the cursor2plus-remote VSIX here instead',
    install: (paths, log) => installExtension(paths, log),
    inspect: (paths) => {
      const installed = isExtensionInstalled(paths);
      return { ok: installed, lines: [line(installed ? OK : FAIL, installed ? 'Extension installed' : 'Extension not installed')] };
    },
    check: () => true,
    backupTargets: () => [],
    restore: (paths, log) => {
      removeExtension(paths, log);
      return 0;
    },
  },

  {
    id: 'renderer-hook',
    tag: 'inject',
    title: 'Renderer hook',
    requires: [CAP_RENDERER],
    skipNote: 'No renderer bundle in this tree — renderer hook not applicable',
    install: (paths, log) => patchInject(paths, log),
    inspect: (paths) => {
      const lines = [];
      for (const [file, label] of [[paths.workbenchJs, 'desktop'], [paths.glassJs, 'glass']]) {
        if (!existsSync(file)) {
          lines.push(line(NA, `Renderer hook (${label}): bundle not present`));
          continue;
        }
        const hook = inspectInjectPatch(readFileSync(file, 'utf-8'));
        // A stale payload is reported as a failure on purpose: the bundle is
        // patched and Cursor works, but the window is still on the previous
        // routes channel, which is exactly the state a silent "OK" would hide.
        const note = hook.upToDate
          ? 'injected'
          : hook.payload && hook.callSite
            ? 'injected but payload is stale — re-run install'
            : 'not injected';
        lines.push(line(hook.upToDate ? OK : FAIL, `Renderer hook ${note} (${label})`));
      }
      return { ok: allOk(lines), lines };
    },
    check: (paths, log) => checkRendererHook(paths, log),
    backupTargets: paths => [paths.glassJs, paths.workbenchJs],
  },

  {
    id: 'always-local',
    tag: 'always-local',
    title: 'Legacy Agent transport (cursor-always-local)',
    requires: [],
    available: profile => extensionRunsHere(profile, 'cursor-always-local'),
    skipNote: 'cursor-always-local is a UI extension and does not run in this tree',
    install: (paths, log) => patchAlwaysLocal(paths, log),
    inspect: (paths) => {
      const state = inspectAlwaysLocalPatch(paths);
      const lines = [
        line(state.router ? OK : FAIL, `Legacy Agent HTTP/1.1 router ${state.router ? 'active' : 'missing'}`),
        line(state.wait ? OK : FAIL, `Legacy Agent server wait ${state.wait ? 'active' : 'missing'}`),
      ];
      if (state.websocketRequired) {
        lines.push(line(state.websocketDisabled ? OK : FAIL,
          `Legacy Agent WebSocket bypass ${state.websocketDisabled ? 'disabled' : 'is active'}`));
      }
      return { ok: state.fullyPatched, lines };
    },
    check: (paths, log) => checkAlwaysLocalPatch(paths, log),
    backupTargets: paths => [paths.alwaysLocalMain],
  },

  {
    id: 'sig-bypass',
    tag: SIG_BYPASS_TAG,
    title: 'Built-in extension signature bypass',
    requires: [CAP_EXTENSION_HOST],
    skipNote: 'extensionHostProcess.js not present — signature bypass not applicable',
    install: (paths, log) => patchSigBypass(paths, log),
    inspect: (paths) => {
      const state = inspectSigBypass(paths);
      return {
        ok: state.applied,
        lines: [line(state.applied ? OK : FAIL, `Signature bypass ${state.applied ? 'active' : 'not active'}`)],
      };
    },
    check: (paths, log) => checkSigBypass(paths, log),
    backupTargets: paths => [paths.extensionHostJs],
  },

  {
    id: 'agent-host',
    tag: 'agent-host',
    title: 'Agent Host transport (cursor-agent-host)',
    requires: [],
    available: profile => extensionRunsHere(profile, 'cursor-agent-host'),
    skipNote: 'cursor-agent-host not shipped in this tree (pre-3.13)',
    install: (paths, log) => patchAgentHost(paths, log),
    inspect: (paths) => {
      const state = inspectAgentHostPatch(paths);
      const lines = [
        line(state.router ? OK : FAIL, `Agent Host HTTP/1.1 router ${state.router ? 'active' : 'missing'}`),
        line(state.wait ? OK : FAIL, `Agent Host server wait ${state.wait ? 'active' : 'missing'}`),
        state.networkTargets.length > 0
          ? line(OK, `Agent Host network target verified (${state.networkTargets.map(shortName).join(', ')})`)
          : line(FAIL, 'Agent Host network target not found'),
      ];
      if (state.websocketTargets.length > 0) {
        lines.push(line(state.websocketDisabled ? OK : FAIL,
          `Agent Host WebSocket bypass ${state.websocketDisabled ? 'disabled' : 'is active'}`));
      }
      else {
        lines.push(line(NA, 'Agent Host WebSocket transport not present (3.13–3.15)'));
      }
      return { ok: state.fullyPatched, lines };
    },
    check: (paths, log) => checkAgentHostPatch(paths, log),
    backupTargets: paths => getAgentHostBackupTargets(paths),
  },

  {
    id: 'proxy-39',
    tag: 'proxy-39',
    title: 'Utility-process BYOK router',
    requires: [CAP_UTILITY_PROCESS],
    skipNote: 'No electron-utility processes in this tree — utility-process router not applicable',
    install: (paths, log) => patchProxy39(paths, log),
    inspect: (paths) => {
      const state = inspectProxy39Patch(paths);
      return {
        ok: !state.required || state.patched,
        lines: [line(state.required ? (state.patched ? OK : FAIL) : NA, state.summary)],
      };
    },
    check: (paths, log) => checkProxy39Patch(paths, log),
    backupTargets: paths => getProxy39BackupTargets(paths),
  },

  {
    id: 'katex',
    tag: 'katex',
    title: 'KaTeX CSS link',
    requires: [CAP_WORKBENCH_HTML],
    skipNote: 'No workbench.html in this tree — KaTeX CSS link not applicable',
    install: (paths, log) => patchKatex(paths, log),
    inspect: (paths) => {
      if (!needsKatexPatch(paths)) {
        return { ok: true, lines: [line(NA, `KaTeX CSS link not needed on Cursor ${paths.cursorVersion}`)] };
      }
      const linked = existsSync(paths.workbenchHtml) && readFileSync(paths.workbenchHtml, 'utf-8').includes('katex.min.css');
      return { ok: linked, lines: [line(linked ? OK : FAIL, `KaTeX CSS link ${linked ? 'present' : 'missing'}`)] };
    },
    check: () => true,
    backupTargets: paths => [paths.workbenchHtml],
  },
];

function shortName(file) {
  return file.split(/[\\/]/).pop();
}

/** Renderer hook dry-run — anchors plus both Agent Window allowlists. */
function checkRendererHook(paths, log) {
  let ok = true;
  for (const [file, label] of [[paths.workbenchJs, 'desktop'], [paths.glassJs, 'glass']]) {
    if (!existsSync(file)) {
      if (label === 'glass') log?.('  Glass workbench not found (pre-3.8, OK)');
      continue;
    }
    const source = readFileSync(file, 'utf-8');

    // Agent Window extension allowlists — a partial hit silently keeps Cursor++
    // out of one of the two arrays, so it is verified separately.
    const allowlist = checkGlassExtensionAllowlist(source);
    log?.(`  [${allowlist.ok ? 'OK' : 'FAIL'}] Extension allowlist (${label}): ${allowlist.detail}`);
    if (!allowlist.ok) ok = false;

    const hook = inspectInjectPatch(source);
    if (hook.upToDate) {
      log?.(`  [OK] Renderer hook (${label}): payload + active transport call site`);
      continue;
    }
    if (!hook.consistent) {
      log?.(`  [FAIL] Renderer hook (${label}) is partial (payload/call-site mismatch)`);
      ok = false;
      continue;
    }
    // Patched by an older installer: install upgrades the payload in place, so
    // this is a state install can reach, which is what `check` reports on.
    if (hook.payload) {
      log?.(`  [OK] Renderer hook (${label}): payload is stale, install will upgrade it`);
      continue;
    }
    // Kept in sync with patch-inject.js ANCHORS — 3.17.8 shortened the module
    // registration keys to bare file names, so matching the file name alone
    // covers both the old and the new shape.
    const anchor = ['callback-client.js', 'promise-client.js'].find(a => source.includes(a));
    if (anchor) {
      log?.(`  [OK] Inject anchor (${label}): "${anchor}"`);
    }
    else {
      log?.(`  [FAIL] Inject anchor (${label}) not found`);
      ok = false;
    }
  }
  return ok;
}

/**
 * Resolve the registry against one install profile.
 * @returns {Array<object>} every step, annotated with `applicable`
 */
export function resolveSteps(profile) {
  return PATCH_STEPS.map((step) => {
    const capable = step.requires.every(capability => profile.capabilities.has(capability));
    const available = capable && (step.available ? step.available(profile) : true);
    return { ...step, applicable: available };
  });
}

/** Roll one step back from its tagged backups. Steps may override this. */
export function restoreStep(step, paths, log) {
  if (step.restore) return step.restore(paths, log);
  let restored = 0;
  for (const file of [paths.productJson, ...step.backupTargets(paths)]) {
    if (restoreBackup(file, step.tag, log)) restored++;
  }
  return restored;
}
