// Gated schedule reader — the paid, non-public scan path for "Import from
// schedule". The takeoff canvas rasterizes the marqueed schedule region and
// POSTs it here (via the /ai/parse-schedule redirect); this function reads the
// finishes with a vision model and returns the SAME ScheduleRow shape the
// browser's vector parser produces, so both feed the one approval dialog.
//
// SECURITY — this endpoint spends money, so it is never public:
//   1. every request must carry a Google OAuth access token (Authorization:
//      Bearer …) — the client hides the feature when signed out, but THIS check
//      is the real gate (a hidden button doesn't stop curl);
//   2. the token is verified against Google, and the account's domain must match
//      ALLOWED_HD when set (e.g. 345flooring.com);
//   3. the vision-model key lives only in this function's env (GEMINI_API_KEY),
//      never in the browser bundle.
// Off by default: with no GEMINI_API_KEY the endpoint returns 501 and the scan
// path stays dark, so a fork that doesn't configure it never exposes anything.

const GOOGLE_USERINFO = "https://www.googleapis.com/oauth2/v3/userinfo";
const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash";
// Comma-separated org allow-list (e.g. "345flooring.com,345constructionco.com")
// — an org whose one Google Workspace spans several domains lists them all here.
// Empty ⇒ any verified Google account. This is the AUTHORITATIVE org gate; the
// client mirrors it in isAllowedDomain() (src/lib/google/auth.js) as a build-time
// VITE_GOOGLE_HD — keep the two lists in sync (see .github/workflows/deploy.yml).
// The client stamps its VITE_GOOGLE_HD on each request so hdDriftWarning() below
// logs a warning if the two ever fall out of sync (#91).
const ALLOWED_HDS = parseHdList(process.env.ALLOWED_HD);

// Parse a comma-separated org-domain allow-list into a normalized, de-duped,
// sorted array (trim + case-fold each; drop empties). Empty input ⇒ [] ⇒ the gate
// is open to any account. Sorted+de-duped so hdDriftWarning() can compare two
// lists order-insensitively. Mirrors domainAllows()'s parsing in auth.js.
function parseHdList(v) {
  return [...new Set((v || "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean))].sort();
}

// A schedule marquee is a small crop of one sheet — these caps are generous for
// that and just bound worst-case memory/time/cost against a malformed request
// (OAuth gating stops *who* can call this, not *what* they send).
const MAX_IMAGE_B64_LEN = 8_000_000; // ~6MB decoded PNG
const MAX_IMAGE_DIM = 4096;

// The client stamps its build-time VITE_GOOGLE_HD on each request as `client_hd`.
// Compare it to this function's runtime ALLOWED_HD and return an operator warning
// when they've drifted — the failure mode from #91 where the client org-gate
// (isAllowedDomain) silently no-ops because the two env values fell out of sync
// across the two systems (GitHub build var vs. Netlify runtime var). This is
// DIAGNOSTIC ONLY: `client_hd` is untrusted, browser-supplied, and never
// influences the auth decision (that's verifyGoogleUser + ALLOWED_HD, above).
// Normalizes both sides exactly as the gates do (trim + case-fold, comma-split)
// and compares them as sets, so domain ORDER doesn't warn but a real membership
// difference does. Returns null when they agree (incl. both empty).
export function hdDriftWarning(clientHd, allowedHd) {
  const c = parseHdList(clientHd), a = parseHdList(allowedHd);
  if (c.join(",") === a.join(",")) return null;
  return `org-gate drift: client VITE_GOOGLE_HD=[${c.join(",")}] != server ALLOWED_HD=[${a.join(",")}] — the client isAllowedDomain() gate is out of sync (see #91)`;
}

// Bound an untrusted diagnostic string before it reaches a log line: single-line
// and length-capped so a hostile `client_hd` can't inject newlines or flood logs.
// Slice BEFORE the regex so the whitespace-collapse never runs over an arbitrarily
// large attacker-supplied value (bound the work, not just the output).
function sanitizeForLog(v) {
  return (typeof v === "string" ? v : "").slice(0, 200).replace(/\s+/g, " ").trim().slice(0, 100);
}

const json = (statusCode, body) => ({
  statusCode,
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

// The schema we ask the model to fill — mirrors lib/scheduleParse's ScheduleRow.
// The client (lib/scheduleScan.normalizeScanRows) re-validates every field, so a
// partial/garbage row is dropped there, never trusted blindly.
const RESPONSE_SCHEMA = {
  type: "OBJECT",
  properties: {
    rows: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: {
          finish_tag: { type: "STRING" },
          section: { type: "STRING" },
          category: { type: "STRING" }, // floor | base | wall | transition | ceiling | other
          description: { type: "STRING" },
          manufacturer: { type: "STRING" },
          style: { type: "STRING" },
          spec_color: { type: "STRING" },
          size: { type: "STRING" },
        },
        required: ["finish_tag"],
      },
    },
  },
  required: ["rows"],
};

const PROMPT = [
  "This image is a crop of a construction finish/material SCHEDULE table.",
  "Extract EVERY finish row into JSON. One object per finish code (the CODE column, e.g. CPT-1, PT-2, RB-1, ACT-1).",
  "Fields per row: finish_tag (the code, uppercased), section (the section header it sits under, e.g. FLOORING/BASE/WALLS/CEILINGS/MILLWORK), category, description (the material/product), manufacturer, style, spec_color (the specified color/name), size.",
  "category MUST be one of: floor, base, wall, transition, ceiling, other — inferred from the section (FLOORING→floor, BASE→base, WALLS→wall, CEILINGS→ceiling, MILLWORK→other, transition strips/trim→transition).",
  "Do NOT invent rows or fields. Leave a field as an empty string if the table doesn't show it. Skip section-header and column-header rows.",
].join(" ");

async function verifyGoogleUser(authHeader) {
  const token = /^Bearer\s+(.+)$/i.exec(authHeader || "")?.[1];
  if (!token) return { ok: false, status: 401, msg: "Sign in to import from scanned plans." };
  let profile;
  try {
    const res = await fetch(GOOGLE_USERINFO, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) return { ok: false, status: 401, msg: "Session expired — sign in again." };
    profile = await res.json();
  } catch {
    return { ok: false, status: 502, msg: "Couldn't verify your sign-in." };
  }
  const email = (profile.email || "").toLowerCase();
  if (!email || profile.email_verified === false) {
    return { ok: false, status: 401, msg: "Your Google sign-in doesn't have a verified email." };
  }
  const hd = (profile.hd || email.split("@")[1] || "").toLowerCase();
  if (ALLOWED_HDS.length && !ALLOWED_HDS.includes(hd)) return { ok: false, status: 403, msg: "This deployment is limited to a specific organization." };
  return { ok: true, email };
}

// Typed failure carrier so the handler can tell WHY the read failed (Gemini HTTP
// status vs. our own JSON-parse of the model output) and log/respond distinctly.
// `kind` is "http" (Gemini returned !ok) or "parse" (we couldn't parse its JSON).
class ReadError extends Error {
  constructor(kind, { status, detail } = {}) {
    super(`read failed (${kind}${status ? ` ${status}` : ""})`);
    this.kind = kind;
    this.status = status;
    this.detail = detail;
  }
}

// Map a Gemini HTTP status to the response we send the CLIENT and the line we log
// for the OPERATOR. Pure (status → decision) so it's node-testable. Key rule: a
// Gemini key rejection (401/403) is an OPERATOR problem, so it must NOT surface as
// a 401/403 to the client — that code path shows "your sign-in doesn't have
// access," which is wrong and misleading. Only a genuine rate limit (429) is
// propagated as-is; everything else collapses to a 502 the way it always did, but
// now with a distinct server log so quota exhaustion is distinguishable from an
// outage or a bad key.
export function mapGeminiHttpFailure(status) {
  if (status === 429) {
    return { statusCode: 429, clientMsg: "The schedule reader is rate limited right now — try again shortly.", logLevel: "warn", logMsg: "gemini rate-limited (429)" };
  }
  if (status === 401 || status === 403) {
    return { statusCode: 502, clientMsg: "couldn't read the schedule", logLevel: "error", logMsg: `GEMINI_API_KEY rejected by Gemini (${status}) — check/rotate the key` };
  }
  return { statusCode: 502, clientMsg: "couldn't read the schedule", logLevel: "error", logMsg: `gemini ${status}` };
}

// Trim a Gemini error body to a bounded, single-line snippet safe to log. Gemini's
// error JSON never contains our API key (the key rides in the URL query string,
// which we deliberately never log), but cap length and strip newlines anyway so a
// large/odd upstream body can't flood or fracture the log line. Slice BEFORE the
// whitespace regex so the collapse never runs over an arbitrarily large body.
function logSnippet(text) {
  return (text || "").slice(0, 600).replace(/\s+/g, " ").trim().slice(0, 300);
}

async function readSchedule(imageB64) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${process.env.GEMINI_API_KEY}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ parts: [{ inline_data: { mime_type: "image/png", data: imageB64 } }, { text: PROMPT }] }],
      generationConfig: { responseMimeType: "application/json", responseSchema: RESPONSE_SCHEMA },
    }),
  });
  if (!res.ok) {
    // Read the error body best-effort for the log; never surface it to the client.
    const detail = await res.text().catch(() => "");
    throw new ReadError("http", { status: res.status, detail: logSnippet(detail) });
  }
  const data = await res.json();
  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text || "{}";
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    // The model returned non-JSON despite responseMimeType — a model-output
    // problem, distinct from an HTTP failure, so the operator can tell them apart.
    throw new ReadError("parse", { detail: logSnippet(text) });
  }
  return Array.isArray(parsed.rows) ? parsed.rows : [];
}

export async function handler(event) {
  if (event.httpMethod !== "POST") return json(405, { error: "POST only" });
  if (!process.env.GEMINI_API_KEY) return json(501, { error: "scan reader not configured" });

  const auth = await verifyGoogleUser(event.headers?.authorization || event.headers?.Authorization);
  if (!auth.ok) return json(auth.status, { error: auth.msg });

  let body;
  try { body = JSON.parse(event.body || "{}"); } catch { return json(400, { error: "bad JSON" }); }
  // JSON.parse happily yields null/array/scalar; the rest of the handler indexes
  // `body` as an object, so reject anything else with a clean 400 (not a 500).
  if (!body || typeof body !== "object" || Array.isArray(body)) return json(400, { error: "bad JSON" });
  // Cross-check the client's stamped org domain against ours; a drift means the
  // client-side org-gate is silently no-op'ing (#91). Log-only, never gates. Only
  // when client_hd is actually sent (a string, incl. "") — an absent field means
  // an old/other client that can't be compared, not drift, so don't false-alarm.
  if (typeof body.client_hd === "string") {
    const drift = hdDriftWarning(sanitizeForLog(body.client_hd), ALLOWED_HD);
    if (drift) console.warn(`parse-schedule: ${drift}`);
  }
  const imageB64 = typeof body.image_b64 === "string" ? body.image_b64 : "";
  if (!imageB64) return json(400, { error: "image_b64 required" });
  if (imageB64.length > MAX_IMAGE_B64_LEN) return json(413, { error: "image too large" });
  const { width, height } = body;
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0 || width > MAX_IMAGE_DIM || height > MAX_IMAGE_DIM) {
    return json(400, { error: "invalid image dimensions" });
  }

  try {
    const rows = await readSchedule(imageB64);
    return json(200, { rows });
  } catch (err) {
    // Distinguish the failure for the operator (log) and the client (status):
    //   - Gemini HTTP failure → mapGeminiHttpFailure (429 propagates; key/5xx → 502)
    //   - model output unparseable → its own 502 + distinct log
    //   - anything else (network, our own bug) → generic 502
    if (err instanceof ReadError && err.kind === "http") {
      const m = mapGeminiHttpFailure(err.status);
      const line = `parse-schedule: ${m.logMsg}${err.detail ? ` — ${err.detail}` : ""}`;
      if (m.logLevel === "warn") console.warn(line); else console.error(line);
      return json(m.statusCode, { error: m.clientMsg });
    }
    if (err instanceof ReadError && err.kind === "parse") {
      console.error(`parse-schedule: couldn't parse Gemini JSON output${err.detail ? ` — ${err.detail}` : ""}`);
      return json(502, { error: "couldn't read the schedule" });
    }
    console.error(`parse-schedule: read failed — ${err?.message || err}`);
    return json(502, { error: "couldn't read the schedule" });
  }
}
