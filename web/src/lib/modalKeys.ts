// Window capture key handlers — the in-app guide's Esc, the gallery's
// shortcut swallow — run before any element's own handler, so without this
// they would take Esc from a modal opened over them (the OCR download notice,
// the sheet preview). A key pressed inside another modal is that modal's.

/** A modal: an aria-modal dialog or an open <dialog>. */
export const MODAL_SELECTOR = '[aria-modal="true"], dialog[open]';

type Target = { closest?: (selector: string) => unknown } | null | undefined;

/** Was the key pressed inside a modal other than `own` (the handler's own
 * dialog element, if it has one)? */
export function inOtherModal(target: Target, own?: unknown): boolean {
  const modal = target?.closest?.(MODAL_SELECTOR) ?? null;
  return modal != null && modal !== own;
}

type Root = { querySelectorAll(selector: string): Iterable<unknown> } | null | undefined;

/** Is a modal other than `own` open anywhere in `root` (the document)? For
 * Esc pressed with focus on the body: the topmost modal (the OCR download
 * notice, mounted last and above everything) takes it, so a window handler
 * for a modal under it steps aside. */
export function otherModalOpen(root: Root, own?: unknown): boolean {
  if (!root) return false;
  for (const m of root.querySelectorAll(MODAL_SELECTOR)) if (m !== own) return true;
  return false;
}
