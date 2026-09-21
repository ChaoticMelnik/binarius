import { describe, expect, it } from 'vitest';
import * as shared from '@binarius/shared';
import * as db from '@binarius/db';

describe('workspace resolution', () => {
  it('resolves @binarius/shared', () => {
    expect(shared).toBeDefined();
  });

  it('resolves @binarius/db', () => {
    expect(db).toBeDefined();
  });
});
