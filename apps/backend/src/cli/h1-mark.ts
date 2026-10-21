import { listH1Accounts, setH1Mark, type Db, type H1MarkResult } from '@binarius/db';

// `h1 mark|unmark|list` (#670, docs/h1.md → Sessions): the account's H1 mark, without which
// `h1 session start` creates nothing. setH1Mark is the one writer; the audit row is its own.
export type H1MarkCommand =
  { kind: 'mark'; accountId: string } | { kind: 'unmark'; accountId: string } | { kind: 'list' };

const EXIT_OK = 0;
const EXIT_FAILED = 1;

// every outcome of setH1Mark, its exit code and its line; a result added later fails tsc here
const MARK_LINES = {
  marked: [EXIT_OK, 'аккаунт помечен для сессий H1'],
  unmarked: [EXIT_OK, 'метка H1 снята'],
  unchanged: [EXIT_OK, 'без изменений: метка уже такая'],
  not_found: [EXIT_FAILED, 'аккаунт брокера не найден'],
  active_session: [
    EXIT_FAILED,
    'у аккаунта активная сессия H1: сначала h1 session stop --account <accountId>',
  ],
} as const satisfies Record<H1MarkResult, readonly [number, string]>;

export async function runH1MarkCommand(
  db: Db,
  command: H1MarkCommand,
  out: (text: string) => void,
  err: (line: string) => void,
): Promise<number> {
  if (command.kind === 'list') {
    const accounts = await listH1Accounts(db);
    if (accounts.length === 0) {
      err('помеченных аккаунтов нет');
      return EXIT_OK;
    }
    for (const account of accounts) {
      out(
        `${[
          account.id,
          account.h1Since.toISOString(),
          account.status,
          account.tradingHalted ? 'halted' : '-',
          account.telegramUserId,
          account.tradingMode,
          account.activeSessionId ?? '-',
        ].join('\t')}\n`,
      );
    }
    err(`аккаунтов: ${accounts.length}`);
    return EXIT_OK;
  }
  const { accountId } = command;
  const result = await db.transaction((tx) =>
    setH1Mark(tx, { accountId, h1: command.kind === 'mark' }),
  );
  const [code, line] = MARK_LINES[result];
  err(line.replace('<accountId>', accountId));
  return code;
}
