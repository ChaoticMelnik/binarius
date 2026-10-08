import { Bot, GrammyError, HttpError, InlineKeyboard, InputFile, type Context } from 'grammy';
import type { Message, User, UserFromGetMe } from 'grammy/types';
import {
  BrokerAccountStatus,
  BrokerBalanceUnavailableReason,
  CONFIRM_CALLBACK_PATTERN,
  confirmCallbackData,
  confirmLoginRequestSchema,
  emailAddressSchema,
  emailLoginCodeSchema,
  errorLogFields,
  isPendingLink,
  languageCodeSchema,
  NotificationLevel,
  notificationLevelSchema,
  OAuthErrorCode,
  startPayloadSchema,
  TelegramChatMemberStatus,
  TradeMode,
  userStartRequestSchema,
  UserErrorCode,
  UserStatus,
  type BotStaticHtmlKey,
  type DecimalString,
  type EmailSendCodeResponse,
  type LinkedAccountView,
  type PendingBrokerAccountView,
  type UserStartRequest,
  COMMAND_RETRY_PATTERN,
  CONNECT_CALLBACK_DATA,
  DEMO_CALLBACK_DATA,
  MENU_CALLBACK_DATA,
  RETRY_COMMANDS,
  supportUrl,
} from '@binarius/shared';
import { ACCOUNT_CARD_PHOTO_PATH } from './assets';
import {
  BackendError,
  BackendErrorCode,
  backendErrorFields,
  type BackendClient,
} from './backend-client';
import { BOT_COMMANDS } from './commands';
import { createDemoComposer, removeLegacyKeyboard } from './demo';
import { createDemoTradeComposer } from './demo-trade';
import { createTradingSessionComposer } from './trading-session';
import type { IntentTracker } from './intent-tracker';
import {
  createLoginDialog,
  type LoginDialog,
  type LoginDialogState,
  type LoginStep,
} from './login-dialog';
import { telegramErrorFields, type Logger } from './logging';
import type { SessionTracker } from './session-tracker';
import { editRefusal } from './screen';
import { createStakePicker, SETTINGS_CALLBACK_DATA, stakeOpenCallbackData } from './stake-picker';
import { editMessageTextHtml, replyHtml, replyWithPhotoHtml, replyWithVideoHtml } from './send';
import {
  accountCard,
  accountStatus,
  currentLevelLabel,
  helpText,
  LABELS,
  levelLabel,
  settingsText,
  statusCard,
  TEXTS,
  textOf,
  type AccountCardInput,
} from './texts';
import { TELEGRAM_API_TIMEOUT_MS } from './timing';

// Callback data of the buttons; Bot API allows 1-64 bytes. `connect` is shared with the backend's
// pushes (bot-navigation.ts). `oauth` was the site sign-in under the welcome and /account; #314 hid
// it, and an old one only loses its keyboard.
export const OAUTH_CALLBACK_DATA = 'oauth';
export const RESEND_CALLBACK_DATA = 'resend';
// The /settings buttons (#120): `level:<level>` sets it; the selected one carries
// `level:current` and only stops the spinner. The longest, `level:reduced`, is 13 bytes.
export const LEVEL_CALLBACK_PREFIX = 'level:';
export const levelCallbackData = (level: NotificationLevel): string =>
  `${LEVEL_CALLBACK_PREFIX}${level}`;
export const LEVEL_CURRENT_CALLBACK_DATA = `${LEVEL_CALLBACK_PREFIX}current`;
const LEVEL_CALLBACK_PATTERN = new RegExp(
  `^${LEVEL_CALLBACK_PREFIX}(${Object.values(NotificationLevel).join('|')})$`,
);

interface RichSend {
  send: () => Promise<Message>;
  method: 'sendVideo' | 'sendPhoto';
  what: string;
}

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
  // the clock the demo compares a pair's schedule with
  now?: () => number;
  // follows each demo trade's status message (#127); required, so no test arms timers unasked
  intentTracker: Pick<IntentTracker, 'track'>;
  // follows each demo session's status message (#284); required for the same reason
  sessionTracker: Pick<SessionTracker, 'track'>;
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
  now = Date.now,
  intentTracker,
  sessionTracker,
}: CreateBotOptions): Bot {
  const bot = new Bot(token, {
    ...(botInfo === undefined ? {} : { botInfo }),
    client: {
      ...(apiRoot === undefined ? {} : { apiRoot }),
      // grammY's own default is 500 s, which would leave every call above bounded by nothing
      timeoutSeconds: telegramApiTimeoutMs / 1000,
    },
  });

  const welcomeKeyboard = () => addConnectButtons(new InlineKeyboard());

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
    await answerHome(ctx, from, { ...startRequestOf(from), ...payloadOf(ctx.match) }, '/start');
  });

  // The bot's home on demand (#24): /start's path without a payload — the request /settings
  // sends — so /menu never spends the acquisition slot.
  privateChats.command('menu', async (ctx) => {
    const from = ctx.from;
    if (from === undefined) return;
    await answerHome(ctx, from, startRequestOf(from), '/menu');
  });

  // «🏠 В меню» (#350): /menu's path, but the card is not pinned. The answer and the pin would put
  // the path at the shutdown budget (timing.ts); the card pinned stays the last /start or /menu.
  privateChats.callbackQuery(MENU_CALLBACK_DATA, async (ctx) => {
    await ctx.answerCallbackQuery().catch(logAnswerFailure);
    await answerHome(ctx, ctx.from, startRequestOf(ctx.from), 'the menu button', { pin: false });
  });

  // «🔄 Повторить» under a command's failure (#350): the command again
  privateChats.callbackQuery(COMMAND_RETRY_PATTERN, async (ctx) => {
    await ctx.answerCallbackQuery().catch(logAnswerFailure);
    const command = RETRY_COMMANDS.find((name) => name === ctx.match[1]);
    switch (command) {
      case 'account':
        await showAccount(ctx, ctx.from);
        return;
      case 'settings':
        await showSettingsCommand(ctx, ctx.from);
        return;
      case undefined:
        return;
      default:
        return command satisfies never;
    }
  });

  // /start, /menu and «🏠 В меню»: blocked, then a waiting link, then the status card for an
  // active account, otherwise the welcome. `command` only names the warn line.
  async function answerHome(
    ctx: Context,
    from: User,
    request: UserStartRequest,
    command: '/start' | '/menu' | 'the menu button',
    { pin }: { pin: boolean } = { pin: true },
  ): Promise<void> {
    let user;
    try {
      user = await backend.recordStart(request);
    } catch (error) {
      logger.warn(
        { ...errorLogFields(error), ...backendErrorFields(error) },
        `${command} not recorded`,
      );
      await replyHtml(ctx, TEXTS.unavailable);
      return;
    }

    if (user.status === UserStatus.Blocked) {
      await replyHtml(ctx, TEXTS.blocked);
      return;
    }
    // before the active check on purpose: a link the owner of this Telegram account did not
    // make must be in front of them, not behind the status card
    if (user.pendingBrokerAccounts.length > 0) {
      await replyHtml(ctx, TEXTS.confirmPrompt, {
        reply_markup: confirmKeyboard(user.pendingBrokerAccounts),
      });
      return;
    }
    if (user.hasActiveBrokerAccount) {
      await sendStatusCard(ctx, from, pin);
      return;
    }
    await sendWelcome(ctx);
  }

  // The numbers are read on every /start and /menu and cached nowhere, so the card is at most
  // the backend's freshness SLA old or says how old it is (docs/bot-menu.md).
  async function sendStatusCard(ctx: Context, from: User, pin: boolean): Promise<void> {
    let access;
    try {
      access = await backend.readTradingAccess(String(from.id));
    } catch (error) {
      // user_not_found included: /users/start has just upserted the row, so it is not "no
      // account" but a backend that contradicts itself
      logger.warn(
        { ...errorLogFields(error), ...backendErrorFields(error) },
        'trading access not read',
      );
      await replyHtml(ctx, TEXTS.unavailable);
      return;
    }
    if (access.status === UserStatus.Blocked) {
      await replyHtml(ctx, TEXTS.blocked);
      return;
    }
    // revoked between the two calls: what /account shows with nothing active
    if (access.brokerUnavailable === BrokerBalanceUnavailableReason.NoAccount) {
      await replyHtml(ctx, TEXTS.accountNone, { reply_markup: welcomeKeyboard() });
      return;
    }
    const card = statusCard({
      mode: TradeMode.Demo,
      tokens: access.tokens,
      broker: access.broker,
      brokerUnavailable: access.brokerUnavailable,
    });
    const reply_markup = new InlineKeyboard().text(LABELS.demoButton, DEMO_CALLBACK_DATA);
    const sent = await sendWithTextFallback(
      ctx,
      {
        send: () =>
          replyWithPhotoHtml(ctx, new InputFile(ACCOUNT_CARD_PHOTO_PATH), card, { reply_markup }),
        method: 'sendPhoto',
        what: 'the status card photo',
      },
      () => replyHtml(ctx, card, { reply_markup }),
    );
    if (sent === undefined || !pin) return;
    await pinCard(ctx, sent.message_id, 'the status card');
  }

  // Reads only: the users row is not refreshed and nothing is recorded, so the row is written only
  // through /users/start (/start, /menu and /settings).
  privateChats.command('account', async (ctx) => {
    const from = ctx.from;
    if (from === undefined) return;
    await showAccount(ctx, from);
  });

  async function showAccount(ctx: Context, from: User): Promise<void> {
    let user;
    try {
      user = await backend.readAccount(String(from.id));
    } catch (error) {
      // no users row yet (the backend was down on /start): nothing is connected, and that is an
      // answer, not a failure. Decided by the code, not the status: a bare 404 is a backend
      // without the route.
      if (error instanceof BackendError && error.reason === UserErrorCode.UserNotFound) {
        await replyHtml(ctx, TEXTS.accountNone, { reply_markup: welcomeKeyboard() });
        return;
      }
      logger.warn({ ...errorLogFields(error), ...backendErrorFields(error) }, '/account not read');
      await replyHtml(ctx, TEXTS.unavailable);
      return;
    }

    if (user.status === UserStatus.Blocked) {
      await replyHtml(ctx, TEXTS.blocked);
      return;
    }
    const keyboard = accountKeyboard(user.accounts);
    await replyHtml(
      ctx,
      accountStatus(user.accounts),
      keyboard === undefined ? undefined : { reply_markup: keyboard },
    );
  }

  // The level comes from /users/start, the call /start already makes: it creates a missing row,
  // so /settings works before the first /start too (#120).
  privateChats.command('settings', async (ctx) => {
    const from = ctx.from;
    if (from === undefined) return;
    await showSettingsCommand(ctx, from);
  });

  async function showSettingsCommand(ctx: Context, from: User): Promise<void> {
    let user;
    try {
      user = await backend.recordStart(startRequestOf(from));
    } catch (error) {
      logger.warn({ ...errorLogFields(error), ...backendErrorFields(error) }, '/settings not read');
      await replyHtml(ctx, TEXTS.unavailable);
      return;
    }
    if (user.status === UserStatus.Blocked) {
      await replyHtml(ctx, TEXTS.blocked);
      return;
    }
    await replyHtml(ctx, settingsText(user.notificationLevel, user.demoStake), {
      reply_markup: levelKeyboard(user.notificationLevel),
    });
  }

  // The stake picker's way back (#297): /settings' own read, then the message in place of the
  // picker.
  privateChats.callbackQuery(SETTINGS_CALLBACK_DATA, async (ctx) => {
    // independent, as in confirm
    const [answered, read] = await Promise.allSettled([
      ctx.answerCallbackQuery(),
      backend.recordStart(startRequestOf(ctx.from)),
    ]);
    if (answered.status === 'rejected') logAnswerFailure(answered.reason);
    if (read.status === 'rejected') {
      logger.warn(
        { ...errorLogFields(read.reason), ...backendErrorFields(read.reason) },
        '/settings not read',
      );
      await replyHtml(ctx, TEXTS.unavailable);
      return;
    }
    if (read.value.status === UserStatus.Blocked) {
      await replyHtml(ctx, TEXTS.blocked);
      return;
    }
    await showSettings(ctx, read.value.notificationLevel, read.value.demoStake);
  });

  privateChats.callbackQuery(LEVEL_CALLBACK_PATTERN, async (ctx) => {
    // the pattern is built from Object.values(NotificationLevel), so a mismatch is a bug for
    // bot.catch
    const level = notificationLevelSchema.parse(ctx.match[1]);
    // independent, as in confirm
    const [answered, set] = await Promise.allSettled([
      ctx.answerCallbackQuery(),
      backend.setNotificationLevel(String(ctx.from.id), level),
    ]);
    if (answered.status === 'rejected') logAnswerFailure(answered.reason);
    if (set.status === 'rejected') {
      // no error code is acted on: the keyboard stays, so pressing again is the retry
      logger.warn(
        { ...errorLogFields(set.reason), ...backendErrorFields(set.reason) },
        'notification level not set',
      );
      await replyHtml(ctx, TEXTS.unavailable);
      return;
    }
    await showSettings(ctx, set.value.level, set.value.demoStake);
  });

  privateChats.callbackQuery(LEVEL_CURRENT_CALLBACK_DATA, async (ctx) => {
    await ctx.answerCallbackQuery().catch((error: unknown) => {
      logAnswerFailure(error);
    });
  });

  // No backend call: the way to a person works for a blocked user and during an outage too.
  privateChats.command('support', async (ctx) => {
    await replyHtml(ctx, TEXTS.support, {
      reply_markup: new InlineKeyboard().url(LABELS.supportButton, supportUrl()),
    });
  });

  // No backend call, like /support: the same answer for everyone, during an outage too (#184).
  privateChats.command('help', async (ctx) => {
    await replyHtml(ctx, helpText(BOT_COMMANDS));
  });

  // The status card's button and the screens behind it (#125, docs/bot-demo.md): callback queries
  // only, so the private-chat filter covers them and the text handler below never sees them.
  privateChats.use(createDemoComposer({ backend, logger, now }));

  // the stake button under the analysis and the refresh button under the status (#127)
  privateChats.use(
    createDemoTradeComposer({
      backend,
      logger,
      now,
      intentTracker,
      connectKeyboard: welcomeKeyboard,
    }),
  );

  // «💵 Сумма» under the analysis, in /settings and under the stake refusals (#297); its typed
  // amount arrives through the text handler below
  const stakePicker = createStakePicker({
    backend,
    logger,
    dialog: loginDialog,
    connectKeyboard: welcomeKeyboard,
  });
  privateChats.use(stakePicker.composer);

  // the session button under the analysis and the buttons under the session's status (#284)
  privateChats.use(
    createTradingSessionComposer({
      backend,
      logger,
      sessionTracker,
      connectKeyboard: welcomeKeyboard,
    }),
  );

  privateChats.callbackQuery(CONNECT_CALLBACK_DATA, async (ctx) => {
    loginDialog.set(ctx.from.id, { step: 'email' });
    await ctx.answerCallbackQuery().catch((error: unknown) => {
      logAnswerFailure(error);
    });
    await replyHtml(ctx, TEXTS.emailPrompt);
  });

  privateChats.callbackQuery(OAUTH_CALLBACK_DATA, (ctx) => removeLegacyKeyboard(ctx, logger));

  privateChats.callbackQuery(CONFIRM_CALLBACK_PATTERN, async (ctx) => {
    const accountId = confirmLoginRequestSchema.shape.accountId.safeParse(ctx.match[1]);
    if (!accountId.success) {
      // the button is ours, so this is a forged or stale query: stop the spinner, say nothing
      await ctx.answerCallbackQuery().catch((error: unknown) => {
        logAnswerFailure(error);
      });
      return;
    }
    // independent: the outcome message matters more than the spinner, so a rejected
    // answerCallbackQuery ("query is too old" is the usual one) must not skip it
    const [answered, confirmed] = await Promise.allSettled([
      ctx.answerCallbackQuery(),
      backend.confirmLogin(String(ctx.from.id), accountId.data),
    ]);
    if (answered.status === 'rejected') logAnswerFailure(answered.reason);
    if (confirmed.status === 'fulfilled') {
      const { account, grant } = confirmed.value;
      await sendAccountCard(ctx, { firstName: ctx.from.first_name, email: account.email, grant });
      return;
    }
    const error: unknown = confirmed.reason;
    const refusal =
      error instanceof BackendError ? CONFIRM_REFUSALS[error.reason ?? ''] : undefined;
    if (refusal !== undefined) {
      await replyHtml(ctx, textOf(refusal));
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
      // no address yet, or no login at all: there is nothing to send a code to
      await replyHtml(ctx, state?.step === 'email' ? TEXTS.emailPrompt : TEXTS.codeRequestStale);
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

  // The user blocked (`kicked`) or unblocked (`member`) the bot (#119). The bot forwards
  // Telegram's word and decides nothing; it sends nothing either, since a blocked chat cannot
  // receive it. In a private chat `from` is the user, the same key /start records.
  privateChats.on('my_chat_member', async (ctx) => {
    const status = ctx.myChatMember.new_chat_member.status;
    if (status !== TelegramChatMemberStatus.Kicked && status !== TelegramChatMemberStatus.Member) {
      return;
    }
    try {
      await backend.recordChatMember(String(ctx.myChatMember.from.id), status);
    } catch (error) {
      logger.warn(
        { ...errorLogFields(error), ...backendErrorFields(error), chatMember: status },
        'chat member status not recorded',
      );
    }
  });

  // Registered after the command handlers, which do not call next(): none of them reaches this
  // handler, so they neither feed the dialog nor reset it. Any other command is
  // ignored here for the same reason. Text outside a dialog is ignored altogether (the owner's
  // decision, #162).
  privateChats.on('message:text', async (ctx) => {
    const from = ctx.from;
    const text = ctx.message.text;
    if (from === undefined || text.startsWith('/')) return;
    const state = loginDialog.get(from.id);
    if (state === undefined) return;

    // a typed demo stake (#297): an address typed now is a stake too, refused as invalid
    if (state.step === 'stake') {
      await stakePicker.onStakeText(ctx, state.origin, text);
      return;
    }

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
    // the broker's address for the account it issued the tokens for; the one this login redeemed
    // the code for when the broker sent none — a blank address is none (addressOrNull, #214)
    await sendAccountCard(ctx, {
      firstName: from.first_name,
      email: login.account.email ?? state.email,
      grant: login.grant,
    });
  });

  // `step` is the step the code was asked from: the address, or «🔄 Запросить код ещё раз» on the
  // code step. The same refusal means a different thing for the dialog on each (SEND_CODE_REFUSALS).
  async function replyToSendCode(
    ctx: Context,
    id: number,
    email: string,
    step: LoginStep,
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
        text: 'unavailable',
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
      textOf(refusal.text),
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
    // The recheck knows that an account is active, not which one nor what was paid: a user who
    // already had one and typed a wrong code for another address lands here too. So the card
    // carries neither the dialog's address nor a pack line (Plan Update, #200).
    if (user.hasActiveBrokerAccount) {
      loginDialog.delete(from.id);
      await sendAccountCard(ctx, { firstName: from.first_name, email: null, grant: null });
      return;
    }
    if (invalidCode) {
      await replyHtml(ctx, TEXTS.codeInvalid, { reply_markup: codeKeyboard() });
      return;
    }
    await replyHtml(ctx, TEXTS.unavailable);
  }

  // A rich message (the welcome video, the account card photo) with its text as the fallback.
  // A refusal of the rich call means nothing was sent, so the same text goes instead. A
  // transport failure — of the rich call or of the text — leaves delivery unknown, and a second
  // copy is worse than none, so nothing more is sent and undefined is returned. It is logged here
  // rather than in bot.catch because only this place still knows the method: HttpError carries
  // none. A refused text message goes to bot.catch, as in every one-message handler — a
  // GrammyError carries its own method there; so does anything that is neither a refusal nor the
  // transport, a bug that must not be dressed up as a delivery problem.
  async function sendWithTextFallback(
    ctx: Context,
    rich: RichSend,
    sendText: () => Promise<Message>,
  ): Promise<Message | undefined> {
    try {
      return await rich.send();
    } catch (error) {
      if (error instanceof GrammyError) {
        logger.warn(
          { ...errorLogFields(error), ...telegramErrorFields(error) },
          `${rich.what} was refused, sending the text instead`,
        );
      } else if (error instanceof HttpError) {
        logTransportFailure(ctx, error, rich.method, `${rich.what} call`);
        return undefined;
      } else {
        throw error;
      }
    }
    try {
      return await sendText();
    } catch (error) {
      if (!(error instanceof HttpError)) throw error;
      logTransportFailure(ctx, error, 'sendMessage', `the text in place of ${rich.what}`);
      return undefined;
    }
  }

  function logTransportFailure(ctx: Context, error: HttpError, method: string, what: string): void {
    logger.error(
      {
        ...errorLogFields(error),
        ...telegramErrorFields(error, method),
        updateId: ctx.update.update_id,
      },
      `${what} failed in transport, sending nothing more`,
    );
  }

  // The account card (#200), sent where an account becomes usable and pinned as the only pin of
  // the chat until the next /start or /menu pins the status card in its place; nothing is pinned
  // when delivery is unknown.
  async function sendAccountCard(ctx: Context, input: AccountCardInput): Promise<void> {
    const card = accountCard(input);
    const sent = await sendWithTextFallback(
      ctx,
      {
        send: () => replyWithPhotoHtml(ctx, new InputFile(ACCOUNT_CARD_PHOTO_PATH), card),
        method: 'sendPhoto',
        what: 'the account card photo',
      },
      () => replyHtml(ctx, card),
    );
    if (sent === undefined) return;
    await pinCard(ctx, sent.message_id, 'the account card');
  }

  // The /settings message re-rendered in place after a press (#120). Unlike a refused send, a
  // refused edit may mean the message already shows the result, so a refusal is classified
  // (editRefusal): already shown — a second press of the same level queued against the old
  // keyboard — is done; a message that is gone or cannot be edited gets the same text and
  // keyboard anew; any other refusal goes to bot.catch with nothing sent, the keyboard on screen
  // being the retry. A transport failure leaves the edit unknown and sends nothing more; anything
  // else is a bug.
  async function showSettings(
    ctx: Context,
    level: NotificationLevel,
    demoStake: DecimalString | null,
  ): Promise<void> {
    const text = settingsText(level, demoStake);
    const reply_markup = levelKeyboard(level);
    try {
      await editMessageTextHtml(ctx, text, { reply_markup });
    } catch (error) {
      const refusal = error instanceof GrammyError ? editRefusal(error) : undefined;
      if (refusal === 'shown') {
        logger.info(
          { ...telegramErrorFields(error) },
          'the settings message already shows this level',
        );
      } else if (refusal === 'gone') {
        logger.warn(
          { ...errorLogFields(error), ...telegramErrorFields(error) },
          'the settings message was not edited, sending it anew',
        );
        await replyHtml(ctx, text, { reply_markup });
      } else if (error instanceof HttpError) {
        logger.error(
          {
            ...errorLogFields(error),
            ...telegramErrorFields(error, 'editMessageText'),
            updateId: ctx.update.update_id,
          },
          'the settings edit failed in transport, sending nothing more',
        );
      } else {
        throw error;
      }
    }
  }

  // The bot stores no message id, so clearing every pin is what leaves exactly one card pinned
  // (the user's own pins go too, the owner's choice). Neither failure touches the connection,
  // which is already committed: the unpin failing still lets the pin run, since two pinned cards
  // are better than none. The pin is silent because the card itself has just notified.
  async function pinCard(
    ctx: Context,
    messageId: number,
    what: 'the account card' | 'the status card',
  ): Promise<void> {
    try {
      await ctx.unpinAllChatMessages();
    } catch (error) {
      logPinFailure(error, 'unpinAllChatMessages', 'the old pins were not cleared');
    }
    try {
      await ctx.pinChatMessage(messageId, { disable_notification: true });
    } catch (error) {
      logPinFailure(error, 'pinChatMessage', `${what} was not pinned`);
    }
  }

  function logPinFailure(error: unknown, method: string, message: string): void {
    if (!(error instanceof GrammyError || error instanceof HttpError)) throw error;
    logger.warn({ ...errorLogFields(error), ...telegramErrorFields(error, method) }, message);
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

  // A file id the API refuses must not cost the user the whole first screen.
  async function sendWelcome(ctx: Context): Promise<void> {
    const reply_markup = welcomeKeyboard();
    if (welcomeVideoFileId !== undefined) {
      await sendWithTextFallback(
        ctx,
        {
          send: () => replyWithVideoHtml(ctx, welcomeVideoFileId, TEXTS.welcome, { reply_markup }),
          method: 'sendVideo',
          what: 'the welcome video',
        },
        () => replyHtml(ctx, TEXTS.welcome, { reply_markup }),
      );
      return;
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

// What every /users/start carries apart from the payload: /start adds that one; /menu, /settings
// and the recheck after an email login send none.
function startRequestOf(from: User): UserStartRequest {
  return {
    telegramUserId: String(from.id),
    displayName: displayNameOf(from),
    ...languageOf(from.language_code),
  };
}

// the welcome's way in, also under /account while no link is active
function addConnectButtons(keyboard: InlineKeyboard): InlineKeyboard {
  return keyboard.text(LABELS.connectButton, CONNECT_CALLBACK_DATA);
}

// A confirm button per waiting link, then the connect button while nothing is active; undefined
// when there is no button at all (an InlineKeyboard starts as one empty row, so its length says
// nothing).
function accountKeyboard(accounts: readonly LinkedAccountView[]): InlineKeyboard | undefined {
  const pending = accounts.filter(isPendingLink);
  const connect = !accounts.some((account) => account.status === BrokerAccountStatus.Active);
  if (pending.length === 0 && !connect) return undefined;
  const keyboard = confirmKeyboard(pending);
  return connect ? addConnectButtons(keyboard) : keyboard;
}

// one row of the three levels, the selected one marked and doing nothing when pressed; then the
// demo stake's picker (#297)
function levelKeyboard(current: NotificationLevel): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  for (const level of Object.values(NotificationLevel)) {
    if (level === current) keyboard.text(currentLevelLabel(level), LEVEL_CURRENT_CALLBACK_DATA);
    else keyboard.text(levelLabel(level), levelCallbackData(level));
  }
  return keyboard
    .row()
    .text(LABELS.settingsStakeButton, stakeOpenCallbackData({ kind: 'settings' }));
}

function confirmKeyboard(accounts: readonly PendingBrokerAccountView[]): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  for (const account of accounts) {
    keyboard.text(LABELS.confirmButton(account.email), confirmCallbackData(account.id)).row();
  }
  return keyboard;
}

// the refusals the user can act on; anything else is an outage to them
const CONFIRM_REFUSALS: Partial<Record<string, BotStaticHtmlKey>> = {
  [OAuthErrorCode.BrokerAccountNotFound]: 'confirmNotFound',
  [OAuthErrorCode.AccountNotPending]: 'confirmAlreadyDone',
  [OAuthErrorCode.UserBlocked]: 'blocked',
};

// What a refusal says and what it does to the dialog: end it, keep it as it is (its TTL too), or
// move it to the given state. `codeKeyboard` puts the code step's buttons under the text.
interface Refusal {
  text: BotStaticHtmlKey;
  dialog: 'end' | 'keep' | LoginDialogState;
  codeKeyboard?: true;
}

// The two 429s are different limits (apps/backend/src/auth/routes.ts). too_many_requests is the
// route's ceiling across all users, checked before anything else: no letter, no slot of this
// user's, no code spent, so the step stays. too_many_attempts is this user's or this address's
// own allowance for the next minutes, so asking for an address again is pointless — but a code
// already sent stays good, which is why a refused «🔄 Запросить код ещё раз» keeps the code step.
// Anything not listed is either a refusal before the letter (a sub-500 status) or an unknown
// outcome (replyToSendCode).
const SEND_CODE_REFUSALS: Record<LoginStep, Partial<Record<string, Refusal>>> = {
  email: {
    [OAuthErrorCode.InvalidEmail]: { text: 'emailRefused', dialog: { step: 'email' } },
    [OAuthErrorCode.TooManyRequests]: { text: 'sendCodeBusy', dialog: 'keep' },
    [OAuthErrorCode.TooManyAttempts]: { text: 'tooManyCodeRequests', dialog: 'end' },
    [OAuthErrorCode.UserBlocked]: { text: 'blocked', dialog: 'end' },
  },
  code: {
    [OAuthErrorCode.InvalidEmail]: { text: 'emailRefused', dialog: { step: 'email' } },
    [OAuthErrorCode.TooManyRequests]: {
      text: 'resendRefused',
      dialog: 'keep',
      codeKeyboard: true,
    },
    [OAuthErrorCode.TooManyAttempts]: {
      text: 'resendRefused',
      dialog: 'keep',
      codeKeyboard: true,
    },
    [OAuthErrorCode.UserBlocked]: { text: 'blocked', dialog: 'end' },
  },
};

// The login refusals that are definite, so no recheck. invalid_code is not one of them — a lost
// answer turns into it on the retry. too_many_requests is the route's ceiling, refused before
// the broker saw the code, so the code is still good and the step stays.
const LOGIN_REFUSALS: Partial<Record<string, Refusal>> = {
  [OAuthErrorCode.TooManyAttempts]: { text: 'tooManyCodeAttempts', dialog: 'end' },
  [OAuthErrorCode.TooManyRequests]: { text: 'loginBusy', dialog: 'keep', codeKeyboard: true },
  [OAuthErrorCode.UserBlocked]: { text: 'blocked', dialog: 'end' },
  [OAuthErrorCode.BrokerAccountTaken]: { text: 'accountTaken', dialog: 'end' },
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
