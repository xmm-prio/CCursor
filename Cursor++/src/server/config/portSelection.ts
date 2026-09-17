/**
 * Server port fallback.
 *
 * The preferred port (routes.json `server.port`) can be taken by an unrelated
 * process, in which case binding fails and every injected consumer keeps
 * talking to whatever answers on it. Walking upwards over a bounded span keeps
 * the server reachable, and because the span is shared with the renderer hook
 * and the node routers (PORT_FALLBACK_SPAN), a shifted port stays discoverable.
 *
 * A port already owned by another Cursor++ instance is reported instead of
 * skipped: joining that instance as a peer is the correct outcome, claiming
 * yet another port would give the window a server nobody routes to.
 */
export type PortStatus = 'free' | 'byok' | 'occupied'

export type PortProbe = (port: number) => Promise<PortStatus>

export interface PortSelection {
  port: number
  status: 'free' | 'byok'
  /** True when the preferred port was unusable and the span was walked. */
  shifted: boolean
}

const MAX_PORT = 65535

/**
 * @param preferred first port to try
 * @param span      how many consecutive ports may be probed, including `preferred`
 * @returns the first port that is free or owned by Cursor++, null when the
 *          whole span is occupied by foreign processes
 */
export async function selectServerPort(
  preferred: number,
  span: number,
  probe: PortProbe,
): Promise<PortSelection | null> {
  const start = Math.trunc(preferred)
  const attempts = Math.max(1, Math.trunc(span))
  for (let offset = 0; offset < attempts; offset++) {
    const port = start + offset
    if (port > MAX_PORT)
      break
    const status = await probe(port)
    if (status === 'occupied')
      continue
    return { port, status, shifted: offset > 0 }
  }
  return null
}
