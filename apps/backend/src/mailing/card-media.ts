import { createHash } from 'node:crypto';
import type { FastifyBaseLogger } from 'fastify';
import { InputFile } from 'grammy';
import { createTelegramFileIds } from '@binarius/shared';
import type { PhotoMedia } from './photo-media';

// A picture drawn for a mailing (#881, docs/mailing.md → The sender): keyed by the hash of its SVG,
// which holds everything the picture shows (the day, the figures, the language, the overrides), so
// every user of one key gets one render and one upload, the rest the file_id the upload brought.
// A refused file forgets its id and the next send uploads the kept PNG again; a failed render is
// not kept, so the retry renders anew. Per process, as the banners' ids (#879).
export interface CardMedia {
  of: (svg: string) => Promise<PhotoMedia>;
}

// two languages of one day, and one change of their overrides: the oldest key goes with its PNG
// and file_id
export const CARD_MEDIA_KEEP = 4;

export function createCardMedia({
  render,
  name,
  logger,
}: {
  render: (svg: string) => Promise<Buffer>;
  // for the log line only
  name: string;
  logger: FastifyBaseLogger;
}): CardMedia {
  const pngs = new Map<string, Promise<Buffer>>();
  const ids = createTelegramFileIds<string>();

  const pngOf = (key: string, svg: string): Promise<Buffer> => {
    const kept = pngs.get(key);
    if (kept !== undefined) {
      // a hit is the newest again: the bound drops the least recently used key
      pngs.delete(key);
      pngs.set(key, kept);
      return kept;
    }
    const png = render(svg);
    pngs.set(key, png);
    png.catch(() => {
      if (pngs.get(key) === png) pngs.delete(key);
    });
    for (const old of pngs.keys()) {
      if (pngs.size <= CARD_MEDIA_KEEP) break;
      pngs.delete(old);
      ids.forget(old);
    }
    return png;
  };

  return {
    of: async (svg) => {
      const key = createHash('sha256').update(svg).digest('hex');
      const png = await pngOf(key, svg);
      return {
        photo: () => ids.get(key) ?? new InputFile(png, `${name.replaceAll(' ', '-')}.png`),
        remember: (result) => {
          // a key the bound dropped meanwhile keeps no id
          if (!pngs.has(key)) return;
          if (!ids.remember(key, result)) {
            logger.warn({ reason: 'no_file_id', media: name }, 'mailing photo not remembered');
          }
        },
        forget: () => {
          ids.forget(key);
        },
      };
    },
  };
}
