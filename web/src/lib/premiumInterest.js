export const PREMIUM_FORM = "premium-interest";
export const ROLES = ["Estimator", "Owner / manager", "General contractor", "Developer / integration partner", "Other"];
export const TRADES = ["Flooring / finishes", "General construction", "Electrical / mechanical / plumbing", "Landscaping", "Other"];
export const INTERESTS = ["Advanced computer-vision models", "Estimates and pricing", "Proposals and client-ready deliverables", "RFI workflows", "Submittal packages", "Native iPad / tablet takeoff", "Mobile fieldwork & sync", "Team workflows", "Integrations and automation", "Not sure yet"];
// Explicit allowlist: never serialize project state, account details or the URL.
export function premiumPayload(fields, requestId) {
  const clean = (key, limit) => String(fields[key] || "").trim().slice(0, limit);
  const email = clean("email", 254).toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error("Enter a valid email address.");
  for (const [key, choices] of [["role", ROLES], ["trade", TRADES], ["interest", INTERESTS]]) {
    if (!choices.includes(fields[key])) throw new Error(`Choose your ${key === "interest" ? "main interest" : key}.`);
  }
  return new URLSearchParams({"form-name": PREMIUM_FORM, email, name: clean("name", 100), company: clean("company", 160), role: fields.role, trade: fields.trade, interest: fields.interest, updates: fields.updates === "yes" ? "yes" : "no", "bot-field": clean("bot-field", 200), "request-id": requestId, "form-revision": "2026-09-15", "consent-revision": "2026-09-15", source: "opentakeoff-app"});
}
export async function sendPremiumInterest(body, send = fetch) {
  const response = await send("/", {method:"POST", headers:{"Content-Type":"application/x-www-form-urlencoded"}, body:body.toString(), signal:AbortSignal.timeout(20000)});
  if (!response.ok) throw new Error("The request could not be sent. Your entries are still here; please try again.");
  // A misconfigured SPA can return its own index with 200 instead of storing.
  const html = await response.text();
  if (/id=["']root["']/.test(html)) throw new Error("Requests are temporarily unavailable. Your entries are still here; please try again later.");
}
