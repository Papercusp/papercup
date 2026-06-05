import '../../packages/operator-core/lib/memory/configure';
import { Mem0Backend } from '@papercusp/memory';

const be = new Mem0Backend();
const scope = '__benchprobe_meta__';
const r = await be.remember('The staging operator on :3170 runs from main and restarts via systemctl --user.', {
  scope, kind: 'project', verbatim: true, metadata: { corpus_key: 'probe_meta_1', test_tag: '__benchprobe__' },
});
console.log('seeded:', JSON.stringify(r));
const hits = await be.search('staging operator port', { scope, limit: 3 });
console.log('top hit metadata keys:', Object.keys(hits[0]?.metadata ?? {}));
console.log('corpus_key on hit:', hits[0]?.metadata?.corpus_key, '| kind:', hits[0]?.kind, '| text:', hits[0]?.text?.slice(0, 60));
const got = await be.get(r.ids[0]);
console.log('get corpus_key:', got?.metadata?.corpus_key);
const all = await be.list({ scope });
console.log('list corpus_key:', all[0]?.metadata?.corpus_key);
for (const e of all) await be.forget(e.id);
console.log('cleaned', all.length);
process.exit(0);
