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
  type TelegramHtml,
  type UserStartRequest,
} from '@binarius/shared';
import { BackendError, BackendErrorCode, type BackendClient } from './backend-client';
import { createLoginDialog, type LoginDialog, type LoginDialogState } from './login-dialog';
import { telegramErrorFields, type Logger } from './logging';
import { replyHtml, replyWithVideoHtml } from './send';
import { LABELS, TEXTS } from './texts';
import { TELEGRAM_API_TIMEOUT_MS } from './timing';

// Callback data of the buttons; Bot API allows 1-64 bytes. `connect` is the main button of the
// welcome and asks for the address: buttons sent by earlier versions carry the same data, so they
// lead where the new ones do, though an old message may still show an older label. `✏️ Изменить
// адрес` carries it too — changing the address is pressing the button again.
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
      .text(LABELS.connectButton, CONNECT_CALLBACK_DATA)
      .row()
      .text(LABELS.oauthButton, OAUTH_CALLBACK_DATA);

  const codeKeyboard = () =>
    new InlineKeyboard()
      .text(LABELS.resendButton, RESEND_CALLBACK_DATA)
      .row()
      .text(LABELS.changeEmailButton, CONNECT_CALLBACK_DATA);

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
      await replyHtml(ctx, TEXTS.unavailable);
      return;
    }

    if (user.status === UserStatus.Blocked) {
      await replyHtml(ctx, TEXTS.blocked);
      return;
    }
    // before the active check on purpose: a link the owner of this Telegram account did not
    // make must be in front of them, not behind a "welcome back"
    if (user.pendingBrokerAccounts.length > 0) {
      await replyHtml(ctx, TEXTS.confirmPrompt, {
        reply_markup: confirmKeyboard(user.pendingBrokerAccounts),
      });
      return;
    }
    if (user.hasActiveBrokerAccount) {
      await replyHtml(ctx, TEXTS.welcomeBack);
      return;
    }
    await sendWelcome(ctx);
  });

  privateChats.callbackQuery(CONNECT_CALLBACK_DATA, async (ctx) => {
    loginDialog.set(ctx.from.id, { step: 'email' });
    await ctx.answerCallbackQuery().catch((error: unknown) => {
      logAnswerFailure(error);
    });
    await replyHtml(ctx, TEXTS.emailPrompt);
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
        await replyHtml(ctx, TEXTS.blocked);
        return;
      }
      logger.warn({ ...errorLogFields(error), ...backendErrorFields(error) }, 'login not started');
      await replyHtml(ctx, TEXTS.unavailable);
      return;
    }
    const { authorizeUrl, miniAppUrl } = login.value;
    // The Mini App carries the signed launch data the callback needs (#113). Telegram takes only
    // https in a web_app button, so the backend sends no Mini App URL for the local stack's
    // http loopback redirect, and the plain link is what is left there.
    await replyHtml(ctx, TEXTS.loginLink, {
      reply_markup:
        miniAppUrl === undefined
          ? new InlineKeyboard().url(LABELS.loginButton, authorizeUrl)
          : new InlineKeyboard().webApp(LABELS.loginButton, miniAppUrl),
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
      await replyHtml(ctx, grantText(confirmed.value.grant));
      return;
    }
    const error: unknown = confirmed.reason;
    const refusal =
      error instanceof BackendError ? CONFIRM_REFUSALS[error.reason ?? ''] : undefined;
    if (refusal !== undefined) {
      await replyHtml(ctx, refusal);
      return;
    }
    logger.warn({ ...errorLogFields(error), ...backendErrorFields(error) }, 'login not confirmed');
    await replyHtml(ctx, TEXTS.unavailable);
  });

  privateChats.callbackQuery(RESEND_CALLBACK_DATA, async (ctx) => {
    const id = ctx.from.id;
    const state = loginDialog.get(id);
    if (state?.step !== 'code') {
      await ctx.answerCallbackQuery().catch((error: unknown) => {
        logAnswerFailure(error);
      });
      // no address yet, or no dialog at all: there is nothing to send a code to
      await replyHtml(ctx, state === undefined ? TEXTS.codeRequestStale : TEXTS.emailPrompt);
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
        await replyHtml(ctx, TEXTS.emailInvalid);
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
      await replyHtml(ctx, TEXTS.codeInvalid, { reply_markup: codeKeyboard() });
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
    await replyHtml(ctx, grantText(login.grant));
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
      await replyHtml(ctx, TEXTS.codeSent(email), { reply_markup: codeKeyboard() });
      return;
    }
    const error: unknown = sent.reason;
    const refusal =
      error instanceof BackendError ? SEND_CODE_REFUSALS[step][error.reason ?? ''] : undefined;
    if (refusal !== undefined) {
      await replyWithRefusal(ctx, id, refusal);
      return;
    }
    logger.warn({ ...errorLogFields(error), ...backendErrorFields(error) }, 'email code not sent');
    // A refusal before the letter: the step stays as it was, and on the code step the code
    // already sent is still good, so its buttons stay under the text.
    if (refusedBeforeSending(error)) {
      await replyWithRefusal(ctx, id, {
        text: TEXTS.unavailable,
        dialog: 'keep',
        ...(step === 'code' ? { codeKeyboard: true as const } : {}),
      });
      return;
    }
    // The letter may have gone out although the answer did not come back (a timeout, a broker
    // that failed after sending, any 5xx, a broken 2xx body), so the user is let type the code
    // from it; the buttons cover the case where nothing arrived.
    loginDialog.set(id, { step: 'code', email });
    await replyHtml(ctx, TEXTS.codeSentUnknown(email), { reply_markup: codeKeyboard() });
  }

  async function replyWithRefusal(ctx: Context, id: number, refusal: Refusal): Promise<void> {
    if (refusal.dialog === 'end') loginDialog.delete(id);
    else if (refusal.dialog !== 'keep') loginDialog.set(id, refusal.dialog);
    await replyHtml(
      ctx,
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
      await replyHtml(ctx, TEXTS.unavailable);
      return;
    }
    if (user.status === UserStatus.Blocked) {
      loginDialog.delete(from.id);
      await replyHtml(ctx, TEXTS.blocked);
      return;
    }
    if (user.hasActiveBrokerAccount) {
      loginDialog.delete(from.id);
      await replyHtml(ctx, TEXTS.linkedActive);
      return;
    }
    if (invalidCode) {
      await replyHtml(ctx, TEXTS.codeInvalid, { reply_markup: codeKeyboard() });
      return;
    }
    await replyHtml(ctx, TEXTS.unavailable);
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
        await replyWithVideoHtml(ctx, welcomeVideoFileId, TEXTS.welcome, { reply_markup });
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
    await replyHtml(ctx, TEXTS.welcome, { reply_markup });
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
    keyboard.text(LABELS.confirmButton(account.email), confirmCallbackData(account.id)).row();
  }
  return keyboard;
}

function grantText(grant: LinkBonusGrantView): TelegramHtml {
  if (grant.granted) return TEXTS.linkedWithBonus(grant.tokens);
  return grant.reason === LinkBonusSkipReason.NotPartnerClient
    ? TEXTS.linkedNoBonusNotPartner
    : TEXTS.linkedNoBonusAlready;
}

// the refusals the user can act on; anything else is an outage to them
const CONFIRM_REFUSALS: Partial<Record<string, TelegramHtml>> = {
  [OAuthErrorCode.BrokerAccountNotFound]: TEXTS.confirmNotFound,
  [OAuthErrorCode.AccountNotPending]: TEXTS.confirmAlreadyDone,
  [OAuthErrorCode.UserBlocked]: TEXTS.blocked,
};

// What a refusal says and what it does to the dialog: end it, keep it as it is (its TTL too), or
// move it to the given state. `codeKeyboard` puts the code step's buttons under the text.
interface Refusal {
  text: TelegramHtml;
  dialog: 'end' | 'keep' | LoginDialogState;
  codeKeyboard?: true;
}

// The two 429s are different limits (apps/backend/src/auth/routes.ts). too_many_requests is the
// route's ceiling across all users, checked before anything else: no letter, no slot of this
// user's, no code spent, so the step stays. too_many_attempts is this user's or this address's
// own allowance for the next minutes, so asking for an address again is pointless — but a code
// already sent stays good, which is why a refused «Запросить код ещё раз» keeps the code step.
// Anything not listed is either a refusal before the letter (a sub-500 status) or an unknown
// outcome (replyToSendCode).
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

// The backend answers a 4xx on send-code only before the broker is called, or for the broker's
// own refusal of the address (apps/backend/src/auth/routes.ts: the ceiling, the body, the blocked
// check and the windows all come before the broker; brokerOutcome maps only invalid_grant to a
// 400). So a sub-500 status means no letter went out. No answer, a 5xx and a broken 2xx body
// leave that open.
const refusedBeforeSending = (error: unknown): boolean =>
  error instanceof BackendError &&
  error.code === BackendErrorCode.HttpStatus &&
  error.status !== undefined &&
  error.status < 500;

function backendErrorFields(error: unknown): { backendStatus?: number; backendReason?: string } {
  if (!(error instanceof BackendError)) return {};
  return { backendStatus: error.status, backendReason: error.reason };
}
