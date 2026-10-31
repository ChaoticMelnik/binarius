import { InputFile } from 'grammy';
import type { Message } from 'grammy/types';
import { pino } from 'pino';
import { describe, expect, it } from 'vitest';
import { logOptions } from '@binarius/shared';
import { CARD_MEDIA_KEEP, createCardMedia } from './card-media';

const sent = (fileId: string) =>
  ({
    message_id: 1,
    photo: [{ file_id: `${fileId}-small` }, { file_id: fileId }],
  }) as unknown as Message;

function media(render?: (svg: string) => Promise<Buffer>) {
  const renders: string[] = [];
  const lines: string[] = [];
  const logger = pino(logOptions('info'), { write: (line: string) => void lines.push(line) });
  const cards = createCardMedia({
    render:
      render ??
      ((svg) => {
        renders.push(svg);
        return Promise.resolve(Buffer.from(`png:${svg}`));
      }),
    name: 'daily summary',
    logger,
  });
  const logs = () => lines.map((line) => JSON.parse(line) as Record<string, unknown>);
  return { cards, renders, logs };
}

describe('the drawn mailing picture (#881)', () => {
  it('CM1 renders once, uploads the PNG, then sends by the file_id the answer brought', async () => {
    const { cards, renders } = media();
    const first = await cards.of('<svg>a</svg>');
    expect(first.photo()).toBeInstanceOf(InputFile);
    first.remember(sent('id-a'));
    const second = await cards.of('<svg>a</svg>');
    expect(second.photo()).toBe('id-a');
    expect(renders).toEqual(['<svg>a</svg>']);
  });

  it('CM2 another SVG is another picture: its own render and upload', async () => {
    const { cards, renders } = media();
    (await cards.of('<svg>ru</svg>')).remember(sent('id-ru'));
    const en = await cards.of('<svg>en</svg>');
    expect(en.photo()).toBeInstanceOf(InputFile);
    expect((await cards.of('<svg>ru</svg>')).photo()).toBe('id-ru');
    expect(renders).toEqual(['<svg>ru</svg>', '<svg>en</svg>']);
  });

  it('CM3 a refused file forgets its id: the next send uploads the kept PNG without a second render', async () => {
    const { cards, renders } = media();
    const card = await cards.of('<svg>a</svg>');
    card.remember(sent('id-a'));
    card.forget();
    expect((await cards.of('<svg>a</svg>')).photo()).toBeInstanceOf(InputFile);
    expect(renders).toHaveLength(1);
  });

  it('CM4 keeps at most CARD_MEDIA_KEEP pictures: the oldest goes with its file_id', async () => {
    const { cards, renders } = media();
    (await cards.of('<svg>0</svg>')).remember(sent('id-0'));
    for (let n = 1; n <= CARD_MEDIA_KEEP; n += 1) await cards.of(`<svg>${String(n)}</svg>`);
    expect(renders).toHaveLength(CARD_MEDIA_KEEP + 1);
    expect((await cards.of('<svg>0</svg>')).photo()).toBeInstanceOf(InputFile);
    expect(renders).toHaveLength(CARD_MEDIA_KEEP + 2);
  });

  it('CM5 a failed render is not kept: the next send renders anew', async () => {
    let calls = 0;
    const { cards } = media(() => {
      calls += 1;
      return calls === 1
        ? Promise.reject(new Error('render failed'))
        : Promise.resolve(Buffer.from('png'));
    });
    await expect(cards.of('<svg>a</svg>')).rejects.toThrow('render failed');
    expect((await cards.of('<svg>a</svg>')).photo()).toBeInstanceOf(InputFile);
    expect(calls).toBe(2);
  });

  it('CM6 an answer without a photo is logged and keeps no id', async () => {
    const { cards, logs } = media();
    const card = await cards.of('<svg>a</svg>');
    card.remember({ message_id: 2 } as unknown as Message);
    expect(card.photo()).toBeInstanceOf(InputFile);
    expect(logs()).toMatchObject([
      {
        level: 40,
        reason: 'no_file_id',
        media: 'daily summary',
        msg: 'mailing photo not remembered',
      },
    ]);
  });
});
