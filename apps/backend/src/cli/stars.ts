import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { Pool } from 'pg';
import {
  DATABASE_URL_RULES,
  parseNoWhitespaceEnv,
  parseUrlEnv,
  readEnv,
  STAR_REFUND_REASON_MAX,
  StarPaymentStatus,
  starRefundReasonSchema,
} from '@binarius/shared';
import {
  createDb,
  listOpenStarRefundRequests,
  readStarPaymentByCharge,
  recordStarRefundBySystem,
  STAR_REFUND_REQUESTS_LIST_LIMIT,
  StarsRefundEvidence,
  StarsRefundSource,
  type StarRefundRecord,
} from '@binarius/db';
import { askRefund, createStarsRefundApi, type StarsRefundApi } from '../payments/star-refund';
import { formatFailure } from './kill-switch';

// Stars refunds by a staff member (#118, docs/stars.md → Refunds). `refund` asks Telegram to refund
// a charge to its payer and records it; `requests` lists what /paysupport asked for. 0 done, 1 the
// command could not be carried out, 2 not understood.
const EXIT_OK = 0;
const EXIT_FAILED = 1;
const EXIT_USAGE = 2;

const USAGE = `Возвраты Telegram Stars.

  stars refund <charge id> --reason <причина>   вернуть оплату плательщику и записать возврат
  stars requests                                 заявки на возврат из /paysupport

Причина — 1-${STAR_REFUND_REASON_MAX} символов без управляющих.`;

type Parsed = { command: 'refund'; chargeId: string; reason: string } | { command: 'requests' };

export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UsageError';
  }
}

export function parseStarsArgs(argv: readonly string[]): Parsed {
  let values: { reason?: string };
  let positionals: string[];
  try {
    ({ values, positionals } = parseArgs({
      args: [...argv],
      allowPositionals: true,
      strict: true,
      options: { reason: { type: 'string' } },
    }));
  } catch (error) {
    throw new UsageError(error instanceof Error ? error.message : String(error));
  }
  const [command, ...rest] = positionals;
  switch (command) {
    case undefined:
      throw new UsageError('нет команды');
    case 'refund': {
      const [chargeId] = rest;
      if (chargeId === undefined || chargeId === '') throw new UsageError('нужен charge id');
      if (rest.length > 1) throw new UsageError('лишние аргументы');
      if (values.reason === undefined) throw new UsageError('нужен --reason');
      const reason = starRefundReasonSchema.safeParse(values.reason);
      if (!reason.success) {
        throw new UsageError(
          `--reason: 1-${STAR_REFUND_REASON_MAX} символов без управляющих (переводов строки, табуляции)`,
        );
      }
      return { command, chargeId, reason: reason.data };
    }
    case 'requests':
      if (rest.length > 0) throw new UsageError('лишние аргументы');
      if (values.reason !== undefined) throw new UsageError('--reason не нужен для requests');
      return { command };
    default:
      throw new UsageError(`неизвестная команда: ${command}`);
  }
}

export interface StarsCliDeps {
  createApi(options: { token: string }): StarsRefundApi;
}

function describeRecord(record: StarRefundRecord, againInTelegram: boolean): string[] {
  switch (record.outcome) {
    case 'refunded':
      return [
        againInTelegram
          ? 'Оплата уже возвращена в Telegram — возврат записан.'
          : 'Возврат выполнен и записан.',
        record.fromStatus === StarPaymentStatus.Held
          ? 'Оплата была задержана: токены не начислялись, списано 0.'
          : `Токенов списано: ${record.taken.toString()}, не возвращено (потрачены или в резерве): ${record.notRecovered.toString()}. Баланс: ${record.balance.toString()}.`,
      ];
    case 'already_recorded':
      return [`Уже возвращена ${record.refundedAt.toISOString()} — второй раз не записано.`];
    // unreachable: no receiver is given, and the row was read before the call
    case 'receiver_mismatch':
    case 'not_found':
      return [`Возврат не записан: ${record.outcome}.`];
  }
}

export async function runStarsCli(
  argv: readonly string[],
  source: NodeJS.ProcessEnv,
  print: (line: string) => void,
  deps: StarsCliDeps = { createApi: createStarsRefundApi },
): Promise<number> {
  let parsed: Parsed;
  try {
    parsed = parseStarsArgs(argv);
  } catch (error) {
    print(error instanceof Error ? error.message : String(error));
    print(USAGE);
    return EXIT_USAGE;
  }

  let databaseUrl: string;
  let token = '';
  try {
    databaseUrl = parseUrlEnv(readEnv(source, 'DATABASE_URL'), 'DATABASE_URL', DATABASE_URL_RULES);
    // the public bot's: refundStarPayment is called by the bot that was paid
    if (parsed.command === 'refund') {
      token = parseNoWhitespaceEnv(readEnv(source, 'TELEGRAM_BOT_TOKEN'), 'TELEGRAM_BOT_TOKEN');
    }
  } catch (error) {
    // our own env messages name the variable, never its value
    print(error instanceof Error ? error.message : String(error));
    return EXIT_FAILED;
  }

  const pool = new Pool({ connectionString: databaseUrl });
  const db = createDb(pool);
  try {
    if (parsed.command === 'requests') {
      try {
        const { rows: requests } = await listOpenStarRefundRequests(db, {
          limit: STAR_REFUND_REQUESTS_LIST_LIMIT,
        });
        if (requests.length === 0) {
          print('Заявок нет');
          return EXIT_OK;
        }
        for (const { requestedAt, payment } of requests) {
          print(
            `${requestedAt.toISOString()}  ${payment.telegramPaymentChargeId}  ${payment.packageCode}  ${String(payment.totalAmount)} ⭐  ${payment.status}  плательщик ${payment.payerTelegramUserId.toString()}`,
          );
          print(
            `  pnpm --filter @binarius/backend stars refund ${payment.telegramPaymentChargeId} --reason "…"`,
          );
        }
        return EXIT_OK;
      } catch (error) {
        print(`Не удалось прочитать заявки: ${formatFailure(error)}.`);
        return EXIT_FAILED;
      }
    }

    // advisory: the record re-reads the row under its lock
    let payment;
    try {
      payment = await readStarPaymentByCharge(db, parsed.chargeId);
    } catch (error) {
      print(`Не удалось прочитать оплату: ${formatFailure(error)}. Telegram не вызывался.`);
      return EXIT_FAILED;
    }
    if (payment === undefined) {
      print('Оплата не найдена');
      return EXIT_FAILED;
    }
    if (payment.status === StarPaymentStatus.Refunded) {
      print(`Уже возвращена ${payment.refundedAt?.toISOString() ?? ''} — Telegram не вызывался.`);
      return EXIT_OK;
    }

    // no transaction is open across the call
    const answer = await askRefund(
      deps.createApi({ token }),
      payment.payerTelegramUserId,
      parsed.chargeId,
    );
    if (answer.kind === 'refused') {
      // Telegram's text carries no secret; the token is never printed
      print(
        `Telegram отказал в возврате: ${String(answer.errorCode)} ${answer.description}. Ничего не записано.`,
      );
      return EXIT_FAILED;
    }
    if (answer.kind === 'unknown') {
      print(
        `Исход неизвестен (${formatFailure(answer.error)}). Ничего не записано. Повторите команду: если возврат прошёл, Telegram ответит «уже возвращена», и возврат будет записан один раз; сверка тоже запишет его в течение 5 минут.`,
      );
      return EXIT_FAILED;
    }

    let record: StarRefundRecord;
    try {
      record = await db.transaction((tx) =>
        recordStarRefundBySystem(tx, {
          telegramPaymentChargeId: parsed.chargeId,
          source: StarsRefundSource.Cli,
          telegramAnswer:
            answer.kind === 'refunded'
              ? StarsRefundEvidence.Refunded
              : StarsRefundEvidence.AlreadyRefunded,
          reason: parsed.reason,
        }),
      );
    } catch (error) {
      print(
        `Возврат в Telegram выполнен, запись в БД не сделана (${formatFailure(error)}) — повторите команду (безопасно) или дождитесь сверки.`,
      );
      return EXIT_FAILED;
    }
    for (const line of describeRecord(record, answer.kind === 'already_refunded')) print(line);
    return record.outcome === 'refunded' || record.outcome === 'already_recorded'
      ? EXIT_OK
      : EXIT_FAILED;
  } finally {
    await pool.end().catch(() => undefined);
  }
}

// The module is imported by its test, so the command only runs when this file is what node was
// started with. `pnpm --filter @binarius/backend stars …` resolves to exactly that.
const entrypoint = process.argv[1];
if (entrypoint !== undefined && import.meta.url === pathToFileURL(entrypoint).href) {
  const code = await runStarsCli(process.argv.slice(2), process.env, (line) => {
    process.stdout.write(`${line}\n`);
  });
  process.exit(code);
}
