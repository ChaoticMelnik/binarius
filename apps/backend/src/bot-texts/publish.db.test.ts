import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BOT_TEXT_CATALOG, BOT_TEXT_SOURCES_EN, BotLanguage } from '@binarius/shared';
import { botTextOverrides } from '@binarius/db';
import { createTempDatabase, type TempDatabase } from '@binarius/db/testing';
import { readBotProfileSource } from './publish';

const baseUrl = process.env.TEST_DATABASE_URL;
if (baseUrl === undefined || baseUrl === '') {
  throw new Error(
    'TEST_DATABASE_URL is required for apps/backend integration tests (see README → Test database)',
  );
}

let tmp: TempDatabase;
beforeAll(async () => {
  tmp = await createTempDatabase(baseUrl);
});
afterAll(() => tmp.drop());

describe('readBotProfileSource', () => {
  it("U6 resolves each language's rows as the loaders do: a rejected one shows that language's default", async () => {
    const { Ru, En } = BotLanguage;
    await tmp.db.insert(botTextOverrides).values([
      { language: Ru, key: 'startCommand', source: 'Поехали' },
      { language: En, key: 'startCommand', source: 'Go' },
      // a line break in a single-line text: the resolver rejects it
      { language: Ru, key: 'profileShortDescription', source: 'Один\nДва' },
      { language: En, key: 'profileShortDescription', source: 'One\nTwo' },
    ]);
    const sources = await readBotProfileSource(tmp.db);
    expect(sources.ru.sourceOf('startCommand')).toBe('Поехали');
    expect(sources.en.sourceOf('startCommand')).toBe('Go');
    expect(sources.ru.sourceOf('profileShortDescription')).toBe(
      BOT_TEXT_CATALOG.profileShortDescription.source,
    );
    expect(sources.en.sourceOf('profileShortDescription')).toBe(
      BOT_TEXT_SOURCES_EN.profileShortDescription,
    );
  });
});
