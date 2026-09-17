/**
 * ccursor install — 完整安装流程
 *
 * 顺序：
 *   0. 定位 Cursor 安装目录 + 预检
 *   1. 释放默认配置到 ~/.ccursor/
 *   2. 遍历 profile 声明的补丁目标 (见 steps.js)
 *   3. 提示重启
 *
 * 目标集由安装形态决定，不在这里分支：桌面安装会走完 extension / renderer
 * hook / always-local / sig bypass / agent-host / utility-process / katex，
 * 而 ~/.cursor-server/bin/<commit> 这种 server root 只声明 agent-host 与 sig
 * bypass，其余目标在 profile 里就已经被判为不适用。
 */
import { findCursorPathsDetailed, formatDiagnostic, formatInstallSelection, formatRemoteHostNotice } from './detect.js';
import { hasBackup } from './backup.js';
import { formatSetupNotice, releaseDefaults } from './release-defaults.js';
import { resolveSteps } from './steps.js';

const ok = msg => console.log(`\x1b[32m[OK]\x1b[0m ${msg}`);
const info = msg => console.log(`\x1b[34m[>]\x1b[0m ${msg}`);
const warn = msg => console.log(`\x1b[33m[!]\x1b[0m ${msg}`);
const fail = msg => console.log(`\x1b[31m[X]\x1b[0m ${msg}`);

export async function install() {
  info('Cursor++ BYOK Installer');
  console.log('');

  // 0. 定位 + 预检
  const { paths, diagnostic } = findCursorPathsDetailed();
  if (!paths) {
    fail('Cursor installation not found');
    console.log('');
    console.log(formatDiagnostic(diagnostic));
    console.log('');
    throw new Error('Cursor installation not found');
  }
  info(`Cursor: ${paths.appRoot}`);
  info(`Version: ${paths.cursorVersion} (${paths.kindLabel}${paths.hasGlass ? ', glass' : ''})`);
  for (const line of formatInstallSelection(diagnostic)) warn(line);

  const steps = resolveSteps(paths);
  const pending = steps.filter(step => step.applicable && !step.inspect(paths).ok);

  if (pending.length === 0) {
    ok('Already fully installed');
    // Still report config gaps: re-running install is exactly what a user does
    // when BYOK "does nothing", and the cause is usually an empty providers.json
    // rather than a missing patch.
    for (const line of formatSetupNotice()) warn(line);
    info('To reinstall, run "ccursor uninstall" first');
    return;
  }

  // Leftover backups while the extension itself is gone means a previous
  // installation was torn down by hand; re-patching on top of that would
  // stack a second generation of backups.
  const extensionStep = steps.find(step => step.id === 'extension');
  const extensionMissing = extensionStep.applicable && !extensionStep.inspect(paths).ok;
  const hasBackups = steps.some(step =>
    step.backupTargets(paths).some(file => hasBackup(file, step.tag)));
  if (hasBackups && extensionMissing) {
    warn('Found backup files from a previous installation');
    warn('Run "ccursor uninstall" to clean up before reinstalling');
    return;
  }

  console.log('');

  // 1. 释放默认配置到 ~/.ccursor/ (尊重已有用户文件)
  releaseDefaults(info);

  // 2. 按注册顺序遍历补丁目标
  for (const step of steps) {
    if (!step.applicable) {
      info(`[${step.id}] Skipped — ${step.skipNote}`);
      continue;
    }
    step.install(paths, info);
  }

  console.log('');
  ok('Installation complete!');
  warn('Restart Cursor for changes to take effect.');
  for (const line of formatSetupNotice()) warn(line);
  for (const line of formatRemoteHostNotice(paths)) warn(line);
  info('Uninstall: npx github:xmm-prio/CCursor uninstall');
}
