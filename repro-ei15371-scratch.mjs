import Corestore from 'corestore';
import NoiseSecretStream from '@hyperswarm/secret-stream';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

async function main() {
  const storeA1 = new Corestore(mkdtempSync(join(tmpdir(), 'a1-'))); // pot-home
  const storeA2 = new Corestore(mkdtempSync(join(tmpdir(), 'a2-'))); // member
  const storeB = new Corestore(mkdtempSync(join(tmpdir(), 'b-')));   // remote peer

  // B already has this core loaded+appended BEFORE it replicates, so corestore's
  // proactive "this.cores.size > 0" loop in replicate() will push/attach it from
  // B's side unprompted, over B's own muxer.
  const coreB = storeB.get({ name: 'peer-b-member-log' });
  await coreB.ready();
  await coreB.append(['hello']);

  const a = new NoiseSecretStream(true);
  const b = new NoiseSecretStream(false);
  a.rawStream.pipe(b.rawStream).pipe(a.rawStream);

  // A1 (pot-home) replicates FIRST on the shared socket `a` — this is where its
  // own ondiscoverykey handler gets paired onto the shared muxer.
  storeA1.replicate(a);
  // A2 (member) replicates SECOND on the SAME shared socket `a` — corestore's
  // Hypercore.createProtocolStream reuses the SAME muxer (noiseStream.userData
  // already set) but re-pairs 'hypercore/alpha', clobbering A1's ondiscoverykey.
  storeA2.replicate(a);
  storeB.replicate(b);

  // A1 NEVER calls storeA1.get({key}) — it relies ENTIRELY on B's proactive
  // announce + its OWN ondiscoverykey handler (this.storage.hasCore / cores.opened
  // check) to discover+attach. This mirrors "pot-home discovers a peer's member log
  // dynamically via the announce channel", i.e. it doesn't already know the key
  // ahead of a live connection.
  //
  // Since A1 truly has never seen this key, _attachMaybe will always return early
  // (neither cores.opened nor storage.hasCore is true) -- so this specific setup
  // can't demonstrate a *positive* case. Instead, demonstrate the covering defect
  // directly: after both replicate() calls, inspect whether A1's own ondiscoverykey
  // pairing is still the live handler on the shared muxer, or A2's has replaced it.
  const muxer = a.userData;
  const key = require('node:util').inspect;

  await new Promise((resolve) => setTimeout(resolve, 400));

  // Directly probe protomux's internal _notify map (test-only introspection).
  const toKeyFn = Object.getPrototypeOf(muxer).constructor;
  console.log('muxer._notify size for hypercore/alpha slot:', muxer._notify.size);
  for (const k of muxer._notify.keys()) console.log('  notify key:', k);

  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(2); });
