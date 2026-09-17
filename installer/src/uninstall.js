/**
 * ccursor uninstall — full rollback
 *
 * Walks the patch step registry in reverse install order. Each step restores
 * its own tagged backups (product.json first, so its checksum table is rolled
 * back before the files it covers), or performs its own teardown when it has
 * no backups — the extension step removes extensions/cursor2plus/.
 *
 * Every registered step runs, applicable or not: restoring is guarded by the
 * presence of a backup, so covering the whole registry cleans up leftovers
 * from an install made while the tree had a different shape.
 *
 * local-mode 是游离于主 installer 之外的特殊工具，
 * 只通过 `ccursor local-mode` / `ccursor local-mode-off` 管理。
 */
import { findCursorPathsDetailed, formatDiagnostic } from './detect.js';
import { PATCH_STEPS, restoreStep } from './steps.js';

const ok = msg => console.log(`\x1b[32m[OK]\x1b[0m ${msg}`);
const info = msg => console.log(`\x1b[34m[>]\x1b[0m ${msg}`);
const warn = msg => console.log(`\x1b[33m[!]\x1b[0m ${msg}`);
const fail = msg => console.log(`\x1b[31m[X]\x1b[0m ${msg}`);

export async function uninstall() {
  info('Cursor++ BYOK Uninstaller');
  console.log('');

  const { paths, diagnostic } = findCursorPathsDetailed();
  if (!paths) {
    fail('Cursor installation not found');
    console.log('');
    console.log(formatDiagnostic(diagnostic));
    console.log('');
    throw new Error('Cursor installation not found');
  }
  info(`Cursor: ${paths.appRoot} (${paths.cursorVersion}, ${paths.kindLabel})`);

  let restored = 0;
  for (const step of [...PATCH_STEPS].reverse()) {
    info(`Restoring ${step.title}...`);
    restored += restoreStep(step, paths, info);
  }

  console.log('');
  if (restored > 0) {
    ok(`Restored ${restored} file(s)`);
  } else {
    warn('No backups found (already clean?)');
  }
  ok('Uninstallation complete');
  warn('Restart Cursor for changes to take effect.');
}
