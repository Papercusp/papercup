/** Dedicated real PSU host for the registered private HTTP integration suite. */
import assert from 'node:assert/strict';
import { hostThroughPty } from '../../../apps/operator/scripts/psu-pty-host.mjs';

const ownerId = process.argv[2];
const advSessionId = Number(process.argv[3]);
assert.equal(process.env.PAPERCUSP_SID, ownerId);
assert.ok(ownerId?.startsWith('su-rs-') && Number.isSafeInteger(advSessionId) && advSessionId > 0);
assert.ok(process.env.PAPERCUSP_PSU_PTY_DIR);
assert.equal(process.env.PAPERCUSP_LAUNCHED_BY, 'su-private-roster-acceptance');
await hostThroughPty({ command: process.execPath,
  args: ['-e', "process.stdin.setEncoding('utf8');let b='';process.stdin.on('data',d=>{b+=d;let i;while((i=b.indexOf('\\n'))>=0){process.stdout.write('ECHO:'+b.slice(0,i)+'\\n');b=b.slice(i+1);}});setTimeout(()=>process.exit(0),120000);"],
  cwd: process.cwd(), env: process.env, ownerId, advSessionId, bridgeTty: false,
  reapScopeResidue: () => ({ killedPids: [], failedPids: [] }),
  onExit: (code, signal) => {
    process.stdout.write('\nROSTER_CANARY_EXIT ' + JSON.stringify({ ownerId, advSessionId, code, signal }) + '\n');
    process.exit(code);
  },
});
