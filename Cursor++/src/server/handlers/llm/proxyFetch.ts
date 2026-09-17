/**
 * LLM SDK 的 HTTP 代理支持
 *
 * 用 undici 包自己的 fetch + ProxyAgent 配对, 返回自定义 fetch 函数,
 * 传给 Anthropic / OpenAI SDK 的 opts.fetch 参数。
 *
 * TLS: 加载 Node.js 内置根证书 + 系统证书 (macOS 钥匙串 / Windows Crypt32 / Linux CA bundle),
 * 确保抓包软件 (Charles/mitmproxy) 的自签名 CA 被信任。
 */
import { execSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import tls from 'node:tls'
import { Agent, type Dispatcher, ProxyAgent, fetch as undiciFetch } from 'undici'
import { UPSTREAM_DISPATCHER_OPTIONS, UPSTREAM_SOCKET_OPTIONS } from '../../config/upstreamTuning'
import { logger } from '../../logger'

// ── 系统证书读取 (内联自 @vscode/proxy-agent) ──

const LINUX_CA_PATHS = [
  '/etc/ssl/certs/ca-certificates.crt',
  '/etc/ssl/certs/ca-bundle.crt',
  '/etc/ssl/ca-bundle.pem',
  '/etc/pki/ca-trust/extracted/pem/tls-ca-bundle.pem',
]

function splitPemBundle(pem: string): string[] {
  return pem.split(/(?=-----BEGIN CERTIFICATE-----)/g).filter(c => c.trim().length > 0)
}

function readSystemCerts(): string[] {
  try {
    if (process.platform === 'darwin') {
      const stdout = execSync('/usr/bin/security find-certificate -a -p', { encoding: 'utf-8', timeout: 10_000 })
      return splitPemBundle(stdout)
    }
    if (process.platform === 'linux') {
      for (const p of LINUX_CA_PATHS) {
        try {
          return splitPemBundle(readFileSync(p, 'utf-8'))
        }
        catch {}
      }
    }
    // Windows: tls.rootCertificates 在 Node 20+ 已包含系统证书
  }
  catch (e) {
    logger.debug({ error: (e as Error).message }, '[PROXY] failed to read system certificates')
  }
  return []
}

let caCertsCache: string[] | null = null

function getCaCerts(): string[] {
  if (caCertsCache)
    return caCertsCache
  const nodeCerts = [...(tls.rootCertificates || [])]
  const sysCerts = readSystemCerts()
  const merged = [...new Set([...nodeCerts, ...sysCerts])]
  caCertsCache = merged
  logger.info({ node: nodeCerts.length, system: sysCerts.length, merged: merged.length }, '[PROXY] loaded CA certificates')
  return merged
}

// ── 传输层调参 (面向长连接 SSE 流) ──
//
// 所有参数集中在 config/upstreamTuning.ts —— 本文件只负责按 proxyUrl 构造并
// 缓存 dispatcher, 不再自带策略常量。

/**
 * Dispatchers are cached per proxy URL ('' = direct).
 *
 * A dispatcher owns the connection pool, so building one per call would defeat
 * keep-alive entirely and leak sockets — `createProxiedFetch` is called from
 * every provider constructor and from every remote-compact request.
 */
const dispatcherCache = new Map<string, Dispatcher>()

function createDispatcher(proxyUrl: string): Dispatcher {
  if (!proxyUrl) {
    // Direct: no `ca` override, Node's default trust store already applies.
    const agent = new Agent({ ...UPSTREAM_DISPATCHER_OPTIONS, connect: { ...UPSTREAM_SOCKET_OPTIONS } })
    logger.info({ ...UPSTREAM_DISPATCHER_OPTIONS }, '[PROXY] LLM fetch direct (no proxy)')
    return agent
  }
  const ca = getCaCerts()
  const agent = new ProxyAgent({
    ...UPSTREAM_DISPATCHER_OPTIONS,
    uri: proxyUrl,
    // proxyTls: socket to the proxy itself; requestTls: TLS to the upstream API
    // tunnelled through it. Both need the merged CA bundle so an intercepting
    // proxy with a self-signed root is trusted.
    proxyTls: { ...UPSTREAM_SOCKET_OPTIONS, ca },
    requestTls: { ...UPSTREAM_SOCKET_OPTIONS, ca },
  })
  logger.info({ proxyUrl, caCount: ca.length, ...UPSTREAM_DISPATCHER_OPTIONS }, '[PROXY] LLM fetch via proxy')
  return agent
}

function getDispatcher(proxyUrl: string | undefined): Dispatcher {
  const key = proxyUrl ?? ''
  let dispatcher = dispatcherCache.get(key)
  if (!dispatcher) {
    dispatcher = createDispatcher(key)
    dispatcherCache.set(key, dispatcher)
  }
  return dispatcher
}

/**
 * Drop every cached dispatcher, gracefully closing its connection pool.
 *
 * Call this whenever provider configuration is reloaded, so that a changed
 * proxyUrl does not leave an orphaned pool behind. `close()` lets in-flight
 * streams finish; the dispatcher is unreachable afterwards either way.
 */
export function resetLlmTransport(): void {
  for (const dispatcher of dispatcherCache.values()) {
    dispatcher.close().catch((e: unknown) => {
      logger.debug({ error: (e as Error).message }, '[PROXY] dispatcher close failed')
    })
  }
  dispatcherCache.clear()
  logger.info('[PROXY] LLM transport dispatchers reset')
}

// ── Proxy Fetch ──

/**
 * 返回独立于 VS Code proxy 设置的 fetch 函数供 LLM SDK 使用。
 *
 * 始终使用 undici 自己的 fetch + Agent/ProxyAgent，绕过 VS Code 的
 * @vscode/proxy-agent monkey-patch (劫持 http.request)。
 * BYOK LLM 请求仅遵循 Provider 自己的 proxyUrl 配置。
 *
 * - proxyUrl 非空: undici fetch + ProxyAgent (走指定代理)
 * - proxyUrl 为空: undici fetch + Agent (直连, 不走任何代理)
 *
 * Both paths run on a cached dispatcher tuned by STREAM_DISPATCHER_OPTIONS;
 * neither inherits undici's global defaults.
 */
export function createProxiedFetch(proxyUrl: string | undefined): typeof globalThis.fetch {
  const dispatcher = getDispatcher(proxyUrl)
  return ((input: any, init?: any) =>
    undiciFetch(input, { ...init, dispatcher })) as unknown as typeof globalThis.fetch
}
