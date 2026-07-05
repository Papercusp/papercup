const t0 = Date.now();
const log = (m: string) => console.log(`+${Date.now() - t0}ms ${m}`);
log('start; importing db-org…');
const { getOrgPg } = await import('@papercusp/db-org');
log('db-org imported; pinging pg…');
const { sql } = getOrgPg();
const ping = await Promise.race([sql`SELECT 1 AS ok`, new Promise((r) => setTimeout(() => r('PG-TIMEOUT-10s'), 10_000))]);
log(`pg=${JSON.stringify(ping)}`);
log('importing flags/server…');
const { getFlag } = await import('@papercusp/flags/server');
const { FLAGS } = await import('@papercusp/flags');
log('flags imported; reading flag…');
const flag = await Promise.race([getFlag(FLAGS.SESSION_SEARCH, 'debug'), new Promise((r) => setTimeout(() => r('FLAG-TIMEOUT-10s'), 10_000))]);
log(`flag=${flag}`);
log('importing session-ingest…');
const mod = await import('./packages/operator-core/lib/search/session-ingest.ts');
log('session-ingest imported; enumerating…');
const { readdir } = await import('node:fs/promises');
for (const a of mod.FILE_ADAPTERS) {
  const t = Date.now(); let n = 0;
  for (const root of a.roots()) { try { n += ((await readdir(root, { recursive: true })) as string[]).filter((x: string) => x.endsWith('.jsonl')).length; } catch {} }
  log(`${a.sourceKind}: ${n} jsonl in ${Date.now() - t}ms`);
}
process.exit(0);
