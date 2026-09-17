/**
 * Turn-level keep-alive envelope.
 *
 * A Cursor client treats a stream that goes quiet for a few seconds as stalled, but an
 * agent turn is legitimately silent for long stretches: while a tool runs, while the user
 * decides whether to approve a shell command, and — least visibly — before the first LLM
 * byte, during checkpoint reads and blob warmup.
 *
 * Keeping that connection alive used to be the responsibility of every waiting site, each
 * wrapping its own await in a heartbeat-emitting generator. That left the gaps between
 * those sites uncovered and made "is this path protected?" a question about eight separate
 * files. Wrapping the whole turn instead makes the answer structural: anything that does
 * not produce a frame for `intervalMs` gets a heartbeat, no matter what it is doing or
 * where in the pipeline it sits.
 *
 * The timer is armed at most once per pending frame and disarmed the moment the race
 * settles, so a fast stream does not accumulate one timer per frame waiting to expire on
 * its own.
 */
import type { AgentServerMessage } from '../../gen/agent_v1_pb'
import { AGENT_HEARTBEAT_INTERVAL_MS } from './constants'
import { heartbeat } from './stream'

type TickOutcome = 'tick' | 'disarmed'

/**
 * Wrap a turn's frame stream so that silent windows are filled with heartbeats.
 *
 * Heartbeats are inserted between frames only — a frame produced by `frames` is never
 * delayed, reordered or dropped.
 */
export async function* withTurnKeepAlive(
  frames: AsyncIterable<AgentServerMessage>,
  intervalMs = AGENT_HEARTBEAT_INTERVAL_MS,
): AsyncIterable<AgentServerMessage> {
  const iterator = frames[Symbol.asyncIterator]()
  let timer: ReturnType<typeof setTimeout> | null = null
  let disarmTick: (() => void) | null = null

  const armTick = (): Promise<TickOutcome> =>
    new Promise<TickOutcome>((resolve) => {
      timer = setTimeout(() => resolve('tick'), intervalMs)
      // Resolving on disarm rather than leaving the promise pending keeps the losing
      // branch of the race from being retained until the timer would have fired.
      disarmTick = () => resolve('disarmed')
    })

  const disarm = (): void => {
    if (timer !== null) {
      clearTimeout(timer)
      timer = null
    }
    disarmTick?.()
    disarmTick = null
  }

  try {
    while (true) {
      const pending = iterator.next()
      let next: IteratorResult<AgentServerMessage> | undefined

      while (next === undefined) {
        const raced = await Promise.race([
          pending.then(result => ({ kind: 'frame' as const, result })),
          armTick().then(outcome => ({ kind: outcome, result: undefined })),
        ])
        disarm()
        if (raced.kind === 'frame')
          next = raced.result
        else if (raced.kind === 'tick')
          yield heartbeat()
      }

      if (next.done)
        return
      yield next.value
    }
  }
  finally {
    disarm()
    await iterator.return?.()
  }
}
