// The VITE_* build variables as Vite itself will see them: the process
// environment plus any .env files in web/. Build-time scripts read flags
// such as VITE_OCR through this, so a flag set in .env.local means the same
// thing to the script as to the build. Falls back to the process environment
// if Vite isn't installed.
//
// `mode` picks the .env.[mode] files, as Vite's --mode does. It defaults to
// "production", the mode `vite build` uses, because these scripts stage and
// check what a build ships; NODE_ENV is not consulted. A script serving the
// dev server would pass "development".
export async function loadEnvVars(webDir, mode = "production") {
  try {
    const { loadEnv } = await import("vite");
    return { ...loadEnv(mode, webDir, "VITE_"), ...pickVite(process.env) };
  } catch {
    return pickVite(process.env);
  }
}

const pickVite = (env) => Object.fromEntries(Object.entries(env).filter(([k]) => k.startsWith("VITE_")));
