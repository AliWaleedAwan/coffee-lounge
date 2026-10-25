import js from '@eslint/js';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/coverage/**',
      'docs/prototypes/**',
      'apps/web/test-results/**',
      'apps/web/playwright-report/**',
    ],
  },
  js.configs.recommended,
  {
    files: ['**/*.ts', '**/*.tsx'],
    extends: [tseslint.configs.strictTypeChecked],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // Money and stock code must never compare loosely or float silently.
      eqeqeq: ['error', 'always'],
      // Fastify handlers and plugins are async by contract even when they do not await.
      '@typescript-eslint/require-await': 'off',
      '@typescript-eslint/restrict-template-expressions': ['error', { allowNumber: true }],
    },
  },
  {
    files: ['apps/web/src/**/*.tsx', 'apps/web/src/**/*.ts'],
    extends: [reactHooks.configs.flat['recommended-latest']],
  },
  {
    files: ['**/*.js', '**/*.mjs', '**/*.cjs'],
    languageOptions: { globals: { ...globals.node } },
  },
  {
    files: ['**/*.cjs'],
    languageOptions: { sourceType: 'commonjs' },
  },
  {
    // The counter app's local pages run in a browser context, not Node.
    files: ['apps/desktop/static/*.js'],
    languageOptions: { sourceType: 'script', globals: { ...globals.browser } },
  },
);
