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
});
