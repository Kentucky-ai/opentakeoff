// React binding for the optional Google cloud mode (see auth.js).
//
// Wraps the module-level auth state in a context so the app can render a
// sign-in button and gate cloud features off `user`. When the build isn't
// configured for Google (`configured: false`), the provider settles `ready`
// immediately and everything downstream stays in anonymous local mode.
import React, { createContext, useContext, useEffect, useState } from "react";
import {
  isGoogleConfigured,
  onAuthChange,
  preloadGoogle,
  getUser,
  signIn as authSignIn,
  signOut as authSignOut,
} from "./auth.js";

const GoogleAuthContext = createContext(null);

export function GoogleAuthProvider({ children }) {
  const configured = isGoogleConfigured();
  const [user, setUser] = useState(getUser());
  // Not configured -> nothing to load, we're ready at once.
  const [ready, setReady] = useState(!configured);

  useEffect(() => {
    if (!configured) return;
    // Keep local state in lock-step with the auth module (sign-in/out fire here).
    const unsub = onAuthChange(setUser);
    // Warm the GIS script ONLY — inject the <script> so the first sign-in click
    // is instant. We deliberately do NOT request a token here: the GIS token
    // model has no truly silent path (every requestAccessToken() opens a popup
    // and expects a user gesture — see auth.js and Google's own docs), so any
    // automatic attempt on mount would pop the OAuth window on every page load.
    // Nothing touches Google credentials until the user explicitly clicks
    // "Sign in with Google Drive." Preloading the script alone never prompts.
    let live = true;
    preloadGoogle().finally(() => { if (live) setReady(true); });
    return () => { live = false; unsub(); };
  }, [configured]);

  const value = {
    user,
    ready,
    configured,
    signIn: authSignIn,
    signOut: authSignOut,
  };

  return (
    <GoogleAuthContext.Provider value={value}>
      {children}
    </GoogleAuthContext.Provider>
  );
}

export function useGoogleAuth() {
  const ctx = useContext(GoogleAuthContext);
  if (!ctx) throw new Error("useGoogleAuth must be used within a GoogleAuthProvider.");
  return ctx;
}
