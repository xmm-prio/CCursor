/**
 * Utility-process BYOK router (Cursor 3.9 – 3.18, "proxy-39")
 *
 * Cursor 3.8 introduced alwaysLocalSingletonMain.js, and 3.9 moved the active
 * AiService HTTP/1.1 transport into that singleton utility process, inlining
 * @connectrpc/connect-node's transport code with ESM namespace imports:
 *   import * as X from "http" / "https"; X.request(...)
 *
 * The extension-host routers (cursor-always-local, cursor-agent-host) cannot
 * reach across that process boundary, so the whitelist router has to be
 * installed inside the utility process as well. The patch does two things,
 * right after VSCode's own proxy-agent patch is installed:
 *   1. install a BYOK http/https.request whitelist router;
 *   2. (< 3.11.25 only) call module.syncBuiltinESMExports() so the ESM
 *      namespace imports used by the inlined HTTP/1.1 transport see the
 *      patched request functions. 3.11.25+ calls syncBuiltinESMExports natively.
 *
 * 3.19 removed the singleton utility process altogether — out/vs/code/
 * electron-utility/ only holds conversationSearch / mcpProcess / sharedProcess,
 * none of which carries an AiService transport. The transport is back in the
 * cursor-always-local and cursor-agent-host extension hosts, both already
 * covered by their own routers.
 *
 * Therefore the target is discovered, never assumed: every utility-process
 * bundle is fingerprinted for an AiService HTTP/1.1 transport. No match means
 * the patch is retired for this version; a match without the proxy-agent
 * install site means the layout moved and is reported as a failure rather than
 * silently skipped.
 */
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { createBackup } from './backup.js';
import { updateChecksums } from './checksum.js';
import { CCURSOR_DIR_NAME, DEFAULT_HOST, DEFAULT_PORT, ROUTES_FILE_NAME } from './defaults.js';

const TAG = 'proxy-39';
const SYNC_MARKER = '__byokSyncBuiltinESMExports';
const SYNC_CALL_MARKER = '/*BYOK-PROXY39*/';
const ROUTER_MARKER = '__byokSingletonUrlRewrite';
const ROUTER_CALL_MARKER = '/*BYOK-SINGLETON-ROUTER*/';
const TARGET_REL = 'out/vs/code/electron-utility/alwaysLocalSingleton/alwaysLocalSingletonMain.js';
const UTILITY_PROCESS_REL = ['out', 'vs', 'code', 'electron-utility'];
/** A utility process is in scope only when it owns an AiService HTTP/1.1 transport. */
const TRANSPORT_FINGERPRINTS = ['aiserver.v1.AiService', 'HTTP/1.1 transport created'];
/** ...and it is patchable only when VSCode's proxy-agent install site is inlined next to it. */
const PROXY_AGENT_ANCHOR = 'proxy-agent patches installed';

function parseSemver(v) {
  const [major = 0, minor = 0, patch = 0] = String(v || '0.0.0').split('.').map(n => Number(n) || 0);
  return { major, minor, patch };
}

function is39OrNewer(version) {
  const v = parseSemver(version);
  return v.major > 3 || (v.major === 3 && v.minor >= 9);
}

function is1125OrNewer(version) {
  const v = parseSemver(version);
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

// ── 目标发现 ──

/** Every *Main.js bundle under out/vs/code/electron-utility/, newest layout or not. */
export function listUtilityProcessBundles(paths) {
  const root = join(paths.appRoot, ...UTILITY_PROCESS_REL);
  if (!existsSync(root)) return [];
  const bundles = [];
  for (const dir of readdirSync(root, { withFileTypes: true })) {
    if (!dir.isDirectory()) continue;
    const dirPath = join(root, dir.name);
    for (const entry of readdirSync(dirPath, { withFileTypes: true })) {
      if (entry.isFile() && entry.name.endsWith('.js')) bundles.push(join(dirPath, entry.name));
    }
  }
  return bundles;
}

function hasTransport(source) {
  return TRANSPORT_FINGERPRINTS.every(fingerprint => source.includes(fingerprint));
}

function isPatchable(source) {
  return source.includes(PROXY_AGENT_ANCHOR)
    && /from\s*["']http["']/.test(source)
    && /from\s*["']https["']/.test(source);
}

/**
 * Classify the utility processes of this install.
 * @returns {{ targets: string[], unpatchable: string[] }}
 *   targets    — carry the AiService transport and expose the proxy-agent anchor
 *   unpatchable — carry the transport but no known insertion point
 */
function discoverTargets(paths) {
  const targets = [];
  const unpatchable = [];
  for (const file of listUtilityProcessBundles(paths)) {
    let source;
    try { source = readFileSync(file, 'utf-8'); }
    catch { continue; }
    if (!hasTransport(source)) continue;
    if (isPatchable(source)) targets.push(file);
    else unpatchable.push(file);
  }
  return { targets, unpatchable };
}

/**
 * Single source of truth for this patch's state, shared by install/status/check.
 * @returns {{ state: 'unsupported'|'retired'|'unreachable'|'patched'|'missing',
 *             required: boolean, patched: boolean, targets: string[],
 *             unpatchable: string[], summary: string }}
 */
export function inspectProxy39Patch(paths) {
  const base = { targets: [], unpatchable: [] };

  if (!is39OrNewer(paths.cursorVersion)) {
    return { ...base, state: 'unsupported', required: false, patched: true, summary: 'Cursor < 3.9, utility-process BYOK router not applicable' };
  }

  const { targets, unpatchable } = discoverTargets(paths);

  if (targets.length === 0 && unpatchable.length === 0) {
    return {
      ...base,
      state: 'retired',
      required: false,
      patched: true,
      summary: 'No utility process owns an AiService HTTP/1.1 transport (3.19+); coverage is provided by the always-local and agent-host routers',
    };
  }

  if (targets.length === 0) {
    return {
      targets, unpatchable,
      state: 'unreachable',
      required: true,
      patched: false,
      summary: `Utility-process AiService transport found without a known insertion point: ${unpatchable.map(shortName).join(', ')}`,
    };
  }

  const nativeSync = is1125OrNewer(paths.cursorVersion);
  const pending = targets.filter((file) => {
    const code = readFileSync(file, 'utf-8');
    return !(hasRouterPatch(code) && (hasSyncPatch(code) || nativeSync));
  });

  if (pending.length === 0) {
    return {
      targets, unpatchable,
      state: 'patched',
      required: true,
      patched: true,
      summary: `Utility-process BYOK router active in ${targets.map(shortName).join(', ')}`,
    };
  }

  return {
    targets, unpatchable,
    state: 'missing',
    required: true,
    patched: false,
    summary: `Utility-process BYOK router missing in ${pending.map(shortName).join(', ')}`,
  };
}

function shortName(file) {
  return file.split(/[\\/]/).pop();
}

/** Legacy path plus every discovered target, so uninstall/status cover both layouts. */
export function getProxy39BackupTargets(paths) {
  const legacy = paths.alwaysLocalSingletonJs || join(paths.appRoot, TARGET_REL);
  const targets = discoverTargets(paths).targets;
  return [...new Set(existsSync(legacy) ? [legacy, ...targets] : targets)];
}

// ── createRequire 定位 ──

function findCreateRequireAlias(source) {
  const re = /import\s*\{([^}]*)\}\s*from\s*(["'])node:module\2;?/g;
  let match;
  while ((match = re.exec(source)) !== null) {
    const spec = match[1].trim();
    const alias = spec.match(/\bcreateRequire\s+as\s+([$A-Z_a-z][$\w]*)\b/)?.[1];
    if (alias) return alias;
    if (/\bcreateRequire\b/.test(spec)) return 'createRequire';
  }
  return null;
}

// ── syncBuiltinESMExports 注入 (< 3.11.25 only) ──

function ensureSyncImport(source) {
  const re = /import\s*\{([^}]*)\}\s*from\s*(["'])node:module\2;?/g;
  let match;
  let targetMatch = null;
  let createRequireName = null;

  while ((match = re.exec(source)) !== null) {
    const spec = match[1].trim();
    const alias = spec.match(/\bcreateRequire\s+as\s+([$A-Z_a-z][$\w]*)\b/)?.[1];
    if (alias) createRequireName = alias;
    else if (/\bcreateRequire\b/.test(spec)) createRequireName = 'createRequire';

    const syncAlias = spec.match(/\bsyncBuiltinESMExports\s+as\s+([$A-Z_a-z][$\w]*)\b/)?.[1];
    if (syncAlias) return { source, fnName: syncAlias, createRequireName };
    if (/\bsyncBuiltinESMExports\b/.test(spec)) return { source, fnName: 'syncBuiltinESMExports', createRequireName };

    if (!targetMatch && createRequireName) targetMatch = match;
  }

  if (!createRequireName) {
    throw new Error('node:module createRequire import not found in utility-process bundle');
  }

  if (!targetMatch) {
    throw new Error('node:module import for createRequire not found');
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

// ── 插入逻辑 ──

function insertBeforeSyncCall(source, routerCall, fnName) {
  const exact = `${SYNC_CALL_MARKER}${fnName}()`;
  const idx = source.indexOf(exact);
  if (idx !== -1) {
    return source.slice(0, idx) + `${routerCall},` + source.slice(idx);
  }

  const call = `${fnName}()`;
  const anchor = source.indexOf(PROXY_AGENT_ANCHOR);
  if (anchor === -1) throw new Error('proxy-agent installed log anchor not found in utility-process bundle');
  const callIdx = source.lastIndexOf(call, anchor);
  if (callIdx === -1) throw new Error('syncBuiltinESMExports call not found before proxy-agent log anchor');
  return source.slice(0, callIdx) + `${routerCall},${SYNC_CALL_MARKER}` + source.slice(callIdx);
}

function insertRouterOnly(source, routerCall) {
  const idx = source.indexOf(PROXY_AGENT_ANCHOR);
  if (idx === -1) throw new Error('proxy-agent installed log anchor not found in utility-process bundle');

  // 3.11.25+: pattern is `installFn(arg),syncFn(),logger.info("...")`
  // Find the `)` right before the `,logger.info(...)` — insert router after the proxy-agent install call
  const start = Math.max(0, idx - 600);
  const window = source.slice(start, idx);
  const commaIdx = window.lastIndexOf('),');
  if (commaIdx === -1) throw new Error('proxy-agent install call not found before log anchor');

  const insertAt = start + commaIdx + 1;
  return source.slice(0, insertAt) + `,${routerCall}` + source.slice(insertAt);
}

function insertPatches(source, fnName, createRequireName, nativeSync) {
  const hasRouter = hasRouterPatch(source);
  const hasSync = hasSyncPatch(source) || nativeSync;
  if (hasRouter && hasSync) return source;

  const routerCall = buildSingletonRouterCall(createRequireName);

  // 3.11.25+: sync is native, only need router
  if (nativeSync) {
    if (hasRouter) return source;
    return insertRouterOnly(source, routerCall);
  }

  // Upgrade path for installations that already have the first proxy-39 sync-only patch.
  if (hasSync && !hasRouter) {
    return insertBeforeSyncCall(source, routerCall, fnName);
  }

  // Fast path for the minified production bundle (< 3.11.25):
  //   CLa(m),e.info("[AlwaysLocalSingleton] proxy-agent patches installed")
  const directRe = /([$_A-Z_a-z][$\w]*)\(([^(){};]{1,160})\),\s*([$_A-Z_a-z][$\w]*)\.info\((["'])\[AlwaysLocalSingleton\] proxy-agent patches installed\4\)/;
  if (directRe.test(source)) {
    return source.replace(directRe, (_m, installFn, arg, logger, quote) => {
      const syncCall = hasSync ? '' : `,${SYNC_CALL_MARKER}${fnName}()`;
      const router = hasRouter ? '' : `,${routerCall}`;
      return `${installFn}(${arg})${router}${syncCall},${logger}.info(${quote}[AlwaysLocalSingleton] proxy-agent patches installed${quote})`;
    });
  }

  // Fallback: anchor on the log string and insert after the immediately preceding call.
  const anchorIdx = source.indexOf(PROXY_AGENT_ANCHOR);
  if (anchorIdx === -1) {
    throw new Error('proxy-agent installed log anchor not found in utility-process bundle');
  }

  const start = Math.max(0, anchorIdx - 400);
  const window = source.slice(start, anchorIdx);
  const commaIdx = window.lastIndexOf('),');
  if (commaIdx === -1) {
    throw new Error('proxy-agent install call not found before log anchor');
  }

  const insertAt = start + commaIdx + 1;
  const patchCalls = `${hasRouter ? '' : `,${routerCall}`}${hasSync ? '' : `,${SYNC_CALL_MARKER}${fnName}()`}`;
  return source.slice(0, insertAt) + patchCalls + source.slice(insertAt);
}

/** Produce the patched source for one utility-process bundle. */
function buildPatchedSource(code, nativeSync) {
  if (nativeSync) {
    // 3.11.25+: sync is native, only the BYOK router is needed.
    const createRequireName = findCreateRequireAlias(code);
    if (!createRequireName) {
      throw new Error('node:module createRequire import not found in utility-process bundle');
    }
    const patched = insertPatches(code, null, createRequireName, true);
    if (!hasRouterPatch(patched)) throw new Error('insertion did not produce the router marker');
    return patched;
  }

  const imported = ensureSyncImport(code);
  const patched = insertPatches(imported.source, imported.fnName, imported.createRequireName, false);
  if (!hasRouterPatch(patched) || !hasSyncPatch(patched)) {
    throw new Error('insertion did not produce both the router and sync markers');
  }
  return patched;
}

// ── Public API ──

export function patchProxy39(paths, log) {
  const inspection = inspectProxy39Patch(paths);

  if (inspection.state === 'unsupported' || inspection.state === 'retired' || inspection.state === 'patched') {
    log?.(`[proxy-39] ${inspection.summary}, skipping`);
    return false;
  }
  if (inspection.state === 'unreachable') {
    throw new Error(`proxy-39: ${inspection.summary}`);
  }

  const nativeSync = is1125OrNewer(paths.cursorVersion);
  log?.(`[proxy-39] Patching ${inspection.targets.length} utility process(es)${nativeSync ? ' (native syncBuiltinESMExports)' : ''}...`);

  let modified = 0;
  for (const target of inspection.targets) {
    const code = readFileSync(target, 'utf-8');
    const patched = buildPatchedSource(code, nativeSync);
    if (patched === code) continue;
    createBackup(target, TAG, log);
    writeFileSync(target, patched);
    updateChecksums(paths, [target], TAG, log);
    modified++;
  }

  log?.(`[proxy-39] Done (${modified} file(s))`);
  return modified > 0;
}

export function checkProxy39Patch(paths, log) {
  const inspection = inspectProxy39Patch(paths);

  if (inspection.state === 'unsupported' || inspection.state === 'retired') {
    log?.(`  ${inspection.summary}`);
    return true;
  }
  if (inspection.state === 'unreachable') {
    log?.(`  [FAIL] ${inspection.summary}`);
    return false;
  }
  if (inspection.state === 'patched') {
    log?.(`  ${inspection.summary}`);
    return true;
  }

  const nativeSync = is1125OrNewer(paths.cursorVersion);
  for (const target of inspection.targets) {
    try {
      buildPatchedSource(readFileSync(target, 'utf-8'), nativeSync);
      log?.(`  [OK] ${shortName(target)}: BYOK router insertion point found`);
    } catch (e) {
      log?.(`  [FAIL] ${shortName(target)}: ${e.message}`);
      return false;
    }
  }
  return true;
}
