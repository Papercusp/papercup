import { describe, expect, it } from 'vitest';
import { reembedConfirmationBody } from './reembed-copy';

describe('reembedConfirmationBody', () => {
  it('describes the delta-only behavior without claiming existing vectors are overwritten', () => {
    const body = reembedConfirmationBody('gemma');

    expect(body).toContain('Existing "gemma" target vectors are retained and skipped');
    expect(body).toContain('only memories missing a "gemma" vector are embedded');
    expect(body).not.toContain('overwritten');
  });
});
