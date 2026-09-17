import { num, str } from '../shared';
import type { ToolRegistryEntry } from '../types';

/**
 * Stdin channel for shells that already moved to the background.
 *
 * The official client exposes `WriteShellStdin` only through the exec channel
 * (`writeShellStdinArgs`); it carries no LLM-facing definition, so the wording below is
 * ours. It is the only way to interact with a backgrounded shell: the exec control
 * channel has a single `abort { id }` case and no per-shell termination message, so a
 * shell that returned control to the model can afterwards only be read (AwaitShell) or
 * written to (this tool).
 */
const DESCRIPTION = `Write characters to the stdin of a shell that is still running in the background.

Use this when a command started with Shell moved to the background and is waiting for input — an interactive prompt, a confirmation, a REPL, or a paged viewer.

- \`shell_id\` is the identifier reported when the command moved to the background; it is the same id AwaitShell takes as \`task_id\`.
- \`chars\` is written verbatim, so include a trailing newline when the program expects a submitted line, and send control characters (for example "\\u0003" for Ctrl-C) when you need to interrupt or quit.
- Nothing is echoed back here. Read the shell's output with AwaitShell after writing.
- A shell that already exited cannot be written to; read its final output instead.`;

const SHELL_ID_DESCRIPTION = `Identifier of the background shell to write to, as reported when the command moved to the background.`;
const CHARS_DESCRIPTION = `Exact characters to write to stdin, including any trailing newline or control characters.`;

const ANTHROPIC = {
    name: 'WriteShellStdin',
    description: DESCRIPTION,
    inputSchema: {
        type: 'object',
        required: ['shell_id', 'chars'],
        properties: {
            shell_id: {
                type: 'integer',
                description: SHELL_ID_DESCRIPTION,
            },
            chars: {
                type: 'string',
                description: CHARS_DESCRIPTION,
            },
        },
    },
};

const OPENAI = { ...ANTHROPIC };

const GEMINI = {
    name: 'WriteShellStdin',
    description: DESCRIPTION,
    inputSchema: {
        type: 'OBJECT',
        properties: {
            shell_id: {
                type: 'INTEGER',
                description: SHELL_ID_DESCRIPTION,
            },
            chars: {
                type: 'STRING',
                description: CHARS_DESCRIPTION,
            },
        },
        required: ['shell_id', 'chars'],
    },
};

/** WriteShellStdinArgs.shell_id is uint32; accept the numeric string forms models emit. */
function shellId(input: Record<string, unknown>): number {
    const raw = input.shell_id ?? input.shellId ?? input.task_id ?? input.taskId;
    const parsed = typeof raw === 'string' ? Number.parseInt(raw, 10) : raw;
    const value = num(parsed, -1);
    if (value < 0)
        throw new Error(`WriteShellStdin.shell_id must be a non-negative integer, received ${JSON.stringify(raw)}`);
    return Math.trunc(value);
}

function stdinArgs(input: Record<string, unknown>): Record<string, unknown> {
    return {
        shellId: shellId(input),
        chars: str(input.chars ?? input.input),
    };
}

export const WriteShellStdinTool: ToolRegistryEntry = {
    canonicalName: 'WriteShellStdin',
    aliases: ['WriteShellStdin', 'write_shell_stdin'],
    cursorToolType: 'writeShellStdinToolCall',
    execArgsType: 'writeShellStdinArgs',
    llmToolByProvider: {
        anthropic: ANTHROPIC,
        openai: OPENAI,
        gemini: GEMINI,
    },
    buildStartedArgs: input => stdinArgs(input),
    buildExecArgs: input => stdinArgs(input),
};
