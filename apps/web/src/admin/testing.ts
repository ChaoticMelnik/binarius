import {
  BrokerAccountStatus,
  NotificationLevel,
  UserStatus,
  type AdminMe,
  type AdminOverviewResponse,
  type AdminUserListItem,
  type AdminUserResponse,
} from '@binarius/shared';

// Backend answers for the read pages (#107), valid against their strict schemas. Shared by the
// client's and the pages' tests.

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
    intents: { total: 120, today: 9 },
    activeWindowMinutes: 15,
    dayStartsAt: '2026-10-07T00:00:00.000Z',
    asOf: AT,
  },
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
};
