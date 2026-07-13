import { getOrgPg } from '@papercusp/db-org';
const { sql } = getOrgPg();
const rows = await sql`
  select fire_error, resolved_by, fired_at
  from harness_shared.improvement_dispatches
  where outcome='orphaned'
  order by fired_at desc limit 2000`;
const cat = (e) => {
  if (!e) return 'NULL fire_error';
  if (/env-failure/.test(e)) return 'env-failure (rate-limit/quota)';
  if (/pre-invoke skip/.test(e)) return 'pre-invoke skip (throttled)';
  if (/host restarted mid-dispatch/.test(e)) return 'host restarted mid-dispatch';
  if (/MODULE_NOT_FOUND/.test(e)) return 'MODULE_NOT_FOUND crash';
  if (/exit 143/.test(e)) return 'exit 143 (SIGTERM/timeout)';
  if (/exit 0 after/.test(e)) return 'exit 0, no resolve called (silent success-but-no-resolve)';
  if (/exit 1 after/.test(e)) return 'exit 1, no resolve (other crash)';
  return 'OTHER: ' + e.slice(0,60);
};
const buckets = new Map();
for (const r of rows) {
  const c = cat(r.fire_error);
  buckets.set(c, (buckets.get(c)||0)+1);
}
for (const [c,n] of [...buckets.entries()].sort((a,b)=>b[1]-a[1])) console.log(n, '::', c);
console.log('total', rows.length);

// last 48h breakdown
const recent = rows.filter(r => Date.now() - new Date(r.fired_at).getTime() < 48*3600*1000);
console.log('--- last 48h:', recent.length, 'orphaned dispatches ---');
const buckets2 = new Map();
for (const r of recent) {
  const c = cat(r.fire_error);
  buckets2.set(c, (buckets2.get(c)||0)+1);
}
for (const [c,n] of [...buckets2.entries()].sort((a,b)=>b[1]-a[1])) console.log(n, '::', c);
process.exit(0);
