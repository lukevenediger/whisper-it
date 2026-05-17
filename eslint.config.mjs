import tsParser from "@typescript-eslint/parser";
import tsPlugin from "@typescript-eslint/eslint-plugin";
import prettier from "eslint-config-prettier";

export default [
  {
    ignores: [
      "dist/**",
      "node_modules/**",
      "tests/fixtures/audio/**",
      "playwright-report/**",
      "coverage/**",
      "src/public/**",
    ],
  },
  {
    files: ["**/*.ts"],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        ecmaVersion: 2022,
        sourceType: "module",
      },
    },
    plugins: { "@typescript-eslint": tsPlugin },
    rules: {
      ...tsPlugin.configs.recommended.rules,
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-unused-vars": [
        "warn",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      "no-console": "off",
    },
  },
  prettier,
];
