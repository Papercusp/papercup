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
    console.log('remember →', JSON.stringify(r), 'ms=', (performance.now() - t0).toFixed(0));
    const t1 = performance.now();
    const hits = await be.search('how does the release deployment work?', { scope, limit: 5 });
    console.log('search →', hits.length, 'hits; top:', hits[0]?.text?.slice(0, 80), 'score=', hits[0]?.score, 'ms=', (performance.now() - t1).toFixed(0));
    // cleanup
    const all = await be.list({ scope });
    for (const e of all) await be.forget(e.id);
    console.log('cleaned', all.length, 'entries');
  } catch (e) {
    console.log('ROUNDTRIP FAILED:', (e as Error).message);
    console.log((e as Error).stack?.split('\n').slice(0, 8).join('\n'));
  }
}
process.exit(0);
