// TEMP throwaway probe for WI-4597 — delete after measuring. Not a real test.
import { describe, it, expect } from 'vitest';
import { getCatalog } from '@papercusp/tooldef';
import './agent-tools/index';

describe('WI-4597 catalog probe', () => {
  it('measures catalog size after side-effect import', () => {
    const cat = getCatalog() as Array<Record<string, unknown>>;
    const names = cat.map((t) => (t.name ?? t.id ?? '?') as string);
    // eslint-disable-next-line no-console
    console.log('WI4597_CATALOG_SIZE=' + cat.length);
    // eslint-disable-next-line no-console
    console.log('WI4597_HAS_COMMENT=' + names.includes('work_items:comment'));
    // eslint-disable-next-line no-console
    console.log('WI4597_SAMPLE=' + JSON.stringify(names.slice(0, 5)));
    expect(cat.length).toBeGreaterThan(0);
  });
});
