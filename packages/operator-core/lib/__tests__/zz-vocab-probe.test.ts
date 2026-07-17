// TEMPORARY debug probe (su-05b41785) — identifies which registration owns
// rubrics:get / code:run in the projected registry. DELETE AFTER USE.
import { describe, expect, it } from 'vitest';
import '../agent-tools/index';
import { listAllProjectedTools } from '@papercusp/tooldef';

describe('zz vocab probe', () => {
  it('prints projected entries', () => {
    const all = listAllProjectedTools();
    for (const name of ['rubrics:get', 'rubrics:ratify', 'code:run']) {
      const hits = all.filter((t) => t.expose?.mcp?.name === name);
      console.log(`\n### ${name} — ${hits.length} registration(s)`);
      for (const t of hits) {
        const props = (t.inputSchema as { properties?: Record<string, unknown> })?.properties ?? {};
        console.log('keys:', Object.keys(props).join(', '));
        console.log('desc-head:', String((t as { description?: string }).description ?? '').slice(0, 120));
        for (const k of ['rubricId', 'rubricIds', 'code']) {
          if (props[k]) console.log(`prop[${k}]:`, JSON.stringify(props[k]).slice(0, 200));
        }
      }
    }
    expect(true).toBe(true);
  });
});
