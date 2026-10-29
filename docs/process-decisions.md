# Process decisions

История решений владельца о процессе: файл никто не загружает автоматически, его читают по ссылке `(#N)` из правила. Разделы — по носителю правила (раздел `.claude/CLAUDE.md` или скилл → шаг), запись — «YYYY-MM-DD, #N — решение — прецедент».
В самом правиле остаются формулировка, не больше одной короткой причины и голый `(#N)`.

## tech-lead → Models by role

Механика (сверено по транскрипту прогона, 2026-09-24):
- Модель фазы задаёт параметр `model` Agent-спавна. Проверено: спавн `"model":"fable"` → `resolvedModel` `claude-fable-5-1` и тот же id во всём транскрипте агента (`47157f55-….jsonl` → `subagents/agent-a3f76eea1b96c9bd1.jsonl`); вложенный спавн глубины 2 `"model":"sonnet"` → `claude-sonnet-5` (`agent-aab833c7d10232220`).
- **Во что разрешается `sonnet` — сверено 2026-10-02 (#198).** В прогоне #56 — `claude-sonnet-5`, в прогоне #198 (2 спавна `/simplify` глубины 2) — `claude-sonnet-5-5`; таблица приведена к наблюдаемому.
- **Во что разрешается `opus` — сверено 2026-10-01 (#171).** В прогоне #56 алиас разрешался в `claude-opus-5-5` (`agent-afdfb5ef2a3c9d098`), в прогоне #22 — в `claude-opus-5`, в прогонах #163, #10 и #171 — снова в `claude-opus-5-5`, на всех глубинах. Таблица приведена к наблюдаемому. Требование «архитектура на самой мощной» от этого не страдает: `fable` разрешается стабильно и подтверждён в обоих прогонах.

- 2026-09-22 — решение: самая мощная модель — на архитектуре; остальные роли распределены по стоимости.
- 2026-09-24, #56 — механизм переписан: модель фазы задаёт параметр `model` Agent-спавна.
- 2026-09-23, #42 — `model:` во frontmatter скилла при `Skill()` внутри хода tech-lead'а модель не переключает — опровергнуто транскриптом #42; поэтому фазы — спавны.
- 2026-10-14 — Plan Update архитектора — на `opus` (решение владельца, экономия лимита Fable).
- 2026-10-23, #769 — фактическая модель проверяется по транскрипту только по запросу владельца или при подозрении на подмену модели, не на каждую задачу. Пример суффикса варианта контекстного окна: `claude-opus-5-5[1m]` у reviewer'а #56.

## .claude/CLAUDE.md → Фазы и вопросы владельцу

- 2026-10-09, #388 — постоянные ответы владельца: по разбору 1 755 вопросов pipeline владелец отвечал на эти вопросы одинаково, поэтому они больше не задаются ни в `/clarify`, ни в checkpoint'ах — действует ответ, а агент называет применённое решение в PR или в итоге фазы.
- 2026-10-23, #769 — clarify-вопрос только на реальную развилку, без минимума — for a first plan and for a Plan Update of any round: of 127 relayed rounds the non-recommended option was chosen ~9 times, and agents waited up to 18 h for the answers.

## tech-lead → Overview → Short sessions

- 2026-10-14 — решение владельца: одна сессия tech-lead — на задачу или волну задач; после суток или трёх смерженных задач tech-lead предлагает новую.

- 2026-10-14 — основание экономии токенов: подсчёт по транскриптам 2026-10-14 — больше всего прочитанного из кэша дают главные контексты долгих сессий (~3,4 млрд токенов) и implementer'ы (~27,6 млн на агента — больше всех ролей); связывающий лимит — недельный кап Fable.

## .claude/CLAUDE.md → CodeGraph

- 2026-09-21 — настроен (`codegraph init -i`).
- 2026-10-06, #17 — проектное подтверждение (архитектор #17, индекс 194 файла): `codegraph_callers` вернул ноль вызовов для каждой операции домена `trade_intents` (`transitionIntent`, `markIntentUnknown`, `rejectIntent`, `markIntentAccepted`, `canTransition`, `TERMINAL_TRADE_INTENT_STATUSES`), хотя вызовы есть — охват домена делается grep'ом, ноль callers не доказывает отсутствие вызовов.
- 2026-10-14 — приоритет codegraph обязательный, а не «если настроен»: по транскриптам до этого решения codegraph давал около 0,3 % поисков (55 вызовов против ~20 600 grep).

## .claude/CLAUDE.md → Проверки

- 2026-10-15, #511 — главный контекст (tech-lead, `/manager`) не запускает тесты; единая проверка — `pnpm check`, вердикт — код выхода; mutation evidence — одним вызовом `tooling/mutations.ts` (standing answer, не спрашивается); красный или отсутствующий CI на голове PR — Blocker (reviewer → Runtime check). Прецедент инструмента: #511's `tooling/mutations.ts` passed 14 stubbed tests while a throw inside the child's event handler left the mutated file in the tree.
- 2026-10-18, #646 — CI не запускается на PR, меняющих только пути из одного списка `.claude/CLAUDE.md` → Проверки; «no checks» на таком PR — не Blocker и не ожидание.

## tech-lead → Overview → Codex

- 2026-10-08 — Codex — companion-скрипт, а не MCP-чекпоинт: правила раздела заменяют `~/.claude/CLAUDE.md` → ABSOLUTE RULE (план и ревью) и его Timeout policy; планирование без Codex.
- 2026-10-23, #769 — docs-PR Phase 5 (аудит сессии) — без Codex и без reviewer'а.

## tech-lead → Phases run as spawned agents

- 2026-10-07, #284 — clarify relay: at most 4 questions per `AskUserQuestion` call, the rest in a second call — #284's fifth question was relayed as a default.
- 2026-10-17, #590 — a question the agent marks as a plan defect, or one whose text says the plan contradicts itself, goes to the architect — such a question was relayed to the owner as a choice.
- 2026-09-24, #56 — Failed or stalled phase: the architect stalled after posting its Plan Update; a blind re-spawn duplicates a posted plan or a status change.
- 2026-10-21, #537 — Continuing a phase after a model limit: the resume after the Opus weekly limit said «First push the branch now, then … the per-commit check of `7eb43c24`»; the commit failed `typecheck` after it was pushed, and PR #703 went in by squash.

## tech-lead → Merge relay

- 2026-10-22, #724 — with `--delete-branch` a worktree holding the PR's branch stops `gh` after the merge: the PR merged and the remote branch stayed.
- 2026-10-22, #75 — `mut/75-schema-check` outlived the merge; a closed `mut/<N>-*` branch is deleted after the merge.
- 2026-10-06, #258 — a sub-agent's ready-to-merge comment after a relayed skip was refused by the permission classifier as a CI bypass; tech-lead posts the returned body.

## tech-lead → Merge method

- 2026-10-09, #388 — standing answer: rebase с удалением ветки, без вопроса о способе.
- 2026-10-10 — решение владельца: база стека мержится `--rebase` без `--delete-branch` — иначе GitHub закрывает зависимые PR.

## tech-lead → A rebase of a pushed branch

- 2026-10-29, #782 — у каждого доказательства свой якорь: голова, на которой его сняли (таблица — `head=`, прогоны `mut/` — голова, от которой отрезана ветка, Codex — `head=` маркера, LGTM — голова в комментарии ready-to-merge); якорь покрывает `headRefOid`, пока цепочка комментариев range-diff от него — сплошь «только конфликты»; новые коммиты между ребейзами — не дефект, а новая цепочка. Прецедент: PR #777, ревью 3-го круга, MJ1 — один якорь на все доказательства: после ребейза H0→H1, круга исправлений с таблицей и Codex на H2 и ребейза H2→H3 обход называл H0 и давал ложный Major «разорванная цепочка»; находка m7 1-го круга вернулась, когда потерялось уточнение «до первого ребейза после таблицы».
- 2026-10-29, #782 — range-diff при ребейзе: новый диапазон — `<new base>..HEAD` (`origin/main` при ребейзе на `main`, новая голова родителя при ребейзе на открытую базу стека), в комментарии — обе головы базы. Прецедент: PR #777, ревью 3-го круга, MJ2 — с `origin/main..HEAD` коммиты открытого родителя попадали в строки `>`, и каждый ребейз на стек читался «сверх конфликтов» (проба: `-: ------- > 1: … a1`).
- 2026-10-29, #782 — старую голову базы на стеке находит и называет в промпте spawner: `git merge-base` зависимой с той головой родителя — текущей или `old-head` одного из его комментариев range-diff, — над которой у зависимой меньше всего коммитов; implementer проверяет её темами коммитов, а без неё возвращает вопрос spawner'у; ребейз стека — `--onto <new base head> <old base head>`. Прецедент: PR #851, ревью 1-го круга, M1 — источника головы не было ни у одного spawner'а, а запрет `merge-base` с родителем отсекал и случай, где он верен (родитель двигался коммитами); после двух ребейзов родителя `old-head` последнего комментария неверен (проба S6).
- 2026-10-23, #769 — каждый ребейз запушенной ветки — rebase-only задача одного implementer-спавна; вердикт «только конфликты» / «сверх конфликтов» по range-diff, критерий — implementer → «A rebase-only task»: 38 rebase-only agents in one week ran the whole cascade.
- 2026-10-18, #637 — tech-lead's own 6-pre run after a rebase: the "Known, moved open" field left empty made the run re-raise #643's Minor as a Major.
- 2026-10-10, #152 — Mergeability right before the merge: #429 merged during the review and the PR turned `CONFLICTING`.

## tech-lead → Mode 1

- 2026-10-23, #769 — запись аудита — только отклонения, не пройденные шаги; ничего не постится на задачу; проверка модели — только по запросу владельца или подозрению.
- 2026-10-21, #668 — the usage-limit text can sit only in `progressPreview` while the summary holds Codex's first message (job task-mvhvi7oq-7flfqh).
- 2026-09-24, #56 — example output of `tooling/model-policy-check.sh` — the script header.
- 2026-10-03, #132, #136, #138, #236 — Fable and Opus weekly limits on 2026-10-03/04: spawns died with `<synthetic>` as their last model.

## tech-lead → Step 7

- 2026-10-02, #177, #192, #103, #166 — several implementers or reviewers at once shared the host, the dev databases and the session scratchpad.
- 2026-10-15, #511 — #511's implementer lost a full `pnpm check` finding out that a worktree has no `TEST_DATABASE_URL`/`REDIS_URL`.
- 2026-10-08, #241, #78, #79, #300, #358 — a worktree-isolated session: the harness let its agents write only in that one worktree.
- 2026-10-06, #125, #126 — agents overwrote each other's `check.sh` and one `pnpm check` ran in the wrong tree; three architects planning in parallel truncated each other's `plan-<N>.md` in the scratchpad root.
- 2026-10-22, #720, #729 — #720's rebase spawn overwrote the parallel #729 rebase spawn's scripts.
- 2026-10-03, #97, #85 — both reviews loaded the main checkout's diff, and one `/code-review` fork checked the PR branch out in the main checkout for two minutes; a guard that only printed the hit let #97's run overlap #85's on the shared database.
- 2026-10-06, #134, #17 — `pgrep -f 'vitest'` matched the shell whose own command line held the pattern, so its wait loop never cleared.
- 2026-10-03, #119, #185, #104 — three parallel reviews exhausted the session limit together before any of them posted.
- 2026-10-06, #134, #99, #133, #19, #17 — five Opus phase agents at once hit the session limit together and stopped mid-step.
- 2026-10-06, #99 — round 2 recreated a removed review worktree's path and failed Codex on the first attempt.
- 2026-10-03, #136 — a worktree copy of the main `.env` stopped both pilot bots for a day (two pollers on one token); the local `.env` has its own dev bots since 2026-10-04.
- 2026-10-16, #391; 2026-10-17, #405 — #391's implementer got a blanket «do not start services» against its plan's procedure check, and the owner had to settle it; #405's did again. #405 — the loopback preload for a dev branch's stand.
- 2026-10-06, #17, #89 — migrations 0013-0015 were missing on the shared database after #17/#89 merged, and `pnpm check` on a fresh `main` failed `schema.db.test.ts`.
- 2026-10-03, #235 — an uncommitted 0011 went into the shared database and was taken out with `drop table` plus `delete from drizzle.__drizzle_migrations` while other agents' `schema.db.test.ts` ran against it.
- 2026-10-15, #381 — #381's 28-pair fetch stopped at pair 14 when its implementer ended on an API 403.
- 2026-10-09, #396 — the implementer's `pkill -INT -f "tsx src/index.ts"` could have stopped another session's dev backend or worker, and nobody could tell afterwards.

## tech-lead → Phase 0

- 2026-10-23, #769 — Phase 0 один раз за сессию; item 6 и задачезависимые половины items 2 и 4 — перед соответствующими спавнами; предупреждения item 5 (a)/(b) записывает Phase 5.
- 2026-10-14 — решение владельца: Model limits — при отказе лимита Fable за 7 дней первичный план сразу на `opus`; так владелец решал каждый раз: 2026-10-07, 2026-10-10.
- 2026-10-15, #511 — простой `grep` по тексту отказа нашёл 47 файлов за неделю при последнем отказе 2026-10-10 — совпадает со строкой правила, загруженной в каждую сессию.

## tech-lead → Phase 2

- 2026-10-10, #396, #397 — all seven plans of 2026-10-06..09 taken on 2026-10-10 needed a round-0 Plan Update; #396 and #397 on 2026-10-09.
- 2026-10-18, #123 — PR #435's round 1 was missed: an empty `gh pr view --json reviews` is not «no review».

## tech-lead → Phase 3

- 2026-10-23, #769 — no per-task audit comment; deviations go into the session's entry.
- 2026-10-06, #252 — #252 stacked on #250: `gh pr diff` also showed the base's commits.

## tech-lead → Phase 4

- 2026-09-30 — решение владельца: hard limit — 3 review rounds per issue.
- 2026-10-20, #666 — the limit counts per PR of a split issue: #673 and #674 took two rounds each.
- 2026-10-16, #536 — two re-runs after rebases re-listed tracked findings; the "Known, moved open" field lists only findings moved into a follow-up issue.
- 2026-10-10, #437, #439 — deleting the base branch closed the dependent PRs; reopening them needed the owner's permission to re-push the base branch.
- 2026-10-15, #494 — commits 1–4 lost their typecheck in the rebase onto `main`.
- 2026-10-10, #441 — #115 stayed open after the merge: a retargeted PR lost its `Closes` link.
- 2026-10-10, #446, #447 — a clean rebase still broke CI twice: #446 — `tsc` after #448 made `webPublicUrl` required; #447 — the longest-answer gate lacked rows for methods merged meanwhile.
- 2026-10-10, #234, #141 — `0580dee`, `7b138a9`: rows for methods merged meanwhile.

## tech-lead → Phase 5

- 2026-10-29, #782 — Phase 5 — раз на триггер, не раз на сессию; продолжение сессии после аудита пишет вторую запись с суффиксом «(продолжение)» при том же `<start>`. Прецедент: PR #777, ревью 3-го круга, m2 — «once per session» и вторая запись под тем же заголовком.
- 2026-10-23, #769 — аудит один раз за сессию, по первому из трёх триггеров; одна запись `audits.md` и один docs-PR без reviewer'а и Codex; ночь без записи записывает следующая сессия любого вида — before it, a task left three artifacts: a Phase 3 comment, a Phase 5 report comment, and an entry with its own docs PR.
- 2026-10-23 — two sessions a day: manager sessions at 11:00 and 20:26.

## tech-lead → Project Architecture Reference

- 2026-09-21 — стек зафиксирован при бутстрапе pipeline; черновой план поставщика использован только для выбора технологий, его бизнес-сценарии и допущения не проверены.
- 2026-09-29, #68, #34 — веб-страницы: Fastify + серверный HTML.
- 2026-10-22, #75 — миграции применяет one-shot сервис `migrate`.

## architect → Overview

- 2026-10-08 — planning runs without Codex (`tech-lead → Overview → Codex`).
- 2026-10-23, #769; #675, #274, #745 — модель в hand-off называется только по своему транскрипту: #675 Plan Update 1, and #274 and #745 Plan Update on 2026-10-23 — three hand-offs named Fable while every turn ran `claude-opus-5-5`.

## architect → Step 4

- 2026-10-03, #119, #185 — planned in one session, both claimed `users.ts`/`user-ops.ts` and both said they merge first; it surfaced only at implementer clarify.
- 2026-10-03, #136, #138 — #136 built its new test on `buildApp`, while #138 made `AppDeps.pairs` required and patched only the existing `buildApp` callers.
- 2026-10-06, #19, #134 — both added Rule 22.
- 2026-10-22, #709, #727 — #709's plan took risk 95, already taken by open PR #727.
- 2026-10-22, #708 — the plan missed two tests with the command-menu literal.
- 2026-10-06, #99, #89, #205 — #99 and #89 against #205's `until()`.
- 2026-10-06, #258, #90, #100 — #258's plan missed #90 and #100, which touched the same shared files; caught at implementer clarify.
- 2026-10-22, #697, #720 — #697's plan wrote the holds in #720's shape, without `signalAction` and the pause branch, which still exist on `main`; caught at implementer clarify.
- 2026-10-06, #90 — the permission classifier blocked SSH to production from an agent.
- 2026-10-07, #240 — planned `no-restricted-imports` on the premise that it skips `import * as`; it catches it, and as planned flagged the shared barrel and five test files.

## architect → Step 4a

- 2026-09-30 — решение владельца: size gate ≤ ~2000 added lines, 3000 the ceiling; the owner pre-authorized creating split issues without a separate confirmation.
- 2026-10-01, #10 — `packages/db/drizzle/meta/*_snapshot.json` does not count.
- 2026-09-30, #6, #7, #42, #22, #9, #68 — calibration: #6 contracts 2.1k, #7 schema 7.5k, #42 transport 7.2k, #22 bot /start 6.1k, #9 OAuth 11.5k, #68 staff login 11.8k.
- 2026-10-07, #299 — estimated at 2.7k against a catalog that #284 and then #297 extended while it was in flight: the PR grew to 3.4k, needed two size exceptions, and a whole review round went to describing #297's screens.

## architect → Step 5

- 2026-09-24, #56 — `review --scope branch` had no `--effort` and ignored the prompt template.

## architect → Step 6 — Validation checklist

- 2026-10-01, #10, #172 — решение владельца: irreversible actions — re-read the state after a timeout (#10 m2 and #172 finding 4).
- 2026-10-01, #176 — a shared route ceiling ended the user's dialog; every unlisted 4xx counted as an unknown outcome.
- 2026-10-02, #198 — `grep '«'` missed quotes in "…" in two docs; a later search skipped `texts.ts`'s own comment.
- 2026-10-02, #199, #209 — #199: a timing probe that broke an older conjunct too, and a `Promise.all` mutation invisible to call order; #209: a sample row that could never pass.
- 2026-10-18, #637 — three rows also failed a second conjunct, and two mutations had no assertion to redden.
- 2026-10-22, #660, #675, #683 — #660 M10/M11 expected L1, which calls the list directly, and M15 was a `load-error`; #675 `Number.isFinite` beside the range check, then 0077 mutations expected in `schema.db.test.ts`; #683 M3, the check's order against `pairOf` unobservable — three plans of one night, two Plan Updates in #675.
- 2026-10-03, #85 — `loggerInstance: pino(...)` compiled at the `Fastify(...)` call and failed on `buildApp`'s return type, TS2322.
- 2026-10-15, #381 — PR #520 M1: `calibrate` passed on an empty stand; PR #512 M1: one decision measured `openDelay` from the decision moment, two others from the boundary, and the fallback counted the 2 s slack twice.
- 2026-10-17, #590 — PR #614 M1: the backfill built its GET on `at` and judged the returned rows closed by `ring.fill(…, now())`, so the bucket forming at `at` was filled as closed.
- 2026-10-22, #696 — PR #713: round 1 — the wake after a settlement read the balance snapshot before `update_balance` wrote the payout and stopped the session `insufficient_balance`; round 2 — the fix covered the session's own settlements, while the wake also fired on other intents of the account.
- 2026-10-16, #392 — PR #553: a fake sleep that ignored `stop` hid an unpaced fetch after SIGINT; ascending ids hid coverage measured on a re-sorted split; no two-drop flap hid a hole stretched to the end of the run.
- 2026-10-23, #745 — PR #760, round 1: the unsuffixed stop's in-place `editMessageText` was reused for the H1 session message, which is a photo; Telegram refused, the bot sent a second message and the photo kept a live «⏹»; H1-B3 pressed only on a text message.

## architect → Step 6 — классы задач

- 2026-10-02, #192 — Compose / env: a nested `${A+${B:?}}` passed on 5.5.1 and failed every `config` on the runner's 2.38.2.
- 2026-10-02, #166 — Developer environment: a VM clock fix passed a 16-min acceptance and left the clock 84 min behind after the first sleep; a truncated `brew --dry-run` hid four upgrades.
- 2026-10-03, #235, #137; 2026-10-16, #567 — Work queue: #235 m1 — failures did not move `rest_observed_at`; the #137 fix covered the outcomes but not a throw, round 1 m2; #567 round 1 — a status message the user deleted or a blocked bot never set `summary_sent_at`, so the row stayed in the resume list forever; the fix cleared `status_message_id` on those endings.
- 2026-10-16, #567 — Bulk start-up work: round 2 — up to 2 000 recovered sessions polled and edited 3 s after a restart.
- 2026-10-16, #536 — A later part of a split feature: round 2 — #567's resume edited old status messages of running sessions and stripped their «⏹» while the backfill withheld the new one.
- 2026-10-17, #404 — Supervisor of external connections: round 1 — a ready reserve never promoted; round 2 — an active stuck in `connecting` and a running socket on an unmarked account; a third plan as an explicit state machine closed them.
- 2026-10-17, #568 — Render / dedupe key: round 1 — an up→down turn with equal `sessionSignalUp`/`sessionSignalDown` overrides kept the bull picture.

## architect → Step 7

- 2026-10-07, #197 — a `\u00XX` escape in the local file came back in #197's plan as caret notation, which turned `[\s\x00-\x1f\x7f]` into a class that refused A-Z; only the implementer's clarify round caught it.

## architect → Architecture Rules

- 2026-10-23, #770 — решение владельца (В3): история правил — в `audits.md` → «Architecture Rules — история», не в правилах; перенос #770 дословный, редактура — #776.
- 2026-10-23, #776 — решение владельца (В4): новое правило — не больше 1 536 байт и без строк истории, тест — `tooling/rules-for.test.ts`; правила до `LEGACY_RULES_MAX` — без лимита.
- 2026-10-29, #776 — решение владельца: `LEGACY_RULES_MAX = 55` — Rules 52–55 появились после В4 (2,1–4,8 КБ) и редактируются как остальные; лимит — с Rule 56.

## implementer → Step 0

- 2026-10-23, #769 — вопрос только на реальную развилку, без минимума (`.claude/CLAUDE.md → Фазы и вопросы владельцу`).
- 2026-10-22, #700 — decision В4 asked for the EN text of the open block, the implementer left it out and justified it in the PR's Deviations.

## implementer → Step 4

- 2026-10-07, #107 — a repo-wide prettier pass reflowed untouched code in `apps/backend` and `apps/web`, which took a separate revert commit.
- 2026-10-16, #551 — one `prettier --write` run on `schema.db.test.ts` reflowed unrelated tests and took fix-up commit `abaf9e4`.

## implementer → Step 5

- 2026-10-20, #666 — #666's per-commit run of 3b910440 hung ~18 h with a worker at ~112 % CPU and blocked #667's implementer (2026-10-19/20); the same commit passed in 60 s under a limit.
- 2026-10-23, #769 — the head is covered by the full `pnpm check`, not by a per-commit run (the head was checked twice); a red check on an already pushed head gets a fix commit and a squash merge.
- 2026-10-17, #105, #506, #508 — each partial check let a red commit through, each on a different part of `pnpm check`: #105's 7b0871f (timing scan), #506's 184c5d1d–696c2127 (`packages/e2e`), #508's dd2f1be8 (lint) — all three PRs went in by squash; #576's commits, checked with the full set, had none.
- 2026-10-14, #493, #492 — #493's first commit typechecked and failed a timing test, and #492 got two non-building commits from a staged `git mv` landing in the wrong commit; both were squash-merged because history cannot be rewritten at night.
- 2026-10-02, #200 — commit 2 was made on a red check joined with `;`, caught before the push.
- 2026-10-23, #274, #722 — #274: a trailing `cat` turned the verdict into 0, a red commit was pushed and stayed in the history, because force-push was not allowed; #722 the same day: `;` before `git commit`, undone before the push.
- 2026-10-20, #669 — #669's H-T8 passed the full local check and failed CI at 5 042 ms, and H-U5 went from 516 ms on `main` to 2 862 ms on CI.
- 2026-10-10, #460 — `git checkout --` over uncommitted changes wiped three files of work.
- 2026-10-22, #660, #675, #683 — a mutation that cannot turn red is a plan defect; #683's M3 stayed green and was left out of the table by the implementer alone — the reviewer confirmed it equivalent, but the proof of that was the reviewer's, not the plan's.
- 2026-10-22, #707 — the closing fence on the JSON's own line; the hand-off named `76ccb733…`, the comment `9f8439ba…`.

## implementer → Step 5.5

- 2026-10-08, #314 — present-tense claims about the removed site sign-in surfaced one by one over four review rounds of #335 and #340.
- 2026-10-01, #159 — a `revoked_at >= created_at` check compared JS `Date`s at millisecond resolution against a microsecond inversion, so on the real bug pair it returned true while the test went red through the DDL CHECK beside it; #159 gave its red run a commit of its own so it could be checked out, and the quoted id then pointed at a commit only the PR's refs still hold.
- 2026-09-28, #22 — shipped three Majors past suites that were green by construction.
- 2026-10-01, #68 — rested a whole round on `assertion-ledger.sh`, which silently dropped deletion-only hunks and globbed zero files; the bring-up procedure passed command by command on a working environment and could not create its first account on a fresh one; carried-over output from an earlier tree was a finding twice (m16, n3), both times with the claim itself intact.

## implementer → Step 6

- 2026-10-09, #388 — commit split: standing answer, the implementer decides.
- 2026-10-03, #185, #138 — with the default comment char `#` the commit message after a conflict lost its `#N: …` subject. Probed on git 2.32: the plain `--continue` dropped the subject; with `;` it was kept.

## implementer → Step 8

- 2026-10-22, #718 — the docs commit stayed local while the hand-off said «each pushed»; the manager found it at the phase boundary.

## manager → Правила ночи

- 2026-10-23, #769 — запись аудита за ночь пишет сам менеджер, docs-PR только с `audits.md`; ночь без записи записывает следующая сессия любого вида.
- 2026-10-15 — решение владельца: Codex ночью не запускается; заменяет решения 2026-10-08 и 2026-10-10 для ночи.
- 2026-10-09 — решение владельца: внешний контент (автор не `ChaoticMelnik`) ночью не берётся.
- 2026-10-10, #416 — решение владельца 2026-10-09, круг 2 #416: ночью стенды не запускаются.
- 2026-10-09, #397 — ответ владельца на clarify: любые действия на VPS ночью запрещены; заменяет п. 6 «Решений владельца» в #397, который разрешал действия на сервере.

## manager → Launch

- 2026-10-10 — /manager was not found until a pull: the harness loads skills from the checked-out tree.
- 2026-10-10, #416 — non-interactive `claude -p` under `--permission-mode auto`: probes of #397, table in PR #416.

## manager → Phase 0

- 2026-10-14 — Colima was stopped, so `up -d redis` could not reach the socket.

## manager → Task selection

- 2026-10-17, #576 — an owner's board note that releases a task: «Связь (уборка 2026-10-17): … Задачу можно брать».
- 2026-10-10, #436, #437, #441 — stack depth at most 3 (#436 → #437 → #441); a 4th level is a skip (решение владельца 2026-10-10).
- 2026-10-22, #697, #720, #721 — a day session merged #697 mid-run, #720 and the stack base #721 became CONFLICTING and were found only at the final report.
- 2026-10-14 — the owner merged process changes into `main` at 21:48 and 21:58 mid-night; three claim comments carried times 5–47 min ahead of the clock.

## manager → Task cycle

- 2026-10-10, #141 — the first Fable spawn had a hand-assembled, truncated prompt without the night rules.
- 2026-10-21, #696 — the manager's own branch name differed from the plan's, and the first answer picked the plan's, not the recommended option.
- 2026-10-18, #405 — 01:01: the #405 stand of a day session (worktree `impl-405`) was a foreign process, not a breach.

## manager → Substitutions

- 2026-10-10, #234 — the manager took «3 Б на символ» for the audit payload unchecked; the architect's probe on Postgres 18 refuted it.
- 2026-10-23, #745 — the manager's «⚡ H1 · {trades}: {result}» would have printed the trade count twice — `{result}` starts with it; the implementer caught it.
- 2026-10-10 — решение владельца: after the first Fable 429 of the session, every later architect spawn goes to `opus`.
- 2026-10-09, #341; 2026-10-22, #709 — API 403 «Request not allowed»: one continuation succeeded both times.

## reviewer → Step 2

- 2026-09-23, #9 — seven delta reviews in a row missed a defect whose two halves sat in different commits.

## reviewer → Step 3

- 2026-10-14 — решение владельца: 3b и 3d — по содержанию diff'а.
- 2026-10-01, #163, #10 — background spawns let the harness end the reviewer's turn first, twice each.
- 2026-10-03, #97, #98, #119, #185, #104 — the forked `Skill("code-review")` reviewed the main checkout's recent commits every time.

## reviewer → Step 4

- 2026-10-08, #340 — a stale comment flagged as uncertain in round 1 reached the owner only in round 3, after the last fix round.

## reviewer → Step 5

- 2026-10-01, #68 — carried output from an earlier tree twice (m16, n3); both times the claim held and the quoted numbers did not.
- 2026-10-21, #668 — the usage-limit text can sit only in `progressPreview`.

## reviewer → Severity Guide

- 2026-09-30 — решение владельца: evidence quality is Minor by default.

## github → Project Constants

- 2026-09-21 — constants filled in at the pipeline's bootstrap.

## github → Why GraphQL

- 2026-09-24, #54, #56 — verified: `gh project item-list` returned 30 of 47 items by default, highest issue number 31; #54 and #56 went missing.

## github → Post a comment

- 2026-10-01, #179, #198 — `gh issue comment --jq` failed silently twice: the flag is not supported and the suppressed stderr hid the failure.
