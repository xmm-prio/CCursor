import { num, str } from '../shared';
import type { ToolRegistryEntry } from '../types';

/** Verbatim from the 3.19.19 cursor-agent-host tool table (`En("SEARCH_CONVERSATIONS", ...)`). */
const DESCRIPTION = `Search a fast local index of the user's local conversations and cached cloud agent conversations. Every unquoted keyword must match the same conversation, so queries with many keywords often return no results; run several searches with 1–2 keywords each instead. Use quotes only for a short exact phrase. Returns conversation IDs, titles, and short snippets—not full transcripts. Some cloud agent conversations may not be searchable.`;

const QUERY_DESCRIPTION = `One or two keywords, or a short exact phrase in quotes, to search for in conversation titles and visible user/assistant message text. Every unquoted keyword must match the same conversation; use separate searches for additional keywords.`;

const LIMIT_DESCRIPTION = `Maximum number of conversation results to return (1-100). Defaults to 20.`;

const ANTHROPIC = {
    name: 'SearchConversations',
    description: DESCRIPTION,
    inputSchema: {
        type: 'object',
        required: ['query'],
        properties: {
            query: {
                type: 'string',
                description: QUERY_DESCRIPTION,
            },
            limit: {
                type: 'integer',
                minimum: 1,
                maximum: 100,
                description: LIMIT_DESCRIPTION,
            },
        },
    },
};

const OPENAI = { ...ANTHROPIC };

const GEMINI = {
    name: 'SearchConversations',
    description: DESCRIPTION,
    inputSchema: {
        type: 'OBJECT',
        properties: {
            query: {
                type: 'STRING',
                description: QUERY_DESCRIPTION,
            },
            limit: {
                type: 'INTEGER',
                description: LIMIT_DESCRIPTION,
            },
        },
        required: ['query'],
    },
};

/** ConversationSearchArgs.limit is optional; only forward a value inside the 1-100 window. */
function clampLimit(value: unknown): number | undefined {
    const limit = num(value, 0);
    if (limit <= 0) return undefined;
    return Math.min(100, Math.trunc(limit));
}

export const SearchConversationsTool: ToolRegistryEntry = {
    canonicalName: 'SearchConversations',
    aliases: ['SearchConversations', 'search_conversations'],
    cursorToolType: 'searchConversationsToolCall',
    execArgsType: 'conversationSearchArgs',
    llmToolByProvider: {
        anthropic: ANTHROPIC,
        openai: OPENAI,
        gemini: GEMINI,
    },
    buildStartedArgs: (input, callId) => {
        const limit = clampLimit(input.limit);
        return {
            query: str(input.query),
            toolCallId: callId,
            ...(limit !== undefined ? { limit } : {}),
        };
    },
    buildExecArgs: (input, callId) => {
        const limit = clampLimit(input.limit);
        return {
            query: str(input.query),
            toolCallId: callId,
            ...(limit !== undefined ? { limit } : {}),
        };
    },
};
