// Account chip — the two-deck toolbar's home for "who am I" (issue #61).
// Renders NOTHING unless the user is signed in: no UI when cloud mode is off,
// and no "Sign in" button when signed out (sign-in is initiated only from the
// explicit landing link / deep-link walls). When signed in it's an initials
// disc + menu (email, sync note, Sign out). The gallery header uses AuthChip.
import React from "react";
import { useGoogleAuth } from "../lib/google/AuthContext.jsx";
import ToolMenu from "./ToolMenu.jsx";

const initialsOf = (user) => {
  const src = String(user?.name || user?.email || "").trim();
  const parts = src.split(/[\s._@-]+/).filter(Boolean);
  if (!parts.length) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[1][0]).toUpperCase();
};

export default function AccountChip({ note, onOpenChange }) {
  const { user, signOut } = useGoogleAuth();
  // Nothing in the toolbar when signed out (or cloud mode off) — the local-first
  // app keeps its pre-Drive look and never shows a "Sign in" button here. Sign-in
  // starts only from the explicit "Sign in with Google Drive" landing link
  // (PlanNavigator) or the deep-link sign-in walls (main.jsx).
  if (!user) return null;

  return (
    <ToolMenu
      title={`Account — ${user.email}`}
      onOpenChange={onOpenChange}
      faceStyle={{ padding: "4px 8px 4px 4px" }}
      menuStyle={{ minWidth: 224 }}
      face={
        <span aria-label="Account" style={{
          width: 20, height: 20, background: "var(--cobalt)", color: "var(--paper-bright)",
          fontFamily: "var(--f-mono)", fontSize: 9, fontWeight: 700,
          display: "inline-flex", alignItems: "center", justifyContent: "center",
        }}>{initialsOf(user)}</span>
      }
      items={[
        { section: "Signed in" },
        { note: <>{user.email}{note ? <><br />{note}</> : null}</> },
        "divider",
        { id: "signout", label: "Sign out", danger: true, title: "Sign out", onSelect: () => signOut() },
      ]}
    />
  );
}
