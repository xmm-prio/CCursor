#!/usr/bin/env node
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));

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
function inflateSync(data, opts) {
  return inflt(data, { i: 2 }, opts && opts.out, opts && opts.dictionary);
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
function unzipSync(data, opts) {
  var files = {};
  var e = data.length - 22;
  for (; b4(data, e) != 101010256; --e) {
    if (!e || data.length - e > 65558)
      err(13);
  }
  ;
  var c = b2(data, e + 8);
  if (!c)
    return {};
  var o = b4(data, e + 16);
  var z = b4(data, e - 20) == 117853008;
  if (z) {
    var ze = b4(data, e - 12);
    z = b4(data, ze) == 101075792;
    if (z) {
      c = b4(data, ze + 32);
      o = b4(data, ze + 48);
    }
  }
  var fltr = opts && opts.filter;
  for (var i = 0; i < c; ++i) {
    var _a2 = zh(data, o, z), c_2 = _a2[0], sc = _a2[1], su = _a2[2], fn2 = _a2[3], no = _a2[4], off = _a2[5], b = slzh(data, off);
    o = no;
    if (!fltr || fltr({
      name: fn2,
      size: sc,
      originalSize: su,
      compression: c_2
    })) {
      if (!c_2)
        files[fn2] = slc(data, b, b + sc);
      else if (c_2 == 8)
        files[fn2] = inflateSync(data.subarray(b, b + sc), { out: new u8(su) });
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
  for (const [name, data] of Object.entries(files)) {
    if (!name.startsWith(prefix) || name.endsWith("/"))
      continue;
    const relPath = name.slice(prefix.length);
    const destPath = (0, import_path6.join)(targetDir, relPath);
    (0, import_fs6.mkdirSync)((0, import_path6.dirname)(destPath), { recursive: true });
    (0, import_fs6.writeFileSync)(destPath, data);
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
var acorn = __toESM(require("acorn"), 1);

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
  for (let offset = 0; offset < PORT_FALLBACK_SPAN; offset++) {
    candidates.push(`http://${bracketed}:${start + offset}`);
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
        ast = acorn.parse(body, { ecmaVersion: 2022, sourceType: "script" });
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
      ast = acorn.parse(body, { ecmaVersion: 2022, sourceType: "script" });
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
      ast = acorn.parseExpressionAt(code, xStart, { ecmaVersion: 2022, sourceType: "module" });
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
    ast = acorn.parse(fnSource, { ecmaVersion: 2022, sourceType: "script" });
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
      parsed = acorn.parseExpressionAt(code, exprStart, { ecmaVersion: 2022, sourceType: "script" });
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
        parsed = acorn.parseExpressionAt(code, exprStart, { ecmaVersion: 2022, sourceType: "script" });
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
var acorn3 = __toESM(require("acorn"), 1);

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

// src/agent-websocket-guard.js
var acorn2 = __toESM(require("acorn"), 1);

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
    return acorn2.parse(source, { ecmaVersion: "latest", sourceType: "script" });
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
      ast = acorn3.parse(snippet, { ecmaVersion: 2022 });
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
      ast = acorn3.parse(objSnippet, { ecmaVersion: 2022 });
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
      ast = acorn3.parse(snippet, { ecmaVersion: 2022 });
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
var acorn4 = __toESM(require("acorn"), 1);
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
    return acorn4.parse(source, { ecmaVersion: "latest", sourceType: "script" });
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
  const current = inspectAgentHostPatch(paths);
  if (current.fullyPatched) {
    log?.(`  Already patched: entry + ${current.networkTargets.length} content-matched network chunk(s)`);
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
function is39OrNewer(version) {
  const v = parseSemver2(version);
  return v.major > 3 || v.major === 3 && v.minor >= 9;
}
function is1125OrNewer(version) {
  const v = parseSemver2(version);
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
