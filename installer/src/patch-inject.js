/**
 * Renderer Hook Injection — AST-based
 *
 * 从 patcher/src/inject.js 移植，与原版逻辑完全一致。
 */
import { existsSync, readFileSync, writeFileSync } from 'fs';
import * as acorn from 'acorn';
import { createBackup } from './backup.js';
import { updateChecksums } from './checksum.js';
import { loadRoutes } from './routes.js';
import { BASE_REDIRECT, BYOK_REDIRECT } from './defaults.js';
import { buildEndpointCandidates, buildRendererChannelSource, RENDERER_CHANNEL_VERSION_MARKER } from './routes-channel.js';

const HOOK_MARKER = '__byokWrapTransport';
const HOOK_SOURCE_MARKER = 'CURSOR-BYOK-HOOK-START';
const HOOK_CALL_SITE = `typeof globalThis.${HOOK_MARKER}==="function"?globalThis.${HOOK_MARKER}(`;
const HOOK_HEAD_WINDOW = 120000;

/**
 * Classify what is already in a workbench bundle.
 *
 * Three facts, because they fail independently: the prepended payload, the
 * rewritten Connect transport call site, and the version of the routes channel
 * inside the payload. The last one is why this is not a boolean — a bundle can
 * be correctly patched by an older installer and still need the current
 * payload, and reporting that as "already patched" is how a fix silently fails
 * to reach the user.
 */
function inspectHook(code) {
  const head = code.slice(0, HOOK_HEAD_WINDOW);
  const payload = head.includes(`/* ${HOOK_SOURCE_MARKER} */`);
  const callSite = code.includes(HOOK_CALL_SITE);
  const currentChannel = head.includes(RENDERER_CHANNEL_VERSION_MARKER);
  return {
    payload,
    callSite,
    currentChannel,
    /** Payload and call site agree — anything else is a half-applied patch. */
    consistent: payload === callSite,
    upToDate: payload && callSite && currentChannel,
  };
}

/** Verify the payload, the active Connect transport call site and the channel version. */
export function isInjectPatched(code) {
  return inspectHook(code).upToDate;
}

/** Full classification, for status output and the dry-run check. */
export function inspectInjectPatch(code) {
  return inspectHook(code);
}
// ConnectRPC 客户端模块的 esbuild 注册键。
//
// 3.17.8 起构建把模块路径从完整路径缩短成纯文件名:
//   ≤3.16.29  "out-build/external/bufbuild/connect/callback-client.js"
//   ≥3.17.8   "callback-client.js"
// 同一次变更让 bundle 里的 "bufbuild" 从 106 处降到 3 处、"connectrpc" 归零 ——
// 是构建配置改了,不是换掉了 ConnectRPC 库(BiDiStreaming/ServerStreaming 数量不变)。
//
// 所以锚点只取文件名部分: 对新版精确命中,对旧版作为完整路径的后缀同样命中,
// 一份锚点覆盖两种形态。
const ANCHORS = [
  'callback-client.js',
  'promise-client.js',
];
const SCAN_WINDOW = 2000;

// ---- string scanning (与原版一致) ----

function skipString(source, i) {
  const quote = source[i];
  i++;
  while (i < source.length) {
    const ch = source[i];
    if (ch === '\\') { i += 2; continue; }
    if (ch === quote) return i + 1;
    if (quote === '`' && ch === '$' && source[i + 1] === '{') {
      i += 2;
      let depth = 1;
      while (i < source.length && depth > 0) {
        const c = source[i];
        if (c === '{') depth++;
        else if (c === '}') depth--;
        else if (c === '"' || c === "'" || c === '`') { i = skipString(source, i); continue; }
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
  while (i < len && source[i] !== '(') i++;
  if (i >= len) return null;
  let parenDepth = 0;
  while (i < len) {
    const ch = source[i];
    if (ch === '(') parenDepth++;
    else if (ch === ')') { parenDepth--; if (parenDepth === 0) { i++; break; } }
    else if (ch === '"' || ch === "'" || ch === '`') { i = skipString(source, i); continue; }
    i++;
  }
  while (i < len && source[i] !== '{') i++;
  if (i >= len) return null;
  let braceDepth = 0;
  while (i < len) {
    const ch = source[i];
    if (ch === '{') braceDepth++;
    else if (ch === '}') { braceDepth--; if (braceDepth === 0) return { start: startOffset, end: i + 1 }; }
    else if (ch === '"' || ch === "'" || ch === '`') { i = skipString(source, i); continue; }
    else if (ch === '/' && i + 1 < len) {
      if (source[i + 1] === '/') { while (i < len && source[i] !== '\n') i++; continue; }
      if (source[i + 1] === '*') { i += 2; while (i + 1 < len && !(source[i] === '*' && source[i + 1] === '/')) i++; i += 2; continue; }
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
    const idx = source.indexOf('function ', i);
    if (idx === -1 || idx >= end) break;
    if (idx > 0 && /[\w$]/.test(source[idx - 1])) { i = idx + 9; continue; }
    results.push(idx);
    i = idx + 9;
  }
  return results;
}

// ---- hook payload ----
//
// 注入到 workbench renderer 的 IIFE,职责:
//   1. wrap ConnectRPC transport (__byokWrapTransport) — 观察 + 发往 collector
//   2. REST 端点重定向到本地 BYOK server
//   3. __byokRefreshModels —— 主动触发模型列表刷新 (借用 captureAiServiceRef
//      在 workbench.js 里泄漏到 globalThis 的 aiService 引用)
//   4. routes channel (routes-channel.js) —— 端点发现 + 启动期就绪门控 +
//      routes 热更新 + refresh 事件订阅, 取代早期的轮询与写死端点

export function buildHookPayload(hasGlass) {
  const routes = loadRoutes();
  const COLLECTOR_HOST = routes.collector.host;
  const COLLECTOR_PORT = routes.collector.port;
  // REST redirect 初始列表仅含 BASE_REDIRECT (stripe profile stub),
  // 保证 Cursor 启动时 /auth/poll 等登录关键端点不被拦截。
  // 完整白名单由 server 就绪后经 routes channel 下发。
  const restRedirects = BASE_REDIRECT.filter(r => r.startsWith('REST:')).map(r => r.slice(5));
  const restListJson = JSON.stringify(restRedirects);
  // 端点发现 + 就绪门控 + routes 热更新 —— 见 routes-channel.js
  const channel = buildRendererChannelSource({
    candidates: buildEndpointCandidates(routes.server),
    byokRedirect: BYOK_REDIRECT,
  });

  // 主体: collector observation + transport wrap + REST 重定向
  // unary/stream 包装中, 在调原始 transport 之前向 headers 注入 x-client-wid,
  // 后续 server 端直接从请求头读取, 无需 clientKey 映射。
  const main = `(function(){if(globalThis.__byokReady)return;globalThis.__byokReady=true;var _hasGlass=${hasGlass ? 'true' : 'false'};var _q=globalThis.__byokQueue=[];var _collectorUrl="http://${COLLECTOR_HOST}:${COLLECTOR_PORT}";var _sending=false;var _down=false;var _restPaths=${restListJson};var _restSet=new Set(_restPaths);function __byokLog(e){if(_down)return;e._t=Date.now();_q.push(e);if(!_sending)_flush()}function _flush(){if(_down||!_q.length){_sending=false;return}_sending=true;var batch=_q.splice(0,50);fetch(_collectorUrl+"/hook",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(batch)}).then(function(){}).catch(function(){_down=true;_q.length=0;console.warn("[BYOK] Collector not reachable at "+_collectorUrl+", logging disabled for this session")}).finally(function(){if(!_down)setTimeout(_flush,100);else _sending=false})}function __byokMsgToJson(e){if(!e)return null;try{if(typeof e.toJson==="function")return e.toJson()}catch(x){}try{if(typeof e.toJsonString==="function")return JSON.parse(e.toJsonString())}catch(x){}return e}function __byokHeadersToObj(e){if(!e)return{};try{if(e instanceof Headers)return Object.fromEntries(e)}catch(x){}return typeof e==="object"?e:{}}function __byokCloneBody(r){if(!r.body)return Promise.resolve(null);try{return r.clone().text()}catch(e){return Promise.resolve(null)}}function __byokInjectWid(hdrs){var wid=typeof window!=="undefined"&&window.vscodeWindowId;if(typeof wid!=="number")return hdrs;var widStr=String(wid);try{if(hdrs&&typeof hdrs.set==="function"){hdrs.set("x-client-wid",widStr);return hdrs}if(hdrs&&typeof hdrs==="object"&&!Array.isArray(hdrs)){hdrs["x-client-wid"]=widStr;return hdrs}if(Array.isArray(hdrs)){hdrs.push(["x-client-wid",widStr]);return hdrs}}catch(e){}var h=new Headers();h.set("x-client-wid",widStr);return h}globalThis.__byokWrapTransport=function(t,n){return{unary:async function(e,r,i,o,s,a,c){if(_byokGated(e.typeName,r.name))await __byokAwaitReady();s=__byokInjectWid(s);var u=Math.random().toString(36).slice(2,10),l=Date.now();__byokLog({type:"unary_req",id:u,svc:e.typeName,mtd:r.name,hdr:__byokHeadersToObj(s),msg:__byokMsgToJson(a)});try{var d=await t.unary(e,r,i,o,s,a,c);__byokLog({type:"unary_res",id:u,dur:Date.now()-l,svc:e.typeName,mtd:r.name,msg:__byokMsgToJson(d.message)});return d}catch(d){__byokLog({type:"unary_err",id:u,dur:Date.now()-l,svc:e.typeName,mtd:r.name,err:d?.message||String(d),code:d?.code});throw d}},stream:async function(e,r,i,o,s,a,c){if(_byokGated(e.typeName,r.name))await __byokAwaitReady();s=__byokInjectWid(s);var u=Math.random().toString(36).slice(2,10),l=Date.now();__byokLog({type:"stream_req",id:u,svc:e.typeName,mtd:r.name,hdr:__byokHeadersToObj(s)});var f=(async function*(){var t=0;for await(var n of a){__byokLog({type:"stream_in",id:u,svc:e.typeName,mtd:r.name,idx:t++,msg:__byokMsgToJson(n)});yield n}})();try{var d=await t.stream(e,r,i,o,s,f,c),h=d.message;d.message=(async function*(){var t=0;for await(var n of h){__byokLog({type:"stream_out",id:u,svc:e.typeName,mtd:r.name,idx:t++,msg:__byokMsgToJson(n)});yield n}__byokLog({type:"stream_end",id:u,dur:Date.now()-l,svc:e.typeName,mtd:r.name,chunks:t})})();return d}catch(d){__byokLog({type:"stream_err",id:u,dur:Date.now()-l,svc:e.typeName,mtd:r.name,err:d?.message||String(d),code:d?.code});throw d}}}};var _origFetch=globalThis.fetch;function _byokFetch(args){var urlArg=args[0];var u=typeof urlArg==="string"?urlArg:(urlArg instanceof Request?urlArg.url:"");var init=args[1]||{};for(var i=0;i<_restPaths.length;i++){if(u.indexOf(_restPaths[i])!==-1){var id=Math.random().toString(36).slice(2,10);var ts=Date.now();var reqMethod=init.method||(urlArg instanceof Request?urlArg.method:"GET")||"GET";var reqHeaders=__byokHeadersToObj(urlArg instanceof Request?urlArg.headers:init.headers);var reqBody=urlArg instanceof Request&&urlArg.body?urlArg.body:(init.body||null);var path=_restPaths[i];var newUrl=_byokUrl+(u.match(/^https?:\\/\\/[^/]*/)?u.replace(/^https?:\\/\\/[^/]*/,""):"/");__byokLog({type:"rest_redirect",id:id,path:path,originalUrl:u,redirectUrl:newUrl,method:reqMethod,reqHeaders:reqHeaders,reqBody:reqBody});var newInit=Object.assign({},init);newInit.headers=__byokInjectWid(newInit.headers);var newArgs=[newUrl,newInit];for(var j=2;j<args.length;j++)newArgs.push(args[j]);return _origFetch.apply(globalThis,newArgs).then(function(resp){var r=resp.clone();__byokLog({type:"rest_response",id:id,path:path,status:r.status,resHeaders:__byokHeadersToObj(r.headers)});__byokCloneBody(r).then(function(text){if(text){__byokLog({type:"rest_body",id:id,path:path,body:text})}}).catch(function(){});return resp}).catch(function(err){__byokLog({type:"rest_error",id:id,path:path,error:err?.message||String(err)});throw err})}}if(u.indexOf(_byokUrl)===0){var nInit=Object.assign({},init);nInit.headers=__byokInjectWid(nInit.headers);var nArgs=[urlArg,nInit];for(var k=2;k<args.length;k++)nArgs.push(args[k]);return _origFetch.apply(globalThis,nArgs)}return _origFetch.apply(globalThis,args)}globalThis.fetch=function(){var args=Array.prototype.slice.call(arguments);var first=args[0];var probe=typeof first==="string"?first:(first instanceof Request?first.url:"");if(_byokGatedPath(probe))return __byokAwaitReady().then(function(){return _byokFetch(args)});return _byokFetch(args)};`;

  // 模型列表刷新机制
  // __byokAiSvc 由 captureAiServiceRef 在 workbench.js 字符串重写时泄漏到 globalThis,
  // 启动期 chat panel 挂载/登录监听首次执行 refreshDefaultModels 时即赋值。
  // 兜底: aiService 引用未捕获时尝试 DOM 点击 [title="Refresh model list"] 按钮。
  //
  // 通知通道: EventSource 订阅 /byok/events, server 在 bumpRefreshSignal 时推送 "event: refresh",
  // 替代了早期的 3s 轮询 /byok/refresh-signal 方案。EventSource 会自动重连。
  // Model Picker "Refresh Models" 按钮注入
  //
  // 监听 .ui-model-picker__menu 出现 → 在 "Add Models" 同级位置注入 "Refresh Models" 选项。
  // 使用 ui-model-picker__user-action-item 类复用原生样式。
  // 点击触发 __byokRefreshModels() 刷新模型列表。
  // Editor Window / Agent Window 均生效。
  // 在模型选择器搜索框右侧注入 Refresh 按钮。
  // 搜索框结构: div.ui-palette-input-wrapper[cmdk-input-wrapper] > icon + input
  // 在 wrapper 末尾追加 button，flex 布局自动排右。
  // 使用 __icon-button 原生样式 (16px, transparent bg, cursor:pointer)。
  const pickerRefresh = `(function(){if(!document.body)return;var _prObs=new MutationObserver(function(){var inp=document.querySelector('input[placeholder="Search models"]');if(!inp)return;var wrap=inp.closest(".ui-input-group");if(!wrap||wrap.querySelector("#byok-refresh-btn"))return;var btn=document.createElement("button");btn.type="button";btn.id="byok-refresh-btn";var _rDonor=_hasGlass?document.querySelector("button.ui-icon-button"):null;btn.className=_rDonor?_rDonor.className:"ui-icon-button";btn.dataset.variant="default";btn.dataset.size="sm";btn.setAttribute("aria-label","Refresh Models");btn.style.cssText="margin-right:4px;flex-shrink:0;cursor:pointer;";btn.textContent="\\u21BB";btn.addEventListener("click",function(ev){ev.stopPropagation();globalThis.__byokRefreshModels&&globalThis.__byokRefreshModels();console.log("[BYOK] manual refresh from picker")});wrap.appendChild(btn)});_prObs.observe(document.body,{childList:true,subtree:true})})();`;

  // Glass sidebar BYOK 状态指示器
  //
  // Agent Window (glass mode) 没有 VS Code 状态栏。
  // 通过 MutationObserver 等待 glass sidebar footer 渲染后注入。
  //
  // 3.7 (desktop bundle 内的 glass panel):
  //   glass-sidebar-footer-bar > ... + glass-sidebar-footer-actions-right
  //   注入到 actions-right 开头 (insertBefore firstChild)
  //   样式: ui-icon-button size=lg, 原始 flex 布局自动适配
  //
  // 3.8+ (独立 glass bundle):
  //   glass-sidebar-footer-bar > dropdown + ◇按钮
  //   actions-right 不再存在, 注入到 footer-bar 末尾倒数第二位 (◇按钮之前)
  //   样式: 去边框, 缩小, 继承前景色
  const glassStatus = `(function(){var _bEl=null,_bTip=null,_bSrv=false,_bMode=false;function _bCreate(){var e=document.createElement("button");e.type="button";e.className="ui-icon-button";e.dataset.variant="default";e.dataset.size="lg";e.id="byok-glass-status";if(_hasGlass){var donor=document.querySelector("button.ui-icon-button");if(donor){e.className=donor.className}else{e.className="ui-icon-button"}e.style.cssText="width:auto;min-width:auto;font-size:10px;gap:2px;white-space:nowrap;"}else{e.className="ui-icon-button";e.dataset.variant="default";e.dataset.size="lg";e.style.cssText="font-size:11px;gap:3px;width:auto;white-space:nowrap;"}e.addEventListener("click",function(){fetch(_byokUrl+"/byok/toggle",{method:"POST"}).then(function(r){return r.json()}).then(function(d){console.log("[BYOK] toggle \\u2192",d.byokMode?"ON":"OFF")}).catch(function(e){console.warn("[BYOK] toggle failed:",e&&e.message||e)})});e.addEventListener("mouseenter",function(){_bShowTip()});e.addEventListener("mouseleave",function(){_bHideTip()});return e}function _bShowTip(){if(_bTip||!_bEl)return;var t=document.createElement("div");t.className="ui-tooltip";t.setAttribute("role","tooltip");t.style.cssText="position:fixed;z-index:99999;pointer-events:none;box-sizing:border-box;width:max-content;max-width:320px;background:var(--cursor-bg-elevated);color:var(--cursor-text-primary);border:var(--ui-tooltip-border-width,1px) solid var(--cursor-stroke-primary);border-radius:var(--ui-tooltip-border-radius,var(--cursor-radius-lg));box-shadow:var(--ui-tooltip-box-shadow,var(--cursor-box-shadow-popup));padding:var(--ui-tooltip-padding-y,var(--cursor-spacing-1-5)) var(--ui-tooltip-padding-x,var(--cursor-spacing-2-5));font-size:var(--ui-tooltip-font-size,var(--cursor-font-size-base));line-height:var(--ui-tooltip-line-height,var(--cursor-line-height-base));letter-spacing:var(--ui-tooltip-letter-spacing,var(--cursor-letter-spacing-base));white-space:pre-line;";t.textContent=(_bSrv?"Server online":"Server offline")+" \\u00B7 "+(_bMode?"BYOK ON":"BYOK OFF");document.body.appendChild(t);var r=_bEl.getBoundingClientRect();var tw=t.offsetWidth,th=t.offsetHeight;t.style.left=Math.round(r.left+r.width/2-tw/2)+"px";t.style.top=Math.round(r.top-th-6)+"px";_bTip=t}function _bHideTip(){if(_bTip){_bTip.remove();_bTip=null}}function _bRender(){if(!_bEl)return;var icon=_bSrv?"\\u2713":"\\u2717";var glyph=_bMode?"\\u25C9":"\\u25CB";_bEl.textContent=icon+" BYOK "+glyph}function _bInject(){if(_bEl&&document.contains(_bEl))return;var footer=document.querySelector('[data-component="glass-sidebar-footer"]');if(footer){var gear=footer.querySelector("button.ui-icon-button");if(gear&&gear.parentElement){_bEl=_bCreate();_bRender();gear.parentElement.insertBefore(_bEl,gear);return}}var trigger=document.querySelector(".glass-sidebar-footer-account-trigger");var endIcon=trigger&&trigger.querySelector(".ui-sidebar-menu-button-end");if(trigger&&endIcon){_bEl=_bCreate();_bRender();trigger.insertBefore(_bEl,endIcon);return}var actOld=document.querySelector(".glass-sidebar-footer-actions-right");if(actOld){_bEl=_bCreate();_bRender();actOld.insertBefore(_bEl,actOld.firstChild)}}if(document.body){var _bObs=new MutationObserver(function(){_bInject()});_bObs.observe(document.body,{childList:true,subtree:true});_bInject()}globalThis.__byokGlassStatus=function(srv,mode){if(srv!==void 0)_bSrv=srv;if(mode!==void 0)_bMode=mode;_bRender()}})();`;

  const refreshLogic = `globalThis.__byokRefreshModels=function(){if(globalThis.__byokAiSvc&&typeof globalThis.__byokAiSvc.refreshDefaultModels==="function"){try{var p=globalThis.__byokAiSvc.refreshDefaultModels();console.log("[BYOK] refreshDefaultModels() invoked via captured aiService ref");if(p&&typeof p.then==="function")p.catch(function(e){console.warn("[BYOK] refreshDefaultModels failed:",e&&e.message||e)});return"service"}catch(e){console.warn("[BYOK] refreshDefaultModels threw:",e&&e.message||e)}}var btn=document.querySelector('[title="Refresh model list"]');if(btn&&typeof btn.click==="function"){btn.click();console.log("[BYOK] refresh triggered via DOM click fallback");return"click"}console.warn("[BYOK] no refresh mechanism available (aiService not captured, picker not visible)");return"none"};`;

  // 顺序有意义: channel 在初始化末尾立即开始端点探测, 依赖前面 main 里
  // 声明的 _origFetch / _restPaths, 也依赖 refreshLogic 之后才可用的
  // __byokRefreshModels (仅在事件回调里惰性引用, 不影响初始化)。
  return main + refreshLogic + channel + pickerRefresh + glassStatus + `console.log("[BYOK] Hook loaded, collector="+_collectorUrl+", byok candidates="+_byokCandidates.join(", "))})()`;
}

// ---- AST fingerprinting + patch ----

export function findTarget(code, log) {
  let anchorOffset = -1;
  for (const anchor of ANCHORS) {
    const idx = code.indexOf(anchor);
    if (idx !== -1) { anchorOffset = idx; log?.(`  Anchor: "${anchor}" at ${idx}`); break; }
  }
  if (anchorOffset === -1) throw new Error('ConnectRPC client module anchor not found');

  const funcStarts = findFunctionStarts(code, anchorOffset, SCAN_WINDOW);
  let dispatcherName = null, dispatcherBounds = null;

  for (const fStart of funcStarts) {
    const bounds = extractFunction(code, fStart);
    if (!bounds) continue;
    const body = code.slice(bounds.start, bounds.end);
    if (body.includes('.Unary') && body.includes('.ServerStreaming') && body.includes('.BiDiStreaming')) {
      let ast;
      try { ast = acorn.parse(body, { ecmaVersion: 2022, sourceType: 'script' }); } catch { continue; }
      const decl = ast.body[0];
      if (decl?.type === 'FunctionDeclaration' && decl.id?.name) {
        dispatcherName = decl.id.name;
        dispatcherBounds = bounds;
        log?.(`  Dispatcher: ${dispatcherName}`);
        break;
      }
    }
  }
  if (!dispatcherName) throw new Error('Dispatcher function not found');

  const postStarts = findFunctionStarts(code, dispatcherBounds.end, SCAN_WINDOW);
  for (const fStart of postStarts) {
    const bounds = extractFunction(code, fStart);
    if (!bounds) continue;
    const body = code.slice(bounds.start, bounds.end);
    if (!body.includes(dispatcherName)) continue;
    let ast;
    try { ast = acorn.parse(body, { ecmaVersion: 2022, sourceType: 'script' }); } catch { continue; }
    const decl = ast.body[0];
    if (!decl || decl.type !== 'FunctionDeclaration') continue;
    if (decl.params?.length !== 2) continue;
    if (decl.params.some(p => p.type !== 'Identifier')) continue;
    const p0 = decl.params[0].name, p1 = decl.params[1].name;
    const stmts = decl.body?.body;
    if (!stmts || stmts.length !== 1 || stmts[0].type !== 'ReturnStatement') continue;
    const ret = stmts[0].argument;
    if (!ret || ret.type !== 'CallExpression') continue;
    if (ret.callee?.type !== 'Identifier' || ret.callee.name !== dispatcherName) continue;
    if (ret.arguments?.length !== 2) continue;
    if (ret.arguments[0].name !== p0 || ret.arguments[1].name !== p1) continue;

    return { name: decl.id.name, bounds, source: body, paramService: p0, paramTransport: p1, innerFn: dispatcherName };
  }
  throw new Error(`No delegate wrapper found for "${dispatcherName}"`);
}

/**
 * 通过 AST 校验 + 字符串替换, 把所有 `X.aiService.refreshDefaultModels(` 调用点
 * 改写为 `(globalThis.__byokAiSvc=X.aiService).refreshDefaultModels(`
 *
 * 目的: Cursor 启动后 (chat panel 挂载、登录监听器触发等) 任意一次该方法被调用时,
 *       aiService 实例引用就被泄漏到 globalThis.__byokAiSvc 上。之后扩展端
 *       通过信号机制让 renderer hook 直接 globalThis.__byokAiSvc.refreshDefaultModels()
 *       即可主动刷新模型列表, 无需 DOM 点击 / 无需用户操作。
 *
 * 跨版本稳定性:
 *   - 不依赖任何混淆变量名
 *   - 仅依赖 protobuf 属性名 `aiService` 和 `refreshDefaultModels` (与 .proto 同步, 极稳定)
 *   - 每个候选位置用 acorn parseExpressionAt 单独验证 AST 形态
 *   - 接受形态: `Identifier.aiService.refreshDefaultModels(...)` 或 `this.aiService.refreshDefaultModels(...)`
 *   - 拒绝形态: 嵌套 MemberExpression (e.g. `obj.foo.aiService.refreshDefaultModels()`) 或位于 string/comment 中的字面文本
 */
function captureAiServiceRef(code, log) {
  const NEEDLE = '.aiService.refreshDefaultModels(';
  const replacements = [];
  let scanFrom = 0;
  let candidateCount = 0;

  while (true) {
    const dotIdx = code.indexOf(NEEDLE, scanFrom);
    if (dotIdx === -1) break;
    candidateCount++;
    scanFrom = dotIdx + NEEDLE.length;

    // 向前提取 X identifier 或 'this' 起点
    let i = dotIdx - 1;
    while (i >= 0 && /[a-zA-Z0-9_$]/.test(code[i])) i--;
    const xStart = i + 1;
    if (xStart === dotIdx) continue;

    // acorn 从 xStart parseExpressionAt 验证 AST 形态
    let ast;
    try {
      ast = acorn.parseExpressionAt(code, xStart, { ecmaVersion: 2022, sourceType: 'module' });
    } catch {
      continue;
    }
    // 多个调用经常以 SequenceExpression 串联 (如 `e.aiService.refreshDefaultModels(),e.aiService.performDefaultModelRequest()`)
    if (ast.type === 'SequenceExpression') ast = ast.expressions[0];

    if (ast?.type !== 'CallExpression') continue;
    const c = ast.callee;
    if (c?.type !== 'MemberExpression') continue;
    if (c.property?.type !== 'Identifier' || c.property.name !== 'refreshDefaultModels') continue;
    if (c.object?.type !== 'MemberExpression') continue;
    if (c.object.property?.type !== 'Identifier' || c.object.property.name !== 'aiService') continue;
    const inner = c.object.object;
    if (inner.type !== 'Identifier' && inner.type !== 'ThisExpression') continue;

    // 替换 X.aiService 为 (globalThis.__byokAiSvc=X.aiService)
    const xText = code.slice(inner.start, inner.end);
    replacements.push({
      start: inner.start,
      end: c.object.end,
      text: `(globalThis.__byokAiSvc=${xText}.aiService)`,
    });
  }

  // 倒序应用避免偏移失效
  replacements.sort((a, b) => b.start - a.start);
  let result = code;
  for (const r of replacements) {
    result = result.slice(0, r.start) + r.text + result.slice(r.end);
  }
  log?.(`  aiService ref capture: ${replacements.length}/${candidateCount} call sites (AST validated)`);
  return result;
}

/**
 * MAX Mode toggle 数据驱动隐藏 (AST 精确匹配)。
 *
 * 目标: MaxModeToggle 组件 (名为 Kec 等, 混淆后不固定)。
 * 识别方式: function 体内包含 `setMaxMode` + `"MAX Mode"` + 从 PY() 解构 state。
 *
 * 补丁: 在函数体开头注入 models 检查 guard —
 *   const{models:_ms}=PY();if(!_ms.some(_m=>_m._supportsMaxMode))return null;
 *
 * PY() 是 React context hook, 多次调用无副作用。
 * _supportsMaxMode 是 picker 内部 model 对象的属性 (从 proto supportsMaxMode 派生)。
 *
 * 效果: BYOK ON (所有模型 supportsMaxMode=false) → 组件返回 null → toggle 隐藏
 *        BYOK OFF (官方模型, 部分 supportsMaxMode=true) → 正常渲染
 */
function patchMaxModeToggle(code, log) {
  const BODY_ANCHOR = '"MAX Mode"';
  const anchorIdx = code.indexOf(BODY_ANCHOR);
  if (anchorIdx === -1) {
    log?.('  [max-mode-toggle] anchor "MAX Mode" not found — skipping');
    return code;
  }

  // 向前找到包含 "MAX Mode" 和 setMaxMode 的函数
  const funcStarts = findFunctionStarts(code, Math.max(0, anchorIdx - 3000), 3000);
  let targetFn = null;
  for (const fStart of funcStarts) {
    const bounds = extractFunction(code, fStart);
    if (!bounds || bounds.end < anchorIdx) continue;
    if (bounds.start > anchorIdx) break;
    const body = code.slice(bounds.start, bounds.end);
    if (body.includes(BODY_ANCHOR) && body.includes('setMaxMode')) {
      targetFn = bounds;
      break;
    }
  }
  if (!targetFn) {
    log?.('  [max-mode-toggle] MaxModeToggle function not found — skipping');
    return code;
  }

  // AST 验证: 确认是 FunctionDeclaration, 参数为 0 个, 体内包含 PY() 调用
  const fnSource = code.slice(targetFn.start, targetFn.end);
  let ast;
  try { ast = acorn.parse(fnSource, { ecmaVersion: 2022, sourceType: 'script' }); } catch (e) {
    log?.(`  [max-mode-toggle] AST parse failed: ${e.message} — skipping`);
    return code;
  }
  const fnDecl = ast.body[0];
  if (!fnDecl || fnDecl.type !== 'FunctionDeclaration' || !fnDecl.id?.name) {
    log?.('  [max-mode-toggle] unexpected AST shape — skipping');
    return code;
  }
  // 从 AST 提取 context hook 调用名 — 查找 { setMaxMode: ... } = <callee>()
  // callee 是混淆变量名 (如 PY), 每版本不同, 必须动态提取
  let contextHookName = null;
  function walkForContextHook(node) {
    if (!node || typeof node !== 'object') return;
    if (node.type === 'VariableDeclarator' && node.id?.type === 'ObjectPattern' && node.init?.type === 'CallExpression') {
      const hasSetMaxMode = node.id.properties?.some(p => p.key?.name === 'setMaxMode');
      if (hasSetMaxMode && node.init.callee?.type === 'Identifier') {
        contextHookName = node.init.callee.name;
      }
    }
    for (const key of Object.keys(node)) {
      if (contextHookName) return;
      const child = node[key];
      if (Array.isArray(child)) child.forEach(c => { if (c && c.type) walkForContextHook(c); });
      else if (child && child.type) walkForContextHook(child);
    }
  }
  walkForContextHook(fnDecl);
  if (!contextHookName) {
    log?.('  [max-mode-toggle] context hook (setMaxMode destructor) not found via AST — skipping');
    return code;
  }

  // 找到函数体 '{' 的位置, 在其后注入 guard
  const bodyStart = targetFn.start + fnDecl.body.start + 1; // +1 跳过 '{'
  const guard = `const{models:_ms}=${contextHookName}();if(!_ms.some(_m=>_m.name!=="default"&&_m.supportsMaxMode))return null;`;
  const result = code.slice(0, bodyStart) + guard + code.slice(bodyStart);
  log?.(`  [max-mode-toggle] injected guard into ${fnDecl.id.name}() via ${contextHookName}(): return null when no model supports Max Mode`);
  return result;
}

const EXTENSION_ID = 'cometix-space.cursor2plus';

/**
 * KaTeX 的 \sqrt / stretchy delimiter / cancel 会生成 inline SVG。
 * Cursor 的 allowMath sanitizer schema 只放行 MathML 时,根号 SVG 会被过滤。
 *
 * 跨版本策略:
 * - 不依赖混淆变量名 (u7b/GVT 等每版变化)。
 * - 从包含 msqrt/mroot 的 math tag array 反向定位 AssignmentExpression。
 * - 用 AST 精确校验 tag array 和紧邻的属性 schema ObjectExpression 结构。
 * - 只追加 KaTeX 必需的 svg/path/line 标签和最小属性集,不放行 href/on* / style / foreignObject。
 *
 * 注意: installer production build 会经过 js-confuser。这里刻意写成单函数 + 命令式循环,
 * 避免复杂 helper/callback 在混淆后触发错误重命名。
 */
function patchKatexMathSvgSanitizer(code, log) {
  const requiredTags = ['math', 'semantics', 'mrow', 'mi', 'mo', 'mn', 'mtext', 'mfrac', 'msqrt', 'mroot', 'annotation'];
  const svgTags = ['svg', 'path', 'line'];
  const svgAttrs = ['xmlns', 'width', 'height', 'viewBox', 'viewbox', 'preserveAspectRatio', 'preserveaspectratio'];
  const lineAttrs = ['x1', 'y1', 'x2', 'y2', 'stroke-width', 'strokeWidth'];

  function literalString(node) {
    return node && node.type === 'Literal' && typeof node.value === 'string' ? node.value : undefined;
  }
  function propertyName(prop) {
    if (!prop || prop.type !== 'Property' || prop.computed) return undefined;
    if (prop.key.type === 'Identifier') return prop.key.name;
    return literalString(prop.key);
  }
  function arrayStrings(node) {
    if (!node || node.type !== 'ArrayExpression') return undefined;
    const values = [];
    for (let i = 0; i < node.elements.length; i++) {
      const value = literalString(node.elements[i]);
      if (value === undefined) return undefined;
      values.push(value);
    }
    return values;
  }
  function firstExpr(expr) {
    return expr && expr.type === 'SequenceExpression' ? expr.expressions[0] : expr;
  }
  function containsAll(values, required) {
    for (let i = 0; i < required.length; i++) {
      if (!values.includes(required[i])) return false;
    }
    return true;
  }
  function tagAssignmentValues(expr) {
    const candidate = firstExpr(expr);
    if (!candidate || candidate.type !== 'AssignmentExpression' || candidate.operator !== '=') return undefined;
    if (!candidate.left || candidate.left.type !== 'Identifier') return undefined;
    const values = arrayStrings(candidate.right);
    if (!values || !containsAll(values, requiredTags)) return undefined;
    return { assignment: candidate, values };
  }
  function attributeSchemaInfo(node) {
    if (!node || node.type !== 'ObjectExpression') return undefined;
    const props = Object.create(null);
    for (let i = 0; i < node.properties.length; i++) {
      const prop = node.properties[i];
      const key = propertyName(prop);
      if (key) props[key] = prop.value;
    }
    const requiredKeys = ['math', 'semantics', 'annotation', 'mfrac', 'msqrt', 'mroot', 'mtd'];
    for (let i = 0; i < requiredKeys.length; i++) {
      if (!props[requiredKeys[i]]) return undefined;
    }
    const mathAttrs = arrayStrings(props.math) || [];
    const mtdAttrs = arrayStrings(props.mtd) || [];
    const mfracAttrs = arrayStrings(props.mfrac) || [];
    if (!mathAttrs.includes('xmlns') || !mathAttrs.includes('display')) return undefined;
    if (!mtdAttrs.includes('columnalign')) return undefined;
    if (!mfracAttrs.includes('linethickness')) return undefined;
    return { node, props };
  }
  function svgPropertySource(key) {
    if (key === 'svg') return `svg:${JSON.stringify(svgAttrs)}`;
    if (key === 'path') return 'path:["d"]';
    if (key === 'line') return `line:${JSON.stringify(lineAttrs)}`;
    throw new Error(`unknown KaTeX SVG sanitizer property: ${key}`);
  }
  function assignmentStartBeforeArray(arrayStart) {
    let i = arrayStart - 1;
    while (i >= 0 && /\s/.test(code[i])) i--;
    if (code[i] !== '=') return -1;
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

    const arrayStart = code.lastIndexOf('[', msqrtIdx);
    if (arrayStart === -1) continue;
    const exprStart = assignmentStartBeforeArray(arrayStart);
    if (exprStart === -1 || seenTagStarts.includes(exprStart)) continue;

    let parsed;
    try {
      parsed = acorn.parseExpressionAt(code, exprStart, { ecmaVersion: 2022, sourceType: 'script' });
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
        text: `${tagInfo.values.length > 0 ? ',' : ''}${parts.join(',')}`,
      });
    }

    const expressions = parsed.type === 'SequenceExpression' ? parsed.expressions : [parsed];
    for (let i = 0; i < expressions.length; i++) {
      const expr = expressions[i];
      if (!expr || expr.type !== 'AssignmentExpression' || expr.operator !== '=') continue;
      if (!expr.left || expr.left.type !== 'Identifier') continue;
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
          text: `${expr.right.properties.length > 0 ? ',' : ''}${propSources.join(',')}`,
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

/**
 * Agent Window (glass) 扩展白名单放行。
 *
 * 白名单由两个数组定义: 一个"核心"数组 (内置 deeplink / socket / auth 扩展),
 * 一个"远程"数组 (remote-ssh / wsl / containers)。两者各被多处引用
 * (函数返回值、.filter()、.includes()、派生的组合数组), 所以只改数组定义,
 * 全部引用点自动生效。
 *
 * 跨版本策略:
 * - 不依赖"某个成员恰好在数组末尾"。旧锚点 '"anysphere.remote-wsl"]' 在
 *   remote-containers 追加到其后就失效了, 而它失效时 installer 只发 warning,
 *   核心数组仍能命中, 于是静默半成功。
 * - 改为: 用成员字面量定位候选, 回退到数组定义处, 用 AST 校验
 *   `<ident> = [ ...<base>, "a", "b", ... ]` 的形态, 再在 ']' 之前追加。
 * - 两个数组必须各命中恰好一次, 否则抛错而不是告警。
 *
 * 注意: installer production build 会经过 js-confuser。这里刻意写成单函数 +
 * 命令式循环, 避免复杂 helper/callback 在混淆后触发错误重命名。
 */
function patchGlassExtensionAllowlist(code, log) {
  const allowlists = [
    {
      label: 'core',
      probe: '"vscode.github-authentication"',
      members: ['anysphere.cursor-deeplink', 'anysphere.cursor-resolver-helper', 'anysphere.cursor-socket', 'vscode.github-authentication'],
    },
    {
      label: 'remote',
      probe: '"anysphere.remote-wsl"',
      members: ['anysphere.remote-ssh', 'anysphere.remote-wsl', 'anysphere.remote-containers'],
    },
  ];

  function definitionStart(arrayStart) {
    let i = arrayStart - 1;
    while (i >= 0 && /\s/.test(code[i])) i--;
    if (code[i] !== '=') return -1;
    i--;
    while (i >= 0 && /\s/.test(code[i])) i--;
    const end = i + 1;
    while (i >= 0 && /[a-zA-Z0-9_$]/.test(code[i])) i--;
    const start = i + 1;
    return start === end ? -1 : start;
  }

  // `<ident> = [ ...<base>, "a", "b" ]` —— 前导 spread 是这两个白名单数组的
  // 结构特征, 用它把同样含有这些成员的扁平字面量数组区分开。
  function allowlistArray(expr, required) {
    const node = expr && expr.type === 'SequenceExpression' ? expr.expressions[0] : expr;
    if (!node || node.type !== 'AssignmentExpression' || node.operator !== '=') return undefined;
    if (!node.left || node.left.type !== 'Identifier') return undefined;
    const array = node.right;
    if (!array || array.type !== 'ArrayExpression') return undefined;
    if (!array.elements.length || array.elements[0].type !== 'SpreadElement') return undefined;

    const values = [];
    for (let i = 1; i < array.elements.length; i++) {
      const element = array.elements[i];
      if (!element || element.type !== 'Literal' || typeof element.value !== 'string') return undefined;
      values.push(element.value);
    }
    for (let i = 0; i < required.length; i++) {
      if (!values.includes(required[i])) return undefined;
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

      const arrayStart = code.lastIndexOf('[', probeIdx);
      if (arrayStart === -1) continue;
      const exprStart = definitionStart(arrayStart);
      if (exprStart === -1 || seen.includes(exprStart)) continue;

      let parsed;
      try {
        parsed = acorn.parseExpressionAt(code, exprStart, { ecmaVersion: 2022, sourceType: 'script' });
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
      const names = matches.map(m => m.name).join(', ');
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
  log?.(`  [glass-allowlist] ${EXTENSION_ID} in ${allowlists.length} allowlist array(s): ${report.join(', ')}`);
  return result;
}

/**
 * Dry-run the allowlist locator so `ccursor check` fails on the same conditions
 * `ccursor install` would throw on.
 * @returns {{ ok: boolean, detail: string }}
 */
export function checkGlassExtensionAllowlist(code) {
  let detail = '';
  try {
    patchGlassExtensionAllowlist(code, msg => { detail = msg.trim(); });
    return { ok: true, detail };
  } catch (e) {
    return { ok: false, detail: e.message };
  }
}

function patchSingleWorkbench(filePath, label, paths, log) {
  const code = readFileSync(filePath, 'utf-8');
  const state = inspectHook(code);

  if (state.upToDate) {
    log?.(`[inject] ${label}: already patched`);
    return;
  }
  if (!state.consistent) {
    throw new Error(`${label}: partial renderer hook detected (payload/call-site mismatch)`);
  }
  if (state.payload) {
    upgradeHookPayload(filePath, label, code, paths, log);
    return;
  }

  const target = findTarget(code, log);
  log?.(`  Target: function ${target.name}(${target.paramService}, ${target.paramTransport})`);

  const { name: fnName, paramService: ps, paramTransport: pt, innerFn } = target;
  const replacement = `function ${fnName}(${ps},${pt}){return ${innerFn}(${ps},(typeof globalThis.${HOOK_MARKER}==="function"?globalThis.${HOOK_MARKER}(${pt},${ps}.typeName):${pt}))}`;

  // 1. 替换 dispatcher 包装
  let patched = code.slice(0, target.bounds.start) + replacement + code.slice(target.bounds.end);
  // 2. AST 验证 + 字符串替换, 在所有 X.aiService.refreshDefaultModels( 调用点泄漏 aiService 引用到 globalThis
  patched = captureAiServiceRef(patched, log);
  // 3. 注入 hook payload (放最前面优先执行)
  const payload = buildHookPayload(paths.hasGlass);
  patched = `/* CURSOR-BYOK-HOOK-START */${payload}/* CURSOR-BYOK-HOOK-END */;${patched}`;
  // 4. MAX Mode toggle: 数据驱动隐藏
  patched = patchMaxModeToggle(patched, log);
  // 5. KaTeX math SVG sanitizer: 放行根号 / stretchy delimiter 所需 inline SVG
  patched = patchKatexMathSvgSanitizer(patched, log);
  // 6. Glass Window (Agent Window) 扩展白名单放行
  patched = patchGlassExtensionAllowlist(patched, log);

  if (!patched.includes(HOOK_MARKER)) throw new Error(`Verification failed for ${label}`);

  createBackup(filePath, 'inject', log);
  writeFileSync(filePath, patched);
  updateChecksums(paths, [filePath], 'inject', log);
}

/**
 * Refresh a bundle that carries an older payload, without re-running the AST
 * rewrites that are already in it.
 *
 * Prepending is enough to take over: the payload is one IIFE guarded by
 * `globalThis.__byokReady`, so the copy that runs first wins and the stale one
 * returns immediately. The call-site rewrite and the aiService capture are
 * already present and are not version dependent, and the remaining rewrites
 * (MAX Mode, KaTeX, Glass allowlist) were applied by the earlier install —
 * re-applying them to an already-patched bundle is what this path exists to
 * avoid.
 *
 * createBackup keeps the earliest backup of the `inject` tag, so uninstall
 * still restores the pristine bundle rather than the previously patched one.
 */
function upgradeHookPayload(filePath, label, code, paths, log) {
  log?.(`[inject] ${label}: payload is stale, upgrading routes channel to ${RENDERER_CHANNEL_VERSION_MARKER}`);
  const payload = buildHookPayload(paths.hasGlass);
  const patched = `/* ${HOOK_SOURCE_MARKER} */${payload}/* CURSOR-BYOK-HOOK-END */;${code}`;

  if (!isInjectPatched(patched)) throw new Error(`Payload upgrade verification failed for ${label}`);

  createBackup(filePath, 'inject', log);
  writeFileSync(filePath, patched);
  updateChecksums(paths, [filePath], 'inject', log);
}

export function patchInject(paths, log) {
  const targets = [
    { path: paths.workbenchJs, label: 'desktop' },
    { path: paths.glassJs, label: 'glass' },
  ];

  for (const { path, label } of targets) {
    if (!existsSync(path)) {
      log?.(`[inject] ${label}: not found, skipping (pre-3.8)`);
      continue;
    }
    log?.(`[inject] Patching ${label} workbench.js...`);
    patchSingleWorkbench(path, label, paths, log);
  }

  log?.('[inject] Done');
}
