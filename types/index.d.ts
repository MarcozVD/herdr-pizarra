/** What the panel shows: board.json's text, and the answer to its last send. */
export type Shown = { text: string | null; loaded: boolean; answer: number; isSent: boolean; status: string; tooBig: boolean }

/** What the panel posts. */
export type Post = {
  save?: { text: string; base: string | null }
  send?: { id: number; ask: boolean; said: string; ids: string[] | null; width: number; height: number }
}

declare module 'claude-code' {
  interface PluginState {
    pizarra: { shown: Shaped<Shown | null> }
  }
}
