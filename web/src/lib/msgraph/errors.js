// MSAL failure → one readable sentence naming the STAGE that broke (#315).
// Pure and dependency-free so it is unit-tested without MSAL, and so the
// sign-in surface never shows a bare AADSTS code to an estimator.
//
// The codes below are MSAL's documented `errorCode` values plus the AADSTS
// numbers a tenant returns for the corners the RFC names: admin-consent
// policies, a personal account against a single-tenant app (and vice versa),
// a redirect URI that does not match the registration, a blocked popup, and
// a token the tenant revoked between sessions.

const AADSTS = [
  [/AADSTS65001|consent_required/i, "consent", "your tenant has not consented to this app: an admin must grant Files.ReadWrite.All (SELF_HOSTING.md, Microsoft 365 → step 1)"],
  [/AADSTS650(52|53|57)|admin_consent/i, "consent", "the app needs admin consent in your tenant before users can grant it (SELF_HOSTING.md, Microsoft 365 → step 1)"],
  [/AADSTS50020|AADSTS90072/i, "tenant", "this account does not belong to the tenant the build was configured for (VITE_MSAL_TENANT) — sign in with a work account from that tenant, or configure the build for the account type you use"],
  [/AADSTS50011|redirect_uri/i, "app registration", "the redirect URI does not match the app registration — add this exact origin under the Single-page application platform"],
  [/AADSTS700016|unauthorized_client/i, "app registration", "the client id was not found in the tenant — check VITE_MSAL_CLIENT_ID and that the registration allows this account type"],
  [/AADSTS7000218/i, "app registration", "the registration is not a Single-page application (it is asking for a client secret) — re-register the platform as SPA"],
  [/AADSTS50076|AADSTS50079|AADSTS50158|interaction_required/i, "sign-in", "the tenant requires a fresh interactive sign-in (MFA or conditional access) — click sign in again"],
  [/AADSTS50173|AADSTS700082|AADSTS70008|token_renewal_error|invalid_grant/i, "sign-in", "the saved sign-in was revoked or expired — sign in again"],
  [/popup_window_error|empty_window_error|BrowserAuthError: popup/i, "popup", "the browser blocked the sign-in popup — allow popups for this site and try again"],
  [/user_cancelled|user_cancelled_error/i, "popup", "the sign-in popup was closed before it finished"],
  [/monitor_window_timeout|BrowserAuthError: monitor/i, "popup", "the sign-in popup timed out — this happens when the redirect URI is not the app's own origin"],
  [/no_network|network_error|Failed to fetch/i, "network", "the sign-in service could not be reached"],
];

/** @param {unknown} e the thrown MSAL error (message / errorCode / errorMessage)
 *  @param {unknown} [prior] the silent-acquire error that preceded a popup attempt
 *  @returns {string} "Microsoft 365 sign-in failed at <stage>: <what to do> (<original code>)" */
export function describeMsalError(e, prior) {
  const parts = [e, prior].filter(Boolean).map((x) => {
    const o = /** @type {any} */ (x) || {};
    return [o.errorCode, o.subError, o.errorMessage, o.message, typeof x === "string" ? x : ""].filter(Boolean).join(" | ");
  });
  // the error the user saw LAST decides the stage; the silent-acquire error
  // that preceded a popup attempt is consulted only when the popup's own
  // message names nothing (a generic failure after "interaction required")
  for (const text of parts) {
    const code = (text.match(/AADSTS\d+/) || [])[0] || (text.match(/^[a-z_]+/) || [])[0] || "";
    for (const [re, stage, what] of AADSTS) {
      if (re.test(text)) return `Microsoft 365 sign-in failed at ${stage}: ${what}${code ? ` (${code})` : ""}.`;
    }
  }
  const raw = (/** @type {any} */ (e)?.message || String(e || "")).replace(/\s+/g, " ").trim();
  return `Microsoft 365 sign-in failed: ${raw || "unknown error"} — report this text verbatim on issue #315.`;
}
