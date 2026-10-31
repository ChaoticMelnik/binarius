import { describe, expect, it } from 'vitest';
import { createBotTexts, defaultBotTextSource } from './bot-texts';
import { enBotTextSource } from './bot-texts-en';
import { helpLinksCaption, type HelpLinksPresent } from './help-links-text';
import { plainTextOf } from './telegram-html';

const ru = createBotTexts(defaultBotTextSource).html;
const en = createBotTexts(enBotTextSource).html;
const ALL: HelpLinksPresent = { channel: true, reviews: true, manager: true };
const caption = (present: HelpLinksPresent, html = ru) =>
  plainTextOf(helpLinksCaption(html, present)).split('\n');

describe('the help push caption (#879)', () => {
  it('HT1: the title, an empty line and a line per link, each quoting its button', () => {
    expect(caption(ALL)).toEqual([
      '📬 Полезные ссылки',
      '',
      'Где узнать больше о боте — по кнопкам ниже.',
      '',
      '📣 «📣 Канал» — новости бота и ответы на частые вопросы.',
      '⭐ «⭐ Отзывы» — отзывы пользователей бота.',
      '💬 «💬 Написать менеджеру» — вопрос про счёт, пополнение или вывод.',
    ]);
  });

  it('HT2: a link that is not set has no line', () => {
    expect(caption({ channel: false, reviews: true, manager: false })).toEqual([
      '📬 Полезные ссылки',
      '',
      'Где узнать больше о боте — по кнопкам ниже.',
      '',
      '⭐ «⭐ Отзывы» — отзывы пользователей бота.',
    ]);
    expect(caption({ channel: true, reviews: false, manager: true }).slice(4)).toEqual([
      '📣 «📣 Канал» — новости бота и ответы на частые вопросы.',
      '💬 «💬 Написать менеджеру» — вопрос про счёт, пополнение или вывод.',
    ]);
  });

  it('HT3: the English catalog prints the English caption', () => {
    const lines = caption(ALL, en);
    expect(lines[0]).toBe('📬 Useful links');
    expect(lines.slice(4)).toEqual([
      '📣 “📣 Channel” — bot news and answers to common questions.',
      "⭐ “⭐ Reviews” — what the bot's users say.",
      '💬 “💬 Message the manager” — a question about the account, a deposit or a withdrawal.',
    ]);
    expect(lines.join('\n')).not.toMatch(/[а-яё]/i);
  });
});
