import * as z from 'zod';

// The language of the client bot's texts for one user (#508, docs/bot-texts.md → Languages).
// Stored in users.language, set once from Telegram's language_code when the row is created and
// changed afterwards only by the user's own choice in the bot.
export const BotLanguage = { Ru: 'ru', En: 'en' } as const;
export type BotLanguage = (typeof BotLanguage)[keyof typeof BotLanguage];
export const botLanguageSchema = z.enum(BotLanguage);

export const DEFAULT_BOT_LANGUAGE: BotLanguage = BotLanguage.Ru;

// The language Telegram shows the bot's command menu and description in when no list was
// published for the client's own language: language_code omitted on setMyCommands and the rest.
export const TELEGRAM_PROFILE_DEFAULT_LANGUAGE: BotLanguage = BotLanguage.En;

// The owner's rule (2026-10-15): Russian when Telegram sends no tag or a Russian one, English for
// every other tag, CIS languages included. Migration 0063 spells the same rule in SQL; its test
// compares the two on one corpus of tags.
const RUSSIAN_TAG = /^ru(-|$)/i;
export const botLanguageOf = (languageCode: string | null | undefined): BotLanguage =>
  languageCode === null || languageCode === undefined || RUSSIAN_TAG.test(languageCode)
    ? BotLanguage.Ru
    : BotLanguage.En;
