/**
 * Routes channel — client side.
 *
 * The BYOK server projects routes.json into one payload (endpoint + REST and
 * ConnectRPC whitelists) and broadcasts it on `/byok/events` as `routes-v2`.
 * Two very different consumers have to join that channel:
 *
 *   - the renderer hook, living in the workbench bundle (fetch / EventSource)
 *   - the node HTTP/1.1 routers, living in every extension host (require http)
 *
 * They cannot share a runtime, so this module owns the one thing they *can*
 * share: the protocol. Endpoint candidates, the whitelist projection, the
 * event names and the reconnect discipline are emitted from here, so the two
 * payloads can never drift apart in what they expect on the wire.
 *
 * Emitted source is deliberately ES5-ish and dependency free — it is prepended
 * to minified production bundles and must survive js-confuser on our side.
 */
import { DEFAULT_HOST, DEFAULT_PORT, PORT_FALLBACK_SPAN, SSE_EVENT_ROUTES } from './defaults.js';

/** How long a gated request may be suspended before it is let through anyway. */
export const READY_GATE_TIMEOUT_MS = 10000;

/**
 * Version stamp of the renderer channel payload.
 *
 * V2 replaced the SSE-only subscription with a WebSocket-first one. That is not
 * a cosmetic change: a renderer gets six HTTP/1.1 sockets per origin *for the
 * whole application*, and an SSE subscription holds one of them for as long as
 * the window lives. With several workspaces open, the permanent streams eat the
 * budget and every other request to the BYOK port queues behind connections
 * that never end. WebSocket connections come from a separate, far larger pool.
 *
 * The stamp exists so an installation carrying the V1 payload is recognised as
 * stale and upgraded in place, instead of being reported as already patched —
 * the same discipline HTTP11_ROUTER_VERSION_MARKER applies to the node routers.
 */
export const RENDERER_CHANNEL_VERSION_MARKER = '__byokRendererChannelV2';

/** WebSocket path of the event channel, served next to /byok/events. */
export const CHANNEL_WS_PATH = '/byok/ws';

/**
 * Ordered list of base URLs a consumer should try when looking for the server.
 *
 * `externalUrl` (Remote SSH / WSL forwarded address) wins when routes.json
 * carried one at install time. The rest of the list walks the same port span
 * the extension walks when its preferred port is occupied, which is what makes
 * a shifted server discoverable without re-running the installer.
 */
export function buildEndpointCandidates({ host, port, externalUrl }) {
  const base = String(host || DEFAULT_HOST);
  const bracketed = base.includes(':') && !base.startsWith('[') ? `[${base}]` : base;
  const start = Number(port) || DEFAULT_PORT;
  const candidates = [];
  if (typeof externalUrl === 'string' && externalUrl) candidates.push(externalUrl.replace(/\/+$/, ''));
  for (let offset = 0; offset < PORT_FALLBACK_SPAN; offset++) {
    candidates.push(`http://${bracketed}:${start + offset}`);
  }
  return [...new Set(candidates)];
}

/** Split a redirect array the same way the server's splitRedirect() does. */
export function splitRedirect(redirect) {
  const rest = [];
  const services = [];
  const methods = [];
  for (const rule of redirect || []) {
    if (typeof rule !== 'string' || !rule) continue;
    if (rule.startsWith('REST:')) rest.push(rule.slice(5));
    else if (rule.includes('/')) methods.push(rule);
    else services.push(rule);
  }
  return { rest, services, methods };
}

/**
 * Renderer-side channel: endpoint discovery, readiness gate and live routes.
 *
 * The startup flicker this gate exists for is not a slow refresh — it is a
 * BYOK request that reached the official API before the local server was up
 * and came back with the built-in model list. So requests on the BYOK
 * whitelist are suspended until the first payload arrives, and only those:
 * login and the always-on BASE stubs are never held. The suspension has a hard
 * ceiling (READY_GATE_TIMEOUT_MS); on expiry the request is released rather
 * than left hanging, since a stuck UI is worse than one flicker.
 *
 * ## Why the subscription prefers WebSocket
 *
 * The channel is one connection held open for the lifetime of the window, and
 * a renderer only gets six HTTP/1.1 sockets per origin — a budget Chromium
 * shares across every Cursor window, not one per window. An SSE subscription
 * therefore spends one of six globally, permanently, per workspace, and once
 * they are gone every ordinary request to the BYOK port waits for a stream
 * that by design never ends. WebSocket connections are pooled separately and
 * far more generously, so the long-lived channel stops competing with the
 * short-lived traffic.
 *
 * SSE remains the fallback rather than a legacy path: a Content-Security-Policy
 * that forbids `ws:` would otherwise take the channel down entirely, and a
 * single flicker of the model list is much cheaper than no channel at all. The
 * fallback is sticky for the session — a CSP does not change at runtime, so
 * re-probing WebSocket on every reconnect would only add latency.
 *
 * Expected globals in the host payload: `_origFetch`, `__byokGlassStatus`,
 * `__byokRefreshModels`. Exposed to the host payload: `_byokUrl`, `_restPaths`,
 * `_restSet`, `_byokGated(svc, method)`, `_byokGatedPath(url)`,
 * `__byokAwaitReady()`.
 */
export function buildRendererChannelSource({ candidates, byokRedirect }) {
  const { rest, services, methods } = splitRedirect(byokRedirect);
  const routesEvent = JSON.stringify(SSE_EVENT_ROUTES);
  return `/* ${RENDERER_CHANNEL_VERSION_MARKER} */`
    + `var _byokCandidates=${JSON.stringify(candidates)};var _byokUrl=_byokCandidates[0];`
    + `var _gateRest=${JSON.stringify(rest)},_gateSvc=new Set(${JSON.stringify(services)}),_gateMtd=new Set(${JSON.stringify(methods)});`
    + `var _byokReadyGate=false,_byokWaiters=[],_byokLink=null,_byokLinkUrl="",_byokRetry=1000,_byokProbing=false,_byokTimer=null,_byokNoWs=false;`
    + `function _byokRelease(reason){if(_byokReadyGate)return;_byokReadyGate=true;globalThis.__byokRoutesReady=true;`
    + `var waiters=_byokWaiters;_byokWaiters=[];for(var i=0;i<waiters.length;i++){try{waiters[i]()}catch(e){}}`
    + `console.log("[BYOK] readiness gate released ("+reason+")")}`
    + `setTimeout(function(){_byokRelease("timeout after ${READY_GATE_TIMEOUT_MS}ms, requests fall through to the official API")},${READY_GATE_TIMEOUT_MS});`
    + `function __byokAwaitReady(){if(_byokReadyGate)return Promise.resolve();return new Promise(function(res){_byokWaiters.push(res)})}`
    + `globalThis.__byokAwaitReady=__byokAwaitReady;`
    + `function _byokGated(svc,mtd){if(_byokReadyGate)return false;return _gateSvc.has(svc)||_gateMtd.has(svc+"/"+mtd)}`
    + `function _byokGatedPath(u){if(_byokReadyGate)return false;for(var i=0;i<_gateRest.length;i++){if(String(u).indexOf(_gateRest[i])!==-1)return true}return false}`
    + `function _byokApplyRoutes(p){if(!p||typeof p!=="object")return;`
    + `_restPaths=Array.isArray(p.rest)?p.rest:[];_restSet=new Set(_restPaths);`
    + `var srv=p.server||{},target=srv.externalUrl||srv.url||_byokUrl;`
    + `console.log("[BYOK] routes applied: endpoint="+target+", REST="+_restPaths.length+", ConnectRPC="+((p.services||[]).length+(p.methods||[]).length)+", BYOK="+(p.byokMode?"ON":"OFF"));`
    + `globalThis.__byokGlassStatus&&globalThis.__byokGlassStatus(true,!!p.byokMode);`
    + `_byokRelease("routes received");`
    // Endpoint moves (port fallback, Remote SSH forwarding) are only adopted
    // once the new address answers /health — otherwise an unreachable
    // externalUrl would bounce us off a working connection on every payload.
    + `_byokUrl=_byokLinkUrl||target;`
    + `if(target&&target!==_byokLinkUrl){_byokProbe(target).then(function(ok){if(!ok||target===_byokLinkUrl)return;`
    + `console.log("[BYOK] endpoint moved to "+target);_byokUrl=target;_byokConnect(target)})}}`
    + `function _byokProbe(base){return new Promise(function(resolve){var done=false;var timer=setTimeout(function(){if(!done){done=true;resolve(false)}},1500);`
    + `_origFetch(base+"/health",{cache:"no-store"}).then(function(r){return r.ok?r.json():null}).then(function(d){if(done)return;done=true;clearTimeout(timer);resolve(!!(d&&d.ok===true&&d.mode==="byok"))})`
    + `.catch(function(){if(done)return;done=true;clearTimeout(timer);resolve(false)})})}`
    // One link at a time, whatever its transport. Everything that can end a
    // link funnels through _byokLinkLost so the retry discipline has a single
    // home and a superseded link can never schedule a reconnect of its own.
    + `function _byokDropLink(){if(!_byokLink)return;var link=_byokLink;_byokLink=null;_byokLinkUrl="";try{link.close()}catch(e){}}`
    + `function _byokLinkLost(link,reason){if(_byokLink!==link)return;_byokLink=null;_byokLinkUrl="";try{link.close()}catch(e){}`
    + `globalThis.__byokGlassStatus&&globalThis.__byokGlassStatus(false,void 0);`
    // A shutdown means the owner window is handing the server over: the next
    // owner may come up on another port, so retry from the full candidate list
    // immediately rather than continuing an exponential backoff.
    + `if(reason==="shutdown"){_byokRetry=1000;console.log("[BYOK] server shutting down, re-discovering endpoint")}`
    + `_byokSchedule()}`
    + `function _byokRefresh(){console.log("[BYOK] refresh event received");globalThis.__byokRefreshModels&&globalThis.__byokRefreshModels()}`
    + `function _byokWsUrl(base){return String(base).replace(/^http/,"ws")+${JSON.stringify(CHANNEL_WS_PATH)}}`
    + `function _byokConnectWs(base){var ws;`
    + `try{ws=new WebSocket(_byokWsUrl(base))}`
    + `catch(e){_byokNoWs=true;console.log("[BYOK] WebSocket channel unavailable ("+(e&&e.message||e)+"), using SSE");_byokConnectSse(base);return}`
    + `var opened=false;var link={close:function(){try{ws.close()}catch(e){}}};`
    + `_byokLink=link;_byokLinkUrl=base;_byokUrl=base;`
    + `ws.addEventListener("open",function(){opened=true;_byokRetry=1000;globalThis.__byokGlassStatus&&globalThis.__byokGlassStatus(true,void 0)});`
    + `ws.addEventListener("message",function(ev){var m;try{m=JSON.parse(ev.data)}catch(e){console.warn("[BYOK] ws payload parse failed:",e&&e.message||e);return}`
    + `if(!m||!m.event)return;`
    + `if(m.event==="shutdown"){_byokLinkLost(link,"shutdown");return}`
    + `if(m.event==="refresh"){_byokRefresh();return}`
    + `if(m.event===${routesEvent}){_byokApplyRoutes(m.data)}});`
    // A refused upgrade (CSP, a proxy that drops it, a server predating the
    // endpoint) closes without ever opening — that is the signal to fall back.
    + `ws.addEventListener("close",function(){if(_byokLink!==link)return;`
    + `if(!opened){_byokNoWs=true;_byokLink=null;_byokLinkUrl="";console.log("[BYOK] WebSocket channel refused, falling back to SSE");_byokConnectSse(base);return}`
    + `_byokLinkLost(link,"closed")});}`
    + `function _byokConnectSse(base){`
    + `try{var es=new EventSource(base+"/byok/events");var link={close:function(){try{es.close()}catch(e){}}};`
    + `_byokLink=link;_byokLinkUrl=base;_byokUrl=base;`
    + `es.addEventListener("open",function(){_byokRetry=1000;globalThis.__byokGlassStatus&&globalThis.__byokGlassStatus(true,void 0)});`
    + `es.addEventListener("refresh",function(){_byokRefresh()});`
    + `es.addEventListener("shutdown",function(){_byokLinkLost(link,"shutdown")});`
    + `es.addEventListener(${routesEvent},function(ev){try{_byokApplyRoutes(JSON.parse(ev.data))}catch(e){console.warn("[BYOK] routes payload parse failed:",e&&e.message||e)}});`
    + `es.addEventListener("error",function(){_byokLinkLost(link,"error")})}`
    + `catch(e){console.warn("[BYOK] EventSource init failed:",e&&e.message||e);_byokSchedule()}}`
    + `function _byokConnect(base){_byokDropLink();`
    + `if(_byokNoWs||typeof WebSocket==="undefined"){_byokConnectSse(base)}else{_byokConnectWs(base)}}`
    + `function _byokSchedule(){if(_byokLink||_byokProbing||_byokTimer)return;var delay=_byokRetry;_byokRetry=Math.min(_byokRetry*2,10000);`
    + `_byokTimer=setTimeout(function(){_byokTimer=null;_byokDiscover()},delay)}`
    + `function _byokDiscover(){if(_byokProbing||_byokLink)return;_byokProbing=true;var i=0;`
    + `(function next(){if(i>=_byokCandidates.length){_byokProbing=false;_byokSchedule();return}`
    + `var base=_byokCandidates[i++];_byokProbe(base).then(function(ok){if(ok){_byokProbing=false;_byokConnect(base)}else{next()}})})()}`
    + `_byokDiscover();`;
}

/**
 * Node-side channel: subscribe to the same payload from an extension host.
 *
 * This runs next to the routes.json watcher, it does not replace it. The
 * watcher stays as the fallback for the window where the server is down, the
 * SSE stream is what removes the up-to-2s staleness while it is up.
 *
 * Expected in the host payload: `state` (with `base`), `applyState(event)`,
 * `_directHttpRequest` / `_directHttpOwner`, `PROCESS_LABEL`, and an
 * `applyPayload(payload)` function that adopts a parsed routes payload.
 */
export function buildNodeChannelSource() {
  return `var _chEs=null,_chPending=false,_chTimer=null,_chRetry=1000;`
    // One connection at a time: an in-flight request, a live stream and a
    // pending retry timer each veto a new attempt, so error storms (server
    // restart, endpoint move) cannot pile up duplicate subscriptions.
    + `function _chSchedule(){if(_chEs||_chPending||_chTimer)return;var d=_chRetry;_chRetry=Math.min(_chRetry*2,10000);`
    + `_chTimer=setTimeout(function(){_chTimer=null;_chConnect()},d)}`
    + `function _chReset(){_chEs=null;_chPending=false;_chSchedule()}`
    + `function _chHandle(block){var lines=block.split("\\n"),ev="",data="";`
    + `for(var i=0;i<lines.length;i++){var line=lines[i];if(line.indexOf("event: ")===0)ev=line.slice(7).trim();else if(line.indexOf("data: ")===0)data+=line.slice(6)}`
    + `if(ev!==${JSON.stringify(SSE_EVENT_ROUTES)}||!data)return;try{applyPayload(JSON.parse(data))}catch(e){console.warn("[BYOK] "+PROCESS_LABEL+" routes payload parse failed: "+e.message)}}`
    + `function _chConnect(){if(_chEs||_chPending)return;_chPending=true;var req;`
    + `try{req=_directHttpRequest.call(_directHttpOwner,state.base+"/byok/events",{headers:{Accept:"text/event-stream","x-byok-route-source":PROCESS_LABEL},agent:false},function(res){`
    + `_chPending=false;if(res.statusCode!==200){res.resume();_chSchedule();return}`
    + `_chEs=req;_chRetry=1000;res.setEncoding("utf-8");var buf="";`
    + `res.on("data",function(chunk){buf+=chunk;var parts=buf.split("\\n\\n");buf=parts.pop();for(var i=0;i<parts.length;i++)_chHandle(parts[i])});`
    + `res.on("end",_chReset);res.on("error",_chReset)})}`
    + `catch(e){_chPending=false;_chSchedule();return}`
    + `req.on("error",_chReset);req.end()}`
    + `_chConnect();`;
}
