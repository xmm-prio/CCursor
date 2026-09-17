/**
 * 定位 Cursor 安装路径 — 跨平台支持
 *
 * 桌面安装 (resources/app):
 *
 * macOS:
 *   /Applications/Cursor.app/Contents/Resources/app
 *   ~/Applications/Cursor.app/Contents/Resources/app
 *
 * Linux:
 *   /opt/Cursor/resources/app
 *   /usr/share/cursor/resources/app
 *   ~/.local/share/cursor/resources/app
 *
 * Windows (per-user install):
 *   %LOCALAPPDATA%\Programs\cursor\resources\app
 *   %LOCALAPPDATA%\Programs\Cursor\resources\app
 *
 * Windows (system-wide install):
 *   %ProgramFiles%\Cursor\resources\app
 *   %ProgramFiles(x86)%\Cursor\resources\app
 *
 * 远端 server 安装 (Remote SSH / tunnel 的 REH 解压目录):
 *   ~/.cursor-server/bin/<commit>
 *   ~/.cursor-server-insiders/bin/<commit>
 *
 * 环境变量覆盖:
 *   CCURSOR_CURSOR_ROOT=/path/to/cursor/app   —— 绝对路径指向 resources/app
 *   或指向 ~/.cursor-server/bin/<commit>;形态由目录内容自动判定
 *   优先级最高,绕过所有自动检测
 *
 * 多安装并存:
 *   桌面安装优先于 server 安装 —— 一台机器上同时有两者时,本地跑的是桌面那份,
 *   server 目录只在远端(那里没有桌面安装)才是唯一目标。
 *   同类形态内枚举全部候选并读各自版本,选版本最高的一份;
 *   桌面形态版本相同无法判定时报错,要求用 CCURSOR_CURSOR_ROOT 指定;
 *   server 形态按 commit 目录分列,同版本时取最近写入的一份。
 */
import { existsSync, readdirSync, statSync } from 'fs';
import { homedir, platform } from 'os';
import { join } from 'path';
import { buildProfile, compareSemver, isPatchableProfile, KIND_DESKTOP } from './profile.js';

/** REH server roots unpacked by Remote SSH / tunnels, one directory per commit. */
const SERVER_DATA_FOLDERS = ['.cursor-server', '.cursor-server-insiders'];

function getApplicationRoots() {
  const home = homedir();

  switch (platform()) {
    case 'darwin':
      return [
        '/Applications/Cursor.app/Contents/Resources/app',
        join(home, 'Applications/Cursor.app/Contents/Resources/app'),
      ];

    case 'linux':
      return [
        '/opt/Cursor/resources/app',
        '/opt/cursor/resources/app',
        '/usr/share/cursor/resources/app',
        '/usr/lib/cursor/resources/app',
        join(home, '.local/share/cursor/resources/app'),
      ];

    case 'win32': {
      const localAppData = process.env.LOCALAPPDATA || join(home, 'AppData', 'Local');
      const programFiles = process.env.ProgramFiles || 'C:\\Program Files';
      const programFilesX86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
      // NTFS is case-insensitive but we try both spellings defensively
      return [
        // Per-user install (default from Cursor installer)
        join(localAppData, 'Programs', 'cursor', 'resources', 'app'),
        join(localAppData, 'Programs', 'Cursor', 'resources', 'app'),
        // System-wide install
        join(programFiles, 'Cursor', 'resources', 'app'),
        join(programFilesX86, 'Cursor', 'resources', 'app'),
        // Scoop
        join(home, 'scoop', 'apps', 'cursor', 'current', 'resources', 'app'),
      ];
    }

    default:
      return [];
  }
}

/**
 * Enumerate the commit-keyed REH roots. These only exist on a machine that has
 * been attached to as a remote host; a client box normally has none.
 */
function getServerRoots() {
  const home = homedir();
  const roots = [];
  for (const folder of SERVER_DATA_FOLDERS) {
    const binDir = join(home, folder, 'bin');
    if (!existsSync(binDir)) continue;
    let entries;
    try { entries = readdirSync(binDir, { withFileTypes: true }); }
    catch { continue; }
    for (const entry of entries) {
      if (entry.isDirectory()) roots.push(join(binDir, entry.name));
    }
  }
  return roots;
}

function getCandidateRoots() {
  return [...getApplicationRoots(), ...getServerRoots()];
}

/**
 * Windows and macOS filesystems are case-insensitive, so the defensive spelling
 * variants in getApplicationRoots() can resolve to one and the same install.
 * Collapse them before version comparison, otherwise a single install looks
 * like an ambiguous multi-install.
 */
function dedupeRoots(roots) {
  const caseInsensitive = platform() === 'win32' || platform() === 'darwin';
  const seen = new Set();
  const unique = [];
  for (const root of roots) {
    const key = caseInsensitive ? root.toLowerCase() : root;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(root);
  }
  return unique;
}

/** When was this tree last written? Used to break same-version ties. */
function installedAt(appRoot) {
  try { return statSync(appRoot).mtimeMs; }
  catch { return 0; }
}

/**
 * Newest install wins — it is the one the user upgraded into and is running.
 * How a same-version tie is handled is declared by the install kind, so the
 * rule lives here once instead of leaking into the commands.
 *
 * @returns {{ selected: object | null, hint?: string }}
 */
function selectInstall(installs) {
  const ordered = [...installs].sort((a, b) =>
    compareSemver(b.cursorVersion, a.cursorVersion) || (b.installedAt - a.installedAt));
  const [selected, runnerUp] = ordered;
  if (!selected) return { selected: null };

  const tied = runnerUp && compareSemver(selected.cursorVersion, runnerUp.cursorVersion) === 0;
  if (tied && selected.sameVersionTieBreak === 'ambiguous') {
    const listed = ordered
      .filter(p => compareSemver(p.cursorVersion, selected.cursorVersion) === 0)
      .map(p => `    ${p.appRoot}  (${p.cursorVersion})`)
      .join('\n');
    return {
      selected: null,
      hint: `Multiple Cursor installs report the same version ${selected.cursorVersion}, cannot decide which one is in use:\n${listed}\n`
        + 'Set CCURSOR_CURSOR_ROOT to the install directory you want to patch and retry.',
    };
  }
  return { selected };
}

/**
 * @returns {{ paths: object | null, diagnostic: { platform: string, tried: Array<{path, status}>, hint?: string } }}
 */
export function findCursorPathsDetailed() {
  const diagnostic = { platform: platform(), tried: [] };

  // 1. Env override has priority
  const envRoot = process.env.CCURSOR_CURSOR_ROOT;
  if (envRoot) {
    diagnostic.tried.push({ path: envRoot, status: 'env-override' });
    if (!existsSync(join(envRoot, 'product.json'))) {
      diagnostic.hint = `CCURSOR_CURSOR_ROOT has no product.json: ${envRoot}`;
      return { paths: null, diagnostic };
    }
    const paths = buildProfile(envRoot);
    if (!isPatchableProfile(paths)) {
      diagnostic.hint = `Found product.json but neither a renderer bundle nor out/server-main.js: ${envRoot}\n`
        + 'This is not a Cursor desktop install or a Cursor server root.';
      return { paths: null, diagnostic };
    }
    const entry = diagnostic.tried[diagnostic.tried.length - 1];
    entry.version = paths.cursorVersion;
    entry.kind = paths.kindLabel;
    diagnostic.installs = [{ path: paths.appRoot, version: paths.cursorVersion, kind: paths.kindLabel }];
    diagnostic.selected = paths.appRoot;
    diagnostic.kind = paths.kindLabel;
    return { paths, diagnostic };
  }

  // 2. 自动检测 — Cursor 沿用 VS Code 的未打包 app/ 目录结构, 不使用 app.asar
  //
  // 必须枚举全部候选而非首个命中即返回: per-user 与 system-wide 安装可以共存且
  // 版本不同, 短路返回会让 installer 去打一份用户根本没在跑的旧安装的补丁。
  let unrecognised = null;
  const installs = [];

  for (const appRoot of dedupeRoots(getCandidateRoots())) {
    if (!existsSync(join(appRoot, 'product.json'))) {
      diagnostic.tried.push({ path: appRoot, status: 'missing' });
      continue;
    }

    const profile = buildProfile(appRoot);
    if (isPatchableProfile(profile)) {
      profile.installedAt = installedAt(appRoot);
      installs.push(profile);
      diagnostic.tried.push({ path: appRoot, status: 'found', version: profile.cursorVersion, kind: profile.kindLabel });
      continue;
    }

    unrecognised = appRoot;
    diagnostic.tried.push({ path: appRoot, status: 'partial', version: profile.cursorVersion });
  }

  // A desktop install always wins over a server root: on a client box the
  // desktop app is what runs, and a remote host has no desktop install at all.
  const desktop = installs.filter(p => p.kind === KIND_DESKTOP);
  const pool = desktop.length > 0 ? desktop : installs;

  diagnostic.installs = pool.map(p => ({ path: p.appRoot, version: p.cursorVersion, kind: p.kindLabel }));

  if (pool.length === 0) {
    if (unrecognised) {
      diagnostic.hint
        = `Found a Cursor directory but no renderer bundle and no out/server-main.js:\n    ${unrecognised}\n`
        + 'Cursor version may be too old or the layout has changed.';
    }
    else {
      diagnostic.hint
        = 'Cursor not found in any default location.\n'
        + 'If installed in a custom path, set CCURSOR_CURSOR_ROOT to point at the resources/app directory\n'
        + '(or at ~/.cursor-server/bin/<commit> on a remote host) and retry.';
    }
    return { paths: null, diagnostic };
  }

  const { selected, hint } = selectInstall(pool);
  if (!selected) {
    diagnostic.hint = hint;
    return { paths: null, diagnostic };
  }

  diagnostic.selected = selected.appRoot;
  diagnostic.kind = selected.kindLabel;
  for (const entry of diagnostic.tried) {
    if (entry.path === selected.appRoot) entry.status = 'ok';
  }
  return { paths: selected, diagnostic };
}

/** 兼容旧调用 —— 仅返回 paths 或 null */
export function findCursorPaths() {
  return findCursorPathsDetailed().paths;
}

/** 格式化诊断信息为人类可读的多行字符串 */
export function formatDiagnostic(diagnostic) {
  const lines = [];
  lines.push(`Platform: ${diagnostic.platform}`);
  lines.push('Tried paths:');
  if (diagnostic.tried.length === 0) {
    lines.push('  (none — unsupported platform)');
  }
  else {
    for (const t of diagnostic.tried) {
      const tag = t.status === 'ok'
        ? '✓'
        : t.status === 'found'
          ? '○'
          : t.status === 'partial'
            ? '~'
            : t.status === 'env-override'
              ? '→'
              : '✗';
      const detail = [t.version, t.kind].filter(Boolean).join(', ');
      lines.push(`  ${tag} ${t.path}${detail ? `  (${detail})` : ''}`);
    }
  }
  if (diagnostic.hint) {
    lines.push('');
    lines.push(diagnostic.hint);
  }
  return lines.join('\n');
}

/**
 * Remote extension host server dirs left behind by Remote SSH / WSL / tunnels.
 *
 * @returns {string[]} existing server data directories, empty on a purely local box
 */
export function detectRemoteServerDirs() {
  const home = homedir();
  return [...SERVER_DATA_FOLDERS, '.vscode-server']
    .map(name => join(home, name))
    .filter(dir => existsSync(dir));
}

/**
 * Actionable instructions for making a remote host self-sufficient.
 *
 * Only relevant while patching a desktop install: a server profile *is* the
 * remote side, so repeating the notice there would be wrong.
 *
 * Background, verified against Cursor 3.19.19: `cursor-always-local` declares
 * `extensionKind: ["ui"]` and stays on the client, while `cursor-agent-host`
 * / `cursor-agent-exec` / `cursor-agent-worker` declare no `extensionKind` at
 * all — VS Code deduces `["workspace"]` for any manifest with a `main`, so in
 * a Remote SSH window those three run on the remote box. Cursor++ is a `ui`
 * extension and cannot follow them: VS Code picks exactly one running location
 * per extension. The remote side therefore needs its own copy of both halves,
 * the router patches and a BYOK server.
 *
 * @returns {string[]} lines to print, empty when nothing remote was detected
 */
export function formatRemoteHostNotice(profile, dirs = detectRemoteServerDirs()) {
  if (profile && profile.kind !== KIND_DESKTOP) return [];
  if (dirs.length === 0) return [];
  const lines = ['Remote extension host detected — this install only covers the local side:'];
  for (const dir of dirs) lines.push(`  ${dir}`);
  lines.push('');
  lines.push('Cursor runs cursor-agent-host / cursor-agent-exec / cursor-agent-worker on the remote');
  lines.push('host, so agent requests made from a remote window never reach the BYOK server here.');
  lines.push('To make the remote host self-sufficient (no cross-machine port forwarding):');
  lines.push('  1. ssh into the remote host and run the installer there. It will select the');
  lines.push('     ~/.cursor-server/bin/<commit> server root and apply the server-side patches.');
  lines.push('  2. Install the cursor2plus-remote VSIX into the remote host — with the window');
  lines.push('     attached, Extensions view → "Install from VSIX", then "Install in SSH: <host>".');
  lines.push('     It is headless on purpose: the local Cursor++ keeps the panel and commands.');
  lines.push('  3. Create ~/.ccursor/providers.json on the remote host. API keys are per-machine');
  lines.push('     and are never copied over; the companion warns on activation when it is empty.');
  return lines;
}

/**
 * Multi-install notice for the commands that already resolved a target.
 * @returns {string[]} lines to print, empty when a single install was found
 */
export function formatInstallSelection(diagnostic) {
  const installs = diagnostic?.installs || [];
  if (installs.length < 2) return [];
  const lines = [`Multiple Cursor installs detected, patching the newest (${diagnostic.selected}):`];
  for (const i of installs) {
    lines.push(`  ${i.path === diagnostic.selected ? '→' : ' '} ${i.path}  (${i.version}, ${i.kind})`);
  }
  lines.push('Override with CCURSOR_CURSOR_ROOT if this is not the install you run.');
  return lines;
}
