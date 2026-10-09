import {
  botCommandsOf,
  botTextKeysOf,
  BotTextGroup,
  BrokerAccountStatus,
  confirmButtonLabel,
  createBotTexts,
  DEFAULT_SESSION_TRADES,
  defaultBotTextSource,
  formatStake,
  formatUsd,
  isPendingLink,
  LinkBonusSkipReason,
  BrokerBalanceUnavailableReason,
  NotificationLevel,
  telegramHtml,
  TradeAction,
  TRADE_INTENT_TRANSITIONS,
  TradeIntentFailureReason,
  TradeIntentStatus,
  TradeMode,
  TradingSessionStatus,
  TradingSessionStopReason,
  type BotHtmlKey,
  type BotStaticHtmlKey,
  type BotStaticPlainKey,
  type BotTextBalance,
  type BotTextKey,
  type BotTextKeyOfGroup,
  type BotTextSource,
  type DecimalString,
  type LinkBonusGrantView,
  type LinkedAccountView,
  type PairView,
  type TelegramHtml,
  type TradeIntentView,
  type TradingAccessResponse,
  type TradingSessionView,
} from '@binarius/shared';
import type { BotCommand } from 'grammy/types';
import type { DemoAssetGroup, DemoDurationSec } from './demo-catalog';

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

// A trade's direction in words: the analysis screen's headline and its stake button (#126), and
// #127's status texts.
export const ACTION_LABELS = labelsOf({
  [TradeAction.Up]: 'actionUp',
  [TradeAction.Down]: 'actionDown',
} as const satisfies Record<TradeAction, BotStaticPlainKey>);

// Messages are Telegram HTML, sent with parse_mode HTML by send.ts only. Every hole is escaped
// unless it is TelegramHtml already, and every assembled text is checked again
// (telegramHtmlTemplate); a variable's value is escaped like any string (bot-text-vars.ts). The
// catalog's html keys but three: cardGreeting branches to cardGreetingNoName, featureLines is a
// fragment of cardBody and helpAbout, and only the backend's push sends oauthLoginFailed.
const NOT_IN_TEXTS = ['cardGreetingNoName', 'featureLines', 'oauthLoginFailed'] as const;
type TextKey = Exclude<BotHtmlKey, (typeof NOT_IN_TEXTS)[number]>;

export const TEXTS = facadeOf(
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

type AccessForTexts = Pick<TradingAccessResponse, 'tokens' | 'broker' | 'demoStake'>;

// a balance with the freshness the backend judged (isBalanceFresh); null with no snapshot
export const balanceOf = (
  broker: TradingAccessResponse['broker'],
  side: TradeMode,
): BotTextBalance =>
  broker === null ? null : { amount: broker[side].available, fresh: broker.fresh };

// `mode` is the card's: DEMO until a user can trade on real
export const userContextOf = (
  firstName: string,
  mode: TradeMode,
  { tokens, broker, demoStake }: AccessForTexts,
): UserTextContext => ({
  firstName,
  tokens: tokens.available,
  reservedTokens: tokens.reserved,
  demoBalance: balanceOf(broker, TradeMode.Demo),
  realBalance: balanceOf(broker, TradeMode.Real),
  mode,
  stake: demoStake,
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
  return grant.reason === LinkBonusSkipReason.NotPartnerClient
    ? TEXTS.cardBonusNotPartner(context)
    : TEXTS.cardBonusAlready(context);
}

// Only what the card prints reaches it: `status` is branched on before a card exists, and
// tradingOpen is the backend's switch, not the user's mode.
export type StatusCardInput = Pick<
  TradingAccessResponse,
  'tokens' | 'broker' | 'brokerUnavailable' | 'demoStake'
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

${TEXTS.statusHint(context)}`;
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

// The broker's symbol is an unbounded wire string: at most this many characters are printed.
export const INTENT_SYMBOL_LIMIT = 64;

// What the status message shows of an intent: its trade and its status; nothing else of the view.
export type IntentStatusView = Pick<
  TradeIntentView,
  'assetId' | 'action' | 'durationSec' | 'amount' | 'status' | 'lastError'
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

// The demo trade's one message (#127). `symbol` is the pair's as the catalog spells it, or null
// when the catalog could not say (the refresh button): the asset's id stands in for it. The
// callers never ask for the deadline hint and the session offer (#360) together.
export function intentStatusText(
  symbol: string | null,
  view: IntentStatusView,
  { deadline = false, sessionOffer = false }: { deadline?: boolean; sessionOffer?: boolean } = {},
): TelegramHtml {
  const asset =
    symbol === null
      ? plain.intentAssetFallback({ assetId: String(view.assetId) })
      : symbol.slice(0, INTENT_SYMBOL_LIMIT);
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

${TEXTS.intentSessionOffer({ trades: tradesCount(DEFAULT_SESSION_TRADES) })}`,
        ]
      : []),
  ];
  return telegramHtml`${TEXTS.intentHeader}
${TEXTS.intentTrade({ line: trade })}

${statusLineOfIntent(view)}${tail}`;
}

// A demo session's stop reasons but completed, by key (#284). kill_switch reads the single
// trade's own refusal of the closed switch.
const SESSION_STOP_LINES = {
  [TradingSessionStopReason.ManualReview]: 'sessionStopManualReview',
  [TradingSessionStopReason.RejectedTwice]: 'sessionStopRejectedTwice',
  [TradingSessionStopReason.Timeout]: 'sessionStopTimeout',
  [TradingSessionStopReason.StakeStop]: 'sessionStopStakeStop',
  [TradingSessionStopReason.AccountUnavailable]: 'sessionStopAccountUnavailable',
  [TradingSessionStopReason.PairUnavailable]: 'sessionStopPairUnavailable',
  [TradingSessionStopReason.BalanceUnavailable]: 'sessionStopBalanceUnavailable',
  [TradingSessionStopReason.InvalidSettings]: 'sessionStopInvalidSettings',
  [TradingSessionStopReason.UserStopped]: 'sessionStopUserStopped',
  [TradingSessionStopReason.KillSwitch]: 'tradingPaused',
} as const satisfies Record<
  Exclude<TradingSessionStopReason, typeof TradingSessionStopReason.Completed>,
  BotStaticHtmlKey
>;

// «сделка», «сделки» or «сделок» after the number
export function pluralTrades(count: number): string {
  const mod10 = count % 10;
  const mod100 = count % 100;
  if (mod10 === 1 && mod100 !== 11) return plain.sessionTradeOne;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return plain.sessionTradeFew;
  return plain.sessionTradeMany;
}
const tradesCount = (count: number): string => `${String(count)} ${pluralTrades(count)}`;

// the session button of the analysis screen and of a finished trade (#360), with the number of
// trades it starts
export const sessionStartButtonLabel = (trades: number): string =>
  plain.sessionStartButton({ trades: tradesCount(trades) });

// A trade with an outgoing edge in the shared graph: it can still settle or be rejected, so the
// session's counters can still move (manual_review included).
export const sessionIntentLive = (intent: TradeIntentView | null): intent is TradeIntentView =>
  intent !== null && TRADE_INTENT_TRANSITIONS[intent.status].length > 0;

// A trade the worker carries to its end without a person: live, and not on manual review.
const intentPlaysOut = (intent: TradeIntentView | null): intent is TradeIntentView =>
  sessionIntentLive(intent) && intent.status !== TradeIntentStatus.ManualReview;

// What the session message shows of a session; nothing else of the view.
type SessionStatusView = Pick<
  TradingSessionView,
  'status' | 'stopReason' | 'settings' | 'trades' | 'lastIntent'
>;

// a hole holding an array is joined without a separator, so the newlines are written here
const joinLines = ([first, ...rest]: readonly TelegramHtml[]): TelegramHtml =>
  rest.reduce(
    (joined, line) => telegramHtml`${joined}
${line}`,
    first ?? telegramHtml``,
  );

// «3 в плюс, 1 в минус», with «в ноль» only when a trade tied
const scoreOf = ({ won, lost, tied }: TradingSessionView['trades']): string =>
  [
    plain.sessionWon({ count: String(won) }),
    plain.sessionLost({ count: String(lost) }),
    ...(tied > 0 ? [plain.sessionTied({ count: String(tied) })] : []),
  ].join(', ');
const resultOf = (trades: TradingSessionView['trades']): string =>
  `${tradesCount(trades.settled)} — ${scoreOf(trades)}`;

// The demo session's one message (#284, docs/bot-session.md): the header and the settings, then
// a live session's trade number, score and the last trade's status, or a stopped session's
// reason and result. `symbol` is null when the catalog could not say.
export function sessionStatusText(
  symbol: string | null,
  view: SessionStatusView,
  { deadline = false }: { deadline?: boolean } = {},
): TelegramHtml {
  const { settings, trades, lastIntent } = view;
  if (settings === null) {
    return telegramHtml`${TEXTS.sessionHeader}

${TEXTS.sessionSettingsUnavailable}`;
  }
  const asset =
    symbol === null
      ? plain.intentAssetFallback({ assetId: String(settings.assetId) })
      : symbol.slice(0, INTENT_SYMBOL_LIMIT);
  const line = [
    asset,
    durationLabelOf(settings.durationSec),
    plain.intentStake({ amount: formatStake(settings.stake.baseStake) }),
  ].join(' · ');
  const head = [TEXTS.sessionHeader, TEXTS.sessionSettings({ line })];
  const body: TelegramHtml[] = [];
  if (view.status !== TradingSessionStatus.Stopped) {
    const step = Math.min(trades.settled + 1, trades.planned);
    head.push(TEXTS.sessionStep({ step: `${String(step)} из ${String(trades.planned)}` }));
    if (trades.settled > 0) head.push(TEXTS.sessionScore({ score: scoreOf(trades) }));
    body.push(
      sessionIntentLive(lastIntent) ? statusLineOfIntent(lastIntent) : TEXTS.sessionWaitingSignal,
    );
  } else if (view.stopReason === TradingSessionStopReason.Completed) {
    body.push(TEXTS.sessionCompleted({ result: resultOf(trades) }));
  } else {
    if (view.stopReason !== null) body.push(textOf(SESSION_STOP_LINES[view.stopReason]));
    if (trades.settled > 0) body.push(TEXTS.sessionTotal({ result: resultOf(trades) }));
    // manual_review's stop line already says it and points at /support: one text for both of its
    // sources (owner, #284 clarify), so the trade's own review line is not repeated under it
    const reviewRepeated =
      view.stopReason === TradingSessionStopReason.ManualReview &&
      lastIntent?.status === TradeIntentStatus.ManualReview;
    if (sessionIntentLive(lastIntent) && !reviewRepeated) {
      body.push(statusLineOfIntent(lastIntent));
    }
    if (intentPlaysOut(lastIntent)) body.push(TEXTS.sessionOpenTradePlaysOut);
  }
  // stopped with no reason is what the CHECKs refuse; the view's schema still allows it
  if (body.length === 0) body.push(TEXTS.sessionStatusUnavailable);
  // «ещё идёт» is about a session that runs: a stopped one gets its plain final status
  if (deadline && view.status !== TradingSessionStatus.Stopped) body.push(TEXTS.sessionDeadline);
  return telegramHtml`${joinLines(head)}

${joinLines(body)}`;
}

// Button labels and the command descriptions: Telegram does not parse them, so they are plain
// strings and are never escaped — an entity here would be shown literally. The catalog's
// `buttons` and `commands` groups; the confirm button branches on the address here.
type LabelKey = Exclude<
  BotTextKeyOfGroup<typeof BotTextGroup.Buttons | typeof BotTextGroup.Commands>,
  'confirmButtonNoEmail'
>;
export const LABELS = facadeOf(
  plain,
  botTextKeysOf(BotTextGroup.Buttons, BotTextGroup.Commands).filter(
    (key): key is LabelKey => key !== 'confirmButtonNoEmail',
  ),
  { confirmButton: (email: string | null): string => confirmButtonLabel(plain, email) },
);

// The demo's asset types (#125); ₿ is not Extended_Pictographic, so the crypto group takes 💠.
export const DEMO_GROUP_LABELS = labelsOf({
  currency: 'demoGroupCurrency',
  commodity: 'demoGroupCommodity',
  stock: 'demoGroupStock',
  cryptocurrency: 'demoGroupCryptocurrency',
  index: 'demoGroupIndex',
  other: 'demoGroupOther',
} as const satisfies Record<DemoAssetGroup, BotStaticPlainKey>);

export const DEMO_DURATION_LABELS = labelsOf({
  5: 'demoDuration5',
  15: 'demoDuration15',
} as const satisfies Record<DemoDurationSec, BotStaticPlainKey>);

// a type's button with the count of its open pairs
export const groupButtonLabel = (group: DemoAssetGroup, openCount: number): string =>
  `${DEMO_GROUP_LABELS[group]} · ${openCount}`;
// the analysis screen's button by the signal's direction (#126), with the amount it trades when
// known (#297)
export const stakeButtonLabel = (action: TradeAction, amount: string | null = null): string =>
  plain.stakeButton({
    action:
      amount === null ? ACTION_LABELS[action] : `${ACTION_LABELS[action]} · ${formatStake(amount)}`,
  });
// a data label, like the confirm button's address: no emoji, the symbol as the broker spells it
// (it already carries «OTC»), the payout printed as it arrives
export const pairButtonLabel = (symbol: string, payout: number): string =>
  `${symbol} · ${String(payout)}%`;

// One screen of a type's pairs: the header naming the type, the page line.
export const demoPairsScreen = (
  group: DemoAssetGroup,
  page: number,
  pageCount: number,
): TelegramHtml =>
  telegramHtml`${TEXTS.demoPairsHeader({ group: DEMO_GROUP_LABELS[group] })}
${TEXTS.demoPage({ page: `${page + 1} из ${pageCount}` })}`;

export const demoDurationsScreen = (pair: PairView): TelegramHtml =>
  telegramHtml`${TEXTS.demoAsset({ symbol: pair.symbol })}
${TEXTS.demoPayout({ payout: String(pair.payout) })}

${TEXTS.demoChooseDuration}`;

export const demoSummary = (pair: PairView, durationSec: DemoDurationSec): TelegramHtml =>
  telegramHtml`${TEXTS.demoAsset({ symbol: pair.symbol })}
${TEXTS.demoDurationLine({ label: DEMO_DURATION_LABELS[durationSec] })}
${TEXTS.demoPayout({ payout: String(pair.payout) })}

${TEXTS.demoNext}`;

// The signals screen's arrow (#320): a data mark like the pair's payout, so it stays out of the
// catalog, and the word labels would not fit a row of pairs.
const SIGNAL_ARROWS = {
  [TradeAction.Up]: '⬆️',
  [TradeAction.Down]: '⬇️',
} as const satisfies Record<TradeAction, string>;
// a pair with a signal: the symbol, the scanner's direction at the last closed candle, the payout
export const signalButtonLabel = (symbol: string, action: TradeAction, payout: number): string =>
  `${symbol} · ${SIGNAL_ARROWS[action]} · ${String(payout)}%`;

// The launch screen (#320): the pair at the chosen duration (#382), the amount the cycle trades,
// what the cycle does. A symbol the catalog did not give drops its line, an amount access did not
// give reads as the broker's minimum; `saved` is what the picker has just saved, null for the reset
// to the minimum.
export function launchText({
  firstName,
  durationSec,
  symbol,
  amount,
  trades,
  saved,
}: {
  firstName: string;
  durationSec: DemoDurationSec;
  symbol: string | null;
  amount: DecimalString | null;
  trades: number;
  saved?: { amount: DecimalString | null };
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
    TEXTS.launchCycle({ ...context, trades: tradesCount(trades) }),
  ];
  if (saved === undefined) return joinLines(lines);
  return telegramHtml`${TEXTS.stakeSavedLine({ firstName, stake: saved.amount })}

${joinLines(lines)}`;
}

export const levelLabel = (level: NotificationLevel): string => LEVEL_LABELS[level];
// the label of the level that is selected now, on its button
export const currentLevelLabel = (level: NotificationLevel): string => `${levelLabel(level)} ✅`;
export const settingsText = (
  level: NotificationLevel,
  demoStake: DecimalString | null,
  firstName: string,
): TelegramHtml => {
  const context = { level, stake: demoStake, firstName };
  return telegramHtml`${TEXTS.settings(context)}

${TEXTS.settingsStake(context)}`;
};

// The stake picker (#297, stake-picker.ts): the saved stake, or the broker's minimum named as
// such, then the two bounds the backend checks it against.
export function stakePickerText({
  user,
  minTradeAmount,
  demoAvailable,
  presets,
}: {
  user: UserTextContext;
  minTradeAmount: DecimalString;
  demoAvailable: DecimalString;
  presets: number;
}): TelegramHtml {
  const context = { ...user, minStake: minTradeAmount, demoAvailable };
  const amount =
    user.stake === null
      ? `${plain.stakeMinimumLabel} (${formatStake(minTradeAmount)})`
      : formatStake(user.stake);
  const lines = [
    TEXTS.stakePickerCurrent({ ...context, amount }),
    TEXTS.stakePickerMinimum(context),
    TEXTS.stakePickerAvailable(context),
    ...(presets === 0 ? [TEXTS.stakePickerNoPresets(context)] : []),
  ];
  return telegramHtml`${TEXTS.stakePickerHeader(context)}
${joinLines(lines)}`;
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
