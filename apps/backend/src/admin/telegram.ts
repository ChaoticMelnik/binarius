import { Bot, InlineKeyboard, type Bot as GrammyBot } from 'grammy';
import type { UserFromGetMe } from 'grammy/types';
import { errorIdentity, errorLogFields } from '@binarius/shared';
import {
  confirmChallengeFromTelegram,
  denyChallengeFromTelegram,
  failChallengeDelivery,
  markChallengeCodeSent,
  StaffLoginChallengeStatus,
  type Db,
} from '@binarius/db';
import {
  ADMIN_POLLING_BATCH_LIMIT,
  ADMIN_POLLING_TIMEOUT_S,
  ADMIN_TELEGRAM_API_TIMEOUT_MS,
} from '../timing';
import { telegramErrorFields } from './telegram-logging';
import { ADMIN_TEXTS } from './texts';

// Only the kinds this bot handles; Telegram then stops delivering the rest.
export const ADMIN_ALLOWED_UPDATES = ['message', 'callback_query'] as const;

// The id in the button carries no authority: every transition joins `staff` on the Telegram
// account the update arrived from, so a callback replayed from elsewhere matches no row.
export const CONFIRM_CALLBACK_PATTERN = /^sl:c:([0-9a-f-]{36})$/;
export const DENY_CALLBACK_PATTERN = /^sl:d:([0-9a-f-]{36})$/;
export const confirmCallbackData = (challengeId: string): string => `sl:c:${challengeId}`;
export const denyCallbackData = (challengeId: string): string => `sl:d:${challengeId}`;

export type Logger = {
  info(object: unknown, message?: string): void;
  warn(object: unknown, message?: string): void;
  error(object: unknown, message?: string): void;
};

export interface LoginPrompt {
  challengeId: string;
  telegramUserId: bigint;
  login: string;
  ip: string;
  userAgent: string;
}

/** What POST /admin/auth/login needs from the bot, and all it is allowed to reach. */
export interface AdminTelegram {
  /** false while long polling is not running: the second factor cannot arrive, so a login
   *  must be refused rather than left waiting for a button nobody will see. */
  isPolling(): boolean;
  /** Throws when Telegram would not take the message; the caller closes the challenge. */
  sendLoginPrompt(prompt: LoginPrompt): Promise<void>;
}

export interface AdminBot extends AdminTelegram {
  start(): void;
  stop(): Promise<void>;
  readonly bot: GrammyBot;
}

export interface CreateAdminBotOptions {
  token: string;
  db: Db;
  logger: Logger;
  // the seams the tests need: a bot that must not call getMe, and a client pointed somewhere
  // local so the configured timeout can be observed rather than assumed
  botInfo?: UserFromGetMe;
  apiRoot?: string;
  telegramApiTimeoutMs?: number;
}

export function createAdminBot({
  token,
  db,
  logger,
  botInfo,
  apiRoot,
  telegramApiTimeoutMs = ADMIN_TELEGRAM_API_TIMEOUT_MS,
}: CreateAdminBotOptions): AdminBot {
  const bot = new Bot(token, {
    ...(botInfo === undefined ? {} : { botInfo }),
    client: {
      ...(apiRoot === undefined ? {} : { apiRoot }),
      // grammY's own default is 500 s, which would leave every call below bounded by nothing
      timeoutSeconds: telegramApiTimeoutMs / 1000,
    },
  });

  // One person per chat. A group would make "the account this update came from" ambiguous, and
  // this bot's whole authority argument rests on that being unambiguous.
  const privateChats = bot.chatType('private');

  privateChats.command('start', async (ctx) => {
    if (ctx.from === undefined) return;
    // ctx.from.id, not the staff row: this answers before anyone has an account, which is what
    // makes it useful — it is how the operator learns the id to create the account with.
    await ctx.reply(ADMIN_TEXTS.start(String(ctx.from.id)));
  });

  privateChats.callbackQuery(CONFIRM_CALLBACK_PATTERN, async (ctx) => {
    const challengeId = ctx.match[1];
    if (challengeId === undefined) return;
    const confirmed = await confirmChallengeFromTelegram(db, {
      challengeId,
      telegramUserId: BigInt(ctx.from.id),
    });
    if (confirmed === undefined) {
      // no row: another account's button, an expired window, or a code already delivered. No
      // audit entry — nothing happened, and a row here would be a record of someone else's id.
      logger.info({ challengeId }, 'a staff login confirmation matched no open challenge');
      await ctx.answerCallbackQuery(ADMIN_TEXTS.stale);
      return;
    }

    // independent: the spinner on the button is worth less than the code, so a rejected
    // answerCallbackQuery ("query is too old" is the usual one) must not skip the message
    const [answered, sent] = await Promise.allSettled([
      ctx.answerCallbackQuery(ADMIN_TEXTS.confirmed),
      ctx.reply(ADMIN_TEXTS.code(confirmed.code)),
    ]);
    if (answered.status === 'rejected') {
      logger.warn(
        {
          ...errorLogFields(answered.reason),
          ...telegramErrorFields(answered.reason, 'answerCallbackQuery'),
        },
        'answering the staff login callback failed',
      );
    }
    if (sent.status === 'rejected') {
      const error: unknown = sent.reason;
      logger.warn(
        { ...errorLogFields(error), ...telegramErrorFields(error, 'sendMessage'), challengeId },
        'the staff login code could not be delivered',
      );
      // the code exists and nobody has it: closing the challenge is what lets the staff member
      // start again now instead of waiting the window out
      await failChallengeDelivery(db, {
        challengeId,
        staffId: confirmed.staffId,
        from: StaffLoginChallengeStatus.Confirmed,
        reason: 'code_send_failed',
        err: errorIdentity(error),
        telegram: { ...telegramErrorFields(error, 'sendMessage') },
      });
      return;
    }
    await markChallengeCodeSent(db, challengeId);
  });

  privateChats.callbackQuery(DENY_CALLBACK_PATTERN, async (ctx) => {
    const challengeId = ctx.match[1];
    if (challengeId === undefined) return;
    const denied = await denyChallengeFromTelegram(db, {
      challengeId,
      telegramUserId: BigInt(ctx.from.id),
    });
    if (denied === undefined) {
      logger.info({ challengeId }, 'a staff login denial matched no open challenge');
      await ctx.answerCallbackQuery(ADMIN_TEXTS.stale);
      return;
    }
    // someone had the password: the entry is in audit_log, and this is the line an operator
    // watching the log sees
    logger.warn(
      { challengeId, staffId: denied.staffId, ip: denied.ip },
      'a staff login was denied from Telegram',
    );
    await ctx.answerCallbackQuery(ADMIN_TEXTS.denied);
  });

  bot.catch((error) => {
    logger.error(
      { ...errorLogFields(error.error), ...telegramErrorFields(error.error) },
      'the staff login bot failed to handle an update',
    );
  });

  let polling = false;
  let settled: Promise<unknown> = Promise.resolve();

  return {
    bot,
    isPolling: () => polling,

    start() {
      const started = bot.start({
        timeout: ADMIN_POLLING_TIMEOUT_S,
        limit: ADMIN_POLLING_BATCH_LIMIT,
        allowed_updates: [...ADMIN_ALLOWED_UPDATES],
        onStart: () => {
          polling = true;
          logger.info({}, 'staff login bot started');
        },
      });
      // A handled promise, kept for the drain. The staff bot is not the process: an invalid
      // token (getMe answers 401, which grammY does not retry) must not take the backend down
      // with it — every login then answers 503 and says so in audit_log.
      settled = started.catch((error: unknown) => {
        polling = false;
        logger.error(
          { ...errorLogFields(error), ...telegramErrorFields(error, 'getMe') },
          'the staff login bot stopped polling',
        );
      });
    },

    async stop() {
      polling = false;
      await bot.stop();
      await settled;
    },

    async sendLoginPrompt({ challengeId, telegramUserId, login, ip, userAgent }) {
      await bot.api.sendMessage(
        // chat_id is `number | string` in the Bot API: a Telegram id above 2^53 survives the trip
        // from the CLI's bigint as a string and gets rounded into someone else's chat as a number
        String(telegramUserId),
        ADMIN_TEXTS.prompt({ login, ip, userAgent, at: new Date().toISOString() }),
        {
          reply_markup: new InlineKeyboard()
            .text(ADMIN_TEXTS.confirmButton, confirmCallbackData(challengeId))
            .text(ADMIN_TEXTS.denyButton, denyCallbackData(challengeId)),
        },
      );
    },
  };
}
