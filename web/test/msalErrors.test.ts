// #315: every MSAL failure names the STAGE that broke, in words an estimator
// can act on and a tester can report — never a bare AADSTS code.
import { test } from "node:test";
import assert from "node:assert/strict";
import { describeMsalError } from "../src/lib/msgraph/errors.js";

test("consent, tenant, registration, popup, network and revoked-token failures each name their stage and carry the original code", () => {
  const cases: Array<[any, RegExp]> = [
    [{ errorCode: "consent_required", errorMessage: "AADSTS65001: The user or administrator has not consented" }, /at consent: .*admin must grant Files\.ReadWrite\.All.*\(AADSTS65001\)/],
    [{ message: "AADSTS90072: User account from identity provider does not exist in tenant" }, /at tenant: .*VITE_MSAL_TENANT/],
    [{ message: "AADSTS50011: The redirect URI specified in the request does not match" }, /at app registration: .*redirect URI/],
    [{ message: "AADSTS7000218: The request body must contain the following parameter: 'client_assertion'" }, /at app registration: .*Single-page application/],
    [{ errorCode: "interaction_required", errorMessage: "AADSTS50076: Due to a configuration change made by your administrator" }, /at sign-in: .*fresh interactive sign-in/],
    [{ errorCode: "popup_window_error" }, /at popup: .*allow popups/],
    [{ errorCode: "user_cancelled" }, /at popup: .*closed before it finished/],
    [new TypeError("Failed to fetch"), /at network/],
  ];
  for (const [err, re] of cases) assert.match(describeMsalError(err), re, JSON.stringify(err));
});

test("the silent-acquire error is consulted when the popup fails generically; an unknown error is passed through verbatim with the report instruction", () => {
  assert.match(describeMsalError({ errorCode: "popup_window_error" }, { errorCode: "interaction_required", errorMessage: "AADSTS50079: MFA required" }), /at popup/, "the popup failure is what the user saw last");
  assert.match(describeMsalError({ message: "something new" }, { errorCode: "consent_required" }), /at consent/, "but a generic popup message defers to the silent error's code");
  assert.equal(describeMsalError({ message: "  odd   thing  " }), "Microsoft 365 sign-in failed: odd thing — report this text verbatim on issue #315.");
  assert.equal(describeMsalError(undefined), "Microsoft 365 sign-in failed: unknown error — report this text verbatim on issue #315.");
});
