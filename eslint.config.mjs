// ESLint flat config. Lint runs with --max-warnings 0 (AGENTS.md "Lint has no warning tier").
// Generated output is never linted: see globalIgnores below and AGENTS.md "Build output is never a gate target".
import js from "@eslint/js";
import tseslint from "typescript-eslint";
import { globalIgnores } from "eslint/config";

export default tseslint.config(
  globalIgnores(["node_modules/", ".wrangler/", "coverage/", "dist/", ".scratch/"]),
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["**/*.ts"],
    languageOptions: {
      parserOptions: { project: ["./tsconfig.json", "./tsconfig.tools.json"], tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      "@typescript-eslint/no-floating-promises": "error",
    },
  },
);
