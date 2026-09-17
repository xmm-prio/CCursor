/**
 * ccursor CLI — Cursor++ BYOK Installer
 *
 * Usage:
 *   npx github:xmm-prio/CCursor install     # Install extension + apply patches
 *   npx github:xmm-prio/CCursor uninstall   # Remove extension + restore patches
 *   npx github:xmm-prio/CCursor status      # Check installation status
 *
 * On Windows, a Cursor installed under Program Files needs an elevated shell.
 */

import { install } from './install.js';
import { uninstall } from './uninstall.js';
import { status } from './status.js';
import { check } from './check.js';
import { findCursorPathsDetailed, formatDiagnostic } from './detect.js';
import { getLocalModeTargets, patchLocalMode } from './patch-local-mode.js';
import { restoreBackup } from './backup.js';

async function update() {
  await uninstall();
  console.log('');
  await install();
}

const command = process.argv[2];

const commands = {
  install,
  uninstall,
  update,
  upgrade: update,
  status,
  check,
  'local-mode': async () => {
    const info = msg => console.log(`\x1b[34m[>]\x1b[0m ${msg}`);
    const { paths, diagnostic } = findCursorPathsDetailed();
    if (!paths) { console.log(formatDiagnostic(diagnostic)); process.exit(1); }
    info(`Cursor: ${paths.appRoot}`);
    patchLocalMode(paths, info);
  },
  'local-mode-off': async () => {
    const info = msg => console.log(`\x1b[34m[>]\x1b[0m ${msg}`);
    const { paths, diagnostic } = findCursorPathsDetailed();
    if (!paths) { console.log(formatDiagnostic(diagnostic)); process.exit(1); }
    info(`Cursor: ${paths.appRoot}`);
    info('Restoring local-mode patches...');
    let restored = 0;
    for (const target of getLocalModeTargets(paths)) {
      if (restoreBackup(target, 'local-mode', info)) restored++;
    }
    if (restoreBackup(paths.productJson, 'local-mode', info)) restored++;
    console.log(restored > 0 ? `\x1b[32m[OK]\x1b[0m Restored ${restored} file(s)` : '\x1b[33m[!]\x1b[0m No backups found');
  },
  help: async () => {
    console.log(`
ccursor — Cursor++ BYOK Installer

Commands:
  install          Install Cursor++ extension and apply patches
  uninstall        Remove extension and restore all patches
  update           Upgrade: uninstall then reinstall
  local-mode       Standalone tool: enable Cursor's built-in Local Agent mode
  local-mode-off   Standalone tool: disable Local Agent mode (restore originals)
  status           Check current installation status
  check            Dry-run: verify AST patch targets are matchable
  help             Show this help message
`);
  },
};

const fn = commands[command];
if (!fn) {
  console.error(`Unknown command: ${command || '(none)'}`);
  commands.help();
  process.exit(1);
}

fn().catch(err => {
  console.error(`\n\x1b[31m[ERROR]\x1b[0m ${err.message}`);
  process.exit(1);
});
