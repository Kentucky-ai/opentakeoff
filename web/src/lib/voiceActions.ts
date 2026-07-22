// Voice intent → app action dispatcher (RFC #59, slice 2). PURE and DOM-free.
// Routes each parsed intent through an injected capability object that the
// canvas builds from the SAME functions its own buttons call (mintCondition /
// activateCondition / updateCondById / addLabel / activateLabel / addMarkup) —
// the agentTools.js precedent: no voice-only code path may touch shapes or
// conditions directly (RFC #59 testing bar, mutation safety). The capability
// seam is also what makes bullet-7's proof testable: tests drive a state model
// through this dispatcher and through the equivalent UI call sequence and
// assert the results deep-equal.
//
// Outcome messages follow the commitMsg bar's convention: failures start with
// "Couldn't" (isDangerMsg renders them red + sticky), successes are short
// green confirmations.
import { parseVoiceIntent, type Intent, type RejectReason } from "./voiceIntent.ts";

export type VoiceCapabilities = {
  getConditions(): Array<{ id: string; finish_tag: string }>;
  getShapeLabels(): string[];
  /** Active condition id, "" when none — the set_waste guard. */
  getActiveConditionId(): string;
  /** Canvas binds {reassign:false} — programmatic activation never reassigns a selected shape. */
  activateCondition(id: string): void;
  /** mintCondition — the one shared minting path (UI +condition and the #63 agent use it too). */
  createCondition(tag: string): { id: string; finish_tag: string };
  /** BY ID, not active-based: combo intents patch a condition activated in the same handler,
   *  before React re-renders, so the active-based updateCond would hit the OLD active. */
  updateCondition(id: string, patch: { waste_pct: number }): void;
  addLabel(label: string): void;
  activateLabel(label: string | null): void;
  /** Canvas anchors the note (text markup on the focused sheet). */
  addNote(text: string): void;
};

export type VoiceOutcome = { ok: boolean; message: string };

/** Every value MUST start with "Couldn't" — that prefix is what the commitMsg
 *  bar's isDangerMsg keys on to render red + sticky. */
export const REJECTION_MESSAGES: Record<RejectReason, string> = {
  empty: "Couldn't hear a command.",
  unrecognized: 'Couldn\'t parse that — try "CPT-1", "waste 7", "label Phase 1", or "note …".',
  unknown_tag: "Couldn't match that tag — say a live condition tag, or a Div-9 code like CPT-2 to create one.",
  bad_number: 'Couldn\'t read the waste number — say 0–100, e.g. "waste 7" or "waste 7.5".',
  trailing_words: "Couldn't parse — extra words after the command. One command at a time.",
};

const fail = (message: string): VoiceOutcome => ({ ok: false, message });
const done = (message: string): VoiceOutcome => ({ ok: true, message });

/** Apply one parsed intent through the capabilities. Never throws; a failed
 *  precondition returns ok:false with a "Couldn't …" message and NO calls. */
export function applyVoiceIntent(caps: VoiceCapabilities, intent: Intent): VoiceOutcome {
  switch (intent.kind) {
    case "activate_condition": {
      let cond: { id: string; finish_tag: string } | undefined;
      if (intent.known) {
        // the parser returned the ctx literal, so exact finish_tag lookup holds
        cond = caps.getConditions().find((c) => c.finish_tag === intent.tag);
        if (!cond) return fail(`Couldn't find condition ${intent.tag}.`);
      } else {
        // defensive dedup (agentTools create_condition precedent) before minting
        cond =
          caps.getConditions().find((c) => c.finish_tag.toUpperCase() === intent.tag.toUpperCase()) ??
          caps.createCondition(intent.tag);
      }
      caps.activateCondition(cond.id);
      if (intent.waste !== undefined) {
        caps.updateCondition(cond.id, { waste_pct: intent.waste });
        return done(
          intent.known
            ? `${cond.finish_tag} active — waste ${intent.waste}%.`
            : `Created ${cond.finish_tag} — active, waste ${intent.waste}%.`,
        );
      }
      return done(intent.known ? `${cond.finish_tag} active.` : `Created ${cond.finish_tag} — active.`);
    }
    case "set_waste": {
      const id = caps.getActiveConditionId();
      if (!id) return fail("Couldn't set waste — no active condition.");
      caps.updateCondition(id, { waste_pct: intent.waste });
      const tag = caps.getConditions().find((c) => c.id === id)?.finish_tag ?? "active condition";
      return done(`Waste ${intent.waste}% on ${tag}.`);
    }
    case "set_label": {
      if (!intent.known) caps.addLabel(intent.label);
      caps.activateLabel(intent.label);
      return done(intent.known ? `Label ${intent.label} active.` : `Added label ${intent.label} — active.`);
    }
    case "clear_label":
      caps.activateLabel(null);
      return done("Label cleared.");
    case "add_note":
      caps.addNote(intent.text);
      return done("Note added — see Markups.");
  }
}

/** Parse + apply in one call — the canvas's single entry point. */
export function runVoiceCommand(caps: VoiceCapabilities, transcript: string): VoiceOutcome {
  const parsed = parseVoiceIntent(transcript, {
    conditionTags: caps.getConditions().map((c) => c.finish_tag),
    shapeLabels: caps.getShapeLabels(),
  });
  if (!parsed.ok) return fail(REJECTION_MESSAGES[parsed.reason]);
  return applyVoiceIntent(caps, parsed.intent);
}
