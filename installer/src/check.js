/**
 * ccursor check — dry-run verify all AST patch targets are matchable
 *
 * Only the targets the resolved profile declares are verified. A target that
 * this install shape does not own is reported as skipped and never counts as
 * a failure.
 */
import { findCursorPathsDetailed, formatDiagnostic, formatInstallSelection } from './detect.js';
import { resolveSteps } from './steps.js';

const ok = s => `\x1b[32m✓ ${s}\x1b[0m`;
const fail = s => `\x1b[31m✗ ${s}\x1b[0m`;
const skip = s => `\x1b[2m- ${s}\x1b[0m`;
const info = s => `\x1b[34m[>]\x1b[0m ${s}`;

export async function check() {
  const { paths, diagnostic } = findCursorPathsDetailed();
  if (!paths) {
    console.log(fail('Cursor installation not found'));
    console.log();
    console.log(formatDiagnostic(diagnostic));
    return;
  }

  console.log(info(`Cursor: ${paths.appRoot} (${paths.cursorVersion}, ${paths.kindLabel})`));
  for (const line of formatInstallSelection(diagnostic)) console.log(info(line));
  console.log();

  let allOk = true;
  for (const step of resolveSteps(paths)) {
    if (!step.applicable) {
      console.log(skip(`${step.title}: ${step.skipNote}`));
      continue;
    }
    console.log(info(`[check] ${step.title}...`));
    const passed = step.check(paths, s => console.log(info(s)));
    if (!passed) allOk = false;
  }

  console.log();
  if (allOk) {
    console.log(ok('All patch targets matchable'));
  } else {
    console.log(fail('Some targets not matchable — install may fail'));
  }
}
