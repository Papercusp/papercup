import { getOrgPg } from '@papercusp/db-org';
const { sql } = getOrgPg();
// classify fire_error by leading signature
const rows = await sql`
  select fire_error, resolved_by, fired_at
  from harness_shared.improvement_dispatches
  where outcome='orphaned'
  order by fired_at desc limit 2000`;
const buckets = new Map();
for (const r of rows) {
  const e = r.fire_error || '(no fire_error)';
  // Extract a short signature: text before first newline, first 80 chars
  const sig = e.split('\n')[0].slice(0, 90);
  buckets.set(sig, (buckets.get(sig)||0)+1);
}
const sorted = [...buckets.entries()].sort((a,b)=>b[1]-a[1]);
for (const [sig, n] of sorted.slice(0, 25)) {
  console.log(n, '::', sig);
}
console.log('total rows scanned', rows.length);
// time range
console.log('oldest', rows[rows.length-1]?.fired_at, 'newest', rows[0]?.fired_at);
process.exit(0);
