import { listUserMemories } from '@papercusp/operator-core/lib/memory/list-user-memories';
(async () => {
  const uid = '120f421b-25c9-47f7-8e3b-329c0edd4bf2';
  for (const label of ['cold', 'warm']) {
    const t0 = Date.now();
    const rows = await listUserMemories(uid);
    console.log(`${label}: ${rows.length} rows in ${Date.now() - t0}ms`);
  }
})().catch((e) => console.log('ERROR:', e?.message ?? e));
