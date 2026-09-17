/**
 * Bounded accumulator for a streamed shell output channel (stdout or stderr).
 *
 * The server accumulates shell output chunk by chunk while the exec runs. A naive
 * `output += chunk` is unbounded: a command that prints megabytes per second grows the
 * run's heap until the exec ends, and the head/tail truncation in shellToolResults.ts
 * only kicks in at result-construction time — far too late.
 *
 * This buffer applies the same head/tail-with-elision-count strategy at accumulation
 * time: the first and last `retainedSide` characters are kept verbatim, everything in
 * between is discarded and only counted. The retained window (1 MB per channel) matches
 * the official per-channel cap (`Cn = 1048576` in cursor-agent-exec), so nothing that
 * the official client would have kept is lost.
 */

/** Per-channel cap, aligned with cursor-agent-exec's 1 MB stdout/stderr limit. */
export const SHELL_STREAM_MAX_CHARS = 1_048_576;

export interface BoundedOutputBuffer {
    append: (chunk: string) => void;
    /** Total characters appended, including the elided ones. */
    readonly totalChars: number;
    /** Characters dropped from the middle of the stream. */
    readonly elidedChars: number;
    /** Retained text; carries an inline elision marker when anything was dropped. */
    readonly text: string;
}

/**
 * @param maxChars Total characters to retain; split evenly between head and tail.
 */
export function createBoundedOutputBuffer(maxChars: number = SHELL_STREAM_MAX_CHARS): BoundedOutputBuffer {
    const retainedSide = Math.max(1, Math.floor(maxChars / 2));
    let head = '';
    let headLen = 0;
    // Tail kept as a chunk ring rather than one string: re-slicing a multi-MB string on
    // every chunk would make accumulation quadratic in the number of chunks.
    const tailChunks: string[] = [];
    let tailLen = 0;
    let totalChars = 0;

    const append = (chunk: string): void => {
        if (!chunk) return;
        totalChars += chunk.length;

        let rest = chunk;
        if (headLen < retainedSide) {
            const take = Math.min(retainedSide - headLen, rest.length);
            head += rest.slice(0, take);
            headLen += take;
            rest = rest.slice(take);
            if (!rest) return;
        }

        tailChunks.push(rest);
        tailLen += rest.length;
        while (tailLen - tailChunks[0].length >= retainedSide) {
            tailLen -= tailChunks.shift()!.length;
        }
        if (tailLen > retainedSide) {
            const overflow = tailLen - retainedSide;
            tailChunks[0] = tailChunks[0].slice(overflow);
            tailLen -= overflow;
        }
    };

    return {
        append,
        get totalChars() {
            return totalChars;
        },
        get elidedChars() {
            return Math.max(0, totalChars - headLen - tailLen);
        },
        get text() {
            const tail = tailChunks.join('');
            const elided = Math.max(0, totalChars - headLen - tail.length);
            return elided > 0
                ? `${head}\n... [${elided} chars elided] ...\n${tail}`
                : `${head}${tail}`;
        },
    };
}
