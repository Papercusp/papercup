/**
 * The nightly transfer tick (P-022 / FB-08) — distill → admit (free,
 * probationary) → student-transfer test → promote/demote/retire (gate.ts).
 *
 * Every dep is a port ({@link TransferTickDeps}) so tick.test.ts covers the
 * whole flow with zero LLM/PG. The live deps come from
 * `defaultTransferTickDeps` (PG pool, fs transcript lister, Anthropic
 * distiller, the memory backend) — EXCEPT `replay`, which stays null until
 * lib/replay's battery lands (`frontier:replay-landed`); a null replay port
 * skips the testing leg with an honest count, never a silent drop.
 *
 * Spend: distillation + battery costs are ledgered on the learning governor
 * (accumulate:true — the governor is this loop's only spend store), tagged
 * origin='replay' (D-002).
 */
import type { Sql } from 'postgres';
import type { MemoryBackend } from '@papercusp/memory';
import { recordLearningSpend } from '../learning-governor/store';
import { admitProbationaryMemory, setMemoryTier } from '../memory/two-tier';
import { applyTransferVerdict, transferVerdict, type TransferTickOptions } from './gate';
import { distillLessonsFromTranscript, lessonSignature } from './distill';
import {
  admitTransferLesson,
  listLessonsForTesting,
  markTransferError,
  recordTransferOutcome,
  setLessonMemoryId,
} from './store';
import {
  TRANSFER_LOOP_ID,
  TRANSFER_ORIGIN,
  type LessonDistillerLlm,
  type TranscriptRefLister,
  type TransferReplayPort,
  type TransferTranscriptSource,
} from './types';

export interface TransferTickDeps {
  sql: Sql;
  lister: TranscriptRefLister;
  source: TransferTranscriptSource;
  llm: LessonDistillerLlm;
  /** null until the replay substrate is wired (frontier:replay-landed). */
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
  workspaceId: string,
  costUsd: number,
  note: string,
  runRef?: string,
): Promise<void> {
  if (!(costUsd > 0)) return;
  try {
    await recordLearningSpend(deps.sql, {
      workspaceId,
      loopId: TRANSFER_LOOP_ID,
      costUsd,
      signalOrigin: TRANSFER_ORIGIN,
      runRef: runRef ?? null,
      note,
      accumulate: true,
    });
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
    await ledgerSpend(deps, workspaceId, costUsd, 'lesson distillation', ref);
    result.lessonsDistilled += lessons.length;

    for (const lesson of lessons) {
      const admitted = await admitTransferLesson(deps.sql, {
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
            await setLessonMemoryId(deps.sql, { workspaceId, id: admitted.lesson.id, memoryId });
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
  const queue = await listLessonsForTesting(deps.sql, { workspaceId, limit: opts.maxTestsPerTick });
  for (const lesson of queue) {
    if (lesson.sourceKind !== 'transcript' || !lesson.sourceRef) continue; // nothing replayable
    let outcome;
    try {
      const transcript = await deps.source.load(lesson.sourceRef);
      outcome = await deps.replay({ lesson, transcript });
    } catch (e) {
      result.errors += 1;
      await markTransferError(deps.sql, { workspaceId, id: lesson.id });
      deps.log(`transfer test errored for ${lesson.id}: ${e instanceof Error ? e.message : e}`);
      continue;
    }
    result.tested += 1;
    result.costUsd += outcome.costUsd;
    await ledgerSpend(deps, workspaceId, outcome.costUsd, 'student-transfer test', outcome.batteryId);

    const verdict = transferVerdict(outcome, opts);
    const transition = applyTransferVerdict(lesson, verdict, opts);
    await recordTransferOutcome(deps.sql, {
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
          await setLessonMemoryId(deps.sql, { workspaceId, id: lesson.id, memoryId: null });
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
