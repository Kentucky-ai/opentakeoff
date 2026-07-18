// Lint gate — part of `npm run check` (CI parity). Exists first and foremost
// for no-undef: tsc runs with checkJs off, so the .jsx/.js app code gets no
// static checking without it (a refactor once deleted a declaration and left
// nine live reads — ReferenceError crashed production tracing; fixed in PR #24).
// The .ts tests are excluded here: tsc --noEmit already checks them strictly.
import js from "@eslint/js";
import globals from "globals";
import reactHooks from "eslint-plugin-react-hooks";

export default [
  { ignores: ["dist/", "node_modules/", "public/"] },
  {
    files: ["src/**/*.{js,jsx}"],
    ...js.configs.recommended,
  },
  // Netlify functions (Node runtime) — lint them too, above all for no-undef:
  // these .mjs files get NO tsc/vite checking and their handler isn't unit-tested
  // (tests import only the pure helpers), so a stray reference reaches production
  // as a runtime ReferenceError → 502. Exactly what shipped when ALLOWED_HD was
  // renamed to ALLOWED_HDS but one handler call site kept the old name.
  {
    files: ["netlify/functions/**/*.mjs"],
    ...js.configs.recommended,
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: "module",
      globals: { ...globals.node, fetch: "readonly" },
    },
    rules: {
      "no-unused-vars": ["error", { varsIgnorePattern: "^[A-Z_]", argsIgnorePattern: "^_", ignoreRestSiblings: true }],
    },
  },
  {
    files: ["src/**/*.{js,jsx}"],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: "module",
      parserOptions: { ecmaFeatures: { jsx: true } },
      // __APP_VERSION__ is a build-time define (vite.config.js) — a real global
      // in the bundle, absent under Node (use sites carry a typeof guard).
      globals: { ...globals.browser, __APP_VERSION__: "readonly" },
    },
    plugins: { "react-hooks": reactHooks },
    rules: {
      // JSX component references otherwise read as unused; rest-sibling
      // destructuring is the codebase's omit-keys idiom.
      "no-unused-vars": ["error", { varsIgnorePattern: "^[A-Z_]", argsIgnorePattern: "^_", ignoreRestSiblings: true }],
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "warn",
    },
  },
];
