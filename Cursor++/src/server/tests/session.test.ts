import { expect, it } from 'vitest'
import { createEphemeralSession, pushSessionMessage, waitForInteractionResponse } from '../handlers/agent/session'
import {
  AgentRunAbortedError,
  waitForExecClientMessage,
  waitForExecStreamClose,
} from '../handlers/agent/wait'

it('waitForInteractionResponse resolves when interaction response is pushed into session', async () => {
  const session = createEphemeralSession('bidi-test')
  const pending = waitForInteractionResponse(session, 3, 'askQuestionInteractionResponse', 1000)
  pushSessionMessage(session, {
    interactionResponse: {
      id: 3,
      askQuestionInteractionResponse: {
        result: {
          success: {
            answers: [
              {
                questionId: 'tool_test_q1',
                selectedOptionIds: ['opt1'],
              },
            ],
          },
        },
      },
    },
  })

  const response = await pending
  expect(response).toBeTruthy()
  const interaction = response?.interactionResponse as Record<string, unknown>
  expect(interaction.id).toBe(3)
  expect('askQuestionInteractionResponse' in interaction).toBeTruthy()
})

it('waitForInteractionResponse without timeout resolves after delayed response', async () => {
  const session = createEphemeralSession('bidi-test-no-timeout')
  const pending = waitForInteractionResponse(session, 7, 'askQuestionInteractionResponse', null)

  setTimeout(() => {
    pushSessionMessage(session, {
      interactionResponse: {
        id: 7,
        askQuestionInteractionResponse: {
          result: {
            success: {
              answers: [
                {
                  questionId: 'tool_test_q2',
                  selectedOptionIds: ['opt2'],
                },
              ],
            },
          },
        },
      },
    })
  }, 25)

  const response = await pending
  expect(response).toBeTruthy()
  const interaction = response?.interactionResponse as Record<string, unknown>
  expect(interaction.id).toBe(7)
  expect('askQuestionInteractionResponse' in interaction).toBeTruthy()
})

it('waitForExecClientMessage returns matching exec client message', async () => {
  const session = createEphemeralSession('exec-wait')
  setTimeout(() => {
    pushSessionMessage(session, {
      execClientMessage: {
        id: 12,
        readResult: {
          success: {
            path: 'a.txt',
            content: 'hello',
          },
        },
      },
    })
  }, 10)

  const result = await waitForExecClientMessage(session, 12, null)

  expect(result).toBeTruthy()
  expect(!!(result as Record<string, unknown>).execClientMessage).toBe(true)
})

it('waitForExecStreamClose returns matching stream close control message', async () => {
  const session = createEphemeralSession('exec-close-wait')
  setTimeout(() => {
    pushSessionMessage(session, {
      execClientControlMessage: {
        streamClose: {
          id: 13,
        },
      },
    })
  }, 10)

  const result = await waitForExecStreamClose(session, 13, null)

  expect(result).toBeTruthy()
  expect((((result as Record<string, unknown>).execClientControlMessage as Record<string, unknown>).streamClose as Record<string, unknown>).id).toBe(13)
})

it('waitForExecClientMessage throws AgentRunAbortedError on execClientControlMessage.throw', async () => {
  const session = createEphemeralSession('exec-throw-wait')
  setTimeout(() => {
    pushSessionMessage(session, {
      execClientControlMessage: {
        throw: {
          id: 14,
          error: 'signal is aborted without reason',
          stackTrace: 'AbortError: signal is aborted without reason',
        },
      },
    })
  }, 10)

  try {
    await waitForExecClientMessage(session, 14, null)
    expect.unreachable('should have thrown')
  }
  catch (error) {
    expect(error).toBeInstanceOf(AgentRunAbortedError)
    expect((error as AgentRunAbortedError).execMessageId).toBe(14)
    expect((error as Error).message).toMatch(/signal is aborted without reason/)
  }
})
