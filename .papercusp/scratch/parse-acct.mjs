import { readFileSync } from 'node:fs';
const s = readFileSync(process.argv[2], 'utf8');
let j;
try { j = JSON.parse(s); } catch (e) { console.log('PARSE_FAIL', e.message); console.log(s.slice(0, 800)); process.exit(0); }
if (!j.accounts) { console.log('NO_ACCOUNTS keys=', Object.keys(j)); console.log(JSON.stringify(j).slice(0, 800)); process.exit(0); }
for (const a of j.accounts) {
  console.log(JSON.stringify({ id: a.id, provider: a.provider, credentialRef: a.credentialRef, label: a.label, egress: a.egress, egressPool: a.egressPool, boundTo: a.boundTo }));
}
