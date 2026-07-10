// Toolbar account chip for the optional Google cloud mode.
//
// Renders NOTHING when the build isn't configured for Google, AND nothing when
// configured-but-signed-out — so the local-first app looks exactly as it did
// before Drive existed, with no "Sign in" button competing in the toolbar.
// Signing in is initiated ONLY from the explicit "Sign in with Google Drive"
// link on the landing screen (see SheetGallery) or the deep-link sign-in walls
// (main.jsx). Once signed in, this shows the user's email + a sign-out
// affordance. All the trust lives in the Internal OAuth app + Drive sharing
// (see lib/google/auth.js); this is just the surface.
import React from "react";
import { useGoogleAuth } from "../lib/google/AuthContext.jsx";

export default function AuthChip() {
  const { user, signOut } = useGoogleAuth();
  if (!user) return null;   // signed out (or cloud mode off) → no toolbar UI

  const base = {
    display: "inline-flex", alignItems: "center", gap: 6, padding: "6px 10px",
    border: "1px solid var(--ink-faint)", background: "transparent",
    color: "var(--ink)", cursor: "pointer", fontSize: 12.5, lineHeight: 1,
  };

  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
      <span title={user.email} style={{ fontSize: 12, color: "var(--ink-muted)", maxWidth: 200, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
        {user.email}
      </span>
      <button type="button" onClick={() => signOut()} title="Sign out"
        style={{ ...base, padding: "5px 8px", color: "var(--ink-muted)" }}>
        Sign out
      </button>
    </span>
  );
}
