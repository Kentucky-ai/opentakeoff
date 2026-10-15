// src/lib/crossApp.js
//
// Cross-app rail contract — ledger D5–D7 (345-Flooring/345-estimating#757).
//
// This file is the AUTHORITY for the shared top rail. OpenTakeoff vendors it
// BYTE-FOR-BYTE and pins the copy with a drift test (opentakeoff#305) — so it is
// deliberately self-contained: no imports, no React, no DOM, no app-specific module
// (345's `src/shell/lib/apps.js` shapes / OT's `calm-header` shapes stay outside),
// and NO style tokens. Per D6 the shared thing is the CONTRACT — destinations,
// order, labels, active state, deep-link params, href builders/parsers — while the
// PIXELS stay each app's own (`--rule` / spacing indices differ between the two).
//
// The contract in one paragraph:
//   · TWO destinations, in this order — "Queue" (345's bid board, pb.345flooring.net)
//     then "OpenTakeoff" (opentakeoff.345flooring.net).
//   · ONE set of deep-link params — `project`, `sheet`, `return` — emitted in that
//     order and only when non-empty.
//   · The ACTIVE destination is the one whose host is the host you are on; the rail
//     renders it as current and links the other one.
//   · A `return` href is honored ONLY when it points back at one of the two app
//     origins (an allowlist, so the param can never become an open redirect).

/**
 * Canonical home per destination (D7: hosts stay pb./opentakeoff. for now).
 * @type {{ queue: string, takeoff: string }}
 */
export const CROSS_APP_HOMES = Object.freeze({
  queue: "https://pb.345flooring.net/",
  takeoff: "https://opentakeoff.345flooring.net/",
});

/** Deep-link param names, in emit order. The order IS the contract. @type {readonly string[]} */
export const CROSS_APP_PARAMS = Object.freeze(["project", "sheet", "return"]);

/**
 * Rail destinations, in rail order. `label` is the shared vocabulary (D7); `host` is
 * what an incoming URL's hostname is matched against for the active state.
 * @type {readonly { id: string, label: string, host: string }[]}
 */
export const CROSS_APP_DESTINATIONS = Object.freeze([
  Object.freeze({ id: "queue", label: "Queue", host: "pb.345flooring.net" }),
  Object.freeze({ id: "takeoff", label: "OpenTakeoff", host: "opentakeoff.345flooring.net" }),
]);

/** Parse an absolute URL, or null when the string is not one. */
function parseUrl(url) {
  try {
    return new URL(url);
  } catch {
    return null;
  }
}

/**
 * The home URL for a destination. A caller may hand in a partial override map (345
 * threads its `resolveAppUrls` homes through) — an absent/empty entry falls back to
 * the canonical host, so an override can never blank a link out.
 * @param {string} id
 * @param {Partial<{ queue: string, takeoff: string }>} [homes]
 * @returns {string}
 */
export function crossAppHome(id, homes = CROSS_APP_HOMES) {
  const override = homes ? homes[id] : "";
  const home = override || CROSS_APP_HOMES[id];
  if (!home) throw new Error(`crossAppHome: unknown destination "${id}"`);
  return home;
}

/**
 * A destination home as a URL OBJECT: the caller's override when it parses, else the
 * canonical home. `resolveAppUrls`' `ensureSlash` passes a bad env value through
 * unchanged (e.g. `VITE_TAKEOFF_HOME=opentakeoff.345flooring.net`), and there is no
 * ErrorBoundary in src/ — so a malformed override must degrade, never throw during
 * render. Returns null only if even the canonical constant is unparseable.
 * @param {string} id
 * @param {Partial<{ queue: string, takeoff: string }>} [homes]
 * @returns {URL | null}
 */
function homeUrl(id, homes = CROSS_APP_HOMES) {
  return parseUrl(crossAppHome(id, homes)) || parseUrl(CROSS_APP_HOMES[id]);
}

/**
 * True when `href` points at one of the two cross-app origins — the `return=`
 * allowlist that keeps the param from being an open redirect. Both the SCHEME and the
 * origin must match: `origin` alone is not the scheme (`new URL("blob:https://pb.345flooring.net/x")
 * .origin` is the inner https origin), so an origin-only check would let a non-http(s)
 * `return=` through to become an anchor href.
 * @param {unknown} href
 * @param {Partial<{ queue: string, takeoff: string }>} [homes]
 * @returns {boolean}
 */
export function isAllowedCrossAppReturn(href, homes = CROSS_APP_HOMES) {
  if (typeof href !== "string" || !href) return false;
  const target = parseUrl(href);
  if (!target) return false;
  return CROSS_APP_DESTINATIONS.some((d) => {
    const home = homeUrl(d.id, homes);
    return Boolean(home) && target.protocol === home.protocol && target.origin === home.origin;
  });
}

/**
 * The destination an href belongs to (by origin), or null when it is not one of the
 * two apps.
 * @param {unknown} href
 * @param {Partial<{ queue: string, takeoff: string }>} [homes]
 * @returns {{ id: string, label: string, host: string } | null}
 */
export function crossAppDestinationForHref(href, homes = CROSS_APP_HOMES) {
  if (typeof href !== "string" || !href) return null;
  const origin = parseUrl(href)?.origin;
  if (!origin) return null;
  for (const d of CROSS_APP_DESTINATIONS) {
    if (homeUrl(d.id, homes)?.origin === origin) return d;
  }
  return null;
}

/**
 * The destination id for a hostname (an incoming `location.host`), or null when the
 * host is neither app (e.g. a preview/dev domain — then the rail simply has no
 * active item rather than guessing).
 * @param {unknown} host
 * @param {Partial<{ queue: string, takeoff: string }>} [homes]
 * @returns {string | null}
 */
export function crossAppIdForHost(host, homes = CROSS_APP_HOMES) {
  if (typeof host !== "string" || !host) return null;
  const hostname = host.toLowerCase().split(":")[0];
  for (const d of CROSS_APP_DESTINATIONS) {
    if (homeUrl(d.id, homes)?.hostname.toLowerCase() === hostname) return d.id;
  }
  return null;
}

/**
 * Build a destination's href, carrying only the contract's params (`project`,
 * `sheet`, `return`), in that order, and skipping empty ones. A `return` that is not
 * on the allowlist is DROPPED, not sanitized — the other app should never be handed
 * a hop-back it would refuse.
 *
 * A malformed home override never throws: `resolveAppUrls`' `ensureSlash` passes a bad
 * env value through unchanged (e.g. `VITE_TAKEOFF_HOME=opentakeoff.345flooring.net`),
 * and there is no ErrorBoundary in src/ — so a `new URL()` throw here would be a white
 * screen. It degrades to the canonical home instead.
 * @param {string} id
 * @param {{ project?: string, sheet?: string, return?: string }} [params]
 * @param {Partial<{ queue: string, takeoff: string }>} [homes]
 * @returns {string}
 */
export function crossAppHref(id, params = {}, homes = CROSS_APP_HOMES) {
  const url = homeUrl(id, homes);
  if (!url) return crossAppHome(id, homes);
  for (const key of CROSS_APP_PARAMS) {
    const raw = params[key];
    if (raw == null || raw === "") continue;
    const value = String(raw);
    if (key === "return" && !isAllowedCrossAppReturn(value, homes)) continue;
    url.searchParams.set(key, value);
  }
  return url.toString();
}

/**
 * Parse a cross-app href back into its destination + carried state. Returns null when
 * the href is not one of the two apps (so a caller can leave an unknown link alone).
 * The returned `return` is "" unless it passes the allowlist.
 * @param {string} href
 * @param {Partial<{ queue: string, takeoff: string }>} [homes]
 * @returns {{ id: string, label: string, project: string, sheet: string, return: string } | null}
 */
export function parseCrossAppLink(href, homes = CROSS_APP_HOMES) {
  const destination = crossAppDestinationForHref(href, homes);
  if (!destination) return null;
  const url = new URL(href);
  const read = (key) => url.searchParams.get(key) || "";
  const back = read("return");
  return {
    id: destination.id,
    label: destination.label,
    project: read("project"),
    sheet: read("sheet"),
    return: isAllowedCrossAppReturn(back, homes) ? back : "",
  };
}

/**
 * The allowlisted `return=` in a query string (e.g. `location.search`), or "".
 * @param {string} [search]
 * @param {Partial<{ queue: string, takeoff: string }>} [homes]
 * @returns {string}
 */
export function crossAppReturnHref(search = "", homes = CROSS_APP_HOMES) {
  const raw = new URLSearchParams(search).get("return") || "";
  return isAllowedCrossAppReturn(raw, homes) ? raw : "";
}

/**
 * The rail: one item per destination, in order, each flagged `active` when its host is
 * the host you are on. The ACTIVE item carries `href: ""` — it is where you already
 * are, so the renderer draws it as current rather than a link. Every other item carries
 * a deep link that re-carries `project` / `sheet` and hops back via `return`.
 * @param {{ host?: string, project?: string, sheet?: string, return?: string }} [state]
 * @param {Partial<{ queue: string, takeoff: string }>} [homes]
 * @returns {Array<{ id: string, label: string, host: string, title: string, href: string, active: boolean }>}
 */
export function crossAppRail(state = {}, homes = CROSS_APP_HOMES) {
  const { host = "", project = "", sheet = "", return: back = "" } = state;
  const active = crossAppIdForHost(host, homes);
  return CROSS_APP_DESTINATIONS.map((d) => {
    const isActive = d.id === active;
    return {
      id: d.id,
      label: d.label,
      host: d.host,
      title: `${d.label} · ${d.host}`,
      active: isActive,
      href: isActive ? "" : crossAppHref(d.id, { project, sheet, return: back }, homes),
    };
  });
}
