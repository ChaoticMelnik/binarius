import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import eslintConfigPrettier from 'eslint-config-prettier';

export default tseslint.config(
  {
    ignores: ['**/dist/**', '**/node_modules/**'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  eslintConfigPrettier,
  {
    // An error object logged whole takes its message, its stack and its cause with it, and no
    // pino redact path can scrub a string: that is how bound SQL parameters and a broker
    // response reached the logs twice during #9. `errorIdentity`/`errorLogFields` are the two
    // shapes that stay safe, so the rule asks for one of them rather than for care.
    files: ['apps/**/src/**/*.ts', 'packages/**/src/**/*.ts'],
    ignores: ['**/*.test.ts'],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector:
            "Property[key.name='err'][value.type!='CallExpression'], " +
            "Property[key.name='err'][value.type='CallExpression'][value.callee.name!='errorIdentity'][value.callee.name!='errorLogFields']",
          message:
            'log errors through errorIdentity() or errorLogFields(): a whole error carries its message, stack and cause, which no redact path can scrub',
        },
      ],
    },
  },
);
