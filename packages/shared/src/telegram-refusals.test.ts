import { describe, expect, it } from 'vitest';
import { deleteRefusal, editRefusal } from './telegram-refusals';

const refusal = (error_code: number, description: string) => ({ error_code, description });

describe('editRefusal', () => {
  it.each([
    'Bad Request: message to edit not found',
    "Bad Request: message can't be edited",
    'Bad Request: there is no text in the message to edit',
  ])('a 400 «%s» is a gone message', (description) => {
    expect(editRefusal(refusal(400, description))).toBe('gone');
  });

  it('a 400 «message is not modified» with any tail is already shown', () => {
    expect(
      editRefusal(
        refusal(
          400,
          'Bad Request: message is not modified: specified new message content and reply markup are exactly the same',
        ),
      ),
    ).toBe('shown');
  });

  it('another 400, or a gone phrase under another code, is not ours to read', () => {
    expect(editRefusal(refusal(400, 'Bad Request: chat not found'))).toBeUndefined();
    expect(editRefusal(refusal(403, 'Forbidden: message to edit not found'))).toBeUndefined();
  });
});

describe('deleteRefusal', () => {
  it.each([
    ['Bad Request: message to delete not found', 'gone'],
    ["Bad Request: message can't be deleted", 'forbidden'],
    ["Bad Request: message can't be deleted for everyone", 'forbidden'],
  ] as const)('a 400 «%s» is %s', (description, expected) => {
    expect(deleteRefusal(refusal(400, description))).toBe(expected);
  });

  it('another 400, or a known phrase under another code, is not ours to read', () => {
    expect(deleteRefusal(refusal(400, 'Bad Request: chat not found'))).toBeUndefined();
    expect(deleteRefusal(refusal(429, 'message to delete not found'))).toBeUndefined();
  });
});
