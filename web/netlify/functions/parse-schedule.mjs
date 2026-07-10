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
const ALLOWED_HD = (process.env.ALLOWED_HD || "").trim().toLowerCase(); // "" = any verified Google account

// A schedule marquee is a small crop of one sheet — these caps are generous for
// that and just bound worst-case memory/time/cost against a malformed request
// (OAuth gating stops *who* can call this, not *what* they send).
const MAX_IMAGE_B64_LEN = 8_000_000; // ~6MB decoded PNG
const MAX_IMAGE_DIM = 4096;

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
  if (ALLOWED_HD && hd !== ALLOWED_HD) return { ok: false, status: 403, msg: "This deployment is limited to a single organization." };
  return { ok: true, email };
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
  if (!res.ok) throw new Error(`gemini ${res.status}`);
  const data = await res.json();
  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text || "{}";
  const parsed = JSON.parse(text);
  return Array.isArray(parsed.rows) ? parsed.rows : [];
}

export async function handler(event) {
  if (event.httpMethod !== "POST") return json(405, { error: "POST only" });
  if (!process.env.GEMINI_API_KEY) return json(501, { error: "scan reader not configured" });

  const auth = await verifyGoogleUser(event.headers?.authorization || event.headers?.Authorization);
  if (!auth.ok) return json(auth.status, { error: auth.msg });

  let body;
  try { body = JSON.parse(event.body || "{}"); } catch { return json(400, { error: "bad JSON" }); }
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
  } catch {
    return json(502, { error: "couldn't read the schedule" });
  }
}
