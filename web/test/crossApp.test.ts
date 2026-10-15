// test/crossApp.test.ts — the cross-app rail CONTRACT, vendored (opentakeoff#305).
//
// src/lib/crossApp.js and src/lib/useCrossAppRail.js are BYTE-FOR-BYTE copies of
// 345-estimating's src/lib/… (ledger D5–D7 / 345-estimating#757). Two things are asserted:
//
//   1. The sha256 PIN — the vendored bytes must never change. 345 owns the contract; a
//      host difference is a `homes` call-site argument, never an edit to this copy, so a
//      hand-edit here is drift even when it happens to keep the 345 behavior.
//   2. The BEHAVIOR SET — the same assertions 345's test/crossApp.test.js runs, so a
//      copy that somehow kept its bytes but lost its meaning (or a re-vendor of a
//      regressed 345 revision) still has to answer for the contract: destination order +
//      labels, param names + emit order, builder/parser round-trip, active-state
//      selection, and the `return` allowlist (scheme AND origin — the blob: hole).
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  CROSS_APP_DESTINATIONS,
  CROSS_APP_PARAMS,
  crossAppDestinationForHref,
  crossAppHref,
  crossAppHome,
  crossAppIdForHost,
  crossAppRail,
  crossAppReturnHref,
  isAllowedCrossAppReturn,
  parseCrossAppLink,
} from "../src/lib/crossApp.js";
import { useCrossAppRail } from "../src/lib/useCrossAppRail.js";

const QUEUE = "https://pb.345flooring.net/";
const TAKEOFF = "https://opentakeoff.345flooring.net/";

/** sha256 of the two vendored files AS SHIPPED BY 345 (verified equal to
 *  345-estimating/src/lib/<name> at vendoring time, 2026-10-15, origin/main 4d6cfd0e). */
const VENDORED_SHA256: Record<string, string> = {
  "crossApp.js": "4fb2d6de858d7fdc48dc87ba048f3fafd8d63138652785f0a76ee7ab2ff7d469",
  "useCrossAppRail.js": "0bfb2f32e03cf7202b65a0cfa683766e725aa812b3d57a7230bfcfc7e7a250f1",
};

const vendoredBytes = (name: string) => readFileSync(new URL(`../src/lib/${name}`, import.meta.url));

test("the vendored files are byte-identical to 345's contract — sha256 pin", () => {
  for (const [name, sha] of Object.entries(VENDORED_SHA256)) {
    assert.equal(
      createHash("sha256").update(vendoredBytes(name)).digest("hex"),
      sha,
      `${name} has DRIFTED from 345's copy — re-vendor it byte-for-byte (a host difference is a \`homes\` argument at the call site, never an edit here)`,
    );
  }
});

test("the rail is TWO destinations, in order: Queue then OpenTakeoff (D7)", () => {
  assert.deepEqual(CROSS_APP_DESTINATIONS.map((d) => d.id), ["queue", "takeoff"]);
  assert.deepEqual(CROSS_APP_DESTINATIONS.map((d) => d.label), ["Queue", "OpenTakeoff"]);
  assert.deepEqual(
    CROSS_APP_DESTINATIONS.map((d) => d.host),
    ["pb.345flooring.net", "opentakeoff.345flooring.net"],
  );
  assert.equal(crossAppHome("queue"), QUEUE);
  assert.equal(crossAppHome("takeoff"), TAKEOFF);
  assert.throws(() => crossAppHome("nope"), /unknown destination/);
});

test("param names + emit order are project, sheet, return — the pinned contract", () => {
  assert.deepEqual(CROSS_APP_PARAMS, ["project", "sheet", "return"]);
  // Supplied out of order — the builder still emits them in contract order.
  const href = crossAppHref("takeoff", { return: QUEUE, sheet: "A-101", project: "p-1" });
  assert.deepEqual([...new URL(href).searchParams.keys()], ["project", "sheet", "return"]);
  assert.equal(href, `${TAKEOFF}?project=p-1&sheet=A-101&return=${encodeURIComponent(QUEUE)}`);
});

test("empty / absent params are skipped, never emitted as blanks", () => {
  assert.equal(crossAppHref("takeoff"), TAKEOFF);
  // The contract's `raw == null` skips null AND undefined, so the assertion stays 345's;
  // only the CAST is OT's (the JSDoc param type is `string`, which cannot spell `null`).
  const blanks = { project: "", sheet: null, return: undefined } as unknown as Parameters<typeof crossAppHref>[1];
  assert.equal(crossAppHref("takeoff", blanks), TAKEOFF);
  assert.equal(crossAppHref("takeoff", { sheet: "A-101" }), `${TAKEOFF}?sheet=A-101`);
});

test("href → parse round-trips for BOTH destinations", () => {
  for (const [id, home, back] of [
    ["queue", QUEUE, TAKEOFF],
    ["takeoff", TAKEOFF, QUEUE],
  ]) {
    const href = crossAppHref(id, { project: "proj-42", sheet: "A-101", return: back });
    assert.ok(href.startsWith(home), `${id} href stays on its own home host`);
    assert.deepEqual(parseCrossAppLink(href), {
      id,
      label: id === "queue" ? "Queue" : "OpenTakeoff",
      project: "proj-42",
      sheet: "A-101",
      return: back,
    });
  }
});

test("a foreign / malformed href is not a rail destination", () => {
  assert.equal(parseCrossAppLink("https://example.com/?project=p"), null);
  assert.equal(parseCrossAppLink("not a url"), null);
  assert.equal(parseCrossAppLink(""), null);
  assert.equal(crossAppDestinationForHref("https://evil.example/"), null);
  assert.equal(crossAppDestinationForHref(TAKEOFF), crossAppDestinationForHref(`${TAKEOFF}?project=p`));
});

test("the active destination is the app you are on; a foreign host has none", () => {
  assert.equal(crossAppIdForHost("pb.345flooring.net"), "queue");
  assert.equal(crossAppIdForHost("pb.345flooring.net:443"), "queue");
  assert.equal(crossAppIdForHost("PB.345Flooring.NET"), "queue");
  assert.equal(crossAppIdForHost("opentakeoff.345flooring.net"), "takeoff");
  // A preview / dev host maps to NEITHER app — no active item rather than a wrong guess.
  assert.equal(crossAppIdForHost("pb-345.pages.dev"), null);
  assert.equal(crossAppIdForHost(""), null);
  // …and the local dev host OT is actually served from in this repo.
  assert.equal(crossAppIdForHost("localhost:5173"), null);
});

test("crossAppRail: the active item is marked (a marker, not a self-link); the other carries the state", () => {
  const rail = crossAppRail({ host: "pb.345flooring.net", project: "p-1", sheet: "A-101", return: TAKEOFF });
  assert.deepEqual(rail.map((r) => r.id), ["queue", "takeoff"]);
  const [queue, takeoff] = rail;
  assert.equal(queue.active, true);
  assert.equal(queue.href, "");
  assert.equal(queue.title, "Queue · pb.345flooring.net");
  assert.equal(takeoff.active, false);
  assert.equal(takeoff.title, "OpenTakeoff · opentakeoff.345flooring.net");
  assert.equal(takeoff.href, `${TAKEOFF}?project=p-1&sheet=A-101&return=${encodeURIComponent(TAKEOFF)}`);

  // …and the mirror image when you are in OpenTakeoff.
  const inOt = crossAppRail({ host: "opentakeoff.345flooring.net", project: "p-1", sheet: "A-101", return: QUEUE });
  assert.equal(inOt[0].active, false);
  assert.equal(inOt[0].href, `${QUEUE}?project=p-1&sheet=A-101&return=${encodeURIComponent(QUEUE)}`);
  assert.equal(inOt[1].active, true);
  assert.equal(inOt[1].href, "");
});

test("`return` is allowlisted to the two app origins (no open redirect)", () => {
  assert.equal(isAllowedCrossAppReturn(QUEUE), true);
  assert.equal(isAllowedCrossAppReturn(`${TAKEOFF}?page=2`), true);
  assert.equal(isAllowedCrossAppReturn("https://evil.example/"), false);
  assert.equal(isAllowedCrossAppReturn("http://pb.345flooring.net/"), false); // scheme mismatch
  assert.equal(isAllowedCrossAppReturn("javascript:alert(1)"), false);
  assert.equal(isAllowedCrossAppReturn(""), false);
  assert.equal(isAllowedCrossAppReturn(null), false);
  // A `blob:` URL's `.origin` IS the inner https origin, so an origin-only check would
  // admit it and it would then render as an anchor href — the SCHEME must match too.
  assert.equal(new URL("blob:https://pb.345flooring.net/abc").origin, "https://pb.345flooring.net");
  assert.equal(isAllowedCrossAppReturn("blob:https://pb.345flooring.net/abc"), false);
  assert.equal(isAllowedCrossAppReturn("blob:https://opentakeoff.345flooring.net/abc"), false);
  assert.equal(isAllowedCrossAppReturn("data:text/html,<script>x</script>"), false);

  // The builder DROPS an off-allowlist return …
  assert.equal(crossAppHref("takeoff", { project: "p-1", return: "https://evil.example/" }), `${TAKEOFF}?project=p-1`);
  assert.equal(
    crossAppHref("takeoff", { project: "p-1", return: "blob:https://pb.345flooring.net/abc" }),
    `${TAKEOFF}?project=p-1`,
  );
  // … and the parser refuses to hand one back.
  assert.equal(parseCrossAppLink(`${TAKEOFF}?return=https%3A%2F%2Fevil.example%2F`)?.return, "");
  assert.equal(parseCrossAppLink(`${TAKEOFF}?return=blob%3Ahttps%3A%2F%2Fpb.345flooring.net%2Fabc`)?.return, "");
  assert.equal(parseCrossAppLink(`${TAKEOFF}?return=${encodeURIComponent(QUEUE)}`)?.return, QUEUE);

  assert.equal(crossAppReturnHref(`?project=p-1&return=${encodeURIComponent(TAKEOFF)}`), TAKEOFF);
  assert.equal(crossAppReturnHref("?return=https%3A%2F%2Fevil.example%2F"), "");
  assert.equal(crossAppReturnHref(""), "");
});

test("a homes override retargets the links (VITE_* / staging) without changing the contract", () => {
  const homes = { takeoff: "https://ot.example/" };
  assert.equal(crossAppHome("takeoff", homes), "https://ot.example/");
  assert.equal(crossAppHome("queue", homes), QUEUE); // untouched key falls back to canonical
  assert.equal(crossAppHome("takeoff", { takeoff: "" }), TAKEOFF); // a blank override can't blank the link
  assert.equal(crossAppIdForHost("ot.example", homes), "takeoff");
  assert.equal(crossAppHref("takeoff", { project: "p-1" }, homes), "https://ot.example/?project=p-1");
});

test("a MALFORMED home override degrades to the canonical home — it never throws during render", () => {
  // resolveAppUrls' ensureSlash passes a bad env value straight through, and src/ has no
  // ErrorBoundary — so `new URL()` on the override must not be able to white-screen the shell.
  const bad = { takeoff: "opentakeoff.345flooring.net" }; // no scheme
  assert.doesNotThrow(() => crossAppRail({ host: "pb.345flooring.net" }, bad));
  assert.equal(crossAppHref("takeoff", {}, bad), TAKEOFF);
  assert.equal(crossAppHref("takeoff", { project: "p-1" }, bad), `${TAKEOFF}?project=p-1`);
  assert.equal(crossAppRail({ host: "pb.345flooring.net", project: "p-1" }, bad)[1].href, `${TAKEOFF}?project=p-1`);
  // …and the host/return predicates keep working against the canonical host.
  assert.equal(crossAppIdForHost("opentakeoff.345flooring.net", bad), "takeoff");
  assert.equal(isAllowedCrossAppReturn(TAKEOFF, bad), true);
  assert.equal(crossAppReturnHref("?return=" + encodeURIComponent(TAKEOFF), bad), TAKEOFF);
});

test("the shared files carry NO style tokens / pixel concerns (D6)", () => {
  for (const rel of ["../src/lib/crossApp.js", "../src/lib/useCrossAppRail.js"]) {
    const src = readFileSync(new URL(rel, import.meta.url), "utf8");
    assert.doesNotMatch(src, /var\(--/, `${rel}: shared code must not reference CSS custom properties`);
    assert.doesNotMatch(src, /className=/, `${rel}: shared code must not carry class names`);
    assert.doesNotMatch(src, /style=\{\{/, `${rel}: shared code must not carry inline styles`);
  }
});

test("the hook is installed in OT (it reads the live location for the rendered rail)", () => {
  // WorkspaceChrome renders the rail from this binding, so the vendored hook must at least
  // be importable under OT's toolchain (node --import tsx) — a React-version or ESM
  // resolution break would otherwise only show up in the browser.
  assert.equal(typeof useCrossAppRail, "function");
});
