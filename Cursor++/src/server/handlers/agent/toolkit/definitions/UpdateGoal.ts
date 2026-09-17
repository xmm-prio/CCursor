import { str } from '../shared';
import type { ToolRegistryEntry } from '../types';

/** Verbatim from the 3.19.19 cursor-agent-host tool table (`En("UPDATE_GOAL", ...)`). */
const DESCRIPTION = `Update the existing goal's status. Set status to \`complete\` only when the objective has actually been achieved and no required work remains. You cannot use this tool to pause a goal; that is controlled by the user. However, if the user paused and asks you to resume, you can set it to \`active\`.`;

const STATUS_DESCRIPTION = `New goal status. Allowed values: 'active', 'complete'.`;

const ANTHROPIC = {
    name: 'UpdateGoal',
    description: DESCRIPTION,
    inputSchema: {
        type: 'object',
        required: ['status'],
        properties: {
            status: {
                type: 'string',
                enum: ['active', 'complete'],
                description: STATUS_DESCRIPTION,
            },
        },
    },
};

const OPENAI = { ...ANTHROPIC };

const GEMINI = {
    name: 'UpdateGoal',
    description: DESCRIPTION,
    inputSchema: {
        type: 'OBJECT',
        properties: {
            status: {
                type: 'STRING',
                enum: ['active', 'complete'],
                description: STATUS_DESCRIPTION,
            },
        },
        required: ['status'],
    },
};

/** agent.v1.GoalStatus — only ACTIVE and COMPLETE are model-settable. */
const GOAL_STATUS: Record<string, number> = {
    active: 1,
    complete: 3,
};

export const UpdateGoalTool: ToolRegistryEntry = {
    canonicalName: 'UpdateGoal',
    aliases: ['UpdateGoal', 'update_goal'],
    cursorToolType: 'updateGoalToolCall',
    execArgsType: null,
    llmToolByProvider: {
        anthropic: ANTHROPIC,
        openai: OPENAI,
        gemini: GEMINI,
    },
    buildStartedArgs: (input) => {
        const requested = str(input.status).toLowerCase();
        const status = GOAL_STATUS[requested];
        if (status === undefined)
            throw new Error(`UpdateGoal.status must be 'active' or 'complete', received ${JSON.stringify(input.status)}`);
        return { status };
    },
};
