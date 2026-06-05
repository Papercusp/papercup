import '../../packages/operator-core/lib/memory/configure';
import { Mem0Backend } from '@papercusp/memory';

const be = new Mem0Backend();
const avail = await be.available();
console.log('available:', JSON.stringify(avail));
if (avail.ok) {
  const scope = '__benchprobe__';
  const t0 = performance.now();
  try {
    const r = await be.remember(
      '__benchprobe__ The deploy gate restarts the green host via deploy-cli with auto-rollback. cipher=zephyr-quartz',
      { scope, kind: 'project', metadata: { test_tag: '__benchprobe__' } },
    );
    console.log('remember (extract) →', JSON.stringify(r), 'ms=', (performance.now() - t0).toFixed(0));
    const tv = performance.now();
    const rv = await be.remember(
      '__benchprobe__ verbatim seed row: the staging operator on :3170 runs from main. cipher=umber-falcon',
      { scope, kind: 'project', verbatim: true, metadata: { test_tag: '__benchprobe__', corpus_key: 'probe_1' } },
    );
    console.log('remember (verbatim) →', JSON.stringify(rv), 'ms=', (performance.now() - tv).toFixed(0));
    const t1 = performance.now();
    const hits = await be.search('how does the release deployment work?', { scope, limit: 5 });
    console.log('search →', hits.length, 'hits; top:', hits[0]?.text?.slice(0, 80), 'score=', hits[0]?.score?.toFixed(3), 'ms=', (performance.now() - t1).toFixed(0));
    const hits2 = await be.search('which port serves the staging operator?', { scope, limit: 5 });
    console.log('search2 →', hits2.length, 'hits; top:', hits2[0]?.text?.slice(0, 80), 'corpus_key=', hits2[0]?.metadata?.corpus_key);
    // cleanup
    const all = await be.list({ scope });
    for (const e of all) await be.forget(e.id);
    const after = await be.list({ scope });
    console.log('cleaned', all.length, 'entries; remaining:', after.length);
  } catch (e) {
    console.log('ROUNDTRIP FAILED:', (e as Error).message);
    console.log((e as Error).stack?.split('\n').slice(0, 8).join('\n'));
  }
}
process.exit(0);
