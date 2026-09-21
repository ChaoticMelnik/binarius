import { describe, expect, it } from 'vitest';
import * as shared from '@binarius/shared';

describe('workspace resolution', () => {
  it('resolves @binarius/shared', () => {
    expect(shared).toBeDefined();
  });
});
