/**
 * P-006 live exercise — runs the REAL resolvers unmocked against the live store.
 *
 * The cell contract refuses `liveExercised: false` because fixtures cannot catch a
 * confidently-wrong resolver. Scratch file, deleted after the run.
 */
import { readCellThread, cellThreadIsCoherent } from './packages/operator-core/lib/coord/cell-thread';
import { readGateOwnership } from './packages/operator-core/lib/coord/gate-ownership';
import { getWorkItemThreadWindow } from './packages/operator-core/lib/work-items';

async function main() {
  // (a) A thread with REAL posts: window + total + truncation, all measured.
  const win = await getWorkItemThreadWindow('WI-6857', 3);
  console.log('[a] getWorkItemThreadWindow WI-6857:', {
    posts: win?.posts.length,
    total: win?.total,
    topics: win?.topics,
    createdAt: win?.createdAt,
  });

  const rich = await readCellThread('WI-6857');
  console.log('[b] readCellThread WI-6857:', {
    shown: rich.shown,
    total: rich.total,
    unknown: rich.unknown,
    topics: rich.topics,
    coherent: cellThreadIsCoherent(rich),
    messages: rich.recent.map((m) => ({
      at: m.at,
      author: m.author,
      chars: m.chars,
      truncated: m.truncated,
      textLen: m.text.length,
      head: m.text.slice(0, 60).replace(/\s+/g, ' '),
    })),
  });

  // (c) The bridge-minted item — MEASURED SILENCE (no thread row at all).
  const silent = await readCellThread('WI-7282');
  console.log('[c] readCellThread WI-7282 (bridge-minted):', {
    shown: silent.shown,
    total: silent.total,
    unknown: silent.unknown,
    topics: silent.topics,
    coherent: cellThreadIsCoherent(silent),
  });

  // (d) Nothing owns the condition -> not-applicable, NOT an empty thread.
  const none = await readCellThread(null);
  console.log('[d] readCellThread(null):', { shown: none.shown, total: none.total, unknown: none.unknown });

  // (e) A work-item that does not exist -> unmeasured, NOT silence.
  const ghost = await readCellThread('WI-99999999');
  console.log('[e] readCellThread(WI-99999999):', { shown: ghost.shown, total: ghost.total, unknown: ghost.unknown });

  // (f) THE WHOLE CELL, unmocked — ownership + folded thread.
  const own = await readGateOwnership({ harness: 'papercusp' });
  console.log('[f] readGateOwnership(papercusp):', {
    eventKey: own.eventKey,
    workItem: own.workItem,
    claimState: own.claimState,
    unknown: own.unknown,
    holderSessionState: own.holderSessionState,
    duplicates: own.duplicates,
    thread: { shown: own.thread.shown, total: own.thread.total, unknown: own.thread.unknown },
  });
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error('EXERCISE FAILED', e);
    process.exit(1);
  },
);
