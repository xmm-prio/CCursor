import { str } from '../shared';
import type { ToolRegistryEntry } from '../types';

/** Verbatim from the 3.19.19 cursor-agent-host tool table (`En("CREATE_GOAL", ...)`). */
const DESCRIPTION = `Create a long-running goal. Only use this tool when explicitly requested by the user; NEVER use this tool for ordinary tasks.`;

const ANTHROPIC = {
    name: 'CreateGoal',
    description: DESCRIPTION,
    inputSchema: {
        type: 'object',
        required: ['objective'],
        properties: {
            objective: {
                type: 'string',
                description: 'The objective the goal tracks until it is completed or cleared.',
            },
        },
    },
};

const OPENAI = { ...ANTHROPIC };

const GEMINI = {
    name: 'CreateGoal',
    description: DESCRIPTION,
    inputSchema: {
        type: 'OBJECT',
        properties: {
            objective: {
                type: 'STRING',
                description: 'The objective the goal tracks until it is completed or cleared.',
            },
        },
        required: ['objective'],
    },
};

export const CreateGoalTool: ToolRegistryEntry = {
    canonicalName: 'CreateGoal',
    aliases: ['CreateGoal', 'create_goal'],
    cursorToolType: 'createGoalToolCall',
    execArgsType: null,
    llmToolByProvider: {
        anthropic: ANTHROPIC,
        openai: OPENAI,
        gemini: GEMINI,
    },
    buildStartedArgs: input => ({ objective: str(input.objective) }),
};
