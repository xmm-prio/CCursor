import { str } from '../shared';
import type { ToolRegistryEntry } from '../types';

/** Verbatim from the 3.19.19 cursor-agent-host tool table (`En("SET_ACTIVE_BRANCH", ...)`). */
const DESCRIPTION = `Set active git branch metadata for the current conversation and client UI. This directly controls which merge-base diff and related pull requests are shown to the user. Call this tool immediately when you are making changes on an existing feature branch, and call it immediately after committing changes to a new branch.`;

const PATH_DESCRIPTION = `Absolute repository path for this branch update.`;
const BRANCH_DESCRIPTION = `New active branch name.`;

const ANTHROPIC = {
    name: 'SetActiveBranch',
    description: DESCRIPTION,
    inputSchema: {
        type: 'object',
        required: ['path', 'branchName'],
        properties: {
            path: {
                type: 'string',
                description: PATH_DESCRIPTION,
            },
            branchName: {
                type: 'string',
                description: BRANCH_DESCRIPTION,
            },
        },
    },
};

const OPENAI = { ...ANTHROPIC };

const GEMINI = {
    name: 'SetActiveBranch',
    description: DESCRIPTION,
    inputSchema: {
        type: 'OBJECT',
        properties: {
            path: {
                type: 'STRING',
                description: PATH_DESCRIPTION,
            },
            branchName: {
                type: 'STRING',
                description: BRANCH_DESCRIPTION,
            },
        },
        required: ['path', 'branchName'],
    },
};

function branchArgs(input: Record<string, unknown>): { path: string, branchName: string } {
    return {
        path: str(input.path),
        branchName: str(input.branchName ?? input.branch_name),
    };
}

/**
 * Metadata-only tool: nothing is executed on either side, but the client tracks the
 * active branch from the `activeBranchChange` update rather than from the tool call,
 * so the update has to be emitted alongside the result.
 */
export const SetActiveBranchTool: ToolRegistryEntry = {
    canonicalName: 'SetActiveBranch',
    aliases: ['SetActiveBranch', 'set_active_branch'],
    cursorToolType: 'setActiveBranchToolCall',
    execArgsType: null,
    llmToolByProvider: {
        anthropic: ANTHROPIC,
        openai: OPENAI,
        gemini: GEMINI,
    },
    buildStartedArgs: input => branchArgs(input),
    buildLocalUpdates: input => [{ case: 'activeBranchChange', value: branchArgs(input) }],
};
