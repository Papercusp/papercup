/**
 * The nightly transfer tick (P-022 / FB-08) — distill → admit (free,
 * probationary) → student-transfer test → promote/demote/retire (gate.ts).
 *
 * Every dep is a port ({@link TransferTickDeps}) so tick.test.ts covers the
 * whole flow with zero LLM/PG. The live deps come from
 * `defaultTransferTickDeps` (PG store port, fs transcript lister, Anthropic
 * distiller, the governed replay battery, the memory backend); a null
 * `replay` port skips the testing leg with an honest count, never a silent
 * drop.
 *
 * Spend: DISTILLATION cost is ledgered on the learning governor under
 * `frontier:transfer-harness` (accumulate:true, origin='replay', D-002);
 * battery cost is ledgered by the governed replay path under
 * `frontier:replay-harness` — each dollar lands on exactly one loop.
 */
import type { MemoryBackend } from '@papercusp/memory';
import { admitProbationaryMemory, setMemoryTier } from '../memory/two-tier';
import {
  applyTransferVerdict,
  transferVerdict,
  type GateTransition,
  type TransferTickOptions,
} from './gate';
import { distillLessonsFromTranscript, lessonSignature } from './distill';
import type { AdmitLessonInput, AdmitLessonResult } from './store';
import {
  TRANSFER_ORIGIN,
  type LessonDistillerLlm,
  type TranscriptRefLister,
  type TransferLesson,
  type TransferReplayPort,
  type TransferTranscriptSource,
} from './types';

/** The PG seam (store.ts bound to a Sql in live-deps; in-memory fakes in tests). */
export interface TransferStorePort {
  admit(input: AdmitLessonInput): Promise<AdmitLessonResult>;
  listForTesting(q: { workspaceId: string; limit: number }): Promise<TransferLesson[]>;
  recordOutcome(q: {
    workspaceId: string;
    id: string;
    transition: GateTransition;
    batteryId: string;
    delta: number;
  }): Promise<unknown>;
  markError(q: { workspaceId: string; id: string }): Promise<void>;
  setMemoryId(q: { workspaceId: string; id: string; memoryId: string | null }): Promise<void>;
}

export interface TransferTickDeps {
  store: TransferStorePort;
  /** Governor spend ledger for DISTILLATION spend only (battery spend is
   *  ledgered by the governed replay path — see testLeg). Never throws
   *  upward; the caller wraps. */
  recordSpend: (q: { costUsd: number; note: string; runRef?: string }) => Promise<void>;
  lister: TranscriptRefLister;
  source: TransferTranscriptSource;
  llm: LessonDistillerLlm;
  /** null ⇒ the testing leg self-skips with an honest count. */
  replay: TransferReplayPort | null;
  /** null = memory admission skipped (degraded; lessons still tracked in PG). */
  memory: MemoryBackend | null;
  log: (msg: string) => void;
}

export interface TransferTickResult {
  transcriptsScanned: number;
  lessonsDistilled: number;
  lessonsAdmitted: number;
  tested: number;
  passed: number;
  failed: number;
  retired: number;
  errors: number;
  /** True when the testing leg was skipped for want of the replay port. */
  testingSkippedNoReplay: boolean;
  costUsd: number;
}

async function ledgerSpend(
  deps: TransferTickDeps,
  costUsd: number,
  note: string,
  runRef?: string,
): Promise<void> {
  if (!(costUsd > 0)) return;
  try {
    await deps.recordSpend({ costUsd, note, ...(runRef ? { runRef } : {}) });
  } catch (e) {
    // Spend bookkeeping must never fail the tick; the governor's lifetime cap
    // self-corrects next tick (under-counted spend only ever errs once).
    deps.log(`spend ledger failed (${note}): ${e instanceof Error ? e.message : e}`);
  }
}

/** The distillation leg: recent transcripts → probationary lessons. */
async function distillLeg(
  workspaceId: string,
  deps: TransferTickDeps,
  opts: TransferTickOptions,
  result: TransferTickResult,
): Promise<void> {
  let refs: string[] = [];
  try {
    refs = await deps.lister({ windowMs: opts.windowMs, cap: opts.maxTranscriptsPerTick });
  } catch (e) {
    deps.log(`transcript listing failed — distillation skipped: ${e instanceof Error ? e.message : e}`);
    return;
  }
  for (const ref of refs) {
    result.transcriptsScanned += 1;
    let lessons;
    let costUsd = 0;
    try {
      const transcript = await deps.source.load(ref);
      ({ lessons, costUsd } = await distillLessonsFromTranscript(transcript, deps.llm, {
        maxLessons: opts.maxLessonsPerTranscript,
      }));
    } catch (e) {
      result.errors += 1;
      deps.log(`distill failed for ${ref}: ${e instanceof Error ? e.message : e}`);
      continue;
    }
    result.costUsd += costUsd;
    await ledgerSpend(deps, costUsd, 'lesson distillation', ref);
    result.lessonsDistilled += lessons.length;

    for (const lesson of lessons) {
      const admitted = await deps.store.admit({
        workspaceId,
        signature: lessonSignature(lesson.lessonText),
        title: lesson.title,
        lessonText: lesson.lessonText,
        sourceKind: 'transcript',
        sourceRef: ref,
      });
      if (!admitted.admitted) continue; // re-distilled duplicate — already tracked
      result.lessonsAdmitted += 1;
      // D-006 free admission: into memory at tier 'probationary', usable
      // immediately; the transfer test decides retention/promotion later.
      if (deps.memory) {
        try {
          const memoryId = await admitProbationaryMemory(deps.memory, {
            text: lesson.lessonText,
            scope: opts.memoryScope,
            kind: 'project',
            metadata: {
              origin: TRANSFER_ORIGIN,
              transfer_lesson_id: admitted.lesson.id,
              source_ref: ref,
            },
          });
          if (memoryId) {
            await deps.store.setMemoryId({ workspaceId, id: admitted.lesson.id, memoryId });
          }
        } catch (e) {
          deps.log(`memory admission failed for ${admitted.lesson.id}: ${e instanceof Error ? e.message : e}`);
        }
      }
    }
  }
}

/** The testing leg: student-transfer tests over the queue, gate transitions
 *  mirrored onto memory (promote/demote metadata; retire ⇒ forget). */
async function testLeg(
  workspaceId: string,
  deps: TransferTickDeps,
  opts: TransferTickOptions,
  result: TransferTickResult,
): Promise<void> {
  if (!deps.replay) {
    result.testingSkippedNoReplay = true;
    deps.log('replay substrate not wired yet (frontier:replay-landed pending) — testing leg skipped');
    return;
  }
  const queue = await deps.store.listForTesting({ workspaceId, limit: opts.maxTestsPerTick });
  for (const lesson of queue) {
    if (lesson.sourceKind !== 'transcript' || !lesson.sourceRef) continue; // nothing replayable
    let outcome;
    try {
      const transcript = await deps.source.load(lesson.sourceRef);
      outcome = await deps.replay({ lesson, transcript });
    } catch (e) {
      result.errors += 1;
      await deps.store.markError({ workspaceId, id: lesson.id });
      deps.log(`transfer test errored for ${lesson.id}: ${e instanceof Error ? e.message : e}`);
      continue;
    }
    result.tested += 1;
    // Battery spend is counted for the tick report but NOT ledgered here —
    // the governed replay path already ledgers it on frontier:replay-harness
    // (replay-adapter.ts); ledgering again would double-count the dollar on
    // the governor's one visible number. The transfer loop ledgers only its
    // own distillation spend.
    result.costUsd += outcome.costUsd;

    const verdict = transferVerdict(outcome, opts);
    const transition = applyTransferVerdict(lesson, verdict, opts);
    await deps.store.recordOutcome({
      workspaceId,
      id: lesson.id,
      transition,
      batteryId: outcome.batteryId,
      delta: outcome.withComposite - outcome.baselineComposite,
    });
    if (verdict === 'passed') result.passed += 1;
    else if (transition.tier === 'retired') result.retired += 1;
    else result.failed += 1;

    // Mirror the tier onto the memory entry (best-effort — transfer_lessons
    // stays authoritative; a backend that can't patch metadata logs and moves on).
    if (deps.memory && lesson.memoryId) {
      try {
        if (transition.forgetMemory) {
          await deps.memory.forget(lesson.memoryId);
          await deps.store.setMemoryId({ workspaceId, id: lesson.id, memoryId: null });
        } else if (transition.tier !== 'retired') {
          await setMemoryTier(deps.memory, lesson.memoryId, transition.tier);
        }
      } catch (e) {
        deps.log(`memory tier mirror failed for ${lesson.id}: ${e instanceof Error ? e.message : e}`);
      }
    }
  }
}

/** One nightly tick. Idempotent-ish: re-distillation dedups on signature; the
 *  test queue orders by last_tested_at, so a replayed tick retests the
 *  stalest rows rather than duplicating work. Never throws. */
export async function runTransferTick(
  workspaceId: string,
  deps: TransferTickDeps,
  opts: TransferTickOptions,
): Promise<TransferTickResult> {
  const result: TransferTickResult = {
    transcriptsScanned: 0,
    lessonsDistilled: 0,
    lessonsAdmitted: 0,
    tested: 0,
    passed: 0,
    failed: 0,
    retired: 0,
    errors: 0,
    testingSkippedNoReplay: false,
    costUsd: 0,
  };
  await distillLeg(workspaceId, deps, opts, result);
  await testLeg(workspaceId, deps, opts, result);
  return result;
}
