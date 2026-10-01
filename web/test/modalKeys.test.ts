// Window capture key handlers (the in-app guide's Esc, the gallery's
// shortcut swallow) step aside for a key pressed inside another modal (the
// OCR download notice, the sheet preview), so that modal gets its own Esc.
import { test } from "node:test";
import assert from "node:assert/strict";
import { inOtherModal, otherModalOpen, MODAL_SELECTOR } from "../src/lib/modalKeys.ts";

/** A target whose closest(selector) answers `modal` for MODAL_SELECTOR. */
const target = (modal: unknown) => ({ closest: (sel: string) => (sel === MODAL_SELECTOR ? modal : null) });

test("a key inside another modal belongs to it", () => {
  const notice = { id: "notice" };
  assert.equal(inOtherModal(target(notice)), true);
  assert.equal(inOtherModal(target(notice), { id: "guide" }), true);
});

test("a key in the handler's own modal, or in no modal, is the handler's", () => {
  const guide = { id: "guide" };
  assert.equal(inOtherModal(target(guide), guide), false);
  assert.equal(inOtherModal(target(null)), false);
  assert.equal(inOtherModal(null), false);
  assert.equal(inOtherModal({}), false, "a target without closest (the window)");
});

test("the selector covers aria-modal dialogs and open <dialog>s", () => {
  assert.ok(MODAL_SELECTOR.includes('[aria-modal="true"]'));
  assert.ok(MODAL_SELECTOR.includes("dialog[open]"));
});

/** A document whose querySelectorAll(MODAL_SELECTOR) lists `modals`. */
const doc = (...modals: unknown[]) => ({ querySelectorAll: (sel: string) => (sel === MODAL_SELECTOR ? modals : []) });

test("otherModalOpen: another modal anywhere in the page, whatever has focus", () => {
  const guide = { id: "guide" }, notice = { id: "notice" };
  assert.equal(otherModalOpen(doc(guide, notice), guide), true, "the notice over the guide takes Esc even with focus on the body");
  assert.equal(otherModalOpen(doc(guide), guide), false, "only the guide itself");
  assert.equal(otherModalOpen(doc()), false);
  assert.equal(otherModalOpen(doc(notice)), true, "no own modal: any modal counts");
  assert.equal(otherModalOpen(null), false);
});
