// Vendor-neutral coverage helpers. Values are generic industry-typical spread
// rates for estimating — always verify against the product data sheet.
export function materialKind(m) {
  if (m?.kind) return m.kind;
  const n = m?.name || "";
  if (/mortar|thin-?set/i.test(n)) return "mortar";
  if (/grout/i.test(n)) return "grout";
  if (/adhes|glue|bond|mastic/i.test(n)) return "adhesive";
  return "";
}
export const MATERIAL_PRESETS = {
  adhesive: [                              // SF per gallon
    { label: '1/16″×1/32″×1/32″ U (PSA)', per: 200 },
    { label: '1/4″ nap roller (PSA)',      per: 300 },
    { label: '1/16″×1/16″×1/16″ sq',       per: 150 },
    { label: '1/8″×1/8″×1/8″ sq',          per: 100 },
    { label: '3/16″ V (wood)',             per: 60 },
    { label: '1/4″×1/4″ V (wood)',         per: 50 },
    { label: '1/2″×1/2″ V (wood, coarse)', per: 40 },
  ],
  mortar: [                                // SF per 50-lb bag
    { label: '1/4″×1/4″×1/4″ sq', per: 90 },
    { label: '1/4″×3/8″×1/4″ sq', per: 65 },
    { label: '1/2″×1/2″×1/2″ sq', per: 42 },
    { label: '3/4″ U (large tile)', per: 30 },
  ],
};
export const GROUT_DENSITY = 8.33;         // industry-standard grout density factor
export const GROUT_DEFAULTS = { tileL: 12, tileW: 24, tileT: 0.375, joint: 0.125, bagLbs: 25 };
// lbs/SF = ((L+W)/(L×W)) × thickness_in × joint_in × density; coverage = bag ÷ lbs/SF
export function groutCoverageSfPerBag({ tileL, tileW, tileT, joint, bagLbs, density = GROUT_DENSITY }) {
  if (!(tileL > 0) || !(tileW > 0) || !(tileT > 0) || !(joint > 0) || !(bagLbs > 0)) return 0;
  return bagLbs / (((tileL + tileW) / (tileL * tileW)) * tileT * joint * density);
}
