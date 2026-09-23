import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import eslintConfigPrettier from 'eslint-config-prettier';

// the object a logger is called with, and the field inside it that would carry an error
const LOG_ERROR_FIELD =
  "CallExpression[callee.property.name=/^(fatal|error|warn|info|debug|trace)$/] > ObjectExpression:first-child > :matches(Property[key.name=/^(err|error|cause|exception)$/], Property[key.value=/^(err|error|cause|exception)$/])";

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
          // What it does not see, all deliberate: a nested object (`{ ctx: { err } }`), an object
          // passed as the second argument, a computed key, `logger[level](error)`, a logger
          // reached through a variable, a spread. It also flags a cast around the helper
          // (`{ err: errorIdentity(e) as T }`), which fails safe. The rule narrows the class of
          // mistake; it does not close it. It runs only under apps/**/src and packages/**/src,
          // and not on **/*.test.ts.
          selector: `${LOG_ERROR_FIELD}:matches([value.type!='CallExpression'], [value.type='CallExpression'][value.callee.name!='errorIdentity'][value.callee.name!='errorLogFields'])`,
          message:
            'log errors through errorIdentity() or errorLogFields(): a whole error carries its message, stack and its own fields, and no redact path can scrub a string',
        },
        {
          // pino's own error-first form, which the property rule cannot see. Matched by the
          // argument's name rather than its type, because the type alone also catches
          // `logger.info(messageVar)` and `console.error(msg)`, which are not errors.
          //
          // The trade runs both ways and neither side is free: an error held in a variable named
          // something else (`problem`, `thrown`) is missed, and a string in a variable named like
          // an error would be flagged. `reason` is deliberately absent from the list — in this
          // repository that name holds a revocation reason, which is a string. `new Error(x)`
          // passed positionally is not matched either.
          selector:
            "CallExpression[callee.object.name!='console'][callee.property.name=/^(fatal|error|warn|info|debug|trace)$/]:matches([arguments.0.type='Identifier'][arguments.0.name=/^(e|err|error|ex|exception|cause|failure)$/i], [arguments.0.type='MemberExpression'][arguments.0.property.name=/^(e|err|error|ex|exception|cause|failure)$/i])",
          message:
            'do not log an error positionally: pass errorIdentity() or errorLogFields() in the log object instead',
        },
      ],
    },
  },
);
