import type { Server } from 'node:http'
/**
 * Event channel over WebSocket — against a real HTTP server and a real client.
 *
 * The unit tests around pushChannel cover framing with fake sockets; what can
 * only be shown end to end is that the upgrade is actually accepted on the
 * shared server, that a client is subscribed the moment it connects, and that
 * teardown really lets the port go — the property a peer window depends on
 * when it takes the server over.
 */
import type { AddressInfo } from 'node:net'
import type { EventSocketServer } from '../eventSocket'
import { createServer } from 'node:http'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { WebSocket } from 'ws'
import { buildRoutesPayload } from '../config/routesPayload'
import { SSE_EVENT_ROUTES } from '../data/defaults'
import { BYOK_WS_PATH, serveEventSocket } from '../eventSocket'
import { emitEvent, emitShutdown, pushChannelDiagnostics, resetPushChannelForTests } from '../pushChannel'

const payload = buildRoutesPayload({
  $schemaVersion: 1,
  byokMode: 1,
  server: { host: '127.0.0.1', port: 39831 },
  collector: { host: '127.0.0.1', port: 14800 },
  redirect: ['REST:/auth/poll', 'aiserver.v1.AuthService'],
})

let http: Server
let socketServer: EventSocketServer
let baseUrl: string
const clients: WebSocket[] = []

interface Client {
  ws: WebSocket
  /** Next message, from a queue that starts filling before the socket opens. */
  next: () => Promise<any>
}

/**
 * The server writes the routes frame from inside the upgrade callback, so it
 * can reach the client in the same read as the handshake response — before an
 * `await open` continuation gets a chance to run. Collecting from construction
 * is what makes the assertions deterministic rather than racy.
 */
async function connect(path = BYOK_WS_PATH): Promise<Client> {
  const ws = new WebSocket(`${baseUrl}${path}`)
  clients.push(ws)

  const queue: any[] = []
  const waiters: Array<(message: any) => void> = []
  ws.on('message', (data) => {
    const message = JSON.parse(String(data))
    const waiter = waiters.shift()
    if (waiter)
      waiter(message)
    else
      queue.push(message)
  })

  await new Promise<void>((resolve, reject) => {
    ws.once('open', () => resolve())
    ws.once('error', reject)
  })

  return {
    ws,
    next: () => queue.length > 0
      ? Promise.resolve(queue.shift())
      : new Promise(resolve => waiters.push(resolve)),
  }
}

beforeEach(async () => {
  resetPushChannelForTests()
  http = createServer((_req, res) => res.end('ok'))
  socketServer = serveEventSocket(http, () => payload)
  await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve))
  baseUrl = `ws://127.0.0.1:${(http.address() as AddressInfo).port}`
})

afterEach(async () => {
  for (const ws of clients.splice(0)) ws.terminate()
  socketServer.close()
  await new Promise<void>(resolve => http.close(() => resolve()))
})

describe('subscription', () => {
  it('hands the current routes to a client the moment it connects', async () => {
    const client = await connect()
    const message = await client.next()

    expect(message.event).toBe(SSE_EVENT_ROUTES)
    expect(message.data).toEqual(payload)
    expect(pushChannelDiagnostics().events.byTransport.ws).toBe(1)
  })

  it('delivers later broadcasts on the same connection', async () => {
    const client = await connect()
    await client.next() // initial routes

    expect(emitEvent({ kind: 'refresh' })).toBe(1)
    expect(await client.next()).toEqual({ event: 'refresh', data: {} })
  })

  it('serves several windows independently', async () => {
    const a = await connect()
    const b = await connect()
    await Promise.all([a.next(), b.next()])

    emitEvent({ kind: 'refresh' })

    expect(await Promise.all([a.next(), b.next()]))
      .toEqual([{ event: 'refresh', data: {} }, { event: 'refresh', data: {} }])
  })

  it('unsubscribes a client that disconnects', async () => {
    const client = await connect()
    await client.next()
    expect(pushChannelDiagnostics().events.subscribers).toBe(1)

    await new Promise<void>((resolve) => {
      client.ws.once('close', () => resolve())
      client.ws.close()
    })
    // The close event reaches the server on a later tick than the client's.
    await new Promise(resolve => setTimeout(resolve, 50))

    expect(pushChannelDiagnostics().events.subscribers).toBe(0)
  })
})

describe('upgrade handling', () => {
  it('refuses an upgrade on any other path instead of leaking the socket', async () => {
    await expect(connect('/not-the-channel')).rejects.toThrow()
    expect(pushChannelDiagnostics().events.subscribers).toBe(0)
  })

  it('leaves ordinary HTTP requests alone', async () => {
    const port = (http.address() as AddressInfo).port
    const response = await fetch(`http://127.0.0.1:${port}/health`)
    expect(await response.text()).toBe('ok')
  })
})

describe('shutdown', () => {
  it('announces the shutdown before hanging up', async () => {
    const client = await connect()
    await client.next()

    emitShutdown()
    expect(await client.next()).toEqual({ event: 'shutdown', data: {} })
  })

  it('releases the port even while a client is still connected', async () => {
    const client = await connect()
    await client.next()
    const port = (http.address() as AddressInfo).port

    socketServer.close()
    await new Promise<void>(resolve => http.close(() => resolve()))

    // Binding again is the only proof that nothing is holding the listener.
    const rebound = createServer()
    await expect(new Promise<void>((resolve, reject) => {
      rebound.once('error', reject)
      rebound.listen(port, '127.0.0.1', resolve)
    })).resolves.toBeUndefined()
    await new Promise<void>(resolve => rebound.close(() => resolve()))

    // afterEach closes an already-closed server; make that a no-op.
    http = createServer()
    socketServer = { close: () => {} }
  })
})
