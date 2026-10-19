// OpenTakeoff Premium plans, as published on kentucky-ai.com/#pricing. Sign-up and the 7-day trial run on
// start.kentucky-ai.com (Stripe Checkout, card on file); this app only links there and never sends anything.
export const PREMIUM_START = "https://start.kentucky-ai.com";
export const PREMIUM_SIGN_IN = `${PREMIUM_START}/#signin`;
export const PREMIUM_COMPARE = "https://kentucky-ai.com/#pricing";
export const PREMIUM_CONTACT = "https://kentucky-ai.com/#call";
export const PREMIUM_TRIAL = {days: 7, credits: 50};
export const PREMIUM_PLANS = [
  {id: "single", name: "Individual Pro", tag: "1 seat", price: 149, per: "7-day free trial · cancel anytime",
    features: ["300 AI credits a month", "AI assistant on the sheet", "Plan index + spec answers", "Estimates, bids, POs", "Every trade suite", "Private hosted workspace"]},
  {id: "team", name: "Team Pro", tag: "Most popular", price: 399, per: "7-day free trial · 3 seats", hot: true,
    features: ["800 AI credits a month, shared", "3 seats", "+$129 a seat, 250 credits each", "Live team editing", "Comments + @mentions", "Everything in Individual Pro"]},
  {id: "enterprise", name: "Enterprise", tag: "Custom", price: null, per: "Sized to your team",
    features: ["Seats + credits sized to you", "Onboarding on your plans", "Custom trade suites", "Invoicing"]},
];
export function planHref(plan) {
  return plan.price == null ? PREMIUM_CONTACT : `${PREMIUM_START}/?plan=${encodeURIComponent(plan.id)}#start`;
}
// Unprompted dialog policy: only after real work, at most once per snooze window, never after a trial start
// ("requested" is the old early-access form's record and is honoured the same way).
export const PREMIUM_PROMPT_KEY = "opentakeoff.premiumPrompt";
export const PREMIUM_PROMPT_SNOOZE_MS = 30 * 24 * 60 * 60 * 1000;
const DONE = ["started", "requested"];
export function shouldAutoPromptPremium(record, shapeCount, now = Date.now()) {
  if (!(shapeCount > 0)) return false;
  if (!record) return true;
  if (DONE.includes(record.status)) return false;
  return !(now - record.at < PREMIUM_PROMPT_SNOOZE_MS);
}
/** @param {Pick<Storage, "getItem">} [storage] */
export function readPremiumPrompt(storage = globalThis.localStorage) {
  try { const record = JSON.parse(storage.getItem(PREMIUM_PROMPT_KEY)); return record && typeof record.at === "number" ? record : null; } catch { return null; }
}
/** @param {"started" | "dismissed"} status @param {Pick<Storage, "getItem" | "setItem">} [storage] */
export function writePremiumPrompt(status, storage = globalThis.localStorage, now = Date.now()) {
  try { if (DONE.includes(status) || !DONE.includes(readPremiumPrompt(storage)?.status)) storage.setItem(PREMIUM_PROMPT_KEY, JSON.stringify({status, at: now})); } catch { /* private window: the prompt may repeat */ }
}
