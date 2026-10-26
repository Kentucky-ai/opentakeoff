// OpenTakeoff Premium is sold on kentucky-ai.com: every Premium button in this app opens its pricing section in a
// new tab. Plans, prices and the 7-day trial sign-up live there only, so this app never shows a stale price and
// never sends anything. Takes no arguments: buttons pass their click event straight through.
export const PREMIUM_PRICING = "https://kentucky-ai.com/#pricing";
export function openPremiumPricing() {
  globalThis.window?.open(PREMIUM_PRICING, "_blank", "noopener,noreferrer");
}
