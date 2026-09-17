/**
 * Built-in extension signature bypass (extensionHostProcess.js).
 *
 * The extension host refuses to load a built-in extension whose signature no
 * longer matches, which is every extension this installer rewrites. The check
 * lives in out/vs/workbench/api/node/extensionHostProcess.js, a file that
 * exists in the desktop app *and* in the REH server tarball, so it is its own
 * patch step instead of a tail on the desktop-only cursor-always-local patch.
 *
 * The backup tag stays 'always-local' so installations made before the split
 * still roll back cleanly.
 */
import { existsSync, readFileSync, writeFileSync } from 'fs';
import { createBackup } from './backup.js';
import { updateChecksums } from './checksum.js';

export const SIG_BYPASS_TAG = 'always-local';
const SIG_PATTERN = /if\(!\w\.valid\)/;

export function inspectSigBypass(paths) {
  if (!existsSync(paths.extensionHostJs)) {
    return { present: false, applied: false, matchable: false };
  }
  const source = readFileSync(paths.extensionHostJs, 'utf-8');
  const pending = SIG_PATTERN.test(source);
  return {
    present: true,
    applied: source.includes('if(!1)') && !pending,
    matchable: pending,
  };
}

export function patchSigBypass(paths, log) {
  log?.('[sig-bypass] Patching extensionHostProcess.js...');
  if (!existsSync(paths.extensionHostJs)) throw new Error(`Not found: ${paths.extensionHostJs}`);

  const source = readFileSync(paths.extensionHostJs, 'utf-8');
  const state = inspectSigBypass(paths);
  if (state.applied) {
    log?.('  Already applied');
    return false;
  }

  const match = source.match(SIG_PATTERN);
  if (!match) throw new Error('Signature validation pattern not found');

  createBackup(paths.extensionHostJs, SIG_BYPASS_TAG, log);
  writeFileSync(paths.extensionHostJs, source.replace(SIG_PATTERN, 'if(!1)'));
  log?.(`  Sig bypass: ${match[0]} → if(!1)`);
  updateChecksums(paths, [paths.extensionHostJs], SIG_BYPASS_TAG, log);
  return true;
}

export function checkSigBypass(paths, log) {
  const state = inspectSigBypass(paths);
  if (!state.present) {
    log?.('  [FAIL] extensionHostProcess.js not found');
    return false;
  }
  if (state.applied) {
    log?.('  [OK] already applied');
    return true;
  }
  if (state.matchable) {
    log?.('  [OK] pattern found');
    return true;
  }
  log?.('  [FAIL] signature validation pattern not found');
  return false;
}
