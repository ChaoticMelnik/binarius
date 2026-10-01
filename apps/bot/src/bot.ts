import { Bot, GrammyError, HttpError, InlineKeyboard, type Context } from 'grammy';
import type { User, UserFromGetMe } from 'grammy/types';
import {
  CONFIRM_CALLBACK_PATTERN,
  confirmCallbackData,
  confirmLoginRequestSchema,
  emailAddressSchema,
  emailLoginCodeSchema,
  errorLogFields,
  LinkBonusSkipReason,
  languageCodeSchema,
  OAuthErrorCode,
  startPayloadSchema,
  userStartRequestSchema,
  UserStatus,
  type EmailSendCodeResponse,
  type LinkBonusGrantView,
  type PendingBrokerAccountView,
  type UserStartRequest,
} from '@binarius/shared';
import { BackendError, type BackendClient } from './backend-client';
import { createLoginDialog, type LoginDialog, type LoginDialogState } from './login-dialog';
import { telegramErrorFields, type Logger } from './logging';
import { TEXTS } from './texts';
import { TELEGRAM_API_TIMEOUT_MS } from './timing';

// Callback data of the buttons; Bot API allows 1-64 bytes. `connect` is the main button of the
// welcome and asks for the address: buttons sent by earlier versions carry the same data and the
// same label, so they lead where the new ones do. `Изменить адрес` carries it too — changing the
// address is pressing the button again.
export const CONNECT_CALLBACK_DATA = 'connect';
export const OAUTH_CALLBACK_DATA = 'oauth';
export const RESEND_CALLBACK_DATA = 'resend';

export interface CreateBotOptions {
  token: string;
  backend: BackendClient;
  logger: Logger;
  welcomeVideoFileId?: string;
  // the two seams the tests need: a bot that must not call getMe, and a client pointed at a
  // local server so the configured timeout can be observed rather than assumed
  botInfo?: UserFromGetMe;
  apiRoot?: string;
  telegramApiTimeoutMs?: number;
  // a seam for the tests that start in the middle of the dialog
  loginDialog?: LoginDialog;
}

export function createBot({
  token,
  backend,
  logger,
  welcomeVideoFileId,
  botInfo,
  apiRoot,
  telegramApiTimeoutMs = TELEGRAM_API_TIMEOUT_MS,
  loginDialog = createLoginDialog(),
}: CreateBotOptions): Bot {
  const bot = new Bot(token, {
    ...(botInfo === undefined ? {} : { botInfo }),
    client: {
      ...(apiRoot === undefined ? {} : { apiRoot }),
      // grammY's own default is 500 s, which would leave every call above bounded by nothing
      timeoutSeconds: telegramApiTimeoutMs / 1000,
    },
  });

  const welcomeKeyboard = () =>
    new InlineKeyboard()
      .text(TEXTS.connectButton, CONNECT_CALLBACK_DATA)
      .row()
      .text(TEXTS.oauthButton, OAUTH_CALLBACK_DATA);

  const codeKeyboard = () =>
    new InlineKeyboard()
      .text(TEXTS.resendButton, RESEND_CALLBACK_DATA)
      .row()
      .text(TEXTS.changeEmailButton, CONNECT_CALLBACK_DATA);

  // Groups and channels are ignored entirely: this bot only ever talks to one person, and a
  // /start in a group would attribute a whole chat to one member's payload.
  const privateChats = bot.chatType('private');

  privateChats.command('start', async (ctx) => {
    const from = ctx.from;
    if (from === undefined) return;
    const request: UserStartRequest = { ...startRequestOf(from), ...payloadOf(ctx.match) };

    let user;
    try {
      user = await backend.recordStart(request);
    } catch (error) {
      logger.warn(
        { ...errorLogFields(error), ...backendErrorFields(error) },
        '/start not recorded',
      );
      await ctx.reply(TEXTS.unavailable);
      return;
    }

    if (user.status === UserStatus.Blocked) {
      await ctx.reply(TEXTS.blocked);
      return;
    }
    // before the active check on purpose: a link the owner of this Telegram account did not
    // make must be in front of them, not behind a "welcome back"
    if (user.pendingBrokerAccounts.length > 0) {
      await ctx.reply(TEXTS.confirmPrompt, {
        reply_markup: confirmKeyboard(user.pendingBrokerAccounts),
      });
      return;
    }
    if (user.hasActiveBrokerAccount) {
      await ctx.reply(TEXTS.welcomeBack);
      return;
    }
    await sendWelcome(ctx);
  });

  privateChats.callbackQuery(CONNECT_CALLBACK_DATA, async (ctx) => {
    loginDialog.set(ctx.from.id, { step: 'email' });
    await ctx.answerCallbackQuery().catch((error: unknown) => {
      logAnswerFailure(error);
    });
    await ctx.reply(TEXTS.emailPrompt);
  });

  privateChats.callbackQuery(OAUTH_CALLBACK_DATA, async (ctx) => {
    // the two calls are independent: the spinner on the button is worth less than the link, so
    // a rejected answerCallbackQuery ("query is too old" is the usual one) must not skip it
    const [answered, login] = await Promise.allSettled([
      ctx.answerCallbackQuery(),
      backend.startLogin(String(ctx.from.id)),
    ]);
    if (answered.status === 'rejected') {
      logger.warn(
        {
          ...errorLogFields(answered.reason),
          ...telegramErrorFields(answered.reason, 'answerCallbackQuery'),
        },
        'answering the callback query failed',
      );
    }
    if (login.status === 'rejected') {
      const error: unknown = login.reason;
      if (error instanceof BackendError && error.reason === OAuthErrorCode.UserBlocked) {
        await ctx.reply(TEXTS.blocked);
        return;
      }
      logger.warn({ ...errorLogFields(error), ...backendErrorFields(error) }, 'login not started');
      await ctx.reply(TEXTS.unavailable);
      return;
    }
    await ctx.reply(TEXTS.loginLink, {
      reply_markup: new InlineKeyboard().url(TEXTS.loginButton, login.value.authorizeUrl),
    });
  });

  privateChats.callbackQuery(CONFIRM_CALLBACK_PATTERN, async (ctx) => {
    const accountId = confirmLoginRequestSchema.shape.accountId.safeParse(ctx.match[1]);
    if (!accountId.success) {
      // the button is ours, so this is a forged or stale query: stop the spinner, say nothing
      await ctx.answerCallbackQuery().catch((error: unknown) => {
        logAnswerFailure(error);
      });
      return;
    }
    // independent, as in oauth: the outcome message matters more than the spinner
    const [answered, confirmed] = await Promise.allSettled([
      ctx.answerCallbackQuery(),
      backend.confirmLogin(String(ctx.from.id), accountId.data),
    ]);
    if (answered.status === 'rejected') logAnswerFailure(answered.reason);
    if (confirmed.status === 'fulfilled') {
      await ctx.reply(grantText(confirmed.value.grant));
      return;
    }
    const error: unknown = confirmed.reason;
    const refusal =
      error instanceof BackendError ? CONFIRM_REFUSALS[error.reason ?? ''] : undefined;
    if (refusal !== undefined) {
      await ctx.reply(refusal);
      return;
    }
    logger.warn({ ...errorLogFields(error), ...backendErrorFields(error) }, 'login not confirmed');
    await ctx.reply(TEXTS.unavailable);
  });

  privateChats.callbackQuery(RESEND_CALLBACK_DATA, async (ctx) => {
    const id = ctx.from.id;
    const state = loginDialog.get(id);
    if (state?.step !== 'code') {
      await ctx.answerCallbackQuery().catch((error: unknown) => {
        logAnswerFailure(error);
      });
      // no address yet, or no dialog at all: there is nothing to send a code to
      await ctx.reply(state === undefined ? TEXTS.codeRequestStale : TEXTS.emailPrompt);
      return;
    }
    // independent, as in confirm
    const [answered, sent] = await Promise.allSettled([
      ctx.answerCallbackQuery(),
      backend.sendEmailCode(String(id), state.email),
    ]);
    if (answered.status === 'rejected') logAnswerFailure(answered.reason);
    await replyToSendCode(ctx, id, state.email, 'code', sent);
  });

  // Registered after command('start'), which does not call next(): /start never reaches this
  // handler, so it neither feeds the dialog nor resets it. Any other command is ignored here for
  // the same reason. Text outside a dialog is ignored altogether (the owner's decision, #162).
  privateChats.on('message:text', async (ctx) => {
    const from = ctx.from;
    const text = ctx.message.text;
    if (from === undefined || text.startsWith('/')) return;
    const state = loginDialog.get(from.id);
    if (state === undefined) return;

    if (state.step === 'email') {
      const email = emailAddressSchema.safeParse(text);
      if (!email.success) {
        await ctx.reply(TEXTS.emailInvalid);
        return;
      }
      const [sent] = await Promise.allSettled([backend.sendEmailCode(String(from.id), email.data)]);
      await replyToSendCode(ctx, from.id, email.data, 'email', sent);
      return;
    }

    // whatever is typed on this step is a code, an address included: the button changes the
    // address (the owner's decision, #171)
    const code = emailLoginCodeSchema.safeParse(text);
    if (!code.success) {
      await ctx.reply(TEXTS.codeInvalid, { reply_markup: codeKeyboard() });
      return;
    }
    let login;
    try {
      login = await backend.emailLogin(String(from.id), state.email, code.data);
    } catch (error) {
      await replyToFailedLogin(ctx, from, error);
      return;
    }
    loginDialog.delete(from.id);
    await ctx.reply(grantText(login.grant));
  });

  // `step` is the step the code was asked from: the address, or «Запросить код ещё раз» on the
  // code step. The same refusal means a different thing for the dialog on each (SEND_CODE_REFUSALS).
  async function replyToSendCode(
    ctx: Context,
    id: number,
    email: string,
    step: LoginDialogState['step'],
    sent: PromiseSettledResult<EmailSendCodeResponse>,
  ): Promise<void> {
    if (sent.status === 'fulfilled') {
      loginDialog.set(id, { step: 'code', email });
      await ctx.reply(TEXTS.codeSent(email), { reply_markup: codeKeyboard() });
      return;
    }
    const error: unknown = sent.reason;
    const refusal =
      error instanceof BackendError ? SEND_CODE_REFUSALS[step][error.reason ?? ''] : undefined;
    if (refusal !== undefined) {
      await replyWithRefusal(ctx, id, refusal);
      return;
    }
    // The letter may have gone out although the answer did not come back (a timeout, a broker
    // that failed after sending, any 5xx), so the user is let type the code from it; the buttons
    // cover the case where nothing arrived.
    logger.warn({ ...errorLogFields(error), ...backendErrorFields(error) }, 'email code not sent');
    loginDialog.set(id, { step: 'code', email });
    await ctx.reply(TEXTS.codeSentUnknown(email), { reply_markup: codeKeyboard() });
  }

  async function replyWithRefusal(ctx: Context, id: number, refusal: Refusal): Promise<void> {
    if (refusal.dialog === 'end') loginDialog.delete(id);
    else if (refusal.dialog !== 'keep') loginDialog.set(id, refusal.dialog);
    await ctx.reply(
      refusal.text,
      refusal.codeKeyboard === true ? { reply_markup: codeKeyboard() } : {},
    );
  }

  // The login is irreversible and its outcome is only in its answer. An answer lost after the
  // commit (the bot's own timeout) leaves an active account behind, and the same code typed
  // again is then refused as invalid_code. So every failure but a definite refusal is checked
  // against the user's state before the user is told it failed.
  async function replyToFailedLogin(ctx: Context, from: User, error: unknown): Promise<void> {
    const refusal = error instanceof BackendError ? LOGIN_REFUSALS[error.reason ?? ''] : undefined;
    if (refusal !== undefined) {
      await replyWithRefusal(ctx, from.id, refusal);
      return;
    }
    const invalidCode =
      error instanceof BackendError && error.reason === OAuthErrorCode.InvalidCode;
    if (!invalidCode) {
      logger.warn({ ...errorLogFields(error), ...backendErrorFields(error) }, 'email login failed');
    }

    let user;
    try {
      user = await backend.recordStart(startRequestOf(from));
    } catch (recheckError) {
      // without the state, "wrong code" would be a guess
      logger.warn(
        { ...errorLogFields(recheckError), ...backendErrorFields(recheckError) },
        'email login outcome not rechecked',
      );
      await ctx.reply(TEXTS.unavailable);
      return;
    }
    if (user.status === UserStatus.Blocked) {
      loginDialog.delete(from.id);
      await ctx.reply(TEXTS.blocked);
      return;
    }
    if (user.hasActiveBrokerAccount) {
      loginDialog.delete(from.id);
      await ctx.reply(TEXTS.linkedActive);
      return;
    }
    if (invalidCode) {
      await ctx.reply(TEXTS.codeInvalid, { reply_markup: codeKeyboard() });
      return;
    }
    await ctx.reply(TEXTS.unavailable);
  }

  function logAnswerFailure(error: unknown): void {
    logger.warn(
      { ...errorLogFields(error), ...telegramErrorFields(error, 'answerCallbackQuery') },
      'answering the callback query failed',
    );
  }

  bot.catch((error) => {
    logger.error(
      {
        ...errorLogFields(error.error),
        ...telegramErrorFields(error.error),
        updateId: error.ctx.update.update_id,
      },
      'update handler failed',
    );
  });

  async function sendWelcome(ctx: Context): Promise<void> {
    const reply_markup = welcomeKeyboard();
    if (welcomeVideoFileId !== undefined) {
      try {
        await ctx.replyWithVideo(welcomeVideoFileId, { caption: TEXTS.welcome, reply_markup });
        return;
      } catch (error) {
        // Telegram answering `ok: false` means nothing was sent, so the text replaces the
        // video rather than repeating it — a file id the API refuses must not cost the user
        // the whole first screen.
        if (error instanceof GrammyError) {
          logger.warn(
            { ...errorLogFields(error), ...telegramErrorFields(error) },
            'the welcome video was refused, sending the text instead',
          );
        } else if (error instanceof HttpError) {
          // A transport failure (our own 8 s abort, a dropped socket) leaves delivery unknown,
          // and a second welcome is worse than none. It is logged here rather than in
          // bot.catch because this is the only place that still knows the method: HttpError
          // carries none, so from there the line reads like a timeout on any other call.
          logger.error(
            {
              ...errorLogFields(error),
              ...telegramErrorFields(error, 'sendVideo'),
              updateId: ctx.update.update_id,
            },
            'the welcome video call failed in transport, sending nothing more',
          );
          return;
        } else {
          // neither a refusal nor the transport: a bug or a broken plugin, which must not be
          // dressed up as a delivery problem
          throw error;
        }
      }
    }
    await ctx.reply(TEXTS.welcome, { reply_markup });
  }

  return bot;
}

// All three derived fields go through the schema of the request itself, not through a pattern
// that is half of one: a value the bot lets through and /users/start then refuses turns the
// whole /start into "service unavailable", where dropping it costs nothing the user would
// notice. A link the user did not compose is not their mistake either, so nothing is reported
// back. The name is the one field that cannot simply be dropped — it is required — so it falls
// back to the Telegram id instead: the only identity the bot is certain to have. Bot API says
// first_name is non-empty, but not that it survives a trim, so this is depth rather than dead
// code.
function displayNameOf(from: User): string {
  const parsed = userStartRequestSchema.shape.displayName.safeParse(
    [from.first_name, from.last_name].filter(Boolean).join(' '),
  );
  return parsed.success ? parsed.data : String(from.id);
}

function payloadOf(match: unknown): Pick<UserStartRequest, 'startPayload'> {
  const parsed = startPayloadSchema.safeParse(match);
  return parsed.success ? { startPayload: parsed.data } : {};
}

function languageOf(languageCode: string | undefined): Pick<UserStartRequest, 'languageCode'> {
  const parsed = languageCodeSchema.safeParse(languageCode);
  return parsed.success ? { languageCode: parsed.data } : {};
}

// What every /users/start carries apart from the payload: /start adds that one, and the recheck
// after an email login sends none.
function startRequestOf(from: User): UserStartRequest {
  return {
    telegramUserId: String(from.id),
    displayName: displayNameOf(from),
    ...languageOf(from.language_code),
  };
}

function confirmKeyboard(accounts: readonly PendingBrokerAccountView[]): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  for (const account of accounts) {
    keyboard.text(TEXTS.confirmButton(account.email), confirmCallbackData(account.id)).row();
  }
  return keyboard;
}

function grantText(grant: LinkBonusGrantView): string {
  if (grant.granted) return TEXTS.linkedWithBonus(grant.tokens);
  return grant.reason === LinkBonusSkipReason.NotPartnerClient
    ? TEXTS.linkedNoBonusNotPartner
    : TEXTS.linkedNoBonusAlready;
}

// the refusals the user can act on; anything else is an outage to them
const CONFIRM_REFUSALS: Partial<Record<string, string>> = {
  [OAuthErrorCode.BrokerAccountNotFound]: TEXTS.confirmNotFound,
  [OAuthErrorCode.AccountNotPending]: TEXTS.confirmAlreadyDone,
  [OAuthErrorCode.UserBlocked]: TEXTS.blocked,
};

// What a refusal says and what it does to the dialog: end it, keep it as it is (its TTL too), or
// move it to the given state. `codeKeyboard` puts the code step's buttons under the text.
interface Refusal {
  text: string;
  dialog: 'end' | 'keep' | LoginDialogState;
  codeKeyboard?: true;
}

// The two 429s are different limits (apps/backend/src/auth/routes.ts). too_many_requests is the
// route's ceiling across all users, checked before anything else: no letter, no slot of this
// user's, no code spent, so the step stays. too_many_attempts is this user's or this address's
// own allowance for the next minutes, so asking for an address again is pointless — but a code
// already sent stays good, which is why a refused «Запросить код ещё раз» keeps the code step.
// Anything not listed is an unknown outcome (replyToSendCode).
const SEND_CODE_REFUSALS: Record<LoginDialogState['step'], Partial<Record<string, Refusal>>> = {
  email: {
    [OAuthErrorCode.InvalidEmail]: { text: TEXTS.emailRefused, dialog: { step: 'email' } },
    [OAuthErrorCode.TooManyRequests]: { text: TEXTS.sendCodeBusy, dialog: 'keep' },
    [OAuthErrorCode.TooManyAttempts]: { text: TEXTS.tooManyCodeRequests, dialog: 'end' },
    [OAuthErrorCode.UserBlocked]: { text: TEXTS.blocked, dialog: 'end' },
  },
  code: {
    [OAuthErrorCode.InvalidEmail]: { text: TEXTS.emailRefused, dialog: { step: 'email' } },
    [OAuthErrorCode.TooManyRequests]: {
      text: TEXTS.resendRefused,
      dialog: 'keep',
      codeKeyboard: true,
    },
    [OAuthErrorCode.TooManyAttempts]: {
      text: TEXTS.resendRefused,
      dialog: 'keep',
      codeKeyboard: true,
    },
    [OAuthErrorCode.UserBlocked]: { text: TEXTS.blocked, dialog: 'end' },
  },
};

// The login refusals that are definite, so no recheck. invalid_code is not one of them — a lost
// answer turns into it on the retry. too_many_requests is the route's ceiling, refused before
// the broker saw the code, so the code is still good and the step stays.
const LOGIN_REFUSALS: Partial<Record<string, Refusal>> = {
  [OAuthErrorCode.TooManyAttempts]: { text: TEXTS.tooManyCodeAttempts, dialog: 'end' },
  [OAuthErrorCode.TooManyRequests]: { text: TEXTS.loginBusy, dialog: 'keep', codeKeyboard: true },
  [OAuthErrorCode.UserBlocked]: { text: TEXTS.blocked, dialog: 'end' },
  [OAuthErrorCode.BrokerAccountTaken]: { text: TEXTS.accountTaken, dialog: 'end' },
};

function backendErrorFields(error: unknown): { backendStatus?: number; backendReason?: string } {
  if (!(error instanceof BackendError)) return {};
  return { backendStatus: error.status, backendReason: error.reason };
}
