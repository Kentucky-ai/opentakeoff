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
  {
    files: ["src/**/*.{js,jsx}"],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: "module",
      parserOptions: { ecmaFeatures: { jsx: true } },
      globals: { ...globals.browser },
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
