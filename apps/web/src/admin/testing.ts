import {
  BrokerAccountStatus,
  NotificationLevel,
  TradeAction,
  TradeIntentFailureReason,
  TradeIntentStatus,
  TradeMode,
  TradeTransport,
  TradingSessionStatus,
  TradingSessionStopReason,
  UserStatus,
  type AdminIntentResponse,
  type AdminIntentsResponse,
  type AdminMe,
  type AdminOverviewResponse,
  type AdminTradeIntentView,
  type AdminTradingSessionsResponse,
  type AdminTradingSessionView,
  type AdminUserListItem,
  type AdminUserResponse,
  type DecimalString,
} from '@binarius/shared';

// Backend answers for the read pages (#107, #108, #330), valid against their strict schemas. Shared by
// the client's and the pages' tests.

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

export const SAMPLE_USER: AdminUserResponse = {
  me: SAMPLE_ME,
  user: {
    id: SAMPLE_USER_ID,
    telegramUserId: '4242',
    displayName: 'Ада',
    languageCode: 'ru',
    status: UserStatus.Active,
    acquisitionSource: null,
    acquiredAt: null,
    telegramBlockedAt: null,
    notificationLevel: NotificationLevel.All,
    demoStake: null,
    tokens: { balance: '5', reserved: '2', available: '3' },
    createdAt: AT,
    updatedAt: AT,
  },
  brokerAccounts: [
    {
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
    },
  ],
  intents: { recent: [SAMPLE_INTENT], total: 3, active: 1 },
};

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
