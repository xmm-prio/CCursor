import { str } from '../shared';
import type { ToolRegistryEntry } from '../types';

/**
 * Description and parameter wording are taken verbatim from the 3.19.19
 * cursor-agent-host tool table (`En("CONNECT_SCM", ...)`), including the
 * `conciseStaticContext` the official final profile shows for this tool.
 */
const DESCRIPTION = `Offer the user a Connect GitHub prompt when source-control access would unblock the task, such as reviewing pull requests, opening pull requests, or acting on a repository. The user may connect, skip, or the attempt may fail. Offer this on your own initiative at most once per conversation; after a skip or failure, don't re-offer it unless the user explicitly asks to use ConnectScm. Otherwise report what happened and continue without GitHub.`;

const REPO_DESCRIPTION = `Optional repository in 'owner/name' form that the user wants connected. Provide it when the user named a specific repo so the connect flow can also prompt to install the app there.`;

const ANTHROPIC = {
    name: 'ConnectScm',
    description: DESCRIPTION,
    inputSchema: {
        type: 'object',
        properties: {
            github_repo: {
                type: 'string',
                description: REPO_DESCRIPTION,
            },
        },
    },
};

const OPENAI = { ...ANTHROPIC };

const GEMINI = {
    name: 'ConnectScm',
    description: DESCRIPTION,
    inputSchema: {
        type: 'OBJECT',
        properties: {
            github_repo: {
                type: 'STRING',
                description: REPO_DESCRIPTION,
            },
        },
    },
};

/** `owner/name` → ConnectScmGithubRepository; anything else yields no repository hint. */
function buildGithubTarget(input: Record<string, unknown>): Record<string, unknown> | undefined {
    const raw = str(input.github_repo ?? input.githubRepo).trim();
    if (!raw) return undefined;
    const [owner, repo] = raw.split('/');
    if (!owner || !repo) return undefined;
    return { case: 'github', value: { repository: { owner, repo } } };
}

export const ConnectScmTool: ToolRegistryEntry = {
    canonicalName: 'ConnectScm',
    aliases: ['ConnectScm', 'connect_scm'],
    cursorToolType: 'connectScmToolCall',
    execArgsType: null,
    conciseStaticContext: 'When user is blocked on connecting to GitHub.',
    llmToolByProvider: {
        anthropic: ANTHROPIC,
        openai: OPENAI,
        gemini: GEMINI,
    },
    buildStartedArgs: (input, callId) => {
        const target = buildGithubTarget(input);
        return {
            ...(target ? { target } : {}),
            toolCallId: callId,
        };
    },
    interaction: {
        queryCase: 'connectScmRequestQuery',
        responseCase: 'connectScmRequestResponse',
        buildQueryValue: startedArgs => ({ args: startedArgs }),
    },
};
