import {
  AdminServiceMarkOutcome,
  ServiceAccountNotWorkingReason,
  AccountHaltReason,
  AuditAction,
  AuditActorType,
  AuditEntityType,
  AuthRevokedReason,
  BrokerAccountStatus,
  DepositEventStatus,
  NotificationLevel,
  StarPaymentStatus,
  TokenLedgerKind,
  TradeAction,
  TradeIntentFailureReason,
  TradeIntentStatus,
  TradeMode,
  TradeTransport,
  TradingSessionStatus,
  TradingSessionStopReason,
  UserStatus,
  type AdminAuditEntryView,
  type AdminAuditResponse,
  type AdminBotProfileMethodResult,
  type AdminBotTextsResponse,
  type AdminBotTextView,
  type AdminBrokerAccountListItem,
  type AdminBrokerAccountsResponse,
  type AdminServiceAccountsResponse,
  type AdminStarPaymentView,
  type AdminStarRefundResponse,
  type AdminStarRefundsResponse,
  type AdminServiceMarkResponse,
  type AdminBrokerAccountView,
  type AdminDepositsResponse,
  type AdminDepositView,
  type AdminIntentResponse,
  type AdminIntentsResponse,
  type AdminLedgerEntry,
  type AdminMe,
  type AdminOverviewResponse,
  type AdminTokenAdjustmentResponse,
  type AdminTokensResponse,
  type AdminTradeIntentView,
  type AdminTradingSessionsResponse,
  type AdminTradingSessionView,
  type AdminUserListItem,
  type AdminUserResponse,
  type DecimalString,
  BotLanguage,
  BotTextKind,
  type AdminBotTextRendered,
} from '@binarius/shared';

// Backend answers for the read pages (#107, #108, #330, #109, #110, #341, #342) and the token
// adjustment (#246), valid against their strict schemas. Shared by the client's and the pages'
// tests.

const AT = '2026-10-07T08:00:00.000Z';

export const SAMPLE_ME: AdminMe = {
  staffId: '00000000-0000-4000-8000-0000000000a1',
  login: 'ada',
  sessionId: '00000000-0000-4000-8000-0000000000a2',
};

export const SAMPLE_USER_ID = '00000000-0000-4000-8000-0000000000c1';

export const SAMPLE_LIST_ITEM: AdminUserListItem = {
  id: SAMPLE_USER_ID,
  telegramUserId: '4242',
  displayName: 'Ада',
  status: UserStatus.Active,
  tokenBalance: '5',
  createdAt: AT,
  updatedAt: AT,
};

export const SAMPLE_OVERVIEW: AdminOverviewResponse = {
  me: SAMPLE_ME,
  overview: {
    users: { total: 31, today: 2, blocked: 1, withActiveBrokerAccount: 7, activeNow: 3 },
    intents: {
      total: 120,
      today: 9,
      // sums to total; active = the eight non-terminal statuses = 12
      byStatus: {
        planned: 1,
        reserved: 1,
        queued: 2,
        submitting: 1,
        accepted: 3,
        settled: 70,
        rejected: 38,
        unknown: 1,
        reconciling: 1,
        manual_review: 2,
      },
      active: 12,
    },
    activeWindowMinutes: 15,
    dayStartsAt: '2026-10-07T00:00:00.000Z',
    asOf: AT,
  },
};

export const SAMPLE_SESSION_ID = '00000000-0000-4000-8000-0000000000e1';

// every nullable key set, so the card shows each field and the session link
export const SAMPLE_INTENT: AdminTradeIntentView = {
  id: '00000000-0000-4000-8000-0000000000f1',
  brokerAccountId: '00000000-0000-4000-8000-0000000000d1',
  telegramUserId: '4242',
  mode: TradeMode.Demo,
  assetId: 101,
  amount: '1.50000000' as DecimalString,
  action: TradeAction.Up,
  durationSec: 60,
  clientRequestId: 'demo:4242:n1',
  createdAt: AT,
  status: TradeIntentStatus.Rejected,
  version: 3,
  tokensReserved: '0',
  transport: TradeTransport.Socket,
  submittedAt: AT,
  lastError: TradeIntentFailureReason.BrokerRejected,
  updatedAt: AT,
  userId: SAMPLE_USER_ID,
  tradingSessionId: SAMPLE_SESSION_ID,
  reconcileClaimedAt: AT,
};

// a reserve: the intent is its one reference
export const SAMPLE_LEDGER_ENTRY: AdminLedgerEntry = {
  id: '00000000-0000-4000-8000-0000000000b1',
  userId: SAMPLE_USER_ID,
  telegramUserId: '4242',
  kind: TokenLedgerKind.Reserve,
  balanceDelta: '0',
  reservedDelta: '1',
  intentId: SAMPLE_INTENT.id,
  depositEventId: null,
  brokerAccountId: null,
  starPaymentId: null,
  referralId: null,
  refType: null,
  refId: null,
  note: null,
  createdAt: AT,
};

// a manual adjustment: no reference, a negative delta, a note that must print as text
export const SAMPLE_LEDGER_ADJUSTMENT: AdminLedgerEntry = {
  ...SAMPLE_LEDGER_ENTRY,
  id: '00000000-0000-4000-8000-0000000000b2',
  kind: TokenLedgerKind.Adjustment,
  balanceDelta: '-3',
  reservedDelta: '0',
  intentId: null,
  note: '<script>alert(1)</script>',
};

// a credited deposit of the sample user, through its account
export const SAMPLE_DEPOSIT: AdminDepositView = {
  id: '00000000-0000-4000-8000-000000000071',
  userId: SAMPLE_USER_ID,
  telegramUserId: '4242',
  brokerAccountId: '00000000-0000-4000-8000-0000000000d1',
  brokerUserId: 'broker-7',
  paymentId: 'pay-1',
  amount: '10.50000000' as DecimalString,
  currency: 'USD',
  status: DepositEventStatus.Credited,
  processedAt: AT,
  createdAt: AT,
};

// an unattributed postback: every nullable key null, a trader id that must print as text
export const SAMPLE_DEPOSIT_UNOWNED: AdminDepositView = {
  id: '00000000-0000-4000-8000-000000000072',
  userId: null,
  telegramUserId: null,
  brokerAccountId: null,
  brokerUserId: 'trader-<b>',
  paymentId: 'pay-2',
  amount: '5.00000000' as DecimalString,
  currency: null,
  status: DepositEventStatus.Received,
  processedAt: null,
  createdAt: AT,
};

// A Stars purchase of the sample user (#510), still refundable, its refund asked for
export const SAMPLE_STAR_PAYMENT: AdminStarPaymentView = {
  id: '00000000-0000-4000-8000-0000000000e1',
  userId: SAMPLE_USER_ID,
  telegramPaymentChargeId: 'charge-<1>',
  payerTelegramUserId: '4242',
  packageCode: 'p50',
  totalAmount: 100,
  tokens: '50',
  status: StarPaymentStatus.Paid,
  paidAt: AT,
  refundedAt: null,
  requestedAt: AT,
};

// one refunded before: no refund form
export const SAMPLE_STAR_PAYMENT_REFUNDED: AdminStarPaymentView = {
  ...SAMPLE_STAR_PAYMENT,
  id: '00000000-0000-4000-8000-0000000000e2',
  telegramPaymentChargeId: 'charge-2',
  status: StarPaymentStatus.Refunded,
  refundedAt: AT,
  requestedAt: null,
};

export const SAMPLE_BROKER_ACCOUNT: AdminBrokerAccountView = {
  id: '00000000-0000-4000-8000-0000000000d1',
  brokerUserId: 'broker-7',
  email: 'ada@example.com',
  isPartnerClient: true,
  status: BrokerAccountStatus.Active,
  authRevokedReason: null,
  tradingHalted: false,
  haltedReason: null,
  accessTokenExpiresAt: AT,
  tokenRotatedAt: null,
  createdAt: AT,
  updatedAt: AT,
  serviceSince: null,
};

export const SAMPLE_USER: AdminUserResponse = {
  me: SAMPLE_ME,
  user: {
    id: SAMPLE_USER_ID,
    telegramUserId: '4242',
    displayName: 'Ада',
    languageCode: 'ru',
    language: BotLanguage.Ru,
    status: UserStatus.Active,
    acquisitionSource: null,
    acquiredAt: null,
    telegramBlockedAt: null,
    notificationLevel: NotificationLevel.All,
    demoStake: null,
    realStake: null,
    tokens: { balance: '5', reserved: '2', available: '3' },
    createdAt: AT,
    updatedAt: AT,
  },
  brokerAccounts: [SAMPLE_BROKER_ACCOUNT],
  intents: { recent: [SAMPLE_INTENT], total: 3, active: 1 },
  ledger: { recent: [SAMPLE_LEDGER_ENTRY] },
  deposits: { recent: [SAMPLE_DEPOSIT] },
  starPayments: { recent: [SAMPLE_STAR_PAYMENT, SAMPLE_STAR_PAYMENT_REFUNDED] },
};

// The requests page (#510): one open request, of the sample payment
export const SAMPLE_STAR_REFUNDS: AdminStarRefundsResponse = {
  me: SAMPLE_ME,
  requests: [
    {
      ...SAMPLE_STAR_PAYMENT,
      requestId: '00000000-0000-4000-8000-0000000000e9',
      requestedAt: AT,
    },
  ],
  nextCursor: null,
};

export const SAMPLE_REFUNDED: AdminStarRefundResponse = {
  me: SAMPLE_ME,
  outcome: 'refunded',
  payment: { ...SAMPLE_STAR_PAYMENT, status: StarPaymentStatus.Refunded, refundedAt: AT },
  telegramAnswer: 'refunded',
  tokensTaken: '3',
  tokensNotRecovered: '47',
  balance: '2',
};

// The token adjustment (#246): a credit of 50 on the sample user's balance of 5, and the two
// refusals, which carry the card as it is now.
export const SAMPLE_ADJUSTED: AdminTokenAdjustmentResponse = {
  me: SAMPLE_ME,
  outcome: 'adjusted',
  entry: {
    ...SAMPLE_LEDGER_ADJUSTMENT,
    id: '00000000-0000-4000-8000-0000000000b3',
    balanceDelta: '50',
    note: 'Компенсация',
  },
  tokens: { balance: '55', reserved: '2', available: '53' },
};

export const sampleAdjustmentRefusal = (
  outcome: 'insufficient_available' | 'balance_changed',
  tokens: AdminUserResponse['user']['tokens'] = SAMPLE_USER.user.tokens,
): AdminTokenAdjustmentResponse => ({
  ...SAMPLE_USER,
  outcome,
  user: { ...SAMPLE_USER.user, tokens },
});

export const SAMPLE_INTENTS: AdminIntentsResponse = {
  me: SAMPLE_ME,
  intents: [SAMPLE_INTENT],
  nextCursor: null,
};

export const SAMPLE_INTENT_RESPONSE: AdminIntentResponse = { me: SAMPLE_ME, intent: SAMPLE_INTENT };

// every nullable key set, settings v1
export const SAMPLE_TRADING_SESSION: AdminTradingSessionView = {
  id: SAMPLE_SESSION_ID,
  brokerAccountId: '00000000-0000-4000-8000-0000000000d1',
  brokerUserId: 'broker-7',
  userId: SAMPLE_USER_ID,
  telegramUserId: '4242',
  mode: TradeMode.Demo,
  status: TradingSessionStatus.Stopped,
  stopReason: TradingSessionStopReason.RejectedTwice,
  settings: {
    version: 1,
    assetId: 101,
    durationSec: 60,
    trades: 5,
    stake: { baseStake: '1.5' as DecimalString, stakeScale: 1 },
  },
  startedAt: AT,
  endedAt: AT,
  lastDecisionAt: AT,
  createdAt: AT,
  updatedAt: AT,
};

// an active session whose settings did not parse: every nullable key null
export const SAMPLE_TRADING_SESSION_NULLS: AdminTradingSessionView = {
  ...SAMPLE_TRADING_SESSION,
  id: '00000000-0000-4000-8000-0000000000e2',
  status: TradingSessionStatus.Active,
  stopReason: null,
  settings: null,
  endedAt: null,
  lastDecisionAt: null,
};

export const SAMPLE_TRADING_SESSIONS: AdminTradingSessionsResponse = {
  me: SAMPLE_ME,
  sessions: [SAMPLE_TRADING_SESSION, SAMPLE_TRADING_SESSION_NULLS],
  nextCursor: null,
};

export const SAMPLE_TOKENS: AdminTokensResponse = {
  me: SAMPLE_ME,
  entries: [SAMPLE_LEDGER_ENTRY, SAMPLE_LEDGER_ADJUSTMENT],
  nextCursor: null,
};

export const SAMPLE_AUDIT_ENTRY: AdminAuditEntryView = {
  id: '00000000-0000-4000-8000-0000000000f1',
  createdAt: AT,
  actorType: AuditActorType.Admin,
  actorId: SAMPLE_ME.staffId,
  actorLogin: 'ada',
  action: AuditAction.UserViewed,
  entityType: AuditEntityType.User,
  entityId: SAMPLE_USER_ID,
  payload: '{"path": "/admin/users/:id", "result": "found"}',
  payloadTruncated: false,
};

export const SAMPLE_AUDIT_ENTRY_NULLS: AdminAuditEntryView = {
  id: '00000000-0000-4000-8000-0000000000f2',
  createdAt: AT,
  actorType: AuditActorType.System,
  actorId: 'cli',
  actorLogin: null,
  action: AuditAction.BotTextSaved,
  entityType: null,
  entityId: null,
  payload: '{"note": "<script>alert(1)</script>"}',
  payloadTruncated: true,
};

export const SAMPLE_AUDIT_ENTRY_INTENT: AdminAuditEntryView = {
  ...SAMPLE_AUDIT_ENTRY,
  id: '00000000-0000-4000-8000-0000000000f3',
  action: AuditAction.IntentViewed,
  entityType: AuditEntityType.TradeIntent,
  entityId: SAMPLE_INTENT.id,
  payload: '{}',
};

export const SAMPLE_AUDIT: AdminAuditResponse = {
  me: SAMPLE_ME,
  entries: [SAMPLE_AUDIT_ENTRY, SAMPLE_AUDIT_ENTRY_NULLS, SAMPLE_AUDIT_ENTRY_INTENT],
  nextCursor: null,
};

export const SAMPLE_DEPOSITS: AdminDepositsResponse = {
  me: SAMPLE_ME,
  deposits: [SAMPLE_DEPOSIT, SAMPLE_DEPOSIT_UNOWNED],
  nextCursor: null,
};

// The broker accounts list (#342): the card's account with its owner, and a revoked, halted one
// with no address, no rotation and a broker id that must print as text.
export const SAMPLE_BROKER_ACCOUNT_ITEM: AdminBrokerAccountListItem = {
  ...SAMPLE_BROKER_ACCOUNT,
  userId: SAMPLE_USER_ID,
  telegramUserId: '4242',
};

export const SAMPLE_BROKER_ACCOUNT_HALTED: AdminBrokerAccountListItem = {
  ...SAMPLE_BROKER_ACCOUNT_ITEM,
  id: '00000000-0000-4000-8000-0000000000d2',
  brokerUserId: 'broker-<b>',
  email: null,
  isPartnerClient: false,
  status: BrokerAccountStatus.Revoked,
  authRevokedReason: AuthRevokedReason.RefreshInvalidGrant,
  tradingHalted: true,
  haltedReason: AccountHaltReason.TradeMismatch,
};

export const SAMPLE_BROKER_ACCOUNTS: AdminBrokerAccountsResponse = {
  me: SAMPLE_ME,
  accounts: [SAMPLE_BROKER_ACCOUNT_HALTED, SAMPLE_BROKER_ACCOUNT_ITEM],
  nextCursor: null,
};

// The service accounts page (#391): one working, one revoked by a failed exchange, one whose
// token expired; the minimum is 3, so the page shows 1 of 3.
const SERVICE_SINCE = '2026-10-01T00:00:00.000Z';
export const SAMPLE_SERVICE_ACCOUNTS: AdminServiceAccountsResponse = {
  me: SAMPLE_ME,
  min: 3,
  working: 1,
  accounts: [
    {
      ...SAMPLE_BROKER_ACCOUNT_ITEM,
      serviceSince: SERVICE_SINCE,
      working: true,
      notWorkingReason: null,
    },
    {
      ...SAMPLE_BROKER_ACCOUNT_HALTED,
      authRevokedReason: AuthRevokedReason.RefreshOutcomeUnknown,
      serviceSince: SERVICE_SINCE,
      working: false,
      notWorkingReason: ServiceAccountNotWorkingReason.Revoked,
    },
    {
      ...SAMPLE_BROKER_ACCOUNT_ITEM,
      id: '00000000-0000-4000-8000-0000000000d3',
      brokerUserId: 'broker-9',
      email: 'eve@example.com',
      serviceSince: SERVICE_SINCE,
      working: false,
      notWorkingReason: ServiceAccountNotWorkingReason.TokenExpired,
    },
  ],
};

export const SAMPLE_SERVICE_MARKED: AdminServiceMarkResponse = {
  me: SAMPLE_ME,
  outcome: AdminServiceMarkOutcome.Marked,
  account: { ...SAMPLE_BROKER_ACCOUNT, serviceSince: SERVICE_SINCE },
};

// The bot texts section (#300): welcome overridden by a staff member, its connectButton fragment by
// the CLI, a commands key the loaders reject, an orphan row from a renamed key; in English (#634),
// welcome and an orphan of its own.
export const SAMPLE_BOT_TEXTS: AdminBotTextsResponse = {
  me: SAMPLE_ME,
  overrides: [
    {
      language: BotLanguage.En,
      key: 'welcome',
      version: 11,
      updatedAt: AT,
      updatedByLogin: 'ada',
      rejection: null,
    },
    {
      language: BotLanguage.En,
      key: 'yyy',
      version: 12,
      updatedAt: AT,
      updatedByLogin: null,
      rejection: 'Неизвестный ключ — игнорируется',
    },
    {
      language: BotLanguage.Ru,
      key: 'connectButton',
      version: 3,
      updatedAt: AT,
      updatedByLogin: null,
      rejection: null,
    },
    {
      language: BotLanguage.Ru,
      key: 'startCommand',
      version: 4,
      updatedAt: AT,
      updatedByLogin: null,
      rejection: 'Пустой текст',
    },
    {
      language: BotLanguage.Ru,
      key: 'welcome',
      version: 7,
      updatedAt: AT,
      updatedByLogin: 'ada',
      rejection: null,
    },
    {
      language: BotLanguage.Ru,
      key: 'zzz',
      version: 9,
      updatedAt: AT,
      updatedByLogin: null,
      rejection: 'Неизвестный ключ — игнорируется',
    },
  ],
};

// A publish of all three (#361): the English description refused by Telegram (#508), the rest
// through.
export const SAMPLE_PUBLISHED: AdminBotProfileMethodResult[] = [
  { method: 'setMyCommands', ok: true },
  {
    method: 'setMyDescription',
    ok: false,
    err: { name: 'GrammyError' },
    telegramErrorCode: 400,
    language: BotLanguage.En,
  },
  { method: 'setMyShortDescription', ok: true },
];
// what it puts in the query, encoded
export const SAMPLE_PUBLISHED_QUERY =
  'setMyCommands%3Aok%2CsetMyDescription%3AGrammyError%3A400%40en%2CsetMyShortDescription%3Aok';

export const SAMPLE_BOT_TEXT: AdminBotTextView = {
  language: BotLanguage.Ru,
  key: 'welcome',
  override: { source: 'Привет, <b>друг</b>', version: 7, updatedAt: AT, updatedByLogin: 'ada' },
  rejection: null,
  fragments: [
    { placeholder: 'connectButton', key: 'connectButton', source: 'Жми', overridden: true },
  ],
};

// A preview of SAMPLE_BOT_TEXT as the backend renders it (#657): Telegram HTML that
// telegramHtmlProblems accepts, with the expandable quote the preview styles.
export const SAMPLE_RENDERED: AdminBotTextRendered = {
  kind: BotTextKind.Html,
  telegramHtml: 'Привет, <b>друг</b>\n\n<blockquote expandable>Жми</blockquote>',
};
