import {
    arr,
    bool,
    enumLike,
    envelope,
    obj,
    resultCase,
    str,
    truncate,
    type ToolResultEnvelope,
} from './shared';

export function buildLocalInteractionToolResult(cursorToolType: string, input: Record<string, unknown>): ToolResultEnvelope | null {
    switch (cursorToolType) {
        case 'updateTodosToolCall': {
            const todos = arr<Record<string, unknown>>(input.todos);
            return {
                result: {
                    case: 'success',
                    value: {
                        todos,
                        totalCount: todos.length,
                        wasMerge: bool(input.merge),
                    },
                },
            };
        }
        case 'webSearchToolCall':
            return { result: { case: 'error', value: { error: 'web search is not implemented yet' } } };
        case 'webFetchToolCall':
            return { result: { case: 'error', value: { error: 'web fetch is not implemented yet', url: str(input.url) } } };
        case 'askQuestionToolCall':
            return { result: { case: 'error', value: { errorMessage: 'ask question response missing' } } };
        case 'createGoalToolCall':
            // Goals are declarative: the client renders them and the model is expected to
            // keep honouring the objective, so recording the call is the whole effect.
            return { result: { case: 'success', value: {} } };
        case 'updateGoalToolCall':
            return { result: { case: 'success', value: { status: enumLike(input.status, 0) } } };
        case 'setActiveBranchToolCall':
            // The branch itself travels in the activeBranchChange update emitted alongside.
            return { result: { case: 'success', value: {} } };
        default:
            return null;
    }
}

/**
 * Unpack an `interactionResponse` into the tool's own result envelope.
 *
 * Every tool declaring `interaction` in the registry lands here; a missing case is an
 * error rather than a silent success so a half-wired tool cannot report progress it
 * never made.
 */
export function buildInteractionResponseToolResult(
    cursorToolType: string,
    response: Record<string, unknown> | null,
    input: Record<string, unknown>,
): ToolResultEnvelope {
    switch (cursorToolType) {
        case 'askQuestionToolCall':
            return buildAskQuestionResultFromInteractionResponse(response);
        case 'createPlanToolCall': {
            const result = obj(obj(response).createPlanRequestResponse).result as Record<string, unknown> | undefined;
            if (result?.success !== undefined) {
                return {
                    result: { case: 'success', value: {} },
                    ...(typeof result.planUri === 'string' ? { planUri: result.planUri } : {}),
                } as ToolResultEnvelope;
            }
            return { result: { case: 'error', value: { error: 'CreatePlan failed' } } };
        }
        case 'switchModeToolCall': {
            const inner = obj(obj(response).switchModeRequestResponse);
            if (inner.approved) {
                return {
                    result: {
                        case: 'success',
                        value: { toModeId: str(input.target_mode_id ?? input.targetModeId, 'agent') },
                    },
                };
            }
            return { result: { case: 'error', value: { error: 'Mode switch rejected by user' } } };
        }
        case 'connectScmToolCall': {
            const inner = obj(obj(response).connectScmRequestResponse);
            if (inner.approved) return { result: { case: 'success', value: {} } };
            if (inner.rejected)
                return { result: { case: 'rejected', value: { reason: str(obj(inner.rejected).reason, 'rejected') } } };
            if (inner.failed)
                return { result: { case: 'error', value: { error: str(obj(inner.failed).error, 'connect github failed') } } };
            return { result: { case: 'error', value: { error: 'missing connect github response' } } };
        }
        case 'mcpAuthToolCall': {
            const inner = obj(obj(response).mcpAuthRequestResponse);
            const serverIdentifier = str(input.serverIdentifier ?? input.server ?? input.namespace);
            if (inner.approved) return { result: { case: 'success', value: { serverIdentifier } } };
            if (inner.rejected)
                return { result: { case: 'rejected', value: { reason: str(obj(inner.rejected).reason, 'rejected') } } };
            return { result: { case: 'error', value: { error: 'missing MCP authorization response' } } };
        }
        default:
            return {
                result: {
                    case: 'error',
                    value: { error: `no interaction result handler for ${cursorToolType}` },
                },
            };
    }
}

export function buildAskQuestionResultFromInteractionResponse(response: Record<string, unknown> | null): ToolResultEnvelope {
    const result = obj(obj(response).askQuestionInteractionResponse).result;
    const rc = resultCase(result);
    return rc ? { result: rc } : { result: { case: 'error', value: { errorMessage: 'missing ask question response' } } };
}

export function buildWebSearchApprovalResultFromInteractionResponse(
    response: Record<string, unknown> | null,
): { approved: boolean; result?: ToolResultEnvelope } {
    const payload = obj(obj(response).webSearchRequestResponse);
    if (payload.approved) return { approved: true };
    if (payload.rejected) return { approved: false, result: { result: { case: 'rejected', value: { reason: str(obj(payload.rejected).reason, 'rejected') } } } };
    return { approved: false, result: { result: { case: 'error', value: { error: 'missing approval response' } } } };
}

export function buildWebFetchApprovalResultFromInteractionResponse(
    response: Record<string, unknown> | null,
): { approved: boolean; result?: ToolResultEnvelope } {
    const payload = obj(obj(response).webFetchRequestResponse);
    if (payload.approved) return { approved: true };
    if (payload.rejected) return { approved: false, result: { result: { case: 'rejected', value: { reason: str(obj(payload.rejected).reason, 'rejected') } } } };
    return { approved: false, result: { result: { case: 'error', value: { error: 'missing approval response', url: '' } } } };
}

export function normalizeInteractionToolResult(
    cursorToolType: string,
    resultCaseName: string,
    value: Record<string, unknown>,
    input: Record<string, unknown>,
): ToolResultEnvelope | null {
    switch (cursorToolType) {
        case 'webSearchToolCall':
            if (resultCaseName === 'success') {
                return envelope('success', {
                    references: arr<Record<string, unknown>>(value.references).map(reference => ({
                        title: str(reference.title),
                        url: str(reference.url),
                        chunk: str(reference.chunk),
                    })),
                });
            }
            return envelope(resultCaseName || 'error', value);
        case 'webFetchToolCall':
            if (resultCaseName === 'success') {
                return envelope('success', {
                    url: str(value.url, str(input.url)),
                    markdown: str(value.markdown),
                    ...(value.outputLocation ? { outputLocation: obj(value.outputLocation) } : {}),
                });
            }
            if (resultCaseName === 'error') {
                return envelope('error', {
                    url: str(value.url, str(input.url)),
                    error: str(value.error, 'web fetch error'),
                });
            }
            return envelope(resultCaseName || 'error', value);
        case 'updateTodosToolCall':
            if (resultCaseName === 'success') {
                const todos = arr<Record<string, unknown>>(value.todos).map(todo => ({
                    ...todo,
                    id: str(todo.id),
                    content: str(todo.content),
                    status: enumLike(todo.status, 0),
                }));
                return envelope('success', {
                    todos,
                    totalCount: value.totalCount ?? todos.length,
                    wasMerge: bool(value.wasMerge),
                });
            }
            return envelope(resultCaseName || 'error', value);
        default:
            return null;
    }
}

export function buildInteractionToolResultText(
    cursorToolType: string,
    toolResult: ToolResultEnvelope,
    resultCaseName: string,
    value: Record<string, unknown>,
): string | null {
    switch (cursorToolType) {
        case 'updateTodosToolCall': {
            if (resultCaseName === 'success') {
                const todos = arr<Record<string, unknown>>(value.todos);
                return truncate(todos.map(todo => `- [${String(enumLike(todo.status, ''))}] ${str(todo.content)} (${str(todo.id)})`).join('\n') || 'Updated todos');
            }
            return `Update todos ${resultCaseName || 'error'}: ${JSON.stringify(value)}`;
        }
        case 'webSearchToolCall':
        case 'webFetchToolCall':
        case 'askQuestionToolCall':
            return truncate(JSON.stringify(toolResult, null, 2), 12000);
        case 'createGoalToolCall':
            return resultCaseName === 'success'
                ? 'Goal created'
                : `Error creating goal: ${str(value.error, resultCaseName || 'unknown error')}`;
        case 'updateGoalToolCall':
            return resultCaseName === 'success'
                ? `Goal status updated to ${String(enumLike(value.status, 'unknown'))}`
                : `Error updating goal: ${str(value.error, resultCaseName || 'unknown error')}`;
        case 'setActiveBranchToolCall':
            return resultCaseName === 'success'
                ? 'Active branch metadata updated'
                : `Failed to update active branch: ${str(value.error, resultCaseName || 'unknown error')}`;
        case 'connectScmToolCall':
            switch (resultCaseName) {
                case 'success': return 'GitHub connected';
                case 'rejected': return `Connect GitHub declined: ${str(value.reason, 'rejected')}`;
                default: return `Connect GitHub failed: ${str(value.error, resultCaseName || 'unknown error')}`;
            }
        case 'mcpAuthToolCall':
            switch (resultCaseName) {
                case 'success': return `Authenticated MCP server ${str(value.serverIdentifier, 'server')}`;
                case 'rejected': return `MCP authorization declined: ${str(value.reason, 'rejected')}`;
                default: return `MCP authorization failed: ${str(value.error, resultCaseName || 'unknown error')}`;
            }
        default:
            return null;
    }
}
