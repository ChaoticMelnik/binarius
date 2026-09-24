## Workflow

### Взаимодействие с владельцем

- **Любой вопрос владельцу — через AskUserQuestion**, не обычным текстом. Относится ко всем уточняющим вопросам в этом репозитории, включая checkpoint'ы pipeline (`/tech-lead`, `/architect`, `/implementer`, `/reviewer`).
- Фазы pipeline работают спавн-агентами без `AskUserQuestion`: вопросы (в том числе ≥3 вопроса `/clarify`) и запрос на мерж они возвращают tech-lead'у, и tech-lead задаёт их владельцу через `AskUserQuestion` (`.claude/skills/tech-lead/SKILL.md` → Phases run as spawned agents).

### GitHub Issues + Projects — таск-трекер

Задачи — GitHub Issues репозитория `ChaoticMelnik/binarius`. Статус ведётся полем **"Pipeline Status"** в GitHub Project #2 (https://github.com/users/ChaoticMelnik/projects/2), не встроенным Open/Closed.

Константы (владелец истины — `.claude/skills/github/SKILL.md`, не вызывай `field-list`/`item-list` заново ради их поиска — они уже там).

Читать issue и менять статус — командами `gh issue`, `gh api graphql` и `gh project item-edit` с `--json`/`--jq`-фильтром по шаблонам из `/github` скилла. Статус ищется только GraphQL-шаблонами: `gh project item-list` без `--limit` молча отдаёт 30 элементов, и issue за этой границей «нет на доске». `gh issue create` не добавляет issue в Project #2 — для этого отдельная операция `/github`. В отличие от Linear MCP (который всегда возвращает объект целиком), `gh` фильтрует на своей стороне до того, как результат попадёт в контекст — поэтому изолированный Agent для чтения/записи тут не обязателен по умолчанию (см. `/github` → Core Rule).

### GitHub — статусы задач

- **При начале работы** — сразу `Pipeline Status → In Progress` (через `/github` скилл). Не ждать напоминания.
- **При готовности к ревью** — сразу `→ In Review` и PR с `Closes #<N>` в описании.
- **После ревью с замечаниями** — reviewer сразу переводит `→ Todo`; `→ In Progress` возвращает архитектор после Plan Update. Задача не может оставаться в In Review при незакрытых замечаниях.
- **Done** — только после подтверждённого мержа (`gh pr view <N> --json state,mergedAt`, `state == "MERGED"`), никогда по одному вердикту ревью.
- Статус в Project board должен отражать реальное состояние работы в любой момент времени.

### Git-процесс

- **Feature-ветки обязательны.** Никогда не коммить напрямую в `main`.
- **Именование веток:** `feat/<N>-краткое-описание`, `fix/<N>-описание`, `refactor/описание`, `docs/<N>-audit` (только docs-PR аудита, tech-lead Phase 5) — `<N>` — номер GitHub issue.
- **Перед началом работы** — `git pull --rebase origin main`.
- **Формат коммитов:** `#<N>: краткое описание`.
- PR обязан содержать `Closes #<N>` в описании — это закрывает issue при мерже. Исключение — docs-PR аудита (tech-lead Phase 5): ветка `docs/<N>-audit`, в описании `Refs #<N>` вместо `Closes` — issue уже закрыт мержем своего PR; статус в Project board переводится отдельно, вручную через `/github` скилл (`Closes` не трогает Pipeline Status).
- **`main` полностью защищена от прямого push и force-push — без исключений.**
- **Коммит/PR-автономность: включена (подтверждено 2026-09-21).** Стоп-пойнты общего pipeline (`~/.claude/CLAUDE.md` → Skill Orchestration → Pipeline autonomy) для commit-authorization и PR-confirmation в этом репозитории сняты — `/implementer` коммитит, пушит feature-ветку и открывает PR автономно, без запроса подтверждения у владельца.
- **Мерж-автономность: включена (подтверждено 2026-09-21), с обязательным подтверждением перед каждым мержем.** Мерж выполняет: в pipeline — tech-lead (merge relay после вердикта reviewer'а-субагента); при прямом вызове `/reviewer` владельцем — сам `/reviewer`. В обоих случаях исполнитель обязан перед КАЖДЫМ мержем без исключения спросить разрешение через `AskUserQuestion` непосредственно перед этим мержем и мержить только на явное "да" — одно полученное "да" не переносится на следующий PR или на повторный мерж; эта часть не waivable ни при каких обстоятельствах (см. `~/.claude/CLAUDE.md` → Skill Orchestration → Pipeline autonomy → Project override). Если `gh pr merge` не проходит технически (конфликты, не прошли чеки, branch protection) — сообщить о проблеме и остановиться, не форсировать и не обходить через `--admin` или другой bypass-флаг.

### Модели по ролям pipeline

Решение 2026-09-22, механизм переписан 2026-09-24 (#56). Требование владельца: самая мощная модель — на архитектуре; остальные роли распределены по стоимости, потому что связывающее ограничение темпа — недельный кап Fable, а не Opus.

| Роль / агент | Модель (алиас → id) | Где задано |
|---|---|---|
| `/tech-lead` (оркестрация, clarify- и merge-relay) | модель сессии (сейчас `claude-opus-5-5`) | главный контекст; frontmatter `model: inherit` |
| `/clarify` | вопросы готовит фаза на своей модели, задаёт tech-lead | implementer Step 0, architect Step 5 |
| `/architect` (план, Plan Update) | `fable` → `claude-fable-5-1` (Claude Fable 5.1), самая мощная | параметр `model` Agent-спавна tech-lead'а |
| `/implementer` | `opus` → `claude-opus-5-5` (Claude Opus 5.5) | параметр `model` Agent-спавна tech-lead'а |
| `/reviewer` (оркестрация, консолидация, ручной чеклист) | `opus` → `claude-opus-5-5` | параметр `model` Agent-спавна tech-lead'а |
| субагенты `/code-review high`, `/security-review` | `opus` → `claude-opus-5-5` | параметр `model` вложенного спавна, reviewer Step 3c / 3b |
| субагент `/simplify` (report-only, без вложенных агентов) | `sonnet` → `claude-sonnet-5` | параметр `model` вложенного спавна, reviewer Step 3d |
| Codex plan review / iteration review (при необходимости — повтор как whole-feature pass) | `gpt-5.6-sol`, reasoning `high` | явные `--model gpt-5.6-sol --effort high` в каждом `task`-вызове companion-скрипта (architect Step 7, reviewer 3a и, если после 3a появились коммиты, 6-pre, tech-lead Phase 5); `~/.codex/config.toml` — только fallback для ручных запусков владельца; `review`/`adversarial-review` в pipeline не используются (нет `--effort`, не читают шаблон промпта); `codex:rescue` не используется |

Механика (сверено по транскрипту этого прогона, 2026-09-24):
- Модель фазы задаёт параметр `model` Agent-спавна. Проверено: спавн `"model":"fable"` → `resolvedModel` `claude-fable-5-1` и тот же id во всём транскрипте агента (`47157f55-….jsonl` → `subagents/agent-a3f76eea1b96c9bd1.jsonl`); спавн `"model":"opus"` → `claude-opus-5-5` (`agent-afdfb5ef2a3c9d098`); вложенный спавн глубины 2 `"model":"sonnet"` → `claude-sonnet-5` (`agent-aab833c7d10232220`).
- `model:` во frontmatter скилла действует только при прямом вызове скилла владельцем: при `Skill()` внутри хода tech-lead'а модель не переключается (опровергнуто транскриптом #42). Поэтому фазы — спавны, а не `Skill()`-вызовы в главном контексте.
- Модель сессии фазы не задаёт: требование «сессия остаётся на Fable» снято. Промпт владельца посреди фазы попадает в главный контекст, а не в уже работающий спавн, и модель архитектора не понижает.
- Агент не может сам сменить модель сессии (`/model` — только владелец). Менять карту моделей = править параметры спавнов в скиллах и эту таблицу.
- `effort` у спавнов не задаётся — действует `effortLevel` сессии (`xhigh`).
- Если организация запретила модель через `availableModels`, Claude Code может молча оставить другую — поэтому фактическая модель проверяется по транскрипту: `.claude/skills/tech-lead/SKILL.md` → Mode 1 → Model policy — check (`resolvedModel` спавна для глубины 1, `subagents/*.meta.json` + транскрипт агента для любой глубины). id сравниваются до первой `[`: `resolvedModel` может нести суффикс варианта контекстного окна (`claude-opus-5-5[1m]` у reviewer'а #56).

При расхождении этого файла с глобальным `~/.claude/CLAUDE.md` (например, `/clarify` через `AskUserQuestion` самой фазы, Codex MCP, модель сессии) правит проектная секция; текст правок глобального файла tech-lead предлагает владельцу отдельно.

### CI

Единая проверочная команда — `pnpm check` (состав — `package.json` → `scripts.check`, порядок и причина — `README.md` → Commands). Её запускают CI (`.github/workflows/ci.yml`, на `push` в `main` и на `pull_request`), implementer перед коммитом и reviewer в Runtime check; вердикт — код выхода, вывод не пропускается через `grep`. Скрипты `typecheck`/`lint`/`test` — для точечных запусков. Все проверки — под Node из `.node-version` (`eval "$(fnm env)" && fnm use`; ESLint загружает правило из `.ts` и под Node < 22.18 не стартует).

CI дополнительно проверяет, что изменения схемы `packages/db` сопровождаются сгенерированной миграцией (`pnpm db:generate` + чистый `git status` на `packages/db/drizzle`), что закоммиченные миграции не менялись, и накатывает их на тестовую БД (`pnpm db:migrate`) до `pnpm check`.

### База данных

PostgreSQL + Drizzle ORM (решение зафиксировано 2026-09-21, см. `.claude/skills/tech-lead/SKILL.md` → Project Architecture Reference для полного стека). Схема — `packages/db`, общая для `apps/backend` и `apps/trading-worker`. Миграции — **forward-only** через `drizzle-kit`, откат — новой миграцией, не редактированием/удалением применённой. `drizzle-kit push` не используется — только миграции файлами. Деньги и токены — `numeric`/целые минимальные единицы в БД и `bigint`/decimal-обёртки в коде, никогда обычный JS `number`/float. Конкретная схема таблиц не определена — проектируется архитектором для первого реального issue.

**Workflow при изменении схемы (`packages/db`):**

1. Изменить Drizzle-схему в `packages/db`.
2. Сгенерировать миграцию (`drizzle-kit generate`; конкретный npm/pnpm-скрипт фиксируется архитектором при заведении `packages/db`).
3. Проверить сгенерированный SQL глазами — drizzle иногда генерирует деструктивные операции (DROP и т.п.), пропускать их без осознанного решения нельзя.
4. Применить к локальной БД (`drizzle-kit migrate` / эквивалентный скрипт).
5. Закоммитить файл миграции и её meta/snapshot вместе с изменением схемы — миграция проходит ревью в составе того же PR. Meta/snapshot-файлы руками не редактировать — их ведёт `drizzle-kit`.

На проде (Docker Compose, см. Project Architecture Reference) миграции должны применяться автоматически при старте контейнера backend/worker; ошибка миграции = контейнер не стартует (fail-fast). Конкретный entrypoint-скрипт и его расположение не зафиксированы здесь — проектируются архитектором вместе с Docker Compose конфигурацией.

### Несколько параллельных агентов/разработчиков

В проекте могут параллельно работать несколько разработчиков/агентов. Это значит:
- Не редактировать файлы, над которыми работает другой агент/разработчик — конфликт-детект и merge-order ведёт `/tech-lead` (Mode 1, "Conflict detection and merge order").
- Если задача затрагивает общий файл — обсудить с владельцем до начала работы.
- Доменная разбивка: `apps/bot` (Telegram/grammY), `apps/backend` (Fastify: OAuth, постбэки, API), `apps/web` (Next.js: вход, касса, админка), `apps/trading-worker` (торговый цикл, Socket.IO), `packages/db` (Drizzle-схема, общая для backend и worker), `packages/shared` (общие типы/контракты). Владелец схемы БД и общих контрактов — один агент за волну.

### Планирование задач

- Если ограничение применяется к одной сущности домена — проверь, применяется ли оно ко всем сущностям этого домена. Частичное покрытие ловится на ревью — дорого.
- Тикет описывает точку входа; исполнитель отвечает за весь охваченный домен.
- Доменные инварианты, подтверждённые кодом (полный список с местами, где они enforced, — `.claude/skills/architect/SKILL.md` → Architecture Rules; здесь — только короткая памятка):
  1. Статусы — `text` + CHECK из одной `as const`-константы; литералы значений вне её файла ESLint `local/no-status-literal` ловит частично (что не ловит — Architecture Rules п.1).
  2. Деньги/токены — `bigint`/`numeric` string-mode + `DecimalString`, никогда JS `number`.
  3. `token_ledger` и `audit_log` — append-only, включая TRUNCATE (триггеры).
  4. Владение строк — композитными FK, не проверками в коде.
  5. Порядок блокировок `users → broker_accounts → trade_intents`, `broker_accounts` — `FOR NO KEY UPDATE`.
  6. Переходы `trade_intents` — только CAS внутри UPDATE, возраст — по часам БД.
  7. Идемпотентность — unique-индексы `(user_id, client_request_id)`, один нетерминальный intent на аккаунт, outbox `(topic, intent_id)`.
  8. Ошибки логируются именем и кодом (`errorIdentity`/`errorLogFields`); ESLint ловит это частично (Architecture Rules п.8); redact-пути не чистят строки.
  9. OAuth: state — хеш и одноразовый CAS, новый аккаунт — `pending` до подтверждения, заблокированный пользователь не доходит до брокера, refresh — одна попытка, сбой → revocation.
  10. bot → backend — общий bearer, сравнение за постоянное время; внутренний API доверенный.

### Конвенции кода

Стек зафиксирован 2026-09-21 (полная таблица и обоснование — `.claude/skills/tech-lead/SKILL.md` → Project Architecture Reference):
- Язык — TypeScript везде (бот, backend, web, worker, общие пакеты), pnpm workspaces monorepo.
- Пользовательские строки (сообщения бота, ошибки, интерфейс кассы) — русский; код (переменные, функции, комментарии, коммиты) — английский (см. `~/.claude/CLAUDE.md` → Code Language Convention).
- Валидация входных данных — на границах: Telegram update handlers, HTTP-роуты Fastify, постбэки брокера. Внутренний код доверяет уже провалидированным данным.
- Деньги/токены — `numeric`/integer minor units, никогда float.
- Комментарии — только когда WHY не очевиден (см. `~/.claude/CLAUDE.md` → Code & Response Hygiene).

### CodeGraph

Настроен (`codegraph init -i` выполнен 2026-09-21). Общий гайд по выбору инструмента и оговорка про ненадёжность `codegraph_callers`/`codegraph_impact` для `obj.method()`-вызовов и передачи функций по ссылке — в `~/.claude/CLAUDE.md` → CodeGraph. Проектных подтверждений этой оговорки в этом репозитории пока нет — кода почти нет (индекс: 1 файл, 18 nodes, 17 edges на момент настройки), появятся по мере разработки.
