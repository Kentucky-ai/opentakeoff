export const PREMIUM_FORM = "premium-interest";
export const ROLES = ["Estimator", "Owner / manager", "General contractor", "Developer / integration partner", "Other"];
// Explicit allowlist: never serialize project state, account details or the URL.
export function premiumPayload(fields, requestId) {
  const clean = (key, limit) => String(fields[key] || "").trim().slice(0, limit);
  const email = clean("email", 254).toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error("Enter a valid email address.");
  const name = clean("name", 100), company = clean("company", 160);
  if (!name) throw new Error("Enter your name.");
  if (!company) throw new Error("Enter your company.");
  if (!ROLES.includes(fields.role)) throw new Error("Choose your role.");
  return new URLSearchParams({"form-name": PREMIUM_FORM, email, name, company, role: fields.role, "bot-field": clean("bot-field", 200), "request-id": requestId, "form-revision": "2026-09-30", source: "opentakeoff-app"});
}
export async function sendPremiumInterest(body, send = fetch) {
  const response = await send("/", {method:"POST", headers:{"Content-Type":"application/x-www-form-urlencoded"}, body:body.toString(), signal:AbortSignal.timeout(20000)});
  if (!response.ok) throw new Error("The request could not be sent. Your entries are still here; please try again.");
  // A misconfigured SPA can return its own index with 200 instead of storing.
  const html = await response.text();
  if (/id=["']root["']/.test(html)) throw new Error("Requests are temporarily unavailable. Your entries are still here; please try again later.");
}
// Unprompted dialog policy: only after real work, at most once per snooze window, never after a request.
export const PREMIUM_PROMPT_KEY = "opentakeoff.premiumPrompt";
export const PREMIUM_PROMPT_SNOOZE_MS = 30 * 24 * 60 * 60 * 1000;
export function shouldAutoPromptPremium(record, shapeCount, now = Date.now()) {
  if (!(shapeCount > 0)) return false;
  if (!record) return true;
  if (record.status === "requested") return false;
  return !(now - record.at < PREMIUM_PROMPT_SNOOZE_MS);
}
/** @param {Pick<Storage, "getItem">} [storage] */
export function readPremiumPrompt(storage = globalThis.localStorage) {
  try { const record = JSON.parse(storage.getItem(PREMIUM_PROMPT_KEY)); return record && typeof record.at === "number" ? record : null; } catch { return null; }
}
/** @param {"requested" | "dismissed"} status @param {Pick<Storage, "getItem" | "setItem">} [storage] */
export function writePremiumPrompt(status, storage = globalThis.localStorage, now = Date.now()) {
  try { if (status === "requested" || readPremiumPrompt(storage)?.status !== "requested") storage.setItem(PREMIUM_PROMPT_KEY, JSON.stringify({status, at: now})); } catch { /* private window: the prompt may repeat */ }
}
