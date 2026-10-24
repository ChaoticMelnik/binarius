import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  AuditActorType,
  BOT_TEXT_CATALOG,
  BOT_TEXT_SOURCES_EN,
  BotLanguage,
  adminBotTextOverrideViewSchema,
  adminBotTextViewSchema,
  resolveBotTextOverrides,
} from '@binarius/shared';
import {
  listBotTextOverridesForAdmin,
  toAdminBotTextOverrideView,
  toAdminBotTextView,
} from './admin-bot-text-ops';
import { saveBotTextOverride } from './bot-text-ops';
import { botTextOverrides } from './schema/index';
import { createTempDatabase, seedStaff, type TempDatabase } from './testing';

const baseUrl = process.env.TEST_DATABASE_URL;
if (baseUrl === undefined || baseUrl === '') {
  throw new Error(
    'TEST_DATABASE_URL is required for packages/db integration tests (see README → Test database)',
  );
}

let tmp: TempDatabase;
beforeAll(async () => {
  tmp = await createTempDatabase(baseUrl);
});
afterAll(() => tmp.drop());
beforeEach(async () => {
  await tmp.db.delete(botTextOverrides);
});

const rows = () => tmp.db.transaction((tx) => listBotTextOverridesForAdmin(tx));
const save = (
  key: string,
  source: string,
  staffId: string | null,
  language: BotLanguage = BotLanguage.Ru,
) =>
  saveBotTextOverride(tmp.db, {
    language,
    key,
    source,
    actor: { type: staffId === null ? AuditActorType.System : AuditActorType.Admin, staffId },
  });

describe('the admin bot texts reads (#300)', () => {
  it('A1 names the staff member who wrote a row, and no one for the CLI', async () => {
    const { staffId, login } = await seedStaff(tmp.db);
    await save('welcome', 'Привет', staffId);
    await save('connectButton', 'Жми', null);
    expect(await rows()).toMatchObject([
      { key: 'connectButton', source: 'Жми', updatedByLogin: null },
      { key: 'welcome', source: 'Привет', updatedByLogin: login },
    ]);
  });

  it('A2 lists a row whose key the catalog does not have', async () => {
    await tmp.db.insert(botTextOverrides).values({ key: 'zzz', source: 'x' });
    const [row] = await rows();
    const resolved = resolveBotTextOverrides(await rows());
    const view = toAdminBotTextOverrideView(row!, resolved.ru.rejected.get('zzz'));
    expect(adminBotTextOverrideViewSchema.parse(view)).toMatchObject({
      language: 'ru',
      key: 'zzz',
      rejection: 'Неизвестный ключ — игнорируется',
    });
  });

  it('A3 gives a fragment the text in effect and whether it is overridden', async () => {
    const fragmentOf = async () => {
      const current = await rows();
      return toAdminBotTextView('welcome', current, resolveBotTextOverrides(current).ru).fragments;
    };
    expect(await fragmentOf()).toEqual([
      {
        placeholder: 'connectButton',
        key: 'connectButton',
        source: BOT_TEXT_CATALOG.connectButton.source,
        overridden: false,
      },
    ]);
    await save('connectButton', 'Жми', null);
    expect(await fragmentOf()).toEqual([
      { placeholder: 'connectButton', key: 'connectButton', source: 'Жми', overridden: true },
    ]);
  });

  it('A4 gives a row the loaders reject its reason in Russian, and none to one in effect', async () => {
    await tmp.db.insert(botTextOverrides).values({ key: 'startCommand', source: 'Старт\nещё' });
    await save('welcome', 'Привет', null);
    // a profile text the CLI saved (#301) is in effect: no reason
    await tmp.db
      .insert(botTextOverrides)
      .values({ key: 'profileShortDescription', source: 'Коротко' });
    const current = await rows();
    const resolved = resolveBotTextOverrides(current);
    const view = (key: 'startCommand' | 'welcome' | 'profileShortDescription') =>
      adminBotTextViewSchema.parse(toAdminBotTextView(key, current, resolved.ru));
    expect(view('startCommand')).toMatchObject({
      override: { source: 'Старт\nещё', updatedByLogin: null },
      rejection: 'Перенос строки в однострочном тексте',
    });
    expect(view('welcome')).toMatchObject({ override: { source: 'Привет' }, rejection: null });
    expect(view('profileShortDescription')).toMatchObject({
      override: { source: 'Коротко' },
      rejection: null,
    });
  });

  it("A-L1 lists each row with its language, and shows a key in a language from that language's texts (#634)", async () => {
    await save('welcome', 'Привет', null);
    await save('connectButton', 'Жми', null);
    const current = await rows();
    expect(current.map(({ language, key }) => [language, key])).toEqual([
      ['ru', 'connectButton'],
      ['ru', 'welcome'],
    ]);
    const resolved = resolveBotTextOverrides(current);
    expect(
      adminBotTextViewSchema.parse(toAdminBotTextView('welcome', current, resolved.en)),
    ).toEqual({
      language: 'en',
      key: 'welcome',
      override: null,
      rejection: null,
      fragments: [
        {
          placeholder: 'connectButton',
          key: 'connectButton',
          source: BOT_TEXT_SOURCES_EN.connectButton,
          overridden: false,
        },
      ],
    });
    await save('connectButton', 'Tap', null, BotLanguage.En);
    const after = await rows();
    expect(after.map(({ language, key }) => [language, key])).toEqual([
      ['en', 'connectButton'],
      ['ru', 'connectButton'],
      ['ru', 'welcome'],
    ]);
    expect(
      toAdminBotTextView('connectButton', after, resolveBotTextOverrides(after).en).override,
    ).toMatchObject({ source: 'Tap' });
  });
});
