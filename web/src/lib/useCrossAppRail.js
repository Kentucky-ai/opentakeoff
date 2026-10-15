// src/lib/useCrossAppRail.js
//
// The tiny React binding for the cross-app rail contract (src/lib/crossApp.js,
// ledger D5–D7 / 345-Flooring/345-estimating#757). Vendored into OpenTakeoff
// alongside crossApp.js.
//
// It reads the CURRENT location — host → which destination is active, and
// `?project` / `?sheet` / `?return` → the state the rail re-carries on the next hop —
// and memoizes `crossAppRail()` over it. Pure contract decisions live in crossApp.js;
// this file only adapts `window.location` to them (and takes an explicit `location`
// for a test or a non-browser host). No style tokens (D6).
import { useMemo } from "react";
import {
  crossAppDestinationForHref,
  crossAppRail,
  crossAppReturnHref,
} from "./crossApp.js";

/**
 * @param {{
 *   location?: { host?: string, search?: string, href?: string } | null,
 *   host?: string,
 *   search?: string,
 *   return?: string,
 *   homes?: Partial<{ queue: string, takeoff: string }>,
 * }} [options]
 * @returns {{
 *   items: ReturnType<typeof crossAppRail>,
 *   returnHref: string,
 *   returnLabel: string,
 * }}
 */
export function useCrossAppRail(options = {}) {
  const loc = options.location || (typeof window !== "undefined" ? window.location : null);
  const host = options.host ?? loc?.host ?? "";
  const search = options.search ?? loc?.search ?? "";
  const pageHref = options.return ?? loc?.href ?? "";

  // A fresh `{ queue, takeoff }` object every render would defeat the memo below, so
  // key the homes on their two strings.
  const queue = options.homes?.queue || "";
  const takeoff = options.homes?.takeoff || "";
  const homes = useMemo(() => ({ queue, takeoff }), [queue, takeoff]);

  return useMemo(() => {
    const params = new URLSearchParams(search);
    const returnHref = crossAppReturnHref(search, homes);
    const back = returnHref ? crossAppDestinationForHref(returnHref, homes) : null;
    return {
      items: crossAppRail(
        {
          host,
          project: params.get("project") || "",
          sheet: params.get("sheet") || "",
          return: pageHref,
        },
        homes,
      ),
      returnHref,
      returnLabel: back ? `Return to ${back.label}` : "",
    };
  }, [host, search, pageHref, homes]);
}
