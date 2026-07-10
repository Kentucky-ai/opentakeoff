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
  trySilentSignIn,
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
    // Warm the GIS script so the first sign-in click is instant, then try to
    // restore the session with no visible prompt — a returning user with a
    // live Google session and a prior consent grant is signed back in before
    // SignInScreen ever renders, instead of having to click through the full
    // consent screen again. Failure (preload or silent sign-in) isn't fatal;
    // either way we still mark ready and fall back to the interactive button.
    let live = true;
    preloadGoogle()
      .then(() => trySilentSignIn())
      .finally(() => { if (live) setReady(true); });
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
