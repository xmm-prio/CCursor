#!/usr/bin/env node

// src/detect.js
var import_fs2 = require("fs");
var import_os = require("os");
var import_path2 = require("path");

// src/profile.js
var import_fs = require("fs");
var import_path = require("path");
var KIND_DESKTOP = "desktop";
var KIND_SERVER = "server";
var KIND_UNKNOWN = "unknown";
var CAP_RENDERER = "renderer";
var CAP_GLASS = "glass";
var CAP_WORKBENCH_HTML = "workbench-html";
var CAP_UTILITY_PROCESS = "utility-process";
var CAP_EXTENSION_HOST = "extension-host";
var CAP_BUILTIN_EXTENSIONS = "builtin-extensions";
var KIND_DESCRIPTORS = {
  [KIND_DESKTOP]: {
    label: "desktop",
    hostRoles: ["ui", "workspace"],
    // Two desktop installs reporting the same version are indistinguishable
    // from the outside; the user has to say which one is the live one.
    sameVersionTieBreak: "ambiguous"
  },
  [KIND_SERVER]: {
    label: "server",
    hostRoles: ["workspace"],
    // Server roots are keyed by commit under bin/, so several builds of one
    // version legitimately coexist. The most recently written one is the one
    // the current client provisioned.
    sameVersionTieBreak: "newest"
  },
  [KIND_UNKNOWN]: {
    label: "unknown",
    hostRoles: [],
    sameVersionTieBreak: "ambiguous"
  }
};
function readJson(file) {
  try {
    return JSON.parse((0, import_fs.readFileSync)(file, "utf-8"));
  } catch {
    return null;
  }
}
function readCursorVersion(appRoot) {
  return readJson((0, import_path.join)(appRoot, "package.json"))?.version || "0.0.0";
}
function parseSemver(v) {
  const [major = 0, minor = 0, patch = 0] = String(v || "0.0.0").split(".").map((n) => Number(n) || 0);
  return { major, minor, patch };
}
function compareSemver(a, b) {
  const left = parseSemver(a);
  const right = parseSemver(b);
  return left.major - right.major || left.minor - right.minor || left.patch - right.patch;
}
function buildTreePaths(appRoot) {
  return {
    appRoot,
    workbenchJs: (0, import_path.join)(appRoot, "out", "vs", "workbench", "workbench.desktop.main.js"),
    glassJs: (0, import_path.join)(appRoot, "out", "vs", "workbench", "workbench.glass.main.js"),
    workbenchHtml: (0, import_path.join)(appRoot, "out", "vs", "code", "electron-sandbox", "workbench", "workbench.html"),
    utilityProcessDir: (0, import_path.join)(appRoot, "out", "vs", "code", "electron-utility"),
    alwaysLocalMain: (0, import_path.join)(appRoot, "extensions", "cursor-always-local", "dist", "main.js"),
    agentHostDist: (0, import_path.join)(appRoot, "extensions", "cursor-agent-host", "dist"),
    agentHostMain: (0, import_path.join)(appRoot, "extensions", "cursor-agent-host", "dist", "main.js"),
    agentHostPackageJson: (0, import_path.join)(appRoot, "extensions", "cursor-agent-host", "package.json"),
    alwaysLocalSingletonJs: (0, import_path.join)(appRoot, "out", "vs", "code", "electron-utility", "alwaysLocalSingleton", "alwaysLocalSingletonMain.js"),
    extensionHostJs: (0, import_path.join)(appRoot, "out", "vs", "workbench", "api", "node", "extensionHostProcess.js"),
    serverMainJs: (0, import_path.join)(appRoot, "out", "server-main.js"),
    productJson: (0, import_path.join)(appRoot, "product.json"),
    extensionsDir: (0, import_path.join)(appRoot, "extensions"),
    cursor2plusDir: (0, import_path.join)(appRoot, "extensions", "cursor2plus")
  };
}
function detectKind(tree) {
  if ((0, import_fs.existsSync)(tree.workbenchJs)) return KIND_DESKTOP;
  if ((0, import_fs.existsSync)(tree.serverMainJs)) return KIND_SERVER;
  return KIND_UNKNOWN;
}
function detectCapabilities(tree) {
  const capabilities = /* @__PURE__ */ new Set();
  if ((0, import_fs.existsSync)(tree.workbenchJs)) capabilities.add(CAP_RENDERER);
  if ((0, import_fs.existsSync)(tree.glassJs)) capabilities.add(CAP_GLASS);
  if ((0, import_fs.existsSync)(tree.workbenchHtml)) capabilities.add(CAP_WORKBENCH_HTML);
  if ((0, import_fs.existsSync)(tree.utilityProcessDir)) capabilities.add(CAP_UTILITY_PROCESS);
  if ((0, import_fs.existsSync)(tree.extensionHostJs)) capabilities.add(CAP_EXTENSION_HOST);
  if ((0, import_fs.existsSync)(tree.extensionsDir)) capabilities.add(CAP_BUILTIN_EXTENSIONS);
  return capabilities;
}
function buildProfile(appRoot) {
  const tree = buildTreePaths(appRoot);
  const kind = detectKind(tree);
  const descriptor = KIND_DESCRIPTORS[kind];
  const cursorVersion = readCursorVersion(appRoot);
  const semver = parseSemver(cursorVersion);
  const capabilities = detectCapabilities(tree);
  return {
    ...tree,
    kind,
    kindLabel: descriptor.label,
    hostRoles: descriptor.hostRoles,
    sameVersionTieBreak: descriptor.sameVersionTieBreak,
    capabilities,
    cursorVersion,
    commit: readJson(tree.productJson)?.commit || null,
    // Glass is a renderer flavour introduced in 3.8, so a tree without a
    // renderer never has it however new it is.
    hasGlass: capabilities.has(CAP_RENDERER) && (semver.major > 3 || semver.major === 3 && semver.minor >= 8)
  };
}
function isPatchableProfile(profile) {
  return Boolean(profile) && profile.kind !== KIND_UNKNOWN;
}
function normalizeKinds(value) {
  const list = typeof value === "string" ? [value] : Array.isArray(value) ? value : [];
  return list.filter((kind) => kind === "ui" || kind === "workspace" || kind === "web");
}
function resolveExtensionKind(profile, dirName) {
  const manifest = readJson((0, import_path.join)(profile.extensionsDir, dirName, "package.json"));
  if (!manifest) return [];
  const declared = normalizeKinds(manifest.extensionKind);
  if (declared.length > 0) return declared;
  const identifier = `${manifest.publisher}.${manifest.name}`.toLowerCase();
  const overrides = readJson(profile.productJson)?.extensionKind;
  if (overrides) {
    const entry = Object.entries(overrides).find(([key]) => key.toLowerCase() === identifier);
    const mapped = normalizeKinds(entry?.[1]);
    if (mapped.length > 0) return mapped;
  }
  return manifest.main ? ["workspace"] : ["ui"];
}
function extensionRunsHere(profile, dirName) {
  const kinds = resolveExtensionKind(profile, dirName);
  return kinds.some((kind) => profile.hostRoles.includes(kind));
}

// src/detect.js
var SERVER_DATA_FOLDERS = [".cursor-server", ".cursor-server-insiders"];
function getApplicationRoots() {
  const home = (0, import_os.homedir)();
  switch ((0, import_os.platform)()) {
    case "darwin":
      return [
        "/Applications/Cursor.app/Contents/Resources/app",
        (0, import_path2.join)(home, "Applications/Cursor.app/Contents/Resources/app")
      ];
    case "linux":
      return [
        "/opt/Cursor/resources/app",
        "/opt/cursor/resources/app",
        "/usr/share/cursor/resources/app",
        "/usr/lib/cursor/resources/app",
        (0, import_path2.join)(home, ".local/share/cursor/resources/app")
      ];
    case "win32": {
      const localAppData = process.env.LOCALAPPDATA || (0, import_path2.join)(home, "AppData", "Local");
      const programFiles = process.env.ProgramFiles || "C:\\Program Files";
      const programFilesX86 = process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)";
      return [
        // Per-user install (default from Cursor installer)
        (0, import_path2.join)(localAppData, "Programs", "cursor", "resources", "app"),
        (0, import_path2.join)(localAppData, "Programs", "Cursor", "resources", "app"),
        // System-wide install
        (0, import_path2.join)(programFiles, "Cursor", "resources", "app"),
        (0, import_path2.join)(programFilesX86, "Cursor", "resources", "app"),
        // Scoop
        (0, import_path2.join)(home, "scoop", "apps", "cursor", "current", "resources", "app")
      ];
    }
    default:
      return [];
  }
}
function getServerRoots() {
  const home = (0, import_os.homedir)();
  const roots = [];
  for (const folder of SERVER_DATA_FOLDERS) {
    const binDir = (0, import_path2.join)(home, folder, "bin");
    if (!(0, import_fs2.existsSync)(binDir)) continue;
    let entries;
    try {
      entries = (0, import_fs2.readdirSync)(binDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) roots.push((0, import_path2.join)(binDir, entry.name));
    }
  }
  return roots;
}
function getCandidateRoots() {
  return [...getApplicationRoots(), ...getServerRoots()];
}
function dedupeRoots(roots) {
  const caseInsensitive = (0, import_os.platform)() === "win32" || (0, import_os.platform)() === "darwin";
  const seen = /* @__PURE__ */ new Set();
  const unique = [];
  for (const root of roots) {
    const key = caseInsensitive ? root.toLowerCase() : root;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(root);
  }
  return unique;
}
function installedAt(appRoot) {
  try {
    return (0, import_fs2.statSync)(appRoot).mtimeMs;
  } catch {
    return 0;
  }
}
function selectInstall(installs) {
  const ordered = [...installs].sort((a, b) => compareSemver(b.cursorVersion, a.cursorVersion) || b.installedAt - a.installedAt);
  const [selected, runnerUp] = ordered;
  if (!selected) return { selected: null };
  const tied = runnerUp && compareSemver(selected.cursorVersion, runnerUp.cursorVersion) === 0;
  if (tied && selected.sameVersionTieBreak === "ambiguous") {
    const listed = ordered.filter((p) => compareSemver(p.cursorVersion, selected.cursorVersion) === 0).map((p) => `    ${p.appRoot}  (${p.cursorVersion})`).join("\n");
    return {
      selected: null,
      hint: `Multiple Cursor installs report the same version ${selected.cursorVersion}, cannot decide which one is in use:
${listed}
Set CCURSOR_CURSOR_ROOT to the install directory you want to patch and retry.`
    };
  }
  return { selected };
}
function findCursorPathsDetailed() {
  const diagnostic = { platform: (0, import_os.platform)(), tried: [] };
  const envRoot = process.env.CCURSOR_CURSOR_ROOT;
  if (envRoot) {
    diagnostic.tried.push({ path: envRoot, status: "env-override" });
    if (!(0, import_fs2.existsSync)((0, import_path2.join)(envRoot, "product.json"))) {
      diagnostic.hint = `CCURSOR_CURSOR_ROOT has no product.json: ${envRoot}`;
      return { paths: null, diagnostic };
    }
    const paths = buildProfile(envRoot);
    if (!isPatchableProfile(paths)) {
      diagnostic.hint = `Found product.json but neither a renderer bundle nor out/server-main.js: ${envRoot}
This is not a Cursor desktop install or a Cursor server root.`;
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
  let unrecognised = null;
  const installs = [];
  for (const appRoot of dedupeRoots(getCandidateRoots())) {
    if (!(0, import_fs2.existsSync)((0, import_path2.join)(appRoot, "product.json"))) {
      diagnostic.tried.push({ path: appRoot, status: "missing" });
      continue;
    }
    const profile = buildProfile(appRoot);
    if (isPatchableProfile(profile)) {
      profile.installedAt = installedAt(appRoot);
      installs.push(profile);
      diagnostic.tried.push({ path: appRoot, status: "found", version: profile.cursorVersion, kind: profile.kindLabel });
      continue;
    }
    unrecognised = appRoot;
    diagnostic.tried.push({ path: appRoot, status: "partial", version: profile.cursorVersion });
  }
  const desktop = installs.filter((p) => p.kind === KIND_DESKTOP);
  const pool = desktop.length > 0 ? desktop : installs;
  diagnostic.installs = pool.map((p) => ({ path: p.appRoot, version: p.cursorVersion, kind: p.kindLabel }));
  if (pool.length === 0) {
    if (unrecognised) {
      diagnostic.hint = `Found a Cursor directory but no renderer bundle and no out/server-main.js:
    ${unrecognised}
Cursor version may be too old or the layout has changed.`;
    } else {
      diagnostic.hint = "Cursor not found in any default location.\nIf installed in a custom path, set CCURSOR_CURSOR_ROOT to point at the resources/app directory\n(or at ~/.cursor-server/bin/<commit> on a remote host) and retry.";
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
    if (entry.path === selected.appRoot) entry.status = "ok";
  }
  return { paths: selected, diagnostic };
}
function formatDiagnostic(diagnostic) {
  const lines = [];
  lines.push(`Platform: ${diagnostic.platform}`);
  lines.push("Tried paths:");
  if (diagnostic.tried.length === 0) {
    lines.push("  (none \u2014 unsupported platform)");
  } else {
    for (const t of diagnostic.tried) {
      const tag = t.status === "ok" ? "\u2713" : t.status === "found" ? "\u25CB" : t.status === "partial" ? "~" : t.status === "env-override" ? "\u2192" : "\u2717";
      const detail = [t.version, t.kind].filter(Boolean).join(", ");
      lines.push(`  ${tag} ${t.path}${detail ? `  (${detail})` : ""}`);
    }
  }
  if (diagnostic.hint) {
    lines.push("");
    lines.push(diagnostic.hint);
  }
  return lines.join("\n");
}
function detectRemoteServerDirs() {
  const home = (0, import_os.homedir)();
  return [...SERVER_DATA_FOLDERS, ".vscode-server"].map((name) => (0, import_path2.join)(home, name)).filter((dir) => (0, import_fs2.existsSync)(dir));
}
function formatRemoteHostNotice(profile, dirs = detectRemoteServerDirs()) {
  if (profile && profile.kind !== KIND_DESKTOP) return [];
  if (dirs.length === 0) return [];
  const lines = ["Remote extension host detected \u2014 this install only covers the local side:"];
  for (const dir of dirs) lines.push(`  ${dir}`);
  lines.push("");
  lines.push("Cursor runs cursor-agent-host / cursor-agent-exec / cursor-agent-worker on the remote");
  lines.push("host, so agent requests made from a remote window never reach the BYOK server here.");
  lines.push("To make the remote host self-sufficient (no cross-machine port forwarding):");
  lines.push("  1. ssh into the remote host and run the installer there. It will select the");
  lines.push("     ~/.cursor-server/bin/<commit> server root and apply the server-side patches.");
  lines.push("  2. Install the cursor2plus-remote VSIX into the remote host \u2014 with the window");
  lines.push('     attached, Extensions view \u2192 "Install from VSIX", then "Install in SSH: <host>".');
  lines.push("     It is headless on purpose: the local Cursor++ keeps the panel and commands.");
  lines.push("  3. Create ~/.ccursor/providers.json on the remote host. API keys are per-machine");
  lines.push("     and are never copied over; the companion warns on activation when it is empty.");
  return lines;
}
function formatInstallSelection(diagnostic) {
  const installs = diagnostic?.installs || [];
  if (installs.length < 2) return [];
  const lines = [`Multiple Cursor installs detected, patching the newest (${diagnostic.selected}):`];
  for (const i of installs) {
    lines.push(`  ${i.path === diagnostic.selected ? "\u2192" : " "} ${i.path}  (${i.version}, ${i.kind})`);
  }
  lines.push("Override with CCURSOR_CURSOR_ROOT if this is not the install you run.");
  return lines;
}

// src/backup.js
var import_fs3 = require("fs");
var import_path3 = require("path");
var PREFIX = "backup-byok";
function backupNamePattern(base2, tag) {
  return `${base2}.${PREFIX}-${tag}-`;
}
function listBackups(dir, base2, tag) {
  if (!(0, import_fs3.existsSync)(dir)) return [];
  const prefix = backupNamePattern(base2, tag);
  return (0, import_fs3.readdirSync)(dir).filter((f) => f.startsWith(prefix)).sort();
}
function createBackup(filePath, tag, log) {
  const dir = (0, import_path3.dirname)(filePath);
  const base2 = (0, import_path3.basename)(filePath);
  const existing = listBackups(dir, base2, tag);
  if (existing.length > 0) {
    log?.(`  Backup exists: ${existing[0]}`);
    return (0, import_path3.join)(dir, existing[0]);
  }
  const ts = (/* @__PURE__ */ new Date()).toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const backupPath = `${filePath}.${PREFIX}-${tag}-${ts}`;
  (0, import_fs3.copyFileSync)(filePath, backupPath);
  log?.(`  Backup [${tag}]: ${(0, import_path3.basename)(backupPath)}`);
  return backupPath;
}
function restoreBackup(filePath, tag, log) {
  const dir = (0, import_path3.dirname)(filePath);
  const base2 = (0, import_path3.basename)(filePath);
  const backups = listBackups(dir, base2, tag);
  if (backups.length === 0) {
    log?.(`  No [${tag}] backup for ${base2}`);
    return false;
  }
  const primary = backups[0];
  (0, import_fs3.renameSync)((0, import_path3.join)(dir, primary), filePath);
  for (let i = 1; i < backups.length; i++) {
    try {
      (0, import_fs3.unlinkSync)((0, import_path3.join)(dir, backups[i]));
    } catch {
    }
  }
  log?.(`  Restored [${tag}]: ${base2}`);
  return true;
}
function hasBackup(filePath, tag) {
  const dir = (0, import_path3.dirname)(filePath);
  const base2 = (0, import_path3.basename)(filePath);
  if (!(0, import_fs3.existsSync)(dir)) return false;
  if (tag) {
    return listBackups(dir, base2, tag).length > 0;
  }
  return (0, import_fs3.readdirSync)(dir).some((f) => f.startsWith(`${base2}.${PREFIX}-`));
}

// src/release-defaults.js
var import_fs5 = require("fs");
var import_child_process = require("child_process");
var import_path5 = require("path");
var import_os3 = require("os");

// src/defaults.js
var CCURSOR_DIR_NAME = ".ccursor";
var ROUTES_FILE_NAME = "routes.json";
var PROVIDERS_FILE_NAME = "providers.json";
var DEFAULT_HOST = "127.0.0.1";
var DEFAULT_PORT = 39831;
var DEFAULT_COLLECTOR_PORT = 14800;
var PORT_FALLBACK_SPAN = 8;
var SSE_EVENT_ROUTES = "routes-v2";
var BASE_REDIRECT = [
  "REST:/auth/full_stripe_profile",
  "REST:/auth/stripe_profile"
];
var BYOK_REDIRECT = [
  // ── BYOK 核心 ──
  "aiserver.v1.AiService/AvailableModels",
  "agent.v1.AgentService/RunSSE",
  "agent.v1.AgentService/UploadConversationBlobs",
  "aiserver.v1.BidiService/BidiAppend",
  // ── 本地摘要持久化(BYOK Agent 配套) ──
  "aiserver.v1.ChatService/GetConversationSummary",
  "aiserver.v1.ChatService/StreamSpeculativeSummaries",
  // ── Rules / Knowledge Base (本地持久化) ──
  "aiserver.v1.AiService/KnowledgeBaseList",
  "aiserver.v1.AiService/KnowledgeBaseAdd",
  "aiserver.v1.AiService/KnowledgeBaseUpdate",
  "aiserver.v1.AiService/KnowledgeBaseRemove",
  // AiService: 模型/配置端点 — BYOK 拦截返回本地配置,不打官方
  "aiserver.v1.AiService/ServerTime",
  "aiserver.v1.AiService/GetDefaultModel",
  "aiserver.v1.AiService/GetDefaultModelNudgeData",
  // ── BYOK 流程下需要 stub 的服务 ──
  "aiserver.v1.AuthService",
  // AnalyticsService: 遥测上报返空; BootstrapStatsig 不拦截(直通官方拿真实 feature gate 配置)
  "aiserver.v1.AnalyticsService/Batch",
  // DashboardService: 逐方法挂入 — 未列出的方法 (如 ListMarketplacePlugins) 直接透传官方 API
  "aiserver.v1.DashboardService/GetPlanInfo",
  "aiserver.v1.DashboardService/GetCurrentPeriodUsage",
  "aiserver.v1.DashboardService/GetTeams",
  "aiserver.v1.DashboardService/GetUserPrivacyMode",
  "aiserver.v1.DashboardService/GetUsageLimitStatusAndActiveGrants",
  "aiserver.v1.DashboardService/GetEffectiveUserPlugins",
  "aiserver.v1.DashboardService/IsOnNewPricing",
  "aiserver.v1.DashboardService/GetManagedSkills",
  "aiserver.v1.DashboardService/GetTeamAdminSettingsOrEmptyIfNotInTeam",
  "aiserver.v1.DashboardService/GetTeamReposOrEmptyIfNotInTeam",
  // 3.6 新增: 不带 OrEmpty 后缀的 Team 端点 (非 team 用户打官方返回 unauthenticated 重试风暴)
  "aiserver.v1.DashboardService/GetTeamAdminSettings",
  "aiserver.v1.DashboardService/GetTeamBackgroundAgentSettings",
  "aiserver.v1.DashboardService/GetTeamRepos",
  // 'aiserver.v1.DashboardService/GetMe',
  "aiserver.v1.DashboardService/GetGlobalCommands",
  "aiserver.v1.DashboardService/GetTeamCommands",
  "aiserver.v1.DashboardService/GetSlackInstallUrl",
  "aiserver.v1.DashboardService/ShareCanvas",
  "aiserver.v1.DashboardService/LookupSharedCanvasByKey",
  "aiserver.v1.ServerConfigService",
  "aiserver.v1.NetworkService",
  "aiserver.v1.HealthService",
  "aiserver.v1.InAppAdService",
  // ── BackgroundComposerService (逐方法 stub — 启动轮询 + UI 初始化) ──
  "aiserver.v1.BackgroundComposerService/ListBackgroundComposers",
  "aiserver.v1.BackgroundComposerService/GetBackgroundComposerUserSettings",
  "aiserver.v1.BackgroundComposerService/ListTeamEnvironments",
  "aiserver.v1.BackgroundComposerService/ListPersonalEnvironments",
  // ── REST endpoints (BYOK 流程下需要的假账号 stub) ──
  "REST:/auth/has_valid_payment_method",
  "REST:/auth/poll",
  "REST:/auth/logout"
];
var DEFAULT_REDIRECT = [...BASE_REDIRECT, ...BYOK_REDIRECT];
var DEFAULT_ROUTES = {
  $schemaVersion: 1,
  byokMode: 1,
  server: { host: DEFAULT_HOST, port: DEFAULT_PORT },
  collector: { host: DEFAULT_HOST, port: DEFAULT_COLLECTOR_PORT },
  redirect: [...BASE_REDIRECT, ...BYOK_REDIRECT]
};
var DEFAULT_PROVIDERS = {
  $schemaVersion: 1,
  providers: []
};
var MODELS_CATALOG_FILE_NAME = "models-catalog.json";
var WEB_TOOLS_FILE_NAME = "web-tools.json";
var DEFAULT_WEB_TOOLS = {
  $schemaVersion: 1,
  search: {
    providers: [
      { id: "default-ddg", type: "duckduckgo", enabled: true },
      { id: "default-exa", type: "exa", enabled: false },
      { id: "default-tavily", type: "tavily", enabled: false },
      { id: "default-brave", type: "brave", enabled: false },
      { id: "default-jina", type: "jina", enabled: false },
      { id: "default-firecrawl", type: "firecrawl", enabled: false }
    ],
    parallel: false,
    maxResults: 10
  },
  fetch: {
    provider: "builtin"
  }
};

// src/routes.js
var import_fs4 = require("fs");
var import_path4 = require("path");
var import_os2 = require("os");
var CCURSOR_DIR = (0, import_path4.join)((0, import_os2.homedir)(), CCURSOR_DIR_NAME);
var ROUTES_PATH = (0, import_path4.join)(CCURSOR_DIR, ROUTES_FILE_NAME);
function loadRoutes() {
  if (!(0, import_fs4.existsSync)(ROUTES_PATH)) return cloneDefaults();
  try {
    const parsed = JSON.parse((0, import_fs4.readFileSync)(ROUTES_PATH, "utf-8"));
    return mergeWithDefaults(parsed);
  } catch {
    return cloneDefaults();
  }
}
function cloneDefaults() {
  return JSON.parse(JSON.stringify(DEFAULT_ROUTES));
}
function mergeWithDefaults(loaded) {
  const fallback = cloneDefaults();
  if (!loaded || typeof loaded !== "object") return fallback;
  return {
    $schemaVersion: loaded.$schemaVersion ?? fallback.$schemaVersion,
    server: {
      host: loaded.server?.host ?? fallback.server.host,
      port: loaded.server?.port ?? fallback.server.port,
      // Only present when the extension host runs remotely (Remote SSH / WSL).
      ...typeof loaded.server?.externalUrl === "string" && loaded.server.externalUrl ? { externalUrl: loaded.server.externalUrl } : {}
    },
    collector: {
      host: loaded.collector?.host ?? fallback.collector.host,
      port: loaded.collector?.port ?? fallback.collector.port
    },
    redirect: Array.isArray(loaded.redirect) && loaded.redirect.length > 0 ? loaded.redirect.slice() : fallback.redirect
  };
}

// src/release-defaults.js
function getCursorStateDbPath() {
  const home = (0, import_os3.homedir)();
  switch (process.platform) {
    case "darwin":
      return (0, import_path5.join)(home, "Library", "Application Support", "Cursor", "User", "globalStorage", "state.vscdb");
    case "win32":
      return (0, import_path5.join)(process.env.APPDATA || (0, import_path5.join)(home, "AppData", "Roaming"), "Cursor", "User", "globalStorage", "state.vscdb");
    case "linux":
      return (0, import_path5.join)(process.env.XDG_CONFIG_HOME || (0, import_path5.join)(home, ".config"), "Cursor", "User", "globalStorage", "state.vscdb");
    default:
      return (0, import_path5.join)(home, ".config", "Cursor", "User", "globalStorage", "state.vscdb");
  }
}
function detectByokMode(log) {
  const vscdb = getCursorStateDbPath();
  if (!(0, import_fs5.existsSync)(vscdb)) {
    log?.("  [detect] state.vscdb not found \u2192 byokMode: 0 (fresh Cursor)");
    return 0;
  }
  try {
    const query = "SELECT value FROM ItemTable WHERE key='cursorAuth/accessToken' LIMIT 1";
    const token = (0, import_child_process.execFileSync)("sqlite3", [vscdb, query], { encoding: "utf-8", timeout: 5e3 }).trim();
    if (!token || token.length < 10) {
      log?.("  [detect] no accessToken \u2192 byokMode: 0 (not logged in)");
      return 0;
    }
    const query2 = "SELECT value FROM ItemTable WHERE key='workbench.contrib.onboarding.browser.gettingStarted.contribution.ts.firsttime' LIMIT 1";
    const firsttime = (0, import_child_process.execFileSync)("sqlite3", [vscdb, query2], { encoding: "utf-8", timeout: 5e3 }).trim();
    if (firsttime === "" || firsttime === "true") {
      log?.("  [detect] onboarding not completed \u2192 byokMode: 0");
      return 0;
    }
    log?.("  [detect] logged in + onboarding done \u2192 byokMode: 1");
    return 1;
  } catch (e) {
    log?.(`  [detect] sqlite3 failed: ${e.message} \u2192 byokMode: 1 (fallback)`);
    return 1;
  }
}
function release(filename, content, log, { force = false } = {}) {
  const dest = (0, import_path5.join)(CCURSOR_DIR, filename);
  if (!force && (0, import_fs5.existsSync)(dest)) {
    log?.(`  ${filename} already exists, keep`);
    return false;
  }
  const existed = (0, import_fs5.existsSync)(dest);
  (0, import_fs5.writeFileSync)(dest, JSON.stringify(content, null, 2) + "\n", "utf-8");
  log?.(`  ${filename} ${existed ? "overwritten" : "released"}`);
  return true;
}
function resolveAssetPath(filename) {
  const candidates = [
    (0, import_path5.join)(__dirname, filename),
    // bundled: dist/<file>
    (0, import_path5.join)(__dirname, "..", "assets", filename)
    // dev: src/../assets/<file>
  ];
  for (const p of candidates) {
    if ((0, import_fs5.existsSync)(p)) return p;
  }
  return null;
}
function copyAsset(filename, log, { force = false } = {}) {
  const dest = (0, import_path5.join)(CCURSOR_DIR, filename);
  if (!force && (0, import_fs5.existsSync)(dest)) {
    log?.(`  ${filename} already exists, keep`);
    return false;
  }
  const src = resolveAssetPath(filename);
  if (!src) {
    log?.(`  ${filename} asset not bundled, skip`);
    return false;
  }
  const existed = (0, import_fs5.existsSync)(dest);
  (0, import_fs5.copyFileSync)(src, dest);
  const size = ((0, import_fs5.readFileSync)(dest).length / 1024).toFixed(1);
  log?.(`  ${filename} ${existed ? "updated" : "released"} (${size} KB)`);
  return true;
}
function formatSetupNotice() {
  const lines = [];
  const providersPath = (0, import_path5.join)(CCURSOR_DIR, PROVIDERS_FILE_NAME);
  let providerCount = 0;
  try {
    const parsed = JSON.parse((0, import_fs5.readFileSync)(providersPath, "utf-8"));
    providerCount = Array.isArray(parsed?.providers) ? parsed.providers.length : 0;
  } catch {
    providerCount = 0;
  }
  if (providerCount === 0) {
    lines.push("No LLM provider configured yet \u2014 Cursor will show no custom models.");
    lines.push("  Add one in the Cursor++ sidebar panel, or edit:");
    lines.push(`  ${providersPath}`);
  }
  try {
    const routes = JSON.parse((0, import_fs5.readFileSync)((0, import_path5.join)(CCURSOR_DIR, ROUTES_FILE_NAME), "utf-8"));
    if (routes?.byokMode === 0) {
      lines.push("BYOK mode is OFF (not signed in to Cursor, or onboarding unfinished).");
      lines.push("  Finish Cursor sign-in, then flip the toggle in the Cursor++ panel.");
    }
  } catch {
  }
  return lines;
}
function releaseDefaults(log) {
  log?.("[defaults] Releasing to ~/.ccursor/...");
  (0, import_fs5.mkdirSync)(CCURSOR_DIR, { recursive: true });
  const mode = detectByokMode(log);
  const routes = {
    ...DEFAULT_ROUTES,
    byokMode: mode,
    redirect: mode ? [...DEFAULT_REDIRECT] : [...BASE_REDIRECT]
  };
  release(ROUTES_FILE_NAME, routes, log, { force: true });
  release(PROVIDERS_FILE_NAME, DEFAULT_PROVIDERS, log);
  release(WEB_TOOLS_FILE_NAME, DEFAULT_WEB_TOOLS, log);
  copyAsset(MODELS_CATALOG_FILE_NAME, log, { force: true });
  log?.("[defaults] Done");
}

// src/steps.js
var import_fs14 = require("fs");

// node_modules/fflate/esm/index.mjs
var import_module = require("module");
var require2 = (0, import_module.createRequire)("/");
var _a;
var Worker;
var isMarkedAsUntransferable;
try {
  _a = require2("worker_threads"), Worker = _a.Worker, isMarkedAsUntransferable = _a.isMarkedAsUntransferable;
} catch (e) {
}
var u8 = Uint8Array;
var u16 = Uint16Array;
var i32 = Int32Array;
var fleb = new u8([
  0,
  0,
  0,
  0,
  0,
  0,
  0,
  0,
  1,
  1,
  1,
  1,
  2,
  2,
  2,
  2,
  3,
  3,
  3,
  3,
  4,
  4,
  4,
  4,
  5,
  5,
  5,
  5,
  0,
  /* unused */
  0,
  0,
  /* impossible */
  0
]);
var fdeb = new u8([
  0,
  0,
  0,
  0,
  1,
  1,
  2,
  2,
  3,
  3,
  4,
  4,
  5,
  5,
  6,
  6,
  7,
  7,
  8,
  8,
  9,
  9,
  10,
  10,
  11,
  11,
  12,
  12,
  13,
  13,
  /* unused */
  0,
  0
]);
var clim = new u8([16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15]);
var freb = function(eb, start) {
  var b = new u16(31);
  for (var i = 0; i < 31; ++i) {
    b[i] = start += 1 << eb[i - 1];
  }
  var r = new i32(b[30]);
  for (var i = 1; i < 30; ++i) {
    for (var j = b[i]; j < b[i + 1]; ++j) {
      r[j] = j - b[i] << 5 | i;
    }
  }
  return { b, r };
};
var _a = freb(fleb, 2);
var fl = _a.b;
var revfl = _a.r;
fl[28] = 258, revfl[258] = 28;
var _b = freb(fdeb, 0);
var fd = _b.b;
var revfd = _b.r;
var rev = new u16(32768);
for (i = 0; i < 32768; ++i) {
  x = (i & 43690) >> 1 | (i & 21845) << 1;
  x = (x & 52428) >> 2 | (x & 13107) << 2;
  x = (x & 61680) >> 4 | (x & 3855) << 4;
  rev[i] = ((x & 65280) >> 8 | (x & 255) << 8) >> 1;
}
var x;
var i;
var hMap = (function(cd, mb, r) {
  var s = cd.length;
  var i = 0;
  var l = new u16(mb);
  for (; i < s; ++i) {
    if (cd[i])
      ++l[cd[i] - 1];
  }
  var le = new u16(mb);
  for (i = 1; i < mb; ++i) {
    le[i] = le[i - 1] + l[i - 1] << 1;
  }
  var co;
  if (r) {
    co = new u16(1 << mb);
    var rvb = 15 - mb;
    for (i = 0; i < s; ++i) {
      if (cd[i]) {
        var sv = i << 4 | cd[i];
        var r_1 = mb - cd[i];
        var v = le[cd[i] - 1]++ << r_1;
        for (var m = v | (1 << r_1) - 1; v <= m; ++v) {
          co[rev[v] >> rvb] = sv;
        }
      }
    }
  } else {
    co = new u16(s);
    for (i = 0; i < s; ++i) {
      if (cd[i]) {
        co[i] = rev[le[cd[i] - 1]++] >> 15 - cd[i];
      }
    }
  }
  return co;
});
var flt = new u8(288);
for (i = 0; i < 144; ++i)
  flt[i] = 8;
var i;
for (i = 144; i < 256; ++i)
  flt[i] = 9;
var i;
for (i = 256; i < 280; ++i)
  flt[i] = 7;
var i;
for (i = 280; i < 288; ++i)
  flt[i] = 8;
var i;
var fdt = new u8(32);
for (i = 0; i < 32; ++i)
  fdt[i] = 5;
var i;
var flrm = /* @__PURE__ */ hMap(flt, 9, 1);
var fdrm = /* @__PURE__ */ hMap(fdt, 5, 1);
var max = function(a) {
  var m = a[0];
  for (var i = 1; i < a.length; ++i) {
    if (a[i] > m)
      m = a[i];
  }
  return m;
};
var bits = function(d, p, m) {
  var o = p / 8 | 0;
  return (d[o] | d[o + 1] << 8) >> (p & 7) & m;
};
var bits16 = function(d, p) {
  var o = p / 8 | 0;
  return (d[o] | d[o + 1] << 8 | d[o + 2] << 16) >> (p & 7);
};
var shft = function(p) {
  return (p + 7) / 8 | 0;
};
var slc = function(v, s, e) {
  if (s == null || s < 0)
    s = 0;
  if (e == null || e > v.length)
    e = v.length;
  return new u8(v.subarray(s, e));
};
var ec = [
  "unexpected EOF",
  "invalid block type",
  "invalid length/literal",
  "invalid distance",
  "stream finished",
  "no stream handler",
  ,
  // determined by compression function
  "no callback",
  "invalid UTF-8 data",
  "extra field too long",
  "date not in range 1980-2099",
  "filename too long",
  "stream finishing",
  "invalid zip data"
  // determined by unknown compression method
];
var err = function(ind, msg, nt) {
  var e = new Error(msg || ec[ind]);
  e.code = ind;
  if (Error.captureStackTrace)
    Error.captureStackTrace(e, err);
  if (!nt)
    throw e;
  return e;
};
var inflt = function(dat, st, buf, dict) {
  var sl = dat.length, dl = dict ? dict.length : 0;
  if (!sl || st.f && !st.l)
    return buf || new u8(0);
  var noBuf = !buf;
  var resize = noBuf || st.i != 2;
  var noSt = st.i;
  if (noBuf)
    buf = new u8(sl * 3);
  var cbuf = function(l2) {
    var bl = buf.length;
    if (l2 > bl) {
      var nbuf = new u8(Math.max(bl * 2, l2));
      nbuf.set(buf);
      buf = nbuf;
    }
  };
  var final = st.f || 0, pos = st.p || 0, bt = st.b || 0, lm = st.l, dm = st.d, lbt = st.m, dbt = st.n;
  var tbts = sl * 8;
  do {
    if (!lm) {
      final = bits(dat, pos, 1);
      var type = bits(dat, pos + 1, 3);
      pos += 3;
      if (!type) {
        var s = shft(pos) + 4, l = dat[s - 4] | dat[s - 3] << 8, t = s + l;
        if (t > sl) {
          if (noSt)
            err(0);
          break;
        }
        if (resize)
          cbuf(bt + l);
        buf.set(dat.subarray(s, t), bt);
        st.b = bt += l, st.p = pos = t * 8, st.f = final;
        continue;
      } else if (type == 1)
        lm = flrm, dm = fdrm, lbt = 9, dbt = 5;
      else if (type == 2) {
        var hLit = bits(dat, pos, 31) + 257, hcLen = bits(dat, pos + 10, 15) + 4;
        var tl = hLit + bits(dat, pos + 5, 31) + 1;
        pos += 14;
        var ldt = new u8(tl);
        var clt = new u8(19);
        for (var i = 0; i < hcLen; ++i) {
          clt[clim[i]] = bits(dat, pos + i * 3, 7);
        }
        pos += hcLen * 3;
        var clb = max(clt), clbmsk = (1 << clb) - 1;
        var clm = hMap(clt, clb, 1);
        for (var i = 0; i < tl; ) {
          var r = clm[bits(dat, pos, clbmsk)];
          pos += r & 15;
          var s = r >> 4;
          if (s < 16) {
            ldt[i++] = s;
          } else {
            var c = 0, n = 0;
            if (s == 16)
              n = 3 + bits(dat, pos, 3), pos += 2, c = ldt[i - 1];
            else if (s == 17)
              n = 3 + bits(dat, pos, 7), pos += 3;
            else if (s == 18)
              n = 11 + bits(dat, pos, 127), pos += 7;
            while (n--)
              ldt[i++] = c;
          }
        }
        var lt = ldt.subarray(0, hLit), dt = ldt.subarray(hLit);
        lbt = max(lt);
        dbt = max(dt);
        lm = hMap(lt, lbt, 1);
        dm = hMap(dt, dbt, 1);
      } else
        err(1);
      if (pos > tbts) {
        if (noSt)
          err(0);
        break;
      }
    }
    if (resize)
      cbuf(bt + 131072);
    var lms = (1 << lbt) - 1, dms = (1 << dbt) - 1;
    var lpos = pos;
    for (; ; lpos = pos) {
      var c = lm[bits16(dat, pos) & lms], sym = c >> 4;
      pos += c & 15;
      if (pos > tbts) {
        if (noSt)
          err(0);
        break;
      }
      if (!c)
        err(2);
      if (sym < 256)
        buf[bt++] = sym;
      else if (sym == 256) {
        lpos = pos, lm = null;
        break;
      } else {
        var add = sym - 254;
        if (sym > 264) {
          var i = sym - 257, b = fleb[i];
          add = bits(dat, pos, (1 << b) - 1) + fl[i];
          pos += b;
        }
        var d = dm[bits16(dat, pos) & dms], dsym = d >> 4;
        if (!d)
          err(3);
        pos += d & 15;
        var dt = fd[dsym];
        if (dsym > 3) {
          var b = fdeb[dsym];
          dt += bits16(dat, pos) & (1 << b) - 1, pos += b;
        }
        if (pos > tbts) {
          if (noSt)
            err(0);
          break;
        }
        if (resize)
          cbuf(bt + 131072);
        var end = bt + add;
        if (bt < dt) {
          var shift = dl - dt, dend = Math.min(dt, end);
          if (shift + bt < 0)
            err(3);
          for (; bt < dend; ++bt)
            buf[bt] = dict[shift + bt];
        }
        for (; bt < end; ++bt)
          buf[bt] = buf[bt - dt];
      }
    }
    st.l = lm, st.p = lpos, st.b = bt, st.f = final;
    if (lm)
      final = 1, st.m = lbt, st.d = dm, st.n = dbt;
  } while (!final);
  return bt != buf.length && noBuf ? slc(buf, 0, bt) : buf.subarray(0, bt);
};
var et = /* @__PURE__ */ new u8(0);
var b2 = function(d, b) {
  return d[b] | d[b + 1] << 8;
};
var b4 = function(d, b) {
  return (d[b] | d[b + 1] << 8 | d[b + 2] << 16 | d[b + 3] << 24) >>> 0;
};
var b8 = function(d, b) {
  return b4(d, b) + b4(d, b + 4) * 4294967296;
};
function inflateSync(data2, opts) {
  return inflt(data2, { i: 2 }, opts && opts.out, opts && opts.dictionary);
}
var td = typeof TextDecoder != "undefined" && /* @__PURE__ */ new TextDecoder();
var tds = 0;
try {
  td.decode(et, { stream: true });
  tds = 1;
} catch (e) {
}
var dutf8 = function(d) {
  for (var r = "", i = 0; ; ) {
    var c = d[i++];
    var eb = (c > 127) + (c > 223) + (c > 239);
    if (i + eb > d.length)
      return { s: r, r: slc(d, i - 1) };
    if (!eb)
      r += String.fromCharCode(c);
    else if (eb == 3) {
      c = ((c & 15) << 18 | (d[i++] & 63) << 12 | (d[i++] & 63) << 6 | d[i++] & 63) - 65536, r += String.fromCharCode(55296 | c >> 10, 56320 | c & 1023);
    } else if (eb & 1)
      r += String.fromCharCode((c & 31) << 6 | d[i++] & 63);
    else
      r += String.fromCharCode((c & 15) << 12 | (d[i++] & 63) << 6 | d[i++] & 63);
  }
};
function strFromU8(dat, latin1) {
  if (latin1) {
    var r = "";
    for (var i = 0; i < dat.length; i += 16384)
      r += String.fromCharCode.apply(null, dat.subarray(i, i + 16384));
    return r;
  } else if (td) {
    return td.decode(dat);
  } else {
    var _a2 = dutf8(dat), s = _a2.s, r = _a2.r;
    if (r.length)
      err(8);
    return s;
  }
}
var slzh = function(d, b) {
  return b + 30 + b2(d, b + 26) + b2(d, b + 28);
};
var zh = function(d, b, z) {
  var fnl = b2(d, b + 28), efl = b2(d, b + 30), fn2 = strFromU8(d.subarray(b + 46, b + 46 + fnl), !(b2(d, b + 8) & 2048)), es = b + 46 + fnl;
  var _a2 = z64hs(d, es, efl, z, b4(d, b + 20), b4(d, b + 24), b4(d, b + 42)), sc = _a2[0], su = _a2[1], off = _a2[2];
  return [b2(d, b + 10), sc, su, fn2, es + efl + b2(d, b + 32), off];
};
var z64hs = function(d, b, l, z, sc, su, off) {
  var nsc = sc == 4294967295, nsu = su == 4294967295, noff = off == 4294967295, e = b + l;
  var nf = nsc + nsu + noff;
  if (z && nf) {
    for (; b + 4 < e; b += 4 + b2(d, b + 2)) {
      if (b2(d, b) == 1) {
        return [
          nsc ? b8(d, b + 4 + 8 * nsu) : sc,
          nsu ? b8(d, b + 4) : su,
          noff ? b8(d, b + 4 + 8 * (nsu + nsc)) : off,
          1
        ];
      }
    }
    if (z < 2)
      err(13);
  }
  return [sc, su, off, 0];
};
function unzipSync(data2, opts) {
  var files = {};
  var e = data2.length - 22;
  for (; b4(data2, e) != 101010256; --e) {
    if (!e || data2.length - e > 65558)
      err(13);
  }
  ;
  var c = b2(data2, e + 8);
  if (!c)
    return {};
  var o = b4(data2, e + 16);
  var z = b4(data2, e - 20) == 117853008;
  if (z) {
    var ze = b4(data2, e - 12);
    z = b4(data2, ze) == 101075792;
    if (z) {
      c = b4(data2, ze + 32);
      o = b4(data2, ze + 48);
    }
  }
  var fltr = opts && opts.filter;
  for (var i = 0; i < c; ++i) {
    var _a2 = zh(data2, o, z), c_2 = _a2[0], sc = _a2[1], su = _a2[2], fn2 = _a2[3], no = _a2[4], off = _a2[5], b = slzh(data2, off);
    o = no;
    if (!fltr || fltr({
      name: fn2,
      size: sc,
      originalSize: su,
      compression: c_2
    })) {
      if (!c_2)
        files[fn2] = slc(data2, b, b + sc);
      else if (c_2 == 8)
        files[fn2] = inflateSync(data2.subarray(b, b + sc), { out: new u8(su) });
      else
        err(14, "unknown compression type " + c_2);
    }
  }
  return files;
}

// src/extension-embed.js
var import_fs6 = require("fs");
var import_path6 = require("path");
var __pkgRoot = (0, import_path6.join)(__dirname, "..");
function installExtension(paths, log) {
  log?.("[extension] Installing to Cursor.app/extensions/cursor2plus/...");
  const vsixDir = (0, import_path6.join)(__pkgRoot, "vsix");
  const vsixFiles = (0, import_fs6.existsSync)(vsixDir) ? (0, import_fs6.readdirSync)(vsixDir).filter((f) => f.endsWith(".vsix")) : [];
  if (vsixFiles.length === 0) {
    throw new Error('No .vsix file found in vsix/ directory. Run "npm run build" first.');
  }
  const vsixPath = (0, import_path6.join)(vsixDir, vsixFiles[0]);
  const targetDir = paths.cursor2plusDir;
  if ((0, import_fs6.existsSync)(targetDir)) {
    (0, import_fs6.rmSync)(targetDir, { recursive: true, force: true });
  }
  (0, import_fs6.mkdirSync)(targetDir, { recursive: true });
  const zipData = new Uint8Array((0, import_fs6.readFileSync)(vsixPath));
  const files = unzipSync(zipData);
  const prefix = "extension/";
  let count = 0;
  for (const [name, data2] of Object.entries(files)) {
    if (!name.startsWith(prefix) || name.endsWith("/"))
      continue;
    const relPath = name.slice(prefix.length);
    const destPath = (0, import_path6.join)(targetDir, relPath);
    (0, import_fs6.mkdirSync)((0, import_path6.dirname)(destPath), { recursive: true });
    (0, import_fs6.writeFileSync)(destPath, data2);
    count++;
  }
  log?.(`  Installed: ${targetDir} (${count} files)`);
  log?.(`  From: ${vsixFiles[0]}`);
}
function removeExtension(paths, log) {
  if ((0, import_fs6.existsSync)(paths.cursor2plusDir)) {
    (0, import_fs6.rmSync)(paths.cursor2plusDir, { recursive: true, force: true });
    log?.("[extension] Removed cursor2plus from extensions/");
  } else {
    log?.("[extension] Not installed");
  }
}
function isExtensionInstalled(paths) {
  return (0, import_fs6.existsSync)((0, import_path6.join)(paths.cursor2plusDir, "package.json"));
}

// src/patch-inject.js
var import_fs8 = require("fs");

// node_modules/acorn/dist/acorn.mjs
var astralIdentifierCodes = [509, 0, 227, 0, 150, 4, 294, 9, 1368, 2, 2, 1, 6, 3, 41, 2, 5, 0, 166, 1, 574, 3, 9, 9, 7, 9, 32, 4, 318, 1, 78, 5, 71, 10, 50, 3, 123, 2, 54, 14, 32, 10, 3, 1, 11, 3, 46, 10, 8, 0, 46, 9, 7, 2, 37, 13, 2, 9, 6, 1, 45, 0, 13, 2, 49, 13, 9, 3, 2, 11, 83, 11, 7, 0, 3, 0, 158, 11, 6, 9, 7, 3, 56, 1, 2, 6, 3, 1, 3, 2, 10, 0, 11, 1, 3, 6, 4, 4, 68, 8, 2, 0, 3, 0, 2, 3, 2, 4, 2, 0, 15, 1, 83, 17, 10, 9, 5, 0, 82, 19, 13, 9, 214, 6, 3, 8, 28, 1, 83, 16, 16, 9, 82, 12, 9, 9, 7, 19, 58, 14, 5, 9, 243, 14, 166, 9, 71, 5, 2, 1, 3, 3, 2, 0, 2, 1, 13, 9, 120, 6, 3, 6, 4, 0, 29, 9, 41, 6, 2, 3, 9, 0, 10, 10, 47, 15, 199, 7, 137, 9, 54, 7, 2, 7, 17, 9, 57, 21, 2, 13, 123, 5, 4, 0, 2, 1, 2, 6, 2, 0, 9, 9, 49, 4, 2, 1, 2, 4, 9, 9, 55, 9, 266, 3, 10, 1, 2, 0, 49, 6, 4, 4, 14, 10, 5350, 0, 7, 14, 11465, 27, 2343, 9, 87, 9, 39, 4, 60, 6, 26, 9, 535, 9, 470, 0, 2, 54, 8, 3, 82, 0, 12, 1, 19628, 1, 4178, 9, 519, 45, 3, 22, 543, 4, 4, 5, 9, 7, 3, 6, 31, 3, 149, 2, 1418, 49, 513, 54, 5, 49, 9, 0, 15, 0, 23, 4, 2, 14, 1361, 6, 2, 16, 3, 6, 2, 1, 2, 4, 101, 0, 161, 6, 10, 9, 357, 0, 62, 13, 499, 13, 245, 1, 2, 9, 233, 0, 3, 0, 8, 1, 6, 0, 475, 6, 110, 6, 6, 9, 4759, 9, 787719, 239];
var astralIdentifierStartCodes = [0, 11, 2, 25, 2, 18, 2, 1, 2, 14, 3, 13, 35, 122, 70, 52, 268, 28, 4, 48, 48, 31, 14, 29, 6, 37, 11, 29, 3, 35, 5, 7, 2, 4, 43, 157, 19, 35, 5, 35, 5, 39, 9, 51, 13, 10, 2, 14, 2, 6, 2, 1, 2, 10, 2, 14, 2, 6, 2, 1, 4, 51, 13, 310, 10, 21, 11, 7, 25, 5, 2, 41, 2, 8, 70, 5, 3, 0, 2, 43, 2, 1, 4, 0, 3, 22, 11, 22, 10, 30, 66, 18, 2, 1, 11, 21, 11, 25, 7, 25, 39, 55, 7, 1, 65, 0, 16, 3, 2, 2, 2, 28, 43, 28, 4, 28, 36, 7, 2, 27, 28, 53, 11, 21, 11, 18, 14, 17, 111, 72, 56, 50, 14, 50, 14, 35, 39, 27, 10, 22, 251, 41, 7, 1, 17, 5, 57, 28, 11, 0, 9, 21, 43, 17, 47, 20, 28, 22, 13, 52, 58, 1, 3, 0, 14, 44, 33, 24, 27, 35, 30, 0, 3, 0, 9, 34, 4, 0, 13, 47, 15, 3, 22, 0, 2, 0, 36, 17, 2, 24, 20, 1, 64, 6, 2, 0, 2, 3, 2, 14, 2, 9, 8, 46, 39, 7, 3, 1, 3, 21, 2, 6, 2, 1, 2, 4, 4, 0, 19, 0, 13, 4, 31, 9, 2, 0, 3, 0, 2, 37, 2, 0, 26, 0, 2, 0, 45, 52, 19, 3, 21, 2, 31, 47, 21, 1, 2, 0, 185, 46, 42, 3, 37, 47, 21, 0, 60, 42, 14, 0, 72, 26, 38, 6, 186, 43, 117, 63, 32, 7, 3, 0, 3, 7, 2, 1, 2, 23, 16, 0, 2, 0, 95, 7, 3, 38, 17, 0, 2, 0, 29, 0, 11, 39, 8, 0, 22, 0, 12, 45, 20, 0, 19, 72, 200, 32, 32, 8, 2, 36, 18, 0, 50, 29, 113, 6, 2, 1, 2, 37, 22, 0, 26, 5, 2, 1, 2, 31, 15, 0, 24, 43, 261, 18, 16, 0, 2, 12, 2, 33, 125, 0, 80, 921, 103, 110, 18, 195, 2637, 96, 16, 1071, 18, 5, 26, 3994, 6, 582, 6842, 29, 1763, 568, 8, 30, 18, 78, 18, 29, 19, 47, 17, 3, 32, 20, 6, 18, 433, 44, 212, 63, 33, 24, 3, 24, 45, 74, 6, 0, 67, 12, 65, 1, 2, 0, 15, 4, 10, 7381, 42, 31, 98, 114, 8702, 3, 2, 6, 2, 1, 2, 290, 16, 0, 30, 2, 3, 0, 15, 3, 9, 395, 2309, 106, 6, 12, 4, 8, 8, 9, 5991, 84, 2, 70, 2, 1, 3, 0, 3, 1, 3, 3, 2, 11, 2, 0, 2, 6, 2, 64, 2, 3, 3, 7, 2, 6, 2, 27, 2, 3, 2, 4, 2, 0, 4, 6, 2, 339, 3, 24, 2, 24, 2, 30, 2, 24, 2, 30, 2, 24, 2, 30, 2, 24, 2, 30, 2, 24, 2, 7, 1845, 30, 7, 5, 262, 61, 147, 44, 11, 6, 17, 0, 322, 29, 19, 43, 485, 27, 229, 29, 3, 0, 208, 30, 2, 2, 2, 1, 2, 6, 3, 4, 10, 1, 225, 6, 2, 3, 2, 1, 2, 14, 2, 196, 60, 67, 8, 0, 1205, 3, 2, 26, 2, 1, 2, 0, 3, 0, 2, 9, 2, 3, 2, 0, 2, 0, 7, 0, 5, 0, 2, 0, 2, 0, 2, 2, 2, 1, 2, 0, 3, 0, 2, 0, 2, 0, 2, 0, 2, 0, 2, 1, 2, 0, 3, 3, 2, 6, 2, 3, 2, 3, 2, 0, 2, 9, 2, 16, 6, 2, 2, 4, 2, 16, 4421, 42719, 33, 4381, 3, 5773, 3, 7472, 16, 621, 2467, 541, 1507, 4938, 6, 8489];
var nonASCIIidentifierChars = "\u200C\u200D\xB7\u0300-\u036F\u0387\u0483-\u0487\u0591-\u05BD\u05BF\u05C1\u05C2\u05C4\u05C5\u05C7\u0610-\u061A\u064B-\u0669\u0670\u06D6-\u06DC\u06DF-\u06E4\u06E7\u06E8\u06EA-\u06ED\u06F0-\u06F9\u0711\u0730-\u074A\u07A6-\u07B0\u07C0-\u07C9\u07EB-\u07F3\u07FD\u0816-\u0819\u081B-\u0823\u0825-\u0827\u0829-\u082D\u0859-\u085B\u0897-\u089F\u08CA-\u08E1\u08E3-\u0903\u093A-\u093C\u093E-\u094F\u0951-\u0957\u0962\u0963\u0966-\u096F\u0981-\u0983\u09BC\u09BE-\u09C4\u09C7\u09C8\u09CB-\u09CD\u09D7\u09E2\u09E3\u09E6-\u09EF\u09FE\u0A01-\u0A03\u0A3C\u0A3E-\u0A42\u0A47\u0A48\u0A4B-\u0A4D\u0A51\u0A66-\u0A71\u0A75\u0A81-\u0A83\u0ABC\u0ABE-\u0AC5\u0AC7-\u0AC9\u0ACB-\u0ACD\u0AE2\u0AE3\u0AE6-\u0AEF\u0AFA-\u0AFF\u0B01-\u0B03\u0B3C\u0B3E-\u0B44\u0B47\u0B48\u0B4B-\u0B4D\u0B55-\u0B57\u0B62\u0B63\u0B66-\u0B6F\u0B82\u0BBE-\u0BC2\u0BC6-\u0BC8\u0BCA-\u0BCD\u0BD7\u0BE6-\u0BEF\u0C00-\u0C04\u0C3C\u0C3E-\u0C44\u0C46-\u0C48\u0C4A-\u0C4D\u0C55\u0C56\u0C62\u0C63\u0C66-\u0C6F\u0C81-\u0C83\u0CBC\u0CBE-\u0CC4\u0CC6-\u0CC8\u0CCA-\u0CCD\u0CD5\u0CD6\u0CE2\u0CE3\u0CE6-\u0CEF\u0CF3\u0D00-\u0D03\u0D3B\u0D3C\u0D3E-\u0D44\u0D46-\u0D48\u0D4A-\u0D4D\u0D57\u0D62\u0D63\u0D66-\u0D6F\u0D81-\u0D83\u0DCA\u0DCF-\u0DD4\u0DD6\u0DD8-\u0DDF\u0DE6-\u0DEF\u0DF2\u0DF3\u0E31\u0E34-\u0E3A\u0E47-\u0E4E\u0E50-\u0E59\u0EB1\u0EB4-\u0EBC\u0EC8-\u0ECE\u0ED0-\u0ED9\u0F18\u0F19\u0F20-\u0F29\u0F35\u0F37\u0F39\u0F3E\u0F3F\u0F71-\u0F84\u0F86\u0F87\u0F8D-\u0F97\u0F99-\u0FBC\u0FC6\u102B-\u103E\u1040-\u1049\u1056-\u1059\u105E-\u1060\u1062-\u1064\u1067-\u106D\u1071-\u1074\u1082-\u108D\u108F-\u109D\u135D-\u135F\u1369-\u1371\u1712-\u1715\u1732-\u1734\u1752\u1753\u1772\u1773\u17B4-\u17D3\u17DD\u17E0-\u17E9\u180B-\u180D\u180F-\u1819\u18A9\u1920-\u192B\u1930-\u193B\u1946-\u194F\u19D0-\u19DA\u1A17-\u1A1B\u1A55-\u1A5E\u1A60-\u1A7C\u1A7F-\u1A89\u1A90-\u1A99\u1AB0-\u1ABD\u1ABF-\u1ADD\u1AE0-\u1AEB\u1B00-\u1B04\u1B34-\u1B44\u1B50-\u1B59\u1B6B-\u1B73\u1B80-\u1B82\u1BA1-\u1BAD\u1BB0-\u1BB9\u1BE6-\u1BF3\u1C24-\u1C37\u1C40-\u1C49\u1C50-\u1C59\u1CD0-\u1CD2\u1CD4-\u1CE8\u1CED\u1CF4\u1CF7-\u1CF9\u1DC0-\u1DFF\u200C\u200D\u203F\u2040\u2054\u20D0-\u20DC\u20E1\u20E5-\u20F0\u2CEF-\u2CF1\u2D7F\u2DE0-\u2DFF\u302A-\u302F\u3099\u309A\u30FB\uA620-\uA629\uA66F\uA674-\uA67D\uA69E\uA69F\uA6F0\uA6F1\uA802\uA806\uA80B\uA823-\uA827\uA82C\uA880\uA881\uA8B4-\uA8C5\uA8D0-\uA8D9\uA8E0-\uA8F1\uA8FF-\uA909\uA926-\uA92D\uA947-\uA953\uA980-\uA983\uA9B3-\uA9C0\uA9D0-\uA9D9\uA9E5\uA9F0-\uA9F9\uAA29-\uAA36\uAA43\uAA4C\uAA4D\uAA50-\uAA59\uAA7B-\uAA7D\uAAB0\uAAB2-\uAAB4\uAAB7\uAAB8\uAABE\uAABF\uAAC1\uAAEB-\uAAEF\uAAF5\uAAF6\uABE3-\uABEA\uABEC\uABED\uABF0-\uABF9\uFB1E\uFE00-\uFE0F\uFE20-\uFE2F\uFE33\uFE34\uFE4D-\uFE4F\uFF10-\uFF19\uFF3F\uFF65";
var nonASCIIidentifierStartChars = "\xAA\xB5\xBA\xC0-\xD6\xD8-\xF6\xF8-\u02C1\u02C6-\u02D1\u02E0-\u02E4\u02EC\u02EE\u0370-\u0374\u0376\u0377\u037A-\u037D\u037F\u0386\u0388-\u038A\u038C\u038E-\u03A1\u03A3-\u03F5\u03F7-\u0481\u048A-\u052F\u0531-\u0556\u0559\u0560-\u0588\u05D0-\u05EA\u05EF-\u05F2\u0620-\u064A\u066E\u066F\u0671-\u06D3\u06D5\u06E5\u06E6\u06EE\u06EF\u06FA-\u06FC\u06FF\u0710\u0712-\u072F\u074D-\u07A5\u07B1\u07CA-\u07EA\u07F4\u07F5\u07FA\u0800-\u0815\u081A\u0824\u0828\u0840-\u0858\u0860-\u086A\u0870-\u0887\u0889-\u088F\u08A0-\u08C9\u0904-\u0939\u093D\u0950\u0958-\u0961\u0971-\u0980\u0985-\u098C\u098F\u0990\u0993-\u09A8\u09AA-\u09B0\u09B2\u09B6-\u09B9\u09BD\u09CE\u09DC\u09DD\u09DF-\u09E1\u09F0\u09F1\u09FC\u0A05-\u0A0A\u0A0F\u0A10\u0A13-\u0A28\u0A2A-\u0A30\u0A32\u0A33\u0A35\u0A36\u0A38\u0A39\u0A59-\u0A5C\u0A5E\u0A72-\u0A74\u0A85-\u0A8D\u0A8F-\u0A91\u0A93-\u0AA8\u0AAA-\u0AB0\u0AB2\u0AB3\u0AB5-\u0AB9\u0ABD\u0AD0\u0AE0\u0AE1\u0AF9\u0B05-\u0B0C\u0B0F\u0B10\u0B13-\u0B28\u0B2A-\u0B30\u0B32\u0B33\u0B35-\u0B39\u0B3D\u0B5C\u0B5D\u0B5F-\u0B61\u0B71\u0B83\u0B85-\u0B8A\u0B8E-\u0B90\u0B92-\u0B95\u0B99\u0B9A\u0B9C\u0B9E\u0B9F\u0BA3\u0BA4\u0BA8-\u0BAA\u0BAE-\u0BB9\u0BD0\u0C05-\u0C0C\u0C0E-\u0C10\u0C12-\u0C28\u0C2A-\u0C39\u0C3D\u0C58-\u0C5A\u0C5C\u0C5D\u0C60\u0C61\u0C80\u0C85-\u0C8C\u0C8E-\u0C90\u0C92-\u0CA8\u0CAA-\u0CB3\u0CB5-\u0CB9\u0CBD\u0CDC-\u0CDE\u0CE0\u0CE1\u0CF1\u0CF2\u0D04-\u0D0C\u0D0E-\u0D10\u0D12-\u0D3A\u0D3D\u0D4E\u0D54-\u0D56\u0D5F-\u0D61\u0D7A-\u0D7F\u0D85-\u0D96\u0D9A-\u0DB1\u0DB3-\u0DBB\u0DBD\u0DC0-\u0DC6\u0E01-\u0E30\u0E32\u0E33\u0E40-\u0E46\u0E81\u0E82\u0E84\u0E86-\u0E8A\u0E8C-\u0EA3\u0EA5\u0EA7-\u0EB0\u0EB2\u0EB3\u0EBD\u0EC0-\u0EC4\u0EC6\u0EDC-\u0EDF\u0F00\u0F40-\u0F47\u0F49-\u0F6C\u0F88-\u0F8C\u1000-\u102A\u103F\u1050-\u1055\u105A-\u105D\u1061\u1065\u1066\u106E-\u1070\u1075-\u1081\u108E\u10A0-\u10C5\u10C7\u10CD\u10D0-\u10FA\u10FC-\u1248\u124A-\u124D\u1250-\u1256\u1258\u125A-\u125D\u1260-\u1288\u128A-\u128D\u1290-\u12B0\u12B2-\u12B5\u12B8-\u12BE\u12C0\u12C2-\u12C5\u12C8-\u12D6\u12D8-\u1310\u1312-\u1315\u1318-\u135A\u1380-\u138F\u13A0-\u13F5\u13F8-\u13FD\u1401-\u166C\u166F-\u167F\u1681-\u169A\u16A0-\u16EA\u16EE-\u16F8\u1700-\u1711\u171F-\u1731\u1740-\u1751\u1760-\u176C\u176E-\u1770\u1780-\u17B3\u17D7\u17DC\u1820-\u1878\u1880-\u18A8\u18AA\u18B0-\u18F5\u1900-\u191E\u1950-\u196D\u1970-\u1974\u1980-\u19AB\u19B0-\u19C9\u1A00-\u1A16\u1A20-\u1A54\u1AA7\u1B05-\u1B33\u1B45-\u1B4C\u1B83-\u1BA0\u1BAE\u1BAF\u1BBA-\u1BE5\u1C00-\u1C23\u1C4D-\u1C4F\u1C5A-\u1C7D\u1C80-\u1C8A\u1C90-\u1CBA\u1CBD-\u1CBF\u1CE9-\u1CEC\u1CEE-\u1CF3\u1CF5\u1CF6\u1CFA\u1D00-\u1DBF\u1E00-\u1F15\u1F18-\u1F1D\u1F20-\u1F45\u1F48-\u1F4D\u1F50-\u1F57\u1F59\u1F5B\u1F5D\u1F5F-\u1F7D\u1F80-\u1FB4\u1FB6-\u1FBC\u1FBE\u1FC2-\u1FC4\u1FC6-\u1FCC\u1FD0-\u1FD3\u1FD6-\u1FDB\u1FE0-\u1FEC\u1FF2-\u1FF4\u1FF6-\u1FFC\u2071\u207F\u2090-\u209C\u2102\u2107\u210A-\u2113\u2115\u2118-\u211D\u2124\u2126\u2128\u212A-\u2139\u213C-\u213F\u2145-\u2149\u214E\u2160-\u2188\u2C00-\u2CE4\u2CEB-\u2CEE\u2CF2\u2CF3\u2D00-\u2D25\u2D27\u2D2D\u2D30-\u2D67\u2D6F\u2D80-\u2D96\u2DA0-\u2DA6\u2DA8-\u2DAE\u2DB0-\u2DB6\u2DB8-\u2DBE\u2DC0-\u2DC6\u2DC8-\u2DCE\u2DD0-\u2DD6\u2DD8-\u2DDE\u3005-\u3007\u3021-\u3029\u3031-\u3035\u3038-\u303C\u3041-\u3096\u309B-\u309F\u30A1-\u30FA\u30FC-\u30FF\u3105-\u312F\u3131-\u318E\u31A0-\u31BF\u31F0-\u31FF\u3400-\u4DBF\u4E00-\uA48C\uA4D0-\uA4FD\uA500-\uA60C\uA610-\uA61F\uA62A\uA62B\uA640-\uA66E\uA67F-\uA69D\uA6A0-\uA6EF\uA717-\uA71F\uA722-\uA788\uA78B-\uA7DC\uA7F1-\uA801\uA803-\uA805\uA807-\uA80A\uA80C-\uA822\uA840-\uA873\uA882-\uA8B3\uA8F2-\uA8F7\uA8FB\uA8FD\uA8FE\uA90A-\uA925\uA930-\uA946\uA960-\uA97C\uA984-\uA9B2\uA9CF\uA9E0-\uA9E4\uA9E6-\uA9EF\uA9FA-\uA9FE\uAA00-\uAA28\uAA40-\uAA42\uAA44-\uAA4B\uAA60-\uAA76\uAA7A\uAA7E-\uAAAF\uAAB1\uAAB5\uAAB6\uAAB9-\uAABD\uAAC0\uAAC2\uAADB-\uAADD\uAAE0-\uAAEA\uAAF2-\uAAF4\uAB01-\uAB06\uAB09-\uAB0E\uAB11-\uAB16\uAB20-\uAB26\uAB28-\uAB2E\uAB30-\uAB5A\uAB5C-\uAB69\uAB70-\uABE2\uAC00-\uD7A3\uD7B0-\uD7C6\uD7CB-\uD7FB\uF900-\uFA6D\uFA70-\uFAD9\uFB00-\uFB06\uFB13-\uFB17\uFB1D\uFB1F-\uFB28\uFB2A-\uFB36\uFB38-\uFB3C\uFB3E\uFB40\uFB41\uFB43\uFB44\uFB46-\uFBB1\uFBD3-\uFD3D\uFD50-\uFD8F\uFD92-\uFDC7\uFDF0-\uFDFB\uFE70-\uFE74\uFE76-\uFEFC\uFF21-\uFF3A\uFF41-\uFF5A\uFF66-\uFFBE\uFFC2-\uFFC7\uFFCA-\uFFCF\uFFD2-\uFFD7\uFFDA-\uFFDC";
var reservedWords = {
  3: "abstract boolean byte char class double enum export extends final float goto implements import int interface long native package private protected public short static super synchronized throws transient volatile",
  5: "class enum extends super const export import",
  6: "enum",
  strict: "implements interface let package private protected public static yield",
  strictBind: "eval arguments"
};
var ecma5AndLessKeywords = "break case catch continue debugger default do else finally for function if return switch throw try var while with null true false instanceof typeof void delete new in this";
var keywords$1 = {
  5: ecma5AndLessKeywords,
  "5module": ecma5AndLessKeywords + " export import",
  6: ecma5AndLessKeywords + " const class extends export import super"
};
var keywordRelationalOperator = /^in(stanceof)?$/;
var nonASCIIidentifierStart = new RegExp("[" + nonASCIIidentifierStartChars + "]");
var nonASCIIidentifier = new RegExp("[" + nonASCIIidentifierStartChars + nonASCIIidentifierChars + "]");
function isInAstralSet(code, set) {
  var pos = 65536;
  for (var i = 0; i < set.length; i += 2) {
    pos += set[i];
    if (pos > code) {
      return false;
    }
    pos += set[i + 1];
    if (pos >= code) {
      return true;
    }
  }
  return false;
}
function isIdentifierStart(code, astral) {
  if (code < 65) {
    return code === 36;
  }
  if (code < 91) {
    return true;
  }
  if (code < 97) {
    return code === 95;
  }
  if (code < 123) {
    return true;
  }
  if (code <= 65535) {
    return code >= 170 && nonASCIIidentifierStart.test(String.fromCharCode(code));
  }
  if (astral === false) {
    return false;
  }
  return isInAstralSet(code, astralIdentifierStartCodes);
}
function isIdentifierChar(code, astral) {
  if (code < 48) {
    return code === 36;
  }
  if (code < 58) {
    return true;
  }
  if (code < 65) {
    return false;
  }
  if (code < 91) {
    return true;
  }
  if (code < 97) {
    return code === 95;
  }
  if (code < 123) {
    return true;
  }
  if (code <= 65535) {
    return code >= 170 && nonASCIIidentifier.test(String.fromCharCode(code));
  }
  if (astral === false) {
    return false;
  }
  return isInAstralSet(code, astralIdentifierStartCodes) || isInAstralSet(code, astralIdentifierCodes);
}
var TokenType = function TokenType2(label, conf) {
  if (conf === void 0) conf = {};
  this.label = label;
  this.keyword = conf.keyword;
  this.beforeExpr = !!conf.beforeExpr;
  this.startsExpr = !!conf.startsExpr;
  this.isLoop = !!conf.isLoop;
  this.isAssign = !!conf.isAssign;
  this.prefix = !!conf.prefix;
  this.postfix = !!conf.postfix;
  this.binop = conf.binop || null;
  this.updateContext = null;
};
function binop(name, prec) {
  return new TokenType(name, { beforeExpr: true, binop: prec });
}
var beforeExpr = { beforeExpr: true };
var startsExpr = { startsExpr: true };
var keywords = {};
function kw(name, options) {
  if (options === void 0) options = {};
  options.keyword = name;
  return keywords[name] = new TokenType(name, options);
}
var types$1 = {
  num: new TokenType("num", startsExpr),
  regexp: new TokenType("regexp", startsExpr),
  string: new TokenType("string", startsExpr),
  name: new TokenType("name", startsExpr),
  privateId: new TokenType("privateId", startsExpr),
  eof: new TokenType("eof"),
  // Punctuation token types.
  bracketL: new TokenType("[", { beforeExpr: true, startsExpr: true }),
  bracketR: new TokenType("]"),
  braceL: new TokenType("{", { beforeExpr: true, startsExpr: true }),
  braceR: new TokenType("}"),
  parenL: new TokenType("(", { beforeExpr: true, startsExpr: true }),
  parenR: new TokenType(")"),
  comma: new TokenType(",", beforeExpr),
  semi: new TokenType(";", beforeExpr),
  colon: new TokenType(":", beforeExpr),
  dot: new TokenType("."),
  question: new TokenType("?", beforeExpr),
  questionDot: new TokenType("?."),
  arrow: new TokenType("=>", beforeExpr),
  template: new TokenType("template"),
  invalidTemplate: new TokenType("invalidTemplate"),
  ellipsis: new TokenType("...", beforeExpr),
  backQuote: new TokenType("`", startsExpr),
  dollarBraceL: new TokenType("${", { beforeExpr: true, startsExpr: true }),
  // Operators. These carry several kinds of properties to help the
  // parser use them properly (the presence of these properties is
  // what categorizes them as operators).
  //
  // `binop`, when present, specifies that this operator is a binary
  // operator, and will refer to its precedence.
  //
  // `prefix` and `postfix` mark the operator as a prefix or postfix
  // unary operator.
  //
  // `isAssign` marks all of `=`, `+=`, `-=` etcetera, which act as
  // binary operators with a very low precedence, that should result
  // in AssignmentExpression nodes.
  eq: new TokenType("=", { beforeExpr: true, isAssign: true }),
  assign: new TokenType("_=", { beforeExpr: true, isAssign: true }),
  incDec: new TokenType("++/--", { prefix: true, postfix: true, startsExpr: true }),
  prefix: new TokenType("!/~", { beforeExpr: true, prefix: true, startsExpr: true }),
  logicalOR: binop("||", 1),
  logicalAND: binop("&&", 2),
  bitwiseOR: binop("|", 3),
  bitwiseXOR: binop("^", 4),
  bitwiseAND: binop("&", 5),
  equality: binop("==/!=/===/!==", 6),
  relational: binop("</>/<=/>=", 7),
  bitShift: binop("<</>>/>>>", 8),
  plusMin: new TokenType("+/-", { beforeExpr: true, binop: 9, prefix: true, startsExpr: true }),
  modulo: binop("%", 10),
  star: binop("*", 10),
  slash: binop("/", 10),
  starstar: new TokenType("**", { beforeExpr: true }),
  coalesce: binop("??", 1),
  // Keyword token types.
  _break: kw("break"),
  _case: kw("case", beforeExpr),
  _catch: kw("catch"),
  _continue: kw("continue"),
  _debugger: kw("debugger"),
  _default: kw("default", beforeExpr),
  _do: kw("do", { isLoop: true, beforeExpr: true }),
  _else: kw("else", beforeExpr),
  _finally: kw("finally"),
  _for: kw("for", { isLoop: true }),
  _function: kw("function", startsExpr),
  _if: kw("if"),
  _return: kw("return", beforeExpr),
  _switch: kw("switch"),
  _throw: kw("throw", beforeExpr),
  _try: kw("try"),
  _var: kw("var"),
  _const: kw("const"),
  _while: kw("while", { isLoop: true }),
  _with: kw("with"),
  _new: kw("new", { beforeExpr: true, startsExpr: true }),
  _this: kw("this", startsExpr),
  _super: kw("super", startsExpr),
  _class: kw("class", startsExpr),
  _extends: kw("extends", beforeExpr),
  _export: kw("export"),
  _import: kw("import", startsExpr),
  _null: kw("null", startsExpr),
  _true: kw("true", startsExpr),
  _false: kw("false", startsExpr),
  _in: kw("in", { beforeExpr: true, binop: 7 }),
  _instanceof: kw("instanceof", { beforeExpr: true, binop: 7 }),
  _typeof: kw("typeof", { beforeExpr: true, prefix: true, startsExpr: true }),
  _void: kw("void", { beforeExpr: true, prefix: true, startsExpr: true }),
  _delete: kw("delete", { beforeExpr: true, prefix: true, startsExpr: true })
};
var lineBreak = /\r\n?|\n|\u2028|\u2029/;
var lineBreakG = new RegExp(lineBreak.source, "g");
function isNewLine(code) {
  return code === 10 || code === 13 || code === 8232 || code === 8233;
}
function nextLineBreak(code, from, end) {
  if (end === void 0) end = code.length;
  for (var i = from; i < end; i++) {
    var next = code.charCodeAt(i);
    if (isNewLine(next)) {
      return i < end - 1 && next === 13 && code.charCodeAt(i + 1) === 10 ? i + 2 : i + 1;
    }
  }
  return -1;
}
var nonASCIIwhitespace = /[\u1680\u2000-\u200a\u202f\u205f\u3000\ufeff]/;
var skipWhiteSpace = /(?:\s|\/\/.*|\/\*[^]*?\*\/)*/g;
var ref = Object.prototype;
var hasOwnProperty = ref.hasOwnProperty;
var toString = ref.toString;
var hasOwn = Object.hasOwn || (function(obj, propName) {
  return hasOwnProperty.call(obj, propName);
});
var isArray = Array.isArray || (function(obj) {
  return toString.call(obj) === "[object Array]";
});
var regexpCache = /* @__PURE__ */ Object.create(null);
function wordsRegexp(words) {
  return regexpCache[words] || (regexpCache[words] = new RegExp("^(?:" + words.replace(/ /g, "|") + ")$"));
}
function codePointToString(code) {
  if (code <= 65535) {
    return String.fromCharCode(code);
  }
  code -= 65536;
  return String.fromCharCode((code >> 10) + 55296, (code & 1023) + 56320);
}
var loneSurrogate = /(?:[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?:[^\uD800-\uDBFF]|^)[\uDC00-\uDFFF])/;
var Position = function Position2(line2, col) {
  this.line = line2;
  this.column = col;
};
Position.prototype.offset = function offset(n) {
  return new Position(this.line, this.column + n);
};
var SourceLocation = function SourceLocation2(p, start, end) {
  this.start = start;
  this.end = end;
  if (p.sourceFile !== null) {
    this.source = p.sourceFile;
  }
};
function getLineInfo(input, offset2) {
  for (var line2 = 1, cur = 0; ; ) {
    var nextBreak = nextLineBreak(input, cur, offset2);
    if (nextBreak < 0) {
      return new Position(line2, offset2 - cur);
    }
    ++line2;
    cur = nextBreak;
  }
}
var defaultOptions = {
  // `ecmaVersion` indicates the ECMAScript version to parse. Must be
  // either 3, 5, 6 (or 2015), 7 (2016), 8 (2017), 9 (2018), 10
  // (2019), 11 (2020), 12 (2021), 13 (2022), 14 (2023), or `"latest"`
  // (the latest version the library supports). This influences
  // support for strict mode, the set of reserved words, and support
  // for new syntax features.
  ecmaVersion: null,
  // `sourceType` indicates the mode the code should be parsed in.
  // Can be either `"script"`, `"module"` or `"commonjs"`. This influences global
  // strict mode and parsing of `import` and `export` declarations.
  sourceType: "script",
  // `onInsertedSemicolon` can be a callback that will be called when
  // a semicolon is automatically inserted. It will be passed the
  // position of the inserted semicolon as an offset, and if
  // `locations` is enabled, it is given the location as a `{line,
  // column}` object as second argument.
  onInsertedSemicolon: null,
  // `onTrailingComma` is similar to `onInsertedSemicolon`, but for
  // trailing commas.
  onTrailingComma: null,
  // By default, reserved words are only enforced if ecmaVersion >= 5.
  // Set `allowReserved` to a boolean value to explicitly turn this on
  // an off. When this option has the value "never", reserved words
  // and keywords can also not be used as property names.
  allowReserved: null,
  // When enabled, a return at the top level is not considered an
  // error.
  allowReturnOutsideFunction: false,
  // When enabled, import/export statements are not constrained to
  // appearing at the top of the program, and an import.meta expression
  // in a script isn't considered an error.
  allowImportExportEverywhere: false,
  // By default, await identifiers are allowed to appear at the top-level scope only if ecmaVersion >= 2022.
  // When enabled, await identifiers are allowed to appear at the top-level scope,
  // but they are still not allowed in non-async functions.
  allowAwaitOutsideFunction: null,
  // When enabled, super identifiers are not constrained to
  // appearing in methods and do not raise an error when they appear elsewhere.
  allowSuperOutsideMethod: null,
  // When enabled, hashbang directive in the beginning of file is
  // allowed and treated as a line comment. Enabled by default when
  // `ecmaVersion` >= 2023.
  allowHashBang: false,
  // By default, the parser will verify that private properties are
  // only used in places where they are valid and have been declared.
  // Set this to false to turn such checks off.
  checkPrivateFields: true,
  // When `locations` is on, `loc` properties holding objects with
  // `start` and `end` properties in `{line, column}` form (with
  // line being 1-based and column 0-based) will be attached to the
  // nodes.
  locations: false,
  // A function can be passed as `onToken` option, which will
  // cause Acorn to call that function with object in the same
  // format as tokens returned from `tokenizer().getToken()`. Note
  // that you are not allowed to call the parser from the
  // callback—that will corrupt its internal state.
  onToken: null,
  // A function can be passed as `onComment` option, which will
  // cause Acorn to call that function with `(block, text, start,
  // end)` parameters whenever a comment is skipped. `block` is a
  // boolean indicating whether this is a block (`/* */`) comment,
  // `text` is the content of the comment, and `start` and `end` are
  // character offsets that denote the start and end of the comment.
  // When the `locations` option is on, two more parameters are
  // passed, the full `{line, column}` locations of the start and
  // end of the comments. Note that you are not allowed to call the
  // parser from the callback—that will corrupt its internal state.
  // When this option has an array as value, objects representing the
  // comments are pushed to it.
  onComment: null,
  // Nodes have their start and end characters offsets recorded in
  // `start` and `end` properties (directly on the node, rather than
  // the `loc` object, which holds line/column data. To also add a
  // [semi-standardized][range] `range` property holding a `[start,
  // end]` array with the same numbers, set the `ranges` option to
  // `true`.
  //
  // [range]: https://bugzilla.mozilla.org/show_bug.cgi?id=745678
  ranges: false,
  // It is possible to parse multiple files into a single AST by
  // passing the tree produced by parsing the first file as
  // `program` option in subsequent parses. This will add the
  // toplevel forms of the parsed file to the `Program` (top) node
  // of an existing parse tree.
  program: null,
  // When `locations` is on, you can pass this to record the source
  // file in every node's `loc` object.
  sourceFile: null,
  // This value, if given, is stored in every node, whether
  // `locations` is on or off.
  directSourceFile: null,
  // When enabled, parenthesized expressions are represented by
  // (non-standard) ParenthesizedExpression nodes
  preserveParens: false
};
var warnedAboutEcmaVersion = false;
function getOptions(opts) {
  var options = {};
  for (var opt in defaultOptions) {
    options[opt] = opts && hasOwn(opts, opt) ? opts[opt] : defaultOptions[opt];
  }
  if (options.ecmaVersion === "latest") {
    options.ecmaVersion = 1e8;
  } else if (options.ecmaVersion == null) {
    if (!warnedAboutEcmaVersion && typeof console === "object" && console.warn) {
      warnedAboutEcmaVersion = true;
      console.warn("Since Acorn 8.0.0, options.ecmaVersion is required.\nDefaulting to 2020, but this will stop working in the future.");
    }
    options.ecmaVersion = 11;
  } else if (options.ecmaVersion >= 2015) {
    options.ecmaVersion -= 2009;
  }
  if (options.allowReserved == null) {
    options.allowReserved = options.ecmaVersion < 5;
  }
  if (!opts || opts.allowHashBang == null) {
    options.allowHashBang = options.ecmaVersion >= 14;
  }
  if (isArray(options.onToken)) {
    var tokens = options.onToken;
    options.onToken = function(token) {
      return tokens.push(token);
    };
  }
  if (isArray(options.onComment)) {
    options.onComment = pushComment(options, options.onComment);
  }
  if (options.sourceType === "commonjs" && options.allowAwaitOutsideFunction) {
    throw new Error("Cannot use allowAwaitOutsideFunction with sourceType: commonjs");
  }
  return options;
}
function pushComment(options, array) {
  return function(block, text, start, end, startLoc, endLoc) {
    var comment = {
      type: block ? "Block" : "Line",
      value: text,
      start,
      end
    };
    if (options.locations) {
      comment.loc = new SourceLocation(this, startLoc, endLoc);
    }
    if (options.ranges) {
      comment.range = [start, end];
    }
    array.push(comment);
  };
}
var SCOPE_TOP = 1;
var SCOPE_FUNCTION = 2;
var SCOPE_ASYNC = 4;
var SCOPE_GENERATOR = 8;
var SCOPE_ARROW = 16;
var SCOPE_SIMPLE_CATCH = 32;
var SCOPE_SUPER = 64;
var SCOPE_DIRECT_SUPER = 128;
var SCOPE_CLASS_STATIC_BLOCK = 256;
var SCOPE_CLASS_FIELD_INIT = 512;
var SCOPE_SWITCH = 1024;
var SCOPE_VAR = SCOPE_TOP | SCOPE_FUNCTION | SCOPE_CLASS_STATIC_BLOCK;
function functionFlags(async, generator) {
  return SCOPE_FUNCTION | (async ? SCOPE_ASYNC : 0) | (generator ? SCOPE_GENERATOR : 0);
}
var BIND_NONE = 0;
var BIND_VAR = 1;
var BIND_LEXICAL = 2;
var BIND_FUNCTION = 3;
var BIND_SIMPLE_CATCH = 4;
var BIND_OUTSIDE = 5;
var Parser = function Parser2(options, input, startPos) {
  this.options = options = getOptions(options);
  this.sourceFile = options.sourceFile;
  this.keywords = wordsRegexp(keywords$1[options.ecmaVersion >= 6 ? 6 : options.sourceType === "module" ? "5module" : 5]);
  var reserved = "";
  if (options.allowReserved !== true) {
    reserved = reservedWords[options.ecmaVersion >= 6 ? 6 : options.ecmaVersion === 5 ? 5 : 3];
    if (options.sourceType === "module") {
      reserved += " await";
    }
  }
  this.reservedWords = wordsRegexp(reserved);
  var reservedStrict = (reserved ? reserved + " " : "") + reservedWords.strict;
  this.reservedWordsStrict = wordsRegexp(reservedStrict);
  this.reservedWordsStrictBind = wordsRegexp(reservedStrict + " " + reservedWords.strictBind);
  this.input = String(input);
  this.containsEsc = false;
  if (startPos) {
    this.pos = startPos;
    this.lineStart = this.input.lastIndexOf("\n", startPos - 1) + 1;
    this.curLine = this.input.slice(0, this.lineStart).split(lineBreak).length;
  } else {
    this.pos = this.lineStart = 0;
    this.curLine = 1;
  }
  this.type = types$1.eof;
  this.value = null;
  this.start = this.end = this.pos;
  this.startLoc = this.endLoc = this.curPosition();
  this.lastTokEndLoc = this.lastTokStartLoc = null;
  this.lastTokStart = this.lastTokEnd = this.pos;
  this.context = this.initialContext();
  this.exprAllowed = true;
  this.inModule = options.sourceType === "module";
  this.strict = this.inModule || this.strictDirective(this.pos);
  this.potentialArrowAt = -1;
  this.potentialArrowInForAwait = false;
  this.yieldPos = this.awaitPos = this.awaitIdentPos = 0;
  this.labels = [];
  this.undefinedExports = /* @__PURE__ */ Object.create(null);
  if (this.pos === 0 && options.allowHashBang && this.input.slice(0, 2) === "#!") {
    this.skipLineComment(2);
  }
  this.scopeStack = [];
  this.enterScope(
    this.options.sourceType === "commonjs" ? SCOPE_FUNCTION : SCOPE_TOP
  );
  this.regexpState = null;
  this.privateNameStack = [];
};
var prototypeAccessors = { inFunction: { configurable: true }, inGenerator: { configurable: true }, inAsync: { configurable: true }, canAwait: { configurable: true }, allowReturn: { configurable: true }, allowSuper: { configurable: true }, allowDirectSuper: { configurable: true }, treatFunctionsAsVar: { configurable: true }, allowNewDotTarget: { configurable: true }, allowUsing: { configurable: true }, inClassStaticBlock: { configurable: true } };
Parser.prototype.parse = function parse() {
  var node = this.options.program || this.startNode();
  this.nextToken();
  return this.parseTopLevel(node);
};
prototypeAccessors.inFunction.get = function() {
  return (this.currentVarScope().flags & SCOPE_FUNCTION) > 0;
};
prototypeAccessors.inGenerator.get = function() {
  return (this.currentVarScope().flags & SCOPE_GENERATOR) > 0;
};
prototypeAccessors.inAsync.get = function() {
  return (this.currentVarScope().flags & SCOPE_ASYNC) > 0;
};
prototypeAccessors.canAwait.get = function() {
  for (var i = this.scopeStack.length - 1; i >= 0; i--) {
    var ref2 = this.scopeStack[i];
    var flags = ref2.flags;
    if (flags & (SCOPE_CLASS_STATIC_BLOCK | SCOPE_CLASS_FIELD_INIT)) {
      return false;
    }
    if (flags & SCOPE_FUNCTION) {
      return (flags & SCOPE_ASYNC) > 0;
    }
  }
  return this.inModule && this.options.ecmaVersion >= 13 || this.options.allowAwaitOutsideFunction;
};
prototypeAccessors.allowReturn.get = function() {
  if (this.inFunction) {
    return true;
  }
  if (this.options.allowReturnOutsideFunction && this.currentVarScope().flags & SCOPE_TOP) {
    return true;
  }
  return false;
};
prototypeAccessors.allowSuper.get = function() {
  var ref2 = this.currentThisScope();
  var flags = ref2.flags;
  return (flags & SCOPE_SUPER) > 0 || this.options.allowSuperOutsideMethod;
};
prototypeAccessors.allowDirectSuper.get = function() {
  return (this.currentThisScope().flags & SCOPE_DIRECT_SUPER) > 0;
};
prototypeAccessors.treatFunctionsAsVar.get = function() {
  return this.treatFunctionsAsVarInScope(this.currentScope());
};
prototypeAccessors.allowNewDotTarget.get = function() {
  for (var i = this.scopeStack.length - 1; i >= 0; i--) {
    var ref2 = this.scopeStack[i];
    var flags = ref2.flags;
    if (flags & (SCOPE_CLASS_STATIC_BLOCK | SCOPE_CLASS_FIELD_INIT) || flags & SCOPE_FUNCTION && !(flags & SCOPE_ARROW)) {
      return true;
    }
  }
  return false;
};
prototypeAccessors.allowUsing.get = function() {
  var ref2 = this.currentScope();
  var flags = ref2.flags;
  if (flags & SCOPE_SWITCH) {
    return false;
  }
  if (!this.inModule && flags & SCOPE_TOP) {
    return false;
  }
  return true;
};
prototypeAccessors.inClassStaticBlock.get = function() {
  return (this.currentVarScope().flags & SCOPE_CLASS_STATIC_BLOCK) > 0;
};
Parser.extend = function extend() {
  var plugins = [], len = arguments.length;
  while (len--) plugins[len] = arguments[len];
  var cls = this;
  for (var i = 0; i < plugins.length; i++) {
    cls = plugins[i](cls);
  }
  return cls;
};
Parser.parse = function parse2(input, options) {
  return new this(options, input).parse();
};
Parser.parseExpressionAt = function parseExpressionAt(input, pos, options) {
  var parser = new this(options, input, pos);
  parser.nextToken();
  return parser.parseExpression();
};
Parser.tokenizer = function tokenizer(input, options) {
  return new this(options, input);
};
Object.defineProperties(Parser.prototype, prototypeAccessors);
var pp$9 = Parser.prototype;
var literal = /^(?:'((?:\\[^]|[^'\\])*?)'|"((?:\\[^]|[^"\\])*?)")/;
pp$9.strictDirective = function(start) {
  if (this.options.ecmaVersion < 5) {
    return false;
  }
  for (; ; ) {
    skipWhiteSpace.lastIndex = start;
    start += skipWhiteSpace.exec(this.input)[0].length;
    var match = literal.exec(this.input.slice(start));
    if (!match) {
      return false;
    }
    if ((match[1] || match[2]) === "use strict") {
      skipWhiteSpace.lastIndex = start + match[0].length;
      var spaceAfter = skipWhiteSpace.exec(this.input), end = spaceAfter.index + spaceAfter[0].length;
      var next = this.input.charAt(end);
      return next === ";" || next === "}" || lineBreak.test(spaceAfter[0]) && !(/[(`.[+\-/*%<>=,?^&]/.test(next) || next === "!" && this.input.charAt(end + 1) === "=");
    }
    start += match[0].length;
    skipWhiteSpace.lastIndex = start;
    start += skipWhiteSpace.exec(this.input)[0].length;
    if (this.input[start] === ";") {
      start++;
    }
  }
};
pp$9.eat = function(type) {
  if (this.type === type) {
    this.next();
    return true;
  } else {
    return false;
  }
};
pp$9.isContextual = function(name) {
  return this.type === types$1.name && this.value === name && !this.containsEsc;
};
pp$9.eatContextual = function(name) {
  if (!this.isContextual(name)) {
    return false;
  }
  this.next();
  return true;
};
pp$9.expectContextual = function(name) {
  if (!this.eatContextual(name)) {
    this.unexpected();
  }
};
pp$9.canInsertSemicolon = function() {
  return this.type === types$1.eof || this.type === types$1.braceR || lineBreak.test(this.input.slice(this.lastTokEnd, this.start));
};
pp$9.insertSemicolon = function() {
  if (this.canInsertSemicolon()) {
    if (this.options.onInsertedSemicolon) {
      this.options.onInsertedSemicolon(this.lastTokEnd, this.lastTokEndLoc);
    }
    return true;
  }
};
pp$9.semicolon = function() {
  if (!this.eat(types$1.semi) && !this.insertSemicolon()) {
    this.unexpected();
  }
};
pp$9.afterTrailingComma = function(tokType, notNext) {
  if (this.type === tokType) {
    if (this.options.onTrailingComma) {
      this.options.onTrailingComma(this.lastTokStart, this.lastTokStartLoc);
    }
    if (!notNext) {
      this.next();
    }
    return true;
  }
};
pp$9.expect = function(type) {
  this.eat(type) || this.unexpected();
};
pp$9.unexpected = function(pos) {
  this.raise(pos != null ? pos : this.start, "Unexpected token");
};
var DestructuringErrors = function DestructuringErrors2() {
  this.shorthandAssign = this.trailingComma = this.parenthesizedAssign = this.parenthesizedBind = this.doubleProto = -1;
};
pp$9.checkPatternErrors = function(refDestructuringErrors, isAssign) {
  if (!refDestructuringErrors) {
    return;
  }
  if (refDestructuringErrors.trailingComma > -1) {
    this.raiseRecoverable(refDestructuringErrors.trailingComma, "Comma is not permitted after the rest element");
  }
  var parens = isAssign ? refDestructuringErrors.parenthesizedAssign : refDestructuringErrors.parenthesizedBind;
  if (parens > -1) {
    this.raiseRecoverable(parens, isAssign ? "Assigning to rvalue" : "Parenthesized pattern");
  }
};
pp$9.checkExpressionErrors = function(refDestructuringErrors, andThrow) {
  if (!refDestructuringErrors) {
    return false;
  }
  var shorthandAssign = refDestructuringErrors.shorthandAssign;
  var doubleProto = refDestructuringErrors.doubleProto;
  if (!andThrow) {
    return shorthandAssign >= 0 || doubleProto >= 0;
  }
  if (shorthandAssign >= 0) {
    this.raise(shorthandAssign, "Shorthand property assignments are valid only in destructuring patterns");
  }
  if (doubleProto >= 0) {
    this.raiseRecoverable(doubleProto, "Redefinition of __proto__ property");
  }
};
pp$9.checkYieldAwaitInDefaultParams = function() {
  if (this.yieldPos && (!this.awaitPos || this.yieldPos < this.awaitPos)) {
    this.raise(this.yieldPos, "Yield expression cannot be a default value");
  }
  if (this.awaitPos) {
    this.raise(this.awaitPos, "Await expression cannot be a default value");
  }
};
pp$9.isSimpleAssignTarget = function(expr) {
  if (expr.type === "ParenthesizedExpression") {
    return this.isSimpleAssignTarget(expr.expression);
  }
  return expr.type === "Identifier" || expr.type === "MemberExpression";
};
var pp$8 = Parser.prototype;
pp$8.parseTopLevel = function(node) {
  var exports2 = /* @__PURE__ */ Object.create(null);
  if (!node.body) {
    node.body = [];
  }
  while (this.type !== types$1.eof) {
    var stmt = this.parseStatement(null, true, exports2);
    node.body.push(stmt);
  }
  if (this.inModule) {
    for (var i = 0, list = Object.keys(this.undefinedExports); i < list.length; i += 1) {
      var name = list[i];
      this.raiseRecoverable(this.undefinedExports[name].start, "Export '" + name + "' is not defined");
    }
  }
  this.adaptDirectivePrologue(node.body);
  this.next();
  node.sourceType = this.options.sourceType === "commonjs" ? "script" : this.options.sourceType;
  return this.finishNode(node, "Program");
};
var loopLabel = { kind: "loop" };
var switchLabel = { kind: "switch" };
pp$8.isLet = function(context) {
  if (this.options.ecmaVersion < 6 || !this.isContextual("let")) {
    return false;
  }
  skipWhiteSpace.lastIndex = this.pos;
  var skip2 = skipWhiteSpace.exec(this.input);
  var next = this.pos + skip2[0].length, nextCh = this.fullCharCodeAt(next);
  if (nextCh === 91 || nextCh === 92) {
    return true;
  }
  if (context) {
    return false;
  }
  if (nextCh === 123) {
    return true;
  }
  if (isIdentifierStart(nextCh)) {
    var start = next;
    do {
      next += nextCh <= 65535 ? 1 : 2;
    } while (isIdentifierChar(nextCh = this.fullCharCodeAt(next)));
    if (nextCh === 92) {
      return true;
    }
    var ident = this.input.slice(start, next);
    if (!keywordRelationalOperator.test(ident)) {
      return true;
    }
  }
  return false;
};
pp$8.isAsyncFunction = function() {
  if (this.options.ecmaVersion < 8 || !this.isContextual("async")) {
    return false;
  }
  skipWhiteSpace.lastIndex = this.pos;
  var skip2 = skipWhiteSpace.exec(this.input);
  var next = this.pos + skip2[0].length, after;
  return !lineBreak.test(this.input.slice(this.pos, next)) && this.input.slice(next, next + 8) === "function" && (next + 8 === this.input.length || !(isIdentifierChar(after = this.fullCharCodeAt(next + 8)) || after === 92));
};
pp$8.isUsingKeyword = function(isAwaitUsing, isFor) {
  if (this.options.ecmaVersion < 17 || !this.isContextual(isAwaitUsing ? "await" : "using")) {
    return false;
  }
  skipWhiteSpace.lastIndex = this.pos;
  var skip2 = skipWhiteSpace.exec(this.input);
  var next = this.pos + skip2[0].length;
  if (lineBreak.test(this.input.slice(this.pos, next))) {
    return false;
  }
  if (isAwaitUsing) {
    var usingEndPos = next + 5, after;
    if (this.input.slice(next, usingEndPos) !== "using" || usingEndPos === this.input.length || isIdentifierChar(after = this.fullCharCodeAt(usingEndPos)) || after === 92) {
      return false;
    }
    skipWhiteSpace.lastIndex = usingEndPos;
    var skipAfterUsing = skipWhiteSpace.exec(this.input);
    next = usingEndPos + skipAfterUsing[0].length;
    if (skipAfterUsing && lineBreak.test(this.input.slice(usingEndPos, next))) {
      return false;
    }
  }
  var ch = this.fullCharCodeAt(next);
  if (!isIdentifierStart(ch) && ch !== 92) {
    return false;
  }
  var idStart = next;
  do {
    next += ch <= 65535 ? 1 : 2;
  } while (isIdentifierChar(ch = this.fullCharCodeAt(next)));
  if (ch === 92) {
    return true;
  }
  var id = this.input.slice(idStart, next);
  if (keywordRelationalOperator.test(id) || isFor && id === "of") {
    return false;
  }
  return true;
};
pp$8.isAwaitUsing = function(isFor) {
  return this.isUsingKeyword(true, isFor);
};
pp$8.isUsing = function(isFor) {
  return this.isUsingKeyword(false, isFor);
};
pp$8.parseStatement = function(context, topLevel, exports2) {
  var starttype = this.type, node = this.startNode(), kind;
  if (this.isLet(context)) {
    starttype = types$1._var;
    kind = "let";
  }
  switch (starttype) {
    case types$1._break:
    case types$1._continue:
      return this.parseBreakContinueStatement(node, starttype.keyword);
    case types$1._debugger:
      return this.parseDebuggerStatement(node);
    case types$1._do:
      return this.parseDoStatement(node);
    case types$1._for:
      return this.parseForStatement(node);
    case types$1._function:
      if (context && (this.strict || context !== "if" && context !== "label") && this.options.ecmaVersion >= 6) {
        this.unexpected();
      }
      return this.parseFunctionStatement(node, false, !context);
    case types$1._class:
      if (context) {
        this.unexpected();
      }
      return this.parseClass(node, true);
    case types$1._if:
      return this.parseIfStatement(node);
    case types$1._return:
      return this.parseReturnStatement(node);
    case types$1._switch:
      return this.parseSwitchStatement(node);
    case types$1._throw:
      return this.parseThrowStatement(node);
    case types$1._try:
      return this.parseTryStatement(node);
    case types$1._const:
    case types$1._var:
      kind = kind || this.value;
      if (context && kind !== "var") {
        this.unexpected();
      }
      return this.parseVarStatement(node, kind);
    case types$1._while:
      return this.parseWhileStatement(node);
    case types$1._with:
      return this.parseWithStatement(node);
    case types$1.braceL:
      return this.parseBlock(true, node);
    case types$1.semi:
      return this.parseEmptyStatement(node);
    case types$1._export:
    case types$1._import:
      if (this.options.ecmaVersion > 10 && starttype === types$1._import) {
        skipWhiteSpace.lastIndex = this.pos;
        var skip2 = skipWhiteSpace.exec(this.input);
        var next = this.pos + skip2[0].length, nextCh = this.input.charCodeAt(next);
        if (nextCh === 40 || nextCh === 46) {
          return this.parseExpressionStatement(node, this.parseExpression());
        }
      }
      if (!this.options.allowImportExportEverywhere) {
        if (!topLevel) {
          this.raise(this.start, "'import' and 'export' may only appear at the top level");
        }
        if (!this.inModule) {
          this.raise(this.start, "'import' and 'export' may appear only with 'sourceType: module'");
        }
      }
      return starttype === types$1._import ? this.parseImport(node) : this.parseExport(node, exports2);
    // If the statement does not start with a statement keyword or a
    // brace, it's an ExpressionStatement or LabeledStatement. We
    // simply start parsing an expression, and afterwards, if the
    // next token is a colon and the expression was a simple
    // Identifier node, we switch to interpreting it as a label.
    default:
      if (this.isAsyncFunction()) {
        if (context) {
          this.unexpected();
        }
        this.next();
        return this.parseFunctionStatement(node, true, !context);
      }
      var usingKind = this.isAwaitUsing(false) ? "await using" : this.isUsing(false) ? "using" : null;
      if (usingKind) {
        if (!this.allowUsing) {
          this.raise(this.start, "Using declaration cannot appear in the top level when source type is `script` or in the bare case statement");
        }
        if (usingKind === "await using") {
          if (!this.canAwait) {
            this.raise(this.start, "Await using cannot appear outside of async function");
          }
          this.next();
        }
        this.next();
        this.parseVar(node, false, usingKind);
        this.semicolon();
        return this.finishNode(node, "VariableDeclaration");
      }
      var maybeName = this.value, expr = this.parseExpression();
      if (starttype === types$1.name && expr.type === "Identifier" && this.eat(types$1.colon)) {
        return this.parseLabeledStatement(node, maybeName, expr, context);
      } else {
        return this.parseExpressionStatement(node, expr);
      }
  }
};
pp$8.parseBreakContinueStatement = function(node, keyword) {
  var isBreak = keyword === "break";
  this.next();
  if (this.eat(types$1.semi) || this.insertSemicolon()) {
    node.label = null;
  } else if (this.type !== types$1.name) {
    this.unexpected();
  } else {
    node.label = this.parseIdent();
    this.semicolon();
  }
  var i = 0;
  for (; i < this.labels.length; ++i) {
    var lab = this.labels[i];
    if (node.label == null || lab.name === node.label.name) {
      if (lab.kind != null && (isBreak || lab.kind === "loop")) {
        break;
      }
      if (node.label && isBreak) {
        break;
      }
    }
  }
  if (i === this.labels.length) {
    this.raise(node.start, "Unsyntactic " + keyword);
  }
  return this.finishNode(node, isBreak ? "BreakStatement" : "ContinueStatement");
};
pp$8.parseDebuggerStatement = function(node) {
  this.next();
  this.semicolon();
  return this.finishNode(node, "DebuggerStatement");
};
pp$8.parseDoStatement = function(node) {
  this.next();
  this.labels.push(loopLabel);
  node.body = this.parseStatement("do");
  this.labels.pop();
  this.expect(types$1._while);
  node.test = this.parseParenExpression();
  if (this.options.ecmaVersion >= 6) {
    this.eat(types$1.semi);
  } else {
    this.semicolon();
  }
  return this.finishNode(node, "DoWhileStatement");
};
pp$8.parseForStatement = function(node) {
  this.next();
  var awaitAt = this.options.ecmaVersion >= 9 && this.canAwait && this.eatContextual("await") ? this.lastTokStart : -1;
  this.labels.push(loopLabel);
  this.enterScope(0);
  this.expect(types$1.parenL);
  if (this.type === types$1.semi) {
    if (awaitAt > -1) {
      this.unexpected(awaitAt);
    }
    return this.parseFor(node, null);
  }
  var isLet = this.isLet();
  if (this.type === types$1._var || this.type === types$1._const || isLet) {
    var init$1 = this.startNode(), kind = isLet ? "let" : this.value;
    this.next();
    this.parseVar(init$1, true, kind);
    this.finishNode(init$1, "VariableDeclaration");
    return this.parseForAfterInit(node, init$1, awaitAt);
  }
  var startsWithLet = this.isContextual("let"), isForOf = false;
  var usingKind = this.isUsing(true) ? "using" : this.isAwaitUsing(true) ? "await using" : null;
  if (usingKind) {
    var init$2 = this.startNode();
    this.next();
    if (usingKind === "await using") {
      if (!this.canAwait) {
        this.raise(this.start, "Await using cannot appear outside of async function");
      }
      this.next();
    }
    this.parseVar(init$2, true, usingKind);
    this.finishNode(init$2, "VariableDeclaration");
    return this.parseForAfterInit(node, init$2, awaitAt);
  }
  var containsEsc = this.containsEsc;
  var refDestructuringErrors = new DestructuringErrors();
  var initPos = this.start;
  var init = awaitAt > -1 ? this.parseExprSubscripts(refDestructuringErrors, "await") : this.parseExpression(true, refDestructuringErrors);
  if (this.type === types$1._in || (isForOf = this.options.ecmaVersion >= 6 && this.isContextual("of"))) {
    if (awaitAt > -1) {
      if (this.type === types$1._in) {
        this.unexpected(awaitAt);
      }
      node.await = true;
    } else if (isForOf && this.options.ecmaVersion >= 8) {
      if (init.start === initPos && !containsEsc && init.type === "Identifier" && init.name === "async") {
        this.unexpected();
      } else if (this.options.ecmaVersion >= 9) {
        node.await = false;
      }
    }
    if (startsWithLet && isForOf) {
      this.raise(init.start, "The left-hand side of a for-of loop may not start with 'let'.");
    }
    this.toAssignable(init, false, refDestructuringErrors);
    this.checkLValPattern(init);
    return this.parseForIn(node, init);
  } else {
    this.checkExpressionErrors(refDestructuringErrors, true);
  }
  if (awaitAt > -1) {
    this.unexpected(awaitAt);
  }
  return this.parseFor(node, init);
};
pp$8.parseForAfterInit = function(node, init, awaitAt) {
  if ((this.type === types$1._in || this.options.ecmaVersion >= 6 && this.isContextual("of")) && init.declarations.length === 1) {
    if (this.options.ecmaVersion >= 9) {
      if (this.type === types$1._in) {
        if (awaitAt > -1) {
          this.unexpected(awaitAt);
        }
      } else {
        node.await = awaitAt > -1;
      }
    }
    return this.parseForIn(node, init);
  }
  if (awaitAt > -1) {
    this.unexpected(awaitAt);
  }
  return this.parseFor(node, init);
};
pp$8.parseFunctionStatement = function(node, isAsync, declarationPosition) {
  this.next();
  return this.parseFunction(node, FUNC_STATEMENT | (declarationPosition ? 0 : FUNC_HANGING_STATEMENT), false, isAsync);
};
pp$8.parseIfStatement = function(node) {
  this.next();
  node.test = this.parseParenExpression();
  node.consequent = this.parseStatement("if");
  node.alternate = this.eat(types$1._else) ? this.parseStatement("if") : null;
  return this.finishNode(node, "IfStatement");
};
pp$8.parseReturnStatement = function(node) {
  if (!this.allowReturn) {
    this.raise(this.start, "'return' outside of function");
  }
  this.next();
  if (this.eat(types$1.semi) || this.insertSemicolon()) {
    node.argument = null;
  } else {
    node.argument = this.parseExpression();
    this.semicolon();
  }
  return this.finishNode(node, "ReturnStatement");
};
pp$8.parseSwitchStatement = function(node) {
  this.next();
  node.discriminant = this.parseParenExpression();
  node.cases = [];
  this.expect(types$1.braceL);
  this.labels.push(switchLabel);
  this.enterScope(SCOPE_SWITCH);
  var cur;
  for (var sawDefault = false; this.type !== types$1.braceR; ) {
    if (this.type === types$1._case || this.type === types$1._default) {
      var isCase = this.type === types$1._case;
      if (cur) {
        this.finishNode(cur, "SwitchCase");
      }
      node.cases.push(cur = this.startNode());
      cur.consequent = [];
      this.next();
      if (isCase) {
        cur.test = this.parseExpression();
      } else {
        if (sawDefault) {
          this.raiseRecoverable(this.lastTokStart, "Multiple default clauses");
        }
        sawDefault = true;
        cur.test = null;
      }
      this.expect(types$1.colon);
    } else {
      if (!cur) {
        this.unexpected();
      }
      cur.consequent.push(this.parseStatement(null));
    }
  }
  this.exitScope();
  if (cur) {
    this.finishNode(cur, "SwitchCase");
  }
  this.next();
  this.labels.pop();
  return this.finishNode(node, "SwitchStatement");
};
pp$8.parseThrowStatement = function(node) {
  this.next();
  if (lineBreak.test(this.input.slice(this.lastTokEnd, this.start))) {
    this.raise(this.lastTokEnd, "Illegal newline after throw");
  }
  node.argument = this.parseExpression();
  this.semicolon();
  return this.finishNode(node, "ThrowStatement");
};
var empty$1 = [];
pp$8.parseCatchClauseParam = function() {
  var param = this.parseBindingAtom();
  var simple2 = param.type === "Identifier";
  this.enterScope(simple2 ? SCOPE_SIMPLE_CATCH : 0);
  this.checkLValPattern(param, simple2 ? BIND_SIMPLE_CATCH : BIND_LEXICAL);
  this.expect(types$1.parenR);
  return param;
};
pp$8.parseTryStatement = function(node) {
  this.next();
  node.block = this.parseBlock();
  node.handler = null;
  if (this.type === types$1._catch) {
    var clause = this.startNode();
    this.next();
    if (this.eat(types$1.parenL)) {
      clause.param = this.parseCatchClauseParam();
    } else {
      if (this.options.ecmaVersion < 10) {
        this.unexpected();
      }
      clause.param = null;
      this.enterScope(0);
    }
    clause.body = this.parseBlock(false);
    this.exitScope();
    node.handler = this.finishNode(clause, "CatchClause");
  }
  node.finalizer = this.eat(types$1._finally) ? this.parseBlock() : null;
  if (!node.handler && !node.finalizer) {
    this.raise(node.start, "Missing catch or finally clause");
  }
  return this.finishNode(node, "TryStatement");
};
pp$8.parseVarStatement = function(node, kind, allowMissingInitializer) {
  this.next();
  this.parseVar(node, false, kind, allowMissingInitializer);
  this.semicolon();
  return this.finishNode(node, "VariableDeclaration");
};
pp$8.parseWhileStatement = function(node) {
  this.next();
  node.test = this.parseParenExpression();
  this.labels.push(loopLabel);
  node.body = this.parseStatement("while");
  this.labels.pop();
  return this.finishNode(node, "WhileStatement");
};
pp$8.parseWithStatement = function(node) {
  if (this.strict) {
    this.raise(this.start, "'with' in strict mode");
  }
  this.next();
  node.object = this.parseParenExpression();
  node.body = this.parseStatement("with");
  return this.finishNode(node, "WithStatement");
};
pp$8.parseEmptyStatement = function(node) {
  this.next();
  return this.finishNode(node, "EmptyStatement");
};
pp$8.parseLabeledStatement = function(node, maybeName, expr, context) {
  for (var i$1 = 0, list = this.labels; i$1 < list.length; i$1 += 1) {
    var label = list[i$1];
    if (label.name === maybeName) {
      this.raise(expr.start, "Label '" + maybeName + "' is already declared");
    }
  }
  var kind = this.type.isLoop ? "loop" : this.type === types$1._switch ? "switch" : null;
  for (var i = this.labels.length - 1; i >= 0; i--) {
    var label$1 = this.labels[i];
    if (label$1.statementStart === node.start) {
      label$1.statementStart = this.start;
      label$1.kind = kind;
    } else {
      break;
    }
  }
  this.labels.push({ name: maybeName, kind, statementStart: this.start });
  node.body = this.parseStatement(context ? context.indexOf("label") === -1 ? context + "label" : context : "label");
  this.labels.pop();
  node.label = expr;
  return this.finishNode(node, "LabeledStatement");
};
pp$8.parseExpressionStatement = function(node, expr) {
  node.expression = expr;
  this.semicolon();
  return this.finishNode(node, "ExpressionStatement");
};
pp$8.parseBlock = function(createNewLexicalScope, node, exitStrict) {
  if (createNewLexicalScope === void 0) createNewLexicalScope = true;
  if (node === void 0) node = this.startNode();
  node.body = [];
  this.expect(types$1.braceL);
  if (createNewLexicalScope) {
    this.enterScope(0);
  }
  while (this.type !== types$1.braceR) {
    var stmt = this.parseStatement(null);
    node.body.push(stmt);
  }
  if (exitStrict) {
    this.strict = false;
  }
  this.next();
  if (createNewLexicalScope) {
    this.exitScope();
  }
  return this.finishNode(node, "BlockStatement");
};
pp$8.parseFor = function(node, init) {
  node.init = init;
  this.expect(types$1.semi);
  node.test = this.type === types$1.semi ? null : this.parseExpression();
  this.expect(types$1.semi);
  node.update = this.type === types$1.parenR ? null : this.parseExpression();
  this.expect(types$1.parenR);
  node.body = this.parseStatement("for");
  this.exitScope();
  this.labels.pop();
  return this.finishNode(node, "ForStatement");
};
pp$8.parseForIn = function(node, init) {
  var isForIn = this.type === types$1._in;
  this.next();
  if (init.type === "VariableDeclaration" && init.declarations[0].init != null && (!isForIn || this.options.ecmaVersion < 8 || this.strict || init.kind !== "var" || init.declarations[0].id.type !== "Identifier")) {
    this.raise(
      init.start,
      (isForIn ? "for-in" : "for-of") + " loop variable declaration may not have an initializer"
    );
  }
  node.left = init;
  node.right = isForIn ? this.parseExpression() : this.parseMaybeAssign();
  this.expect(types$1.parenR);
  node.body = this.parseStatement("for");
  this.exitScope();
  this.labels.pop();
  return this.finishNode(node, isForIn ? "ForInStatement" : "ForOfStatement");
};
pp$8.parseVar = function(node, isFor, kind, allowMissingInitializer) {
  node.declarations = [];
  node.kind = kind;
  for (; ; ) {
    var decl = this.startNode();
    this.parseVarId(decl, kind);
    if (this.eat(types$1.eq)) {
      decl.init = this.parseMaybeAssign(isFor);
    } else if (!allowMissingInitializer && kind === "const" && !(this.type === types$1._in || this.options.ecmaVersion >= 6 && this.isContextual("of"))) {
      this.unexpected();
    } else if (!allowMissingInitializer && (kind === "using" || kind === "await using") && this.options.ecmaVersion >= 17 && this.type !== types$1._in && !this.isContextual("of")) {
      this.raise(this.lastTokEnd, "Missing initializer in " + kind + " declaration");
    } else if (!allowMissingInitializer && decl.id.type !== "Identifier" && !(isFor && (this.type === types$1._in || this.isContextual("of")))) {
      this.raise(this.lastTokEnd, "Complex binding patterns require an initialization value");
    } else {
      decl.init = null;
    }
    node.declarations.push(this.finishNode(decl, "VariableDeclarator"));
    if (!this.eat(types$1.comma)) {
      break;
    }
  }
  return node;
};
pp$8.parseVarId = function(decl, kind) {
  decl.id = kind === "using" || kind === "await using" ? this.parseIdent() : this.parseBindingAtom();
  this.checkLValPattern(decl.id, kind === "var" ? BIND_VAR : BIND_LEXICAL, false);
};
var FUNC_STATEMENT = 1;
var FUNC_HANGING_STATEMENT = 2;
var FUNC_NULLABLE_ID = 4;
pp$8.parseFunction = function(node, statement, allowExpressionBody, isAsync, forInit) {
  this.initFunction(node);
  if (this.options.ecmaVersion >= 9 || this.options.ecmaVersion >= 6 && !isAsync) {
    if (this.type === types$1.star && statement & FUNC_HANGING_STATEMENT) {
      this.unexpected();
    }
    node.generator = this.eat(types$1.star);
  }
  if (this.options.ecmaVersion >= 8) {
    node.async = !!isAsync;
  }
  if (statement & FUNC_STATEMENT) {
    node.id = statement & FUNC_NULLABLE_ID && this.type !== types$1.name ? null : this.parseIdent();
    if (node.id && !(statement & FUNC_HANGING_STATEMENT)) {
      this.checkLValSimple(node.id, this.strict || node.generator || node.async ? this.treatFunctionsAsVar ? BIND_VAR : BIND_LEXICAL : BIND_FUNCTION);
    }
  }
  var oldYieldPos = this.yieldPos, oldAwaitPos = this.awaitPos, oldAwaitIdentPos = this.awaitIdentPos;
  this.yieldPos = 0;
  this.awaitPos = 0;
  this.awaitIdentPos = 0;
  this.enterScope(functionFlags(node.async, node.generator));
  if (!(statement & FUNC_STATEMENT)) {
    node.id = this.type === types$1.name ? this.parseIdent() : null;
  }
  this.parseFunctionParams(node);
  this.parseFunctionBody(node, allowExpressionBody, false, forInit);
  this.yieldPos = oldYieldPos;
  this.awaitPos = oldAwaitPos;
  this.awaitIdentPos = oldAwaitIdentPos;
  return this.finishNode(node, statement & FUNC_STATEMENT ? "FunctionDeclaration" : "FunctionExpression");
};
pp$8.parseFunctionParams = function(node) {
  this.expect(types$1.parenL);
  node.params = this.parseBindingList(types$1.parenR, false, this.options.ecmaVersion >= 8);
  this.checkYieldAwaitInDefaultParams();
};
pp$8.parseClass = function(node, isStatement) {
  this.next();
  var oldStrict = this.strict;
  this.strict = true;
  this.parseClassId(node, isStatement);
  this.parseClassSuper(node);
  var privateNameMap = this.enterClassBody();
  var classBody = this.startNode();
  var hadConstructor = false;
  classBody.body = [];
  this.expect(types$1.braceL);
  while (this.type !== types$1.braceR) {
    var element = this.parseClassElement(node.superClass !== null);
    if (element) {
      classBody.body.push(element);
      if (element.type === "MethodDefinition" && element.kind === "constructor") {
        if (hadConstructor) {
          this.raiseRecoverable(element.start, "Duplicate constructor in the same class");
        }
        hadConstructor = true;
      } else if (element.key && element.key.type === "PrivateIdentifier" && isPrivateNameConflicted(privateNameMap, element)) {
        this.raiseRecoverable(element.key.start, "Identifier '#" + element.key.name + "' has already been declared");
      }
    }
  }
  this.strict = oldStrict;
  this.next();
  node.body = this.finishNode(classBody, "ClassBody");
  this.exitClassBody();
  return this.finishNode(node, isStatement ? "ClassDeclaration" : "ClassExpression");
};
pp$8.parseClassElement = function(constructorAllowsSuper) {
  if (this.eat(types$1.semi)) {
    return null;
  }
  var ecmaVersion = this.options.ecmaVersion;
  var node = this.startNode();
  var keyName = "";
  var isGenerator = false;
  var isAsync = false;
  var kind = "method";
  var isStatic = false;
  if (this.eatContextual("static")) {
    if (ecmaVersion >= 13 && this.eat(types$1.braceL)) {
      this.parseClassStaticBlock(node);
      return node;
    }
    if (this.isClassElementNameStart() || this.type === types$1.star) {
      isStatic = true;
    } else {
      keyName = "static";
    }
  }
  node.static = isStatic;
  if (!keyName && ecmaVersion >= 8 && this.eatContextual("async")) {
    if ((this.isClassElementNameStart() || this.type === types$1.star) && !this.canInsertSemicolon()) {
      isAsync = true;
    } else {
      keyName = "async";
    }
  }
  if (!keyName && (ecmaVersion >= 9 || !isAsync) && this.eat(types$1.star)) {
    isGenerator = true;
  }
  if (!keyName && !isAsync && !isGenerator) {
    var lastValue = this.value;
    if (this.eatContextual("get") || this.eatContextual("set")) {
      if (this.isClassElementNameStart()) {
        kind = lastValue;
      } else {
        keyName = lastValue;
      }
    }
  }
  if (keyName) {
    node.computed = false;
    node.key = this.startNodeAt(this.lastTokStart, this.lastTokStartLoc);
    node.key.name = keyName;
    this.finishNode(node.key, "Identifier");
  } else {
    this.parseClassElementName(node);
  }
  if (ecmaVersion < 13 || this.type === types$1.parenL || kind !== "method" || isGenerator || isAsync) {
    var isConstructor = !node.static && checkKeyName(node, "constructor");
    var allowsDirectSuper = isConstructor && constructorAllowsSuper;
    if (isConstructor && kind !== "method") {
      this.raise(node.key.start, "Constructor can't have get/set modifier");
    }
    node.kind = isConstructor ? "constructor" : kind;
    this.parseClassMethod(node, isGenerator, isAsync, allowsDirectSuper);
  } else {
    this.parseClassField(node);
  }
  return node;
};
pp$8.isClassElementNameStart = function() {
  return this.type === types$1.name || this.type === types$1.privateId || this.type === types$1.num || this.type === types$1.string || this.type === types$1.bracketL || this.type.keyword;
};
pp$8.parseClassElementName = function(element) {
  if (this.type === types$1.privateId) {
    if (this.value === "constructor") {
      this.raise(this.start, "Classes can't have an element named '#constructor'");
    }
    element.computed = false;
    element.key = this.parsePrivateIdent();
  } else {
    this.parsePropertyName(element);
  }
};
pp$8.parseClassMethod = function(method, isGenerator, isAsync, allowsDirectSuper) {
  var key = method.key;
  if (method.kind === "constructor") {
    if (isGenerator) {
      this.raise(key.start, "Constructor can't be a generator");
    }
    if (isAsync) {
      this.raise(key.start, "Constructor can't be an async method");
    }
  } else if (method.static && checkKeyName(method, "prototype")) {
    this.raise(key.start, "Classes may not have a static property named prototype");
  }
  var value = method.value = this.parseMethod(isGenerator, isAsync, allowsDirectSuper);
  if (method.kind === "get" && value.params.length !== 0) {
    this.raiseRecoverable(value.start, "getter should have no params");
  }
  if (method.kind === "set" && value.params.length !== 1) {
    this.raiseRecoverable(value.start, "setter should have exactly one param");
  }
  if (method.kind === "set" && value.params[0].type === "RestElement") {
    this.raiseRecoverable(value.params[0].start, "Setter cannot use rest params");
  }
  return this.finishNode(method, "MethodDefinition");
};
pp$8.parseClassField = function(field) {
  if (checkKeyName(field, "constructor")) {
    this.raise(field.key.start, "Classes can't have a field named 'constructor'");
  } else if (field.static && checkKeyName(field, "prototype")) {
    this.raise(field.key.start, "Classes can't have a static field named 'prototype'");
  }
  if (this.eat(types$1.eq)) {
    this.enterScope(SCOPE_CLASS_FIELD_INIT | SCOPE_SUPER);
    field.value = this.parseMaybeAssign();
    this.exitScope();
  } else {
    field.value = null;
  }
  this.semicolon();
  return this.finishNode(field, "PropertyDefinition");
};
pp$8.parseClassStaticBlock = function(node) {
  node.body = [];
  var oldLabels = this.labels;
  this.labels = [];
  this.enterScope(SCOPE_CLASS_STATIC_BLOCK | SCOPE_SUPER);
  while (this.type !== types$1.braceR) {
    var stmt = this.parseStatement(null);
    node.body.push(stmt);
  }
  this.next();
  this.exitScope();
  this.labels = oldLabels;
  return this.finishNode(node, "StaticBlock");
};
pp$8.parseClassId = function(node, isStatement) {
  if (this.type === types$1.name) {
    node.id = this.parseIdent();
    if (isStatement) {
      this.checkLValSimple(node.id, BIND_LEXICAL, false);
    }
  } else {
    if (isStatement === true) {
      this.unexpected();
    }
    node.id = null;
  }
};
pp$8.parseClassSuper = function(node) {
  node.superClass = this.eat(types$1._extends) ? this.parseExprSubscripts(null, false) : null;
};
pp$8.enterClassBody = function() {
  var element = { declared: /* @__PURE__ */ Object.create(null), used: [] };
  this.privateNameStack.push(element);
  return element.declared;
};
pp$8.exitClassBody = function() {
  var ref2 = this.privateNameStack.pop();
  var declared = ref2.declared;
  var used = ref2.used;
  if (!this.options.checkPrivateFields) {
    return;
  }
  var len = this.privateNameStack.length;
  var parent = len === 0 ? null : this.privateNameStack[len - 1];
  for (var i = 0; i < used.length; ++i) {
    var id = used[i];
    if (!hasOwn(declared, id.name)) {
      if (parent) {
        parent.used.push(id);
      } else {
        this.raiseRecoverable(id.start, "Private field '#" + id.name + "' must be declared in an enclosing class");
      }
    }
  }
};
function isPrivateNameConflicted(privateNameMap, element) {
  var name = element.key.name;
  var curr = privateNameMap[name];
  var next = "true";
  if (element.type === "MethodDefinition" && (element.kind === "get" || element.kind === "set")) {
    next = (element.static ? "s" : "i") + element.kind;
  }
  if (curr === "iget" && next === "iset" || curr === "iset" && next === "iget" || curr === "sget" && next === "sset" || curr === "sset" && next === "sget") {
    privateNameMap[name] = "true";
    return false;
  } else if (!curr) {
    privateNameMap[name] = next;
    return false;
  } else {
    return true;
  }
}
function checkKeyName(node, name) {
  var computed = node.computed;
  var key = node.key;
  return !computed && (key.type === "Identifier" && key.name === name || key.type === "Literal" && key.value === name);
}
pp$8.parseExportAllDeclaration = function(node, exports2) {
  if (this.options.ecmaVersion >= 11) {
    if (this.eatContextual("as")) {
      node.exported = this.parseModuleExportName();
      this.checkExport(exports2, node.exported, this.lastTokStart);
    } else {
      node.exported = null;
    }
  }
  this.expectContextual("from");
  if (this.type !== types$1.string) {
    this.unexpected();
  }
  node.source = this.parseExprAtom();
  if (this.options.ecmaVersion >= 16) {
    node.attributes = this.parseWithClause();
  }
  this.semicolon();
  return this.finishNode(node, "ExportAllDeclaration");
};
pp$8.parseExport = function(node, exports2) {
  this.next();
  if (this.eat(types$1.star)) {
    return this.parseExportAllDeclaration(node, exports2);
  }
  if (this.eat(types$1._default)) {
    this.checkExport(exports2, "default", this.lastTokStart);
    node.declaration = this.parseExportDefaultDeclaration();
    return this.finishNode(node, "ExportDefaultDeclaration");
  }
  if (this.shouldParseExportStatement()) {
    node.declaration = this.parseExportDeclaration(node);
    if (node.declaration.type === "VariableDeclaration") {
      this.checkVariableExport(exports2, node.declaration.declarations);
    } else {
      this.checkExport(exports2, node.declaration.id, node.declaration.id.start);
    }
    node.specifiers = [];
    node.source = null;
    if (this.options.ecmaVersion >= 16) {
      node.attributes = [];
    }
  } else {
    node.declaration = null;
    node.specifiers = this.parseExportSpecifiers(exports2);
    if (this.eatContextual("from")) {
      if (this.type !== types$1.string) {
        this.unexpected();
      }
      node.source = this.parseExprAtom();
      if (this.options.ecmaVersion >= 16) {
        node.attributes = this.parseWithClause();
      }
    } else {
      for (var i = 0, list = node.specifiers; i < list.length; i += 1) {
        var spec = list[i];
        this.checkUnreserved(spec.local);
        this.checkLocalExport(spec.local);
        if (spec.local.type === "Literal") {
          this.raise(spec.local.start, "A string literal cannot be used as an exported binding without `from`.");
        }
      }
      node.source = null;
      if (this.options.ecmaVersion >= 16) {
        node.attributes = [];
      }
    }
    this.semicolon();
  }
  return this.finishNode(node, "ExportNamedDeclaration");
};
pp$8.parseExportDeclaration = function(node) {
  return this.parseStatement(null);
};
pp$8.parseExportDefaultDeclaration = function() {
  var isAsync;
  if (this.type === types$1._function || (isAsync = this.isAsyncFunction())) {
    var fNode = this.startNode();
    this.next();
    if (isAsync) {
      this.next();
    }
    return this.parseFunction(fNode, FUNC_STATEMENT | FUNC_NULLABLE_ID, false, isAsync);
  } else if (this.type === types$1._class) {
    var cNode = this.startNode();
    return this.parseClass(cNode, "nullableID");
  } else {
    var declaration = this.parseMaybeAssign();
    this.semicolon();
    return declaration;
  }
};
pp$8.checkExport = function(exports2, name, pos) {
  if (!exports2) {
    return;
  }
  if (typeof name !== "string") {
    name = name.type === "Identifier" ? name.name : name.value;
  }
  if (hasOwn(exports2, name)) {
    this.raiseRecoverable(pos, "Duplicate export '" + name + "'");
  }
  exports2[name] = true;
};
pp$8.checkPatternExport = function(exports2, pat) {
  var type = pat.type;
  if (type === "Identifier") {
    this.checkExport(exports2, pat, pat.start);
  } else if (type === "ObjectPattern") {
    for (var i = 0, list = pat.properties; i < list.length; i += 1) {
      var prop = list[i];
      this.checkPatternExport(exports2, prop);
    }
  } else if (type === "ArrayPattern") {
    for (var i$1 = 0, list$1 = pat.elements; i$1 < list$1.length; i$1 += 1) {
      var elt = list$1[i$1];
      if (elt) {
        this.checkPatternExport(exports2, elt);
      }
    }
  } else if (type === "Property") {
    this.checkPatternExport(exports2, pat.value);
  } else if (type === "AssignmentPattern") {
    this.checkPatternExport(exports2, pat.left);
  } else if (type === "RestElement") {
    this.checkPatternExport(exports2, pat.argument);
  }
};
pp$8.checkVariableExport = function(exports2, decls) {
  if (!exports2) {
    return;
  }
  for (var i = 0, list = decls; i < list.length; i += 1) {
    var decl = list[i];
    this.checkPatternExport(exports2, decl.id);
  }
};
pp$8.shouldParseExportStatement = function() {
  return this.type.keyword === "var" || this.type.keyword === "const" || this.type.keyword === "class" || this.type.keyword === "function" || this.isLet() || this.isAsyncFunction();
};
pp$8.parseExportSpecifier = function(exports2) {
  var node = this.startNode();
  node.local = this.parseModuleExportName();
  node.exported = this.eatContextual("as") ? this.parseModuleExportName() : node.local;
  this.checkExport(
    exports2,
    node.exported,
    node.exported.start
  );
  return this.finishNode(node, "ExportSpecifier");
};
pp$8.parseExportSpecifiers = function(exports2) {
  var nodes = [], first = true;
  this.expect(types$1.braceL);
  while (!this.eat(types$1.braceR)) {
    if (!first) {
      this.expect(types$1.comma);
      if (this.afterTrailingComma(types$1.braceR)) {
        break;
      }
    } else {
      first = false;
    }
    nodes.push(this.parseExportSpecifier(exports2));
  }
  return nodes;
};
pp$8.parseImport = function(node) {
  this.next();
  if (this.type === types$1.string) {
    node.specifiers = empty$1;
    node.source = this.parseExprAtom();
  } else {
    node.specifiers = this.parseImportSpecifiers();
    this.expectContextual("from");
    node.source = this.type === types$1.string ? this.parseExprAtom() : this.unexpected();
  }
  if (this.options.ecmaVersion >= 16) {
    node.attributes = this.parseWithClause();
  }
  this.semicolon();
  return this.finishNode(node, "ImportDeclaration");
};
pp$8.parseImportSpecifier = function() {
  var node = this.startNode();
  node.imported = this.parseModuleExportName();
  if (this.eatContextual("as")) {
    node.local = this.parseIdent();
  } else {
    this.checkUnreserved(node.imported);
    node.local = node.imported;
  }
  this.checkLValSimple(node.local, BIND_LEXICAL);
  return this.finishNode(node, "ImportSpecifier");
};
pp$8.parseImportDefaultSpecifier = function() {
  var node = this.startNode();
  node.local = this.parseIdent();
  this.checkLValSimple(node.local, BIND_LEXICAL);
  return this.finishNode(node, "ImportDefaultSpecifier");
};
pp$8.parseImportNamespaceSpecifier = function() {
  var node = this.startNode();
  this.next();
  this.expectContextual("as");
  node.local = this.parseIdent();
  this.checkLValSimple(node.local, BIND_LEXICAL);
  return this.finishNode(node, "ImportNamespaceSpecifier");
};
pp$8.parseImportSpecifiers = function() {
  var nodes = [], first = true;
  if (this.type === types$1.name) {
    nodes.push(this.parseImportDefaultSpecifier());
    if (!this.eat(types$1.comma)) {
      return nodes;
    }
  }
  if (this.type === types$1.star) {
    nodes.push(this.parseImportNamespaceSpecifier());
    return nodes;
  }
  this.expect(types$1.braceL);
  while (!this.eat(types$1.braceR)) {
    if (!first) {
      this.expect(types$1.comma);
      if (this.afterTrailingComma(types$1.braceR)) {
        break;
      }
    } else {
      first = false;
    }
    nodes.push(this.parseImportSpecifier());
  }
  return nodes;
};
pp$8.parseWithClause = function() {
  var nodes = [];
  if (!this.eat(types$1._with)) {
    return nodes;
  }
  this.expect(types$1.braceL);
  var attributeKeys = {};
  var first = true;
  while (!this.eat(types$1.braceR)) {
    if (!first) {
      this.expect(types$1.comma);
      if (this.afterTrailingComma(types$1.braceR)) {
        break;
      }
    } else {
      first = false;
    }
    var attr = this.parseImportAttribute();
    var keyName = attr.key.type === "Identifier" ? attr.key.name : attr.key.value;
    if (hasOwn(attributeKeys, keyName)) {
      this.raiseRecoverable(attr.key.start, "Duplicate attribute key '" + keyName + "'");
    }
    attributeKeys[keyName] = true;
    nodes.push(attr);
  }
  return nodes;
};
pp$8.parseImportAttribute = function() {
  var node = this.startNode();
  node.key = this.type === types$1.string ? this.parseExprAtom() : this.parseIdent(this.options.allowReserved !== "never");
  this.expect(types$1.colon);
  if (this.type !== types$1.string) {
    this.unexpected();
  }
  node.value = this.parseExprAtom();
  return this.finishNode(node, "ImportAttribute");
};
pp$8.parseModuleExportName = function() {
  if (this.options.ecmaVersion >= 13 && this.type === types$1.string) {
    var stringLiteral = this.parseLiteral(this.value);
    if (loneSurrogate.test(stringLiteral.value)) {
      this.raise(stringLiteral.start, "An export name cannot include a lone surrogate.");
    }
    return stringLiteral;
  }
  return this.parseIdent(true);
};
pp$8.adaptDirectivePrologue = function(statements) {
  for (var i = 0; i < statements.length && this.isDirectiveCandidate(statements[i]); ++i) {
    statements[i].directive = statements[i].expression.raw.slice(1, -1);
  }
};
pp$8.isDirectiveCandidate = function(statement) {
  return this.options.ecmaVersion >= 5 && statement.type === "ExpressionStatement" && statement.expression.type === "Literal" && typeof statement.expression.value === "string" && // Reject parenthesized strings.
  (this.input[statement.start] === '"' || this.input[statement.start] === "'");
};
var pp$7 = Parser.prototype;
pp$7.toAssignable = function(node, isBinding, refDestructuringErrors) {
  if (this.options.ecmaVersion >= 6 && node) {
    switch (node.type) {
      case "Identifier":
        if (this.inAsync && node.name === "await") {
          this.raise(node.start, "Cannot use 'await' as identifier inside an async function");
        }
        break;
      case "ObjectPattern":
      case "ArrayPattern":
      case "AssignmentPattern":
      case "RestElement":
        break;
      case "ObjectExpression":
        node.type = "ObjectPattern";
        if (refDestructuringErrors) {
          this.checkPatternErrors(refDestructuringErrors, true);
        }
        for (var i = 0, list = node.properties; i < list.length; i += 1) {
          var prop = list[i];
          this.toAssignable(prop, isBinding);
          if (prop.type === "RestElement" && (prop.argument.type === "ArrayPattern" || prop.argument.type === "ObjectPattern")) {
            this.raise(prop.argument.start, "Unexpected token");
          }
        }
        break;
      case "Property":
        if (node.kind !== "init") {
          this.raise(node.key.start, "Object pattern can't contain getter or setter");
        }
        this.toAssignable(node.value, isBinding);
        break;
      case "ArrayExpression":
        node.type = "ArrayPattern";
        if (refDestructuringErrors) {
          this.checkPatternErrors(refDestructuringErrors, true);
        }
        this.toAssignableList(node.elements, isBinding);
        break;
      case "SpreadElement":
        node.type = "RestElement";
        this.toAssignable(node.argument, isBinding);
        if (node.argument.type === "AssignmentPattern") {
          this.raise(node.argument.start, "Rest elements cannot have a default value");
        }
        break;
      case "AssignmentExpression":
        if (node.operator !== "=") {
          this.raise(node.left.end, "Only '=' operator can be used for specifying default value.");
        }
        node.type = "AssignmentPattern";
        delete node.operator;
        this.toAssignable(node.left, isBinding);
        break;
      case "ParenthesizedExpression":
        this.toAssignable(node.expression, isBinding, refDestructuringErrors);
        break;
      case "ChainExpression":
        this.raiseRecoverable(node.start, "Optional chaining cannot appear in left-hand side");
        break;
      case "MemberExpression":
        if (!isBinding) {
          break;
        }
      default:
        this.raise(node.start, "Assigning to rvalue");
    }
  } else if (refDestructuringErrors) {
    this.checkPatternErrors(refDestructuringErrors, true);
  }
  return node;
};
pp$7.toAssignableList = function(exprList, isBinding) {
  var end = exprList.length;
  for (var i = 0; i < end; i++) {
    var elt = exprList[i];
    if (elt) {
      this.toAssignable(elt, isBinding);
    }
  }
  if (end) {
    var last = exprList[end - 1];
    if (this.options.ecmaVersion === 6 && isBinding && last && last.type === "RestElement" && last.argument.type !== "Identifier") {
      this.unexpected(last.argument.start);
    }
  }
  return exprList;
};
pp$7.parseSpread = function(refDestructuringErrors) {
  var node = this.startNode();
  this.next();
  node.argument = this.parseMaybeAssign(false, refDestructuringErrors);
  return this.finishNode(node, "SpreadElement");
};
pp$7.parseRestBinding = function() {
  var node = this.startNode();
  this.next();
  if (this.options.ecmaVersion === 6 && this.type !== types$1.name) {
    this.unexpected();
  }
  node.argument = this.parseBindingAtom();
  return this.finishNode(node, "RestElement");
};
pp$7.parseBindingAtom = function() {
  if (this.options.ecmaVersion >= 6) {
    switch (this.type) {
      case types$1.bracketL:
        var node = this.startNode();
        this.next();
        node.elements = this.parseBindingList(types$1.bracketR, true, true);
        return this.finishNode(node, "ArrayPattern");
      case types$1.braceL:
        return this.parseObj(true);
    }
  }
  return this.parseIdent();
};
pp$7.parseBindingList = function(close, allowEmpty, allowTrailingComma, allowModifiers) {
  var elts = [], first = true;
  while (!this.eat(close)) {
    if (first) {
      first = false;
    } else {
      this.expect(types$1.comma);
    }
    if (allowEmpty && this.type === types$1.comma) {
      elts.push(null);
    } else if (allowTrailingComma && this.afterTrailingComma(close)) {
      break;
    } else if (this.type === types$1.ellipsis) {
      var rest = this.parseRestBinding();
      this.parseBindingListItem(rest);
      elts.push(rest);
      if (this.type === types$1.comma) {
        this.raiseRecoverable(this.start, "Comma is not permitted after the rest element");
      }
      this.expect(close);
      break;
    } else {
      elts.push(this.parseAssignableListItem(allowModifiers));
    }
  }
  return elts;
};
pp$7.parseAssignableListItem = function(allowModifiers) {
  var elem = this.parseMaybeDefault(this.start, this.startLoc);
  this.parseBindingListItem(elem);
  return elem;
};
pp$7.parseBindingListItem = function(param) {
  return param;
};
pp$7.parseMaybeDefault = function(startPos, startLoc, left) {
  left = left || this.parseBindingAtom();
  if (this.options.ecmaVersion < 6 || !this.eat(types$1.eq)) {
    return left;
  }
  var node = this.startNodeAt(startPos, startLoc);
  node.left = left;
  node.right = this.parseMaybeAssign();
  return this.finishNode(node, "AssignmentPattern");
};
pp$7.checkLValSimple = function(expr, bindingType, checkClashes) {
  if (bindingType === void 0) bindingType = BIND_NONE;
  var isBind = bindingType !== BIND_NONE;
  switch (expr.type) {
    case "Identifier":
      if (this.strict && this.reservedWordsStrictBind.test(expr.name)) {
        this.raiseRecoverable(expr.start, (isBind ? "Binding " : "Assigning to ") + expr.name + " in strict mode");
      }
      if (isBind) {
        if (bindingType === BIND_LEXICAL && expr.name === "let") {
          this.raiseRecoverable(expr.start, "let is disallowed as a lexically bound name");
        }
        if (checkClashes) {
          if (hasOwn(checkClashes, expr.name)) {
            this.raiseRecoverable(expr.start, "Argument name clash");
          }
          checkClashes[expr.name] = true;
        }
        if (bindingType !== BIND_OUTSIDE) {
          this.declareName(expr.name, bindingType, expr.start);
        }
      }
      break;
    case "ChainExpression":
      this.raiseRecoverable(expr.start, "Optional chaining cannot appear in left-hand side");
      break;
    case "MemberExpression":
      if (isBind) {
        this.raiseRecoverable(expr.start, "Binding member expression");
      }
      break;
    case "ParenthesizedExpression":
      if (isBind) {
        this.raiseRecoverable(expr.start, "Binding parenthesized expression");
      }
      return this.checkLValSimple(expr.expression, bindingType, checkClashes);
    default:
      this.raise(expr.start, (isBind ? "Binding" : "Assigning to") + " rvalue");
  }
};
pp$7.checkLValPattern = function(expr, bindingType, checkClashes) {
  if (bindingType === void 0) bindingType = BIND_NONE;
  switch (expr.type) {
    case "ObjectPattern":
      for (var i = 0, list = expr.properties; i < list.length; i += 1) {
        var prop = list[i];
        this.checkLValInnerPattern(prop, bindingType, checkClashes);
      }
      break;
    case "ArrayPattern":
      for (var i$1 = 0, list$1 = expr.elements; i$1 < list$1.length; i$1 += 1) {
        var elem = list$1[i$1];
        if (elem) {
          this.checkLValInnerPattern(elem, bindingType, checkClashes);
        }
      }
      break;
    default:
      this.checkLValSimple(expr, bindingType, checkClashes);
  }
};
pp$7.checkLValInnerPattern = function(expr, bindingType, checkClashes) {
  if (bindingType === void 0) bindingType = BIND_NONE;
  switch (expr.type) {
    case "Property":
      this.checkLValInnerPattern(expr.value, bindingType, checkClashes);
      break;
    case "AssignmentPattern":
      this.checkLValPattern(expr.left, bindingType, checkClashes);
      break;
    case "RestElement":
      this.checkLValPattern(expr.argument, bindingType, checkClashes);
      break;
    default:
      this.checkLValPattern(expr, bindingType, checkClashes);
  }
};
var TokContext = function TokContext2(token, isExpr, preserveSpace, override, generator) {
  this.token = token;
  this.isExpr = !!isExpr;
  this.preserveSpace = !!preserveSpace;
  this.override = override;
  this.generator = !!generator;
};
var types = {
  b_stat: new TokContext("{", false),
  b_expr: new TokContext("{", true),
  b_tmpl: new TokContext("${", false),
  p_stat: new TokContext("(", false),
  p_expr: new TokContext("(", true),
  q_tmpl: new TokContext("`", true, true, function(p) {
    return p.tryReadTemplateToken();
  }),
  f_stat: new TokContext("function", false),
  f_expr: new TokContext("function", true),
  f_expr_gen: new TokContext("function", true, false, null, true),
  f_gen: new TokContext("function", false, false, null, true)
};
var pp$6 = Parser.prototype;
pp$6.initialContext = function() {
  return [types.b_stat];
};
pp$6.curContext = function() {
  return this.context[this.context.length - 1];
};
pp$6.braceIsBlock = function(prevType) {
  var parent = this.curContext();
  if (parent === types.f_expr || parent === types.f_stat) {
    return true;
  }
  if (prevType === types$1.colon && (parent === types.b_stat || parent === types.b_expr)) {
    return !parent.isExpr;
  }
  if (prevType === types$1._return || prevType === types$1.name && this.exprAllowed) {
    return lineBreak.test(this.input.slice(this.lastTokEnd, this.start));
  }
  if (prevType === types$1._else || prevType === types$1.semi || prevType === types$1.eof || prevType === types$1.parenR || prevType === types$1.arrow) {
    return true;
  }
  if (prevType === types$1.braceL) {
    return parent === types.b_stat;
  }
  if (prevType === types$1._var || prevType === types$1._const || prevType === types$1.name) {
    return false;
  }
  return !this.exprAllowed;
};
pp$6.inGeneratorContext = function() {
  for (var i = this.context.length - 1; i >= 1; i--) {
    var context = this.context[i];
    if (context.token === "function") {
      return context.generator;
    }
  }
  return false;
};
pp$6.updateContext = function(prevType) {
  var update2, type = this.type;
  if (type.keyword && prevType === types$1.dot) {
    this.exprAllowed = false;
  } else if (update2 = type.updateContext) {
    update2.call(this, prevType);
  } else {
    this.exprAllowed = type.beforeExpr;
  }
};
pp$6.overrideContext = function(tokenCtx) {
  if (this.curContext() !== tokenCtx) {
    this.context[this.context.length - 1] = tokenCtx;
  }
};
types$1.parenR.updateContext = types$1.braceR.updateContext = function() {
  if (this.context.length === 1) {
    this.exprAllowed = true;
    return;
  }
  var out = this.context.pop();
  if (out === types.b_stat && this.curContext().token === "function") {
    out = this.context.pop();
  }
  this.exprAllowed = !out.isExpr;
};
types$1.braceL.updateContext = function(prevType) {
  this.context.push(this.braceIsBlock(prevType) ? types.b_stat : types.b_expr);
  this.exprAllowed = true;
};
types$1.dollarBraceL.updateContext = function() {
  this.context.push(types.b_tmpl);
  this.exprAllowed = true;
};
types$1.parenL.updateContext = function(prevType) {
  var statementParens = prevType === types$1._if || prevType === types$1._for || prevType === types$1._with || prevType === types$1._while;
  this.context.push(statementParens ? types.p_stat : types.p_expr);
  this.exprAllowed = true;
};
types$1.incDec.updateContext = function() {
};
types$1._function.updateContext = types$1._class.updateContext = function(prevType) {
  if (prevType.beforeExpr && prevType !== types$1._else && !(prevType === types$1.semi && this.curContext() !== types.p_stat) && !(prevType === types$1._return && lineBreak.test(this.input.slice(this.lastTokEnd, this.start))) && !((prevType === types$1.colon || prevType === types$1.braceL) && this.curContext() === types.b_stat)) {
    this.context.push(types.f_expr);
  } else {
    this.context.push(types.f_stat);
  }
  this.exprAllowed = false;
};
types$1.colon.updateContext = function() {
  if (this.curContext().token === "function") {
    this.context.pop();
  }
  this.exprAllowed = true;
};
types$1.backQuote.updateContext = function() {
  if (this.curContext() === types.q_tmpl) {
    this.context.pop();
  } else {
    this.context.push(types.q_tmpl);
  }
  this.exprAllowed = false;
};
types$1.star.updateContext = function(prevType) {
  if (prevType === types$1._function) {
    var index = this.context.length - 1;
    if (this.context[index] === types.f_expr) {
      this.context[index] = types.f_expr_gen;
    } else {
      this.context[index] = types.f_gen;
    }
  }
  this.exprAllowed = true;
};
types$1.name.updateContext = function(prevType) {
  var allowed = false;
  if (this.options.ecmaVersion >= 6 && prevType !== types$1.dot) {
    if (this.value === "of" && !this.exprAllowed || this.value === "yield" && this.inGeneratorContext()) {
      allowed = true;
    }
  }
  this.exprAllowed = allowed;
};
var pp$5 = Parser.prototype;
pp$5.checkPropClash = function(prop, propHash, refDestructuringErrors) {
  if (this.options.ecmaVersion >= 9 && prop.type === "SpreadElement") {
    return;
  }
  if (this.options.ecmaVersion >= 6 && (prop.computed || prop.method || prop.shorthand)) {
    return;
  }
  var key = prop.key;
  var name;
  switch (key.type) {
    case "Identifier":
      name = key.name;
      break;
    case "Literal":
      name = String(key.value);
      break;
    default:
      return;
  }
  var kind = prop.kind;
  if (this.options.ecmaVersion >= 6) {
    if (name === "__proto__" && kind === "init") {
      if (propHash.proto) {
        if (refDestructuringErrors) {
          if (refDestructuringErrors.doubleProto < 0) {
            refDestructuringErrors.doubleProto = key.start;
          }
        } else {
          this.raiseRecoverable(key.start, "Redefinition of __proto__ property");
        }
      }
      propHash.proto = true;
    }
    return;
  }
  name = "$" + name;
  var other = propHash[name];
  if (other) {
    var redefinition;
    if (kind === "init") {
      redefinition = this.strict && other.init || other.get || other.set;
    } else {
      redefinition = other.init || other[kind];
    }
    if (redefinition) {
      this.raiseRecoverable(key.start, "Redefinition of property");
    }
  } else {
    other = propHash[name] = {
      init: false,
      get: false,
      set: false
    };
  }
  other[kind] = true;
};
pp$5.parseExpression = function(forInit, refDestructuringErrors) {
  var startPos = this.start, startLoc = this.startLoc;
  var expr = this.parseMaybeAssign(forInit, refDestructuringErrors);
  if (this.type === types$1.comma) {
    var node = this.startNodeAt(startPos, startLoc);
    node.expressions = [expr];
    while (this.eat(types$1.comma)) {
      node.expressions.push(this.parseMaybeAssign(forInit, refDestructuringErrors));
    }
    return this.finishNode(node, "SequenceExpression");
  }
  return expr;
};
pp$5.parseMaybeAssign = function(forInit, refDestructuringErrors, afterLeftParse) {
  if (this.isContextual("yield")) {
    if (this.inGenerator) {
      return this.parseYield(forInit);
    } else {
      this.exprAllowed = false;
    }
  }
  var ownDestructuringErrors = false, oldParenAssign = -1, oldTrailingComma = -1, oldDoubleProto = -1;
  if (refDestructuringErrors) {
    oldParenAssign = refDestructuringErrors.parenthesizedAssign;
    oldTrailingComma = refDestructuringErrors.trailingComma;
    oldDoubleProto = refDestructuringErrors.doubleProto;
    refDestructuringErrors.parenthesizedAssign = refDestructuringErrors.trailingComma = -1;
  } else {
    refDestructuringErrors = new DestructuringErrors();
    ownDestructuringErrors = true;
  }
  var startPos = this.start, startLoc = this.startLoc;
  if (this.type === types$1.parenL || this.type === types$1.name) {
    this.potentialArrowAt = this.start;
    this.potentialArrowInForAwait = forInit === "await";
  }
  var left = this.parseMaybeConditional(forInit, refDestructuringErrors);
  if (afterLeftParse) {
    left = afterLeftParse.call(this, left, startPos, startLoc);
  }
  if (this.type.isAssign) {
    var node = this.startNodeAt(startPos, startLoc);
    node.operator = this.value;
    if (this.type === types$1.eq) {
      left = this.toAssignable(left, false, refDestructuringErrors);
    }
    if (!ownDestructuringErrors) {
      refDestructuringErrors.parenthesizedAssign = refDestructuringErrors.trailingComma = refDestructuringErrors.doubleProto = -1;
    }
    if (refDestructuringErrors.shorthandAssign >= left.start) {
      refDestructuringErrors.shorthandAssign = -1;
    }
    if (this.type === types$1.eq) {
      this.checkLValPattern(left);
    } else {
      this.checkLValSimple(left);
    }
    node.left = left;
    this.next();
    node.right = this.parseMaybeAssign(forInit);
    if (oldDoubleProto > -1) {
      refDestructuringErrors.doubleProto = oldDoubleProto;
    }
    return this.finishNode(node, "AssignmentExpression");
  } else {
    if (ownDestructuringErrors) {
      this.checkExpressionErrors(refDestructuringErrors, true);
    }
  }
  if (oldParenAssign > -1) {
    refDestructuringErrors.parenthesizedAssign = oldParenAssign;
  }
  if (oldTrailingComma > -1) {
    refDestructuringErrors.trailingComma = oldTrailingComma;
  }
  return left;
};
pp$5.parseMaybeConditional = function(forInit, refDestructuringErrors) {
  var startPos = this.start, startLoc = this.startLoc;
  var expr = this.parseExprOps(forInit, refDestructuringErrors);
  if (this.checkExpressionErrors(refDestructuringErrors)) {
    return expr;
  }
  if (this.eat(types$1.question)) {
    var node = this.startNodeAt(startPos, startLoc);
    node.test = expr;
    node.consequent = this.parseMaybeAssign();
    this.expect(types$1.colon);
    node.alternate = this.parseMaybeAssign(forInit);
    return this.finishNode(node, "ConditionalExpression");
  }
  return expr;
};
pp$5.parseExprOps = function(forInit, refDestructuringErrors) {
  var startPos = this.start, startLoc = this.startLoc;
  var expr = this.parseMaybeUnary(refDestructuringErrors, false, false, forInit);
  if (this.checkExpressionErrors(refDestructuringErrors)) {
    return expr;
  }
  return expr.start === startPos && expr.type === "ArrowFunctionExpression" ? expr : this.parseExprOp(expr, startPos, startLoc, -1, forInit);
};
pp$5.parseExprOp = function(left, leftStartPos, leftStartLoc, minPrec, forInit) {
  var prec = this.type.binop;
  if (prec != null && (!forInit || this.type !== types$1._in)) {
    if (prec > minPrec) {
      var logical = this.type === types$1.logicalOR || this.type === types$1.logicalAND;
      var coalesce = this.type === types$1.coalesce;
      if (coalesce) {
        prec = types$1.logicalAND.binop;
      }
      var op = this.value;
      this.next();
      var startPos = this.start, startLoc = this.startLoc;
      var right = this.parseExprOp(this.parseMaybeUnary(null, false, false, forInit), startPos, startLoc, prec, forInit);
      var node = this.buildBinary(leftStartPos, leftStartLoc, left, right, op, logical || coalesce);
      if (logical && this.type === types$1.coalesce || coalesce && (this.type === types$1.logicalOR || this.type === types$1.logicalAND)) {
        this.raiseRecoverable(this.start, "Logical expressions and coalesce expressions cannot be mixed. Wrap either by parentheses");
      }
      return this.parseExprOp(node, leftStartPos, leftStartLoc, minPrec, forInit);
    }
  }
  return left;
};
pp$5.buildBinary = function(startPos, startLoc, left, right, op, logical) {
  if (right.type === "PrivateIdentifier") {
    this.raise(right.start, "Private identifier can only be left side of binary expression");
  }
  var node = this.startNodeAt(startPos, startLoc);
  node.left = left;
  node.operator = op;
  node.right = right;
  return this.finishNode(node, logical ? "LogicalExpression" : "BinaryExpression");
};
pp$5.parseMaybeUnary = function(refDestructuringErrors, sawUnary, incDec, forInit) {
  var startPos = this.start, startLoc = this.startLoc, expr;
  if (this.isContextual("await") && this.canAwait) {
    expr = this.parseAwait(forInit);
    sawUnary = true;
  } else if (this.type.prefix) {
    var node = this.startNode(), update2 = this.type === types$1.incDec;
    node.operator = this.value;
    node.prefix = true;
    this.next();
    node.argument = this.parseMaybeUnary(null, true, update2, forInit);
    this.checkExpressionErrors(refDestructuringErrors, true);
    if (update2) {
      this.checkLValSimple(node.argument);
    } else if (this.strict && node.operator === "delete" && isLocalVariableAccess(node.argument)) {
      this.raiseRecoverable(node.start, "Deleting local variable in strict mode");
    } else if (node.operator === "delete" && isPrivateFieldAccess(node.argument)) {
      this.raiseRecoverable(node.start, "Private fields can not be deleted");
    } else {
      sawUnary = true;
    }
    expr = this.finishNode(node, update2 ? "UpdateExpression" : "UnaryExpression");
  } else if (!sawUnary && this.type === types$1.privateId) {
    if ((forInit || this.privateNameStack.length === 0) && this.options.checkPrivateFields) {
      this.unexpected();
    }
    expr = this.parsePrivateIdent();
    if (this.type !== types$1._in) {
      this.unexpected();
    }
  } else {
    expr = this.parseExprSubscripts(refDestructuringErrors, forInit);
    if (this.checkExpressionErrors(refDestructuringErrors)) {
      return expr;
    }
    while (this.type.postfix && !this.canInsertSemicolon()) {
      var node$1 = this.startNodeAt(startPos, startLoc);
      node$1.operator = this.value;
      node$1.prefix = false;
      node$1.argument = expr;
      this.checkLValSimple(expr);
      this.next();
      expr = this.finishNode(node$1, "UpdateExpression");
    }
  }
  if (!incDec && this.eat(types$1.starstar)) {
    if (sawUnary) {
      this.unexpected(this.lastTokStart);
    } else {
      return this.buildBinary(startPos, startLoc, expr, this.parseMaybeUnary(null, false, false, forInit), "**", false);
    }
  } else {
    return expr;
  }
};
function isLocalVariableAccess(node) {
  return node.type === "Identifier" || node.type === "ParenthesizedExpression" && isLocalVariableAccess(node.expression);
}
function isPrivateFieldAccess(node) {
  return node.type === "MemberExpression" && node.property.type === "PrivateIdentifier" || node.type === "ChainExpression" && isPrivateFieldAccess(node.expression) || node.type === "ParenthesizedExpression" && isPrivateFieldAccess(node.expression);
}
pp$5.parseExprSubscripts = function(refDestructuringErrors, forInit) {
  var startPos = this.start, startLoc = this.startLoc;
  var expr = this.parseExprAtom(refDestructuringErrors, forInit);
  if (expr.type === "ArrowFunctionExpression" && this.input.slice(this.lastTokStart, this.lastTokEnd) !== ")") {
    return expr;
  }
  var result = this.parseSubscripts(expr, startPos, startLoc, false, forInit);
  if (refDestructuringErrors && result.type === "MemberExpression") {
    if (refDestructuringErrors.parenthesizedAssign >= result.start) {
      refDestructuringErrors.parenthesizedAssign = -1;
    }
    if (refDestructuringErrors.parenthesizedBind >= result.start) {
      refDestructuringErrors.parenthesizedBind = -1;
    }
    if (refDestructuringErrors.trailingComma >= result.start) {
      refDestructuringErrors.trailingComma = -1;
    }
  }
  return result;
};
pp$5.parseSubscripts = function(base2, startPos, startLoc, noCalls, forInit) {
  var maybeAsyncArrow = this.options.ecmaVersion >= 8 && base2.type === "Identifier" && base2.name === "async" && this.lastTokEnd === base2.end && !this.canInsertSemicolon() && base2.end - base2.start === 5 && this.potentialArrowAt === base2.start;
  var optionalChained = false;
  while (true) {
    var element = this.parseSubscript(base2, startPos, startLoc, noCalls, maybeAsyncArrow, optionalChained, forInit);
    if (element.optional) {
      optionalChained = true;
    }
    if (element === base2 || element.type === "ArrowFunctionExpression") {
      if (optionalChained) {
        var chainNode = this.startNodeAt(startPos, startLoc);
        chainNode.expression = element;
        element = this.finishNode(chainNode, "ChainExpression");
      }
      return element;
    }
    base2 = element;
  }
};
pp$5.shouldParseAsyncArrow = function() {
  return !this.canInsertSemicolon() && this.eat(types$1.arrow);
};
pp$5.parseSubscriptAsyncArrow = function(startPos, startLoc, exprList, forInit) {
  return this.parseArrowExpression(this.startNodeAt(startPos, startLoc), exprList, true, forInit);
};
pp$5.parseSubscript = function(base2, startPos, startLoc, noCalls, maybeAsyncArrow, optionalChained, forInit) {
  var optionalSupported = this.options.ecmaVersion >= 11;
  var optional = optionalSupported && this.eat(types$1.questionDot);
  if (noCalls && optional) {
    this.raise(this.lastTokStart, "Optional chaining cannot appear in the callee of new expressions");
  }
  var computed = this.eat(types$1.bracketL);
  if (computed || optional && this.type !== types$1.parenL && this.type !== types$1.backQuote || this.eat(types$1.dot)) {
    var node = this.startNodeAt(startPos, startLoc);
    node.object = base2;
    if (computed) {
      node.property = this.parseExpression();
      this.expect(types$1.bracketR);
    } else if (this.type === types$1.privateId && base2.type !== "Super") {
      node.property = this.parsePrivateIdent();
    } else {
      node.property = this.parseIdent(this.options.allowReserved !== "never");
    }
    node.computed = !!computed;
    if (optionalSupported) {
      node.optional = optional;
    }
    base2 = this.finishNode(node, "MemberExpression");
  } else if (!noCalls && this.eat(types$1.parenL)) {
    var refDestructuringErrors = new DestructuringErrors(), oldYieldPos = this.yieldPos, oldAwaitPos = this.awaitPos, oldAwaitIdentPos = this.awaitIdentPos;
    this.yieldPos = 0;
    this.awaitPos = 0;
    this.awaitIdentPos = 0;
    var exprList = this.parseExprList(types$1.parenR, this.options.ecmaVersion >= 8, false, refDestructuringErrors);
    if (maybeAsyncArrow && !optional && this.shouldParseAsyncArrow()) {
      this.checkPatternErrors(refDestructuringErrors, false);
      this.checkYieldAwaitInDefaultParams();
      if (this.awaitIdentPos > 0) {
        this.raise(this.awaitIdentPos, "Cannot use 'await' as identifier inside an async function");
      }
      this.yieldPos = oldYieldPos;
      this.awaitPos = oldAwaitPos;
      this.awaitIdentPos = oldAwaitIdentPos;
      return this.parseSubscriptAsyncArrow(startPos, startLoc, exprList, forInit);
    }
    this.checkExpressionErrors(refDestructuringErrors, true);
    this.yieldPos = oldYieldPos || this.yieldPos;
    this.awaitPos = oldAwaitPos || this.awaitPos;
    this.awaitIdentPos = oldAwaitIdentPos || this.awaitIdentPos;
    var node$1 = this.startNodeAt(startPos, startLoc);
    node$1.callee = base2;
    node$1.arguments = exprList;
    if (optionalSupported) {
      node$1.optional = optional;
    }
    base2 = this.finishNode(node$1, "CallExpression");
  } else if (this.type === types$1.backQuote) {
    if (optional || optionalChained) {
      this.raise(this.start, "Optional chaining cannot appear in the tag of tagged template expressions");
    }
    var node$2 = this.startNodeAt(startPos, startLoc);
    node$2.tag = base2;
    node$2.quasi = this.parseTemplate({ isTagged: true });
    base2 = this.finishNode(node$2, "TaggedTemplateExpression");
  }
  return base2;
};
pp$5.parseExprAtom = function(refDestructuringErrors, forInit, forNew) {
  if (this.type === types$1.slash) {
    this.readRegexp();
  }
  var node, canBeArrow = this.potentialArrowAt === this.start;
  switch (this.type) {
    case types$1._super:
      if (!this.allowSuper) {
        this.raise(this.start, "'super' keyword outside a method");
      }
      node = this.startNode();
      this.next();
      if (this.type === types$1.parenL && !this.allowDirectSuper) {
        this.raise(node.start, "super() call outside constructor of a subclass");
      }
      if (this.type !== types$1.dot && this.type !== types$1.bracketL && this.type !== types$1.parenL) {
        this.unexpected();
      }
      return this.finishNode(node, "Super");
    case types$1._this:
      node = this.startNode();
      this.next();
      return this.finishNode(node, "ThisExpression");
    case types$1.name:
      var startPos = this.start, startLoc = this.startLoc, containsEsc = this.containsEsc;
      var id = this.parseIdent(false);
      if (this.options.ecmaVersion >= 8 && !containsEsc && id.name === "async" && !this.canInsertSemicolon() && this.eat(types$1._function)) {
        this.overrideContext(types.f_expr);
        return this.parseFunction(this.startNodeAt(startPos, startLoc), 0, false, true, forInit);
      }
      if (canBeArrow && !this.canInsertSemicolon()) {
        if (this.eat(types$1.arrow)) {
          return this.parseArrowExpression(this.startNodeAt(startPos, startLoc), [id], false, forInit);
        }
        if (this.options.ecmaVersion >= 8 && id.name === "async" && this.type === types$1.name && !containsEsc && (!this.potentialArrowInForAwait || this.value !== "of" || this.containsEsc)) {
          id = this.parseIdent(false);
          if (this.canInsertSemicolon() || !this.eat(types$1.arrow)) {
            this.unexpected();
          }
          return this.parseArrowExpression(this.startNodeAt(startPos, startLoc), [id], true, forInit);
        }
      }
      return id;
    case types$1.regexp:
      var value = this.value;
      node = this.parseLiteral(value.value);
      node.regex = { pattern: value.pattern, flags: value.flags };
      return node;
    case types$1.num:
    case types$1.string:
      return this.parseLiteral(this.value);
    case types$1._null:
    case types$1._true:
    case types$1._false:
      node = this.startNode();
      node.value = this.type === types$1._null ? null : this.type === types$1._true;
      node.raw = this.type.keyword;
      this.next();
      return this.finishNode(node, "Literal");
    case types$1.parenL:
      var start = this.start, expr = this.parseParenAndDistinguishExpression(canBeArrow, forInit);
      if (refDestructuringErrors) {
        if (refDestructuringErrors.parenthesizedAssign < 0 && !this.isSimpleAssignTarget(expr)) {
          refDestructuringErrors.parenthesizedAssign = start;
        }
        if (refDestructuringErrors.parenthesizedBind < 0) {
          refDestructuringErrors.parenthesizedBind = start;
        }
      }
      return expr;
    case types$1.bracketL:
      node = this.startNode();
      this.next();
      node.elements = this.parseExprList(types$1.bracketR, true, true, refDestructuringErrors);
      return this.finishNode(node, "ArrayExpression");
    case types$1.braceL:
      this.overrideContext(types.b_expr);
      return this.parseObj(false, refDestructuringErrors);
    case types$1._function:
      node = this.startNode();
      this.next();
      return this.parseFunction(node, 0);
    case types$1._class:
      return this.parseClass(this.startNode(), false);
    case types$1._new:
      return this.parseNew();
    case types$1.backQuote:
      return this.parseTemplate();
    case types$1._import:
      if (this.options.ecmaVersion >= 11) {
        return this.parseExprImport(forNew);
      } else {
        return this.unexpected();
      }
    default:
      return this.parseExprAtomDefault();
  }
};
pp$5.parseExprAtomDefault = function() {
  this.unexpected();
};
pp$5.parseExprImport = function(forNew) {
  var node = this.startNode();
  if (this.containsEsc) {
    this.raiseRecoverable(this.start, "Escape sequence in keyword import");
  }
  this.next();
  if (this.type === types$1.parenL && !forNew) {
    return this.parseDynamicImport(node);
  } else if (this.type === types$1.dot) {
    var meta = this.startNodeAt(node.start, node.loc && node.loc.start);
    meta.name = "import";
    node.meta = this.finishNode(meta, "Identifier");
    return this.parseImportMeta(node);
  } else {
    this.unexpected();
  }
};
pp$5.parseDynamicImport = function(node) {
  this.next();
  node.source = this.parseMaybeAssign();
  if (this.options.ecmaVersion >= 16) {
    if (!this.eat(types$1.parenR)) {
      this.expect(types$1.comma);
      if (!this.afterTrailingComma(types$1.parenR)) {
        node.options = this.parseMaybeAssign();
        if (!this.eat(types$1.parenR)) {
          this.expect(types$1.comma);
          if (!this.afterTrailingComma(types$1.parenR)) {
            this.unexpected();
          }
        }
      } else {
        node.options = null;
      }
    } else {
      node.options = null;
    }
  } else {
    if (!this.eat(types$1.parenR)) {
      var errorPos = this.start;
      if (this.eat(types$1.comma) && this.eat(types$1.parenR)) {
        this.raiseRecoverable(errorPos, "Trailing comma is not allowed in import()");
      } else {
        this.unexpected(errorPos);
      }
    }
  }
  return this.finishNode(node, "ImportExpression");
};
pp$5.parseImportMeta = function(node) {
  this.next();
  var containsEsc = this.containsEsc;
  node.property = this.parseIdent(true);
  if (node.property.name !== "meta") {
    this.raiseRecoverable(node.property.start, "The only valid meta property for import is 'import.meta'");
  }
  if (containsEsc) {
    this.raiseRecoverable(node.start, "'import.meta' must not contain escaped characters");
  }
  if (this.options.sourceType !== "module" && !this.options.allowImportExportEverywhere) {
    this.raiseRecoverable(node.start, "Cannot use 'import.meta' outside a module");
  }
  return this.finishNode(node, "MetaProperty");
};
pp$5.parseLiteral = function(value) {
  var node = this.startNode();
  node.value = value;
  node.raw = this.input.slice(this.start, this.end);
  if (node.raw.charCodeAt(node.raw.length - 1) === 110) {
    node.bigint = node.value != null ? node.value.toString() : node.raw.slice(0, -1).replace(/_/g, "");
  }
  this.next();
  return this.finishNode(node, "Literal");
};
pp$5.parseParenExpression = function() {
  this.expect(types$1.parenL);
  var val = this.parseExpression();
  this.expect(types$1.parenR);
  return val;
};
pp$5.shouldParseArrow = function(exprList) {
  return !this.canInsertSemicolon();
};
pp$5.parseParenAndDistinguishExpression = function(canBeArrow, forInit) {
  var startPos = this.start, startLoc = this.startLoc, val, allowTrailingComma = this.options.ecmaVersion >= 8;
  if (this.options.ecmaVersion >= 6) {
    this.next();
    var innerStartPos = this.start, innerStartLoc = this.startLoc;
    var exprList = [], first = true, lastIsComma = false;
    var refDestructuringErrors = new DestructuringErrors(), oldYieldPos = this.yieldPos, oldAwaitPos = this.awaitPos, spreadStart;
    this.yieldPos = 0;
    this.awaitPos = 0;
    while (this.type !== types$1.parenR) {
      first ? first = false : this.expect(types$1.comma);
      if (allowTrailingComma && this.afterTrailingComma(types$1.parenR, true)) {
        lastIsComma = true;
        break;
      } else if (this.type === types$1.ellipsis) {
        spreadStart = this.start;
        exprList.push(this.parseParenItem(this.parseRestBinding()));
        if (this.type === types$1.comma) {
          this.raiseRecoverable(
            this.start,
            "Comma is not permitted after the rest element"
          );
        }
        break;
      } else {
        exprList.push(this.parseMaybeAssign(false, refDestructuringErrors, this.parseParenItem));
      }
    }
    var innerEndPos = this.lastTokEnd, innerEndLoc = this.lastTokEndLoc;
    this.expect(types$1.parenR);
    if (canBeArrow && this.shouldParseArrow(exprList) && this.eat(types$1.arrow)) {
      this.checkPatternErrors(refDestructuringErrors, false);
      this.checkYieldAwaitInDefaultParams();
      this.yieldPos = oldYieldPos;
      this.awaitPos = oldAwaitPos;
      return this.parseParenArrowList(startPos, startLoc, exprList, forInit);
    }
    if (!exprList.length || lastIsComma) {
      this.unexpected(this.lastTokStart);
    }
    if (spreadStart) {
      this.unexpected(spreadStart);
    }
    this.checkExpressionErrors(refDestructuringErrors, true);
    this.yieldPos = oldYieldPos || this.yieldPos;
    this.awaitPos = oldAwaitPos || this.awaitPos;
    if (exprList.length > 1) {
      val = this.startNodeAt(innerStartPos, innerStartLoc);
      val.expressions = exprList;
      this.finishNodeAt(val, "SequenceExpression", innerEndPos, innerEndLoc);
    } else {
      val = exprList[0];
    }
  } else {
    val = this.parseParenExpression();
  }
  if (this.options.preserveParens) {
    var par = this.startNodeAt(startPos, startLoc);
    par.expression = val;
    return this.finishNode(par, "ParenthesizedExpression");
  } else {
    return val;
  }
};
pp$5.parseParenItem = function(item) {
  return item;
};
pp$5.parseParenArrowList = function(startPos, startLoc, exprList, forInit) {
  return this.parseArrowExpression(this.startNodeAt(startPos, startLoc), exprList, false, forInit);
};
var empty = [];
pp$5.parseNew = function() {
  if (this.containsEsc) {
    this.raiseRecoverable(this.start, "Escape sequence in keyword new");
  }
  var node = this.startNode();
  this.next();
  if (this.options.ecmaVersion >= 6 && this.type === types$1.dot) {
    var meta = this.startNodeAt(node.start, node.loc && node.loc.start);
    meta.name = "new";
    node.meta = this.finishNode(meta, "Identifier");
    this.next();
    var containsEsc = this.containsEsc;
    node.property = this.parseIdent(true);
    if (node.property.name !== "target") {
      this.raiseRecoverable(node.property.start, "The only valid meta property for new is 'new.target'");
    }
    if (containsEsc) {
      this.raiseRecoverable(node.start, "'new.target' must not contain escaped characters");
    }
    if (!this.allowNewDotTarget) {
      this.raiseRecoverable(node.start, "'new.target' can only be used in functions and class static block");
    }
    return this.finishNode(node, "MetaProperty");
  }
  var startPos = this.start, startLoc = this.startLoc;
  node.callee = this.parseSubscripts(this.parseExprAtom(null, false, true), startPos, startLoc, true, false);
  if (this.eat(types$1.parenL)) {
    node.arguments = this.parseExprList(types$1.parenR, this.options.ecmaVersion >= 8, false);
  } else {
    node.arguments = empty;
  }
  return this.finishNode(node, "NewExpression");
};
pp$5.parseTemplateElement = function(ref2) {
  var isTagged = ref2.isTagged;
  var elem = this.startNode();
  if (this.type === types$1.invalidTemplate) {
    if (!isTagged) {
      this.raiseRecoverable(this.start, "Bad escape sequence in untagged template literal");
    }
    elem.value = {
      raw: this.value.replace(/\r\n?/g, "\n"),
      cooked: null
    };
  } else {
    elem.value = {
      raw: this.input.slice(this.start, this.end).replace(/\r\n?/g, "\n"),
      cooked: this.value
    };
  }
  this.next();
  elem.tail = this.type === types$1.backQuote;
  return this.finishNode(elem, "TemplateElement");
};
pp$5.parseTemplate = function(ref2) {
  if (ref2 === void 0) ref2 = {};
  var isTagged = ref2.isTagged;
  if (isTagged === void 0) isTagged = false;
  var node = this.startNode();
  this.next();
  node.expressions = [];
  var curElt = this.parseTemplateElement({ isTagged });
  node.quasis = [curElt];
  while (!curElt.tail) {
    if (this.type === types$1.eof) {
      this.raise(this.pos, "Unterminated template literal");
    }
    this.expect(types$1.dollarBraceL);
    node.expressions.push(this.parseExpression());
    this.expect(types$1.braceR);
    node.quasis.push(curElt = this.parseTemplateElement({ isTagged }));
  }
  this.next();
  return this.finishNode(node, "TemplateLiteral");
};
pp$5.isAsyncProp = function(prop) {
  return !prop.computed && prop.key.type === "Identifier" && prop.key.name === "async" && (this.type === types$1.name || this.type === types$1.num || this.type === types$1.string || this.type === types$1.bracketL || this.type.keyword || this.options.ecmaVersion >= 9 && this.type === types$1.star) && !lineBreak.test(this.input.slice(this.lastTokEnd, this.start));
};
pp$5.parseObj = function(isPattern, refDestructuringErrors) {
  var node = this.startNode(), first = true, propHash = {};
  node.properties = [];
  this.next();
  while (!this.eat(types$1.braceR)) {
    if (!first) {
      this.expect(types$1.comma);
      if (this.options.ecmaVersion >= 5 && this.afterTrailingComma(types$1.braceR)) {
        break;
      }
    } else {
      first = false;
    }
    var prop = this.parseProperty(isPattern, refDestructuringErrors);
    if (!isPattern) {
      this.checkPropClash(prop, propHash, refDestructuringErrors);
    }
    node.properties.push(prop);
  }
  return this.finishNode(node, isPattern ? "ObjectPattern" : "ObjectExpression");
};
pp$5.parseProperty = function(isPattern, refDestructuringErrors) {
  var prop = this.startNode(), isGenerator, isAsync, startPos, startLoc;
  if (this.options.ecmaVersion >= 9 && this.eat(types$1.ellipsis)) {
    if (isPattern) {
      prop.argument = this.parseIdent(false);
      if (this.type === types$1.comma) {
        this.raiseRecoverable(this.start, "Comma is not permitted after the rest element");
      }
      return this.finishNode(prop, "RestElement");
    }
    prop.argument = this.parseMaybeAssign(false, refDestructuringErrors);
    if (this.type === types$1.comma && refDestructuringErrors && refDestructuringErrors.trailingComma < 0) {
      refDestructuringErrors.trailingComma = this.start;
    }
    return this.finishNode(prop, "SpreadElement");
  }
  if (this.options.ecmaVersion >= 6) {
    prop.method = false;
    prop.shorthand = false;
    if (isPattern || refDestructuringErrors) {
      startPos = this.start;
      startLoc = this.startLoc;
    }
    if (!isPattern) {
      isGenerator = this.eat(types$1.star);
    }
  }
  var containsEsc = this.containsEsc;
  this.parsePropertyName(prop);
  if (!isPattern && !containsEsc && this.options.ecmaVersion >= 8 && !isGenerator && this.isAsyncProp(prop)) {
    isAsync = true;
    isGenerator = this.options.ecmaVersion >= 9 && this.eat(types$1.star);
    this.parsePropertyName(prop);
  } else {
    isAsync = false;
  }
  this.parsePropertyValue(prop, isPattern, isGenerator, isAsync, startPos, startLoc, refDestructuringErrors, containsEsc);
  return this.finishNode(prop, "Property");
};
pp$5.parseGetterSetter = function(prop) {
  var kind = prop.key.name;
  this.parsePropertyName(prop);
  prop.value = this.parseMethod(false);
  prop.kind = kind;
  var paramCount = prop.kind === "get" ? 0 : 1;
  if (prop.value.params.length !== paramCount) {
    var start = prop.value.start;
    if (prop.kind === "get") {
      this.raiseRecoverable(start, "getter should have no params");
    } else {
      this.raiseRecoverable(start, "setter should have exactly one param");
    }
  } else {
    if (prop.kind === "set" && prop.value.params[0].type === "RestElement") {
      this.raiseRecoverable(prop.value.params[0].start, "Setter cannot use rest params");
    }
  }
};
pp$5.parsePropertyValue = function(prop, isPattern, isGenerator, isAsync, startPos, startLoc, refDestructuringErrors, containsEsc) {
  if ((isGenerator || isAsync) && this.type === types$1.colon) {
    this.unexpected();
  }
  if (this.eat(types$1.colon)) {
    prop.value = isPattern ? this.parseMaybeDefault(this.start, this.startLoc) : this.parseMaybeAssign(false, refDestructuringErrors);
    prop.kind = "init";
  } else if (this.options.ecmaVersion >= 6 && this.type === types$1.parenL) {
    if (isPattern) {
      this.unexpected();
    }
    prop.method = true;
    prop.value = this.parseMethod(isGenerator, isAsync);
    prop.kind = "init";
  } else if (!isPattern && !containsEsc && this.options.ecmaVersion >= 5 && !prop.computed && prop.key.type === "Identifier" && (prop.key.name === "get" || prop.key.name === "set") && (this.type !== types$1.comma && this.type !== types$1.braceR && this.type !== types$1.eq)) {
    if (isGenerator || isAsync) {
      this.unexpected();
    }
    this.parseGetterSetter(prop);
  } else if (this.options.ecmaVersion >= 6 && !prop.computed && prop.key.type === "Identifier") {
    if (isGenerator || isAsync) {
      this.unexpected();
    }
    this.checkUnreserved(prop.key);
    if (prop.key.name === "await" && !this.awaitIdentPos) {
      this.awaitIdentPos = startPos;
    }
    if (isPattern) {
      prop.value = this.parseMaybeDefault(startPos, startLoc, this.copyNode(prop.key));
    } else if (this.type === types$1.eq && refDestructuringErrors) {
      if (refDestructuringErrors.shorthandAssign < 0) {
        refDestructuringErrors.shorthandAssign = this.start;
      }
      prop.value = this.parseMaybeDefault(startPos, startLoc, this.copyNode(prop.key));
    } else {
      prop.value = this.copyNode(prop.key);
    }
    prop.kind = "init";
    prop.shorthand = true;
  } else {
    this.unexpected();
  }
};
pp$5.parsePropertyName = function(prop) {
  if (this.options.ecmaVersion >= 6) {
    if (this.eat(types$1.bracketL)) {
      prop.computed = true;
      prop.key = this.parseMaybeAssign();
      this.expect(types$1.bracketR);
      return prop.key;
    } else {
      prop.computed = false;
    }
  }
  return prop.key = this.type === types$1.num || this.type === types$1.string ? this.parseExprAtom() : this.parseIdent(this.options.allowReserved !== "never");
};
pp$5.initFunction = function(node) {
  node.id = null;
  if (this.options.ecmaVersion >= 6) {
    node.generator = node.expression = false;
  }
  if (this.options.ecmaVersion >= 8) {
    node.async = false;
  }
};
pp$5.parseMethod = function(isGenerator, isAsync, allowDirectSuper) {
  var node = this.startNode(), oldYieldPos = this.yieldPos, oldAwaitPos = this.awaitPos, oldAwaitIdentPos = this.awaitIdentPos;
  this.initFunction(node);
  if (this.options.ecmaVersion >= 6) {
    node.generator = isGenerator;
  }
  if (this.options.ecmaVersion >= 8) {
    node.async = !!isAsync;
  }
  this.yieldPos = 0;
  this.awaitPos = 0;
  this.awaitIdentPos = 0;
  this.enterScope(functionFlags(isAsync, node.generator) | SCOPE_SUPER | (allowDirectSuper ? SCOPE_DIRECT_SUPER : 0));
  this.expect(types$1.parenL);
  node.params = this.parseBindingList(types$1.parenR, false, this.options.ecmaVersion >= 8);
  this.checkYieldAwaitInDefaultParams();
  this.parseFunctionBody(node, false, true, false);
  this.yieldPos = oldYieldPos;
  this.awaitPos = oldAwaitPos;
  this.awaitIdentPos = oldAwaitIdentPos;
  return this.finishNode(node, "FunctionExpression");
};
pp$5.parseArrowExpression = function(node, params, isAsync, forInit) {
  var oldYieldPos = this.yieldPos, oldAwaitPos = this.awaitPos, oldAwaitIdentPos = this.awaitIdentPos;
  this.enterScope(functionFlags(isAsync, false) | SCOPE_ARROW);
  this.initFunction(node);
  if (this.options.ecmaVersion >= 8) {
    node.async = !!isAsync;
  }
  this.yieldPos = 0;
  this.awaitPos = 0;
  this.awaitIdentPos = 0;
  node.params = this.toAssignableList(params, true);
  this.parseFunctionBody(node, true, false, forInit);
  this.yieldPos = oldYieldPos;
  this.awaitPos = oldAwaitPos;
  this.awaitIdentPos = oldAwaitIdentPos;
  return this.finishNode(node, "ArrowFunctionExpression");
};
pp$5.parseFunctionBody = function(node, isArrowFunction, isMethod, forInit) {
  var isExpression = isArrowFunction && this.type !== types$1.braceL;
  var oldStrict = this.strict, useStrict = false;
  if (isExpression) {
    node.body = this.parseMaybeAssign(forInit);
    node.expression = true;
    this.checkParams(node, false);
  } else {
    var nonSimple = this.options.ecmaVersion >= 7 && !this.isSimpleParamList(node.params);
    if (!oldStrict || nonSimple) {
      useStrict = this.strictDirective(this.end);
      if (useStrict && nonSimple) {
        this.raiseRecoverable(node.start, "Illegal 'use strict' directive in function with non-simple parameter list");
      }
    }
    var oldLabels = this.labels;
    this.labels = [];
    if (useStrict) {
      this.strict = true;
    }
    this.checkParams(node, !oldStrict && !useStrict && !isArrowFunction && !isMethod && this.isSimpleParamList(node.params));
    if (this.strict && node.id) {
      this.checkLValSimple(node.id, BIND_OUTSIDE);
    }
    node.body = this.parseBlock(false, void 0, useStrict && !oldStrict);
    node.expression = false;
    this.adaptDirectivePrologue(node.body.body);
    this.labels = oldLabels;
  }
  this.exitScope();
};
pp$5.isSimpleParamList = function(params) {
  for (var i = 0, list = params; i < list.length; i += 1) {
    var param = list[i];
    if (param.type !== "Identifier") {
      return false;
    }
  }
  return true;
};
pp$5.checkParams = function(node, allowDuplicates) {
  var nameHash = /* @__PURE__ */ Object.create(null);
  for (var i = 0, list = node.params; i < list.length; i += 1) {
    var param = list[i];
    this.checkLValInnerPattern(param, BIND_VAR, allowDuplicates ? null : nameHash);
  }
};
pp$5.parseExprList = function(close, allowTrailingComma, allowEmpty, refDestructuringErrors) {
  var elts = [], first = true;
  while (!this.eat(close)) {
    if (!first) {
      this.expect(types$1.comma);
      if (allowTrailingComma && this.afterTrailingComma(close)) {
        break;
      }
    } else {
      first = false;
    }
    var elt = void 0;
    if (allowEmpty && this.type === types$1.comma) {
      elt = null;
    } else if (this.type === types$1.ellipsis) {
      elt = this.parseSpread(refDestructuringErrors);
      if (refDestructuringErrors && this.type === types$1.comma && refDestructuringErrors.trailingComma < 0) {
        refDestructuringErrors.trailingComma = this.start;
      }
    } else {
      elt = this.parseMaybeAssign(false, refDestructuringErrors);
    }
    elts.push(elt);
  }
  return elts;
};
pp$5.checkUnreserved = function(ref2) {
  var start = ref2.start;
  var end = ref2.end;
  var name = ref2.name;
  if (this.inGenerator && name === "yield") {
    this.raiseRecoverable(start, "Cannot use 'yield' as identifier inside a generator");
  }
  if (this.inAsync && name === "await") {
    this.raiseRecoverable(start, "Cannot use 'await' as identifier inside an async function");
  }
  if (!(this.currentThisScope().flags & SCOPE_VAR) && name === "arguments") {
    this.raiseRecoverable(start, "Cannot use 'arguments' in class field initializer");
  }
  if (this.inClassStaticBlock && (name === "arguments" || name === "await")) {
    this.raise(start, "Cannot use " + name + " in class static initialization block");
  }
  if (this.keywords.test(name)) {
    this.raise(start, "Unexpected keyword '" + name + "'");
  }
  if (this.options.ecmaVersion < 6 && this.input.slice(start, end).indexOf("\\") !== -1) {
    return;
  }
  var re = this.strict ? this.reservedWordsStrict : this.reservedWords;
  if (re.test(name)) {
    if (!this.inAsync && name === "await") {
      this.raiseRecoverable(start, "Cannot use keyword 'await' outside an async function");
    }
    this.raiseRecoverable(start, "The keyword '" + name + "' is reserved");
  }
};
pp$5.parseIdent = function(liberal) {
  var node = this.parseIdentNode();
  this.next(!!liberal);
  this.finishNode(node, "Identifier");
  if (!liberal) {
    this.checkUnreserved(node);
    if (node.name === "await" && !this.awaitIdentPos) {
      this.awaitIdentPos = node.start;
    }
  }
  return node;
};
pp$5.parseIdentNode = function() {
  var node = this.startNode();
  if (this.type === types$1.name) {
    node.name = this.value;
  } else if (this.type.keyword) {
    node.name = this.type.keyword;
    if ((node.name === "class" || node.name === "function") && (this.lastTokEnd !== this.lastTokStart + 1 || this.input.charCodeAt(this.lastTokStart) !== 46)) {
      this.context.pop();
    }
    this.type = types$1.name;
  } else {
    this.unexpected();
  }
  return node;
};
pp$5.parsePrivateIdent = function() {
  var node = this.startNode();
  if (this.type === types$1.privateId) {
    node.name = this.value;
  } else {
    this.unexpected();
  }
  this.next();
  this.finishNode(node, "PrivateIdentifier");
  if (this.options.checkPrivateFields) {
    if (this.privateNameStack.length === 0) {
      this.raise(node.start, "Private field '#" + node.name + "' must be declared in an enclosing class");
    } else {
      this.privateNameStack[this.privateNameStack.length - 1].used.push(node);
    }
  }
  return node;
};
pp$5.parseYield = function(forInit) {
  if (!this.yieldPos) {
    this.yieldPos = this.start;
  }
  var node = this.startNode();
  this.next();
  if (this.type === types$1.semi || this.canInsertSemicolon() || this.type !== types$1.star && !this.type.startsExpr) {
    node.delegate = false;
    node.argument = null;
  } else {
    node.delegate = this.eat(types$1.star);
    node.argument = this.parseMaybeAssign(forInit);
  }
  return this.finishNode(node, "YieldExpression");
};
pp$5.parseAwait = function(forInit) {
  if (!this.awaitPos) {
    this.awaitPos = this.start;
  }
  var node = this.startNode();
  this.next();
  node.argument = this.parseMaybeUnary(null, true, false, forInit);
  return this.finishNode(node, "AwaitExpression");
};
var pp$4 = Parser.prototype;
pp$4.raise = function(pos, message) {
  var loc = getLineInfo(this.input, pos);
  message += " (" + loc.line + ":" + loc.column + ")";
  if (this.sourceFile) {
    message += " in " + this.sourceFile;
  }
  var err2 = new SyntaxError(message);
  err2.pos = pos;
  err2.loc = loc;
  err2.raisedAt = this.pos;
  throw err2;
};
pp$4.raiseRecoverable = pp$4.raise;
pp$4.curPosition = function() {
  if (this.options.locations) {
    return new Position(this.curLine, this.pos - this.lineStart);
  }
};
var pp$3 = Parser.prototype;
var Scope = function Scope2(flags) {
  this.flags = flags;
  this.var = [];
  this.lexical = [];
  this.functions = [];
};
pp$3.enterScope = function(flags) {
  this.scopeStack.push(new Scope(flags));
};
pp$3.exitScope = function() {
  this.scopeStack.pop();
};
pp$3.treatFunctionsAsVarInScope = function(scope) {
  return scope.flags & SCOPE_FUNCTION || !this.inModule && scope.flags & SCOPE_TOP;
};
pp$3.declareName = function(name, bindingType, pos) {
  var redeclared = false;
  if (bindingType === BIND_LEXICAL) {
    var scope = this.currentScope();
    redeclared = scope.lexical.indexOf(name) > -1 || scope.functions.indexOf(name) > -1 || scope.var.indexOf(name) > -1;
    scope.lexical.push(name);
    if (this.inModule && scope.flags & SCOPE_TOP) {
      delete this.undefinedExports[name];
    }
  } else if (bindingType === BIND_SIMPLE_CATCH) {
    var scope$1 = this.currentScope();
    scope$1.lexical.push(name);
  } else if (bindingType === BIND_FUNCTION) {
    var scope$2 = this.currentScope();
    if (this.treatFunctionsAsVar) {
      redeclared = scope$2.lexical.indexOf(name) > -1;
    } else {
      redeclared = scope$2.lexical.indexOf(name) > -1 || scope$2.var.indexOf(name) > -1;
    }
    scope$2.functions.push(name);
  } else {
    for (var i = this.scopeStack.length - 1; i >= 0; --i) {
      var scope$3 = this.scopeStack[i];
      if (scope$3.lexical.indexOf(name) > -1 && !(scope$3.flags & SCOPE_SIMPLE_CATCH && scope$3.lexical[0] === name) || !this.treatFunctionsAsVarInScope(scope$3) && scope$3.functions.indexOf(name) > -1) {
        redeclared = true;
        break;
      }
      scope$3.var.push(name);
      if (this.inModule && scope$3.flags & SCOPE_TOP) {
        delete this.undefinedExports[name];
      }
      if (scope$3.flags & SCOPE_VAR) {
        break;
      }
    }
  }
  if (redeclared) {
    this.raiseRecoverable(pos, "Identifier '" + name + "' has already been declared");
  }
};
pp$3.checkLocalExport = function(id) {
  if (this.scopeStack[0].lexical.indexOf(id.name) === -1 && this.scopeStack[0].var.indexOf(id.name) === -1) {
    this.undefinedExports[id.name] = id;
  }
};
pp$3.currentScope = function() {
  return this.scopeStack[this.scopeStack.length - 1];
};
pp$3.currentVarScope = function() {
  for (var i = this.scopeStack.length - 1; ; i--) {
    var scope = this.scopeStack[i];
    if (scope.flags & (SCOPE_VAR | SCOPE_CLASS_FIELD_INIT | SCOPE_CLASS_STATIC_BLOCK)) {
      return scope;
    }
  }
};
pp$3.currentThisScope = function() {
  for (var i = this.scopeStack.length - 1; ; i--) {
    var scope = this.scopeStack[i];
    if (scope.flags & (SCOPE_VAR | SCOPE_CLASS_FIELD_INIT | SCOPE_CLASS_STATIC_BLOCK) && !(scope.flags & SCOPE_ARROW)) {
      return scope;
    }
  }
};
var Node = function Node2(parser, pos, loc) {
  this.type = "";
  this.start = pos;
  this.end = 0;
  if (parser.options.locations) {
    this.loc = new SourceLocation(parser, loc);
  }
  if (parser.options.directSourceFile) {
    this.sourceFile = parser.options.directSourceFile;
  }
  if (parser.options.ranges) {
    this.range = [pos, 0];
  }
};
var pp$2 = Parser.prototype;
pp$2.startNode = function() {
  return new Node(this, this.start, this.startLoc);
};
pp$2.startNodeAt = function(pos, loc) {
  return new Node(this, pos, loc);
};
function finishNodeAt(node, type, pos, loc) {
  node.type = type;
  node.end = pos;
  if (this.options.locations) {
    node.loc.end = loc;
  }
  if (this.options.ranges) {
    node.range[1] = pos;
  }
  return node;
}
pp$2.finishNode = function(node, type) {
  return finishNodeAt.call(this, node, type, this.lastTokEnd, this.lastTokEndLoc);
};
pp$2.finishNodeAt = function(node, type, pos, loc) {
  return finishNodeAt.call(this, node, type, pos, loc);
};
pp$2.copyNode = function(node) {
  var newNode = new Node(this, node.start, this.startLoc);
  for (var prop in node) {
    newNode[prop] = node[prop];
  }
  return newNode;
};
var scriptValuesAddedInUnicode = "Berf Beria_Erfe Gara Garay Gukh Gurung_Khema Hrkt Katakana_Or_Hiragana Kawi Kirat_Rai Krai Nag_Mundari Nagm Ol_Onal Onao Sidetic Sidt Sunu Sunuwar Tai_Yo Tayo Todhri Todr Tolong_Siki Tols Tulu_Tigalari Tutg Unknown Zzzz";
var ecma9BinaryProperties = "ASCII ASCII_Hex_Digit AHex Alphabetic Alpha Any Assigned Bidi_Control Bidi_C Bidi_Mirrored Bidi_M Case_Ignorable CI Cased Changes_When_Casefolded CWCF Changes_When_Casemapped CWCM Changes_When_Lowercased CWL Changes_When_NFKC_Casefolded CWKCF Changes_When_Titlecased CWT Changes_When_Uppercased CWU Dash Default_Ignorable_Code_Point DI Deprecated Dep Diacritic Dia Emoji Emoji_Component Emoji_Modifier Emoji_Modifier_Base Emoji_Presentation Extender Ext Grapheme_Base Gr_Base Grapheme_Extend Gr_Ext Hex_Digit Hex IDS_Binary_Operator IDSB IDS_Trinary_Operator IDST ID_Continue IDC ID_Start IDS Ideographic Ideo Join_Control Join_C Logical_Order_Exception LOE Lowercase Lower Math Noncharacter_Code_Point NChar Pattern_Syntax Pat_Syn Pattern_White_Space Pat_WS Quotation_Mark QMark Radical Regional_Indicator RI Sentence_Terminal STerm Soft_Dotted SD Terminal_Punctuation Term Unified_Ideograph UIdeo Uppercase Upper Variation_Selector VS White_Space space XID_Continue XIDC XID_Start XIDS";
var ecma10BinaryProperties = ecma9BinaryProperties + " Extended_Pictographic";
var ecma11BinaryProperties = ecma10BinaryProperties;
var ecma12BinaryProperties = ecma11BinaryProperties + " EBase EComp EMod EPres ExtPict";
var ecma13BinaryProperties = ecma12BinaryProperties;
var ecma14BinaryProperties = ecma13BinaryProperties;
var unicodeBinaryProperties = {
  9: ecma9BinaryProperties,
  10: ecma10BinaryProperties,
  11: ecma11BinaryProperties,
  12: ecma12BinaryProperties,
  13: ecma13BinaryProperties,
  14: ecma14BinaryProperties
};
var ecma14BinaryPropertiesOfStrings = "Basic_Emoji Emoji_Keycap_Sequence RGI_Emoji_Modifier_Sequence RGI_Emoji_Flag_Sequence RGI_Emoji_Tag_Sequence RGI_Emoji_ZWJ_Sequence RGI_Emoji";
var unicodeBinaryPropertiesOfStrings = {
  9: "",
  10: "",
  11: "",
  12: "",
  13: "",
  14: ecma14BinaryPropertiesOfStrings
};
var unicodeGeneralCategoryValues = "Cased_Letter LC Close_Punctuation Pe Connector_Punctuation Pc Control Cc cntrl Currency_Symbol Sc Dash_Punctuation Pd Decimal_Number Nd digit Enclosing_Mark Me Final_Punctuation Pf Format Cf Initial_Punctuation Pi Letter L Letter_Number Nl Line_Separator Zl Lowercase_Letter Ll Mark M Combining_Mark Math_Symbol Sm Modifier_Letter Lm Modifier_Symbol Sk Nonspacing_Mark Mn Number N Open_Punctuation Ps Other C Other_Letter Lo Other_Number No Other_Punctuation Po Other_Symbol So Paragraph_Separator Zp Private_Use Co Punctuation P punct Separator Z Space_Separator Zs Spacing_Mark Mc Surrogate Cs Symbol S Titlecase_Letter Lt Unassigned Cn Uppercase_Letter Lu";
var ecma9ScriptValues = "Adlam Adlm Ahom Anatolian_Hieroglyphs Hluw Arabic Arab Armenian Armn Avestan Avst Balinese Bali Bamum Bamu Bassa_Vah Bass Batak Batk Bengali Beng Bhaiksuki Bhks Bopomofo Bopo Brahmi Brah Braille Brai Buginese Bugi Buhid Buhd Canadian_Aboriginal Cans Carian Cari Caucasian_Albanian Aghb Chakma Cakm Cham Cham Cherokee Cher Common Zyyy Coptic Copt Qaac Cuneiform Xsux Cypriot Cprt Cyrillic Cyrl Deseret Dsrt Devanagari Deva Duployan Dupl Egyptian_Hieroglyphs Egyp Elbasan Elba Ethiopic Ethi Georgian Geor Glagolitic Glag Gothic Goth Grantha Gran Greek Grek Gujarati Gujr Gurmukhi Guru Han Hani Hangul Hang Hanunoo Hano Hatran Hatr Hebrew Hebr Hiragana Hira Imperial_Aramaic Armi Inherited Zinh Qaai Inscriptional_Pahlavi Phli Inscriptional_Parthian Prti Javanese Java Kaithi Kthi Kannada Knda Katakana Kana Kayah_Li Kali Kharoshthi Khar Khmer Khmr Khojki Khoj Khudawadi Sind Lao Laoo Latin Latn Lepcha Lepc Limbu Limb Linear_A Lina Linear_B Linb Lisu Lisu Lycian Lyci Lydian Lydi Mahajani Mahj Malayalam Mlym Mandaic Mand Manichaean Mani Marchen Marc Masaram_Gondi Gonm Meetei_Mayek Mtei Mende_Kikakui Mend Meroitic_Cursive Merc Meroitic_Hieroglyphs Mero Miao Plrd Modi Mongolian Mong Mro Mroo Multani Mult Myanmar Mymr Nabataean Nbat New_Tai_Lue Talu Newa Newa Nko Nkoo Nushu Nshu Ogham Ogam Ol_Chiki Olck Old_Hungarian Hung Old_Italic Ital Old_North_Arabian Narb Old_Permic Perm Old_Persian Xpeo Old_South_Arabian Sarb Old_Turkic Orkh Oriya Orya Osage Osge Osmanya Osma Pahawh_Hmong Hmng Palmyrene Palm Pau_Cin_Hau Pauc Phags_Pa Phag Phoenician Phnx Psalter_Pahlavi Phlp Rejang Rjng Runic Runr Samaritan Samr Saurashtra Saur Sharada Shrd Shavian Shaw Siddham Sidd SignWriting Sgnw Sinhala Sinh Sora_Sompeng Sora Soyombo Soyo Sundanese Sund Syloti_Nagri Sylo Syriac Syrc Tagalog Tglg Tagbanwa Tagb Tai_Le Tale Tai_Tham Lana Tai_Viet Tavt Takri Takr Tamil Taml Tangut Tang Telugu Telu Thaana Thaa Thai Thai Tibetan Tibt Tifinagh Tfng Tirhuta Tirh Ugaritic Ugar Vai Vaii Warang_Citi Wara Yi Yiii Zanabazar_Square Zanb";
var ecma10ScriptValues = ecma9ScriptValues + " Dogra Dogr Gunjala_Gondi Gong Hanifi_Rohingya Rohg Makasar Maka Medefaidrin Medf Old_Sogdian Sogo Sogdian Sogd";
var ecma11ScriptValues = ecma10ScriptValues + " Elymaic Elym Nandinagari Nand Nyiakeng_Puachue_Hmong Hmnp Wancho Wcho";
var ecma12ScriptValues = ecma11ScriptValues + " Chorasmian Chrs Diak Dives_Akuru Khitan_Small_Script Kits Yezi Yezidi";
var ecma13ScriptValues = ecma12ScriptValues + " Cypro_Minoan Cpmn Old_Uyghur Ougr Tangsa Tnsa Toto Vithkuqi Vith";
var ecma14ScriptValues = ecma13ScriptValues + " " + scriptValuesAddedInUnicode;
var unicodeScriptValues = {
  9: ecma9ScriptValues,
  10: ecma10ScriptValues,
  11: ecma11ScriptValues,
  12: ecma12ScriptValues,
  13: ecma13ScriptValues,
  14: ecma14ScriptValues
};
var data = {};
function buildUnicodeData(ecmaVersion) {
  var d = data[ecmaVersion] = {
    binary: wordsRegexp(unicodeBinaryProperties[ecmaVersion] + " " + unicodeGeneralCategoryValues),
    binaryOfStrings: wordsRegexp(unicodeBinaryPropertiesOfStrings[ecmaVersion]),
    nonBinary: {
      General_Category: wordsRegexp(unicodeGeneralCategoryValues),
      Script: wordsRegexp(unicodeScriptValues[ecmaVersion])
    }
  };
  d.nonBinary.Script_Extensions = d.nonBinary.Script;
  d.nonBinary.gc = d.nonBinary.General_Category;
  d.nonBinary.sc = d.nonBinary.Script;
  d.nonBinary.scx = d.nonBinary.Script_Extensions;
}
for (i = 0, list = [9, 10, 11, 12, 13, 14]; i < list.length; i += 1) {
  ecmaVersion = list[i];
  buildUnicodeData(ecmaVersion);
}
var ecmaVersion;
var i;
var list;
var pp$1 = Parser.prototype;
var BranchID = function BranchID2(parent, base2) {
  this.parent = parent;
  this.base = base2 || this;
};
BranchID.prototype.separatedFrom = function separatedFrom(alt) {
  for (var self = this; self; self = self.parent) {
    for (var other = alt; other; other = other.parent) {
      if (self.base === other.base && self !== other) {
        return true;
      }
    }
  }
  return false;
};
BranchID.prototype.sibling = function sibling() {
  return new BranchID(this.parent, this.base);
};
var RegExpValidationState = function RegExpValidationState2(parser) {
  this.parser = parser;
  this.validFlags = "gim" + (parser.options.ecmaVersion >= 6 ? "uy" : "") + (parser.options.ecmaVersion >= 9 ? "s" : "") + (parser.options.ecmaVersion >= 13 ? "d" : "") + (parser.options.ecmaVersion >= 15 ? "v" : "");
  this.unicodeProperties = data[parser.options.ecmaVersion >= 14 ? 14 : parser.options.ecmaVersion];
  this.source = "";
  this.flags = "";
  this.start = 0;
  this.switchU = false;
  this.switchV = false;
  this.switchN = false;
  this.pos = 0;
  this.lastIntValue = 0;
  this.lastStringValue = "";
  this.lastAssertionIsQuantifiable = false;
  this.numCapturingParens = 0;
  this.maxBackReference = 0;
  this.groupNames = /* @__PURE__ */ Object.create(null);
  this.backReferenceNames = [];
  this.branchID = null;
};
RegExpValidationState.prototype.reset = function reset(start, pattern, flags) {
  var unicodeSets = flags.indexOf("v") !== -1;
  var unicode = flags.indexOf("u") !== -1;
  this.start = start | 0;
  this.source = pattern + "";
  this.flags = flags;
  if (unicodeSets && this.parser.options.ecmaVersion >= 15) {
    this.switchU = true;
    this.switchV = true;
    this.switchN = true;
  } else {
    this.switchU = unicode && this.parser.options.ecmaVersion >= 6;
    this.switchV = false;
    this.switchN = unicode && this.parser.options.ecmaVersion >= 9;
  }
};
RegExpValidationState.prototype.raise = function raise(message) {
  this.parser.raiseRecoverable(this.start, "Invalid regular expression: /" + this.source + "/: " + message);
};
RegExpValidationState.prototype.at = function at(i, forceU) {
  if (forceU === void 0) forceU = false;
  var s = this.source;
  var l = s.length;
  if (i >= l) {
    return -1;
  }
  var c = s.charCodeAt(i);
  if (!(forceU || this.switchU) || c <= 55295 || c >= 57344 || i + 1 >= l) {
    return c;
  }
  var next = s.charCodeAt(i + 1);
  return next >= 56320 && next <= 57343 ? (c << 10) + next - 56613888 : c;
};
RegExpValidationState.prototype.nextIndex = function nextIndex(i, forceU) {
  if (forceU === void 0) forceU = false;
  var s = this.source;
  var l = s.length;
  if (i >= l) {
    return l;
  }
  var c = s.charCodeAt(i), next;
  if (!(forceU || this.switchU) || c <= 55295 || c >= 57344 || i + 1 >= l || (next = s.charCodeAt(i + 1)) < 56320 || next > 57343) {
    return i + 1;
  }
  return i + 2;
};
RegExpValidationState.prototype.current = function current(forceU) {
  if (forceU === void 0) forceU = false;
  return this.at(this.pos, forceU);
};
RegExpValidationState.prototype.lookahead = function lookahead(forceU) {
  if (forceU === void 0) forceU = false;
  return this.at(this.nextIndex(this.pos, forceU), forceU);
};
RegExpValidationState.prototype.advance = function advance(forceU) {
  if (forceU === void 0) forceU = false;
  this.pos = this.nextIndex(this.pos, forceU);
};
RegExpValidationState.prototype.eat = function eat(ch, forceU) {
  if (forceU === void 0) forceU = false;
  if (this.current(forceU) === ch) {
    this.advance(forceU);
    return true;
  }
  return false;
};
RegExpValidationState.prototype.eatChars = function eatChars(chs, forceU) {
  if (forceU === void 0) forceU = false;
  var pos = this.pos;
  for (var i = 0, list = chs; i < list.length; i += 1) {
    var ch = list[i];
    var current2 = this.at(pos, forceU);
    if (current2 === -1 || current2 !== ch) {
      return false;
    }
    pos = this.nextIndex(pos, forceU);
  }
  this.pos = pos;
  return true;
};
pp$1.validateRegExpFlags = function(state) {
  var validFlags = state.validFlags;
  var flags = state.flags;
  var u = false;
  var v = false;
  for (var i = 0; i < flags.length; i++) {
    var flag = flags.charAt(i);
    if (validFlags.indexOf(flag) === -1) {
      this.raise(state.start, "Invalid regular expression flag");
    }
    if (flags.indexOf(flag, i + 1) > -1) {
      this.raise(state.start, "Duplicate regular expression flag");
    }
    if (flag === "u") {
      u = true;
    }
    if (flag === "v") {
      v = true;
    }
  }
  if (this.options.ecmaVersion >= 15 && u && v) {
    this.raise(state.start, "Invalid regular expression flag");
  }
};
function hasProp(obj) {
  for (var _ in obj) {
    return true;
  }
  return false;
}
pp$1.validateRegExpPattern = function(state) {
  this.regexp_pattern(state);
  if (!state.switchN && this.options.ecmaVersion >= 9 && hasProp(state.groupNames)) {
    state.switchN = true;
    this.regexp_pattern(state);
  }
};
pp$1.regexp_pattern = function(state) {
  state.pos = 0;
  state.lastIntValue = 0;
  state.lastStringValue = "";
  state.lastAssertionIsQuantifiable = false;
  state.numCapturingParens = 0;
  state.maxBackReference = 0;
  state.groupNames = /* @__PURE__ */ Object.create(null);
  state.backReferenceNames.length = 0;
  state.branchID = null;
  this.regexp_disjunction(state);
  if (state.pos !== state.source.length) {
    if (state.eat(
      41
      /* ) */
    )) {
      state.raise("Unmatched ')'");
    }
    if (state.eat(
      93
      /* ] */
    ) || state.eat(
      125
      /* } */
    )) {
      state.raise("Lone quantifier brackets");
    }
  }
  if (state.maxBackReference > state.numCapturingParens) {
    state.raise("Invalid escape");
  }
  for (var i = 0, list = state.backReferenceNames; i < list.length; i += 1) {
    var name = list[i];
    if (!state.groupNames[name]) {
      state.raise("Invalid named capture referenced");
    }
  }
};
pp$1.regexp_disjunction = function(state) {
  var trackDisjunction = this.options.ecmaVersion >= 16;
  if (trackDisjunction) {
    state.branchID = new BranchID(state.branchID, null);
  }
  this.regexp_alternative(state);
  while (state.eat(
    124
    /* | */
  )) {
    if (trackDisjunction) {
      state.branchID = state.branchID.sibling();
    }
    this.regexp_alternative(state);
  }
  if (trackDisjunction) {
    state.branchID = state.branchID.parent;
  }
  if (this.regexp_eatQuantifier(state, true)) {
    state.raise("Nothing to repeat");
  }
  if (state.eat(
    123
    /* { */
  )) {
    state.raise("Lone quantifier brackets");
  }
};
pp$1.regexp_alternative = function(state) {
  while (state.pos < state.source.length && this.regexp_eatTerm(state)) {
  }
};
pp$1.regexp_eatTerm = function(state) {
  if (this.regexp_eatAssertion(state)) {
    if (state.lastAssertionIsQuantifiable && this.regexp_eatQuantifier(state)) {
      if (state.switchU) {
        state.raise("Invalid quantifier");
      }
    }
    return true;
  }
  if (state.switchU ? this.regexp_eatAtom(state) : this.regexp_eatExtendedAtom(state)) {
    this.regexp_eatQuantifier(state);
    return true;
  }
  return false;
};
pp$1.regexp_eatAssertion = function(state) {
  var start = state.pos;
  state.lastAssertionIsQuantifiable = false;
  if (state.eat(
    94
    /* ^ */
  ) || state.eat(
    36
    /* $ */
  )) {
    return true;
  }
  if (state.eat(
    92
    /* \ */
  )) {
    if (state.eat(
      66
      /* B */
    ) || state.eat(
      98
      /* b */
    )) {
      return true;
    }
    state.pos = start;
  }
  if (state.eat(
    40
    /* ( */
  ) && state.eat(
    63
    /* ? */
  )) {
    var lookbehind = false;
    if (this.options.ecmaVersion >= 9) {
      lookbehind = state.eat(
        60
        /* < */
      );
    }
    if (state.eat(
      61
      /* = */
    ) || state.eat(
      33
      /* ! */
    )) {
      this.regexp_disjunction(state);
      if (!state.eat(
        41
        /* ) */
      )) {
        state.raise("Unterminated group");
      }
      state.lastAssertionIsQuantifiable = !lookbehind;
      return true;
    }
  }
  state.pos = start;
  return false;
};
pp$1.regexp_eatQuantifier = function(state, noError) {
  if (noError === void 0) noError = false;
  if (this.regexp_eatQuantifierPrefix(state, noError)) {
    state.eat(
      63
      /* ? */
    );
    return true;
  }
  return false;
};
pp$1.regexp_eatQuantifierPrefix = function(state, noError) {
  return state.eat(
    42
    /* * */
  ) || state.eat(
    43
    /* + */
  ) || state.eat(
    63
    /* ? */
  ) || this.regexp_eatBracedQuantifier(state, noError);
};
pp$1.regexp_eatBracedQuantifier = function(state, noError) {
  var start = state.pos;
  if (state.eat(
    123
    /* { */
  )) {
    var min = 0, max2 = -1;
    if (this.regexp_eatDecimalDigits(state)) {
      min = state.lastIntValue;
      if (state.eat(
        44
        /* , */
      ) && this.regexp_eatDecimalDigits(state)) {
        max2 = state.lastIntValue;
      }
      if (state.eat(
        125
        /* } */
      )) {
        if (max2 !== -1 && max2 < min && !noError) {
          state.raise("numbers out of order in {} quantifier");
        }
        return true;
      }
    }
    if (state.switchU && !noError) {
      state.raise("Incomplete quantifier");
    }
    state.pos = start;
  }
  return false;
};
pp$1.regexp_eatAtom = function(state) {
  return this.regexp_eatPatternCharacters(state) || state.eat(
    46
    /* . */
  ) || this.regexp_eatReverseSolidusAtomEscape(state) || this.regexp_eatCharacterClass(state) || this.regexp_eatUncapturingGroup(state) || this.regexp_eatCapturingGroup(state);
};
pp$1.regexp_eatReverseSolidusAtomEscape = function(state) {
  var start = state.pos;
  if (state.eat(
    92
    /* \ */
  )) {
    if (this.regexp_eatAtomEscape(state)) {
      return true;
    }
    state.pos = start;
  }
  return false;
};
pp$1.regexp_eatUncapturingGroup = function(state) {
  var start = state.pos;
  if (state.eat(
    40
    /* ( */
  )) {
    if (state.eat(
      63
      /* ? */
    )) {
      if (this.options.ecmaVersion >= 16) {
        var addModifiers = this.regexp_eatModifiers(state);
        var hasHyphen = state.eat(
          45
          /* - */
        );
        if (addModifiers || hasHyphen) {
          for (var i = 0; i < addModifiers.length; i++) {
            var modifier = addModifiers.charAt(i);
            if (addModifiers.indexOf(modifier, i + 1) > -1) {
              state.raise("Duplicate regular expression modifiers");
            }
          }
          if (hasHyphen) {
            var removeModifiers = this.regexp_eatModifiers(state);
            if (!addModifiers && !removeModifiers && state.current() === 58) {
              state.raise("Invalid regular expression modifiers");
            }
            for (var i$1 = 0; i$1 < removeModifiers.length; i$1++) {
              var modifier$1 = removeModifiers.charAt(i$1);
              if (removeModifiers.indexOf(modifier$1, i$1 + 1) > -1 || addModifiers.indexOf(modifier$1) > -1) {
                state.raise("Duplicate regular expression modifiers");
              }
            }
          }
        }
      }
      if (state.eat(
        58
        /* : */
      )) {
        this.regexp_disjunction(state);
        if (state.eat(
          41
          /* ) */
        )) {
          return true;
        }
        state.raise("Unterminated group");
      }
    }
    state.pos = start;
  }
  return false;
};
pp$1.regexp_eatCapturingGroup = function(state) {
  if (state.eat(
    40
    /* ( */
  )) {
    if (this.options.ecmaVersion >= 9) {
      this.regexp_groupSpecifier(state);
    } else if (state.current() === 63) {
      state.raise("Invalid group");
    }
    this.regexp_disjunction(state);
    if (state.eat(
      41
      /* ) */
    )) {
      state.numCapturingParens += 1;
      return true;
    }
    state.raise("Unterminated group");
  }
  return false;
};
pp$1.regexp_eatModifiers = function(state) {
  var modifiers = "";
  var ch = 0;
  while ((ch = state.current()) !== -1 && isRegularExpressionModifier(ch)) {
    modifiers += codePointToString(ch);
    state.advance();
  }
  return modifiers;
};
function isRegularExpressionModifier(ch) {
  return ch === 105 || ch === 109 || ch === 115;
}
pp$1.regexp_eatExtendedAtom = function(state) {
  return state.eat(
    46
    /* . */
  ) || this.regexp_eatReverseSolidusAtomEscape(state) || this.regexp_eatCharacterClass(state) || this.regexp_eatUncapturingGroup(state) || this.regexp_eatCapturingGroup(state) || this.regexp_eatInvalidBracedQuantifier(state) || this.regexp_eatExtendedPatternCharacter(state);
};
pp$1.regexp_eatInvalidBracedQuantifier = function(state) {
  if (this.regexp_eatBracedQuantifier(state, true)) {
    state.raise("Nothing to repeat");
  }
  return false;
};
pp$1.regexp_eatSyntaxCharacter = function(state) {
  var ch = state.current();
  if (isSyntaxCharacter(ch)) {
    state.lastIntValue = ch;
    state.advance();
    return true;
  }
  return false;
};
function isSyntaxCharacter(ch) {
  return ch === 36 || ch >= 40 && ch <= 43 || ch === 46 || ch === 63 || ch >= 91 && ch <= 94 || ch >= 123 && ch <= 125;
}
pp$1.regexp_eatPatternCharacters = function(state) {
  var start = state.pos;
  var ch = 0;
  while ((ch = state.current()) !== -1 && !isSyntaxCharacter(ch)) {
    state.advance();
  }
  return state.pos !== start;
};
pp$1.regexp_eatExtendedPatternCharacter = function(state) {
  var ch = state.current();
  if (ch !== -1 && ch !== 36 && !(ch >= 40 && ch <= 43) && ch !== 46 && ch !== 63 && ch !== 91 && ch !== 94 && ch !== 124) {
    state.advance();
    return true;
  }
  return false;
};
pp$1.regexp_groupSpecifier = function(state) {
  if (state.eat(
    63
    /* ? */
  )) {
    if (!this.regexp_eatGroupName(state)) {
      state.raise("Invalid group");
    }
    var trackDisjunction = this.options.ecmaVersion >= 16;
    var known = state.groupNames[state.lastStringValue];
    if (known) {
      if (trackDisjunction) {
        for (var i = 0, list = known; i < list.length; i += 1) {
          var altID = list[i];
          if (!altID.separatedFrom(state.branchID)) {
            state.raise("Duplicate capture group name");
          }
        }
      } else {
        state.raise("Duplicate capture group name");
      }
    }
    if (trackDisjunction) {
      (known || (state.groupNames[state.lastStringValue] = [])).push(state.branchID);
    } else {
      state.groupNames[state.lastStringValue] = true;
    }
  }
};
pp$1.regexp_eatGroupName = function(state) {
  state.lastStringValue = "";
  if (state.eat(
    60
    /* < */
  )) {
    if (this.regexp_eatRegExpIdentifierName(state) && state.eat(
      62
      /* > */
    )) {
      return true;
    }
    state.raise("Invalid capture group name");
  }
  return false;
};
pp$1.regexp_eatRegExpIdentifierName = function(state) {
  state.lastStringValue = "";
  if (this.regexp_eatRegExpIdentifierStart(state)) {
    state.lastStringValue += codePointToString(state.lastIntValue);
    while (this.regexp_eatRegExpIdentifierPart(state)) {
      state.lastStringValue += codePointToString(state.lastIntValue);
    }
    return true;
  }
  return false;
};
pp$1.regexp_eatRegExpIdentifierStart = function(state) {
  var start = state.pos;
  var forceU = this.options.ecmaVersion >= 11;
  var ch = state.current(forceU);
  state.advance(forceU);
  if (ch === 92 && this.regexp_eatRegExpUnicodeEscapeSequence(state, forceU)) {
    ch = state.lastIntValue;
  }
  if (isRegExpIdentifierStart(ch)) {
    state.lastIntValue = ch;
    return true;
  }
  state.pos = start;
  return false;
};
function isRegExpIdentifierStart(ch) {
  return isIdentifierStart(ch, true) || ch === 36 || ch === 95;
}
pp$1.regexp_eatRegExpIdentifierPart = function(state) {
  var start = state.pos;
  var forceU = this.options.ecmaVersion >= 11;
  var ch = state.current(forceU);
  state.advance(forceU);
  if (ch === 92 && this.regexp_eatRegExpUnicodeEscapeSequence(state, forceU)) {
    ch = state.lastIntValue;
  }
  if (isRegExpIdentifierPart(ch)) {
    state.lastIntValue = ch;
    return true;
  }
  state.pos = start;
  return false;
};
function isRegExpIdentifierPart(ch) {
  return isIdentifierChar(ch, true) || ch === 36 || ch === 95 || ch === 8204 || ch === 8205;
}
pp$1.regexp_eatAtomEscape = function(state) {
  if (this.regexp_eatBackReference(state) || this.regexp_eatCharacterClassEscape(state) || this.regexp_eatCharacterEscape(state) || state.switchN && this.regexp_eatKGroupName(state)) {
    return true;
  }
  if (state.switchU) {
    if (state.current() === 99) {
      state.raise("Invalid unicode escape");
    }
    state.raise("Invalid escape");
  }
  return false;
};
pp$1.regexp_eatBackReference = function(state) {
  var start = state.pos;
  if (this.regexp_eatDecimalEscape(state)) {
    var n = state.lastIntValue;
    if (state.switchU) {
      if (n > state.maxBackReference) {
        state.maxBackReference = n;
      }
      return true;
    }
    if (n <= state.numCapturingParens) {
      return true;
    }
    state.pos = start;
  }
  return false;
};
pp$1.regexp_eatKGroupName = function(state) {
  if (state.eat(
    107
    /* k */
  )) {
    if (this.regexp_eatGroupName(state)) {
      state.backReferenceNames.push(state.lastStringValue);
      return true;
    }
    state.raise("Invalid named reference");
  }
  return false;
};
pp$1.regexp_eatCharacterEscape = function(state) {
  return this.regexp_eatControlEscape(state) || this.regexp_eatCControlLetter(state) || this.regexp_eatZero(state) || this.regexp_eatHexEscapeSequence(state) || this.regexp_eatRegExpUnicodeEscapeSequence(state, false) || !state.switchU && this.regexp_eatLegacyOctalEscapeSequence(state) || this.regexp_eatIdentityEscape(state);
};
pp$1.regexp_eatCControlLetter = function(state) {
  var start = state.pos;
  if (state.eat(
    99
    /* c */
  )) {
    if (this.regexp_eatControlLetter(state)) {
      return true;
    }
    state.pos = start;
  }
  return false;
};
pp$1.regexp_eatZero = function(state) {
  if (state.current() === 48 && !isDecimalDigit(state.lookahead())) {
    state.lastIntValue = 0;
    state.advance();
    return true;
  }
  return false;
};
pp$1.regexp_eatControlEscape = function(state) {
  var ch = state.current();
  if (ch === 116) {
    state.lastIntValue = 9;
    state.advance();
    return true;
  }
  if (ch === 110) {
    state.lastIntValue = 10;
    state.advance();
    return true;
  }
  if (ch === 118) {
    state.lastIntValue = 11;
    state.advance();
    return true;
  }
  if (ch === 102) {
    state.lastIntValue = 12;
    state.advance();
    return true;
  }
  if (ch === 114) {
    state.lastIntValue = 13;
    state.advance();
    return true;
  }
  return false;
};
pp$1.regexp_eatControlLetter = function(state) {
  var ch = state.current();
  if (isControlLetter(ch)) {
    state.lastIntValue = ch % 32;
    state.advance();
    return true;
  }
  return false;
};
function isControlLetter(ch) {
  return ch >= 65 && ch <= 90 || ch >= 97 && ch <= 122;
}
pp$1.regexp_eatRegExpUnicodeEscapeSequence = function(state, forceU) {
  if (forceU === void 0) forceU = false;
  var start = state.pos;
  var switchU = forceU || state.switchU;
  if (state.eat(
    117
    /* u */
  )) {
    if (this.regexp_eatFixedHexDigits(state, 4)) {
      var lead = state.lastIntValue;
      if (switchU && lead >= 55296 && lead <= 56319) {
        var leadSurrogateEnd = state.pos;
        if (state.eat(
          92
          /* \ */
        ) && state.eat(
          117
          /* u */
        ) && this.regexp_eatFixedHexDigits(state, 4)) {
          var trail = state.lastIntValue;
          if (trail >= 56320 && trail <= 57343) {
            state.lastIntValue = (lead - 55296) * 1024 + (trail - 56320) + 65536;
            return true;
          }
        }
        state.pos = leadSurrogateEnd;
        state.lastIntValue = lead;
      }
      return true;
    }
    if (switchU && state.eat(
      123
      /* { */
    ) && this.regexp_eatHexDigits(state) && state.eat(
      125
      /* } */
    ) && isValidUnicode(state.lastIntValue)) {
      return true;
    }
    if (switchU) {
      state.raise("Invalid unicode escape");
    }
    state.pos = start;
  }
  return false;
};
function isValidUnicode(ch) {
  return ch >= 0 && ch <= 1114111;
}
pp$1.regexp_eatIdentityEscape = function(state) {
  if (state.switchU) {
    if (this.regexp_eatSyntaxCharacter(state)) {
      return true;
    }
    if (state.eat(
      47
      /* / */
    )) {
      state.lastIntValue = 47;
      return true;
    }
    return false;
  }
  var ch = state.current();
  if (ch !== 99 && (!state.switchN || ch !== 107)) {
    state.lastIntValue = ch;
    state.advance();
    return true;
  }
  return false;
};
pp$1.regexp_eatDecimalEscape = function(state) {
  state.lastIntValue = 0;
  var ch = state.current();
  if (ch >= 49 && ch <= 57) {
    do {
      state.lastIntValue = 10 * state.lastIntValue + (ch - 48);
      state.advance();
    } while ((ch = state.current()) >= 48 && ch <= 57);
    return true;
  }
  return false;
};
var CharSetNone = 0;
var CharSetOk = 1;
var CharSetString = 2;
pp$1.regexp_eatCharacterClassEscape = function(state) {
  var ch = state.current();
  if (isCharacterClassEscape(ch)) {
    state.lastIntValue = -1;
    state.advance();
    return CharSetOk;
  }
  var negate = false;
  if (state.switchU && this.options.ecmaVersion >= 9 && ((negate = ch === 80) || ch === 112)) {
    state.lastIntValue = -1;
    state.advance();
    var result;
    if (state.eat(
      123
      /* { */
    ) && (result = this.regexp_eatUnicodePropertyValueExpression(state)) && state.eat(
      125
      /* } */
    )) {
      if (negate && result === CharSetString) {
        state.raise("Invalid property name");
      }
      return result;
    }
    state.raise("Invalid property name");
  }
  return CharSetNone;
};
function isCharacterClassEscape(ch) {
  return ch === 100 || ch === 68 || ch === 115 || ch === 83 || ch === 119 || ch === 87;
}
pp$1.regexp_eatUnicodePropertyValueExpression = function(state) {
  var start = state.pos;
  if (this.regexp_eatUnicodePropertyName(state) && state.eat(
    61
    /* = */
  )) {
    var name = state.lastStringValue;
    if (this.regexp_eatUnicodePropertyValue(state)) {
      var value = state.lastStringValue;
      this.regexp_validateUnicodePropertyNameAndValue(state, name, value);
      return CharSetOk;
    }
  }
  state.pos = start;
  if (this.regexp_eatLoneUnicodePropertyNameOrValue(state)) {
    var nameOrValue = state.lastStringValue;
    return this.regexp_validateUnicodePropertyNameOrValue(state, nameOrValue);
  }
  return CharSetNone;
};
pp$1.regexp_validateUnicodePropertyNameAndValue = function(state, name, value) {
  if (!hasOwn(state.unicodeProperties.nonBinary, name)) {
    state.raise("Invalid property name");
  }
  if (!state.unicodeProperties.nonBinary[name].test(value)) {
    state.raise("Invalid property value");
  }
};
pp$1.regexp_validateUnicodePropertyNameOrValue = function(state, nameOrValue) {
  if (state.unicodeProperties.binary.test(nameOrValue)) {
    return CharSetOk;
  }
  if (state.switchV && state.unicodeProperties.binaryOfStrings.test(nameOrValue)) {
    return CharSetString;
  }
  state.raise("Invalid property name");
};
pp$1.regexp_eatUnicodePropertyName = function(state) {
  var ch = 0;
  state.lastStringValue = "";
  while (isUnicodePropertyNameCharacter(ch = state.current())) {
    state.lastStringValue += codePointToString(ch);
    state.advance();
  }
  return state.lastStringValue !== "";
};
function isUnicodePropertyNameCharacter(ch) {
  return isControlLetter(ch) || ch === 95;
}
pp$1.regexp_eatUnicodePropertyValue = function(state) {
  var ch = 0;
  state.lastStringValue = "";
  while (isUnicodePropertyValueCharacter(ch = state.current())) {
    state.lastStringValue += codePointToString(ch);
    state.advance();
  }
  return state.lastStringValue !== "";
};
function isUnicodePropertyValueCharacter(ch) {
  return isUnicodePropertyNameCharacter(ch) || isDecimalDigit(ch);
}
pp$1.regexp_eatLoneUnicodePropertyNameOrValue = function(state) {
  return this.regexp_eatUnicodePropertyValue(state);
};
pp$1.regexp_eatCharacterClass = function(state) {
  if (state.eat(
    91
    /* [ */
  )) {
    var negate = state.eat(
      94
      /* ^ */
    );
    var result = this.regexp_classContents(state);
    if (!state.eat(
      93
      /* ] */
    )) {
      state.raise("Unterminated character class");
    }
    if (negate && result === CharSetString) {
      state.raise("Negated character class may contain strings");
    }
    return true;
  }
  return false;
};
pp$1.regexp_classContents = function(state) {
  if (state.current() === 93) {
    return CharSetOk;
  }
  if (state.switchV) {
    return this.regexp_classSetExpression(state);
  }
  this.regexp_nonEmptyClassRanges(state);
  return CharSetOk;
};
pp$1.regexp_nonEmptyClassRanges = function(state) {
  while (this.regexp_eatClassAtom(state)) {
    var left = state.lastIntValue;
    if (state.eat(
      45
      /* - */
    ) && this.regexp_eatClassAtom(state)) {
      var right = state.lastIntValue;
      if (state.switchU && (left === -1 || right === -1)) {
        state.raise("Invalid character class");
      }
      if (left !== -1 && right !== -1 && left > right) {
        state.raise("Range out of order in character class");
      }
    }
  }
};
pp$1.regexp_eatClassAtom = function(state) {
  var start = state.pos;
  if (state.eat(
    92
    /* \ */
  )) {
    if (this.regexp_eatClassEscape(state)) {
      return true;
    }
    if (state.switchU) {
      var ch$1 = state.current();
      if (ch$1 === 99 || isOctalDigit(ch$1)) {
        state.raise("Invalid class escape");
      }
      state.raise("Invalid escape");
    }
    state.pos = start;
  }
  var ch = state.current();
  if (ch !== 93) {
    state.lastIntValue = ch;
    state.advance();
    return true;
  }
  return false;
};
pp$1.regexp_eatClassEscape = function(state) {
  var start = state.pos;
  if (state.eat(
    98
    /* b */
  )) {
    state.lastIntValue = 8;
    return true;
  }
  if (state.switchU && state.eat(
    45
    /* - */
  )) {
    state.lastIntValue = 45;
    return true;
  }
  if (!state.switchU && state.eat(
    99
    /* c */
  )) {
    if (this.regexp_eatClassControlLetter(state)) {
      return true;
    }
    state.pos = start;
  }
  return this.regexp_eatCharacterClassEscape(state) || this.regexp_eatCharacterEscape(state);
};
pp$1.regexp_classSetExpression = function(state) {
  var result = CharSetOk, subResult;
  if (this.regexp_eatClassSetRange(state)) ;
  else if (subResult = this.regexp_eatClassSetOperand(state)) {
    if (subResult === CharSetString) {
      result = CharSetString;
    }
    var start = state.pos;
    while (state.eatChars(
      [38, 38]
      /* && */
    )) {
      if (state.current() !== 38 && (subResult = this.regexp_eatClassSetOperand(state))) {
        if (subResult !== CharSetString) {
          result = CharSetOk;
        }
        continue;
      }
      state.raise("Invalid character in character class");
    }
    if (start !== state.pos) {
      return result;
    }
    while (state.eatChars(
      [45, 45]
      /* -- */
    )) {
      if (this.regexp_eatClassSetOperand(state)) {
        continue;
      }
      state.raise("Invalid character in character class");
    }
    if (start !== state.pos) {
      return result;
    }
  } else {
    state.raise("Invalid character in character class");
  }
  for (; ; ) {
    if (this.regexp_eatClassSetRange(state)) {
      continue;
    }
    subResult = this.regexp_eatClassSetOperand(state);
    if (!subResult) {
      return result;
    }
    if (subResult === CharSetString) {
      result = CharSetString;
    }
  }
};
pp$1.regexp_eatClassSetRange = function(state) {
  var start = state.pos;
  if (this.regexp_eatClassSetCharacter(state)) {
    var left = state.lastIntValue;
    if (state.eat(
      45
      /* - */
    ) && this.regexp_eatClassSetCharacter(state)) {
      var right = state.lastIntValue;
      if (left !== -1 && right !== -1 && left > right) {
        state.raise("Range out of order in character class");
      }
      return true;
    }
    state.pos = start;
  }
  return false;
};
pp$1.regexp_eatClassSetOperand = function(state) {
  if (this.regexp_eatClassSetCharacter(state)) {
    return CharSetOk;
  }
  return this.regexp_eatClassStringDisjunction(state) || this.regexp_eatNestedClass(state);
};
pp$1.regexp_eatNestedClass = function(state) {
  var start = state.pos;
  if (state.eat(
    91
    /* [ */
  )) {
    var negate = state.eat(
      94
      /* ^ */
    );
    var result = this.regexp_classContents(state);
    if (state.eat(
      93
      /* ] */
    )) {
      if (negate && result === CharSetString) {
        state.raise("Negated character class may contain strings");
      }
      return result;
    }
    state.pos = start;
  }
  if (state.eat(
    92
    /* \ */
  )) {
    var result$1 = this.regexp_eatCharacterClassEscape(state);
    if (result$1) {
      return result$1;
    }
    state.pos = start;
  }
  return null;
};
pp$1.regexp_eatClassStringDisjunction = function(state) {
  var start = state.pos;
  if (state.eatChars(
    [92, 113]
    /* \q */
  )) {
    if (state.eat(
      123
      /* { */
    )) {
      var result = this.regexp_classStringDisjunctionContents(state);
      if (state.eat(
        125
        /* } */
      )) {
        return result;
      }
    } else {
      state.raise("Invalid escape");
    }
    state.pos = start;
  }
  return null;
};
pp$1.regexp_classStringDisjunctionContents = function(state) {
  var result = this.regexp_classString(state);
  while (state.eat(
    124
    /* | */
  )) {
    if (this.regexp_classString(state) === CharSetString) {
      result = CharSetString;
    }
  }
  return result;
};
pp$1.regexp_classString = function(state) {
  var count = 0;
  while (this.regexp_eatClassSetCharacter(state)) {
    count++;
  }
  return count === 1 ? CharSetOk : CharSetString;
};
pp$1.regexp_eatClassSetCharacter = function(state) {
  var start = state.pos;
  if (state.eat(
    92
    /* \ */
  )) {
    if (this.regexp_eatCharacterEscape(state) || this.regexp_eatClassSetReservedPunctuator(state)) {
      return true;
    }
    if (state.eat(
      98
      /* b */
    )) {
      state.lastIntValue = 8;
      return true;
    }
    state.pos = start;
    return false;
  }
  var ch = state.current();
  if (ch < 0 || ch === state.lookahead() && isClassSetReservedDoublePunctuatorCharacter(ch)) {
    return false;
  }
  if (isClassSetSyntaxCharacter(ch)) {
    return false;
  }
  state.advance();
  state.lastIntValue = ch;
  return true;
};
function isClassSetReservedDoublePunctuatorCharacter(ch) {
  return ch === 33 || ch >= 35 && ch <= 38 || ch >= 42 && ch <= 44 || ch === 46 || ch >= 58 && ch <= 64 || ch === 94 || ch === 96 || ch === 126;
}
function isClassSetSyntaxCharacter(ch) {
  return ch === 40 || ch === 41 || ch === 45 || ch === 47 || ch >= 91 && ch <= 93 || ch >= 123 && ch <= 125;
}
pp$1.regexp_eatClassSetReservedPunctuator = function(state) {
  var ch = state.current();
  if (isClassSetReservedPunctuator(ch)) {
    state.lastIntValue = ch;
    state.advance();
    return true;
  }
  return false;
};
function isClassSetReservedPunctuator(ch) {
  return ch === 33 || ch === 35 || ch === 37 || ch === 38 || ch === 44 || ch === 45 || ch >= 58 && ch <= 62 || ch === 64 || ch === 96 || ch === 126;
}
pp$1.regexp_eatClassControlLetter = function(state) {
  var ch = state.current();
  if (isDecimalDigit(ch) || ch === 95) {
    state.lastIntValue = ch % 32;
    state.advance();
    return true;
  }
  return false;
};
pp$1.regexp_eatHexEscapeSequence = function(state) {
  var start = state.pos;
  if (state.eat(
    120
    /* x */
  )) {
    if (this.regexp_eatFixedHexDigits(state, 2)) {
      return true;
    }
    if (state.switchU) {
      state.raise("Invalid escape");
    }
    state.pos = start;
  }
  return false;
};
pp$1.regexp_eatDecimalDigits = function(state) {
  var start = state.pos;
  var ch = 0;
  state.lastIntValue = 0;
  while (isDecimalDigit(ch = state.current())) {
    state.lastIntValue = 10 * state.lastIntValue + (ch - 48);
    state.advance();
  }
  return state.pos !== start;
};
function isDecimalDigit(ch) {
  return ch >= 48 && ch <= 57;
}
pp$1.regexp_eatHexDigits = function(state) {
  var start = state.pos;
  var ch = 0;
  state.lastIntValue = 0;
  while (isHexDigit(ch = state.current())) {
    state.lastIntValue = 16 * state.lastIntValue + hexToInt(ch);
    state.advance();
  }
  return state.pos !== start;
};
function isHexDigit(ch) {
  return ch >= 48 && ch <= 57 || ch >= 65 && ch <= 70 || ch >= 97 && ch <= 102;
}
function hexToInt(ch) {
  if (ch >= 65 && ch <= 70) {
    return 10 + (ch - 65);
  }
  if (ch >= 97 && ch <= 102) {
    return 10 + (ch - 97);
  }
  return ch - 48;
}
pp$1.regexp_eatLegacyOctalEscapeSequence = function(state) {
  if (this.regexp_eatOctalDigit(state)) {
    var n1 = state.lastIntValue;
    if (this.regexp_eatOctalDigit(state)) {
      var n2 = state.lastIntValue;
      if (n1 <= 3 && this.regexp_eatOctalDigit(state)) {
        state.lastIntValue = n1 * 64 + n2 * 8 + state.lastIntValue;
      } else {
        state.lastIntValue = n1 * 8 + n2;
      }
    } else {
      state.lastIntValue = n1;
    }
    return true;
  }
  return false;
};
pp$1.regexp_eatOctalDigit = function(state) {
  var ch = state.current();
  if (isOctalDigit(ch)) {
    state.lastIntValue = ch - 48;
    state.advance();
    return true;
  }
  state.lastIntValue = 0;
  return false;
};
function isOctalDigit(ch) {
  return ch >= 48 && ch <= 55;
}
pp$1.regexp_eatFixedHexDigits = function(state, length) {
  var start = state.pos;
  state.lastIntValue = 0;
  for (var i = 0; i < length; ++i) {
    var ch = state.current();
    if (!isHexDigit(ch)) {
      state.pos = start;
      return false;
    }
    state.lastIntValue = 16 * state.lastIntValue + hexToInt(ch);
    state.advance();
  }
  return true;
};
var Token = function Token2(p) {
  this.type = p.type;
  this.value = p.value;
  this.start = p.start;
  this.end = p.end;
  if (p.options.locations) {
    this.loc = new SourceLocation(p, p.startLoc, p.endLoc);
  }
  if (p.options.ranges) {
    this.range = [p.start, p.end];
  }
};
var pp = Parser.prototype;
pp.next = function(ignoreEscapeSequenceInKeyword) {
  if (!ignoreEscapeSequenceInKeyword && this.type.keyword && this.containsEsc) {
    this.raiseRecoverable(this.start, "Escape sequence in keyword " + this.type.keyword);
  }
  if (this.options.onToken) {
    this.options.onToken(new Token(this));
  }
  this.lastTokEnd = this.end;
  this.lastTokStart = this.start;
  this.lastTokEndLoc = this.endLoc;
  this.lastTokStartLoc = this.startLoc;
  this.nextToken();
};
pp.getToken = function() {
  this.next();
  return new Token(this);
};
if (typeof Symbol !== "undefined") {
  pp[Symbol.iterator] = function() {
    var this$1$1 = this;
    return {
      next: function() {
        var token = this$1$1.getToken();
        return {
          done: token.type === types$1.eof,
          value: token
        };
      }
    };
  };
}
pp.nextToken = function() {
  var curContext = this.curContext();
  if (!curContext || !curContext.preserveSpace) {
    this.skipSpace();
  }
  this.start = this.pos;
  if (this.options.locations) {
    this.startLoc = this.curPosition();
  }
  if (this.pos >= this.input.length) {
    return this.finishToken(types$1.eof);
  }
  if (curContext.override) {
    return curContext.override(this);
  } else {
    this.readToken(this.fullCharCodeAtPos());
  }
};
pp.readToken = function(code) {
  if (isIdentifierStart(code, this.options.ecmaVersion >= 6) || code === 92) {
    return this.readWord();
  }
  return this.getTokenFromCode(code);
};
pp.fullCharCodeAt = function(pos) {
  var code = this.input.charCodeAt(pos);
  if (code <= 55295 || code >= 56320) {
    return code;
  }
  var next = this.input.charCodeAt(pos + 1);
  return next <= 56319 || next >= 57344 ? code : (code << 10) + next - 56613888;
};
pp.fullCharCodeAtPos = function() {
  return this.fullCharCodeAt(this.pos);
};
pp.skipBlockComment = function() {
  var startLoc = this.options.onComment && this.curPosition();
  var start = this.pos, end = this.input.indexOf("*/", this.pos += 2);
  if (end === -1) {
    this.raise(this.pos - 2, "Unterminated comment");
  }
  this.pos = end + 2;
  if (this.options.locations) {
    for (var nextBreak = void 0, pos = start; (nextBreak = nextLineBreak(this.input, pos, this.pos)) > -1; ) {
      ++this.curLine;
      pos = this.lineStart = nextBreak;
    }
  }
  if (this.options.onComment) {
    this.options.onComment(
      true,
      this.input.slice(start + 2, end),
      start,
      this.pos,
      startLoc,
      this.curPosition()
    );
  }
};
pp.skipLineComment = function(startSkip) {
  var start = this.pos;
  var startLoc = this.options.onComment && this.curPosition();
  var ch = this.input.charCodeAt(this.pos += startSkip);
  while (this.pos < this.input.length && !isNewLine(ch)) {
    ch = this.input.charCodeAt(++this.pos);
  }
  if (this.options.onComment) {
    this.options.onComment(
      false,
      this.input.slice(start + startSkip, this.pos),
      start,
      this.pos,
      startLoc,
      this.curPosition()
    );
  }
};
pp.skipSpace = function() {
  loop: while (this.pos < this.input.length) {
    var ch = this.input.charCodeAt(this.pos);
    switch (ch) {
      case 32:
      case 160:
        ++this.pos;
        break;
      case 13:
        if (this.input.charCodeAt(this.pos + 1) === 10) {
          ++this.pos;
        }
      case 10:
      case 8232:
      case 8233:
        ++this.pos;
        if (this.options.locations) {
          ++this.curLine;
          this.lineStart = this.pos;
        }
        break;
      case 47:
        switch (this.input.charCodeAt(this.pos + 1)) {
          case 42:
            this.skipBlockComment();
            break;
          case 47:
            this.skipLineComment(2);
            break;
          default:
            break loop;
        }
        break;
      default:
        if (ch > 8 && ch < 14 || ch >= 5760 && nonASCIIwhitespace.test(String.fromCharCode(ch))) {
          ++this.pos;
        } else {
          break loop;
        }
    }
  }
};
pp.finishToken = function(type, val) {
  this.end = this.pos;
  if (this.options.locations) {
    this.endLoc = this.curPosition();
  }
  var prevType = this.type;
  this.type = type;
  this.value = val;
  this.updateContext(prevType);
};
pp.readToken_dot = function() {
  var next = this.input.charCodeAt(this.pos + 1);
  if (next >= 48 && next <= 57) {
    return this.readNumber(true);
  }
  var next2 = this.input.charCodeAt(this.pos + 2);
  if (this.options.ecmaVersion >= 6 && next === 46 && next2 === 46) {
    this.pos += 3;
    return this.finishToken(types$1.ellipsis);
  } else {
    ++this.pos;
    return this.finishToken(types$1.dot);
  }
};
pp.readToken_slash = function() {
  var next = this.input.charCodeAt(this.pos + 1);
  if (this.exprAllowed) {
    ++this.pos;
    return this.readRegexp();
  }
  if (next === 61) {
    return this.finishOp(types$1.assign, 2);
  }
  return this.finishOp(types$1.slash, 1);
};
pp.readToken_mult_modulo_exp = function(code) {
  var next = this.input.charCodeAt(this.pos + 1);
  var size = 1;
  var tokentype = code === 42 ? types$1.star : types$1.modulo;
  if (this.options.ecmaVersion >= 7 && code === 42 && next === 42) {
    ++size;
    tokentype = types$1.starstar;
    next = this.input.charCodeAt(this.pos + 2);
  }
  if (next === 61) {
    return this.finishOp(types$1.assign, size + 1);
  }
  return this.finishOp(tokentype, size);
};
pp.readToken_pipe_amp = function(code) {
  var next = this.input.charCodeAt(this.pos + 1);
  if (next === code) {
    if (this.options.ecmaVersion >= 12) {
      var next2 = this.input.charCodeAt(this.pos + 2);
      if (next2 === 61) {
        return this.finishOp(types$1.assign, 3);
      }
    }
    return this.finishOp(code === 124 ? types$1.logicalOR : types$1.logicalAND, 2);
  }
  if (next === 61) {
    return this.finishOp(types$1.assign, 2);
  }
  return this.finishOp(code === 124 ? types$1.bitwiseOR : types$1.bitwiseAND, 1);
};
pp.readToken_caret = function() {
  var next = this.input.charCodeAt(this.pos + 1);
  if (next === 61) {
    return this.finishOp(types$1.assign, 2);
  }
  return this.finishOp(types$1.bitwiseXOR, 1);
};
pp.readToken_plus_min = function(code) {
  var next = this.input.charCodeAt(this.pos + 1);
  if (next === code) {
    if (next === 45 && !this.inModule && this.input.charCodeAt(this.pos + 2) === 62 && (this.lastTokEnd === 0 || lineBreak.test(this.input.slice(this.lastTokEnd, this.pos)))) {
      this.skipLineComment(3);
      this.skipSpace();
      return this.nextToken();
    }
    return this.finishOp(types$1.incDec, 2);
  }
  if (next === 61) {
    return this.finishOp(types$1.assign, 2);
  }
  return this.finishOp(types$1.plusMin, 1);
};
pp.readToken_lt_gt = function(code) {
  var next = this.input.charCodeAt(this.pos + 1);
  var size = 1;
  if (next === code) {
    size = code === 62 && this.input.charCodeAt(this.pos + 2) === 62 ? 3 : 2;
    if (this.input.charCodeAt(this.pos + size) === 61) {
      return this.finishOp(types$1.assign, size + 1);
    }
    return this.finishOp(types$1.bitShift, size);
  }
  if (next === 33 && code === 60 && !this.inModule && this.input.charCodeAt(this.pos + 2) === 45 && this.input.charCodeAt(this.pos + 3) === 45) {
    this.skipLineComment(4);
    this.skipSpace();
    return this.nextToken();
  }
  if (next === 61) {
    size = 2;
  }
  return this.finishOp(types$1.relational, size);
};
pp.readToken_eq_excl = function(code) {
  var next = this.input.charCodeAt(this.pos + 1);
  if (next === 61) {
    return this.finishOp(types$1.equality, this.input.charCodeAt(this.pos + 2) === 61 ? 3 : 2);
  }
  if (code === 61 && next === 62 && this.options.ecmaVersion >= 6) {
    this.pos += 2;
    return this.finishToken(types$1.arrow);
  }
  return this.finishOp(code === 61 ? types$1.eq : types$1.prefix, 1);
};
pp.readToken_question = function() {
  var ecmaVersion = this.options.ecmaVersion;
  if (ecmaVersion >= 11) {
    var next = this.input.charCodeAt(this.pos + 1);
    if (next === 46) {
      var next2 = this.input.charCodeAt(this.pos + 2);
      if (next2 < 48 || next2 > 57) {
        return this.finishOp(types$1.questionDot, 2);
      }
    }
    if (next === 63) {
      if (ecmaVersion >= 12) {
        var next2$1 = this.input.charCodeAt(this.pos + 2);
        if (next2$1 === 61) {
          return this.finishOp(types$1.assign, 3);
        }
      }
      return this.finishOp(types$1.coalesce, 2);
    }
  }
  return this.finishOp(types$1.question, 1);
};
pp.readToken_numberSign = function() {
  var ecmaVersion = this.options.ecmaVersion;
  var code = 35;
  if (ecmaVersion >= 13) {
    ++this.pos;
    code = this.fullCharCodeAtPos();
    if (isIdentifierStart(code, true) || code === 92) {
      return this.finishToken(types$1.privateId, this.readWord1());
    }
  }
  this.raise(this.pos, "Unexpected character '" + codePointToString(code) + "'");
};
pp.getTokenFromCode = function(code) {
  switch (code) {
    // The interpretation of a dot depends on whether it is followed
    // by a digit or another two dots.
    case 46:
      return this.readToken_dot();
    // Punctuation tokens.
    case 40:
      ++this.pos;
      return this.finishToken(types$1.parenL);
    case 41:
      ++this.pos;
      return this.finishToken(types$1.parenR);
    case 59:
      ++this.pos;
      return this.finishToken(types$1.semi);
    case 44:
      ++this.pos;
      return this.finishToken(types$1.comma);
    case 91:
      ++this.pos;
      return this.finishToken(types$1.bracketL);
    case 93:
      ++this.pos;
      return this.finishToken(types$1.bracketR);
    case 123:
      ++this.pos;
      return this.finishToken(types$1.braceL);
    case 125:
      ++this.pos;
      return this.finishToken(types$1.braceR);
    case 58:
      ++this.pos;
      return this.finishToken(types$1.colon);
    case 96:
      if (this.options.ecmaVersion < 6) {
        break;
      }
      ++this.pos;
      return this.finishToken(types$1.backQuote);
    case 48:
      var next = this.input.charCodeAt(this.pos + 1);
      if (next === 120 || next === 88) {
        return this.readRadixNumber(16);
      }
      if (this.options.ecmaVersion >= 6) {
        if (next === 111 || next === 79) {
          return this.readRadixNumber(8);
        }
        if (next === 98 || next === 66) {
          return this.readRadixNumber(2);
        }
      }
    // Anything else beginning with a digit is an integer, octal
    // number, or float.
    case 49:
    case 50:
    case 51:
    case 52:
    case 53:
    case 54:
    case 55:
    case 56:
    case 57:
      return this.readNumber(false);
    // Quotes produce strings.
    case 34:
    case 39:
      return this.readString(code);
    // Operators are parsed inline in tiny state machines. '=' (61) is
    // often referred to. `finishOp` simply skips the amount of
    // characters it is given as second argument, and returns a token
    // of the type given by its first argument.
    case 47:
      return this.readToken_slash();
    case 37:
    case 42:
      return this.readToken_mult_modulo_exp(code);
    case 124:
    case 38:
      return this.readToken_pipe_amp(code);
    case 94:
      return this.readToken_caret();
    case 43:
    case 45:
      return this.readToken_plus_min(code);
    case 60:
    case 62:
      return this.readToken_lt_gt(code);
    case 61:
    case 33:
      return this.readToken_eq_excl(code);
    case 63:
      return this.readToken_question();
    case 126:
      return this.finishOp(types$1.prefix, 1);
    case 35:
      return this.readToken_numberSign();
  }
  this.raise(this.pos, "Unexpected character '" + codePointToString(code) + "'");
};
pp.finishOp = function(type, size) {
  var str = this.input.slice(this.pos, this.pos + size);
  this.pos += size;
  return this.finishToken(type, str);
};
pp.readRegexp = function() {
  var escaped, inClass, start = this.pos;
  for (; ; ) {
    if (this.pos >= this.input.length) {
      this.raise(start, "Unterminated regular expression");
    }
    var ch = this.input.charAt(this.pos);
    if (lineBreak.test(ch)) {
      this.raise(start, "Unterminated regular expression");
    }
    if (!escaped) {
      if (ch === "[") {
        inClass = true;
      } else if (ch === "]" && inClass) {
        inClass = false;
      } else if (ch === "/" && !inClass) {
        break;
      }
      escaped = ch === "\\";
    } else {
      escaped = false;
    }
    ++this.pos;
  }
  var pattern = this.input.slice(start, this.pos);
  ++this.pos;
  var flagsStart = this.pos;
  var flags = this.readWord1();
  if (this.containsEsc) {
    this.unexpected(flagsStart);
  }
  var state = this.regexpState || (this.regexpState = new RegExpValidationState(this));
  state.reset(start, pattern, flags);
  this.validateRegExpFlags(state);
  this.validateRegExpPattern(state);
  var value = null;
  try {
    value = new RegExp(pattern, flags);
  } catch (e) {
  }
  return this.finishToken(types$1.regexp, { pattern, flags, value });
};
pp.readInt = function(radix, len, maybeLegacyOctalNumericLiteral) {
  var allowSeparators = this.options.ecmaVersion >= 12 && len === void 0;
  var isLegacyOctalNumericLiteral = maybeLegacyOctalNumericLiteral && this.input.charCodeAt(this.pos) === 48;
  var start = this.pos, total = 0, lastCode = 0;
  for (var i = 0, e = len == null ? Infinity : len; i < e; ++i, ++this.pos) {
    var code = this.input.charCodeAt(this.pos), val = void 0;
    if (allowSeparators && code === 95) {
      if (isLegacyOctalNumericLiteral) {
        this.raiseRecoverable(this.pos, "Numeric separator is not allowed in legacy octal numeric literals");
      }
      if (lastCode === 95) {
        this.raiseRecoverable(this.pos, "Numeric separator must be exactly one underscore");
      }
      if (i === 0) {
        this.raiseRecoverable(this.pos, "Numeric separator is not allowed at the first of digits");
      }
      lastCode = code;
      continue;
    }
    if (code >= 97) {
      val = code - 97 + 10;
    } else if (code >= 65) {
      val = code - 65 + 10;
    } else if (code >= 48 && code <= 57) {
      val = code - 48;
    } else {
      val = Infinity;
    }
    if (val >= radix) {
      break;
    }
    lastCode = code;
    total = total * radix + val;
  }
  if (allowSeparators && lastCode === 95) {
    this.raiseRecoverable(this.pos - 1, "Numeric separator is not allowed at the last of digits");
  }
  if (this.pos === start || len != null && this.pos - start !== len) {
    return null;
  }
  return total;
};
function stringToNumber(str, isLegacyOctalNumericLiteral) {
  if (isLegacyOctalNumericLiteral) {
    return parseInt(str, 8);
  }
  return parseFloat(str.replace(/_/g, ""));
}
function stringToBigInt(str) {
  if (typeof BigInt !== "function") {
    return null;
  }
  return BigInt(str.replace(/_/g, ""));
}
pp.readRadixNumber = function(radix) {
  var start = this.pos;
  this.pos += 2;
  var val = this.readInt(radix);
  if (val == null) {
    this.raise(this.start + 2, "Expected number in radix " + radix);
  }
  if (this.options.ecmaVersion >= 11 && this.input.charCodeAt(this.pos) === 110) {
    val = stringToBigInt(this.input.slice(start, this.pos));
    ++this.pos;
  } else if (isIdentifierStart(this.fullCharCodeAtPos())) {
    this.raise(this.pos, "Identifier directly after number");
  }
  return this.finishToken(types$1.num, val);
};
pp.readNumber = function(startsWithDot) {
  var start = this.pos;
  if (!startsWithDot && this.readInt(10, void 0, true) === null) {
    this.raise(start, "Invalid number");
  }
  var octal = this.pos - start >= 2 && this.input.charCodeAt(start) === 48;
  if (octal && this.strict) {
    this.raise(start, "Invalid number");
  }
  var next = this.input.charCodeAt(this.pos);
  if (!octal && !startsWithDot && this.options.ecmaVersion >= 11 && next === 110) {
    var val$1 = stringToBigInt(this.input.slice(start, this.pos));
    ++this.pos;
    if (isIdentifierStart(this.fullCharCodeAtPos())) {
      this.raise(this.pos, "Identifier directly after number");
    }
    return this.finishToken(types$1.num, val$1);
  }
  if (octal && /[89]/.test(this.input.slice(start, this.pos))) {
    octal = false;
  }
  if (next === 46 && !octal) {
    ++this.pos;
    this.readInt(10);
    next = this.input.charCodeAt(this.pos);
  }
  if ((next === 69 || next === 101) && !octal) {
    next = this.input.charCodeAt(++this.pos);
    if (next === 43 || next === 45) {
      ++this.pos;
    }
    if (this.readInt(10) === null) {
      this.raise(start, "Invalid number");
    }
  }
  if (isIdentifierStart(this.fullCharCodeAtPos())) {
    this.raise(this.pos, "Identifier directly after number");
  }
  var val = stringToNumber(this.input.slice(start, this.pos), octal);
  return this.finishToken(types$1.num, val);
};
pp.readCodePoint = function() {
  var ch = this.input.charCodeAt(this.pos), code;
  if (ch === 123) {
    if (this.options.ecmaVersion < 6) {
      this.unexpected();
    }
    var codePos = ++this.pos;
    code = this.readHexChar(this.input.indexOf("}", this.pos) - this.pos);
    ++this.pos;
    if (code > 1114111) {
      this.invalidStringToken(codePos, "Code point out of bounds");
    }
  } else {
    code = this.readHexChar(4);
  }
  return code;
};
pp.readString = function(quote) {
  var out = "", chunkStart = ++this.pos;
  for (; ; ) {
    if (this.pos >= this.input.length) {
      this.raise(this.start, "Unterminated string constant");
    }
    var ch = this.input.charCodeAt(this.pos);
    if (ch === quote) {
      break;
    }
    if (ch === 92) {
      out += this.input.slice(chunkStart, this.pos);
      out += this.readEscapedChar(false);
      chunkStart = this.pos;
    } else if (ch === 8232 || ch === 8233) {
      if (this.options.ecmaVersion < 10) {
        this.raise(this.start, "Unterminated string constant");
      }
      ++this.pos;
      if (this.options.locations) {
        this.curLine++;
        this.lineStart = this.pos;
      }
    } else {
      if (isNewLine(ch)) {
        this.raise(this.start, "Unterminated string constant");
      }
      ++this.pos;
    }
  }
  out += this.input.slice(chunkStart, this.pos++);
  return this.finishToken(types$1.string, out);
};
var INVALID_TEMPLATE_ESCAPE_ERROR = {};
pp.tryReadTemplateToken = function() {
  this.inTemplateElement = true;
  try {
    this.readTmplToken();
  } catch (err2) {
    if (err2 === INVALID_TEMPLATE_ESCAPE_ERROR) {
      this.readInvalidTemplateToken();
    } else {
      throw err2;
    }
  }
  this.inTemplateElement = false;
};
pp.invalidStringToken = function(position, message) {
  if (this.inTemplateElement && this.options.ecmaVersion >= 9) {
    throw INVALID_TEMPLATE_ESCAPE_ERROR;
  } else {
    this.raise(position, message);
  }
};
pp.readTmplToken = function() {
  var out = "", chunkStart = this.pos;
  for (; ; ) {
    if (this.pos >= this.input.length) {
      this.raise(this.start, "Unterminated template");
    }
    var ch = this.input.charCodeAt(this.pos);
    if (ch === 96 || ch === 36 && this.input.charCodeAt(this.pos + 1) === 123) {
      if (this.pos === this.start && (this.type === types$1.template || this.type === types$1.invalidTemplate)) {
        if (ch === 36) {
          this.pos += 2;
          return this.finishToken(types$1.dollarBraceL);
        } else {
          ++this.pos;
          return this.finishToken(types$1.backQuote);
        }
      }
      out += this.input.slice(chunkStart, this.pos);
      return this.finishToken(types$1.template, out);
    }
    if (ch === 92) {
      out += this.input.slice(chunkStart, this.pos);
      out += this.readEscapedChar(true);
      chunkStart = this.pos;
    } else if (isNewLine(ch)) {
      out += this.input.slice(chunkStart, this.pos);
      ++this.pos;
      switch (ch) {
        case 13:
          if (this.input.charCodeAt(this.pos) === 10) {
            ++this.pos;
          }
        case 10:
          out += "\n";
          break;
        default:
          out += String.fromCharCode(ch);
          break;
      }
      if (this.options.locations) {
        ++this.curLine;
        this.lineStart = this.pos;
      }
      chunkStart = this.pos;
    } else {
      ++this.pos;
    }
  }
};
pp.readInvalidTemplateToken = function() {
  for (; this.pos < this.input.length; this.pos++) {
    switch (this.input[this.pos]) {
      case "\\":
        ++this.pos;
        break;
      case "$":
        if (this.input[this.pos + 1] !== "{") {
          break;
        }
      // fall through
      case "`":
        return this.finishToken(types$1.invalidTemplate, this.input.slice(this.start, this.pos));
      case "\r":
        if (this.input[this.pos + 1] === "\n") {
          ++this.pos;
        }
      // fall through
      case "\n":
      case "\u2028":
      case "\u2029":
        ++this.curLine;
        this.lineStart = this.pos + 1;
        break;
    }
  }
  this.raise(this.start, "Unterminated template");
};
pp.readEscapedChar = function(inTemplate) {
  var ch = this.input.charCodeAt(++this.pos);
  ++this.pos;
  switch (ch) {
    case 110:
      return "\n";
    // 'n' -> '\n'
    case 114:
      return "\r";
    // 'r' -> '\r'
    case 120:
      return String.fromCharCode(this.readHexChar(2));
    // 'x'
    case 117:
      return codePointToString(this.readCodePoint());
    // 'u'
    case 116:
      return "	";
    // 't' -> '\t'
    case 98:
      return "\b";
    // 'b' -> '\b'
    case 118:
      return "\v";
    // 'v' -> '\u000b'
    case 102:
      return "\f";
    // 'f' -> '\f'
    case 13:
      if (this.input.charCodeAt(this.pos) === 10) {
        ++this.pos;
      }
    // '\r\n'
    case 10:
      if (this.options.locations) {
        this.lineStart = this.pos;
        ++this.curLine;
      }
      return "";
    case 56:
    case 57:
      if (this.strict) {
        this.invalidStringToken(
          this.pos - 1,
          "Invalid escape sequence"
        );
      }
      if (inTemplate) {
        var codePos = this.pos - 1;
        this.invalidStringToken(
          codePos,
          "Invalid escape sequence in template string"
        );
      }
    default:
      if (ch >= 48 && ch <= 55) {
        var octalStr = this.input.substr(this.pos - 1, 3).match(/^[0-7]+/)[0];
        var octal = parseInt(octalStr, 8);
        if (octal > 255) {
          octalStr = octalStr.slice(0, -1);
          octal = parseInt(octalStr, 8);
        }
        this.pos += octalStr.length - 1;
        ch = this.input.charCodeAt(this.pos);
        if ((octalStr !== "0" || ch === 56 || ch === 57) && (this.strict || inTemplate)) {
          this.invalidStringToken(
            this.pos - 1 - octalStr.length,
            inTemplate ? "Octal literal in template string" : "Octal literal in strict mode"
          );
        }
        return String.fromCharCode(octal);
      }
      if (isNewLine(ch)) {
        if (this.options.locations) {
          this.lineStart = this.pos;
          ++this.curLine;
        }
        return "";
      }
      return String.fromCharCode(ch);
  }
};
pp.readHexChar = function(len) {
  var codePos = this.pos;
  var n = this.readInt(16, len);
  if (n === null) {
    this.invalidStringToken(codePos, "Bad character escape sequence");
  }
  return n;
};
pp.readWord1 = function() {
  this.containsEsc = false;
  var word = "", first = true, chunkStart = this.pos;
  var astral = this.options.ecmaVersion >= 6;
  while (this.pos < this.input.length) {
    var ch = this.fullCharCodeAtPos();
    if (isIdentifierChar(ch, astral)) {
      this.pos += ch <= 65535 ? 1 : 2;
    } else if (ch === 92) {
      this.containsEsc = true;
      word += this.input.slice(chunkStart, this.pos);
      var escStart = this.pos;
      if (this.input.charCodeAt(++this.pos) !== 117) {
        this.invalidStringToken(this.pos, "Expecting Unicode escape sequence \\uXXXX");
      }
      ++this.pos;
      var esc = this.readCodePoint();
      if (!(first ? isIdentifierStart : isIdentifierChar)(esc, astral)) {
        this.invalidStringToken(escStart, "Invalid Unicode escape");
      }
      word += codePointToString(esc);
      chunkStart = this.pos;
    } else {
      break;
    }
    first = false;
  }
  return word + this.input.slice(chunkStart, this.pos);
};
pp.readWord = function() {
  var word = this.readWord1();
  var type = types$1.name;
  if (this.keywords.test(word)) {
    type = keywords[word];
  }
  return this.finishToken(type, word);
};
var version = "8.16.0";
Parser.acorn = {
  Parser,
  version,
  defaultOptions,
  Position,
  SourceLocation,
  getLineInfo,
  Node,
  TokenType,
  tokTypes: types$1,
  keywordTypes: keywords,
  TokContext,
  tokContexts: types,
  isIdentifierChar,
  isIdentifierStart,
  Token,
  isNewLine,
  lineBreak,
  lineBreakG,
  nonASCIIwhitespace
};
function parse3(input, options) {
  return Parser.parse(input, options);
}
function parseExpressionAt2(input, pos, options) {
  return Parser.parseExpressionAt(input, pos, options);
}

// src/checksum.js
var import_crypto = require("crypto");
var import_fs7 = require("fs");
var import_path7 = require("path");
function computeHash(filePath) {
  return (0, import_crypto.createHash)("sha256").update((0, import_fs7.readFileSync)(filePath)).digest("base64").replace(/=+$/, "");
}
function hasChecksumTable(paths) {
  try {
    return Boolean(JSON.parse((0, import_fs7.readFileSync)(paths.productJson, "utf-8")).checksums);
  } catch {
    return false;
  }
}
function updateChecksums(paths, modifiedFiles, tag, log) {
  const product = JSON.parse((0, import_fs7.readFileSync)(paths.productJson, "utf-8"));
  if (!product.checksums) {
    log?.("  No checksums in product.json");
    return 0;
  }
  let updated = 0;
  for (const file of modifiedFiles) {
    const key = (0, import_path7.relative)((0, import_path7.join)(paths.appRoot, "out"), file).replace(/\\/g, "/");
    if (product.checksums[key]) {
      product.checksums[key] = computeHash(file);
      updated++;
      log?.(`  Checksum: ${key}`);
    }
  }
  if (updated > 0) {
    createBackup(paths.productJson, tag, log);
    (0, import_fs7.writeFileSync)(paths.productJson, JSON.stringify(product, null, 2) + "\n");
  }
  return updated;
}

// src/routes-channel.js
var READY_GATE_TIMEOUT_MS = 1e4;
function buildEndpointCandidates({ host, port, externalUrl }) {
  const base2 = String(host || DEFAULT_HOST);
  const bracketed = base2.includes(":") && !base2.startsWith("[") ? `[${base2}]` : base2;
  const start = Number(port) || DEFAULT_PORT;
  const candidates = [];
  if (typeof externalUrl === "string" && externalUrl) candidates.push(externalUrl.replace(/\/+$/, ""));
  for (let offset2 = 0; offset2 < PORT_FALLBACK_SPAN; offset2++) {
    candidates.push(`http://${bracketed}:${start + offset2}`);
  }
  return [...new Set(candidates)];
}
function splitRedirect(redirect) {
  const rest = [];
  const services = [];
  const methods = [];
  for (const rule of redirect || []) {
    if (typeof rule !== "string" || !rule) continue;
    if (rule.startsWith("REST:")) rest.push(rule.slice(5));
    else if (rule.includes("/")) methods.push(rule);
    else services.push(rule);
  }
  return { rest, services, methods };
}
function buildRendererChannelSource({ candidates, byokRedirect }) {
  const { rest, services, methods } = splitRedirect(byokRedirect);
  return `var _byokCandidates=${JSON.stringify(candidates)};var _byokUrl=_byokCandidates[0];var _gateRest=${JSON.stringify(rest)},_gateSvc=new Set(${JSON.stringify(services)}),_gateMtd=new Set(${JSON.stringify(methods)});var _byokReadyGate=false,_byokWaiters=[],_byokEs=null,_byokEsUrl="",_byokRetry=1000,_byokProbing=false,_byokTimer=null;function _byokRelease(reason){if(_byokReadyGate)return;_byokReadyGate=true;globalThis.__byokRoutesReady=true;var waiters=_byokWaiters;_byokWaiters=[];for(var i=0;i<waiters.length;i++){try{waiters[i]()}catch(e){}}console.log("[BYOK] readiness gate released ("+reason+")")}setTimeout(function(){_byokRelease("timeout after ${READY_GATE_TIMEOUT_MS}ms, requests fall through to the official API")},${READY_GATE_TIMEOUT_MS});function __byokAwaitReady(){if(_byokReadyGate)return Promise.resolve();return new Promise(function(res){_byokWaiters.push(res)})}globalThis.__byokAwaitReady=__byokAwaitReady;function _byokGated(svc,mtd){if(_byokReadyGate)return false;return _gateSvc.has(svc)||_gateMtd.has(svc+"/"+mtd)}function _byokGatedPath(u){if(_byokReadyGate)return false;for(var i=0;i<_gateRest.length;i++){if(String(u).indexOf(_gateRest[i])!==-1)return true}return false}function _byokApplyRoutes(p){if(!p||typeof p!=="object")return;_restPaths=Array.isArray(p.rest)?p.rest:[];_restSet=new Set(_restPaths);var srv=p.server||{},target=srv.externalUrl||srv.url||_byokUrl;console.log("[BYOK] routes applied: endpoint="+target+", REST="+_restPaths.length+", ConnectRPC="+((p.services||[]).length+(p.methods||[]).length)+", BYOK="+(p.byokMode?"ON":"OFF"));globalThis.__byokGlassStatus&&globalThis.__byokGlassStatus(true,!!p.byokMode);_byokRelease("routes received");_byokUrl=_byokEsUrl||target;if(target&&target!==_byokEsUrl){_byokProbe(target).then(function(ok){if(!ok||target===_byokEsUrl)return;console.log("[BYOK] endpoint moved to "+target);_byokUrl=target;_byokConnect(target)})}}function _byokProbe(base){return new Promise(function(resolve){var done=false;var timer=setTimeout(function(){if(!done){done=true;resolve(false)}},1500);_origFetch(base+"/health",{cache:"no-store"}).then(function(r){return r.ok?r.json():null}).then(function(d){if(done)return;done=true;clearTimeout(timer);resolve(!!(d&&d.ok===true&&d.mode==="byok"))}).catch(function(){if(done)return;done=true;clearTimeout(timer);resolve(false)})})}function _byokConnect(base){try{if(_byokEs){_byokEs.close();_byokEs=null}}catch(e){}try{var es=new EventSource(base+"/byok/events");_byokEs=es;_byokEsUrl=base;_byokUrl=base;es.addEventListener("open",function(){_byokRetry=1000;globalThis.__byokGlassStatus&&globalThis.__byokGlassStatus(true,void 0)});es.addEventListener("refresh",function(){console.log("[BYOK] refresh event received");globalThis.__byokRefreshModels&&globalThis.__byokRefreshModels()});es.addEventListener(${JSON.stringify(SSE_EVENT_ROUTES)},function(ev){try{_byokApplyRoutes(JSON.parse(ev.data))}catch(e){console.warn("[BYOK] routes payload parse failed:",e&&e.message||e)}});es.addEventListener("error",function(){globalThis.__byokGlassStatus&&globalThis.__byokGlassStatus(false,void 0);if(_byokEs!==es)return;try{es.close()}catch(e){}_byokEs=null;_byokEsUrl="";_byokSchedule()})}catch(e){console.warn("[BYOK] EventSource init failed:",e&&e.message||e);_byokSchedule()}}function _byokSchedule(){if(_byokEs||_byokProbing||_byokTimer)return;var delay=_byokRetry;_byokRetry=Math.min(_byokRetry*2,10000);_byokTimer=setTimeout(function(){_byokTimer=null;_byokDiscover()},delay)}function _byokDiscover(){if(_byokProbing||_byokEs)return;_byokProbing=true;var i=0;(function next(){if(i>=_byokCandidates.length){_byokProbing=false;_byokSchedule();return}var base=_byokCandidates[i++];_byokProbe(base).then(function(ok){if(ok){_byokProbing=false;_byokConnect(base)}else{next()}})})()}_byokDiscover();`;
}
function buildNodeChannelSource() {
  return `var _chEs=null,_chPending=false,_chTimer=null,_chRetry=1000;function _chSchedule(){if(_chEs||_chPending||_chTimer)return;var d=_chRetry;_chRetry=Math.min(_chRetry*2,10000);_chTimer=setTimeout(function(){_chTimer=null;_chConnect()},d)}function _chReset(){_chEs=null;_chPending=false;_chSchedule()}function _chHandle(block){var lines=block.split("\\n"),ev="",data="";for(var i=0;i<lines.length;i++){var line=lines[i];if(line.indexOf("event: ")===0)ev=line.slice(7).trim();else if(line.indexOf("data: ")===0)data+=line.slice(6)}if(ev!==${JSON.stringify(SSE_EVENT_ROUTES)}||!data)return;try{applyPayload(JSON.parse(data))}catch(e){console.warn("[BYOK] "+PROCESS_LABEL+" routes payload parse failed: "+e.message)}}function _chConnect(){if(_chEs||_chPending)return;_chPending=true;var req;try{req=_directHttpRequest.call(_directHttpOwner,state.base+"/byok/events",{headers:{Accept:"text/event-stream","x-byok-route-source":PROCESS_LABEL},agent:false},function(res){_chPending=false;if(res.statusCode!==200){res.resume();_chSchedule();return}_chEs=req;_chRetry=1000;res.setEncoding("utf-8");var buf="";res.on("data",function(chunk){buf+=chunk;var parts=buf.split("\\n\\n");buf=parts.pop();for(var i=0;i<parts.length;i++)_chHandle(parts[i])});res.on("end",_chReset);res.on("error",_chReset)})}catch(e){_chPending=false;_chSchedule();return}req.on("error",_chReset);req.end()}_chConnect();`;
}

// src/patch-inject.js
var HOOK_MARKER = "__byokWrapTransport";
var HOOK_SOURCE_MARKER = "CURSOR-BYOK-HOOK-START";
var HOOK_CALL_SITE = `typeof globalThis.${HOOK_MARKER}==="function"?globalThis.${HOOK_MARKER}(`;
function isInjectPatched(code) {
  return code.slice(0, 12e4).includes(`/* ${HOOK_SOURCE_MARKER} */`) && code.includes(HOOK_CALL_SITE);
}
var ANCHORS = [
  "callback-client.js",
  "promise-client.js"
];
var SCAN_WINDOW = 2e3;
function skipString(source, i) {
  const quote = source[i];
  i++;
  while (i < source.length) {
    const ch = source[i];
    if (ch === "\\") {
      i += 2;
      continue;
    }
    if (ch === quote) return i + 1;
    if (quote === "`" && ch === "$" && source[i + 1] === "{") {
      i += 2;
      let depth = 1;
      while (i < source.length && depth > 0) {
        const c = source[i];
        if (c === "{") depth++;
        else if (c === "}") depth--;
        else if (c === '"' || c === "'" || c === "`") {
          i = skipString(source, i);
          continue;
        }
        i++;
      }
      continue;
    }
    i++;
  }
  return i;
}
function extractFunction(source, startOffset) {
  let i = startOffset;
  const len = source.length;
  while (i < len && source[i] !== "(") i++;
  if (i >= len) return null;
  let parenDepth = 0;
  while (i < len) {
    const ch = source[i];
    if (ch === "(") parenDepth++;
    else if (ch === ")") {
      parenDepth--;
      if (parenDepth === 0) {
        i++;
        break;
      }
    } else if (ch === '"' || ch === "'" || ch === "`") {
      i = skipString(source, i);
      continue;
    }
    i++;
  }
  while (i < len && source[i] !== "{") i++;
  if (i >= len) return null;
  let braceDepth = 0;
  while (i < len) {
    const ch = source[i];
    if (ch === "{") braceDepth++;
    else if (ch === "}") {
      braceDepth--;
      if (braceDepth === 0) return { start: startOffset, end: i + 1 };
    } else if (ch === '"' || ch === "'" || ch === "`") {
      i = skipString(source, i);
      continue;
    } else if (ch === "/" && i + 1 < len) {
      if (source[i + 1] === "/") {
        while (i < len && source[i] !== "\n") i++;
        continue;
      }
      if (source[i + 1] === "*") {
        i += 2;
        while (i + 1 < len && !(source[i] === "*" && source[i + 1] === "/")) i++;
        i += 2;
        continue;
      }
    }
    i++;
  }
  return null;
}
function findFunctionStarts(source, from, windowSize) {
  const results = [];
  const end = Math.min(from + windowSize, source.length);
  let i = from;
  while (i < end) {
    const idx = source.indexOf("function ", i);
    if (idx === -1 || idx >= end) break;
    if (idx > 0 && /[\w$]/.test(source[idx - 1])) {
      i = idx + 9;
      continue;
    }
    results.push(idx);
    i = idx + 9;
  }
  return results;
}
function buildHookPayload(hasGlass) {
  const routes = loadRoutes();
  const COLLECTOR_HOST = routes.collector.host;
  const COLLECTOR_PORT = routes.collector.port;
  const restRedirects = BASE_REDIRECT.filter((r) => r.startsWith("REST:")).map((r) => r.slice(5));
  const restListJson = JSON.stringify(restRedirects);
  const channel = buildRendererChannelSource({
    candidates: buildEndpointCandidates(routes.server),
    byokRedirect: BYOK_REDIRECT
  });
  const main = `(function(){if(globalThis.__byokReady)return;globalThis.__byokReady=true;var _hasGlass=${hasGlass ? "true" : "false"};var _q=globalThis.__byokQueue=[];var _collectorUrl="http://${COLLECTOR_HOST}:${COLLECTOR_PORT}";var _sending=false;var _down=false;var _restPaths=${restListJson};var _restSet=new Set(_restPaths);function __byokLog(e){if(_down)return;e._t=Date.now();_q.push(e);if(!_sending)_flush()}function _flush(){if(_down||!_q.length){_sending=false;return}_sending=true;var batch=_q.splice(0,50);fetch(_collectorUrl+"/hook",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(batch)}).then(function(){}).catch(function(){_down=true;_q.length=0;console.warn("[BYOK] Collector not reachable at "+_collectorUrl+", logging disabled for this session")}).finally(function(){if(!_down)setTimeout(_flush,100);else _sending=false})}function __byokMsgToJson(e){if(!e)return null;try{if(typeof e.toJson==="function")return e.toJson()}catch(x){}try{if(typeof e.toJsonString==="function")return JSON.parse(e.toJsonString())}catch(x){}return e}function __byokHeadersToObj(e){if(!e)return{};try{if(e instanceof Headers)return Object.fromEntries(e)}catch(x){}return typeof e==="object"?e:{}}function __byokCloneBody(r){if(!r.body)return Promise.resolve(null);try{return r.clone().text()}catch(e){return Promise.resolve(null)}}function __byokInjectWid(hdrs){var wid=typeof window!=="undefined"&&window.vscodeWindowId;if(typeof wid!=="number")return hdrs;var widStr=String(wid);try{if(hdrs&&typeof hdrs.set==="function"){hdrs.set("x-client-wid",widStr);return hdrs}if(hdrs&&typeof hdrs==="object"&&!Array.isArray(hdrs)){hdrs["x-client-wid"]=widStr;return hdrs}if(Array.isArray(hdrs)){hdrs.push(["x-client-wid",widStr]);return hdrs}}catch(e){}var h=new Headers();h.set("x-client-wid",widStr);return h}globalThis.__byokWrapTransport=function(t,n){return{unary:async function(e,r,i,o,s,a,c){if(_byokGated(e.typeName,r.name))await __byokAwaitReady();s=__byokInjectWid(s);var u=Math.random().toString(36).slice(2,10),l=Date.now();__byokLog({type:"unary_req",id:u,svc:e.typeName,mtd:r.name,hdr:__byokHeadersToObj(s),msg:__byokMsgToJson(a)});try{var d=await t.unary(e,r,i,o,s,a,c);__byokLog({type:"unary_res",id:u,dur:Date.now()-l,svc:e.typeName,mtd:r.name,msg:__byokMsgToJson(d.message)});return d}catch(d){__byokLog({type:"unary_err",id:u,dur:Date.now()-l,svc:e.typeName,mtd:r.name,err:d?.message||String(d),code:d?.code});throw d}},stream:async function(e,r,i,o,s,a,c){if(_byokGated(e.typeName,r.name))await __byokAwaitReady();s=__byokInjectWid(s);var u=Math.random().toString(36).slice(2,10),l=Date.now();__byokLog({type:"stream_req",id:u,svc:e.typeName,mtd:r.name,hdr:__byokHeadersToObj(s)});var f=(async function*(){var t=0;for await(var n of a){__byokLog({type:"stream_in",id:u,svc:e.typeName,mtd:r.name,idx:t++,msg:__byokMsgToJson(n)});yield n}})();try{var d=await t.stream(e,r,i,o,s,f,c),h=d.message;d.message=(async function*(){var t=0;for await(var n of h){__byokLog({type:"stream_out",id:u,svc:e.typeName,mtd:r.name,idx:t++,msg:__byokMsgToJson(n)});yield n}__byokLog({type:"stream_end",id:u,dur:Date.now()-l,svc:e.typeName,mtd:r.name,chunks:t})})();return d}catch(d){__byokLog({type:"stream_err",id:u,dur:Date.now()-l,svc:e.typeName,mtd:r.name,err:d?.message||String(d),code:d?.code});throw d}}}};var _origFetch=globalThis.fetch;function _byokFetch(args){var urlArg=args[0];var u=typeof urlArg==="string"?urlArg:(urlArg instanceof Request?urlArg.url:"");var init=args[1]||{};for(var i=0;i<_restPaths.length;i++){if(u.indexOf(_restPaths[i])!==-1){var id=Math.random().toString(36).slice(2,10);var ts=Date.now();var reqMethod=init.method||(urlArg instanceof Request?urlArg.method:"GET")||"GET";var reqHeaders=__byokHeadersToObj(urlArg instanceof Request?urlArg.headers:init.headers);var reqBody=urlArg instanceof Request&&urlArg.body?urlArg.body:(init.body||null);var path=_restPaths[i];var newUrl=_byokUrl+(u.match(/^https?:\\/\\/[^/]*/)?u.replace(/^https?:\\/\\/[^/]*/,""):"/");__byokLog({type:"rest_redirect",id:id,path:path,originalUrl:u,redirectUrl:newUrl,method:reqMethod,reqHeaders:reqHeaders,reqBody:reqBody});var newInit=Object.assign({},init);newInit.headers=__byokInjectWid(newInit.headers);var newArgs=[newUrl,newInit];for(var j=2;j<args.length;j++)newArgs.push(args[j]);return _origFetch.apply(globalThis,newArgs).then(function(resp){var r=resp.clone();__byokLog({type:"rest_response",id:id,path:path,status:r.status,resHeaders:__byokHeadersToObj(r.headers)});__byokCloneBody(r).then(function(text){if(text){__byokLog({type:"rest_body",id:id,path:path,body:text})}}).catch(function(){});return resp}).catch(function(err){__byokLog({type:"rest_error",id:id,path:path,error:err?.message||String(err)});throw err})}}if(u.indexOf(_byokUrl)===0){var nInit=Object.assign({},init);nInit.headers=__byokInjectWid(nInit.headers);var nArgs=[urlArg,nInit];for(var k=2;k<args.length;k++)nArgs.push(args[k]);return _origFetch.apply(globalThis,nArgs)}return _origFetch.apply(globalThis,args)}globalThis.fetch=function(){var args=Array.prototype.slice.call(arguments);var first=args[0];var probe=typeof first==="string"?first:(first instanceof Request?first.url:"");if(_byokGatedPath(probe))return __byokAwaitReady().then(function(){return _byokFetch(args)});return _byokFetch(args)};`;
  const pickerRefresh = `(function(){if(!document.body)return;var _prObs=new MutationObserver(function(){var inp=document.querySelector('input[placeholder="Search models"]');if(!inp)return;var wrap=inp.closest(".ui-input-group");if(!wrap||wrap.querySelector("#byok-refresh-btn"))return;var btn=document.createElement("button");btn.type="button";btn.id="byok-refresh-btn";var _rDonor=_hasGlass?document.querySelector("button.ui-icon-button"):null;btn.className=_rDonor?_rDonor.className:"ui-icon-button";btn.dataset.variant="default";btn.dataset.size="sm";btn.setAttribute("aria-label","Refresh Models");btn.style.cssText="margin-right:4px;flex-shrink:0;cursor:pointer;";btn.textContent="\\u21BB";btn.addEventListener("click",function(ev){ev.stopPropagation();globalThis.__byokRefreshModels&&globalThis.__byokRefreshModels();console.log("[BYOK] manual refresh from picker")});wrap.appendChild(btn)});_prObs.observe(document.body,{childList:true,subtree:true})})();`;
  const glassStatus = `(function(){var _bEl=null,_bTip=null,_bSrv=false,_bMode=false;function _bCreate(){var e=document.createElement("button");e.type="button";e.className="ui-icon-button";e.dataset.variant="default";e.dataset.size="lg";e.id="byok-glass-status";if(_hasGlass){var donor=document.querySelector("button.ui-icon-button");if(donor){e.className=donor.className}else{e.className="ui-icon-button"}e.style.cssText="width:auto;min-width:auto;font-size:10px;gap:2px;white-space:nowrap;"}else{e.className="ui-icon-button";e.dataset.variant="default";e.dataset.size="lg";e.style.cssText="font-size:11px;gap:3px;width:auto;white-space:nowrap;"}e.addEventListener("click",function(){fetch(_byokUrl+"/byok/toggle",{method:"POST"}).then(function(r){return r.json()}).then(function(d){console.log("[BYOK] toggle \\u2192",d.byokMode?"ON":"OFF")}).catch(function(e){console.warn("[BYOK] toggle failed:",e&&e.message||e)})});e.addEventListener("mouseenter",function(){_bShowTip()});e.addEventListener("mouseleave",function(){_bHideTip()});return e}function _bShowTip(){if(_bTip||!_bEl)return;var t=document.createElement("div");t.className="ui-tooltip";t.setAttribute("role","tooltip");t.style.cssText="position:fixed;z-index:99999;pointer-events:none;box-sizing:border-box;width:max-content;max-width:320px;background:var(--cursor-bg-elevated);color:var(--cursor-text-primary);border:var(--ui-tooltip-border-width,1px) solid var(--cursor-stroke-primary);border-radius:var(--ui-tooltip-border-radius,var(--cursor-radius-lg));box-shadow:var(--ui-tooltip-box-shadow,var(--cursor-box-shadow-popup));padding:var(--ui-tooltip-padding-y,var(--cursor-spacing-1-5)) var(--ui-tooltip-padding-x,var(--cursor-spacing-2-5));font-size:var(--ui-tooltip-font-size,var(--cursor-font-size-base));line-height:var(--ui-tooltip-line-height,var(--cursor-line-height-base));letter-spacing:var(--ui-tooltip-letter-spacing,var(--cursor-letter-spacing-base));white-space:pre-line;";t.textContent=(_bSrv?"Server online":"Server offline")+" \\u00B7 "+(_bMode?"BYOK ON":"BYOK OFF");document.body.appendChild(t);var r=_bEl.getBoundingClientRect();var tw=t.offsetWidth,th=t.offsetHeight;t.style.left=Math.round(r.left+r.width/2-tw/2)+"px";t.style.top=Math.round(r.top-th-6)+"px";_bTip=t}function _bHideTip(){if(_bTip){_bTip.remove();_bTip=null}}function _bRender(){if(!_bEl)return;var icon=_bSrv?"\\u2713":"\\u2717";var glyph=_bMode?"\\u25C9":"\\u25CB";_bEl.textContent=icon+" BYOK "+glyph}function _bInject(){if(_bEl&&document.contains(_bEl))return;var footer=document.querySelector('[data-component="glass-sidebar-footer"]');if(footer){var gear=footer.querySelector("button.ui-icon-button");if(gear&&gear.parentElement){_bEl=_bCreate();_bRender();gear.parentElement.insertBefore(_bEl,gear);return}}var trigger=document.querySelector(".glass-sidebar-footer-account-trigger");var endIcon=trigger&&trigger.querySelector(".ui-sidebar-menu-button-end");if(trigger&&endIcon){_bEl=_bCreate();_bRender();trigger.insertBefore(_bEl,endIcon);return}var actOld=document.querySelector(".glass-sidebar-footer-actions-right");if(actOld){_bEl=_bCreate();_bRender();actOld.insertBefore(_bEl,actOld.firstChild)}}if(document.body){var _bObs=new MutationObserver(function(){_bInject()});_bObs.observe(document.body,{childList:true,subtree:true});_bInject()}globalThis.__byokGlassStatus=function(srv,mode){if(srv!==void 0)_bSrv=srv;if(mode!==void 0)_bMode=mode;_bRender()}})();`;
  const refreshLogic = `globalThis.__byokRefreshModels=function(){if(globalThis.__byokAiSvc&&typeof globalThis.__byokAiSvc.refreshDefaultModels==="function"){try{var p=globalThis.__byokAiSvc.refreshDefaultModels();console.log("[BYOK] refreshDefaultModels() invoked via captured aiService ref");if(p&&typeof p.then==="function")p.catch(function(e){console.warn("[BYOK] refreshDefaultModels failed:",e&&e.message||e)});return"service"}catch(e){console.warn("[BYOK] refreshDefaultModels threw:",e&&e.message||e)}}var btn=document.querySelector('[title="Refresh model list"]');if(btn&&typeof btn.click==="function"){btn.click();console.log("[BYOK] refresh triggered via DOM click fallback");return"click"}console.warn("[BYOK] no refresh mechanism available (aiService not captured, picker not visible)");return"none"};`;
  return main + refreshLogic + channel + pickerRefresh + glassStatus + `console.log("[BYOK] Hook loaded, collector="+_collectorUrl+", byok candidates="+_byokCandidates.join(", "))})()`;
}
function findTarget(code, log) {
  let anchorOffset = -1;
  for (const anchor of ANCHORS) {
    const idx = code.indexOf(anchor);
    if (idx !== -1) {
      anchorOffset = idx;
      log?.(`  Anchor: "${anchor}" at ${idx}`);
      break;
    }
  }
  if (anchorOffset === -1) throw new Error("ConnectRPC client module anchor not found");
  const funcStarts = findFunctionStarts(code, anchorOffset, SCAN_WINDOW);
  let dispatcherName = null, dispatcherBounds = null;
  for (const fStart of funcStarts) {
    const bounds = extractFunction(code, fStart);
    if (!bounds) continue;
    const body = code.slice(bounds.start, bounds.end);
    if (body.includes(".Unary") && body.includes(".ServerStreaming") && body.includes(".BiDiStreaming")) {
      let ast;
      try {
        ast = parse3(body, { ecmaVersion: 2022, sourceType: "script" });
      } catch {
        continue;
      }
      const decl = ast.body[0];
      if (decl?.type === "FunctionDeclaration" && decl.id?.name) {
        dispatcherName = decl.id.name;
        dispatcherBounds = bounds;
        log?.(`  Dispatcher: ${dispatcherName}`);
        break;
      }
    }
  }
  if (!dispatcherName) throw new Error("Dispatcher function not found");
  const postStarts = findFunctionStarts(code, dispatcherBounds.end, SCAN_WINDOW);
  for (const fStart of postStarts) {
    const bounds = extractFunction(code, fStart);
    if (!bounds) continue;
    const body = code.slice(bounds.start, bounds.end);
    if (!body.includes(dispatcherName)) continue;
    let ast;
    try {
      ast = parse3(body, { ecmaVersion: 2022, sourceType: "script" });
    } catch {
      continue;
    }
    const decl = ast.body[0];
    if (!decl || decl.type !== "FunctionDeclaration") continue;
    if (decl.params?.length !== 2) continue;
    if (decl.params.some((p) => p.type !== "Identifier")) continue;
    const p0 = decl.params[0].name, p1 = decl.params[1].name;
    const stmts = decl.body?.body;
    if (!stmts || stmts.length !== 1 || stmts[0].type !== "ReturnStatement") continue;
    const ret = stmts[0].argument;
    if (!ret || ret.type !== "CallExpression") continue;
    if (ret.callee?.type !== "Identifier" || ret.callee.name !== dispatcherName) continue;
    if (ret.arguments?.length !== 2) continue;
    if (ret.arguments[0].name !== p0 || ret.arguments[1].name !== p1) continue;
    return { name: decl.id.name, bounds, source: body, paramService: p0, paramTransport: p1, innerFn: dispatcherName };
  }
  throw new Error(`No delegate wrapper found for "${dispatcherName}"`);
}
function captureAiServiceRef(code, log) {
  const NEEDLE = ".aiService.refreshDefaultModels(";
  const replacements = [];
  let scanFrom = 0;
  let candidateCount = 0;
  while (true) {
    const dotIdx = code.indexOf(NEEDLE, scanFrom);
    if (dotIdx === -1) break;
    candidateCount++;
    scanFrom = dotIdx + NEEDLE.length;
    let i = dotIdx - 1;
    while (i >= 0 && /[a-zA-Z0-9_$]/.test(code[i])) i--;
    const xStart = i + 1;
    if (xStart === dotIdx) continue;
    let ast;
    try {
      ast = parseExpressionAt2(code, xStart, { ecmaVersion: 2022, sourceType: "module" });
    } catch {
      continue;
    }
    if (ast.type === "SequenceExpression") ast = ast.expressions[0];
    if (ast?.type !== "CallExpression") continue;
    const c = ast.callee;
    if (c?.type !== "MemberExpression") continue;
    if (c.property?.type !== "Identifier" || c.property.name !== "refreshDefaultModels") continue;
    if (c.object?.type !== "MemberExpression") continue;
    if (c.object.property?.type !== "Identifier" || c.object.property.name !== "aiService") continue;
    const inner = c.object.object;
    if (inner.type !== "Identifier" && inner.type !== "ThisExpression") continue;
    const xText = code.slice(inner.start, inner.end);
    replacements.push({
      start: inner.start,
      end: c.object.end,
      text: `(globalThis.__byokAiSvc=${xText}.aiService)`
    });
  }
  replacements.sort((a, b) => b.start - a.start);
  let result = code;
  for (const r of replacements) {
    result = result.slice(0, r.start) + r.text + result.slice(r.end);
  }
  log?.(`  aiService ref capture: ${replacements.length}/${candidateCount} call sites (AST validated)`);
  return result;
}
function patchMaxModeToggle(code, log) {
  const BODY_ANCHOR = '"MAX Mode"';
  const anchorIdx = code.indexOf(BODY_ANCHOR);
  if (anchorIdx === -1) {
    log?.('  [max-mode-toggle] anchor "MAX Mode" not found \u2014 skipping');
    return code;
  }
  const funcStarts = findFunctionStarts(code, Math.max(0, anchorIdx - 3e3), 3e3);
  let targetFn = null;
  for (const fStart of funcStarts) {
    const bounds = extractFunction(code, fStart);
    if (!bounds || bounds.end < anchorIdx) continue;
    if (bounds.start > anchorIdx) break;
    const body = code.slice(bounds.start, bounds.end);
    if (body.includes(BODY_ANCHOR) && body.includes("setMaxMode")) {
      targetFn = bounds;
      break;
    }
  }
  if (!targetFn) {
    log?.("  [max-mode-toggle] MaxModeToggle function not found \u2014 skipping");
    return code;
  }
  const fnSource = code.slice(targetFn.start, targetFn.end);
  let ast;
  try {
    ast = parse3(fnSource, { ecmaVersion: 2022, sourceType: "script" });
  } catch (e) {
    log?.(`  [max-mode-toggle] AST parse failed: ${e.message} \u2014 skipping`);
    return code;
  }
  const fnDecl = ast.body[0];
  if (!fnDecl || fnDecl.type !== "FunctionDeclaration" || !fnDecl.id?.name) {
    log?.("  [max-mode-toggle] unexpected AST shape \u2014 skipping");
    return code;
  }
  let contextHookName = null;
  function walkForContextHook(node) {
    if (!node || typeof node !== "object") return;
    if (node.type === "VariableDeclarator" && node.id?.type === "ObjectPattern" && node.init?.type === "CallExpression") {
      const hasSetMaxMode = node.id.properties?.some((p) => p.key?.name === "setMaxMode");
      if (hasSetMaxMode && node.init.callee?.type === "Identifier") {
        contextHookName = node.init.callee.name;
      }
    }
    for (const key of Object.keys(node)) {
      if (contextHookName) return;
      const child = node[key];
      if (Array.isArray(child)) child.forEach((c) => {
        if (c && c.type) walkForContextHook(c);
      });
      else if (child && child.type) walkForContextHook(child);
    }
  }
  walkForContextHook(fnDecl);
  if (!contextHookName) {
    log?.("  [max-mode-toggle] context hook (setMaxMode destructor) not found via AST \u2014 skipping");
    return code;
  }
  const bodyStart = targetFn.start + fnDecl.body.start + 1;
  const guard = `const{models:_ms}=${contextHookName}();if(!_ms.some(_m=>_m.name!=="default"&&_m.supportsMaxMode))return null;`;
  const result = code.slice(0, bodyStart) + guard + code.slice(bodyStart);
  log?.(`  [max-mode-toggle] injected guard into ${fnDecl.id.name}() via ${contextHookName}(): return null when no model supports Max Mode`);
  return result;
}
var EXTENSION_ID = "cometix-space.cursor2plus";
function patchKatexMathSvgSanitizer(code, log) {
  const requiredTags = ["math", "semantics", "mrow", "mi", "mo", "mn", "mtext", "mfrac", "msqrt", "mroot", "annotation"];
  const svgTags = ["svg", "path", "line"];
  const svgAttrs = ["xmlns", "width", "height", "viewBox", "viewbox", "preserveAspectRatio", "preserveaspectratio"];
  const lineAttrs = ["x1", "y1", "x2", "y2", "stroke-width", "strokeWidth"];
  function literalString(node) {
    return node && node.type === "Literal" && typeof node.value === "string" ? node.value : void 0;
  }
  function propertyName(prop) {
    if (!prop || prop.type !== "Property" || prop.computed) return void 0;
    if (prop.key.type === "Identifier") return prop.key.name;
    return literalString(prop.key);
  }
  function arrayStrings(node) {
    if (!node || node.type !== "ArrayExpression") return void 0;
    const values = [];
    for (let i = 0; i < node.elements.length; i++) {
      const value = literalString(node.elements[i]);
      if (value === void 0) return void 0;
      values.push(value);
    }
    return values;
  }
  function firstExpr(expr) {
    return expr && expr.type === "SequenceExpression" ? expr.expressions[0] : expr;
  }
  function containsAll(values, required) {
    for (let i = 0; i < required.length; i++) {
      if (!values.includes(required[i])) return false;
    }
    return true;
  }
  function tagAssignmentValues(expr) {
    const candidate = firstExpr(expr);
    if (!candidate || candidate.type !== "AssignmentExpression" || candidate.operator !== "=") return void 0;
    if (!candidate.left || candidate.left.type !== "Identifier") return void 0;
    const values = arrayStrings(candidate.right);
    if (!values || !containsAll(values, requiredTags)) return void 0;
    return { assignment: candidate, values };
  }
  function attributeSchemaInfo(node) {
    if (!node || node.type !== "ObjectExpression") return void 0;
    const props = /* @__PURE__ */ Object.create(null);
    for (let i = 0; i < node.properties.length; i++) {
      const prop = node.properties[i];
      const key = propertyName(prop);
      if (key) props[key] = prop.value;
    }
    const requiredKeys = ["math", "semantics", "annotation", "mfrac", "msqrt", "mroot", "mtd"];
    for (let i = 0; i < requiredKeys.length; i++) {
      if (!props[requiredKeys[i]]) return void 0;
    }
    const mathAttrs = arrayStrings(props.math) || [];
    const mtdAttrs = arrayStrings(props.mtd) || [];
    const mfracAttrs = arrayStrings(props.mfrac) || [];
    if (!mathAttrs.includes("xmlns") || !mathAttrs.includes("display")) return void 0;
    if (!mtdAttrs.includes("columnalign")) return void 0;
    if (!mfracAttrs.includes("linethickness")) return void 0;
    return { node, props };
  }
  function svgPropertySource(key) {
    if (key === "svg") return `svg:${JSON.stringify(svgAttrs)}`;
    if (key === "path") return 'path:["d"]';
    if (key === "line") return `line:${JSON.stringify(lineAttrs)}`;
    throw new Error(`unknown KaTeX SVG sanitizer property: ${key}`);
  }
  function assignmentStartBeforeArray(arrayStart) {
    let i = arrayStart - 1;
    while (i >= 0 && /\s/.test(code[i])) i--;
    if (code[i] !== "=") return -1;
    i--;
    while (i >= 0 && /\s/.test(code[i])) i--;
    const end = i + 1;
    while (i >= 0 && /[a-zA-Z0-9_$]/.test(code[i])) i--;
    const start = i + 1;
    return start === end ? -1 : start;
  }
  const edits = [];
  const seenTagStarts = [];
  const seenAttrStarts = [];
  let candidateCount = 0;
  let scanFrom = 0;
  while (true) {
    const msqrtIdx = code.indexOf('"msqrt"', scanFrom);
    if (msqrtIdx === -1) break;
    scanFrom = msqrtIdx + 7;
    candidateCount++;
    const arrayStart = code.lastIndexOf("[", msqrtIdx);
    if (arrayStart === -1) continue;
    const exprStart = assignmentStartBeforeArray(arrayStart);
    if (exprStart === -1 || seenTagStarts.includes(exprStart)) continue;
    let parsed;
    try {
      parsed = parseExpressionAt2(code, exprStart, { ecmaVersion: 2022, sourceType: "script" });
    } catch {
      continue;
    }
    const tagInfo = tagAssignmentValues(parsed);
    if (!tagInfo) continue;
    seenTagStarts.push(exprStart);
    const missingTags = [];
    for (let i = 0; i < svgTags.length; i++) {
      if (!tagInfo.values.includes(svgTags[i])) missingTags.push(svgTags[i]);
    }
    if (missingTags.length > 0) {
      const parts = [];
      for (let i = 0; i < missingTags.length; i++) parts.push(JSON.stringify(missingTags[i]));
      edits.push({
        start: tagInfo.assignment.right.end - 1,
        end: tagInfo.assignment.right.end - 1,
        text: `${tagInfo.values.length > 0 ? "," : ""}${parts.join(",")}`
      });
    }
    const expressions = parsed.type === "SequenceExpression" ? parsed.expressions : [parsed];
    for (let i = 0; i < expressions.length; i++) {
      const expr = expressions[i];
      if (!expr || expr.type !== "AssignmentExpression" || expr.operator !== "=") continue;
      if (!expr.left || expr.left.type !== "Identifier") continue;
      const attrInfo = attributeSchemaInfo(expr.right);
      if (!attrInfo || seenAttrStarts.includes(expr.right.start)) continue;
      seenAttrStarts.push(expr.right.start);
      const existingKeys = [];
      for (let j = 0; j < expr.right.properties.length; j++) {
        const key = propertyName(expr.right.properties[j]);
        if (key) existingKeys.push(key);
      }
      const missingProps = [];
      for (let j = 0; j < svgTags.length; j++) {
        if (!existingKeys.includes(svgTags[j])) missingProps.push(svgTags[j]);
      }
      if (missingProps.length > 0) {
        const propSources = [];
        for (let j = 0; j < missingProps.length; j++) propSources.push(svgPropertySource(missingProps[j]));
        edits.push({
          start: expr.right.end - 1,
          end: expr.right.end - 1,
          text: `${expr.right.properties.length > 0 ? "," : ""}${propSources.join(",")}`
        });
      }
      break;
    }
  }
  if (seenTagStarts.length === 0) {
    log?.(`  [katex-svg] WARNING: no AST-validated KaTeX math tag allowlist found (${candidateCount} candidate(s))`);
    return code;
  }
  if (seenAttrStarts.length === 0) {
    log?.(`  [katex-svg] WARNING: no AST-validated KaTeX math attribute schema found (${seenTagStarts.length} tag allowlist(s))`);
    return code;
  }
  if (edits.length === 0) {
    log?.(`  [katex-svg] already patched (${seenTagStarts.length} math sanitizer schema(s))`);
    return code;
  }
  edits.sort((a, b) => b.start - a.start);
  let result = code;
  for (let i = 0; i < edits.length; i++) {
    const edit = edits[i];
    result = result.slice(0, edit.start) + edit.text + result.slice(edit.end);
  }
  log?.(`  [katex-svg] patched ${seenTagStarts.length} KaTeX math sanitizer schema(s), ${edits.length} insertion(s)`);
  return result;
}
function patchGlassExtensionAllowlist(code, log) {
  const allowlists = [
    {
      label: "core",
      probe: '"vscode.github-authentication"',
      members: ["anysphere.cursor-deeplink", "anysphere.cursor-resolver-helper", "anysphere.cursor-socket", "vscode.github-authentication"]
    },
    {
      label: "remote",
      probe: '"anysphere.remote-wsl"',
      members: ["anysphere.remote-ssh", "anysphere.remote-wsl", "anysphere.remote-containers"]
    }
  ];
  function definitionStart(arrayStart) {
    let i = arrayStart - 1;
    while (i >= 0 && /\s/.test(code[i])) i--;
    if (code[i] !== "=") return -1;
    i--;
    while (i >= 0 && /\s/.test(code[i])) i--;
    const end = i + 1;
    while (i >= 0 && /[a-zA-Z0-9_$]/.test(code[i])) i--;
    const start = i + 1;
    return start === end ? -1 : start;
  }
  function allowlistArray(expr, required) {
    const node = expr && expr.type === "SequenceExpression" ? expr.expressions[0] : expr;
    if (!node || node.type !== "AssignmentExpression" || node.operator !== "=") return void 0;
    if (!node.left || node.left.type !== "Identifier") return void 0;
    const array = node.right;
    if (!array || array.type !== "ArrayExpression") return void 0;
    if (!array.elements.length || array.elements[0].type !== "SpreadElement") return void 0;
    const values = [];
    for (let i = 1; i < array.elements.length; i++) {
      const element = array.elements[i];
      if (!element || element.type !== "Literal" || typeof element.value !== "string") return void 0;
      values.push(element.value);
    }
    for (let i = 0; i < required.length; i++) {
      if (!values.includes(required[i])) return void 0;
    }
    return { name: node.left.name, array, values };
  }
  const edits = [];
  const report = [];
  for (let a = 0; a < allowlists.length; a++) {
    const spec = allowlists[a];
    const matches = [];
    const seen = [];
    let scanFrom = 0;
    while (true) {
      const probeIdx = code.indexOf(spec.probe, scanFrom);
      if (probeIdx === -1) break;
      scanFrom = probeIdx + spec.probe.length;
      const arrayStart = code.lastIndexOf("[", probeIdx);
      if (arrayStart === -1) continue;
      const exprStart = definitionStart(arrayStart);
      if (exprStart === -1 || seen.includes(exprStart)) continue;
      let parsed;
      try {
        parsed = parseExpressionAt2(code, exprStart, { ecmaVersion: 2022, sourceType: "script" });
      } catch {
        continue;
      }
      const found = allowlistArray(parsed, spec.members);
      if (!found) continue;
      seen.push(exprStart);
      matches.push(found);
    }
    if (matches.length === 0) {
      throw new Error(`glass-allowlist: ${spec.label} extension allowlist array not found`);
    }
    if (matches.length > 1) {
      const names = matches.map((m) => m.name).join(", ");
      throw new Error(`glass-allowlist: ${spec.label} extension allowlist array is ambiguous (${names})`);
    }
    const target = matches[0];
    if (target.values.includes(EXTENSION_ID)) {
      report.push(`${spec.label}=${target.name} (already present)`);
      continue;
    }
    edits.push({ start: target.array.end - 1, text: `,${JSON.stringify(EXTENSION_ID)}` });
    report.push(`${spec.label}=${target.name}`);
  }
  edits.sort((x, y) => y.start - x.start);
  let result = code;
  for (let i = 0; i < edits.length; i++) {
    result = result.slice(0, edits[i].start) + edits[i].text + result.slice(edits[i].start);
  }
  log?.(`  [glass-allowlist] ${EXTENSION_ID} in ${allowlists.length} allowlist array(s): ${report.join(", ")}`);
  return result;
}
function checkGlassExtensionAllowlist(code) {
  let detail = "";
  try {
    patchGlassExtensionAllowlist(code, (msg) => {
      detail = msg.trim();
    });
    return { ok: true, detail };
  } catch (e) {
    return { ok: false, detail: e.message };
  }
}
function patchSingleWorkbench(filePath, label, paths, log) {
  const code = (0, import_fs8.readFileSync)(filePath, "utf-8");
  if (isInjectPatched(code)) {
    log?.(`[inject] ${label}: already patched`);
    return;
  }
  if (code.includes(HOOK_MARKER) || code.includes(HOOK_SOURCE_MARKER)) {
    throw new Error(`${label}: partial renderer hook detected (payload/call-site mismatch)`);
  }
  const target = findTarget(code, log);
  log?.(`  Target: function ${target.name}(${target.paramService}, ${target.paramTransport})`);
  const { name: fnName, paramService: ps, paramTransport: pt, innerFn } = target;
  const replacement = `function ${fnName}(${ps},${pt}){return ${innerFn}(${ps},(typeof globalThis.${HOOK_MARKER}==="function"?globalThis.${HOOK_MARKER}(${pt},${ps}.typeName):${pt}))}`;
  let patched = code.slice(0, target.bounds.start) + replacement + code.slice(target.bounds.end);
  patched = captureAiServiceRef(patched, log);
  const payload = buildHookPayload(paths.hasGlass);
  patched = `/* CURSOR-BYOK-HOOK-START */${payload}/* CURSOR-BYOK-HOOK-END */;${patched}`;
  patched = patchMaxModeToggle(patched, log);
  patched = patchKatexMathSvgSanitizer(patched, log);
  patched = patchGlassExtensionAllowlist(patched, log);
  if (!patched.includes(HOOK_MARKER)) throw new Error(`Verification failed for ${label}`);
  createBackup(filePath, "inject", log);
  (0, import_fs8.writeFileSync)(filePath, patched);
  updateChecksums(paths, [filePath], "inject", log);
}
function patchInject(paths, log) {
  const targets = [
    { path: paths.workbenchJs, label: "desktop" },
    { path: paths.glassJs, label: "glass" }
  ];
  for (const { path, label } of targets) {
    if (!(0, import_fs8.existsSync)(path)) {
      log?.(`[inject] ${label}: not found, skipping (pre-3.8)`);
      continue;
    }
    log?.(`[inject] Patching ${label} workbench.js...`);
    patchSingleWorkbench(path, label, paths, log);
  }
  log?.("[inject] Done");
}

// src/patch-always-local.js
var import_fs9 = require("fs");

// src/node-http11-router.js
var HTTP11_ROUTER_VERSION_MARKER = "__byokHttp11RouterV3";
var HTTP11_ROUTER_SOURCE_MARKER = "BYOK-HTTP11-ROUTER-V3";
function buildNodeHttp11RouterPayload({ guardMarker, processLabel }) {
  const fallbackHost = JSON.stringify(DEFAULT_HOST);
  const fallbackPort = String(DEFAULT_PORT);
  const ccursorDir = JSON.stringify(CCURSOR_DIR_NAME);
  const routesFile = JSON.stringify(ROUTES_FILE_NAME);
  const guard = JSON.stringify(guardMarker);
  const label = JSON.stringify(processLabel);
  const versionMarker = JSON.stringify(HTTP11_ROUTER_VERSION_MARKER);
  return `/* ${HTTP11_ROUTER_SOURCE_MARKER} */
(function(){
  var VERSION_MARKER=${versionMarker},GUARD_MARKER=${guard},PROCESS_LABEL=${label};
  if(globalThis[VERSION_MARKER]){globalThis[GUARD_MARKER]=true;return;}
  globalThis[VERSION_MARKER]=true;globalThis[GUARD_MARKER]=true;
  var _http=require("http"),_https=require("https"),_fs=require("fs"),_path=require("path"),_os=require("os"),_module=require("module");
  var _proxyHttpRequest=_http.request,_proxyHttpsRequest=_https.request;
  var _proxyHttpGet=_http.get,_proxyHttpsGet=_https.get;
  var _directHttpOwner=_http.__vscodeOriginal||_http;
  var _directHttpRequest=(_http.__vscodeOriginal&&_http.__vscodeOriginal.request)||_proxyHttpRequest;
  var ROUTES_PATH=_path.join(_os.homedir(),${ccursorDir},${routesFile});
  var FALLBACK_HOST=${fallbackHost},FALLBACK_PORT=${fallbackPort};
  var _title=String(process.env.VSCODE_PROCESS_TITLE||""),_widMatch=_title.match(/\\[(\\d+)-\\d+\\]/),WINDOW_ID=_widMatch?_widMatch[1]:null;
  var state={host:FALLBACK_HOST,port:FALLBACK_PORT,base:"http://"+FALLBACK_HOST+":"+FALLBACK_PORT,svcSet:new Set(),methodSet:new Set(),restSet:new Set(),ruleCount:0,restCount:0};
  function baseUrl(host,port){var h=String(host);if(h.indexOf(":")!==-1&&h.charAt(0)!=="[")h="["+h+"]";return"http://"+h+":"+port;}
  function emptyState(){return{host:FALLBACK_HOST,port:FALLBACK_PORT,base:baseUrl(FALLBACK_HOST,FALLBACK_PORT),svcSet:new Set(),methodSet:new Set(),restSet:new Set(),ruleCount:0,restCount:0};}
  function loadConfig(){try{
    var cfg=JSON.parse(_fs.readFileSync(ROUTES_PATH,"utf-8"));
    var host=cfg&&cfg.server&&typeof cfg.server.host==="string"&&cfg.server.host.trim()?cfg.server.host.trim():FALLBACK_HOST;
    var rawPort=cfg&&cfg.server&&cfg.server.port;
    var port=(typeof rawPort==="number"||typeof rawPort==="string")&&String(rawPort).trim()?rawPort:FALLBACK_PORT;
    var rules=cfg&&Array.isArray(cfg.redirect)?cfg.redirect:[];
    var svcSet=new Set(),methodSet=new Set(),restSet=new Set(),ruleCount=0,restCount=0;
    for(var i=0;i<rules.length;i++){var rule=rules[i];if(typeof rule!=="string")continue;
      if(rule.indexOf("REST:")===0){restSet.add(rule.slice(5));restCount++;}
      else if(rule.indexOf("/")!==-1){methodSet.add(rule);ruleCount++;}
      else{svcSet.add(rule);ruleCount++;}}
    return{host:host,port:port,base:baseUrl(host,port),svcSet:svcSet,methodSet:methodSet,restSet:restSet,ruleCount:ruleCount,restCount:restCount};
  }catch(e){return emptyState();}}
  function applyState(event){state=loadConfig();console.log("[BYOK] "+PROCESS_LABEL+" "+event+" -> "+state.base+" (ConnectRPC="+state.ruleCount+", REST="+state.restCount+")");}
  function applyPayload(payload){
    if(!payload||typeof payload!=="object")return;
    var srv=payload.server||{},host=srv.host||state.host,port=srv.port||state.port;
    var svcSet=new Set(payload.services||[]),methodSet=new Set(payload.methods||[]),restSet=new Set(payload.rest||[]);
    var moved=String(host)!==String(state.host)||String(port)!==String(state.port);
    state={host:host,port:port,base:baseUrl(host,port),svcSet:svcSet,methodSet:methodSet,restSet:restSet,ruleCount:svcSet.size+methodSet.size,restCount:restSet.size};
    console.log("[BYOK] "+PROCESS_LABEL+" routes pushed -> "+state.base+" (ConnectRPC="+state.ruleCount+", REST="+state.restCount+")");
    // Endpoint moved (port fallback): drop the stream so the channel
    // resubscribes against the new base instead of a dead socket.
    if(moved){if(_chEs){try{_chEs.destroy();}catch(e){}}_chRetry=200;_chReset();}
  }
  applyState("routes loaded");
  // routes.json \u8F6E\u8BE2\u662F\u515C\u5E95: server \u79BB\u7EBF\u671F\u95F4\u53EA\u6709\u5B83\u80FD\u53CD\u6620\u5916\u90E8\u6539\u52A8\u3002
  // server \u5728\u7EBF\u65F6\u7531 routes channel \u5373\u65F6\u4E0B\u53D1, \u6D88\u9664 2s \u9648\u65E7\u7A97\u53E3\u3002
  try{_fs.watchFile(ROUTES_PATH,{interval:2000,persistent:false},function(){applyState("routes reloaded");});}catch(e){console.warn("[BYOK] "+PROCESS_LABEL+" watchFile failed: "+e.message);}
  function normalizeHost(host){return String(host||"").trim().replace(/^\\[|\\]$/g,"").toLowerCase();}
  function isCursorApiHost(host){host=normalizeHost(host);return/(^|\\.)api[234]\\.cursor\\.sh$|(^|\\.)api5\\.cursor\\.sh$|(^|\\.)gcpp\\.cursor\\.sh$|^api\\.playground\\.cursor\\.sh$/.test(host);}
  function pathOnly(pathname){pathname=String(pathname||"");var hash=pathname.indexOf("#");if(hash!==-1)pathname=pathname.slice(0,hash);var query=pathname.indexOf("?");return query===-1?pathname:pathname.slice(0,query);}
  function shouldRedirect(pathname){pathname=pathOnly(pathname);if(!pathname||pathname.length<2)return false;if(state.restSet.has(pathname))return true;var path=pathname.charAt(0)==="/"?pathname.slice(1):pathname;var slash=path.indexOf("/");if(slash===-1)return false;if(state.methodSet.has(path))return true;return state.svcSet.has(path.slice(0,slash));}
  function parseRequest(input){try{
    if(typeof input==="string"){var s=new URL(input);return{hostname:s.hostname,port:s.port,protocol:s.protocol,path:s.pathname+s.search,raw:input,kind:"string"};}
    if(input instanceof URL)return{hostname:input.hostname,port:input.port,protocol:input.protocol,path:input.pathname+input.search,raw:input,kind:"url"};
    if(input&&typeof input==="object"){var hostText=String(input.hostname||input.host||""),port=input.port||"";
      if(!input.hostname&&hostText.charAt(0)!=="["){var colon=hostText.lastIndexOf(":");if(colon>0&&/^\\d+$/.test(hostText.slice(colon+1))){if(!port)port=hostText.slice(colon+1);hostText=hostText.slice(0,colon);}}
      return{hostname:hostText,port:String(port||""),protocol:input.protocol||"",path:input.path||((input.pathname||"/")+(input.search||"")),raw:input,kind:"object"};}
  }catch(e){}return null;}
  function isConfiguredLocal(parsed){if(!parsed||(parsed.protocol&&parsed.protocol!=="http:"))return false;if(normalizeHost(parsed.hostname)!==normalizeHost(state.host))return false;return!parsed.port||String(parsed.port)===String(state.port);}
  function cloneHeaders(headers){var result={};if(!headers)return result;try{if(typeof Headers!=="undefined"&&headers instanceof Headers){headers.forEach(function(value,key){result[key]=value;});return result;}}catch(e){}
    if(Array.isArray(headers)){if(headers.length&&Array.isArray(headers[0])){for(var i=0;i<headers.length;i++)if(headers[i]&&headers[i].length>=2)result[String(headers[i][0])]=headers[i][1];}else{for(var j=0;j+1<headers.length;j+=2)result[String(headers[j])]=headers[j+1];}return result;}
    if(typeof headers==="object")for(var key in headers)if(Object.prototype.hasOwnProperty.call(headers,key))result[key]=headers[key];return result;}
  function routeHeaders(headers){var result=cloneHeaders(headers),hasWid=false;for(var key in result){var lower=key.toLowerCase();if(lower==="host"||lower===":authority")delete result[key];else if(lower==="x-client-wid")hasWid=true;}if(WINDOW_ID&&!hasWid)result["x-client-wid"]=WINDOW_ID;result["x-byok-route-source"]=PROCESS_LABEL;return result;}
  function localOptions(options){var result=Object.assign({},options||{});result.headers=routeHeaders(result.headers);result.agent=false;delete result.host;delete result.servername;delete result.createConnection;delete result.ALPNProtocols;return result;}
  function rewriteOptions(options){var result=localOptions(options);result.protocol="http:";result.hostname=state.host;result.port=state.port;return result;}
  function rewriteUrl(parsed){var path=parsed.path||"/";return state.base+(path.charAt(0)==="/"?path:"/"+path);}
  function directRequest(parsed,second,callback){var cb=typeof second==="function"?second:callback;if(parsed.kind==="object")return _directHttpRequest.call(_directHttpOwner,rewriteOptions(parsed.raw),cb);var options=typeof second==="function"||second==null?{}:second;return _directHttpRequest.call(_directHttpOwner,rewriteUrl(parsed),localOptions(options),cb);}
  function interceptRequest(isHttps){return function(input,options,callback){var parsed=parseRequest(input);if(parsed&&((isCursorApiHost(parsed.hostname)&&shouldRedirect(parsed.path))||isConfiguredLocal(parsed)))return directRequest(parsed,options,callback);var original=isHttps?_proxyHttpsRequest:_proxyHttpRequest;return original.call(isHttps?_https:_http,input,options,callback);};}
  function interceptGet(isHttps){return function(input,options,callback){var parsed=parseRequest(input);if(parsed&&((isCursorApiHost(parsed.hostname)&&shouldRedirect(parsed.path))||isConfiguredLocal(parsed))){var request=(isHttps?_https:_http).request(input,options,callback);request.end();return request;}var original=isHttps?_proxyHttpsGet:_proxyHttpGet;return original.call(isHttps?_https:_http,input,options,callback);};}
  _http.request=interceptRequest(false);_https.request=interceptRequest(true);_http.get=interceptGet(false);_https.get=interceptGet(true);
  try{if(typeof _module.syncBuiltinESMExports==="function")_module.syncBuiltinESMExports();}catch(e){console.warn("[BYOK] "+PROCESS_LABEL+" syncBuiltinESMExports failed: "+e.message);}
  ${buildNodeChannelSource()}
  console.log("[BYOK] "+PROCESS_LABEL+" HTTP/1.1 whitelist router active (config: "+ROUTES_PATH+")");
})();
/* ${HTTP11_ROUTER_SOURCE_MARKER}-END */
`;
}
function isNodeHttp11RouterPatched(source, guardMarker) {
  const head = source.slice(0, 24e3);
  return head.includes(`/* ${HTTP11_ROUTER_SOURCE_MARKER} */`) && head.includes(HTTP11_ROUTER_VERSION_MARKER) && head.includes(guardMarker) && head.includes("_http.request=interceptRequest(false)") && head.includes("_https.request=interceptRequest(true)") && head.includes("_module.syncBuiltinESMExports") && head.includes("_chConnect();");
}

// node_modules/acorn-walk/dist/walk.mjs
function simple(node, visitors, baseVisitor, state, override) {
  if (!baseVisitor) {
    baseVisitor = base;
  }
  (function c(node2, st, override2) {
    var type = override2 || node2.type;
    visitNode(baseVisitor, type, node2, st, c);
    if (visitors[type]) {
      visitors[type](node2, st);
    }
  })(node, state, override);
}
function skipThrough(node, st, c) {
  c(node, st);
}
function ignore(_node, _st, _c) {
}
function visitNode(baseVisitor, type, node, st, c) {
  if (baseVisitor[type] == null) {
    throw new Error("No walker function defined for node type " + type);
  }
  baseVisitor[type](node, st, c);
}
var base = {};
base.Program = base.BlockStatement = base.StaticBlock = function(node, st, c) {
  for (var i = 0, list = node.body; i < list.length; i += 1) {
    var stmt = list[i];
    c(stmt, st, "Statement");
  }
};
base.Statement = skipThrough;
base.EmptyStatement = ignore;
base.ExpressionStatement = base.ParenthesizedExpression = base.ChainExpression = function(node, st, c) {
  return c(node.expression, st, "Expression");
};
base.IfStatement = function(node, st, c) {
  c(node.test, st, "Expression");
  c(node.consequent, st, "Statement");
  if (node.alternate) {
    c(node.alternate, st, "Statement");
  }
};
base.LabeledStatement = function(node, st, c) {
  return c(node.body, st, "Statement");
};
base.BreakStatement = base.ContinueStatement = ignore;
base.WithStatement = function(node, st, c) {
  c(node.object, st, "Expression");
  c(node.body, st, "Statement");
};
base.SwitchStatement = function(node, st, c) {
  c(node.discriminant, st, "Expression");
  for (var i = 0, list = node.cases; i < list.length; i += 1) {
    var cs = list[i];
    c(cs, st);
  }
};
base.SwitchCase = function(node, st, c) {
  if (node.test) {
    c(node.test, st, "Expression");
  }
  for (var i = 0, list = node.consequent; i < list.length; i += 1) {
    var cons = list[i];
    c(cons, st, "Statement");
  }
};
base.ReturnStatement = base.YieldExpression = base.AwaitExpression = function(node, st, c) {
  if (node.argument) {
    c(node.argument, st, "Expression");
  }
};
base.ThrowStatement = base.SpreadElement = function(node, st, c) {
  return c(node.argument, st, "Expression");
};
base.TryStatement = function(node, st, c) {
  c(node.block, st, "Statement");
  if (node.handler) {
    c(node.handler, st);
  }
  if (node.finalizer) {
    c(node.finalizer, st, "Statement");
  }
};
base.CatchClause = function(node, st, c) {
  if (node.param) {
    c(node.param, st, "Pattern");
  }
  c(node.body, st, "Statement");
};
base.WhileStatement = base.DoWhileStatement = function(node, st, c) {
  c(node.test, st, "Expression");
  c(node.body, st, "Statement");
};
base.ForStatement = function(node, st, c) {
  if (node.init) {
    c(node.init, st, "ForInit");
  }
  if (node.test) {
    c(node.test, st, "Expression");
  }
  if (node.update) {
    c(node.update, st, "Expression");
  }
  c(node.body, st, "Statement");
};
base.ForInStatement = base.ForOfStatement = function(node, st, c) {
  c(node.left, st, "ForInit");
  c(node.right, st, "Expression");
  c(node.body, st, "Statement");
};
base.ForInit = function(node, st, c) {
  if (node.type === "VariableDeclaration") {
    c(node, st);
  } else {
    c(node, st, "Expression");
  }
};
base.DebuggerStatement = ignore;
base.FunctionDeclaration = function(node, st, c) {
  return c(node, st, "Function");
};
base.VariableDeclaration = function(node, st, c) {
  for (var i = 0, list = node.declarations; i < list.length; i += 1) {
    var decl = list[i];
    c(decl, st);
  }
};
base.VariableDeclarator = function(node, st, c) {
  c(node.id, st, "Pattern");
  if (node.init) {
    c(node.init, st, "Expression");
  }
};
base.Function = function(node, st, c) {
  if (node.id) {
    c(node.id, st, "Pattern");
  }
  for (var i = 0, list = node.params; i < list.length; i += 1) {
    var param = list[i];
    c(param, st, "Pattern");
  }
  c(node.body, st, node.expression ? "Expression" : "Statement");
};
base.Pattern = function(node, st, c) {
  if (node.type === "Identifier") {
    c(node, st, "VariablePattern");
  } else if (node.type === "MemberExpression") {
    c(node, st, "MemberPattern");
  } else {
    c(node, st);
  }
};
base.VariablePattern = ignore;
base.MemberPattern = skipThrough;
base.RestElement = function(node, st, c) {
  return c(node.argument, st, "Pattern");
};
base.ArrayPattern = function(node, st, c) {
  for (var i = 0, list = node.elements; i < list.length; i += 1) {
    var elt = list[i];
    if (elt) {
      c(elt, st, "Pattern");
    }
  }
};
base.ObjectPattern = function(node, st, c) {
  for (var i = 0, list = node.properties; i < list.length; i += 1) {
    var prop = list[i];
    if (prop.type === "Property") {
      if (prop.computed) {
        c(prop.key, st, "Expression");
      }
      c(prop.value, st, "Pattern");
    } else if (prop.type === "RestElement") {
      c(prop.argument, st, "Pattern");
    }
  }
};
base.Expression = skipThrough;
base.ThisExpression = base.Super = base.MetaProperty = ignore;
base.ArrayExpression = function(node, st, c) {
  for (var i = 0, list = node.elements; i < list.length; i += 1) {
    var elt = list[i];
    if (elt) {
      c(elt, st, "Expression");
    }
  }
};
base.ObjectExpression = function(node, st, c) {
  for (var i = 0, list = node.properties; i < list.length; i += 1) {
    var prop = list[i];
    c(prop, st);
  }
};
base.FunctionExpression = base.ArrowFunctionExpression = base.FunctionDeclaration;
base.SequenceExpression = function(node, st, c) {
  for (var i = 0, list = node.expressions; i < list.length; i += 1) {
    var expr = list[i];
    c(expr, st, "Expression");
  }
};
base.TemplateLiteral = function(node, st, c) {
  for (var i = 0, list = node.quasis; i < list.length; i += 1) {
    var quasi = list[i];
    c(quasi, st);
  }
  for (var i$1 = 0, list$1 = node.expressions; i$1 < list$1.length; i$1 += 1) {
    var expr = list$1[i$1];
    c(expr, st, "Expression");
  }
};
base.TemplateElement = ignore;
base.UnaryExpression = base.UpdateExpression = function(node, st, c) {
  c(node.argument, st, "Expression");
};
base.BinaryExpression = base.LogicalExpression = function(node, st, c) {
  c(node.left, st, "Expression");
  c(node.right, st, "Expression");
};
base.AssignmentExpression = base.AssignmentPattern = function(node, st, c) {
  c(node.left, st, "Pattern");
  c(node.right, st, "Expression");
};
base.ConditionalExpression = function(node, st, c) {
  c(node.test, st, "Expression");
  c(node.consequent, st, "Expression");
  c(node.alternate, st, "Expression");
};
base.NewExpression = base.CallExpression = function(node, st, c) {
  c(node.callee, st, "Expression");
  if (node.arguments) {
    for (var i = 0, list = node.arguments; i < list.length; i += 1) {
      var arg = list[i];
      c(arg, st, "Expression");
    }
  }
};
base.MemberExpression = function(node, st, c) {
  c(node.object, st, "Expression");
  if (node.computed) {
    c(node.property, st, "Expression");
  }
};
base.ExportNamedDeclaration = base.ExportDefaultDeclaration = function(node, st, c) {
  if (node.declaration) {
    c(node.declaration, st, node.type === "ExportNamedDeclaration" || node.declaration.id ? "Statement" : "Expression");
  }
  if (node.source) {
    c(node.source, st, "Expression");
  }
  if (node.attributes) {
    for (var i = 0, list = node.attributes; i < list.length; i += 1) {
      var attr = list[i];
      c(attr, st);
    }
  }
};
base.ExportAllDeclaration = function(node, st, c) {
  if (node.exported) {
    c(node.exported, st);
  }
  c(node.source, st, "Expression");
  if (node.attributes) {
    for (var i = 0, list = node.attributes; i < list.length; i += 1) {
      var attr = list[i];
      c(attr, st);
    }
  }
};
base.ImportAttribute = function(node, st, c) {
  c(node.value, st, "Expression");
};
base.ImportDeclaration = function(node, st, c) {
  for (var i = 0, list = node.specifiers; i < list.length; i += 1) {
    var spec = list[i];
    c(spec, st);
  }
  c(node.source, st, "Expression");
  if (node.attributes) {
    for (var i$1 = 0, list$1 = node.attributes; i$1 < list$1.length; i$1 += 1) {
      var attr = list$1[i$1];
      c(attr, st);
    }
  }
};
base.ImportExpression = function(node, st, c) {
  c(node.source, st, "Expression");
  if (node.options) {
    c(node.options, st, "Expression");
  }
};
base.ImportSpecifier = base.ImportDefaultSpecifier = base.ImportNamespaceSpecifier = base.Identifier = base.PrivateIdentifier = base.Literal = ignore;
base.TaggedTemplateExpression = function(node, st, c) {
  c(node.tag, st, "Expression");
  c(node.quasi, st, "Expression");
};
base.ClassDeclaration = base.ClassExpression = function(node, st, c) {
  return c(node, st, "Class");
};
base.Class = function(node, st, c) {
  if (node.id) {
    c(node.id, st, "Pattern");
  }
  if (node.superClass) {
    c(node.superClass, st, "Expression");
  }
  c(node.body, st);
};
base.ClassBody = function(node, st, c) {
  for (var i = 0, list = node.body; i < list.length; i += 1) {
    var elt = list[i];
    c(elt, st);
  }
};
base.MethodDefinition = base.PropertyDefinition = base.Property = function(node, st, c) {
  if (node.computed) {
    c(node.key, st, "Expression");
  }
  if (node.value) {
    c(node.value, st, "Expression");
  }
};

// src/agent-websocket-guard.js
var AGENT_WS_GATE_MARKER = "__byokAgentWebSocketGateDisabled";
var AGENT_WS_ORIGINS_MARKER = "__byokAgentWebSocketOriginsDisabled";
var OLD_GATE_MARKER = "__byokAgentHostWebSocketGateDisabled";
var OLD_ORIGINS_MARKER = "__byokAgentHostWebSocketOriginsDisabled";
var DISABLED_WS_GATE = "__byok_disabled_nal_websocket_client";
function parseBundle(source, label) {
  try {
    return parse3(source, { ecmaVersion: "latest", sourceType: "script" });
  } catch (error) {
    throw new Error(`${label} JavaScript parse failed: ${error.message}`);
  }
}
function websocketAstInfo(source, label) {
  const ast = parseBundle(source, label);
  const gateLiterals = [];
  const acceptedOriginArrays = [];
  simple(ast, {
    Literal(node) {
      if (node.value === "nal_websocket_client") gateLiterals.push(node);
    },
    ArrayExpression(node) {
      const values = node.elements.filter(Boolean).map((element) => element.type === "Literal" ? element.value : void 0);
      if (values.includes("https://api.playground.cursor.sh") && values.includes("https://api2.cursor.sh")) {
        acceptedOriginArrays.push(node);
      }
    }
  });
  return { gateLiterals, acceptedOriginArrays };
}
function hasGateMarker(source) {
  return source.includes(AGENT_WS_GATE_MARKER) || source.includes(OLD_GATE_MARKER);
}
function hasOriginsMarker(source) {
  return source.includes(AGENT_WS_ORIGINS_MARKER) || source.includes(OLD_ORIGINS_MARKER);
}
function hasAgentWebSocketStack(source) {
  return source.includes("/agent/v1/run") && source.includes("createAgentRunWebSocketSelection");
}
function isAgentWebSocketDisabled(source, label = "Agent network bundle") {
  if (!hasAgentWebSocketStack(source)) return true;
  if (!hasGateMarker(source) || !hasOriginsMarker(source)) return false;
  const info4 = websocketAstInfo(source, label);
  return info4.gateLiterals.length === 0 && info4.acceptedOriginArrays.length === 0;
}
function disableAgentWebSocket(source, label = "Agent network bundle") {
  if (!hasAgentWebSocketStack(source)) return { source, changed: false, required: false };
  if (isAgentWebSocketDisabled(source, label)) return { source, changed: false, required: true };
  const info4 = websocketAstInfo(source, label);
  const edits = [];
  if (!hasGateMarker(source)) {
    if (info4.gateLiterals.length !== 1) {
      throw new Error(`${label}: expected one nal_websocket_client gate literal, found ${info4.gateLiterals.length}`);
    }
    const gate = info4.gateLiterals[0];
    edits.push({
      start: gate.start,
      end: gate.end,
      text: `${JSON.stringify(DISABLED_WS_GATE)}/*${AGENT_WS_GATE_MARKER}*/`
    });
  }
  if (!hasOriginsMarker(source)) {
    if (info4.acceptedOriginArrays.length !== 1) {
      throw new Error(`${label}: expected one Agent WebSocket accepted-origin set, found ${info4.acceptedOriginArrays.length}`);
    }
    const origins = info4.acceptedOriginArrays[0];
    edits.push({
      start: origins.start + 1,
      end: origins.end - 1,
      text: `/*${AGENT_WS_ORIGINS_MARKER}*/`
    });
  }
  edits.sort((a, b) => b.start - a.start);
  let patched = source;
  for (const edit of edits) patched = patched.slice(0, edit.start) + edit.text + patched.slice(edit.end);
  parseBundle(patched, `${label} (patched)`);
  if (!isAgentWebSocketDisabled(patched, label)) throw new Error(`${label}: WebSocket disable verification failed`);
  return { source: patched, changed: edits.length > 0, required: true };
}

// src/patch-always-local.js
var ALWAYS_LOCAL_ROUTER_MARKER = "__byokUrlRewrite";
var WAIT_MARKER = "__byokWaitServer";
function buildPayload() {
  return buildNodeHttp11RouterPayload({
    guardMarker: ALWAYS_LOCAL_ROUTER_MARKER,
    processLabel: "always-local"
  });
}
function patchAlwaysLocal(paths, log) {
  log?.("[always-local] Patching...");
  if (!(0, import_fs9.existsSync)(paths.alwaysLocalMain)) throw new Error(`Not found: ${paths.alwaysLocalMain}`);
  const modified = [];
  const original = (0, import_fs9.readFileSync)(paths.alwaysLocalMain, "utf-8");
  let patched = original;
  if (!isNodeHttp11RouterPatched(patched, ALWAYS_LOCAL_ROUTER_MARKER)) {
    patched = buildPayload() + patched;
    log?.("  HTTP/1.1 whitelist router injected");
  } else {
    log?.("  HTTP/1.1 whitelist router already active");
  }
  const websocket = disableAgentWebSocket(patched, "cursor-always-local main.js");
  patched = websocket.source;
  if (websocket.required) {
    log?.("  Legacy Agent WebSocket bypass disabled");
  }
  const waited = injectActivateWait(patched, "always-local", log);
  if (!waited.ok) throw new Error("cursor-always-local activate function not found");
  patched = waited.source;
  if (patched !== original) {
    createBackup(paths.alwaysLocalMain, "always-local", log);
    (0, import_fs9.writeFileSync)(paths.alwaysLocalMain, patched);
    modified.push(paths.alwaysLocalMain);
  }
  if (modified.length > 0) updateChecksums(paths, modified, "always-local", log);
  log?.("[always-local] Done");
}
function inspectAlwaysLocalPatch(paths) {
  if (!(0, import_fs9.existsSync)(paths.alwaysLocalMain)) {
    return { present: false, router: false, wait: false, fullyPatched: false };
  }
  const source = (0, import_fs9.readFileSync)(paths.alwaysLocalMain, "utf-8");
  const router = isNodeHttp11RouterPatched(source, ALWAYS_LOCAL_ROUTER_MARKER);
  const wait = hasActivateWait(source);
  const websocketRequired = hasAgentWebSocketStack(source);
  const websocketDisabled = isAgentWebSocketDisabled(source, "cursor-always-local main.js");
  return {
    present: true,
    router,
    wait,
    websocketRequired,
    websocketDisabled,
    fullyPatched: router && wait && websocketDisabled
  };
}
function checkAlwaysLocalPatch(paths, log) {
  log?.("[check] Verifying cursor-always-local HTTP/1.1 route target...");
  if (!(0, import_fs9.existsSync)(paths.alwaysLocalMain)) {
    log?.("  cursor-always-local main.js not found");
    return false;
  }
  try {
    let candidate = (0, import_fs9.readFileSync)(paths.alwaysLocalMain, "utf-8");
    if (!isNodeHttp11RouterPatched(candidate, ALWAYS_LOCAL_ROUTER_MARKER)) candidate = buildPayload() + candidate;
    candidate = disableAgentWebSocket(candidate, "cursor-always-local main.js").source;
    const waited = injectActivateWait(candidate, "always-local", log);
    if (!waited.ok) throw new Error("activate function not found");
    candidate = waited.source;
    if (!isNodeHttp11RouterPatched(candidate, ALWAYS_LOCAL_ROUTER_MARKER)) throw new Error("router call-site verification failed");
    if (!hasActivateWait(candidate)) throw new Error("activate wait verification failed");
    if (!isAgentWebSocketDisabled(candidate, "cursor-always-local main.js")) throw new Error("legacy WebSocket disable verification failed");
    log?.("  [OK] HTTP/1.1 router + activate wait + legacy WebSocket guard");
    return true;
  } catch (error) {
    log?.(`  [FAIL] ${error.message}`);
    return false;
  }
}
function buildWaitSnippet(processLabel) {
  const fallbackHost = JSON.stringify(DEFAULT_HOST);
  const fallbackPort = String(DEFAULT_PORT);
  const ccursorDir = JSON.stringify(CCURSOR_DIR_NAME);
  const routesFile = JSON.stringify(ROUTES_FILE_NAME);
  const label = JSON.stringify(processLabel);
  return `await(async()=>{if(globalThis.${WAIT_MARKER})return;globalThis.${WAIT_MARKER}=true;const _label=${label};const _h=require("http");const _fs=require("fs");const _p=require("path");const _o=require("os");let _host=${fallbackHost},_port=${fallbackPort};try{const _c=JSON.parse(_fs.readFileSync(_p.join(_o.homedir(),${ccursorDir},${routesFile}),"utf-8"));if(_c&&_c.server){_host=_c.server.host||_host;_port=_c.server.port||_port;}}catch{}const _deadline=Date.now()+30000;while(Date.now()<_deadline){try{await new Promise((ok,no)=>{const r=_h.get("http://"+_host+":"+_port+"/health",res=>{res.resume();res.statusCode===200?ok():no()});r.on("error",no);r.setTimeout(500,()=>{r.destroy();no()})});console.log("[BYOK] Server ready, proceeding with "+_label+" activate");return}catch{}await new Promise(r=>setTimeout(r,500))}console.warn("[BYOK] Server not ready after 30s; "+_label+" will continue but routed requests remain local")})();`;
}
function hasActivateWait(source) {
  return source.includes(`await(async()=>{if(globalThis.${WAIT_MARKER})`);
}
function injectActivateWait(source, processLabel, log) {
  if (hasActivateWait(source)) {
    log?.("  activate wait-for-server already injected");
    return { source, changed: false, ok: true };
  }
  const position = findActivateInsertPosition(source, log);
  if (!position) return { source, changed: false, ok: false };
  const asyncPrefix = position.isAsync ? "" : "async ";
  let patched = source.slice(0, position.funcKeyword) + asyncPrefix + source.slice(position.funcKeyword);
  const bodyStart = position.bodyStart + asyncPrefix.length;
  patched = patched.slice(0, bodyStart) + buildWaitSnippet(processLabel) + patched.slice(bodyStart);
  if (!position.isAsync) log?.("  activate: function \u2192 async function");
  log?.("  activate: wait-for-server injected");
  return { source: patched, changed: true, ok: true };
}
function findActivateInsertPosition(source, log) {
  const resultA = findActivateAssignment(source, log);
  if (resultA) return resultA;
  const resultB = findActivateExportedFunction(source, log);
  if (resultB) return resultB;
  return null;
}
function findActivateAssignment(source, log) {
  const NEEDLE = "activate";
  const LOOKBACK = 10;
  let searchFrom = 0;
  while (true) {
    const idx = source.indexOf(NEEDLE, searchFrom);
    if (idx < 0) break;
    searchFrom = idx + NEEDLE.length;
    if (idx > 0 && /[a-zA-Z_$]/.test(source[idx - 1])) continue;
    if (idx + NEEDLE.length < source.length && /[a-zA-Z0-9_$]/.test(source[idx + NEEDLE.length])) continue;
    const before = source.substring(Math.max(0, idx - LOOKBACK), idx).trimEnd();
    if (!before.endsWith(".")) continue;
    const dotPos = idx - 1 - (before.length - before.trimEnd().length);
    let lhsStart = dotPos;
    while (lhsStart > 0 && /[a-zA-Z0-9_$]/.test(source[lhsStart - 1])) lhsStart--;
    let i = idx + NEEDLE.length;
    while (i < source.length && /[\s=]/.test(source[i])) i++;
    const funcKeyword = i;
    const ahead = source.substring(i, i + 20);
    if (!ahead.startsWith("function") && !ahead.startsWith("async")) continue;
    while (i < source.length && source[i] !== "(") i++;
    if (i >= source.length) continue;
    let parenDepth = 0;
    for (; i < source.length; i++) {
      if (source[i] === "(") parenDepth++;
      if (source[i] === ")") {
        parenDepth--;
        if (parenDepth === 0) {
          i++;
          break;
        }
      }
    }
    while (i < source.length && source[i] !== "{") i++;
    if (i >= source.length) continue;
    const bodyStart = i + 1;
    const snippet = source.substring(lhsStart, bodyStart) + "}";
    let ast;
    try {
      ast = parse3(snippet, { ecmaVersion: 2022 });
    } catch {
      continue;
    }
    const stmt = ast.body[0];
    if (!stmt || stmt.type !== "ExpressionStatement") continue;
    const expr = stmt.expression;
    if (!expr || expr.type !== "AssignmentExpression") continue;
    if (!expr.left || expr.left.type !== "MemberExpression") continue;
    const prop = expr.left.property;
    if (!prop || prop.type === "Identifier" && prop.name !== "activate") continue;
    if (!expr.right || expr.right.type !== "FunctionExpression") continue;
    const VERIFY_RANGE = 5e3;
    const nearbyRange = source.substring(Math.max(0, lhsStart - VERIFY_RANGE), Math.min(source.length, bodyStart + VERIFY_RANGE));
    if (!nearbyRange.includes(".deactivate") && !nearbyRange.includes("deactivate")) continue;
    log?.(`  AST match: .activate = FunctionExpression at ${lhsStart}, body at ${bodyStart}`);
    return { bodyStart, funcKeyword, isAsync: expr.right.async === true };
  }
  return null;
}
function findActivateExportedFunction(source, log) {
  const NEEDLE = "activate";
  let searchFrom = 0;
  let activateFuncName = null;
  let activateExportEnd = 0;
  while (true) {
    const idx = source.indexOf(NEEDLE, searchFrom);
    if (idx < 0) break;
    searchFrom = idx + NEEDLE.length;
    if (idx > 0 && /[a-zA-Z_$]/.test(source[idx - 1])) continue;
    if (idx + NEEDLE.length < source.length && /[a-zA-Z0-9_$]/.test(source[idx + NEEDLE.length])) continue;
    let objStart = idx;
    while (objStart > 0 && source[objStart] !== "{") objStart--;
    if (source[objStart] !== "{") continue;
    let objEnd = idx;
    let braceDepth = 0;
    for (let k = objStart; k < source.length && k < objStart + 500; k++) {
      if (source[k] === "{") braceDepth++;
      if (source[k] === "}") {
        braceDepth--;
        if (braceDepth === 0) {
          objEnd = k + 1;
          break;
        }
      }
    }
    if (braceDepth !== 0) continue;
    const objSnippet = "(" + source.substring(objStart, objEnd) + ")";
    let ast;
    try {
      ast = parse3(objSnippet, { ecmaVersion: 2022 });
    } catch {
      continue;
    }
    const exprStmt = ast.body[0];
    if (!exprStmt || exprStmt.type !== "ExpressionStatement") continue;
    const obj = exprStmt.expression;
    if (!obj || obj.type !== "ObjectExpression") continue;
    let activateProp = null;
    let hasDeactivate = false;
    for (const prop of obj.properties) {
      if (prop.type !== "Property") continue;
      const key = prop.key;
      const name = key.type === "Identifier" ? key.name : key.type === "Literal" ? key.value : null;
      if (name === "activate") activateProp = prop;
      if (name === "deactivate") hasDeactivate = true;
    }
    if (!activateProp || !hasDeactivate) continue;
    const arrow = activateProp.value;
    if (!arrow || arrow.type !== "ArrowFunctionExpression") continue;
    if (!arrow.body || arrow.body.type !== "Identifier") continue;
    activateFuncName = arrow.body.name;
    activateExportEnd = objEnd;
    log?.(`  Export object found: activate => ${activateFuncName}`);
    break;
  }
  if (!activateFuncName) return null;
  const funcNeedle = "function " + activateFuncName;
  let fIdx = source.indexOf(funcNeedle, activateExportEnd);
  if (fIdx < 0) fIdx = source.lastIndexOf(funcNeedle, activateExportEnd);
  while (fIdx >= 0) {
    let i = fIdx + funcNeedle.length;
    while (i < source.length && source[i] !== "(") i++;
    if (i >= source.length) {
      fIdx = source.indexOf(funcNeedle, fIdx + 1);
      continue;
    }
    let parenDepth = 0;
    for (; i < source.length; i++) {
      if (source[i] === "(") parenDepth++;
      if (source[i] === ")") {
        parenDepth--;
        if (parenDepth === 0) {
          i++;
          break;
        }
      }
    }
    while (i < source.length && source[i] !== "{") i++;
    if (i >= source.length) {
      fIdx = source.indexOf(funcNeedle, fIdx + 1);
      continue;
    }
    const bodyStart = i + 1;
    const beforeFunction = source.slice(Math.max(0, fIdx - 16), fIdx);
    const asyncMatch = beforeFunction.match(/async\s+$/);
    const funcKeyword = asyncMatch ? fIdx - asyncMatch[0].length : fIdx;
    const snippet = source.substring(funcKeyword, bodyStart) + "}";
    let ast;
    try {
      ast = parse3(snippet, { ecmaVersion: 2022 });
    } catch {
      fIdx = source.indexOf(funcNeedle, fIdx + 1);
      continue;
    }
    const decl = ast.body[0];
    if (!decl || decl.type !== "FunctionDeclaration") {
      fIdx = source.indexOf(funcNeedle, fIdx + 1);
      continue;
    }
    if (decl.id?.name !== activateFuncName) {
      fIdx = source.indexOf(funcNeedle, fIdx + 1);
      continue;
    }
    log?.(`  AST match (exported): ${decl.async ? "async " : ""}function ${activateFuncName} at ${funcKeyword}, body at ${bodyStart}`);
    return { bodyStart, funcKeyword, isAsync: decl.async === true };
  }
  log?.(`  Export found activate => ${activateFuncName}, but function definition not found`);
  return null;
}

// src/patch-sig-bypass.js
var import_fs10 = require("fs");
var SIG_BYPASS_TAG = "always-local";
var SIG_PATTERN = /if\(!\w\.valid\)/;
function inspectSigBypass(paths) {
  if (!(0, import_fs10.existsSync)(paths.extensionHostJs)) {
    return { present: false, applied: false, matchable: false };
  }
  const source = (0, import_fs10.readFileSync)(paths.extensionHostJs, "utf-8");
  const pending = SIG_PATTERN.test(source);
  return {
    present: true,
    applied: source.includes("if(!1)") && !pending,
    matchable: pending
  };
}
function patchSigBypass(paths, log) {
  log?.("[sig-bypass] Patching extensionHostProcess.js...");
  if (!(0, import_fs10.existsSync)(paths.extensionHostJs)) throw new Error(`Not found: ${paths.extensionHostJs}`);
  const source = (0, import_fs10.readFileSync)(paths.extensionHostJs, "utf-8");
  const state = inspectSigBypass(paths);
  if (state.applied) {
    log?.("  Already applied");
    return false;
  }
  const match = source.match(SIG_PATTERN);
  if (!match) throw new Error("Signature validation pattern not found");
  createBackup(paths.extensionHostJs, SIG_BYPASS_TAG, log);
  (0, import_fs10.writeFileSync)(paths.extensionHostJs, source.replace(SIG_PATTERN, "if(!1)"));
  log?.(`  Sig bypass: ${match[0]} \u2192 if(!1)`);
  updateChecksums(paths, [paths.extensionHostJs], SIG_BYPASS_TAG, log);
  return true;
}
function checkSigBypass(paths, log) {
  const state = inspectSigBypass(paths);
  if (!state.present) {
    log?.("  [FAIL] extensionHostProcess.js not found");
    return false;
  }
  if (state.applied) {
    log?.("  [OK] already applied");
    return true;
  }
  if (state.matchable) {
    log?.("  [OK] pattern found");
    return true;
  }
  log?.("  [FAIL] signature validation pattern not found");
  return false;
}

// src/patch-agent-host.js
var import_fs11 = require("fs");
var import_path8 = require("path");
var TAG = "agent-host";
var AGENT_HOST_ROUTER_MARKER = "__byokAgentHostUrlRewrite";
var ENTRY_FINGERPRINTS = [
  "cursorAgentHostEnabled",
  "registerAgentHostProvider",
  "Activating agent host extension"
];
var NETWORK_FINGERPRINTS = [
  "agent.v1.AgentService",
  "RunSSE",
  "BidiAppend",
  "AiConnectTransportHandler",
  "HTTP/1.1 transport created with network settings"
];
function parseBundle2(source, label) {
  try {
    return parse3(source, { ecmaVersion: "latest", sourceType: "script" });
  } catch (error) {
    throw new Error(`${label} JavaScript parse failed: ${error.message}`);
  }
}
function agentHostDist(paths) {
  return paths.agentHostDist || (0, import_path8.dirname)(paths.agentHostMain);
}
function hasAgentHost(paths) {
  return Boolean(paths.agentHostMain && (0, import_fs11.existsSync)(paths.agentHostMain));
}
function hasValidPackage(paths) {
  const packagePath = paths.agentHostPackageJson || (0, import_path8.join)((0, import_path8.dirname)(agentHostDist(paths)), "package.json");
  if (!(0, import_fs11.existsSync)(packagePath)) return false;
  try {
    const pkg = JSON.parse((0, import_fs11.readFileSync)(packagePath, "utf-8"));
    return pkg.name === "cursor-agent-host" && pkg.publisher === "anysphere" && pkg.main === "./dist/main.js";
  } catch {
    return false;
  }
}
function isAgentHostEntry(source) {
  return ENTRY_FINGERPRINTS.every((fingerprint) => source.includes(fingerprint));
}
function isAgentHostNetworkSource(source) {
  return NETWORK_FINGERPRINTS.every((fingerprint) => source.includes(fingerprint));
}
function listDistJavaScript(paths) {
  const dist = agentHostDist(paths);
  if (!(0, import_fs11.existsSync)(dist)) return [];
  return (0, import_fs11.readdirSync)(dist, { withFileTypes: true }).filter((entry) => entry.isFile() && entry.name.endsWith(".js") && !entry.name.endsWith(".unminify.js")).map((entry) => (0, import_path8.join)(dist, entry.name));
}
function findAgentHostNetworkTargets(paths) {
  const targets = [];
  for (const file of listDistJavaScript(paths)) {
    const source = (0, import_fs11.readFileSync)(file, "utf-8");
    if (isAgentHostNetworkSource(source)) targets.push(file);
  }
  return targets;
}
function buildAgentHostRouter() {
  return buildNodeHttp11RouterPayload({
    guardMarker: AGENT_HOST_ROUTER_MARKER,
    processLabel: "agent-host"
  });
}
function prepareAgentHostPatch(paths, log) {
  if (!hasValidPackage(paths)) throw new Error("cursor-agent-host package fingerprint mismatch");
  const originalEntry = (0, import_fs11.readFileSync)(paths.agentHostMain, "utf-8");
  if (!isAgentHostEntry(originalEntry)) throw new Error("cursor-agent-host entry fingerprint mismatch");
  const networkTargets = findAgentHostNetworkTargets(paths);
  if (networkTargets.length === 0) throw new Error("Agent Host network transport chunk not found by content fingerprint");
  const originalByFile = /* @__PURE__ */ new Map();
  for (const file of /* @__PURE__ */ new Set([paths.agentHostMain, ...networkTargets])) {
    originalByFile.set(file, (0, import_fs11.readFileSync)(file, "utf-8"));
  }
  const patchedByFile = new Map(originalByFile);
  let entry = patchedByFile.get(paths.agentHostMain);
  if (!isNodeHttp11RouterPatched(entry, AGENT_HOST_ROUTER_MARKER)) {
    entry = buildAgentHostRouter() + entry;
    log?.("  Agent Host HTTP/1.1 whitelist router injected");
  }
  const waited = injectActivateWait(entry, "agent-host", log);
  if (!waited.ok) throw new Error("cursor-agent-host activate function not found");
  entry = waited.source;
  patchedByFile.set(paths.agentHostMain, entry);
  let websocketTargets = 0;
  for (const file of networkTargets) {
    const source = patchedByFile.get(file);
    if (!hasAgentWebSocketStack(source)) continue;
    websocketTargets++;
    const disabled = disableAgentWebSocket(source, (0, import_path8.basename)(file));
    patchedByFile.set(file, disabled.source);
    log?.(`  Agent WebSocket disabled in content-matched chunk: ${(0, import_path8.basename)(file)}`);
  }
  for (const [file, source] of patchedByFile) {
    if (source !== originalByFile.get(file)) parseBundle2(source, (0, import_path8.basename)(file));
  }
  return { originalByFile, patchedByFile, networkTargets, websocketTargets };
}
function patchAgentHost(paths, log) {
  if (!hasAgentHost(paths)) {
    log?.("[agent-host] Not present (Cursor < 3.13), skipping");
    return false;
  }
  log?.("[agent-host] Patching independent Agent Host transport...");
  const prepared = prepareAgentHostPatch(paths, log);
  const modified = [];
  for (const [file, source] of prepared.patchedByFile) {
    if (source === prepared.originalByFile.get(file)) continue;
    createBackup(file, TAG, log);
    (0, import_fs11.writeFileSync)(file, source);
    modified.push(file);
  }
  if (modified.length === 0) {
    log?.("[agent-host] Already fully patched");
    return false;
  }
  updateChecksums(paths, modified, TAG, log);
  log?.(`[agent-host] Done (${modified.length} file(s), ${prepared.networkTargets.length} network chunk(s), ${prepared.websocketTargets} WebSocket chunk(s))`);
  return true;
}
function inspectAgentHostPatch(paths) {
  if (!hasAgentHost(paths)) {
    return {
      present: false,
      required: false,
      fullyPatched: true,
      entryValid: true,
      router: true,
      wait: true,
      networkTargets: [],
      websocketTargets: [],
      websocketDisabled: true,
      errors: []
    };
  }
  const errors = [];
  const packageValid = hasValidPackage(paths);
  if (!packageValid) errors.push("package fingerprint mismatch");
  let entry = "";
  try {
    entry = (0, import_fs11.readFileSync)(paths.agentHostMain, "utf-8");
  } catch (error) {
    errors.push(error.message);
  }
  const entryValid = Boolean(entry) && isAgentHostEntry(entry);
  if (!entryValid) errors.push("entry fingerprint mismatch");
  const router = Boolean(entry) && isNodeHttp11RouterPatched(entry, AGENT_HOST_ROUTER_MARKER);
  const wait = Boolean(entry) && hasActivateWait(entry);
  let networkTargets = [];
  try {
    networkTargets = findAgentHostNetworkTargets(paths);
  } catch (error) {
    errors.push(error.message);
  }
  if (networkTargets.length === 0) errors.push("network transport chunk not found");
  const websocketTargets = [];
  let websocketDisabled = true;
  for (const file of networkTargets) {
    try {
      const source = (0, import_fs11.readFileSync)(file, "utf-8");
      if (!hasAgentWebSocketStack(source)) continue;
      websocketTargets.push(file);
      if (!isAgentWebSocketDisabled(source, (0, import_path8.basename)(file))) websocketDisabled = false;
    } catch (error) {
      websocketDisabled = false;
      errors.push(error.message);
    }
  }
  const fullyPatched = packageValid && entryValid && router && wait && networkTargets.length > 0 && websocketDisabled && errors.length === 0;
  return {
    present: true,
    required: true,
    fullyPatched,
    entryValid,
    router,
    wait,
    networkTargets,
    websocketTargets,
    websocketDisabled,
    errors
  };
}
function checkAgentHostPatch(paths, log) {
  if (!hasAgentHost(paths)) {
    log?.("  cursor-agent-host not present (pre-3.13, not required)");
    return true;
  }
  const current2 = inspectAgentHostPatch(paths);
  if (current2.fullyPatched) {
    log?.(`  Already patched: entry + ${current2.networkTargets.length} content-matched network chunk(s)`);
    return true;
  }
  try {
    const prepared = prepareAgentHostPatch(paths, log);
    log?.(`  [OK] Agent Host entry/router/activate target found`);
    log?.(`  [OK] ${prepared.networkTargets.length} network chunk(s) found by semantic fingerprints`);
    log?.(`  [OK] ${prepared.websocketTargets} WebSocket chunk(s) can be disabled`);
    return true;
  } catch (error) {
    log?.(`  [FAIL] ${error.message}`);
    return false;
  }
}
function getAgentHostBackupTargets(paths) {
  const targets = /* @__PURE__ */ new Set();
  if (paths.agentHostMain) targets.add(paths.agentHostMain);
  const dist = agentHostDist(paths);
  if (!(0, import_fs11.existsSync)(dist)) return [...targets];
  const marker = `.backup-byok-${TAG}-`;
  for (const entry of (0, import_fs11.readdirSync)(dist, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const index = entry.name.indexOf(marker);
    if (index > 0) targets.add((0, import_path8.join)(dist, entry.name.slice(0, index)));
  }
  return [...targets].sort();
}

// src/patch-proxy-39.js
var import_fs12 = require("fs");
var import_path9 = require("path");
var TAG2 = "proxy-39";
var SYNC_MARKER = "__byokSyncBuiltinESMExports";
var SYNC_CALL_MARKER = "/*BYOK-PROXY39*/";
var ROUTER_MARKER = "__byokSingletonUrlRewrite";
var ROUTER_CALL_MARKER = "/*BYOK-SINGLETON-ROUTER*/";
var TARGET_REL = "out/vs/code/electron-utility/alwaysLocalSingleton/alwaysLocalSingletonMain.js";
var UTILITY_PROCESS_REL = ["out", "vs", "code", "electron-utility"];
var TRANSPORT_FINGERPRINTS = ["aiserver.v1.AiService", "HTTP/1.1 transport created"];
var PROXY_AGENT_ANCHOR = "proxy-agent patches installed";
function parseSemver2(v) {
  const [major = 0, minor = 0, patch = 0] = String(v || "0.0.0").split(".").map((n) => Number(n) || 0);
  return { major, minor, patch };
}
function is39OrNewer(version2) {
  const v = parseSemver2(version2);
  return v.major > 3 || v.major === 3 && v.minor >= 9;
}
function is1125OrNewer(version2) {
  const v = parseSemver2(version2);
  if (v.major > 3) return true;
  if (v.major < 3) return false;
  if (v.minor > 11) return true;
  if (v.minor < 11) return false;
  return v.patch >= 25;
}
function hasSyncPatch(code) {
  return code.includes(SYNC_CALL_MARKER);
}
function hasRouterPatch(code) {
  return code.includes(ROUTER_MARKER);
}
function listUtilityProcessBundles(paths) {
  const root = (0, import_path9.join)(paths.appRoot, ...UTILITY_PROCESS_REL);
  if (!(0, import_fs12.existsSync)(root)) return [];
  const bundles = [];
  for (const dir of (0, import_fs12.readdirSync)(root, { withFileTypes: true })) {
    if (!dir.isDirectory()) continue;
    const dirPath = (0, import_path9.join)(root, dir.name);
    for (const entry of (0, import_fs12.readdirSync)(dirPath, { withFileTypes: true })) {
      if (entry.isFile() && entry.name.endsWith(".js")) bundles.push((0, import_path9.join)(dirPath, entry.name));
    }
  }
  return bundles;
}
function hasTransport(source) {
  return TRANSPORT_FINGERPRINTS.every((fingerprint) => source.includes(fingerprint));
}
function isPatchable(source) {
  return source.includes(PROXY_AGENT_ANCHOR) && /from\s*["']http["']/.test(source) && /from\s*["']https["']/.test(source);
}
function discoverTargets(paths) {
  const targets = [];
  const unpatchable = [];
  for (const file of listUtilityProcessBundles(paths)) {
    let source;
    try {
      source = (0, import_fs12.readFileSync)(file, "utf-8");
    } catch {
      continue;
    }
    if (!hasTransport(source)) continue;
    if (isPatchable(source)) targets.push(file);
    else unpatchable.push(file);
  }
  return { targets, unpatchable };
}
function inspectProxy39Patch(paths) {
  const base2 = { targets: [], unpatchable: [] };
  if (!is39OrNewer(paths.cursorVersion)) {
    return { ...base2, state: "unsupported", required: false, patched: true, summary: "Cursor < 3.9, utility-process BYOK router not applicable" };
  }
  const { targets, unpatchable } = discoverTargets(paths);
  if (targets.length === 0 && unpatchable.length === 0) {
    return {
      ...base2,
      state: "retired",
      required: false,
      patched: true,
      summary: "No utility process owns an AiService HTTP/1.1 transport (3.19+); coverage is provided by the always-local and agent-host routers"
    };
  }
  if (targets.length === 0) {
    return {
      targets,
      unpatchable,
      state: "unreachable",
      required: true,
      patched: false,
      summary: `Utility-process AiService transport found without a known insertion point: ${unpatchable.map(shortName).join(", ")}`
    };
  }
  const nativeSync = is1125OrNewer(paths.cursorVersion);
  const pending = targets.filter((file) => {
    const code = (0, import_fs12.readFileSync)(file, "utf-8");
    return !(hasRouterPatch(code) && (hasSyncPatch(code) || nativeSync));
  });
  if (pending.length === 0) {
    return {
      targets,
      unpatchable,
      state: "patched",
      required: true,
      patched: true,
      summary: `Utility-process BYOK router active in ${targets.map(shortName).join(", ")}`
    };
  }
  return {
    targets,
    unpatchable,
    state: "missing",
    required: true,
    patched: false,
    summary: `Utility-process BYOK router missing in ${pending.map(shortName).join(", ")}`
  };
}
function shortName(file) {
  return file.split(/[\\/]/).pop();
}
function getProxy39BackupTargets(paths) {
  const legacy = paths.alwaysLocalSingletonJs || (0, import_path9.join)(paths.appRoot, TARGET_REL);
  const targets = discoverTargets(paths).targets;
  return [...new Set((0, import_fs12.existsSync)(legacy) ? [legacy, ...targets] : targets)];
}
function findCreateRequireAlias(source) {
  const re = /import\s*\{([^}]*)\}\s*from\s*(["'])node:module\2;?/g;
  let match;
  while ((match = re.exec(source)) !== null) {
    const spec = match[1].trim();
    const alias = spec.match(/\bcreateRequire\s+as\s+([$A-Z_a-z][$\w]*)\b/)?.[1];
    if (alias) return alias;
    if (/\bcreateRequire\b/.test(spec)) return "createRequire";
  }
  return null;
}
function ensureSyncImport(source) {
  const re = /import\s*\{([^}]*)\}\s*from\s*(["'])node:module\2;?/g;
  let match;
  let targetMatch = null;
  let createRequireName = null;
  while ((match = re.exec(source)) !== null) {
    const spec2 = match[1].trim();
    const alias = spec2.match(/\bcreateRequire\s+as\s+([$A-Z_a-z][$\w]*)\b/)?.[1];
    if (alias) createRequireName = alias;
    else if (/\bcreateRequire\b/.test(spec2)) createRequireName = "createRequire";
    const syncAlias = spec2.match(/\bsyncBuiltinESMExports\s+as\s+([$A-Z_a-z][$\w]*)\b/)?.[1];
    if (syncAlias) return { source, fnName: syncAlias, createRequireName };
    if (/\bsyncBuiltinESMExports\b/.test(spec2)) return { source, fnName: "syncBuiltinESMExports", createRequireName };
    if (!targetMatch && createRequireName) targetMatch = match;
  }
  if (!createRequireName) {
    throw new Error("node:module createRequire import not found in utility-process bundle");
  }
  if (!targetMatch) {
    throw new Error("node:module import for createRequire not found");
  }
  const spec = targetMatch[1].trim();
  const replacement = `import{${spec},syncBuiltinESMExports as ${SYNC_MARKER}}from${targetMatch[2]}node:module${targetMatch[2]};`;
  return { source: source.replace(targetMatch[0], replacement), fnName: SYNC_MARKER, createRequireName };
}
function buildSingletonRouterCall(createRequireName) {
  const fallbackHost = JSON.stringify(DEFAULT_HOST);
  const fallbackPort = String(DEFAULT_PORT);
  const ccursorDir = JSON.stringify(CCURSOR_DIR_NAME);
  const routesFile = JSON.stringify(ROUTES_FILE_NAME);
  return `${ROUTER_CALL_MARKER}(function(__byokCreateRequire){if(globalThis.${ROUTER_MARKER})return;globalThis.${ROUTER_MARKER}=true;var _require=__byokCreateRequire(import.meta.url);var _http=_require("http");var _https=_require("https");var _fs=_require("fs");var _path=_require("path");var _os=_require("os");var _proxyHttp=_http.request;var _proxyHttps=_https.request;var _directHttp=(_http.__vscodeOriginal&&_http.__vscodeOriginal.request)||_proxyHttp;var ROUTES_PATH=_path.join(_os.homedir(),${ccursorDir},${routesFile});var FALLBACK_HOST=${fallbackHost};var FALLBACK_PORT=${fallbackPort};var state={host:FALLBACK_HOST,port:FALLBACK_PORT,base:"http://"+FALLBACK_HOST+":"+FALLBACK_PORT,svcSet:new Set(),methodSet:new Set(),restSet:new Set(),ruleCount:0,restCount:0};function loadConfig(){try{var raw=_fs.readFileSync(ROUTES_PATH,"utf-8");var cfg=JSON.parse(raw);var host=(cfg&&cfg.server&&cfg.server.host)||FALLBACK_HOST;var port=(cfg&&cfg.server&&cfg.server.port)||FALLBACK_PORT;var rules=(cfg&&Array.isArray(cfg.redirect))?cfg.redirect:[];var svcSet=new Set(),methodSet=new Set(),restSet=new Set(),ruleCount=0,restCount=0;for(var i=0;i<rules.length;i++){var r=rules[i];if(typeof r!=="string")continue;if(r.indexOf("REST:")===0){restSet.add(r.slice(5));restCount++}else if(r.indexOf("/")!==-1){methodSet.add(r);ruleCount++}else{svcSet.add(r);ruleCount++}}return{host:host,port:port,base:"http://"+host+":"+port,svcSet:svcSet,methodSet:methodSet,restSet:restSet,ruleCount:ruleCount,restCount:restCount}}catch(e){return{host:FALLBACK_HOST,port:FALLBACK_PORT,base:"http://"+FALLBACK_HOST+":"+FALLBACK_PORT,svcSet:new Set(),methodSet:new Set(),restSet:new Set(),ruleCount:0,restCount:0}}}function applyState(label){state=loadConfig();console.log("[BYOK] singleton "+label+" -> "+state.base+" (ConnectRPC="+state.ruleCount+", REST="+state.restCount+")")}applyState("routes loaded");try{_fs.watchFile(ROUTES_PATH,{interval:2000,persistent:false},function(){applyState("routes reloaded")})}catch(e){console.warn("[BYOK] singleton watchFile failed: "+e.message)}function isApiHost(h){h=String(h||"").toLowerCase();return /(^|\\.)api[234]\\.cursor\\.sh$|(^|\\.)api5\\.cursor\\.sh$|(^|\\.)gcpp\\.cursor\\.sh$/.test(h)}function normalizePath(p){p=String(p||"");var q=p.indexOf("?");return q===-1?p:p.slice(0,q)}function shouldRedirect(pathname){pathname=normalizePath(pathname);if(!pathname||pathname.length<2)return false;if(state.restSet.has(pathname))return true;var p=pathname.charAt(0)==="/"?pathname.slice(1):pathname;var slash=p.indexOf("/");if(slash===-1)return false;if(state.methodSet.has(p))return true;var svc=p.slice(0,slash);return state.svcSet.has(svc)}function parseUrl(u){try{if(typeof u==="string"){var s=new URL(u);return{hostname:s.hostname,path:s.pathname+s.search,raw:u,kind:"string"}}if(u instanceof URL)return{hostname:u.hostname,path:u.pathname+u.search,raw:u,kind:"url"};if(u&&typeof u==="object"){var host=u.hostname||(u.host?String(u.host).replace(/:\\d+$/,""):"");var path=u.path||((u.pathname||"/")+(u.search||""));return{hostname:host,path:path,raw:u,kind:"object"}}}catch(e){}return null}function rewriteToString(p){return state.base+(p.path&&p.path.charAt(0)==="/"?p.path:"/"+(p.path||""))}function rewriteOpts(u){var o=Object.assign({},u);o.protocol="http:";o.hostname=state.host;o.host=state.host+":"+state.port;o.port=state.port;return o}function intercept(isHttps){return function(u,o,cb){var parsed=parseUrl(u);if(parsed&&isApiHost(parsed.hostname)&&shouldRedirect(parsed.path)){if(parsed.kind==="object")return _directHttp.call(_http,rewriteOpts(parsed.raw),o,cb);return _directHttp.call(_http,rewriteToString(parsed),o,cb)}return(isHttps?_proxyHttps:_proxyHttp).call(isHttps?_https:_http,u,o,cb)}}_http.request=intercept(false);_https.request=intercept(true);console.log("[BYOK] singleton whitelist router active (config: "+ROUTES_PATH+")")})(${createRequireName})`;
}
function insertBeforeSyncCall(source, routerCall, fnName) {
  const exact = `${SYNC_CALL_MARKER}${fnName}()`;
  const idx = source.indexOf(exact);
  if (idx !== -1) {
    return source.slice(0, idx) + `${routerCall},` + source.slice(idx);
  }
  const call = `${fnName}()`;
  const anchor = source.indexOf(PROXY_AGENT_ANCHOR);
  if (anchor === -1) throw new Error("proxy-agent installed log anchor not found in utility-process bundle");
  const callIdx = source.lastIndexOf(call, anchor);
  if (callIdx === -1) throw new Error("syncBuiltinESMExports call not found before proxy-agent log anchor");
  return source.slice(0, callIdx) + `${routerCall},${SYNC_CALL_MARKER}` + source.slice(callIdx);
}
function insertRouterOnly(source, routerCall) {
  const idx = source.indexOf(PROXY_AGENT_ANCHOR);
  if (idx === -1) throw new Error("proxy-agent installed log anchor not found in utility-process bundle");
  const start = Math.max(0, idx - 600);
  const window = source.slice(start, idx);
  const commaIdx = window.lastIndexOf("),");
  if (commaIdx === -1) throw new Error("proxy-agent install call not found before log anchor");
  const insertAt = start + commaIdx + 1;
  return source.slice(0, insertAt) + `,${routerCall}` + source.slice(insertAt);
}
function insertPatches(source, fnName, createRequireName, nativeSync) {
  const hasRouter = hasRouterPatch(source);
  const hasSync = hasSyncPatch(source) || nativeSync;
  if (hasRouter && hasSync) return source;
  const routerCall = buildSingletonRouterCall(createRequireName);
  if (nativeSync) {
    if (hasRouter) return source;
    return insertRouterOnly(source, routerCall);
  }
  if (hasSync && !hasRouter) {
    return insertBeforeSyncCall(source, routerCall, fnName);
  }
  const directRe = /([$_A-Z_a-z][$\w]*)\(([^(){};]{1,160})\),\s*([$_A-Z_a-z][$\w]*)\.info\((["'])\[AlwaysLocalSingleton\] proxy-agent patches installed\4\)/;
  if (directRe.test(source)) {
    return source.replace(directRe, (_m, installFn, arg, logger, quote) => {
      const syncCall = hasSync ? "" : `,${SYNC_CALL_MARKER}${fnName}()`;
      const router = hasRouter ? "" : `,${routerCall}`;
      return `${installFn}(${arg})${router}${syncCall},${logger}.info(${quote}[AlwaysLocalSingleton] proxy-agent patches installed${quote})`;
    });
  }
  const anchorIdx = source.indexOf(PROXY_AGENT_ANCHOR);
  if (anchorIdx === -1) {
    throw new Error("proxy-agent installed log anchor not found in utility-process bundle");
  }
  const start = Math.max(0, anchorIdx - 400);
  const window = source.slice(start, anchorIdx);
  const commaIdx = window.lastIndexOf("),");
  if (commaIdx === -1) {
    throw new Error("proxy-agent install call not found before log anchor");
  }
  const insertAt = start + commaIdx + 1;
  const patchCalls = `${hasRouter ? "" : `,${routerCall}`}${hasSync ? "" : `,${SYNC_CALL_MARKER}${fnName}()`}`;
  return source.slice(0, insertAt) + patchCalls + source.slice(insertAt);
}
function buildPatchedSource(code, nativeSync) {
  if (nativeSync) {
    const createRequireName = findCreateRequireAlias(code);
    if (!createRequireName) {
      throw new Error("node:module createRequire import not found in utility-process bundle");
    }
    const patched2 = insertPatches(code, null, createRequireName, true);
    if (!hasRouterPatch(patched2)) throw new Error("insertion did not produce the router marker");
    return patched2;
  }
  const imported = ensureSyncImport(code);
  const patched = insertPatches(imported.source, imported.fnName, imported.createRequireName, false);
  if (!hasRouterPatch(patched) || !hasSyncPatch(patched)) {
    throw new Error("insertion did not produce both the router and sync markers");
  }
  return patched;
}
function patchProxy39(paths, log) {
  const inspection = inspectProxy39Patch(paths);
  if (inspection.state === "unsupported" || inspection.state === "retired" || inspection.state === "patched") {
    log?.(`[proxy-39] ${inspection.summary}, skipping`);
    return false;
  }
  if (inspection.state === "unreachable") {
    throw new Error(`proxy-39: ${inspection.summary}`);
  }
  const nativeSync = is1125OrNewer(paths.cursorVersion);
  log?.(`[proxy-39] Patching ${inspection.targets.length} utility process(es)${nativeSync ? " (native syncBuiltinESMExports)" : ""}...`);
  let modified = 0;
  for (const target of inspection.targets) {
    const code = (0, import_fs12.readFileSync)(target, "utf-8");
    const patched = buildPatchedSource(code, nativeSync);
    if (patched === code) continue;
    createBackup(target, TAG2, log);
    (0, import_fs12.writeFileSync)(target, patched);
    updateChecksums(paths, [target], TAG2, log);
    modified++;
  }
  log?.(`[proxy-39] Done (${modified} file(s))`);
  return modified > 0;
}
function checkProxy39Patch(paths, log) {
  const inspection = inspectProxy39Patch(paths);
  if (inspection.state === "unsupported" || inspection.state === "retired") {
    log?.(`  ${inspection.summary}`);
    return true;
  }
  if (inspection.state === "unreachable") {
    log?.(`  [FAIL] ${inspection.summary}`);
    return false;
  }
  if (inspection.state === "patched") {
    log?.(`  ${inspection.summary}`);
    return true;
  }
  const nativeSync = is1125OrNewer(paths.cursorVersion);
  for (const target of inspection.targets) {
    try {
      buildPatchedSource((0, import_fs12.readFileSync)(target, "utf-8"), nativeSync);
      log?.(`  [OK] ${shortName(target)}: BYOK router insertion point found`);
    } catch (e) {
      log?.(`  [FAIL] ${shortName(target)}: ${e.message}`);
      return false;
    }
  }
  return true;
}

// src/patch-katex.js
var import_fs13 = require("fs");
var KATEX_LINK = '<link rel="stylesheet" href="../../../../../extensions/markdown-math/notebook-out/katex.min.css">';
var MARKER = "katex.min.css";
function parseSemver3(v) {
  const [major = 0, minor = 0, patch = 0] = String(v || "0.0.0").split(".").map((n) => Number(n) || 0);
  return { major, minor, patch };
}
function needsKatexPatch(paths) {
  const v = parseSemver3(paths?.cursorVersion);
  if (v.major !== 3) return false;
  return v.minor >= 6 && v.minor < 9;
}
function patchKatex(paths, log) {
  if (!needsKatexPatch(paths)) {
    const v = paths?.cursorVersion || "?";
    log?.(`[katex] Cursor ${v} outside 3.6\u20133.8 range, skipping (official KaTeX CSS present or not yet regressed)`);
    return false;
  }
  const htmlPath = paths.workbenchHtml;
  if (!(0, import_fs13.existsSync)(htmlPath)) {
    log?.("[katex] WARNING: workbench.html not found, skipping");
    return false;
  }
  const katexCssPath = `${paths.appRoot}/extensions/markdown-math/notebook-out/katex.min.css`;
  if (!(0, import_fs13.existsSync)(katexCssPath)) {
    log?.("[katex] WARNING: katex.min.css not found, skipping");
    return false;
  }
  let html = (0, import_fs13.readFileSync)(htmlPath, "utf-8");
  if (html.includes(MARKER)) {
    log?.("[katex] already linked");
    return false;
  }
  createBackup(htmlPath, "katex", log);
  const needle = 'workbench.desktop.main.css">';
  const idx = html.indexOf(needle);
  if (idx === -1) {
    log?.("[katex] WARNING: workbench CSS link not found in HTML, appending to <head>");
    html = html.replace("</head>", `		${KATEX_LINK}
	</head>`);
  } else {
    html = html.slice(0, idx + needle.length) + "\n		" + KATEX_LINK + html.slice(idx + needle.length);
  }
  (0, import_fs13.writeFileSync)(htmlPath, html, "utf-8");
  log?.("[katex] linked katex.min.css in workbench.html");
  updateChecksums(paths, [htmlPath], "katex", log);
  log?.("[katex] Done");
  return true;
}

// src/steps.js
var OK = "ok";
var FAIL = "fail";
var NA = "na";
var line = (state, text) => ({ state, text });
var allOk = (lines) => lines.every((l) => l.state !== FAIL);
function hostsUiExtensions(profile) {
  return profile.hostRoles.includes("ui");
}
var PATCH_STEPS = [
  {
    id: "extension",
    tag: "extension",
    title: "Cursor++ extension",
    requires: [],
    // The bundled VSIX is the UI half of Cursor++ (panel, commands, settings).
    // A tree that runs no UI extensions must not receive it; the remote half
    // is the separate cursor2plus-remote VSIX, installed by the user through
    // the Extensions view so that Cursor registers it for the remote host.
    available: (profile) => hostsUiExtensions(profile),
    skipNote: "Bundled cursor2plus is a UI extension \u2014 install the cursor2plus-remote VSIX here instead",
    install: (paths, log) => installExtension(paths, log),
    inspect: (paths) => {
      const installed = isExtensionInstalled(paths);
      return { ok: installed, lines: [line(installed ? OK : FAIL, installed ? "Extension installed" : "Extension not installed")] };
    },
    check: () => true,
    backupTargets: () => [],
    restore: (paths, log) => {
      removeExtension(paths, log);
      return 0;
    }
  },
  {
    id: "renderer-hook",
    tag: "inject",
    title: "Renderer hook",
    requires: [CAP_RENDERER],
    skipNote: "No renderer bundle in this tree \u2014 renderer hook not applicable",
    install: (paths, log) => patchInject(paths, log),
    inspect: (paths) => {
      const lines = [];
      for (const [file, label] of [[paths.workbenchJs, "desktop"], [paths.glassJs, "glass"]]) {
        if (!(0, import_fs14.existsSync)(file)) {
          lines.push(line(NA, `Renderer hook (${label}): bundle not present`));
          continue;
        }
        const injected = isInjectPatched((0, import_fs14.readFileSync)(file, "utf-8"));
        lines.push(line(injected ? OK : FAIL, `Renderer hook ${injected ? "injected" : "not injected"} (${label})`));
      }
      return { ok: allOk(lines), lines };
    },
    check: (paths, log) => checkRendererHook(paths, log),
    backupTargets: (paths) => [paths.glassJs, paths.workbenchJs]
  },
  {
    id: "always-local",
    tag: "always-local",
    title: "Legacy Agent transport (cursor-always-local)",
    requires: [],
    available: (profile) => extensionRunsHere(profile, "cursor-always-local"),
    skipNote: "cursor-always-local is a UI extension and does not run in this tree",
    install: (paths, log) => patchAlwaysLocal(paths, log),
    inspect: (paths) => {
      const state = inspectAlwaysLocalPatch(paths);
      const lines = [
        line(state.router ? OK : FAIL, `Legacy Agent HTTP/1.1 router ${state.router ? "active" : "missing"}`),
        line(state.wait ? OK : FAIL, `Legacy Agent server wait ${state.wait ? "active" : "missing"}`)
      ];
      if (state.websocketRequired) {
        lines.push(line(
          state.websocketDisabled ? OK : FAIL,
          `Legacy Agent WebSocket bypass ${state.websocketDisabled ? "disabled" : "is active"}`
        ));
      }
      return { ok: state.fullyPatched, lines };
    },
    check: (paths, log) => checkAlwaysLocalPatch(paths, log),
    backupTargets: (paths) => [paths.alwaysLocalMain]
  },
  {
    id: "sig-bypass",
    tag: SIG_BYPASS_TAG,
    title: "Built-in extension signature bypass",
    requires: [CAP_EXTENSION_HOST],
    skipNote: "extensionHostProcess.js not present \u2014 signature bypass not applicable",
    install: (paths, log) => patchSigBypass(paths, log),
    inspect: (paths) => {
      const state = inspectSigBypass(paths);
      return {
        ok: state.applied,
        lines: [line(state.applied ? OK : FAIL, `Signature bypass ${state.applied ? "active" : "not active"}`)]
      };
    },
    check: (paths, log) => checkSigBypass(paths, log),
    backupTargets: (paths) => [paths.extensionHostJs]
  },
  {
    id: "agent-host",
    tag: "agent-host",
    title: "Agent Host transport (cursor-agent-host)",
    requires: [],
    available: (profile) => extensionRunsHere(profile, "cursor-agent-host"),
    skipNote: "cursor-agent-host not shipped in this tree (pre-3.13)",
    install: (paths, log) => patchAgentHost(paths, log),
    inspect: (paths) => {
      const state = inspectAgentHostPatch(paths);
      const lines = [
        line(state.router ? OK : FAIL, `Agent Host HTTP/1.1 router ${state.router ? "active" : "missing"}`),
        line(state.wait ? OK : FAIL, `Agent Host server wait ${state.wait ? "active" : "missing"}`),
        state.networkTargets.length > 0 ? line(OK, `Agent Host network target verified (${state.networkTargets.map(shortName2).join(", ")})`) : line(FAIL, "Agent Host network target not found")
      ];
      if (state.websocketTargets.length > 0) {
        lines.push(line(
          state.websocketDisabled ? OK : FAIL,
          `Agent Host WebSocket bypass ${state.websocketDisabled ? "disabled" : "is active"}`
        ));
      } else {
        lines.push(line(NA, "Agent Host WebSocket transport not present (3.13\u20133.15)"));
      }
      return { ok: state.fullyPatched, lines };
    },
    check: (paths, log) => checkAgentHostPatch(paths, log),
    backupTargets: (paths) => getAgentHostBackupTargets(paths)
  },
  {
    id: "proxy-39",
    tag: "proxy-39",
    title: "Utility-process BYOK router",
    requires: [CAP_UTILITY_PROCESS],
    skipNote: "No electron-utility processes in this tree \u2014 utility-process router not applicable",
    install: (paths, log) => patchProxy39(paths, log),
    inspect: (paths) => {
      const state = inspectProxy39Patch(paths);
      return {
        ok: !state.required || state.patched,
        lines: [line(state.required ? state.patched ? OK : FAIL : NA, state.summary)]
      };
    },
    check: (paths, log) => checkProxy39Patch(paths, log),
    backupTargets: (paths) => getProxy39BackupTargets(paths)
  },
  {
    id: "katex",
    tag: "katex",
    title: "KaTeX CSS link",
    requires: [CAP_WORKBENCH_HTML],
    skipNote: "No workbench.html in this tree \u2014 KaTeX CSS link not applicable",
    install: (paths, log) => patchKatex(paths, log),
    inspect: (paths) => {
      if (!needsKatexPatch(paths)) {
        return { ok: true, lines: [line(NA, `KaTeX CSS link not needed on Cursor ${paths.cursorVersion}`)] };
      }
      const linked = (0, import_fs14.existsSync)(paths.workbenchHtml) && (0, import_fs14.readFileSync)(paths.workbenchHtml, "utf-8").includes("katex.min.css");
      return { ok: linked, lines: [line(linked ? OK : FAIL, `KaTeX CSS link ${linked ? "present" : "missing"}`)] };
    },
    check: () => true,
    backupTargets: (paths) => [paths.workbenchHtml]
  }
];
function shortName2(file) {
  return file.split(/[\\/]/).pop();
}
function checkRendererHook(paths, log) {
  let ok5 = true;
  for (const [file, label] of [[paths.workbenchJs, "desktop"], [paths.glassJs, "glass"]]) {
    if (!(0, import_fs14.existsSync)(file)) {
      if (label === "glass") log?.("  Glass workbench not found (pre-3.8, OK)");
      continue;
    }
    const source = (0, import_fs14.readFileSync)(file, "utf-8");
    const allowlist = checkGlassExtensionAllowlist(source);
    log?.(`  [${allowlist.ok ? "OK" : "FAIL"}] Extension allowlist (${label}): ${allowlist.detail}`);
    if (!allowlist.ok) ok5 = false;
    if (isInjectPatched(source)) {
      log?.(`  [OK] Renderer hook (${label}): payload + active transport call site`);
      continue;
    }
    if (source.includes("__byokWrapTransport") || source.includes("CURSOR-BYOK-HOOK-START")) {
      log?.(`  [FAIL] Renderer hook (${label}) is partial (payload/call-site mismatch)`);
      ok5 = false;
      continue;
    }
    const anchor = ["callback-client.js", "promise-client.js"].find((a) => source.includes(a));
    if (anchor) {
      log?.(`  [OK] Inject anchor (${label}): "${anchor}"`);
    } else {
      log?.(`  [FAIL] Inject anchor (${label}) not found`);
      ok5 = false;
    }
  }
  return ok5;
}
function resolveSteps(profile) {
  return PATCH_STEPS.map((step) => {
    const capable = step.requires.every((capability) => profile.capabilities.has(capability));
    const available = capable && (step.available ? step.available(profile) : true);
    return { ...step, applicable: available };
  });
}
function restoreStep(step, paths, log) {
  if (step.restore) return step.restore(paths, log);
  let restored = 0;
  for (const file of [paths.productJson, ...step.backupTargets(paths)]) {
    if (restoreBackup(file, step.tag, log)) restored++;
  }
  return restored;
}

// src/install.js
var ok = (msg) => console.log(`\x1B[32m[OK]\x1B[0m ${msg}`);
var info = (msg) => console.log(`\x1B[34m[>]\x1B[0m ${msg}`);
var warn = (msg) => console.log(`\x1B[33m[!]\x1B[0m ${msg}`);
var fail = (msg) => console.log(`\x1B[31m[X]\x1B[0m ${msg}`);
async function install() {
  info("Cursor++ BYOK Installer");
  console.log("");
  const { paths, diagnostic } = findCursorPathsDetailed();
  if (!paths) {
    fail("Cursor installation not found");
    console.log("");
    console.log(formatDiagnostic(diagnostic));
    console.log("");
    throw new Error("Cursor installation not found");
  }
  info(`Cursor: ${paths.appRoot}`);
  info(`Version: ${paths.cursorVersion} (${paths.kindLabel}${paths.hasGlass ? ", glass" : ""})`);
  for (const line2 of formatInstallSelection(diagnostic)) warn(line2);
  const steps = resolveSteps(paths);
  const pending = steps.filter((step) => step.applicable && !step.inspect(paths).ok);
  if (pending.length === 0) {
    ok("Already fully installed");
    for (const line2 of formatSetupNotice()) warn(line2);
    info('To reinstall, run "ccursor uninstall" first');
    return;
  }
  const extensionStep = steps.find((step) => step.id === "extension");
  const extensionMissing = extensionStep.applicable && !extensionStep.inspect(paths).ok;
  const hasBackups = steps.some((step) => step.backupTargets(paths).some((file) => hasBackup(file, step.tag)));
  if (hasBackups && extensionMissing) {
    warn("Found backup files from a previous installation");
    warn('Run "ccursor uninstall" to clean up before reinstalling');
    return;
  }
  console.log("");
  releaseDefaults(info);
  for (const step of steps) {
    if (!step.applicable) {
      info(`[${step.id}] Skipped \u2014 ${step.skipNote}`);
      continue;
    }
    step.install(paths, info);
  }
  console.log("");
  ok("Installation complete!");
  warn("Restart Cursor for changes to take effect.");
  for (const line2 of formatSetupNotice()) warn(line2);
  for (const line2 of formatRemoteHostNotice(paths)) warn(line2);
  info("Uninstall: npx github:xmm-prio/CCursor uninstall");
}

// src/uninstall.js
var ok2 = (msg) => console.log(`\x1B[32m[OK]\x1B[0m ${msg}`);
var info2 = (msg) => console.log(`\x1B[34m[>]\x1B[0m ${msg}`);
var warn2 = (msg) => console.log(`\x1B[33m[!]\x1B[0m ${msg}`);
var fail2 = (msg) => console.log(`\x1B[31m[X]\x1B[0m ${msg}`);
async function uninstall() {
  info2("Cursor++ BYOK Uninstaller");
  console.log("");
  const { paths, diagnostic } = findCursorPathsDetailed();
  if (!paths) {
    fail2("Cursor installation not found");
    console.log("");
    console.log(formatDiagnostic(diagnostic));
    console.log("");
    throw new Error("Cursor installation not found");
  }
  info2(`Cursor: ${paths.appRoot} (${paths.cursorVersion}, ${paths.kindLabel})`);
  let restored = 0;
  for (const step of [...PATCH_STEPS].reverse()) {
    info2(`Restoring ${step.title}...`);
    restored += restoreStep(step, paths, info2);
  }
  console.log("");
  if (restored > 0) {
    ok2(`Restored ${restored} file(s)`);
  } else {
    warn2("No backups found (already clean?)");
  }
  ok2("Uninstallation complete");
  warn2("Restart Cursor for changes to take effect.");
}

// src/status.js
var import_fs15 = require("fs");
var import_path10 = require("path");
var ok3 = (s) => `\x1B[32m\u2713 ${s}\x1B[0m`;
var fail3 = (s) => `\x1B[31m\u2717 ${s}\x1B[0m`;
var na = (s) => `\x1B[2m- ${s}\x1B[0m`;
var RENDER = { ok: ok3, fail: fail3, na };
async function status() {
  const { paths, diagnostic } = findCursorPathsDetailed();
  if (!paths) {
    console.log(fail3("Cursor installation not found"));
    console.log("");
    console.log(formatDiagnostic(diagnostic));
    return;
  }
  console.log(`Cursor: ${paths.appRoot} (${paths.cursorVersion}, ${paths.kindLabel})`);
  for (const line2 of formatInstallSelection(diagnostic)) console.log(line2);
  console.log("");
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
  const remoteNotice = formatRemoteHostNotice(paths);
  if (remoteNotice.length > 0) {
    console.log("");
    console.log(na(remoteNotice[0]));
    for (const line2 of remoteNotice.slice(1)) console.log(line2);
  }
  console.log("");
  const routesPath = (0, import_path10.join)(CCURSOR_DIR, ROUTES_FILE_NAME);
  const providersPath = (0, import_path10.join)(CCURSOR_DIR, PROVIDERS_FILE_NAME);
  console.log((0, import_fs15.existsSync)(routesPath) ? ok3(`routes.json: ${routesPath}`) : fail3(`routes.json missing at ${routesPath}`));
  console.log((0, import_fs15.existsSync)(providersPath) ? ok3(`providers.json: ${providersPath}`) : fail3(`providers.json missing at ${providersPath}`));
  console.log("");
  const backupFiles = /* @__PURE__ */ new Set();
  for (const step of steps) {
    if (!step.applicable) continue;
    for (const file of step.backupTargets(paths)) backupFiles.add(file);
  }
  if (backupFiles.size > 0 && hasChecksumTable(paths)) backupFiles.add(paths.productJson);
  const backupCount = [...backupFiles].filter((f) => hasBackup(f)).length;
  console.log(`Backups: ${backupCount}/${backupFiles.size} files backed up`);
}

// src/check.js
var ok4 = (s) => `\x1B[32m\u2713 ${s}\x1B[0m`;
var fail4 = (s) => `\x1B[31m\u2717 ${s}\x1B[0m`;
var skip = (s) => `\x1B[2m- ${s}\x1B[0m`;
var info3 = (s) => `\x1B[34m[>]\x1B[0m ${s}`;
async function check() {
  const { paths, diagnostic } = findCursorPathsDetailed();
  if (!paths) {
    console.log(fail4("Cursor installation not found"));
    console.log();
    console.log(formatDiagnostic(diagnostic));
    return;
  }
  console.log(info3(`Cursor: ${paths.appRoot} (${paths.cursorVersion}, ${paths.kindLabel})`));
  for (const line2 of formatInstallSelection(diagnostic)) console.log(info3(line2));
  console.log();
  let allOk2 = true;
  for (const step of resolveSteps(paths)) {
    if (!step.applicable) {
      console.log(skip(`${step.title}: ${step.skipNote}`));
      continue;
    }
    console.log(info3(`[check] ${step.title}...`));
    const passed = step.check(paths, (s) => console.log(info3(s)));
    if (!passed) allOk2 = false;
  }
  console.log();
  if (allOk2) {
    console.log(ok4("All patch targets matchable"));
  } else {
    console.log(fail4("Some targets not matchable \u2014 install may fail"));
  }
}

// src/patch-local-mode.js
var import_fs16 = require("fs");
var import_path11 = require("path");
var TAG3 = "local-mode";
var PATTERN = "localMode:!1";
var REPLACEMENT = "localMode:!0";
var MAIN_REL = "out/main.js";
var STABLE_TARGETS = [
  MAIN_REL,
  "out/vs/workbench/workbench.desktop.main.js",
  "out/vs/workbench/workbench.glass.main.js",
  "out/vs/workbench/api/node/extensionHostProcess.js"
];
function getLocalModeTargets(paths) {
  return [
    ...STABLE_TARGETS.map((rel) => (0, import_path11.join)(paths.appRoot, rel)),
    ...listUtilityProcessBundles(paths)
  ];
}
function patchLocalMode(paths, log) {
  log?.("[local-mode] Patching buildFlags.localMode...");
  let patched = 0;
  const modifiedFiles = [];
  const targets = getLocalModeTargets(paths);
  for (const filePath of targets) {
    const rel = (0, import_path11.relative)(paths.appRoot, filePath).replace(/\\/g, "/");
    if (!(0, import_fs16.existsSync)(filePath)) {
      log?.(`  [local-mode] ${rel}: not found, skipping`);
      continue;
    }
    const code = (0, import_fs16.readFileSync)(filePath, "utf-8");
    if (code.includes(REPLACEMENT)) {
      log?.(`  [local-mode] ${rel}: already patched`);
      patched++;
      continue;
    }
    if (!code.includes(PATTERN)) {
      log?.(`  [local-mode] ${rel}: pattern not found, skipping`);
      continue;
    }
    createBackup(filePath, TAG3, log);
    (0, import_fs16.writeFileSync)(filePath, code.replace(PATTERN, REPLACEMENT));
    modifiedFiles.push(filePath);
    patched++;
    log?.(`  [local-mode] ${rel}: patched`);
  }
  if (modifiedFiles.length > 0) {
    updateChecksums(paths, modifiedFiles, TAG3, log);
  }
  log?.(`[local-mode] Done (${patched}/${targets.length} files)`);
  return patched;
}

// src/cli.js
async function update() {
  await uninstall();
  console.log("");
  await install();
}
var command = process.argv[2];
var commands = {
  install,
  uninstall,
  update,
  upgrade: update,
  status,
  check,
  "local-mode": async () => {
    const info4 = (msg) => console.log(`\x1B[34m[>]\x1B[0m ${msg}`);
    const { paths, diagnostic } = findCursorPathsDetailed();
    if (!paths) {
      console.log(formatDiagnostic(diagnostic));
      process.exit(1);
    }
    info4(`Cursor: ${paths.appRoot}`);
    patchLocalMode(paths, info4);
  },
  "local-mode-off": async () => {
    const info4 = (msg) => console.log(`\x1B[34m[>]\x1B[0m ${msg}`);
    const { paths, diagnostic } = findCursorPathsDetailed();
    if (!paths) {
      console.log(formatDiagnostic(diagnostic));
      process.exit(1);
    }
    info4(`Cursor: ${paths.appRoot}`);
    info4("Restoring local-mode patches...");
    let restored = 0;
    for (const target of getLocalModeTargets(paths)) {
      if (restoreBackup(target, "local-mode", info4)) restored++;
    }
    if (restoreBackup(paths.productJson, "local-mode", info4)) restored++;
    console.log(restored > 0 ? `\x1B[32m[OK]\x1B[0m Restored ${restored} file(s)` : "\x1B[33m[!]\x1B[0m No backups found");
  },
  help: async () => {
    console.log(`
ccursor \u2014 Cursor++ BYOK Installer

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
  }
};
var fn = commands[command];
if (!fn) {
  console.error(`Unknown command: ${command || "(none)"}`);
  commands.help();
  process.exit(1);
}
fn().catch((err2) => {
  console.error(`
\x1B[31m[ERROR]\x1B[0m ${err2.message}`);
  process.exit(1);
});
