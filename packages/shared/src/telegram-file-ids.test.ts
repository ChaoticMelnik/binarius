import { describe, expect, it } from 'vitest';
import { createTelegramFileIds } from './telegram-file-ids';

describe('createTelegramFileIds (#859)', () => {
  it("F1: an animation's answer and a photo's largest size are remembered by key", () => {
    const ids = createTelegramFileIds<'radar' | 'still'>();
    expect(ids.get('radar')).toBeUndefined();
    expect(ids.remember('radar', { animation: { file_id: 'A1' } })).toBe(true);
    expect(ids.remember('still', { photo: [{ file_id: 'small' }, { file_id: 'large' }] })).toBe(
      true,
    );
    expect(ids.get('radar')).toBe('A1');
    expect(ids.get('still')).toBe('large');
  });

  it('F2: an inline edit carries no id; a message without one is reported; a known id stays', () => {
    const ids = createTelegramFileIds<'radar'>();
    expect(ids.remember('radar', true)).toBe(true);
    expect(ids.get('radar')).toBeUndefined();
    expect(ids.remember('radar', {})).toBe(false);
    ids.remember('radar', { animation: { file_id: 'A1' } });
    ids.remember('radar', { animation: { file_id: 'A2' } });
    expect(ids.get('radar')).toBe('A1');
  });

  it('F3: a forgotten id is gone, so the next send uploads the file', () => {
    const ids = createTelegramFileIds<'radar'>();
    ids.remember('radar', { animation: { file_id: 'A1' } });
    ids.forget('radar');
    expect(ids.get('radar')).toBeUndefined();
  });

  it('F4: past maxEntries the least recently read key goes; a read makes its key the newest', () => {
    const ids = createTelegramFileIds<string>({ maxEntries: 2 });
    ids.remember('a', { photo: [{ file_id: 'A' }] });
    ids.remember('b', { photo: [{ file_id: 'B' }] });
    expect(ids.get('a')).toBe('A');
    ids.remember('c', { photo: [{ file_id: 'C' }] });
    expect(ids.get('b')).toBeUndefined();
    expect(ids.get('a')).toBe('A');
    expect(ids.get('c')).toBe('C');
  });

  it('F5: without maxEntries nothing is dropped', () => {
    const ids = createTelegramFileIds<number>();
    for (let key = 0; key < 1_000; key += 1) {
      ids.remember(key, { photo: [{ file_id: `f${String(key)}` }] });
    }
    expect(ids.get(0)).toBe('f0');
    expect(ids.get(999)).toBe('f999');
  });
});
