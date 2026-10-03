import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import eslintConfigPrettier from 'eslint-config-prettier';
import noStatusLiteral from './tooling/eslint-rules/no-status-literal.ts';
import { LOG_ERROR_KEYS } from './packages/shared/src/logging.ts';

// a variable named like an error, in the position pino would serialize whole
const ERROR_LIKE_NAME = '(e|err|error|ex|exception|cause|failure)';

// the object a logger is called with, and the field inside it that would carry an error: the
// same keys the loggers' serializers guard (LOG_ERROR_KEYS)
const ERROR_KEYS = LOG_ERROR_KEYS.join('|');
const LOG_ERROR_FIELD = `CallExpression[callee.property.name=/^(fatal|error|warn|info|debug|trace)$/] > ObjectExpression:first-child > :matches(Property[key.name=/^(${ERROR_KEYS})$/], Property[key.value=/^(${ERROR_KEYS})$/])`;

// The logging rule's two selectors. Hoisted because a later config block that sets
// no-restricted-syntax replaces this option list for the files it matches rather than adding to
// it, so the Telegram block below has to carry them again.
const LOG_ERROR_RULES = [
  {
    // Scoped to the object a logger is called with. A global match would fail on the
    // `error` and `cause` fields legitimate objects carry — zod options, an ErrorOptions
    // cause, the publisher's outcome, an API response body.
    //
    // What it does not see, all deliberate: a nested object (`{ ctx: { err } }`), an object
    // passed as the second argument, a computed key, `logger[level](error)`, a logger
    // method held in a variable, a spread. A logger reached through a variable IS seen
    // (`const l = request.log; l.error({ err })`). It also flags a cast around the helper
    // (`{ err: errorIdentity(e) as T }`), which fails safe. The rule narrows the class of
    // mistake; it does not close it. Since #85 the loggers' own serializers reduce whatever
    // reaches these keys at the top level to the same whitelist; they share the nested-object
    // blind spot, and neither sees an error interpolated into the message (`%s`, `%o`).
    selector: `${LOG_ERROR_FIELD}:matches([value.type!='CallExpression'], [value.type='CallExpression'][value.callee.name!='errorIdentity'][value.callee.name!='errorLogFields'])`,
    message:
      'log errors through errorIdentity() or errorLogFields(): a whole error carries its message, stack and its own fields, and no redact path can scrub a string',
  },
  {
    // pino's own error-first form, which the property rule cannot see. Matched by the
    // argument's name rather than its type, because the type alone also catches
    // `logger.info(messageVar)`, which is not an error.
    //
    // The trade runs both ways and neither side is free: an error held in a variable named
    // something else (`problem`, `thrown`) is missed, and a string in a variable named like
    // an error would be flagged. `reason` is deliberately absent from the list — in this
    // repository that name holds a revocation reason, which is a string. Also missed:
    // `new Error(x)` passed positionally, and `logger[level](error)`.
    selector: `CallExpression[callee.property.name=/^(fatal|error|warn|info|debug|trace)$/]:matches([arguments.0.type='Identifier'][arguments.0.name=/^${ERROR_LIKE_NAME}$/i], [arguments.0.type='MemberExpression'][arguments.0.property.name=/^${ERROR_LIKE_NAME}$/i])`,
    message:
      'do not log an error positionally: pass errorIdentity() or errorLogFields() in the log object instead',
  },
];

// grammY's methods that send text Telegram parses (parse_mode) to a user. Matched by the method's
// exact name on any object, so `ctx.reply`, `ctx.api.sendMessage` and `bot.api.raw.sendMessage`
// are all seen; a method held in a variable or reached by a computed key is not — the same class
// of gap as the logging rule. Derived on 2026-10-02 for @grammyjs/types 5.0.0 and grammy 1.46.0;
// after an upgrade of either, re-run from the repository root and compare (step 1 writes api.txt
// to the current directory, delete it afterwards):
//   T=node_modules/.pnpm/@grammyjs+types@5.0.0/node_modules/@grammyjs/types
//   D=node_modules/.pnpm/grammy@1.46.0/node_modules/grammy/out
//   # 1. Bot API methods whose args carry parse_mode or a type that does
//   awk '/^    [a-zA-Z]+\(args/ { match($0, /[a-zA-Z]+\(args/); name = substr($0, RSTART, RLENGTH-5) } /^    [a-z]/ && !/\(args/ { name = "" } name != "" && /parse_mode|InputMedia|InputPaidMedia|InputChecklist|InlineQueryResult/ { print name }' "$T/methods.d.ts" | sort -u > api.txt
//   # 2. every grammY method that forwards to one of them under another name
//   grep -hoE '^    [a-zA-Z]+\([^;]*Other<(R, )?"[a-zA-Z]+"' "$D/context.d.ts" "$D/core/api.d.ts" | sed -E 's/^    ([a-zA-Z]+)\(.*Other<(R, )?"([a-zA-Z]+)".*/\1 \3/' | sort -u | awk 'NR==FNR { api[$1]=1; next } ($2 in api) && $1 != $2 { print $1 " -> " $2 }' api.txt -
// Left out on purpose: answerCallbackQuery (its text is shown unparsed); sendRichMessage,
// sendRichMessageDraft and their replyWith* aliases (structured RichText, no parsed string);
// methods whose fields are all plain (sendInvoice, sendVenue, sendContact, setMy*, setChat*).
const RAW_TELEGRAM_SEND_METHODS = [
  // step 1: the Bot API methods
  'answerGuestQuery',
  'answerInlineQuery',
  'answerWebAppQuery',
  'copyMessage',
  'editEphemeralMessageCaption',
  'editEphemeralMessageMedia',
  'editEphemeralMessageText',
  'editMessageCaption',
  'editMessageChecklist',
  'editMessageMedia',
  'editMessageText',
  'editStory',
  'giftPremiumSubscription',
  'postStory',
  'savePreparedInlineMessage',
  'sendAnimation',
  'sendAudio',
  'sendChecklist',
  'sendDocument',
  'sendGift',
  'sendLivePhoto',
  'sendMediaGroup',
  'sendMessage',
  'sendMessageDraft',
  'sendPaidMedia',
  'sendPhoto',
  'sendPoll',
  'sendVideo',
  'sendVoice',
  // step 2: grammY's aliases of them
  'editMessageCaptionInline',
  'editMessageMediaInline',
  'editMessageTextInline',
  'reply',
  'replyWithAnimation',
  'replyWithAudio',
  'replyWithChecklist',
  'replyWithDocument',
  'replyWithDraft',
  'replyWithGift',
  'replyWithGiftToChannel',
  'replyWithLivePhoto',
  'replyWithMediaGroup',
  'replyWithPaidMedia',
  'replyWithPhoto',
  'replyWithPoll',
  'replyWithVideo',
  'replyWithVoice',
  'sendGiftToChannel',
];

const RAW_TELEGRAM_SEND = {
  selector: `CallExpression[callee.property.name=/^(${RAW_TELEGRAM_SEND_METHODS.join('|')})$/]`,
  message:
    'send user texts through replyHtml/replyWithVideoHtml/replyWithPhotoHtml/editMessageTextHtml (apps/bot/src/send.ts) or the link notifier: they take TelegramHtml and set parse_mode HTML, so nothing unescaped reaches the user as markup',
};

export default tseslint.config(
  {
    // .claude/worktrees/ holds other agents' checkouts of this repository: their unfinished code
    // would fail this lint, and one removed mid-run fails it with ENOENT
    ignores: ['**/dist/**', '**/node_modules/**', '.claude/worktrees/**'],
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
    // typed: no-status-literal reads contextual types and the status constants from the program
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    plugins: { local: { rules: { 'no-status-literal': noStatusLiteral } } },
    rules: {
      // tests stay out of this block on purpose: they must be able to spell a raw value to
      // prove the CHECK constraint rejects or accepts it
      'local/no-status-literal': 'error',
      'no-restricted-syntax': ['error', ...LOG_ERROR_RULES],
    },
  },
  {
    // Telegram user texts (#198): the user bot and the backend's push send only TelegramHtml, and
    // only through their seams. The staff bot (apps/backend/src/admin) stays plain text by the
    // owner's decision of 2026-10-02 and is outside this block. The seam files are ignored here,
    // so they fall back to the block above and keep the logging rule.
    files: ['apps/bot/src/**/*.ts', 'apps/backend/src/auth/**/*.ts'],
    ignores: ['**/*.test.ts', 'apps/bot/src/send.ts', 'apps/backend/src/auth/link-notifier.ts'],
    rules: {
      'no-restricted-syntax': ['error', ...LOG_ERROR_RULES, RAW_TELEGRAM_SEND],
    },
  },
);
