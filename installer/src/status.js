/**
 * ccursor status — check install state
 *
 * Reports whatever the resolved profile declares. Targets that do not exist in
 * this install shape are listed as not-applicable rather than as failures, so
 * a Cursor server root does not look broken just because it has no renderer.
 */
import { existsSync } from 'fs';
import { join } from 'path';
import { findCursorPathsDetailed, formatDiagnostic, formatInstallSelection, formatRemoteHostNotice } from './detect.js';
import { hasBackup } from './backup.js';
import { hasChecksumTable } from './checksum.js';
import { CCURSOR_DIR } from './routes.js';
import { PROVIDERS_FILE_NAME, ROUTES_FILE_NAME } from './defaults.js';
import { resolveSteps } from './steps.js';

const ok = s => `\x1b[32m✓ ${s}\x1b[0m`;
const fail = s => `\x1b[31m✗ ${s}\x1b[0m`;
const na = s => `\x1b[2m- ${s}\x1b[0m`;

const RENDER = { ok, fail, na };

export async function status() {
  const { paths, diagnostic } = findCursorPathsDetailed();
  if (!paths) {
    console.log(fail('Cursor installation not found'));
    console.log('');
    console.log(formatDiagnostic(diagnostic));
    return;
  }

  console.log(`Cursor: ${paths.appRoot} (${paths.cursorVersion}, ${paths.kindLabel})`);
  for (const line of formatInstallSelection(diagnostic)) console.log(line);
  console.log('');

  const steps = resolveSteps(paths);
  for (const step of steps) {
    if (!step.applicable) {
      console.log(na(`${step.title}: ${step.skipNote}`));
      continue;
    }
    for (const entry of step.inspect(paths).lines) {
      console.log(RENDER[entry.state](entry.text));
    }
  }

  // Remote SSH / WSL — patches on a desktop install cover the local side only
  const remoteNotice = formatRemoteHostNotice(paths);
  if (remoteNotice.length > 0) {
    console.log('');
    console.log(na(remoteNotice[0]));
    for (const line of remoteNotice.slice(1)) console.log(line);
  }

  // ~/.ccursor 资源
  console.log('');
  const routesPath = join(CCURSOR_DIR, ROUTES_FILE_NAME);
  const providersPath = join(CCURSOR_DIR, PROVIDERS_FILE_NAME);
  console.log(existsSync(routesPath) ? ok(`routes.json: ${routesPath}`) : fail(`routes.json missing at ${routesPath}`));
  console.log(existsSync(providersPath) ? ok(`providers.json: ${providersPath}`) : fail(`providers.json missing at ${providersPath}`));

  // Backups
  console.log('');
  const backupFiles = new Set();
  for (const step of steps) {
    if (!step.applicable) continue;
    for (const file of step.backupTargets(paths)) backupFiles.add(file);
  }
  if (backupFiles.size > 0 && hasChecksumTable(paths)) backupFiles.add(paths.productJson);
  const backupCount = [...backupFiles].filter(f => hasBackup(f)).length;
  console.log(`Backups: ${backupCount}/${backupFiles.size} files backed up`);
}
