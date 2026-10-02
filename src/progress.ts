// What a run reports while it works (DESIGN §7). The MCP implementation is src/mcp/progress.ts.

export interface Progress {
    /**
     * Waiting at `position` behind the session's running turn (`session`) or for a semaphore slot (`slot`); also keeps
     * the heartbeat going while queued.
     */
    queued(position: number, behind: 'session' | 'slot'): void;
    /** The run itself began: heartbeat with the elapsed time from here on. */
    started(): void;
    /** wait_thronglet: waiting for the session's turns to finish; heartbeat with the elapsed time until `done`. */
    waiting(): void;
    /** Every `tool_call`. */
    tool(title: string): void;
    /** Agent text of the current turn has `chars` characters; throttled. */
    text(chars: number): void;
    /** Stops the heartbeat; later calls are ignored. */
    done(): void;
    /** Resolves once every notification sent so far has been handed to the transport; await before returning the result. */
    idle(): Promise<void>;
}

export const noProgress: Progress = {
    queued: () => {
        /* no-op */
    },
    started: () => {
        /* no-op */
    },
    waiting: () => {
        /* no-op */
    },
    tool: () => {
        /* no-op */
    },
    text: () => {
        /* no-op */
    },
    done: () => {
        /* no-op */
    },
    idle: () => Promise.resolve(),
};
