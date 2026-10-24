## Workflow

### Язык и код

- Пользовательские строки (бот, ошибки, касса, админка) — русский; код, комментарии, коммиты — английский. Комментарии — только когда WHY не очевиден.
- Валидация входа — на границах (Telegram update, HTTP-роуты Fastify, постбэки брокера); внутренний код доверяет провалидированным данным.

### Стек и домены

- TypeScript везде, pnpm workspaces monorepo. Домены: `apps/bot` (grammY), `apps/backend` (Fastify: OAuth, постбэки, API), `apps/web` (Fastify + серверный HTML: вход сотрудников, касса, админка), `apps/trading-worker` (торговый цикл, Socket.IO), `packages/db` (Drizzle-схема и миграции, общие для backend и worker), `packages/shared` (общие типы и контракты); полная таблица — `.claude/skills/tech-lead/SKILL.md` → Project Architecture Reference.
- Параллельно работают несколько агентов: файлы чужой активной задачи не правятся; схему БД и общие контракты меняет один агент за волну; общий файл двух задач — вопрос владельцу до старта; конфликты веток и порядок мержа ведёт tech-lead (Conflict detection and merge order).

### Деньги

- Деньги и токены — `numeric(20,8)`/`bigint` в БД, `DecimalString` в коде, никогда JS `number`/float; две границы, где число допустимо (разбор провода брокера, вывод мок-брокера), — Rule 2.

### База данных

PostgreSQL + Drizzle ORM; схема — `packages/db`, общая для `apps/backend` и `apps/trading-worker`. Миграции — **forward-only**: генерирует `drizzle-kit` (`pnpm db:generate`), применяет runner `pnpm db:migrate` (`packages/db/src/cli/migrate.ts`); откат — новой миграцией, не правкой или удалением применённой; `drizzle-kit push` не используется. В Docker Compose миграции применяет one-shot сервис `migrate`; `backend` и `trading-worker` стартуют после его успешного выхода и сами проверяют, что БД не отстаёт от журнала образа (#75). Порядок правки схемы — implementer Step 4; CI требует сгенерированную миграцию при изменении схемы и не даёт менять закоммиченные.

### Доменные инварианты

- Подтверждённые кодом — индекс `.claude/skills/architect/SKILL.md` → Architecture Rules и файлы `.claude/skills/architect/rules/{core,trading,signal-h1,bot-ui,payments,auth}.md`; по файлам задачи — `node tooling/rules-for.ts <files>`.
- Ограничение на одну сущность домена — проверь все сущности домена; тикет — точка входа, исполнитель отвечает за весь охваченный домен.

### Трекер и статусы

- Задачи — GitHub Issues `ChaoticMelnik/binarius`, статус — поле «Pipeline Status» Project #2, не Open/Closed; чтение и запись — шаблонами `/github` (`.claude/skills/github/SKILL.md`, константы там).
- Начало работы → In Progress; PR с `Closes #<N>` → In Review; Blocker/Major в ревью → Todo (архитектор возвращает In Progress после Plan Update), одни Minor не возвращают; Done — только после подтверждённого мержа (`gh pr view <N> --json state,mergedAt`, `MERGED`). Три круга ревью на PR — tech-lead Phase 4. Статус отражает реальное состояние в любой момент.

### Git

- Ветка на задачу — от `origin/main` или ветки базы стека (implementer Step 2): `feat/<N>-описание`, `fix/<N>-описание`, `refactor/описание`; `docs/audit-<YYYY-MM-DD>` — аудит сессии (`Refs` вместо `Closes`, tech-lead Phase 5). Коммит — `#<N>: описание`. Перед началом — `git pull --rebase origin main`.
- `main` защищена от push и force-push без исключений. Переписывается только непушенная история (implementer Step 5); запушенную ветку переписывает только ребейз — задача rebase-only, push `--force-with-lease` (tech-lead → «A rebase of a pushed branch»).
- Размер PR — до ~2 000 добавленных строк, потолок 3 000 (architect Step 4a).

### Фазы и вопросы владельцу

- Любой вопрос владельцу — через `AskUserQuestion`, не текстом (кроме сессии `/manager`). Фазы pipeline — спавн-агенты без `AskUserQuestion`: вопросы и запрос на мерж они возвращают tech-lead'у (или `/manager`, который отвечает сам), tech-lead спрашивает владельца (`.claude/skills/tech-lead/SKILL.md` → Phases run as spawned agents).
- Вопрос `/clarify` — только на реальную развилку, которую issue и план не закрывают, без минимума; без развилок фаза пишет «развилок нет» в итоге и продолжает в том же спавне.
- Темы с постоянным ответом владельца не спрашиваются (вопрос вне формулировки ответа — как обычно); фаза называет применённый ответ в PR или итоге; ответ — в скилле роли: разбиение коммитов (implementer Step 6), способ мержа (tech-lead → Merge relay), доказательства мутаций (implementer Step 5 → Mutation evidence), размер PR 2 000–3 000 (architect Step 4a), оставшиеся Minor (tech-lead Phase 4).

### Переопределения глобального `~/.claude/CLAUDE.md`

При расхождении этого файла с глобальным правит этот файл; текст правок глобального файла tech-lead предлагает владельцу отдельно.
- `/clarify` — пола нет: вопрос только на реальную развилку (выше; 2026-10-23, #769).
- Стоп-пойнты коммита и PR сняты: implementer коммитит, пушит ветку и открывает PR сам (2026-09-21).
- Мерж выполняет агент — tech-lead в pipeline, `/reviewer` при прямом вызове — только после `AskUserQuestion` непосредственно перед каждым мержем; «да» не переносится на другой PR или повторный мерж; без `--admin` и bypass-флагов (2026-09-21).
- Codex — не MCP-чекпоинт, а companion-скрипт: один whole-feature pass перед мержем, планы без Codex, лимит — пропуск со строкой без вопроса; PR сессии менеджера и docs-PR аудита — без Codex (2026-10-08, 2026-10-15, #769; tech-lead → Overview → Codex).
- Модель фазы — параметр `model` спавна, не frontmatter скилла и не модель сессии (tech-lead → Models by role).

### Режим manager

Ночная автономная сессия `/manager`: решения владельца и исключения роли — `.claude/skills/manager/SKILL.md` → Правила ночи (2026-10-09, #397).

### Модели по ролям pipeline

Таблица и механизм — `.claude/skills/tech-lead/SKILL.md` → Models by role.

### Проверки

- Node — из `.node-version`: `eval "$(fnm env)" && fnm use` (под Node < 22.18 ESLint не стартует). Единая проверка — `pnpm check`, вердикт — код выхода; CI запускает её на push в `main` и на PR, кроме изменений только `.claude/**`, `audits.md` и `docs/process-decisions.md` (`.claude/skills/architect/**` CI запускает).
- Тесты — только в спавн-агентах: главный контекст (tech-lead, `/manager`) не запускает `pnpm check`, vitest, мутации и проверку коммитов, а читает итоги фаз и `gh pr checks` (tech-lead → The main context runs no tests).

### CodeGraph

- Структурные вопросы — сначала codegraph (`codegraph_context` → один `codegraph_explore`); grep — для буквального текста и двух форм, которые codegraph теряет (`obj.method()`, функция по ссылке): ноль callers не доказывает отсутствие вызовов (проверено на `trade_intents`); цепочка grep + Read вместо codegraph на структурный вопрос — отклонение.
- Индекс — дерево основной копии `/Users/user/Documents/Binarius`: изменения своей ветки в него не попадают, их читают из worktree. Перед опорой на индекс: `codegraph_status` отвечает, а `git -C <основная копия> status` и `rev-parse` показывают `main` без изменений; иначе codegraph — карта, факты — по `origin/main` (`git show`) или файлам своего worktree.
