// @ts-check
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/build/**',
      '**/coverage/**',
      'openapi/openapi.json',
      'sdk/src/generated/**',
      'db/supabase/.branches/**',
      'db/supabase/.temp/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/consistent-type-imports': 'error',
      'no-console': ['warn', { allow: ['warn', 'error', 'info'] }],
    },
  },
  // Envelope quarantine: every OpenAPIHono instance must come from the
  // newApiApp() factory (api/src/routes/_lib/app.ts) so the validation
  // defaultHook -- which does NOT inherit across .route() mounts -- is wired
  // on every sub-app. A bare `new OpenAPIHono()` answers validation failures
  // in zod-openapi's default shape instead of the project envelope.
  {
    files: ['api/src/**/*.ts'],
    ignores: ['api/src/routes/_lib/app.ts'],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector: "NewExpression[callee.name='OpenAPIHono']",
          message:
            'Construct apps via newApiApp() from routes/_lib/app.ts so the validation-envelope defaultHook is always wired.',
        },
      ],
    },
  },
  // Admin quarantine: the privileged Supabase client (constructed only in
  // api/src/admin/supabase-admin.ts) must not be imported outside src/admin/.
  // The grep-based lint catches the env var; this catches the wrapper module.
  // User-facing routes can still import other admin modules (e.g. an admin
  // function that signs up a user) -- just not the client itself.
  {
    files: ['api/src/**/*.ts'],
    ignores: ['api/src/admin/**'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: [
                '**/admin/supabase-admin',
                '**/admin/supabase-admin.js',
                '**/admin/supabase-admin.ts',
              ],
              message:
                'The privileged Supabase admin client is quarantined to src/admin/. Wrap your call in an admin function (e.g. createAccountForNewUser in src/admin/signup.ts) and import THAT instead, never the client.',
            },
          ],
        },
      ],
    },
  },
  prettier,
);
