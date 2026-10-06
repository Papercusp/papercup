/**
 * P-017 arm adapters (plan `gitnexus-deterministic-integration-2026-10-05`,
 * D-011): one interface every engine answers the fair corpus through, and the
 * conformance check that separates ADAPTER defects from engine weakness.
 *
 * Scoring lives in fair-comparison.ts and is pure. This file holds what talks to
 * the outside world: wrapping the 2026-10-02 `EngineArm`s (rg, GitNexus,
 * codebase-memory — reused rather than re-written), classifying how a query
 * failed, and writing the micro repo to disk.
 *
 * A failed query is never an empty answer. D-011 requires declined, crashed,
 * timed-out and stale-index outcomes to be reported apart from wrong answers, so
 * every adapter returns an `AnswerStatus` and `sites` is empty unless the arm
 * actually answered.
 */
import { execFile } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { CorpusCase } from './acceptance-corpus';
import type { EngineArm, PhaseCost } from './engine-comparison';
import type { AnswerKey, AnswerStatus, ArmAnswer, ArmCapabilities, CaseScore, FairCase, OutcomeClass } from './fair-comparison';
import { scoreCase } from './fair-comparison';
import { MICRO_REPO_FILES } from './fair-comparison-micro-repo';

/** One engine as the fair comparison sees it. */
export interface FairArm {
  readonly capabilities: ArmCapabilities;
  /** Non-null when the arm cannot run on this host (binary missing, licence not admitted): reported, never scored. */
  readonly unavailable: string | null;
  index(): Promise<PhaseCost>;
  query(kase: FairCase): Promise<ArmAnswer>;
}

/**
 * How a query failed, from the error text an arm produced. `null` means it
 * answered. Order matters: a decline names itself, a deadline is reported by
 * `timeout` as exit 124 (or 137 after the kill grace), and anything else that
 * failed is a crash.
 */
export function classifyArmError(error: string | null): AnswerStatus {
  if (error === null) return 'answered';
  const e = error.trim();
  if (/^declined\b/i.test(e)) return 'declined';
  if (/\bstale[- ]index\b|\bindex is stale\b|\bstale\b.*\bindex\b/i.test(e)) return 'stale-index';
  if (/\bexit (124|137)\b|\bdeadline\b|\btimed?[- ]?out\b|\bETIMEDOUT\b/i.test(e)) return 'timed-out';
  return 'crashed';
}

/** The CorpusCase shape the 2026-10-02 arms read: only id, intent and the query text drive them. */
export function toCorpusCase(kase: FairCase): CorpusCase {
  return {
    id: kase.id,
    planCase: 0,
    intent: kase.intent,
    title: kase.id,
    query: kase.subject,
    gradeMode: 'must-contain',
    expectedSites: [],
    eligibleBackends: [],
    falsifies: 'P-017 fair-comparison case (scored by fair-comparison.ts, not by gradeMode)',
  };
}

const answer = (kase: FairCase, status: AnswerStatus, latencyMs: number, sites: ArmAnswer['sites'], detail: string | null): ArmAnswer => ({
  caseId: kase.id,
  status,
  sites: status === 'answered' ? sites : [],
  latencyMs,
  ...(detail === null ? {} : { detail }),
});

/**
 * Wrap a 2026-10-02 EngineArm. An intent the arm does not declare is declined
 * without querying (the scorer counts it `undeclared`, not wrong); an error
 * string or a thrown error becomes a typed status instead of an empty answer.
 */
export function fromEngineArm(engine: EngineArm, capabilities: ArmCapabilities, now: () => number = () => performance.now()): FairArm {
  return {
    capabilities,
    unavailable: engine.unavailable,
    index: () => engine.index(),
    async query(kase) {
      if (!capabilities.intents.includes(kase.intent)) {
        return answer(kase, 'declined', 0, [], `undeclared intent '${kase.intent}'`);
      }
      const t0 = now();
      try {
        const r = await engine.query(toCorpusCase(kase));
        return answer(kase, classifyArmError(r.error), now() - t0, r.sites, r.error);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return answer(kase, classifyArmError(msg), now() - t0, [], msg);
      }
    },
  };
}

export interface AdapterDefect {
  readonly caseId: string;
  readonly outcome: OutcomeClass;
  readonly why: string;
}

export interface ConformanceReport {
  readonly armId: string;
  readonly scores: readonly CaseScore[];
  /** Plain declared cases not answered exactly, and any crash: adapter defects until shown otherwise. */
  readonly defects: readonly AdapterDefect[];
  readonly ok: boolean;
}

/**
 * Run an arm over the micro repo and name every adapter defect. A PLAIN case
 * (no hardness tag) that the arm declares must come back `correct`: the engine
 * supports the intent and the micro repo has no trap, so a miss is our parser,
 * line base or intent mapping until shown otherwise. A crash on ANY case is a
 * defect too. Hard cases are reported in `scores` but never counted as defects:
 * that is the engine being measured.
 */
export async function runConformance(arm: FairArm, cases: readonly FairCase[], keys: readonly AnswerKey[]): Promise<ConformanceReport> {
  const keyOf = new Map(keys.map((k) => [k.caseId, k]));
  const scores: CaseScore[] = [];
  const defects: AdapterDefect[] = [];
  for (const kase of cases) {
    const key = keyOf.get(kase.id);
    if (!key) throw new Error(`no answer key for micro case ${kase.id}`);
    const ans = await arm.query(kase);
    const score = scoreCase(kase, arm.capabilities, key, ans);
    scores.push(score);
    if (score.outcome === 'crashed') {
      defects.push({ caseId: kase.id, outcome: score.outcome, why: ans.detail ?? 'crashed without detail' });
    } else if (kase.tags.length === 0 && score.outcome !== 'undeclared' && score.outcome !== 'correct') {
      const got = ans.sites.map((s) => `${s.path}:${s.line1 ?? '?'}`).join(', ') || '(none)';
      defects.push({ caseId: kase.id, outcome: score.outcome, why: `plain case: expected ${key.sites.join(', ')}; got ${got}${ans.detail ? ` (${ans.detail})` : ''}` });
    }
  }
  return { armId: arm.capabilities.armId, scores, defects, ok: defects.length === 0 };
}

const git = (cwd: string, args: readonly string[]): Promise<void> =>
  new Promise((resolve, reject) => {
    execFile('git', [...args], { cwd, env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1' } }, (err, _out, stderr) =>
      err ? reject(new Error(`git ${args[0]} failed: ${String(stderr).trim() || err.message}`)) : resolve(),
    );
  });

/**
 * Write the micro repo (markers stripped) into `dir`, and by default make it a
 * one-commit git repository: several engines index only tracked files.
 */
export async function materializeMicroRepo(dir: string, opts: { git?: boolean } = {}): Promise<void> {
  for (const [rel, body] of Object.entries(MICRO_REPO_FILES)) {
    const abs = join(dir, rel);
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, body, 'utf8');
  }
  if (opts.git === false) return;
  await git(dir, ['init', '-q', '-b', 'main']);
  await git(dir, ['add', '-A']);
  await git(dir, ['-c', 'user.name=fair-comparison', '-c', 'user.email=fair-comparison@localhost', 'commit', '-q', '-m', 'micro repo']);
}
