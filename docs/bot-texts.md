# Bot texts catalog (#240)

Every text the client bot shows — messages, button labels, the command descriptions and the
bot's profile — is written once, in `packages/shared/src/bot-texts.ts` (`BOT_TEXT_CATALOG`).
The bot and the backend's push after an OAuth login both render from it. The texts quoted in this
repository's other docs and comments are the catalog's defaults.

The catalog is part 1 of #240. Overrides stored in the database and a writer for them (#299), the
admin section that edits them (#300), and republishing the commands and the profile (#301) come
next. Until then the defaults are the only source.

Not in the catalog: the staff bot (`apps/backend/src/admin`, plain text by the owner's decision of
2026-10-02) and the Mini App pages (`apps/web/src/oauth/texts.ts`).

## Files

- `packages/shared/src/bot-texts.ts` — `BOT_TEXT_CATALOG`, the groups (`BotTextGroup`,
  `BOT_TEXT_GROUP_TITLES`), the key types (`BotTextKey`, `BotHtmlKey`, `BotPlainKey`,
  `BotStaticHtmlKey`), `botTextKeysOf(...groups)`, `defaultBotTextSource`, `botTextProblems` and
  `createBotTexts`.
- `packages/shared/src/bot-text-template.ts` — the entry shape and its two helpers
  (`botHtmlText`, `botPlainText`), the grammar (`parseBotTextTemplate`), the validator
  (`botTextEntryProblems`, `BotTextProblemCode`) and the views (`createBotTextViews`). It is
  generic over the catalog, so its tests run on a small one of their own.
- `packages/shared/src/telegram-html.ts` — `telegramHtmlTemplate`, the constructor the views use
  ([Safety](#safety)).
- `apps/bot/src/texts.ts` — the bot's view: `TEXTS`, `LABELS`, `PROFILE`, the label maps,
  `setBotTextSource`, `textOf`.
- `apps/backend/src/auth/texts.ts` — the backend's view: `CLIENT_TEXTS`, `CLIENT_LABELS`,
  `setBotTextSource`.

## An entry

`html(group, description, source, options)` or `plain(...)` in the catalog, with:

- **kind** — `html`, a message part sent as Telegram HTML, or `plain`: a label, a word put into
  a message, a command description or the profile. Telegram never parses a plain text, so it is
  never escaped.
- **group** — the screen or scenario the admin section lists it under: `start`, `card`,
  `account`, `menu`, `settings`, `support`, `help`, `demo`, `analysis`, `trade`, `buttons`,
  `commands`, `profile`. `buttons` is exactly the bot's `LABELS` buttons plus
  `confirmButtonNoEmail`, `commands` the `*Command` descriptions; a label shown on one screen
  only (the levels, the asset types, the durations, the directions) sits in that screen's group.
  `bot-texts.test.ts` pins both lists.
- **description** — where the text is shown, in Russian, at most 200 characters.
- **source** — the default template.
- **arg** — at most one value the caller passes, with a sample for the validator (`{ name,
  sample }`; the type requires the sample).
- **fragments** — placeholder → key: another entry's text put in place of the placeholder.
- **limit** and **singleLine** ([Limits](#limits)).

A **key** is a permanent id, `^[a-z][a-zA-Z0-9]{0,63}$`. Overrides will be stored under it, so
renaming a key once #299 has shipped is a data migration.

## The template

- `{name}`, with `name` matching `[a-z][a-zA-Z0-9]*`, is a placeholder. Any other `{` or `}` is a
  stray brace and an error; there is no escape, and no default needs a literal brace.
- The **argument** must appear in the template, and may appear more than once.
- A **fragment** placeholder is optional: a template may leave it out. A fragment's key has no
  fragments and no argument of its own — one level deep, so no cycle — and a plain template takes
  only plain fragments. In an html template an html fragment is nested as Telegram HTML, a plain
  one is escaped. Fragments carry the feature lines into the card and `/help`, the level labels
  into the `/settings` legend, the directions into the signal headline, and the button labels a
  message quotes («Нажми «{connectButton}»»), so renaming a button cannot leave a stale quote.
- In an html template a placeholder stands where text goes, never inside a tag: not in a tag's
  name, an attribute or its value.

## The validator

`botTextProblems(key, source, lookup = defaultBotTextSource)` returns problems as codes with an
optional detail; part 2 and part 3 turn them into Russian messages. Fragments are rendered from
`lookup`'s current texts.

| Code | When |
|---|---|
| `empty` | the source is blank, or nothing is left of it after entities parsing |
| `stray_brace` | a `{` or `}` outside a placeholder |
| `unknown_placeholder` | a name that is neither the argument nor a fragment (detail: the name) |
| `missing_placeholder` | the argument does not appear (detail: its name) |
| `placeholder_in_tag` | html: a placeholder inside a tag (detail: the name) |
| `invalid_html` | html: `telegramHtmlProblems` refuses the text (detail: its first problem) |
| `too_long` | the text with the sample is over the entry's limit (detail: the length) |
| `padded_line` | a line of the text starts or ends with a space |
| `multiline` | a single-line entry holds LF, CR, U+2028 or U+2029 |

A stray brace or an unknown placeholder stops the check: nothing can be rendered. Lengths are
counted as the Bot API counts them: on `plainTextOf(...)` for html, on the string for plain, in
UTF-16 code units. `bot-texts.test.ts` runs the validator over every default.

## Safety

**Why a saved text cannot break on a value.** The validator renders an html template twice: with
the sample, and with `·` (U+00B7) in place of the argument. To find a placeholder inside a tag it
renders a third time with a letter in every placeholder, which keeps a tag that holds one a tag
(`<blockquote e{v}pandable>`). An escaped value in text position holds no `<`, `>`, `"` and no
bare `&`, so it can change how the text parses only by completing a partial entity of the static
text right before it (`&am{v};`, `&#{v}1;`); `·` leaves such an entity a bare `&`, which is
refused. A template valid with `·` and with no placeholder inside a tag is therefore valid with any
escaped value, the empty one included.

**Every rendered text is checked again.** The views build html through `telegramHtmlTemplate`,
which renders the holes as `telegramHtml` does — strings escaped, `TelegramHtml` nested — and runs
`telegramHtmlProblems` over the assembled text on every call, throwing `InvalidTelegramTemplate`
(its `name` only, no text) when Telegram would refuse it. That catches what a check of the static
parts cannot see, such as a `TelegramHtml` argument that puts an `<a>` inside an `<a>`. The callers
do not catch it: in part 1 it would mean a catalog default that the tests let through. A source
whose text does not parse against its key throws `InvalidBotText`, also by name only.

**One importer.** ESLint (`eslint.config.js`, the `telegramHtmlTemplate` block) refuses
`telegramHtmlTemplate` in a named import, a namespace import or an `export *` of
`telegram-html` or `@binarius/shared` in every `apps/*/src` and `packages/*/src` file but
`bot-text-template.ts` and the root barrel `packages/shared/src/index.ts`. Tests are outside the
block, and a dynamic `import()` is not caught; the check on every call holds either way.

## Limits

- html: 4096 (`TELEGRAM_MESSAGE_LIMIT`); 1024 (`TELEGRAM_CAPTION_LIMIT`) for the parts of a
  caption — `welcome` (the video's), the account card's `card*` and `featureLines`, the status
  card's `status*`.
- The command descriptions 256, `profileDescription` 512, `profileShortDescription` 120: the Bot
  API's limits.
- Every other plain entry: `BOT_LABEL_LIMIT` (64) and one line. This is the project's limit, not
  the Bot API's, which publishes none for an inline button's text: it keeps a button readable and
  is well above the longest default.

An entry's limit bounds that entry, not a message assembled from several (the card, the status
card, `/account`, `/help`, the analysis screen). Those are checked by the bot's tests at their
widest holes. The writer of overrides (#299) has to refuse a set of texts that overflows an
assembled message.

## Reading the texts

`createBotTexts(source)` returns `{ html, plain }`: one getter per key, reading
`source.sourceOf(key)` on every access. A static html key gives `TelegramHtml`, an html key with
an argument `(value: string | TelegramHtml) => TelegramHtml`; plain keys give `string` and
`(value: string) => string`. The types follow each entry's kind and argument
(`bot-texts.typecheck.ts` is the oracle). A getter returns the same object or function while the
key's text and its fragments' texts are unchanged — the suites compare texts with `toBe` — and
renders again as soon as any of them changes.

The bot's `texts.ts` and the backend's `auth/texts.ts` each hold a source, the catalog's defaults
until `setBotTextSource` replaces it (#299 does that at startup), and build their views over it.
The bot's views keep the names and signatures they had before the catalog: `TEXTS` is every html
key but `cardGreetingNoName`, `featureLines` and `oauthLoginFailed`, with `cardGreeting` trimming
the name and falling back to `cardGreetingNoName`, and `accountLine*` taking `null` for an unknown
address; `LABELS` is the `buttons` and `commands` groups but `confirmButtonNoEmail`, with
`confirmButton(email | null)`. Both bot and backend label the confirm button through
`confirmButtonLabel` (`link-confirmation.ts`).

**Nothing is read at load.** Every text is looked up when a message is built, so a swapped source
reaches every message: `/help` is assembled per request, and the maps that used to hold texts —
the refusals in `bot.ts` and `demo-trade.ts`, the intent status lines, the signal headlines —
now hold keys (`textOf(key)`), while the label maps (`ACTION_LABELS`, `DEMO_GROUP_LABELS`,
`DEMO_DURATION_LABELS`, the analysis words) are getters over keys (`labelsOf`). The one exception
is `BOT_COMMANDS` in `apps/bot/src/commands.ts`, built at load until #301 republishes the commands.
The tests of the source swap hold one place each (`bot.test.ts`, `demo-trade.test.ts`,
`texts.test.ts`, `analysis.test.ts`, `link-notifier.test.ts`).

## What stays in code

Data and identifiers, not texts (decision on the issue's plan, approved by the owner):

- the command names `/start`, `/menu`, `/account`, `/settings`, `/help`, `/support` — the bot
  routes by them; only their descriptions are entries;
- `MODE_LABELS` (DEMO/REAL);
- `pairButtonLabel` («symbol · payout%») and `groupButtonLabel`'s ` · N`;
- the ` ✅` after the selected level (`currentLevelLabel`);
- the fallback duration `⏱ N с` (`durationLabelOf`), `formatAge`'s `с`/`мин`, `formatUsd`'s `$`
  and digit grouping;
- «N из M» on the demo's page line, the ` · ` of the trade line and `analysisSubject`, the
  indicator names `EMA`/`RSI`/`ATR` and the ` — ` of the analysis lines;
- the `/command — description` line of `/help`.

## Adding a text

1. Add an entry to `BOT_TEXT_CATALOG` in the group of the screen that shows it, with a Russian
   description; give it an argument with a sample if the caller passes a value, and fragments for
   any other entry it quotes.
2. Read it in the bot through `TEXTS`/`LABELS` (or `textOf`/`labelsOf` for a map), never into a
   module constant.
3. `pnpm check`: `bot-texts.test.ts` validates the default, and the facade tests in `texts.test.ts`
   name the keys `TEXTS` and `LABELS` hold — a new html entry joins `TEXTS`, a new button needs the
   lists in `bot-texts.test.ts` and `texts.test.ts`.
