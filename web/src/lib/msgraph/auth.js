// MSAL wrapper (#315) — browser-side auth against the USER'S OWN tenant.
// Tokens live in the user's browser, period: no relay, no token store, no
// server of ours in the path. That invariant is the whole security model.
//
// EXPERIMENTAL and awaiting a live tenant proof (issue #315): the wiring
// follows MSAL's documented popup + silent-refresh flow, but no one on this
// project has a 365 tenant to run it against — self-hosters who do are the
// validation path, and the failure states below are written to be REPORTABLE
// (a readable error naming the stage, never a wedge).
//
// Scope: Files.ReadWrite.All (delegated) — read/write driveItems the signed-in
// user can already reach, which is exactly a document library they use. Tenant
// admin-consent policies can block it; that surfaces as a readable sign-in
// error, and SELF_HOSTING.md tells the admin what to consent to.
//
// CUT-LINE: this module (and @azure/msal-browser) loads ONLY on the opted-in
// 365 path via dynamic import — anonymous, folder, and Drive bundles never
// pull MSAL in.

import { PublicClientApplication } from "@azure/msal-browser";
import { describeMsalError } from "./errors.js";

const SCOPES = ["Files.ReadWrite.All"];

/** @param {{clientId: string, tenant: string}} cfg */
export function createMsalAuth(cfg) {
  const pca = new PublicClientApplication({
    auth: {
      clientId: cfg.clientId,
      authority: `https://login.microsoftonline.com/${cfg.tenant}`,
      redirectUri: window.location.origin,
    },
    cache: { cacheLocation: "localStorage" }, // survive reloads — sign in once
  });
  let initP = null;
  const init = () => (initP ??= pca.initialize());

  const account = () => pca.getAllAccounts()[0] || null;

  return {
    /** The signed-in account (after init), or null. */
    async currentAccount() {
      await init();
      return account();
    },

    /** Interactive sign-in — MUST run in a user gesture (popup). */
    async signIn() {
      await init();
      let res;
      try {
        res = await pca.loginPopup({ scopes: SCOPES, prompt: "select_account" });
      } catch (e) {
        // every failure names its stage — consent, tenant, popup — so a
        // tester's report says which one broke without reading MSAL codes
        throw new Error(describeMsalError(e));
      }
      if (res?.account) pca.setActiveAccount(res.account);
      return res?.account || account();
    },

    async signOut() {
      await init();
      const acc = account();
      // Local-only clear: a popup logout is disruptive and unnecessary for
      // "stop syncing" — the tenant session is the user's own business.
      if (acc) await pca.clearCache({ account: acc });
    },

    // The injected token source the Graph client takes — silent first, popup
    // fallback (which throws outside a gesture; callers treat that as
    // "needs sign-in", a readable state, not a crash loop).
    // `forceRefresh` is what the Graph client asks for ONCE after a 401 — MSAL
    // skips its cache and goes to the token endpoint; a token the tenant
    // revoked (consent change, password reset, conditional access) fails
    // there with a readable reason instead of a cached zombie.
    async getToken({ forceRefresh = false } = {}) {
      await init();
      const acc = account();
      if (!acc) throw new Error("m365: not signed in");
      try {
        const res = await pca.acquireTokenSilent({ scopes: SCOPES, account: acc, forceRefresh });
        return res.accessToken;
      } catch (silentErr) {
        try {
          const res = await pca.acquireTokenPopup({ scopes: SCOPES, account: acc });
          return res.accessToken;
        } catch (e) {
          throw new Error(describeMsalError(e, silentErr));
        }
      }
    },
  };
}
