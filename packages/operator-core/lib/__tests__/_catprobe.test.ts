import { describe, it } from 'vitest';
import { getCatalog } from '@papercusp/tooldef';
describe('probe', () => {
  it('before/after a direct tool import', async () => {
    console.log('BEFORE:', (getCatalog() as any[]).length);
    const mod = await import('../agent-tools/work_items/comment');
    console.log('imported comment tool:', (mod.default as any)?.name);
    console.log('AFTER direct import:', (getCatalog() as any[]).length);
    console.log('in catalog?', (getCatalog() as any[]).some((t) => t.name === 'work_items:comment'));
    await import('../agent-tools/index');
    console.log('AFTER index import:', (getCatalog() as any[]).length);
  });
});
