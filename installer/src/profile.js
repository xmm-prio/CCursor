/**
 * Install profile — what shape of Cursor install is this, and what does it host?
 *
 * Cursor ships two independently patchable trees:
 *
 *   desktop  `resources/app` of the Electron app. Owns the renderer bundles
 *            (workbench.desktop.main.js / workbench.glass.main.js), the
 *            electron-utility processes, workbench.html and the full built-in
 *            extension set. It runs both `ui` and `workspace` extensions.
 *
 *   server   `~/.cursor-server/bin/<commit>`, the REH tarball named by
 *            product.json#serverDownloadUrlTemplate. Verified against
 *            vscode-reh-linux-x64 for commit 6496ea8a (3.19.19): `out/` holds
 *            only server-main.js, server-cli.js, bootstrap-fork.js,
 *            vs/server/, vs/platform/ and vs/workbench/api/node/
 *            extensionHostProcess.js — no renderer bundle, no
 *            out/vs/code/**, no workbench.html — while `extensions/` ships the
 *            same built-in set as the desktop app. It runs `workspace`
 *            extensions only.
 *
 * Commands must never branch on the kind. They walk the patch steps the
 * profile declares (see steps.js). The kind only decides which capabilities
 * the tree exposes and which extension host roles run here; every patch step
 * states the capabilities it needs and is filtered out when they are absent.
 */
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';

export const KIND_DESKTOP = 'desktop';
export const KIND_SERVER = 'server';
export const KIND_UNKNOWN = 'unknown';

/** Capability ids a patch step can require of the tree it is applied to. */
export const CAP_RENDERER = 'renderer';
export const CAP_GLASS = 'glass';
export const CAP_WORKBENCH_HTML = 'workbench-html';
export const CAP_UTILITY_PROCESS = 'utility-process';
export const CAP_EXTENSION_HOST = 'extension-host';
export const CAP_BUILTIN_EXTENSIONS = 'builtin-extensions';

const KIND_DESCRIPTORS = {
  [KIND_DESKTOP]: {
    label: 'desktop',
    hostRoles: ['ui', 'workspace'],
    // Two desktop installs reporting the same version are indistinguishable
    // from the outside; the user has to say which one is the live one.
    sameVersionTieBreak: 'ambiguous',
  },
  [KIND_SERVER]: {
    label: 'server',
    hostRoles: ['workspace'],
    // Server roots are keyed by commit under bin/, so several builds of one
    // version legitimately coexist. The most recently written one is the one
    // the current client provisioned.
    sameVersionTieBreak: 'newest',
  },
  [KIND_UNKNOWN]: {
    label: 'unknown',
    hostRoles: [],
    sameVersionTieBreak: 'ambiguous',
  },
};

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf-8'));
  }
  catch {
    return null;
  }
}

function readCursorVersion(appRoot) {
  return readJson(join(appRoot, 'package.json'))?.version || '0.0.0';
}

export function parseSemver(v) {
  const [major = 0, minor = 0, patch = 0] = String(v || '0.0.0').split('.').map(n => Number(n) || 0);
  return { major, minor, patch };
}

/** @returns negative when a < b, 0 when equal, positive when a > b */
export function compareSemver(a, b) {
  const left = parseSemver(a);
  const right = parseSemver(b);
  return (left.major - right.major) || (left.minor - right.minor) || (left.patch - right.patch);
}

function buildTreePaths(appRoot) {
  return {
    appRoot,
    workbenchJs: join(appRoot, 'out', 'vs', 'workbench', 'workbench.desktop.main.js'),
    glassJs: join(appRoot, 'out', 'vs', 'workbench', 'workbench.glass.main.js'),
    workbenchHtml: join(appRoot, 'out', 'vs', 'code', 'electron-sandbox', 'workbench', 'workbench.html'),
    utilityProcessDir: join(appRoot, 'out', 'vs', 'code', 'electron-utility'),
    alwaysLocalMain: join(appRoot, 'extensions', 'cursor-always-local', 'dist', 'main.js'),
    agentHostDist: join(appRoot, 'extensions', 'cursor-agent-host', 'dist'),
    agentHostMain: join(appRoot, 'extensions', 'cursor-agent-host', 'dist', 'main.js'),
    agentHostPackageJson: join(appRoot, 'extensions', 'cursor-agent-host', 'package.json'),
    alwaysLocalSingletonJs: join(appRoot, 'out', 'vs', 'code', 'electron-utility', 'alwaysLocalSingleton', 'alwaysLocalSingletonMain.js'),
    extensionHostJs: join(appRoot, 'out', 'vs', 'workbench', 'api', 'node', 'extensionHostProcess.js'),
    serverMainJs: join(appRoot, 'out', 'server-main.js'),
    productJson: join(appRoot, 'product.json'),
    extensionsDir: join(appRoot, 'extensions'),
    cursor2plusDir: join(appRoot, 'extensions', 'cursor2plus'),
  };
}

/**
 * Which tree is this? Decided by the entry point each build shape owns
 * exclusively, never by where the directory happens to live.
 */
function detectKind(tree) {
  if (existsSync(tree.workbenchJs)) return KIND_DESKTOP;
  if (existsSync(tree.serverMainJs)) return KIND_SERVER;
  return KIND_UNKNOWN;
}

function detectCapabilities(tree) {
  const capabilities = new Set();
  if (existsSync(tree.workbenchJs)) capabilities.add(CAP_RENDERER);
  if (existsSync(tree.glassJs)) capabilities.add(CAP_GLASS);
  if (existsSync(tree.workbenchHtml)) capabilities.add(CAP_WORKBENCH_HTML);
  if (existsSync(tree.utilityProcessDir)) capabilities.add(CAP_UTILITY_PROCESS);
  if (existsSync(tree.extensionHostJs)) capabilities.add(CAP_EXTENSION_HOST);
  if (existsSync(tree.extensionsDir)) capabilities.add(CAP_BUILTIN_EXTENSIONS);
  return capabilities;
}

/**
 * Describe one install tree.
 *
 * The returned object doubles as the `paths` bag every patch module already
 * takes, so adding the profile fields costs those modules nothing.
 */
export function buildProfile(appRoot) {
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
    hasGlass: capabilities.has(CAP_RENDERER)
      && (semver.major > 3 || (semver.major === 3 && semver.minor >= 8)),
  };
}

/** A tree is patchable only when we recognised its shape. */
export function isPatchableProfile(profile) {
  return Boolean(profile) && profile.kind !== KIND_UNKNOWN;
}

function normalizeKinds(value) {
  const list = typeof value === 'string' ? [value] : Array.isArray(value) ? value : [];
  return list.filter(kind => kind === 'ui' || kind === 'workspace' || kind === 'web');
}

/**
 * Resolve where a built-in extension runs, following VS Code's own order:
 * manifest `extensionKind`, then the product.json override map, then
 * `deduceExtensionKind` — anything with a node entry point is a `workspace`
 * extension, everything else is `ui`.
 *
 * @returns {string[]} empty when the extension is not shipped in this tree
 */
function resolveExtensionKind(profile, dirName) {
  const manifest = readJson(join(profile.extensionsDir, dirName, 'package.json'));
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

  return manifest.main ? ['workspace'] : ['ui'];
}

/**
 * Does this built-in extension actually run in this tree?
 *
 * This is what keeps `cursor-always-local` out of the server profile: the REH
 * tarball ships its 5.7 MB bundle, but the manifest declares
 * `extensionKind: ["ui"]`, so a Remote SSH window always runs it on the client
 * and the remote copy is dead weight. `cursor-agent-host` declares no
 * extensionKind and has a `main`, so it deduces to `workspace` and does run
 * there — which is exactly the gap the server profile has to close.
 */
export function extensionRunsHere(profile, dirName) {
  const kinds = resolveExtensionKind(profile, dirName);
  return kinds.some(kind => profile.hostRoles.includes(kind));
}
