import { str } from '../shared';
import type { ToolRegistryEntry } from '../types';

/**
 * MCP server authorization.
 *
 * `McpAuth` has no LLM-facing definition of its own: the official server injects a
 * synthetic `mcp_auth` tool into every MCP namespace (see MCP_AUTH_TOOL in
 * dynamicTools.ts), and the model reaches it through
 * `CallDynamicTool({ namespace: <server>, toolName: 'mcp_auth' })`. Routing therefore
 * happens in tools.ts; this entry only supplies the protocol identity (tool type,
 * started args and the interaction channel) once that route has been taken.
 *
 * `llmToolByProvider` is intentionally empty so the tool never enters the builtin
 * catalog as a standalone name.
 */
export const McpAuthTool: ToolRegistryEntry = {
    canonicalName: 'McpAuth',
    aliases: ['McpAuth', 'mcp_auth'],
    cursorToolType: 'mcpAuthToolCall',
    execArgsType: null,
    llmToolByProvider: {},
    buildStartedArgs: (input, callId) => ({
        serverIdentifier: str(input.serverIdentifier ?? input.server ?? input.namespace),
        toolCallId: callId,
    }),
    interaction: {
        queryCase: 'mcpAuthRequestQuery',
        responseCase: 'mcpAuthRequestResponse',
        buildQueryValue: startedArgs => ({ args: startedArgs }),
    },
};
