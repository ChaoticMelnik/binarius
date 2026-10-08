import { describe, expect, it } from 'vitest';
import {
  ADMIN_BOT_TEXT_FRAGMENTS_MAX,
  ADMIN_BOT_TEXT_REASON_MAX,
  adminBotTextReason,
  adminBotTextPreviewResponseSchema,
  adminBotTextResponseSchema,
  adminBotTextSaveRequestSchema,
  isAdminBotTextEditable,
  renderBotTextPreview,
} from './admin-bot-texts';
import { BotTextProblemCode } from './bot-text-template';
import { BotTextRejectionCode, resolveBotTextOverrides } from './bot-text-overrides';
import { BOT_TEXT_CATALOG, defaultBotTextSource, type BotTextKey } from './bot-texts';

const keys = Object.keys(BOT_TEXT_CATALOG) as BotTextKey[];
const me = {
  staffId: '00000000-0000-4000-8000-000000000001',
  login: 'ada',
  sessionId: '00000000-0000-4000-8000-000000000002',
};
const text = { key: 'welcome', override: null, rejection: null, fragments: [] };

describe('the read-only fence of the admin (#300)', () => {
  it('holds exactly the commands and the profile', () => {
    const readOnly = keys.filter((key) => !isAdminBotTextEditable(key));
    expect(readOnly).toEqual(
      keys.filter((key) => ['commands', 'profile'].includes(BOT_TEXT_CATALOG[key].group)),
    );
    expect(readOnly).toContain('profileDescription');
    expect(readOnly).toContain('startCommand');
    for (const key of ['welcome', 'connectButton', 'levelAll'] as const) {
      expect(isAdminBotTextEditable(key)).toBe(true);
    }
  });
});

describe('adminBotTextReason', () => {
  it('cuts a long reason to the wire limit and leaves a short one alone', () => {
    const problems = Array.from({ length: 100 }, () => ({ code: BotTextProblemCode.Empty }));
    const cut = adminBotTextReason({ code: BotTextRejectionCode.Invalid, problems }, 'welcome');
    expect(cut).toHaveLength(ADMIN_BOT_TEXT_REASON_MAX);
    expect(cut.endsWith('…')).toBe(true);
    expect(adminBotTextReason({ code: BotTextRejectionCode.UnknownKey }, 'zzz')).toBe(
      'Неизвестный ключ — игнорируется',
    );
  });
});

describe('the wire schemas', () => {
  it('refuse a key the backend grew', () => {
    expect(adminBotTextResponseSchema.safeParse({ me, text }).success).toBe(true);
    expect(adminBotTextResponseSchema.safeParse({ me: { ...me, x: 1 }, text }).success).toBe(false);
    expect(adminBotTextResponseSchema.safeParse({ me, text: { ...text, x: 1 } }).success).toBe(
      false,
    );
    const override = {
      source: 'a',
      version: 1,
      updatedAt: '2026-10-08T00:00:00Z',
      updatedByLogin: null,
    };
    expect(
      adminBotTextResponseSchema.safeParse({
        me,
        text: { ...text, override: { ...override, x: 1 } },
      }).success,
    ).toBe(false);
  });

  it('take only Telegram HTML Telegram would accept as a rendered preview', () => {
    const answer = (telegramHtml: string) =>
      adminBotTextPreviewResponseSchema.safeParse({
        me,
        text,
        outcome: 'rendered',
        rendered: { kind: 'html', telegramHtml },
      }).success;
    expect(answer('<b>a</b>')).toBe(true);
    expect(answer('a < b')).toBe(false);
  });

  it.each([
    [-1, false],
    [2 ** 53, false],
    [1.5, false],
    [0, true],
  ])('takes expectedVersion %s: %s', (expectedVersion, ok) => {
    expect(adminBotTextSaveRequestSchema.safeParse({ source: 'a', expectedVersion }).success).toBe(
      ok,
    );
  });

  it('counts the source in code points, as the table CHECK', () => {
    const save = (source: string) =>
      adminBotTextSaveRequestSchema.safeParse({ source, expectedVersion: 0 }).success;
    expect(save('😀'.repeat(16384))).toBe(true);
    expect(save('😀'.repeat(16385))).toBe(false);
  });
});

describe('the catalog', () => {
  it('gives no key more fragments than the view carries', () => {
    for (const key of keys) {
      expect(Object.keys(BOT_TEXT_CATALOG[key].fragments).length).toBeLessThanOrEqual(
        ADMIN_BOT_TEXT_FRAGMENTS_MAX,
      );
    }
  });
});

describe('renderBotTextPreview', () => {
  it('fills every variable with its registry sample and the fragments with the texts in effect', () => {
    const codeSent = renderBotTextPreview('codeSent', defaultBotTextSource);
    expect(codeSent).toMatchObject({ kind: 'html' });
    expect(JSON.stringify(codeSent)).toContain('ada@example.com');
    const { source } = resolveBotTextOverrides([{ key: 'connectButton', source: 'Жми' }]);
    expect(JSON.stringify(renderBotTextPreview('welcome', source))).toContain('«Жми»');
    expect(renderBotTextPreview('connectButton', source)).toEqual({ kind: 'plain', text: 'Жми' });
  });
});
