import { describe, expect, it } from 'vitest';
import type { BackendClient } from './backend-client';
import { createBot } from './bot';
import { botCommands } from './texts';
import {
  ACCOUNT_VIEW,
  REFERRAL_VIEW,
  BOT_INFO,
  USER_VIEW,
  captureApi,
  fakeLogger,
  textUpdate,
  stubSessionTracker,
  stubTracker,
} from './testing';

// The list and its Bot API limits are packages/shared/src/bot-commands.test.ts (#301).
describe('the command menu', () => {
  // grammY keeps no registry of handlers, so the only way to know a listed command is answered
  // is to send it
  it.each(botCommands().map((entry) => entry.command))('answers /%s', async (command) => {
    const backend: BackendClient = {
      recordStart: () => Promise.resolve(USER_VIEW),
      readAccount: () => Promise.resolve(ACCOUNT_VIEW),
      readReferral: () => Promise.resolve(REFERRAL_VIEW),
      confirmLogin: () => Promise.reject(new Error('not used here')),
      sendEmailCode: () => Promise.reject(new Error('not used here')),
      emailLogin: () => Promise.reject(new Error('not used here')),
      recordChatMember: () => Promise.reject(new Error('not used here')),
      setNotificationLevel: () => Promise.reject(new Error('not used here')),
      readTradingAccess: () => Promise.reject(new Error('not used here')),
      readPairs: () => Promise.reject(new Error('not used here')),
      readSignals: () => Promise.reject(new Error('not used here')),
      evaluateSignal: () => Promise.reject(new Error('not used here')),
      createIntent: () => Promise.reject(new Error('not used here')),
      readIntent: () => Promise.reject(new Error('not used here')),
      startSession: () => Promise.reject(new Error('not used here')),
      readSession: () => Promise.reject(new Error('not used here')),
      stopSession: () => Promise.reject(new Error('not used here')),
      claimSessionSummary: () => Promise.reject(new Error('not used here')),
      stopSessions: () => Promise.reject(new Error('not used here')),
      setDemoStake: () => Promise.reject(new Error('not used here')),
      readBotTexts: () => Promise.reject(new Error('not used here')),
    };
    const bot = createBot({
      intentTracker: stubTracker(),
      sessionTracker: stubSessionTracker(),
      token: '123456:AA-bot-token',
      backend,
      logger: fakeLogger(),
      botInfo: BOT_INFO,
    });
    const api = captureApi(bot);

    await bot.handleUpdate(textUpdate(`/${command}`));

    expect(api.calls.map((call) => call.method)).toContain('sendMessage');
  });
});
