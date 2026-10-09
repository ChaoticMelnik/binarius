import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BOT_TEXT_CATALOG } from '@binarius/shared';
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
  it('U6 resolves the rows as the loaders do: a rejected one shows the default', async () => {
    await tmp.db.insert(botTextOverrides).values([
      { key: 'startCommand', source: 'Поехали' },
      // a line break in a single-line text: the resolver rejects it
      { key: 'profileShortDescription', source: 'Один\nДва' },
    ]);
    const source = await readBotProfileSource(tmp.db);
    expect(source.sourceOf('startCommand')).toBe('Поехали');
    expect(source.sourceOf('profileShortDescription')).toBe(
      BOT_TEXT_CATALOG.profileShortDescription.source,
    );
  });
});
