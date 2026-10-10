# Bot texts catalog (#240)

Every text the client bot shows — messages, button labels, the command descriptions and the
bot's profile — is written once, in `packages/shared/src/bot-texts.ts` (`BOT_TEXT_CATALOG`).
The bot, the backend's push after an OAuth login and the backend's mailings ([mailing.md](mailing.md))
render from it. The texts quoted in this
repository's other docs and comments are the catalog's defaults.

The catalog is part 1 of #240. Part 2 (#299) stores overrides in the database, applies them in
the bot and the backend without a deploy and edits them from a CLI ([Overrides](#overrides)). The
admin section «Тексты бота» (#300) edits them too ([admin-pages.md](admin-pages.md) → Bot texts).
Part 4 (#301) makes the command descriptions and the profile editable from the CLI and republishes
them to Telegram when they change ([Publishing](#publishing)); the admin page edits and publishes
them too (#361).

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
  generic over the catalog and its variables, so its tests run on a small catalog and registry of
  their own.
- `packages/shared/src/bot-text-vars.ts` — the registry of variables (`BOT_TEXT_VARS`,
  [Variables](#variables)), `MODE_LABELS` and `BotTextBalance`;
  `packages/shared/src/bot-text-format.ts` — `formatUsd`, `formatStake`, `formatCount`,
  `formatAge`, the formatters the registry and the bot share.
- `packages/shared/src/telegram-html.ts` — `telegramHtmlTemplate`, the constructor the views use
  ([Safety](#safety)).
- `apps/bot/src/texts.ts` — the bot's view: `TEXTS`, `LABELS`, `PROFILE`, `botCommands()`, the
  label maps, `setBotTextSource`, `textOf`.
- `packages/shared/src/bot-commands.ts` — the command menu: `BOT_COMMANDS` (each command's name and
  its description's key), `BOT_COMMAND_SCOPE`, `botCommandsOf(plain)`.
- `apps/backend/src/auth/texts.ts` — the backend's view: `CLIENT_TEXTS`, `CLIENT_LABELS`,
  `setBotTextSource`; read by the push (`auth/client-push.ts`) and the mailings
  (`mailing/messages.ts`).
- `packages/shared/src/bot-text-overrides.ts` — the resolver, the writer's check, the Russian
  messages, the refresher and the wire schema of `GET /bot-texts`.
- `packages/shared/src/bot-text-messages.ts` — the assembled messages and their estimate.
- `packages/db/src/bot-text-ops.ts` — the table's reader and its one writer;
  `apps/backend/src/cli/bot-text.ts` — the CLI; `apps/backend/src/bot-texts/routes.ts` — the bot's
  read; `apps/backend/src/bot-texts/publish.ts` — publishing the menu and the profile.
- The admin section (#300): `packages/shared/src/admin-bot-texts.ts` (wire shapes, the publish
  result's shape, `renderBotTextPreview`), `packages/db/src/admin-bot-text-ops.ts` (the read with
  the writer's login), `apps/web/src/admin/telegram-preview.ts` (the preview as browser HTML),
  `apps/web/src/admin/publish-result.ts` (the publish result in the redirect, #361).

## An entry

`html(group, description, source, options)` or `plain(...)` in the catalog, with:

- **kind** — `html`, a message part sent as Telegram HTML, or `plain`: a label, a word put into
  a message, a command description or the profile. Telegram never parses a plain text, so it is
  never escaped.
- **group** — the screen or scenario the admin section lists it under: `start`, `card`,
  `account`, `menu`, `settings`, `support`, `help`, `demo`, `analysis`, `trade`, `session`,
  `mailing`, `buttons`, `commands`, `profile`. `mailing` holds the texts only the backend's
  mailing engine sends (#202), so the bot's `TEXTS` leaves the group out. `buttons` is exactly
  the bot's `LABELS` buttons plus
  `confirmButtonNoEmail`, `commands` the `*Command` descriptions; a label shown on one screen
  only (the levels, the asset types, the durations, the directions) sits in that screen's group.
  `bot-texts.test.ts` pins both lists.
- **description** — where the text is shown, in Russian, at most 200 characters.
- **source** — the default template.
- **vars** — the registry's variables every caller of the key holds when it renders it
  ([Variables](#variables)); `[]` when it holds none.
- **fragments** — placeholder → key: another entry's text put in place of the placeholder.
- **limit** and **singleLine** ([Limits](#limits)).

A **key** is a permanent id, `^[a-z][a-zA-Z0-9]{0,63}$` (`BOT_TEXT_KEY_PATTERN`). Overrides are
stored under it, so renaming a key is a data migration; without one, the old row shows in
`bot-text list` as an unknown key, and `bot-text reset <old key>` removes it.

## The template

- `{name}`, with `name` matching `[a-z][a-zA-Z0-9]*`, is a placeholder. Any other `{` or `}` is a
  stray brace and an error; there is no escape, and no default needs a literal brace.
- A **variable** of the key is optional: a template may leave out any of them, or use one more
  than once (#358 В3, owner's decision of 2026-10-08, in place of #240's rule that the argument
  must appear).
- A **fragment** placeholder is optional: a template may leave it out. A fragment's key has no
  fragments and no variables of its own — one level deep, so no cycle — and a plain template takes
  only plain fragments. In an html template an html fragment is nested as Telegram HTML, a plain
  one is escaped. Fragments carry the feature lines into the card and `/help`, the level labels
  into the `/settings` legend, the directions into the signal headline, and the button labels a
  message quotes («Нажми «{connectButton}»»), so renaming a button cannot leave a stale quote.
- In an html template a placeholder stands where text goes, never inside a tag: not in a tag's
  name, an attribute or its value.

## The validator

`botTextProblems(key, source, lookup = defaultBotTextSource)` returns problems as codes with an
optional detail; `botTextProblemMessage(key, problem)` words each in Russian for the CLI and the
admin section. Fragments are rendered from
`lookup`'s current texts.

| Code | When |
|---|---|
| `empty` | the source is blank, or nothing is left of it after entities parsing |
| `stray_brace` | a `{` or `}` outside a placeholder |
| `unknown_placeholder` | a name that is neither a variable of the key nor a fragment (detail: the name) |
| `placeholder_in_tag` | html: a placeholder inside a tag (detail: the name) |
| `invalid_html` | html: `telegramHtmlProblems` refuses the text (detail: its first problem) |
| `too_long` | the text with the variables' samples is over the entry's limit (detail: the length) |
| `padded_line` | a line of the text starts or ends with a space |
| `multiline` | a single-line entry holds LF, CR, U+2028 or U+2029 |

`unknown_placeholder` reads «Переменная {x} недоступна в этом тексте. Доступны: {a}, {b}» —
or «Переменных у этого текста нет» — with the key's fragments after it («фрагменты: {connectButton}»),
in the CLI and the admin alike. A stray brace or an unknown placeholder stops the check: nothing
can be rendered. Lengths are
counted as the Bot API counts them: on `plainTextOf(...)` for html, on the string for plain, in
UTF-16 code units. `bot-texts.test.ts` runs the validator over every default.

## Safety

**Why a saved text cannot break on a value.** The validator renders an html template twice: with
the variables' samples, and with `·` (U+00B7) in place of every variable. To find a placeholder
inside a tag it
renders a third time with a letter in every placeholder, which keeps a tag that holds one a tag
(`<blockquote e{v}pandable>`). An escaped value in text position holds no `<`, `>`, `"` and no
bare `&`, so it can change how the text parses only by completing a partial entity of the static
text right before it (`&am{v};`, `&#{v}1;`); `·` leaves such an entity a bare `&`, which is
refused. A template valid with `·` and with no placeholder inside a tag is therefore valid with any
escaped value, the empty one included.

**Every rendered text is checked again.** The views build html through `telegramHtmlTemplate`,
which renders the holes as `telegramHtml` does — strings escaped, `TelegramHtml` nested — and runs
`telegramHtmlProblems` over the assembled text on every call, throwing `InvalidTelegramTemplate`
(its `name` only, no text) when Telegram would refuse it. A variable's formatter returns a
string, which the hole escapes; no variable takes `TelegramHtml` (the type, and `InvalidBotText` at
run time for a formatter's result that is not a string), so html reaches html only through a
declared fragment, which the validator renders and checks (#299). The callers
do not catch it: it would mean a catalog default that the tests let through, or an override that
skipped the resolver ([Loading](#loading)). A source whose text does not parse against its key
throws `InvalidBotText`, also by name only.

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
card, `/account`, `/help`, the analysis screen). Those are bounded by [Assembled
messages](#assembled-messages).

## Reading the texts

`createBotTexts(source)` returns `{ html, plain, samples, renderWith }`: one getter per key,
reading `source.sourceOf(key)` on every access. A static html key gives `TelegramHtml`, an html key
with variables `(context) => TelegramHtml`, where `context` holds every variable of the key with
the registry's input type (`{ email: string | null; firstName: string }` for `codeSent`); plain
keys give `string` and `(context) => string`. The types follow each entry's kind and variables
(`bot-texts.typecheck.ts` is the oracle: a missing variable, one the key does not have, a wrong
input type and a `TelegramHtml` value do not compile). Only the variables the text holds are
formatted, so a stand-in text is read only when it can be shown. `samples.html[key]` and
`samples.plain[key]` are every key rendered at its variables' samples — the admin's preview and
the validator's view; `renderWith` fills each placeholder with a given string, for the estimate of
[Assembled messages](#assembled-messages). A getter returns the same object or function while the
key's text and its fragments' texts are unchanged — the suites compare texts with `toBe` — and
renders again as soon as any of them changes.

The bot's `texts.ts` and the backend's `auth/texts.ts` each hold a source, the catalog's defaults
until `setBotTextSource` replaces it (the refresher does, every 30 s: [Loading](#loading)), and
build their views over it.
The bot's views keep the names they had before the catalog: `TEXTS` is every html key but
`cardGreetingNoName`, `featureLines` and `oauthLoginFailed`, with `cardGreeting` falling back to
`cardGreetingNoName` for a blank name; `LABELS` is the `buttons` and `commands` groups but
`confirmButtonNoEmail`, with `confirmButton(email | null)`. The status card and the stake picker
build their context once (`userContextOf` in `texts.ts`). Both bot and backend label the confirm button through
`confirmButtonLabel` (`link-confirmation.ts`).

**Nothing is read at load.** Every text is looked up when a message is built, so a swapped source
reaches every message: `/help` is assembled per request, and the maps that used to hold texts —
the refusals in `bot.ts` and `demo-trade.ts`, the intent status lines, the signal headlines —
now hold keys (`textOf(key)`), while the label maps (`ACTION_LABELS`, `DEMO_GROUP_LABELS`,
`DEMO_DURATION_LABELS`, the analysis words) are getters over keys (`labelsOf`). `botCommands()`
included (#301): `/help` lists the descriptions in effect, and the menu published at start is
built when it is published. The tests of the source swap hold one place each (`bot.test.ts`, `demo-trade.test.ts`,
`texts.test.ts`, `analysis.test.ts`, `client-push.test.ts`).

## What stays in code

Data and identifiers, not texts (decision on the issue's plan, approved by the owner):

- the command names `/start`, `/menu`, `/stop`, `/account`, `/settings`, `/invite`, `/help`, `/support` —
  the bot routes by them; only their descriptions are entries. The names and their order are
  `BOT_COMMANDS` in `packages/shared/src/bot-commands.ts`;
- `MODE_LABELS` (DEMO/REAL), now in `bot-text-vars.ts` for `{mode}`;
- `pairButtonLabel` («symbol · payout%») and `groupButtonLabel`'s ` · N`;
- the ` ✅` after the selected level (`currentLevelLabel`);
- the fallback duration `⏱ N с` (`durationLabelOf`), `formatAge`'s `с`/`мин`, `formatUsd`'s `$`
  and digit grouping (`bot-text-format.ts`);
- «N из M» on the demo's page line, the ` · ` of the trade line and `analysisSubject`, the
  indicator names `EMA`/`RSI`/`ATR` and the ` — ` of the analysis lines;
- the `/command — description` line of `/help`.

## Variables

`BOT_TEXT_VARS` (`packages/shared/src/bot-text-vars.ts`, #358) is the registry of the values a text
can print. Each variable has a Russian description and a sample — the editor's panel, the CLI's
`show`, the preview and the validator read them — and a formatter from the caller's input to the
string in the placeholder: money through `formatUsd`/`formatStake` over a `DecimalString`, never a
JS number (Rule 2), counts through `formatCount`, the age through `formatAge`. How wide each can
get is `BOT_TEXT_VAR_DEFAULT_WIDTHS` in `bot-text-messages.ts`; a variable without a width does not
compile.

| Variable | Input | Printed | Stand-in |
|---|---|---|---|
| `firstName` | Telegram's `first_name` | trimmed | — |
| `email` | the account's address or `null` | as is | `accountUnknownAddress` |
| `tokens`, `reservedTokens` | token counts of the access read | `formatCount` | — |
| `bonusTokens` | the link bonus | as is | — |
| `demoBalance`, `realBalance` | `{ amount, fresh }` or `null` | `formatUsd`, fresh only | `balanceUnavailable` |
| `mode` | `TradeMode` | `MODE_LABELS` | — |
| `level` | `NotificationLevel` | its button label | — |
| `stake` | the saved demo stake or `null` | `formatStake` | `stakeMinimumLabel` |
| `minStake`, `demoAvailable` | the broker's bounds | `formatStake` | — |
| `realAvailable` | `real.available` of the access read, the mode screen (#121) | `formatUsd` | — |
| `age` | seconds | `formatAge` | — |
| `profit` | `trades.profit` of the session view, the SQL sum (#337); the summary card's `result` (#318) | `formatSignedUsd` | — |
| `botUsername` | the bot's `ctx.me.username`, without `@` (#318) | as is | — |
| `referralLink` | the user's personal link, `referralLinkOf` (#115) | as is | — |

The rest (`amount`, `count`, `symbol`, `subject`, `line`, `trades`, …) are a line's value the
caller has already put into words from the catalog and its data, printed as is; their description
names what they hold.

**A text never causes a request.** A variable is bound to a key only when every caller of that key
already holds the value when it renders: the access read and `from.first_name` for the status card
and the stake picker, the level and the stake for `/settings`, the address for the login dialog,
the account card, `/account` and the backend's push. A formatter gets nothing but its input and the
stand-in texts; no handler reads anything more for a text (`HANDLER_CALLS`, held by
`apps/bot/src/timing.test.ts`). New data for a text is a code change, not an override. A static
text sent from many places (`unavailable`, `blocked`, `accountNone`, `statusAmbiguous`,
`confirmPrompt`, …) has no variables, and `statusStale` and `stakeBelowMinimum`, each sent from
more than one place, have only what every sender holds: `statusStale` is also the age line under a
session's result (#337), and every sender holds the age.

**A stale value is never shown as current** (owner, 2026-10-08). `{demoBalance}`/`{realBalance}`
print a number only from a fresh snapshot (`fresh`, the backend's `isBalanceFresh`); stale or
missing, they print the editable `balanceUnavailable` («нет свежих данных»). The status card's own
lines keep `{amount}` as it is and say the age on `statusStale`/`statusNoSnapshot`. A stand-in is
read from the same source as the text, so an override of it applies everywhere the variable does.

**Renamed placeholders.** Twelve placeholders took the registry's names, the default text the same:
`statusTokens` `{count}` → `{tokens}`, `statusReserved` `{count}` → `{reservedTokens}`,
`cardBonusGranted` `{tokens}` → `{bonusTokens}`, `settings` `{current}` → `{level}`,
`settingsStake`, `stakeSaved`, `launchStake`, `stakeSavedLine` `{amount}` → `{stake}`,
`stakePickerMinimum`, `stakeBelowMinimum` `{amount}` → `{minStake}`, `stakePickerAvailable`,
`stakeAboveAvailableAmount` `{amount}` → `{demoAvailable}`. Migration `0030_bot_text_variable_names`
rewrites a saved override of these keys to the new name, version and time untouched; a row the
longer name would push past the table's length CHECK stays as it was, and the loaders show the
default and name the reason (`bot-text list`, the admin section). The old name is then an
unavailable variable: a form still open with it is refused on save.

## Adding a text

1. Add an entry to `BOT_TEXT_CATALOG` in the group of the screen that shows it, with a Russian
   description; list in `vars` the registry's variables every caller holds when it renders it
   (a value no variable has yet is a new registry entry with its width), and fragments for any
   other entry it quotes.
2. Read it in the bot through `TEXTS`/`LABELS` (or `textOf`/`labelsOf` for a map), never into a
   module constant.
3. `pnpm check`: `bot-texts.test.ts` validates the default, and the facade tests in `texts.test.ts`
   name the keys `TEXTS` and `LABELS` hold — a new html entry joins `TEXTS`, a new button needs the
   lists in `bot-texts.test.ts` and `texts.test.ts`. Where the real assembly is narrower than a
   variable's default width, add the key to `BOT_TEXT_VAR_WIDTHS`
   ([Assembled messages](#assembled-messages)).
4. A new assembly of several texts gets a description in `BOT_TEXT_MESSAGES` and a builder in
   `apps/bot/src/bot-text-messages.test.ts`. Nothing finds a new assembly on its own: this step is
   the only thing that puts it under the writer's and the loaders' bound.

The admin's editor reads the entry's `vars` (with the registry's descriptions and samples),
`fragments` and `limit` in one place, `placeholderHints` (`apps/web/src/admin/pages.ts`), and the
preview renders `samples` (`renderBotTextPreview`).

## Overrides

`bot_text_overrides` holds one row per overridden key: `key`, `source`, `version`, `updated_at`,
`updated_by_staff_id` (null from the CLI). A key with no row shows its default; a reset deletes
the row. The table's CHECKs hold the key's spelling and a length of 1-16384
(`BOT_TEXT_SOURCE_MAX`); whether the key is in the catalog is the writer's check, and a row that
skips it is ignored by the loaders. A version comes from `bot_text_override_version_seq` on every
write, so a key reset and saved again never gets back a version a stale form still holds. A key
with no row is version 0.

The writer (`applyBotTextSave`, `applyBotTextReset`) locks the table in `SHARE ROW EXCLUSIVE`
mode, which serializes writers and leaves the loaders' SELECT alone, and reads every row. It runs
inside its caller's transaction: the CLI's `saveBotTextOverride`/`resetBotTextOverride` open one
and write the audit row; the admin section calls it inside `runAsStaff`, which writes the row. It
refuses:

- a key outside the catalog (a reset of one is allowed);
- an expected version other than the current one: «Текст уже изменил другой сотрудник»; the
  answer carries the current version and text (the default when there is no row);
- a change `botTextChangeProblems` objects to: the key itself would be rejected by the resolver
  below, or an override in effect now would stop being — a fragment that breaks a host, a reset
  that puts back a longer default, two texts that overflow a card together. An override the
  loaders reject already does not block a change of another key.

A save that changes nothing answers «unchanged», a reset of a default «already default»; neither
writes. Every save and reset writes `audit_log` in the same transaction: `bot_text_saved` or
`bot_text_reset`, payload `{ key, action, oldText, newText, oldVersion, newVersion }`, the texts
in effect before and after; a reset of a key outside the catalog records the row's text as
`oldText`, the only copy there is. The admin's row adds `path` and `result`, and a refused admin
request writes the same action with `result` and no texts (admin-pages.md → Audit actions). The
admin publishes the command menu and the profile after a save or reset of their keys, as the CLI
does, and records the result in its own row, `bot_profile_published` (admin-pages.md → Bot texts →
Publishing).

## Loading

`resolveBotTextOverrides(rows)` decides which rows take effect, for the loaders and the writer
alike. A row is rejected, and its key shows the default, when its key is unknown,
when `botTextProblems` refuses it against the other accepted texts, when it is a fragment that
breaks a host still on its default, or when it is a part of an assembled message that would
overflow (every overridden part of that message goes). Rejecting only takes candidates out and the
defaults pass, so the loop ends.

`createBotTextRefresher` loads at start and then every `BOT_TEXTS_REFRESH_MS` (30 s) from the
start of the previous load: the bot over `GET /bot-texts` (internal bearer, `{ key, source,
version }` only) within `BACKEND_REQUEST_TIMEOUT_MS` and up to `MAX_BOT_TEXTS_BODY_BYTES` (8 MiB) of
body, a longer one being a failed load, the backend from the database within
`BOT_TEXTS_LOAD_BUDGET_MS`. A saved text reaches new messages within 35 s in the bot and 33 s in
the backend's push, without a restart; the CLI and the admin promise
`BOT_TEXTS_APPLIED_WITHIN_S` (35), which `apps/bot/src/timing.test.ts` holds at least the refresh
plus `BACKEND_REQUEST_TIMEOUT_MS`. A failed load keeps the last applied set — the defaults
until the first success — and logs a `warn` by error identity; a rejected row is logged once per
change of the rejected set, by key, version and reason, never with its text. Both processes stop
the refresher on shutdown.

The table's CHECKs are the bot's wire schema bounds, field for field: the key's pattern, the
source's length in code points (as zod's `max` counts a string, and as `char_length` does), the
version 1..2^53−1, and 1000 rows through the read's `limit` (`listBotTextOverrides`, first by
key). So no row in the table, hand-inserted SQL included, fails the bot's parse of
`GET /bot-texts`; a row that passes them and fails the resolver is rejected and shows the default
in both processes. `schema.db.test.ts` holds the two sides equal on their boundary rows.

## The CLI

On the server, inside the backend container (`-T` passes stdin; `-s` keeps pnpm's header out of
stdout):

```bash
docker compose exec -T backend pnpm -s --filter @binarius/backend bot-text show welcome > welcome.txt
docker compose exec -T backend pnpm --filter @binarius/backend bot-text set welcome --file - < welcome.txt
docker compose exec backend pnpm --filter @binarius/backend bot-text reset welcome
docker compose exec backend pnpm --filter @binarius/backend bot-text list
```

`show` prints the text alone on stdout and the rest (group, description, the key's variables with
their descriptions and samples, its fragments, the version) on stderr.
`set` reads strict UTF-8, drops a BOM, turns CRLF into LF and takes off one trailing newline.
`set` and `reset` take `--version N` from `show`. Exit 0 is done or nothing to do, 1 refused or
failed, 2 not understood; after a database failure on a write the state may have changed, so the
CLI points at `show`. `set` and `reset` of a command description or a profile text, and `publish`,
also publish to Telegram ([Publishing](#publishing)).

## Publishing

Telegram keeps the command menu (`setMyCommands`, scope `all_private_chats`), the description and
the short description on its side, so a change of one of those texts reaches users only once it is
published. Three places publish, each from the rows as the loaders resolve them, never from the
text of a request:

- **The bot at start.** `onStart` waits for the first texts load (`botTexts.loaded()`, bounded by
  the refresher's own budget), then sends the three calls with the texts in effect. A failed first
  load publishes the defaults. The refresher's later loads apply new texts to messages and `/help`,
  but do not publish: the menu and the profile change at the next start or `publish`.
- **The CLI after a save or a reset** of a `commands` key (`setMyCommands`) or a `profile` key
  (`setMyDescription` or `setMyShortDescription`): after the commit, only the method of that key.
  A save or reset that writes nothing publishes nothing.
- **`bot-text publish`**: all three, for a failed publish or a row written by hand.
- **The admin section (#361)**, the same two ways: after the commit of a save or reset of a key of
  the two groups, only that key's method; «Опубликовать заново» (`POST /admin/bot-texts/publish`),
  all three. Each writes `bot_profile_published` with the result by method (admin-pages.md → Bot
  texts → Publishing).

```bash
docker compose exec backend pnpm --filter @binarius/backend bot-text publish
```

The CLI prints one line per method: `setMyCommands: опубликовано`, or
`setMyCommands: ошибка — GrammyError, Telegram 400` / `… — HttpError (Error)`: the error's identity
and Telegram's `error_code`, never its description or the payload (Rule 8). On any failure a line
on stderr says to run `bot-text publish`. A save or reset exits 0 whatever Telegram answered: the
override is kept (#240, В6). `publish` exits 1 when any method failed. These runs read
`TELEGRAM_BOT_TOKEN` before anything is written — a missing token refuses the run with nothing
saved — and other keys never need it.

`publishBotProfile` (`apps/backend/src/bot-texts/publish.ts`) does the backend's publishing: one
attempt per method, one call after another, each caught on its own, one result per method sent. It
uses a bare grammY `Api` on the public bot's token, which polls nothing. Each call is bounded by
`BOT_PROFILE_PUBLISH_TIMEOUT_MS` (2 s) and the three by `BOT_PROFILE_PUBLISH_BUDGET_MS` (6 s,
`packages/shared`), the bound web's request timeout sits above, since the admin routes publish
inside a request (`apps/web/src/timing.ts`, #361). The backend's timing chain holds both. The CLI's
publish is not audited, its save or reset is; the admin's publish is (`bot_profile_published`).
`BOT_PROFILE_METHODS` and `botProfileMethodsOf` live in `packages/shared/src/bot-text-overrides.ts`,
for the backend and web alike; a new `profile` key does not compile until it names its method.

The bot's start, a CLI run and the admin may publish at the same time. Each publishes the resolved
rows, and the last call wins. A save committed after the bot resolved its first load and before its
`setMyCommands` leaves the old menu in Telegram until the next publish. The CLI's own publish
follows its commit, so a CLI run ends with its value in Telegram unless its publish failed, and
then it says so. The admin's publishes are one queue a backend process: each reads the rows after
the previous one has been sent, so the last publish of a burst carries every admin save or reset
committed before its read; the CLI, the bot's start and a second backend process are outside that
queue — the last call wins — and «Опубликовать заново» mends a menu left behind.

## Assembled messages

A key's limit is checked with its variables' samples. `BOT_TEXT_MESSAGES` describes what that
cannot bound: each message the bot builds from several keys (the account and status cards,
`/help`, `/account`, the analysis screens, the trade and session status, the demo screens,
`/settings` with the stake line and the stake picker, the summary card's footer — plain text drawn
on the image, bounded by its key's limit, #318), and each html key with variables in no such
message. `estimateBotTextMessage` adds up the parts with every placeholder the text holds at its
widest — the key's width in `BOT_TEXT_VAR_WIDTHS`, else the variable's in
`BOT_TEXT_VAR_DEFAULT_WIDTHS` — and labels read from the texts in effect, so a longer override of a
label widens the line it goes into, and a variable an override adds widens the message by its own
width. `apps/bot/src/bot-text-messages.test.ts` holds every description equal to the real assembly
on the defaults and to the keys it reads.

Widths from a schema are enforced there: an address entered by the user 254, a USD amount 20, a
stake 25 (`formatStake` over an unsigned `numeric(20,8)`: the demo stake, the broker's minimum and
the demo balance), a count 25, an int4 asset id or duration, and the `/account` list, which the
backend answers with at most `USER_ACCOUNT_LIST_LIMIT` (10) links. The rest are stated
assumptions in `BOT_TEXT_WIDTHS`: a broker's address ≤ 254, a symbol ≤ 64, a session's counters
≤ 999, the analysis numbers, a bot's username ≤ 32 (Telegram's rule). A value past one of them lengthens a message by a few characters,
and Telegram refuses the message only if that crosses its limit. A plain label is measured as
written, markup and entities included: it is escaped and shown literally.
