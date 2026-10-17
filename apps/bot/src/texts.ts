import {
  assertExhausted,
  botCommandsOf,
  botTextKeysOf,
  BotTextGroup,
  breakEvenPct,
  BrokerAccountStatus,
  confirmButtonLabel,
  createBotTexts,
  createSessionTexts,
  joinHtmlLines,
  pairLabel,
  DEFAULT_SESSION_CYCLES,
  defaultBotTextSource,
  formatStake,
  formatUsd,
  stakeIsRisky,
  isPendingLink,
  MODE_LABELS,
  LinkBonusSkipReason,
  BrokerBalanceUnavailableReason,
  NotificationLevel,
  StarPaymentStatus,
  telegramHtml,
  TradeAction,
  TRADE_INTENT_TRANSITIONS,
  TradeIntentFailureReason,
  TradeIntentStatus,
  TradeMode,
  TradingSessionStatus,
  type BotHtmlKey,
  type BotHtmlTexts,
  type BotPlainTexts,
  type BotStaticHtmlKey,
  type BotStaticPlainKey,
  type BotTextBalance,
  type BotTextKey,
  type BotTextKeyOfGroup,
  type BotTextSource,
  type SessionScore,
  type BrokerBalanceView,
  type DecimalString,
  type LinkBonusGrantView,
  type LinkedAccountView,
  type PairLabel,
  type PairTypeGroup,
  type PairView,
  type StarPaymentView,
  type TelegramHtml,
  type TradeIntentView,
  type TradingAccessResponse,
  type TradingSessionView,
} from '@binarius/shared';
import type { BotCommand } from 'grammy/types';
import type { DemoDurationSec } from './demo-catalog';

// The texts live in the catalog (packages/shared/src/bot-texts.ts, docs/bot-texts.md). This file
// is the bot's view of it: TEXTS, LABELS, PROFILE and the label maps keep the names they had,
// botCommands() joined them (#301), a key with variables takes their values as one context (#358),
// and every one of them reads the source at the moment it is used. No text is taken into a module
// constant at load, so a source swapped by setBotTextSource reaches every message, the command
// menu and /help's command lines included.
let active: BotTextSource<BotTextKey> = defaultBotTextSource;
export const setBotTextSource = (source: BotTextSource<BotTextKey>): void => {
  active = source;
};
const { html, plain } = createBotTexts({ sourceOf: (key) => active.sourceOf(key) });

// A message part by its key, for the maps that name a text rather than hold it (the refusals).
export const textOf = (key: BotStaticHtmlKey): TelegramHtml => html[key];

// The session's words shared with the backend's session notices (#464, session-texts.ts in
// packages/shared), printed with this bot's catalog.
export const sessionTexts = createSessionTexts({ html, plain });
export const { pluralTrades, sessionAssetLabel, sessionEndLine } = sessionTexts;
const { tradesCount, cyclesCount, scoreOf, resultOf } = sessionTexts;
const joinLines = joinHtmlLines;

// `keys` read through `view` on every access; `overrides` are fixed functions, created once so a
// toBe on them holds.
function facadeOf<V extends object, K extends keyof V & string, R extends object>(
  view: V,
  keys: readonly K[],
  overrides: R,
): Omit<Pick<V, K>, keyof R> & R {
  const facade = {};
  for (const key of keys) {
    if (Object.hasOwn(overrides, key)) continue;
    Object.defineProperty(facade, key, { get: () => view[key], enumerable: true });
  }
  for (const [key, value] of Object.entries(overrides)) {
    Object.defineProperty(facade, key, { value, enumerable: true });
  }
  return facade as Omit<Pick<V, K>, keyof R> & R;
}

// A map from a value (a level, a direction, a reason) to its label, by catalog key.
export function labelsOf<M extends Record<string | number, BotStaticPlainKey>>(
  keys: M,
): { readonly [K in keyof M]: string } {
  const labels = {};
  for (const [name, key] of Object.entries(keys)) {
    Object.defineProperty(labels, name, { get: () => plain[key], enumerable: true });
  }
  return labels as { readonly [K in keyof M]: string };
}

// The /settings buttons, also the legend of its message (#120)
const LEVEL_LABELS = labelsOf({
  [NotificationLevel.All]: 'levelAll',
  [NotificationLevel.Reduced]: 'levelReduced',
  [NotificationLevel.Off]: 'levelOff',
} as const satisfies Record<NotificationLevel, BotStaticPlainKey>);

// A trade's direction in words: the analysis's stake button (#126) and #127's status texts; the
// card names it with its own words (#482).
export const ACTION_LABELS = labelsOf({
  [TradeAction.Up]: 'actionUp',
  [TradeAction.Down]: 'actionDown',
} as const satisfies Record<TradeAction, BotStaticPlainKey>);

// Messages are Telegram HTML, sent with parse_mode HTML by send.ts only. Every hole is escaped
// unless it is TelegramHtml already, and every assembled text is checked again
// (telegramHtmlTemplate); a variable's value is escaped like any string (bot-text-vars.ts). The
// catalog's html keys but these, and the reminders: cardGreeting branches to cardGreetingNoName,
// featureLines is a fragment of cardBody and helpAbout, and only the backend sends
// oauthLoginFailed and depositCredited (its pushes), the session notices (#464) and the `mailing`
// group (its mailing engine).
// the session notices' keys (#464): the backend sends them, through session-texts.ts; and the
// waiting message (#536), session-notice-messages.ts
const BACKEND_SESSION_KEYS = [
  'sessionTradeWon',
  'sessionTradeLost',
  'sessionTradeTied',
  'sessionAdaptiveStake',
  'sessionSummarySymbol',
  'sessionWaitingSignal',
] as const;
const NOT_IN_TEXTS = [
  'cardGreetingNoName',
  'featureLines',
  'oauthLoginFailed',
  'depositCredited',
  ...BACKEND_SESSION_KEYS,
  ...botTextKeysOf(BotTextGroup.Mailing),
] as const;
type TextKey = Exclude<
  BotHtmlKey,
  | 'cardGreetingNoName'
  | 'featureLines'
  | 'oauthLoginFailed'
  | 'depositCredited'
  | (typeof BACKEND_SESSION_KEYS)[number]
  | BotTextKeyOfGroup<typeof BotTextGroup.Mailing>
>;

interface TextOverrides {
  cardGreeting: (context: { firstName: string; email: string | null }) => TelegramHtml;
}
// annotated: the inferred type of the whole catalog is past what tsc serializes into a .d.ts
export const TEXTS: Omit<Pick<BotHtmlTexts, TextKey>, keyof TextOverrides> & TextOverrides =
  facadeOf(
    html,
    (Object.keys(html) as BotHtmlKey[]).filter(
      (key): key is TextKey => !(NOT_IN_TEXTS as readonly string[]).includes(key),
    ),
    {
      // The name is Telegram's first_name: the Bot API guarantees it non-empty, not non-blank.
      cardGreeting: (context: { firstName: string; email: string | null }): TelegramHtml =>
        context.firstName.trim() === ''
          ? html.cardGreetingNoName({ email: context.email })
          : html.cardGreeting(context),
    },
  );

// What a handler holding the access read and the user's first_name gives the texts of the status
// card and the stake picker (docs/bot-texts.md → Variables). Nothing here is read for a text.
export interface UserTextContext {
  firstName: string;
  tokens: string;
  reservedTokens: string;
  demoBalance: BotTextBalance;
  realBalance: BotTextBalance;
  mode: TradeMode;
  stake: DecimalString | null;
}

type AccessForTexts = Pick<TradingAccessResponse, 'tokens' | 'broker' | 'demoStake' | 'realStake'>;

// a balance with the freshness the backend judged (isBalanceFresh); null with no snapshot
export const balanceOf = (
  broker: TradingAccessResponse['broker'],
  side: TradeMode,
): BotTextBalance =>
  broker === null ? null : { amount: broker[side].available, fresh: broker.fresh };

// `mode` is the user's trading mode (#121) where the caller read it, the picker's own mode for the
// stake picker, which saves that mode's stake whatever the user's mode (#326)
export const userContextOf = (
  firstName: string,
  mode: TradeMode,
  { tokens, broker, demoStake, realStake }: AccessForTexts,
): UserTextContext => ({
  firstName,
  tokens: tokens.available,
  reservedTokens: tokens.reserved,
  demoBalance: balanceOf(broker, TradeMode.Demo),
  realBalance: balanceOf(broker, TradeMode.Real),
  mode,
  // the amount a trade stakes in that mode: the saved stake; in real without one the broker's
  // minimum (#326), null without a snapshot either (the text prints «минимальная ставка брокера»)
  stake: mode === TradeMode.Real ? (realStake ?? broker?.minTradeAmount ?? null) : demoStake,
});

// The /help message: the three blocks, then one line per command in the menu's order.
export function helpText(commands: readonly BotCommand[]): TelegramHtml {
  // a hole holding an array is joined without a separator, so each line carries its newline
  const lines = commands.map(
    ({ command, description }) => telegramHtml`
/${command} — ${description}`,
  );
  return telegramHtml`${TEXTS.helpAbout}

${TEXTS.helpConnect}

${TEXTS.helpCommands}${lines}`;
}

// What /account says about the user's links, in the order given (newest first). No link at all
// is accountNone; otherwise the header follows the best link there is.
export function accountStatus(accounts: readonly LinkedAccountView[]): TelegramHtml {
  const [first, ...rest] = accounts.map(accountLine);
  if (first === undefined) return TEXTS.accountNone;
  const header = accounts.some((account) => account.status === BrokerAccountStatus.Active)
    ? TEXTS.accountConnected
    : accounts.some(isPendingLink)
      ? TEXTS.accountPending
      : TEXTS.accountRevoked;
  // a hole holding an array is joined without a separator, so the newlines are written here
  const lines = rest.reduce(
    (joined, line) => telegramHtml`${joined}
${line}`,
    first,
  );
  return telegramHtml`${header}

${lines}`;
}

function accountLine({ status, email }: LinkedAccountView): TelegramHtml {
  switch (status) {
    case BrokerAccountStatus.Active:
      return TEXTS.accountLineActive({ email });
    case BrokerAccountStatus.Pending:
      return TEXTS.accountLinePending({ email });
    case BrokerAccountStatus.Revoked:
      return TEXTS.accountLineRevoked({ email });
  }
}

// Only these three fields reach the card, so no token, code or other secret can. `email` is null
// when the address of the connected account is not known — the broker sent none or a blank one
// (addressOrNull), or the recheck after a lost answer; `grant` is null when what the login paid
// is not known (that recheck).
export interface AccountCardInput {
  firstName: string;
  email: string | null;
  grant: LinkBonusGrantView | null;
}

// Blocks separated by one blank line; an absent block takes its blank line with it.
export function accountCard({ firstName, email, grant }: AccountCardInput): TelegramHtml {
  const context = { firstName, email };
  const greeting = TEXTS.cardGreeting(context);
  const header =
    email === null
      ? greeting
      : telegramHtml`${greeting}
${TEXTS.cardEmail(context)}`;
  const bonus = bonusOf(grant, context);
  const tail = bonus === null ? [] : [telegramHtml`\n\n${bonus}`];
  return telegramHtml`${header}

${TEXTS.cardBody(context)}${tail}`;
}

function bonusOf(
  grant: LinkBonusGrantView | null,
  context: { firstName: string; email: string | null },
): TelegramHtml | null {
  if (grant === null) return null;
  if (grant.granted) return TEXTS.cardBonusGranted({ ...context, bonusTokens: grant.tokens });
  switch (grant.reason) {
    case LinkBonusSkipReason.NotPartnerClient:
      return TEXTS.cardBonusNotPartner(context);
    case LinkBonusSkipReason.AlreadyGranted:
      return TEXTS.cardBonusAlready(context);
    // the owner turned the starter pack off (#13): the card says nothing about a bonus
    case LinkBonusSkipReason.NoActiveRule:
      return null;
    default:
      return assertExhausted(grant.reason, 'link bonus skip reason');
  }
}

// Only what the card prints reaches it: `status` is branched on before a card exists, and
// tradingOpen is the backend's switch, not the user's mode. `mode` is the access read's
// tradingMode (#121): the header and the hint follow it.
export type StatusCardInput = Pick<
  TradingAccessResponse,
  'tokens' | 'broker' | 'brokerUnavailable' | 'demoStake' | 'realStake'
> & {
  firstName: string;
  mode: TradeMode;
};

// The header, a blank line, the balances and tokens, the status line when there is one, a blank
// line, the hint. With no snapshot both amounts read $0.00 and the status line says why; the
// card's own amounts are printed as they are, their freshness on the status line (#358 В2).
export function statusCard(input: StatusCardInput): TelegramHtml {
  const { tokens, broker, brokerUnavailable } = input;
  const context = userContextOf(input.firstName, input.mode, input);
  const zero = formatUsd('0');
  const real = TEXTS.statusReal({
    ...context,
    amount: broker === null ? zero : formatUsd(broker.real.available),
  });
  const demo = TEXTS.statusDemo({
    ...context,
    amount: broker === null ? zero : formatUsd(broker.demo.available),
  });
  // the wire form of a count is ^\d+$, so a non-zero digit is a non-zero count
  const reserved = /[1-9]/.test(tokens.reserved)
    ? [telegramHtml` ${TEXTS.statusReserved(context)}`]
    : [];
  const status = statusLineOf(broker, brokerUnavailable, context);
  const statusTail = status === null ? [] : [telegramHtml`\n${status}`];
  return telegramHtml`${TEXTS.statusHeader(context)}

${real}
${demo}
${TEXTS.statusTokens(context)}${reserved}${statusTail}

${input.mode === TradeMode.Real ? TEXTS.statusHintReal(context) : TEXTS.statusHint(context)}`;
}

function statusLineOf(
  broker: StatusCardInput['broker'],
  brokerUnavailable: StatusCardInput['brokerUnavailable'],
  context: UserTextContext,
): TelegramHtml | null {
  if (broker === null) {
    return brokerUnavailable === BrokerBalanceUnavailableReason.AmbiguousAccount
      ? TEXTS.statusAmbiguous
      : TEXTS.statusNoSnapshot(context);
  }
  if (broker.fresh) return null;
  // the same age isBalanceFresh judged: the newer of the REST snapshot and the last event
  const age = Math.min(broker.restSnapshotAgeSec, broker.balanceEventAgeSec ?? Infinity);
  return TEXTS.statusStale({ age });
}

// The status line of each status but rejected, whose line is its reason's. Exhaustive, so a
// status added to the contract fails tsc here instead of falling into a catch-all. Keys, read at
// the moment a status is shown.
const INTENT_STATUS_LINES = {
  [TradeIntentStatus.Planned]: 'intentQueued',
  [TradeIntentStatus.Reserved]: 'intentQueued',
  [TradeIntentStatus.Queued]: 'intentQueued',
  [TradeIntentStatus.Submitting]: 'intentSubmitting',
  [TradeIntentStatus.Accepted]: 'intentAccepted',
  [TradeIntentStatus.Settled]: 'intentSettled',
  [TradeIntentStatus.Unknown]: 'intentUnknown',
  [TradeIntentStatus.Reconciling]: 'intentUnknown',
  [TradeIntentStatus.ManualReview]: 'intentManualReview',
} as const satisfies Record<
  Exclude<TradeIntentStatus, typeof TradeIntentStatus.Rejected>,
  BotStaticHtmlKey
>;

// rejectIntent writes its own reason, so a rejected row carries one of the first seven; the rest
// lead to unknown or manual_review and read the generic line should one ever arrive here
const REJECTED_LINES = {
  [TradeIntentFailureReason.ExecutorNotConfigured]: 'intentRejectedNotConfigured',
  [TradeIntentFailureReason.Expired]: 'intentRejectedExpired',
  [TradeIntentFailureReason.BrokerRejected]: 'intentRejectedByBroker',
  [TradeIntentFailureReason.PublishFailed]: 'intentRejectedPublishFailed',
  [TradeIntentFailureReason.ReconciliationNotFound]: 'intentRejectedNotFound',
  [TradeIntentFailureReason.ManualRejected]: 'intentRejectedManual',
  [TradeIntentFailureReason.TradingPaused]: 'intentRejectedPaused',
  [TradeIntentFailureReason.DemoOnly]: 'intentRejectedDemoOnly',
  [TradeIntentFailureReason.ExecutorTimeout]: 'intentRejected',
  [TradeIntentFailureReason.ExecutorError]: 'intentRejected',
  [TradeIntentFailureReason.StaleSubmitting]: 'intentRejected',
  [TradeIntentFailureReason.InvalidJob]: 'intentRejected',
  [TradeIntentFailureReason.ProcessingFailed]: 'intentRejected',
  [TradeIntentFailureReason.TradeMismatch]: 'intentRejected',
  [TradeIntentFailureReason.ReconciliationAmbiguous]: 'intentRejected',
  [TradeIntentFailureReason.BrokerUnavailable]: 'intentRejected',
} as const satisfies Record<TradeIntentFailureReason, BotStaticHtmlKey>;

// What the status message shows of an intent: its trade and its status; nothing else of the view.
export type IntentStatusView = Pick<
  TradeIntentView,
  'mode' | 'assetId' | 'action' | 'durationSec' | 'amount' | 'status' | 'lastError'
>;

const durationLabelOf = (durationSec: number): string =>
  durationSec in DEMO_DURATION_LABELS
    ? DEMO_DURATION_LABELS[durationSec as DemoDurationSec]
    : `⏱ ${String(durationSec)} с`;

const statusLineOfIntent = ({ status, lastError }: IntentStatusView): TelegramHtml =>
  status === TradeIntentStatus.Rejected
    ? lastError === null
      ? TEXTS.intentRejected
      : textOf(REJECTED_LINES[lastError])
    : textOf(INTENT_STATUS_LINES[status]);

// The demo trade's one message (#127). `symbol` is the pair's label (pairLabel), or null when
// the catalog could not say (the refresh button): the asset's id stands in for it. The callers
// never ask for the deadline hint and the session offer (#360) together.
export function intentStatusText(
  symbol: PairLabel | null,
  view: IntentStatusView,
  { deadline = false, sessionOffer = false }: { deadline?: boolean; sessionOffer?: boolean } = {},
): TelegramHtml {
  const asset = symbol ?? plain.intentAssetFallback({ assetId: String(view.assetId) });
  const trade = [
    asset,
    ACTION_LABELS[view.action],
    durationLabelOf(view.durationSec),
    plain.intentStake({ amount: formatStake(view.amount) }),
  ].join(' · ');
  const tail = [
    ...(deadline
      ? [
          telegramHtml`

${TEXTS.intentDeadline}`,
        ]
      : []),
    ...(sessionOffer
      ? [
          telegramHtml`

${TEXTS.intentSessionOffer({ cycles: cyclesCount(DEFAULT_SESSION_CYCLES) })}`,
        ]
      : []),
  ];
  const header = view.mode === TradeMode.Real ? TEXTS.intentHeaderReal : TEXTS.intentHeader;
  return telegramHtml`${header}
${TEXTS.intentTrade({ line: trade })}

${statusLineOfIntent(view)}${tail}`;
}

// A session door's label in real mode carries the mode's label (#327), as the stake button does
// (#121), so a real session never starts from a button that looks like a demo one
const withModeLabel = (label: string, mode: TradeMode): string =>
  mode === TradeMode.Real ? `${label} · ${MODE_LABELS[TradeMode.Real]}` : label;
// the session button of the analysis screen and of a finished trade (#360), with the number of
// cycles it starts (#552)
export const sessionStartButtonLabel = (cycles: number, mode: TradeMode): string =>
  withModeLabel(plain.sessionStartButton({ cycles: cyclesCount(cycles) }), mode);
// the launch screen's cycle button (#320) and «🔁 Ещё сессия» under a finished session (#318)
export const launchCycleButtonLabel = (mode: TradeMode): string =>
  withModeLabel(LABELS.launchCycleButton, mode);
export const sessionAgainButtonLabel = (mode: TradeMode): string =>
  withModeLabel(LABELS.sessionAgainButton, mode);

// A trade with an outgoing edge in the shared graph: it can still settle or be rejected, so the
// session's counters can still move (manual_review included).
const sessionIntentLive = (intent: TradeIntentView | null): intent is TradeIntentView =>
  intent !== null && TRADE_INTENT_TRANSITIONS[intent.status].length > 0;

// A trade the worker carries to its end without a person: live, and not on manual review.
const intentPlaysOut = (intent: TradeIntentView | null): intent is TradeIntentView =>
  sessionIntentLive(intent) && intent.status !== TradeIntentStatus.ManualReview;

// What the session message shows of a session; nothing else of the view.
type SessionStatusView = Pick<
  TradingSessionView,
  'mode' | 'status' | 'stopReason' | 'settings' | 'trades' | 'cycles' | 'lastIntent' | 'balance'
>;

// The summary card's words (#318, session-card.ts), read when the card is drawn so an override
// reaches the next card. The footer is an assembled message (bot-text-messages.ts →
// sessionCardFooter): the session's trades and score, «в ноль» only when a trade tied.
export const sessionCardLabels = () => ({
  title: plain.sessionCardTitle,
  result: plain.sessionCardResult,
  legendEntry: plain.sessionCardLegendEntry,
  legendWin: plain.sessionCardLegendWin,
  legendLoss: plain.sessionCardLegendLoss,
  legendTie: plain.sessionCardLegendTie,
});
export const sessionCardTradeLabel = (index: number): string =>
  plain.sessionCardTrade({ count: String(index) });
export const sessionCardFooter = (count: number, score: SessionScore): string =>
  plain.sessionCardFooter({ trades: tradesCount(count), score: scoreOf(score) });

// The caption of the card shared through «📤 Поделиться» (#321, session-share.ts): the score
// without the $ sum, which the image itself shows, and the bot's link.
export const sessionShareCaption = (
  symbol: PairLabel | null,
  assetId: number,
  trades: TradingSessionView['trades'],
  botUsername: string,
): TelegramHtml =>
  TEXTS.sessionShareCaption({
    symbol: sessionAssetLabel(symbol, assetId),
    result: resultOf(trades),
    botUsername,
  });

// The reply to «⏹» under the waiting message and to /stop of one session (#536): the end line, and
// the open trade's line while the worker still carries it to its end.
export const sessionStopReplyText = (
  view: Pick<SessionStatusView, 'stopReason' | 'trades' | 'cycles' | 'lastIntent'>,
): TelegramHtml =>
  joinLines([
    sessionEndLine(view),
    ...(intentPlaysOut(view.lastIntent) ? [TEXTS.sessionOpenTradePlaysOut] : []),
  ]);

// The session's message (#284, #536, docs/bot-session.md → The session message): the header by
// mode (#327), the pair, the stake and the expiry, then «Торговая сессия запущена…» while it runs
// and its end line once it stopped. Nothing of its trades: they are the backend's messages, and the
// result and balance its summary's (#464). `symbol` is null when the catalog could not say.
export function sessionStatusText(symbol: PairLabel | null, view: SessionStatusView): TelegramHtml {
  const { settings } = view;
  const header = view.mode === TradeMode.Real ? TEXTS.sessionHeaderReal : TEXTS.sessionHeader;
  if (settings === null) {
    return telegramHtml`${header}

${TEXTS.sessionSettingsUnavailable}`;
  }
  const head = joinLines([
    header,
    TEXTS.sessionPair({ symbol: sessionAssetLabel(symbol, settings.assetId) }),
    TEXTS.sessionStake({ stake: settings.stake.baseStake }),
    TEXTS.sessionExpiry({ duration: `${String(settings.durationSec)} с` }),
  ]);
  const state =
    view.status === TradingSessionStatus.Stopped ? sessionEndLine(view) : TEXTS.sessionRunning;
  return telegramHtml`${head}

${state}`;
}

// Button labels and the command descriptions: Telegram does not parse them, so they are plain
// strings and are never escaped — an entity here would be shown literally. The catalog's
// `buttons` and `commands` groups; the confirm button branches on the address here.
// The waiting message's «⏹» (#536) is the backend's; the bot draws sessionStopButton only in place
// of a pressed waiting message after an unknown stop outcome (#587, waitingStopKeyboard).
type LabelKey = Exclude<
  BotTextKeyOfGroup<typeof BotTextGroup.Buttons | typeof BotTextGroup.Commands>,
  'confirmButtonNoEmail'
>;
interface LabelOverrides {
  confirmButton: (email: string | null) => string;
}
export const LABELS: Omit<Pick<BotPlainTexts, LabelKey>, keyof LabelOverrides> & LabelOverrides =
  facadeOf(
    plain,
    botTextKeysOf(BotTextGroup.Buttons, BotTextGroup.Commands).filter(
      (key): key is LabelKey => key !== 'confirmButtonNoEmail',
    ),
    { confirmButton: (email: string | null): string => confirmButtonLabel(plain, email) },
  );

// what «📤 Поделиться» puts beside the link in the chat the user picks (#115); plain, as a label
export const inviteShareText = (): string => plain.inviteShareText;

// /paysupport (#118, docs/stars.md → /paysupport): the header, then a line per payment in the order
// given (newest first), by its state — a request already made reads as such until the refund.
export function paysupportText(payments: readonly StarPaymentView[]): TelegramHtml {
  const lines = payments.map(paysupportLine);
  // a hole holding an array is joined without a separator, so the newlines are written here
  const joined = lines.slice(1).reduce(
    (all, line) => telegramHtml`${all}
${line}`,
    lines[0] ?? telegramHtml``,
  );
  return telegramHtml`${TEXTS.paysupportScreen}

${joined}`;
}

function paysupportLine({ paidAt, totalAmount, status, requested }: StarPaymentView): TelegramHtml {
  const context = { paymentDate: paidAt, stars: String(totalAmount) };
  if (status === StarPaymentStatus.Refunded) return TEXTS.paysupportLineRefunded(context);
  if (requested) return TEXTS.paysupportLineRequested(context);
  return status === StarPaymentStatus.Held
    ? TEXTS.paysupportLineHeld(context)
    : TEXTS.paysupportLinePaid(context);
}

// plain, as every button label
export const paysupportRefundLabel = (paidAt: number): string =>
  plain.paysupportRefundButton({ paymentDate: paidAt });
export const paysupportListLabel = (): string => plain.paysupportListButton;

// The Stars purchase (#117, docs/stars.md): Telegram parses none of these, so they are plain like
// the labels — the package and pay buttons, the invoice's title and description, and the
// pre-checkout's error_message.
export const buyPackageLabel = ({ tokens, stars }: { tokens: bigint; stars: number }): string =>
  plain.buyPackageButton({ purchasedTokens: tokens.toString(), stars: String(stars) });
export const starsPayLabel = (stars: number): string =>
  plain.starsPayButton({ stars: String(stars) });
export const starsInvoiceTitle = (): string => plain.starsInvoiceTitle;
export const starsInvoiceDescription = (tokens: string): string =>
  plain.starsInvoiceDescription({ purchasedTokens: tokens });
export const starsPreCheckoutError = (failed: boolean): string =>
  failed ? plain.starsPreCheckoutFailed : plain.starsPreCheckoutRefused;

// The demo's asset types (#125); ₿ is not Extended_Pictographic, so the crypto group takes 💠.
export const DEMO_GROUP_LABELS = labelsOf({
  currency: 'demoGroupCurrency',
  commodity: 'demoGroupCommodity',
  stock: 'demoGroupStock',
  cryptocurrency: 'demoGroupCryptocurrency',
  index: 'demoGroupIndex',
  other: 'demoGroupOther',
} as const satisfies Record<PairTypeGroup, BotStaticPlainKey>);

export const DEMO_DURATION_LABELS = labelsOf({
  5: 'demoDuration5',
  15: 'demoDuration15',
} as const satisfies Record<DemoDurationSec, BotStaticPlainKey>);

// a type's button with the count of its open pairs
export const groupButtonLabel = (group: PairTypeGroup, openCount: number): string =>
  `${DEMO_GROUP_LABELS[group]} · ${openCount}`;
// the analysis screen's button by the signal's direction (#126), with the amount it trades when
// known (#297), and the mode's label in real mode (#121), so a real trade never looks like a demo
// one; MODE_LABELS is data, not a text
export const stakeButtonLabel = (
  action: TradeAction,
  amount: string | null = null,
  mode: TradeMode = TradeMode.Demo,
): string =>
  plain.stakeButton({
    action: [
      ACTION_LABELS[action],
      ...(amount === null ? [] : [formatStake(amount)]),
      ...(mode === TradeMode.Real ? [MODE_LABELS[TradeMode.Real]] : []),
    ].join(' · '),
  });
// a data label, like the confirm button's address: no emoji, the pair's label (pairLabel: the
// broker's symbol, " OTC" by isOtc, #428), the payout printed as it arrives; no separators, so it
// fits a half-width button (#419)
export const pairButtonLabel = (label: PairLabel, payout: number): string =>
  `${label} ${String(payout)}%`;

// One screen of a type's pairs: the header naming the type, the page line.
export const demoPairsScreen = (
  group: PairTypeGroup,
  page: number,
  pageCount: number,
): TelegramHtml =>
  telegramHtml`${TEXTS.demoPairsHeader({ group: DEMO_GROUP_LABELS[group] })}
${TEXTS.demoPage({ page: `${page + 1} из ${pageCount}` })}`;

// The share of right forecasts at which a fixed stake breaks even, one decimal (#379); a dash
// where the payout gives none. At most «100.0» (BOT_TEXT_WIDTHS.breakEven).
export const formatBreakEven = (payout: number): string =>
  Number.isFinite(payout) && payout > 0 ? breakEvenPct(payout).toFixed(1) : '—';

// every pair screen that names the payout names the break-even share too (#379)
export const payoutText = (pair: PairView): TelegramHtml =>
  TEXTS.demoPayout({ payout: String(pair.payout), breakEven: formatBreakEven(pair.payout) });

export const demoDurationsScreen = (pair: PairView): TelegramHtml =>
  telegramHtml`${TEXTS.demoAsset({ symbol: pairLabel(pair) })}
${payoutText(pair)}

${TEXTS.demoChooseDuration}`;

export const demoSummary = (pair: PairView, durationSec: DemoDurationSec): TelegramHtml =>
  telegramHtml`${TEXTS.demoAsset({ symbol: pairLabel(pair) })}
${TEXTS.demoDurationLine({ label: DEMO_DURATION_LABELS[durationSec] })}
${payoutText(pair)}

${TEXTS.demoNext}`;

// the analysis screen's ATR in quote steps (#379)
export const atrTicksText = (count: string): string => plain.analysisAtrTicks({ count });

// an indicator of the analysis card without enough closed candles (#482)
export const indicatorShortText = (count: number, required: number): string =>
  plain.indicatorShortData({ count: String(count), required: String(required) });

// The signals screen's arrow (#320): a data mark like the pair's payout, so it stays out of the
// catalog, and the word labels would not fit a row of pairs, two buttons wide since #419.
const SIGNAL_ARROWS = {
  [TradeAction.Up]: '⬆️',
  [TradeAction.Down]: '⬇️',
} as const satisfies Record<TradeAction, string>;
// a pair with a signal: the pair's label, the scanner's direction at the last closed candle, the
// payout
export const signalButtonLabel = (label: PairLabel, action: TradeAction, payout: number): string =>
  `${label} ${SIGNAL_ARROWS[action]} ${String(payout)}%`;

// The launch screen (#320): the pair at the chosen duration (#382), the amount the cycle trades,
// what the cycle does. A symbol the catalog did not give drops its line, an amount access did not
// give reads as the broker's minimum; `saved` is what the picker has just saved and in which mode,
// null for the reset to the minimum. In real mode (#327) the cycle line says the trades use real
// money.
export function launchText({
  firstName,
  durationSec,
  symbol,
  amount,
  cycles,
  saved,
  mode = TradeMode.Demo,
}: {
  firstName: string;
  durationSec: DemoDurationSec;
  symbol: PairLabel | null;
  amount: DecimalString | null;
  cycles: number;
  saved?: { amount: DecimalString | null; mode: TradeMode };
  mode?: TradeMode;
}): TelegramHtml {
  const context = { firstName, stake: amount };
  const lines = [
    ...(symbol === null
      ? []
      : [
          TEXTS.launchHeader({
            ...context,
            subject: `${symbol} · ${DEMO_DURATION_LABELS[durationSec]}`,
          }),
        ]),
    amount === null
      ? TEXTS.launchStakeMinimum(context)
      : TEXTS.launchStake({ ...context, stake: amount }),
    (mode === TradeMode.Real ? TEXTS.launchCycleReal : TEXTS.launchCycle)({
      ...context,
      cycles: cyclesCount(cycles),
    }),
  ];
  if (saved === undefined) return joinLines(lines);
  return telegramHtml`${stakeSavedLine(saved.mode, { firstName, stake: saved.amount })}

${joinLines(lines)}`;
}

// The amount screen of a demo cycle (#476, demo.ts → cycleStakeScreen): the pair, the cycle, then
// the call to choose an amount, or the picker's line when the demo balance is below the broker's
// minimum. `stake` is the amount in effect; after a picker save the saved line leads, as on the
// launch screen.
export function cycleStakeText({
  firstName,
  durationSec,
  symbol,
  stake,
  access,
  broker,
  empty,
  saved,
  cycles = DEFAULT_SESSION_CYCLES,
}: {
  firstName: string;
  durationSec: DemoDurationSec;
  symbol: PairLabel | null;
  stake: DecimalString;
  access: AccessForTexts;
  broker: BrokerBalanceView;
  empty: boolean;
  saved?: { amount: DecimalString | null; mode: TradeMode };
  // a parameter so the length test reaches the widest plural, as launchText's
  cycles?: number;
}): TelegramHtml {
  const context = { firstName, stake };
  const lines = [
    ...(symbol === null
      ? []
      : [
          TEXTS.launchHeader({
            ...context,
            subject: `${symbol} · ${DEMO_DURATION_LABELS[durationSec]}`,
          }),
        ]),
    TEXTS.launchCycle({ ...context, cycles: cyclesCount(cycles) }),
  ];
  const choose = empty
    ? TEXTS.stakePickerNoPresets({
        ...userContextOf(firstName, TradeMode.Demo, access),
        minStake: broker.minTradeAmount,
        demoAvailable: broker.demo.available,
        realAvailable: broker.real.available,
      })
    : TEXTS.cycleStakeChoose({ firstName });
  const body = telegramHtml`${joinLines(lines)}

${choose}`;
  if (saved === undefined) return body;
  return telegramHtml`${stakeSavedLine(saved.mode, { firstName, stake: saved.amount })}

${body}`;
}

// An amount's button on that screen: ✅ on the amount in effect, «· риск» from
// STAKE_RISK_THRESHOLD (#476)
export const cycleStakeLabel = (amount: DecimalString, current: boolean): string => {
  const shown = current ? `${formatStake(amount)} ✅` : formatStake(amount);
  return stakeIsRisky(amount) ? plain.stakeRiskButton({ amount: shown }) : shown;
};

export const levelLabel = (level: NotificationLevel): string => LEVEL_LABELS[level];
// the label of the level that is selected now, on its button
export const currentLevelLabel = (level: NotificationLevel): string => `${levelLabel(level)} ✅`;
// /settings: the level block, then the stake of each mode (#297, #326)
export const settingsText = (
  level: NotificationLevel,
  demoStake: DecimalString | null,
  realStake: DecimalString | null,
  firstName: string,
): TelegramHtml => {
  const context = { level, stake: demoStake, firstName };
  return telegramHtml`${TEXTS.settings(context)}

${TEXTS.settingsStake(context)}
${TEXTS.settingsStakeReal({ ...context, stake: realStake })}`;
};

// the line over a screen after a save, in the saved stake's mode (#326)
export const stakeSavedLine = (
  mode: TradeMode,
  context: { firstName: string; stake: DecimalString | null },
): TelegramHtml =>
  mode === TradeMode.Real ? TEXTS.stakeSavedLineReal(context) : TEXTS.stakeSavedLine(context);

// The stake picker (#297, #326, stake-picker.ts) of one mode: the saved stake, or the broker's
// minimum named as such, then the two bounds the backend checks it against — the minimum and
// that mode's balance. `user.stake` is the picker's mode's saved stake.
export function stakePickerText({
  user,
  mode,
  minTradeAmount,
  demoAvailable,
  realAvailable,
  presets,
}: {
  user: UserTextContext;
  mode: TradeMode;
  minTradeAmount: DecimalString;
  demoAvailable: DecimalString;
  realAvailable: DecimalString;
  presets: number;
}): TelegramHtml {
  const context = { ...user, minStake: minTradeAmount, demoAvailable, realAvailable };
  const real = mode === TradeMode.Real;
  const amount =
    user.stake === null
      ? `${plain.stakeMinimumLabel} (${formatStake(minTradeAmount)})`
      : formatStake(user.stake);
  const lines = [
    TEXTS.stakePickerCurrent({ ...context, amount }),
    TEXTS.stakePickerMinimum(context),
    real ? TEXTS.stakePickerAvailableReal(context) : TEXTS.stakePickerAvailable(context),
    ...(presets === 0
      ? [real ? TEXTS.stakePickerNoPresetsReal(context) : TEXTS.stakePickerNoPresets(context)]
      : []),
  ];
  return telegramHtml`${real ? TEXTS.stakePickerHeaderReal(context) : TEXTS.stakePickerHeader(context)}
${joinLines(lines)}`;
}

// The mode screen (#474, trading-mode.ts): the mode now; with a balance snapshot the real balance
// (as fresh as the card's) and the amount a real trade stakes — the saved real stake or the
// broker's minimum, whatever the mode now; the warning and the session line; the paused line
// while the switch is closed.
export function tradingModeScreen({
  mode,
  broker,
  realStake,
  tradingOpen,
}: {
  mode: TradeMode;
  broker: TradingAccessResponse['broker'];
  realStake: DecimalString | null;
  tradingOpen: boolean;
}): TelegramHtml {
  const lines = [
    TEXTS.modeCurrent({ mode }),
    ...(broker === null
      ? []
      : [
          TEXTS.modeRealBalance({ realBalance: balanceOf(broker, TradeMode.Real) }),
          TEXTS.modeRealStake({ stake: realStake ?? broker.minTradeAmount }),
        ]),
  ];
  const paused = tradingOpen ? [] : [telegramHtml`\n${TEXTS.modePaused}`];
  return telegramHtml`${TEXTS.modeHeader}
${joinLines(lines)}

${TEXTS.modeWarning}
${TEXTS.modeStopsSession}${paused}`;
}

// The confirm of real mode: the amount a real trade stakes; the out-of-bounds line when that amount
// fails checkStake against the snapshot (trading-mode.ts decides it); the session line.
export function tradingModeConfirm({
  stake,
  minTradeAmount,
  realAvailable,
  outOfBounds,
}: {
  stake: DecimalString;
  minTradeAmount: DecimalString;
  realAvailable: DecimalString;
  outOfBounds: boolean;
}): TelegramHtml {
  const warning = outOfBounds
    ? [
        telegramHtml`\n${TEXTS.modeStakeOutOfBounds({ stake, realAvailable, minStake: minTradeAmount })}`,
      ]
    : [];
  return telegramHtml`${TEXTS.modeConfirm({ stake })}${warning}
${TEXTS.modeStopsSession}`;
}

// A switch's result, by the mode the server answered; the session line when it stopped any (#327)
export function tradingModeResult({
  tradingMode,
  stoppedSessions,
}: {
  tradingMode: TradeMode;
  stoppedSessions: number;
}): TelegramHtml {
  const stopped = stoppedSessions >= 1 ? [telegramHtml`\n${TEXTS.modeSessionStopped}`] : [];
  return telegramHtml`${tradingMode === TradeMode.Real ? TEXTS.modeEnabled : TEXTS.modeDisabled}${stopped}`;
}

// The command menu (packages/shared/src/bot-commands.ts) with the descriptions in effect now: the
// menu published at start and /help's lines (#301).
export const botCommands = (): BotCommand[] => botCommandsOf(plain);

// The bot's profile: `description` is the «Что умеет этот бот?» block an empty chat shows before
// Start, `shortDescription` the line on the profile page and in the preview of a shared link.
// Telegram parses neither, so like LABELS they are plain and never escaped; line breaks are kept
// as written. The Bot API limits (512 and 120) are the catalog entries' limits.
export const PROFILE = {
  get description(): string {
    return plain.profileDescription;
  },
  get shortDescription(): string {
    return plain.profileShortDescription;
  },
};
