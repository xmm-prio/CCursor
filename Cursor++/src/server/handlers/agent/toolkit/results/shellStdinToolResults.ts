import { envelope, num, obj, resultCase, str, type ToolResultEnvelope } from './shared';

/**
 * WriteShellStdin — stdin writes into an already-backgrounded shell.
 *
 * The exec channel answers with WriteShellStdinResult { success | error }; success only
 * confirms the write and reports how long the terminal file was beforehand, which is the
 * offset the model should read from when it polls with AwaitShell.
 */
export function buildShellStdinExecToolResult(
    cursorToolType: string,
    execClientMsg: Record<string, unknown>,
    input: Record<string, unknown>,
): ToolResultEnvelope | null {
    if (cursorToolType !== 'writeShellStdinToolCall') return null;
    const rc = resultCase(obj(execClientMsg.writeShellStdinResult));
    return rc
        ? { result: rc }
        : {
            result: {
                case: 'error',
                value: { error: `shell ${num(input.shellId ?? input.shell_id)} returned no stdin write result` },
            },
        };
}

export function normalizeShellStdinToolResult(
    cursorToolType: string,
    resultCaseName: string,
    value: Record<string, unknown>,
    input: Record<string, unknown>,
): ToolResultEnvelope | null {
    if (cursorToolType !== 'writeShellStdinToolCall') return null;
    if (resultCaseName === 'success') {
        return envelope('success', {
            shellId: num(value.shellId, num(input.shellId ?? input.shell_id)),
            terminalFileLengthBeforeInputWritten: num(value.terminalFileLengthBeforeInputWritten),
        });
    }
    return envelope(resultCaseName || 'error', value);
}

export function buildShellStdinToolResultText(
    cursorToolType: string,
    resultCaseName: string,
    value: Record<string, unknown>,
    input: Record<string, unknown>,
): string | null {
    if (cursorToolType !== 'writeShellStdinToolCall') return null;
    const shellId = num(value.shellId, num(input.shellId ?? input.shell_id));
    if (resultCaseName === 'success') {
        const before = num(value.terminalFileLengthBeforeInputWritten);
        return `Wrote ${str(input.chars).length} char(s) to the stdin of shell ${shellId}.`
            + ` The terminal file was ${before} char(s) long before the write; read the shell with AwaitShell to see what it produced.`;
    }
    return `Failed to write to the stdin of shell ${shellId}: ${str(value.error, resultCaseName || 'unknown error')}`;
}
