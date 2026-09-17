/**
 * WebSocket transport of the event channel.
 *
 * Same subscribers, same payloads and same lifetime as `/byok/events`; the only
 * thing that differs is which socket pool the connection is drawn from, and
 * that is the whole point.
 *
 * A renderer gets six HTTP/1.1 sockets per origin, and Chromium shares that
 * budget across every Cursor window rather than handing each one its own. An
 * SSE subscription is a request that never completes, so every open workspace
 * permanently spends one of the six on a stream that carries a few bytes an
 * hour. Past a handful of windows the budget is gone and ordinary requests to
 * the BYOK port — model lists, auth polls, chat summaries — queue behind those
 * streams, which is exactly the "one window's agent blocks the others" symptom.
 * WebSocket connections are pooled separately and far more generously.
 *
 * `noServer` mode rather than @fastify/websocket: the only thing needed from
 * the framework is the raw HTTP server, and taking the upgrade directly keeps
 * both the dependency list and the request pipeline unchanged.
 */
import type { Server } from 'node:http'
import type { RoutesPayload } from './config/routesPayload'
import { WebSocketServer } from 'ws'
import { logger } from './logger'
import { addEventSink, createWebSocketSink } from './pushChannel'

/** WebSocket path of the event channel, mirrored by the installer's renderer hook. */
export const BYOK_WS_PATH = '/byok/ws'

export interface EventSocketServer {
  /** Hang up on every client and stop accepting upgrades. */
  close: () => void
}

/**
 * Serve the event channel over WebSocket on `server`.
 *
 * `currentRoutes` is read at connect time, so a client that arrives after a
 * port fallback or an external-URL publication is handed the address in effect
 * right now — the same frame `/byok/events` opens with, and the one that
 * releases the renderer's startup readiness gate.
 */
export function serveEventSocket(server: Server, currentRoutes: () => RoutesPayload): EventSocketServer {
  const wss = new WebSocketServer({ noServer: true })

  server.on('upgrade', (req, socket, head) => {
    const path = (req.url ?? '').split('?')[0]
    if (path !== BYOK_WS_PATH) {
      // This server has exactly one upgrade entry point. Leaving an unknown
      // handshake unanswered would leak the socket, since Node only closes it
      // automatically while no 'upgrade' listener is registered at all.
      socket.destroy()
      return
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      const sink = createWebSocketSink(ws)
      const unsubscribe = addEventSink(sink)
      sink.write({ kind: 'routes', payload: currentRoutes() })
      ws.on('close', unsubscribe)
      ws.on('error', unsubscribe)
    })
    logger.debug('[SRV] event channel upgraded to WebSocket')
  })

  return {
    close() {
      for (const client of wss.clients) client.terminate()
      wss.close()
    },
  }
}
