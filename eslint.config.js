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
          // Scoped to the object a logger is called with. A global match would fail on the
          // `error` and `cause` fields legitimate objects carry — zod options, an ErrorOptions
          // cause, the publisher's outcome, an API response body.
          //
          // Known and deliberate gaps: a computed key, `logger[level](error)`, a logger reached
          // through a variable, a cast, a spread. The rule narrows the class of mistake, it does
          // not close it.
          selector:
            "CallExpression[callee.property.name=/^(fatal|error|warn|info|debug|trace)$/] > ObjectExpression:first-child > :matches(Property[key.name=/^(err|error|cause|exception)$/], Property[key.value=/^(err|error|cause|exception)$/])[value.type!='CallExpression'], " +
            "CallExpression[callee.property.name=/^(fatal|error|warn|info|debug|trace)$/] > ObjectExpression:first-child > :matches(Property[key.name=/^(err|error|cause|exception)$/], Property[key.value=/^(err|error|cause|exception)$/])[value.type='CallExpression'][value.callee.name!='errorIdentity'][value.callee.name!='errorLogFields']",
          message:
            'log errors through errorIdentity() or errorLogFields(): a whole error carries its message, stack and its own fields, and no redact path can scrub a string',
        },
        {
          // pino's own error-first form, which the property rule cannot see
          selector:
            "CallExpression[callee.property.name=/^(fatal|error|warn|info|debug|trace)$/][arguments.0.type='Identifier']",
          message:
            'do not log an error positionally: pass errorIdentity() or errorLogFields() in the log object instead',
        },
      ],
    },
  },
);
