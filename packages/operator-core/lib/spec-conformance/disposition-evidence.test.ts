import { describe, expect, it, vi } from 'vitest';
import { dispositionOwnerDirective } from '../owner-directives';
import { hasOnlyUrlReferences, URL_ONLY_DISPOSITION_ERROR } from './disposition-evidence';

describe('URL-only directive completion evidence (R-20)', () => {
  it.each([
    'https://example.test/report',
    'HTTP://example.test/result',
    'https://example.test/a\nhttps://example.test/b',
    '<https://example.test/report>',
    '[Verification report](https://example.test/report)',
    '- [Report](https://example.test/report)\n- https://example.test/proof',
    '`https://example.test/report`.',
    '(https://example.test/result), <https://example.test/proof>',
    '/reports?sel=rpt-test',
    '[Read the report](/reports?sel=rpt-test)',
    '1. https://example.test/report\n2. /reports?sel=rpt-test',
    'papercusp://scratch/verification',
  ])('recognises references without an outcome: %s', (note) => {
    expect(hasOnlyUrlReferences(note)).toBe(true);
  });

  it.each([
    'Verified the service returned the expected response; proof: https://example.test/report',
    'The regression suite passed. [Report](https://example.test/report)',
    'The requested fix is built and its focused tests pass.',
    'Verification failed; the original task remains open.',
    '',
  ])('preserves outcome prose: %s', (note) => {
    expect(hasOnlyUrlReferences(note)).toBe(false);
  });

  it('refuses a URL-only successful disposition before its datastore write', async () => {
    const sql = vi.fn();
    const result = await dispositionOwnerDirective(
      { id: 1, status: 'done', note: '[Report](https://example.test/report)', dispositionedBy: 'su-test' },
      sql as never,
    );
    expect(result).toEqual({ ok: false, error: URL_ONLY_DISPOSITION_ERROR });
    expect(sql).not.toHaveBeenCalled();
  });
});
