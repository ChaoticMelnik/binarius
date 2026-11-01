import { createHash } from 'node:crypto';
import { Composer, GrammyError, InputFile, type Context } from 'grammy';
import {
  ButtonRole,
  createTelegramFileIds,
  errorLogFields,
  fileRefusal,
  referralLinkOf,
  switchInlineButton,
  type SessionShare,
  telegramErrorFields,
  type TelegramHtml,
} from '@binarius/shared';
import {
  BackendError,
  BackendErrorCode,
  backendErrorFields,
  type BackendClient,
} from './backend-client';
import type { Logger } from './logging';
import { answerInlineQueryEmpty, answerInlineQueryPhotoHtml, sendPhotoToStorage } from './send';
import { renderSessionCard } from './session-card';
import { sessionPromoModel, sessionPromoSvg } from './session-promo';
import { SESSION_NOT_FOUND, sessionTrackingDone } from './session-tracker';
import { LABELS, sessionShareCaption } from './texts';

// «📤 Поделиться» under the session's summary card (#321, #538, docs/bot-session.md → Sharing the
// card): the button opens Telegram's chat picker with the inline query `share:<sessionId>`, and
// the handler below answers it with the promo card, drawn now and posted to the private storage
// channel (SHARE_STORAGE_CHAT_ID) for its file id. The backend's owner-scoped read of the session
// is the proof that the one asking may share it. A button sent before #538 carries the #318
// card's file id (`share:<sessionId>:<fileId>`) and is answered with that card, nothing drawn.

// InlineQuery.query, and so the button's query, is at most 256 characters (Bot API)
export const INLINE_QUERY_LIMIT = 256;
const SHARE_PREFIX = 'share:';
// spelled here, not imported: trading-session.ts imports this file
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
// the old form's file id: 256 - 'share:' - the uuid - ':' = 213 characters
export const SHARE_PATTERN = new RegExp(`^${SHARE_PREFIX}(${UUID})(?::(\\S{1,213}))?$`);

export const shareQuery = (sessionId: string): string => `${SHARE_PREFIX}${sessionId}`;

// the start payload of the bot's plain link: the caption's link of a sender without a code
export const SHARE_START_PAYLOAD = 'share';
export const shareFallbackLink = (botUsername: string): string =>
  `https://t.me/${botUsername}?start=${SHARE_START_PAYLOAD}`;

// the picker lists people, groups and channels; a chat with a bot would show the card to no one.
// A step forward (#475): its own row, green.
export const shareButton = (query: string) =>
  switchInlineButton(ButtonRole.Forward, LABELS.sessionShareButton, {
    query,
    allow_user_chats: true,
    allow_group_chats: true,
    allow_channel_chats: true,
  });

// the promo cards' file_ids kept by the picture (the SVG's sha256): session, language and text
// overrides (#875); a bound on memory, as the session tracker's
export const PROMO_FILE_IDS_MAX = 10_000;

export interface SessionShareDeps {
  backend: Pick<BackendClient, 'readSessionShare'>;
  logger: Logger;
  // SHARE_STORAGE_CHAT_ID; none, a new-form query is answered empty
  storageChatId?: number;
}

const isNotFound = (error: unknown): boolean =>
  error instanceof BackendError &&
  error.code === BackendErrorCode.HttpStatus &&
  error.reason === SESSION_NOT_FOUND;

// the asset as the card names it (trading-session.ts → sendCard): the settings', or the last
// trade's when the settings could not be read (#321 clarify, manager's decision of 2026-10-11)
const assetIdOf = (share: SessionShare): number | undefined =>
  share.session.settings?.assetId ?? share.session.lastIntent?.assetId;

// Mounted on the bot itself, not under the private-chat filter: inline updates carry no chat.
// Inline mode makes `@bot …` available to anyone in any chat, so every query is answered, and
// everything but the owner's query for a finished session gets the empty answer.
export function createSessionShareComposer<C extends Context>({
  backend,
  logger,
  storageChatId,
}: SessionShareDeps): Composer<C> {
  const composer = new Composer<C>();
  const notShared = 'trading session not shared';
  // a card drawn and posted once per picture and process; read after the owner's read, never
  // instead of it (Rule 13, Rule 72)
  const promoIds = createTelegramFileIds<string>({ maxEntries: PROMO_FILE_IDS_MAX });

  composer.inlineQuery(SHARE_PATTERN, async (ctx) => {
    const sessionId = ctx.match[1] ?? '';
    const oldFileId = ctx.match[2];
    let share: SessionShare;
    try {
      share = await backend.readSessionShare(sessionId, String(ctx.inlineQuery.from.id));
    } catch (error) {
      // another user's session is the same 404 as a missing one (Rule 13): nothing to say
      if (!isNotFound(error)) {
        logger.warn(
          { ...errorLogFields(error), ...backendErrorFields(error), sessionId },
          notShared,
        );
      }
      await answer(ctx, sessionId, null);
      return;
    }
    const assetId = assetIdOf(share);
    // the counts are final only once the session is done; the same button works when it is
    if (!sessionTrackingDone(share.session) || assetId === undefined || share.trades.length === 0) {
      await answer(ctx, sessionId, null);
      return;
    }
    const caption = sessionShareCaption(
      share.referralCode === null
        ? shareFallbackLink(ctx.me.username)
        : referralLinkOf(ctx.me.username, share.referralCode),
    );
    if (oldFileId !== undefined) {
      await answer(ctx, sessionId, { fileId: oldFileId, caption });
      return;
    }
    if (storageChatId === undefined) {
      logger.warn({ sessionId, reason: 'storage_off' }, notShared);
      await answer(ctx, sessionId, null);
      return;
    }
    let fileId: string | undefined;
    let key: string;
    try {
      const svg = sessionPromoSvg(sessionPromoModel(share, share.session, assetId));
      // the whole picture is the key, as the backend's card media (Rule 69): a language or a text
      // override changes the SVG, so the card is drawn anew
      key = createHash('sha256').update(svg).digest('hex');
      fileId = promoIds.get(key);
      if (fileId === undefined) {
        const png = await renderSessionCard(svg);
        const posted = await sendPhotoToStorage(
          ctx.api,
          storageChatId,
          new InputFile(png, 'promo.png'),
        );
        promoIds.remember(key, posted);
        fileId = promoIds.get(key);
      }
    } catch (error) {
      // no retry: an inline query is answered once, and the user can press again
      logger.warn(
        { ...errorLogFields(error), ...telegramErrorFields(error, 'sendPhoto'), sessionId },
        'trading session promo not uploaded',
      );
      await answer(ctx, sessionId, null);
      return;
    }
    if (fileId === undefined) {
      logger.warn({ sessionId, reason: 'no_file_id' }, notShared);
      await answer(ctx, sessionId, null);
      return;
    }
    await answer(ctx, sessionId, { fileId, caption }, key);
  });

  composer.on('inline_query', (ctx) => answer(ctx, undefined, null));

  // /setinlinefeedback: the result's id is the session's (answerInlineQueryPhotoHtml's `id`)
  composer.on('chosen_inline_result', (ctx) => {
    logger.info({ sessionId: ctx.chosenInlineResult.result_id }, 'trading session card shared');
  });

  async function answer(
    ctx: Context,
    sessionId: string | undefined,
    card: { fileId: string; caption: TelegramHtml } | null,
    // the kept file id's key the answer used: only that one is forgotten
    keptKey?: string,
  ): Promise<void> {
    try {
      if (card === null || sessionId === undefined) {
        await answerInlineQueryEmpty(ctx);
      } else {
        await answerInlineQueryPhotoHtml(ctx, { id: sessionId, fileId: card.fileId }, card.caption);
      }
    } catch (error) {
      // a forged or foreign file id is refused here too (400): Telegram is its validator; a stale
      // kept id is forgotten, so the next query draws the card again — an expired query is not
      // the file's fault, so the id stays (fileRefusal)
      if (keptKey !== undefined && error instanceof GrammyError && fileRefusal(error)) {
        promoIds.forget(keptKey);
      }
      logger.warn(
        {
          ...errorLogFields(error),
          ...telegramErrorFields(error, 'answerInlineQuery'),
          ...(sessionId === undefined ? {} : { sessionId }),
        },
        'inline query not answered',
      );
    }
  }

  return composer;
}
