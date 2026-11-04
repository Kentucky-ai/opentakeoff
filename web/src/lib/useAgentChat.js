// The chat window's state: one project's conversation turns, persisted in the
// local meta store (IndexedDB, key agent_chat:<project>) and folded from the
// agent loop's events by lib/agentChat. The canvas owns the run; this owns
// the record of it.
import { useCallback, useEffect, useRef, useState } from "react";
import { metaGet, metaPut } from "./store.js";
import { foldEvent, loadChat, MAX_TURNS, newTurn, saveChat, settleTurn } from "./agentChat.js";

const META = { get: metaGet, put: metaPut };
const SAVE_DEBOUNCE_MS = 400;

export function useAgentChat(projectId) {
  const [turns, setTurns] = useState([]);
  const turnsRef = useRef(turns);
  turnsRef.current = turns;
  const loadedRef = useRef(false);
  const dirtyRef = useRef(false);

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
  /** Fold one agent-loop event into its turn. */
  const apply = useCallback((id, ev) => {
    setTurns((ts) => ts.map((t) => (t.id === id ? foldEvent(t, ev) : t)));
  }, []);
  /** The run is over: anything still marked running becomes stopped. */
  const settle = useCallback((id) => {
    setTurns((ts) => ts.map((t) => (t.id === id ? settleTurn(t) : t)));
  }, []);
  const clear = useCallback(() => setTurns([]), []);

  return { turns, turnsRef, begin, apply, settle, clear };
}
