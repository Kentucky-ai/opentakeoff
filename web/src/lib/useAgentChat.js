// The chat window's state: one project's conversation turns, persisted in the
// local meta store (IndexedDB, key agent_chat:<project>) and folded from the
// agent loop's events by lib/agentChat. The canvas owns the run; this owns
// the record of it. Streamed text deltas are coalesced (createDeltaBatcher) so
// a fast model re-renders the chat ~20 times a second, not once per token.
// The record stays in this browser: it is not part of the project file, an
// export, or Drive sync.
import { useCallback, useEffect, useRef, useState } from "react";
import { metaGet, metaPut } from "./store.js";
import { createDeltaBatcher, foldEvent, loadChat, MAX_TURNS, newTurn, saveChat, settleTurn } from "./agentChat.js";

const META = { get: metaGet, put: metaPut };
const SAVE_DEBOUNCE_MS = 400;

export function useAgentChat(projectId) {
  const [turns, setTurns] = useState([]);
  const turnsRef = useRef(turns);
  turnsRef.current = turns;
  const loadedRef = useRef(false);
  const dirtyRef = useRef(false);
  const batcherRef = useRef(/** @type {ReturnType<typeof createDeltaBatcher> | null} */ (null));
  if (!batcherRef.current) {
    batcherRef.current = createDeltaBatcher((pairs) => {
      setTurns((ts) => ts.map((t) => {
        let next = t;
        for (const [id, ev] of pairs) if (id === t.id) next = foldEvent(next, ev);
        return next;
      }));
    });
  }
  useEffect(() => () => batcherRef.current?.flush(), []);

  useEffect(() => {
    let live = true;
    loadedRef.current = false;
    loadChat(META, projectId).then((saved) => {
      if (!live) return;
      loadedRef.current = true;
      // a message sent before the load landed stays, after the saved history
      setTurns((cur) => (cur.length ? [...saved, ...cur].slice(-MAX_TURNS) : saved));
    });
    return () => {
      live = false;
      // leaving the project: write what is pending now, not after the debounce
      if (loadedRef.current && dirtyRef.current) { dirtyRef.current = false; void saveChat(META, projectId, turnsRef.current); }
    };
  }, [projectId]);

  useEffect(() => {
    if (!loadedRef.current) return undefined;
    dirtyRef.current = true;
    const id = setTimeout(() => { dirtyRef.current = false; void saveChat(META, projectId, turns); }, SAVE_DEBOUNCE_MS);
    return () => clearTimeout(id);
  }, [turns, projectId]);

  /** Start a turn for a user message; returns its id for apply/settle. */
  const begin = useCallback((goal) => {
    const t = newTurn(goal);
    setTurns((ts) => [...ts, t].slice(-MAX_TURNS));
    return t.id;
  }, []);
  /** Fold one agent-loop event into its turn (text deltas batched, order kept). */
  const apply = useCallback((id, ev) => { batcherRef.current?.apply(id, ev); }, []);
  /** The run is over: anything still marked running becomes stopped. */
  const settle = useCallback((id) => {
    batcherRef.current?.flush();
    setTurns((ts) => ts.map((t) => (t.id === id ? settleTurn(t) : t)));
  }, []);
  const clear = useCallback(() => setTurns([]), []);

  return { turns, turnsRef, begin, apply, settle, clear };
}
