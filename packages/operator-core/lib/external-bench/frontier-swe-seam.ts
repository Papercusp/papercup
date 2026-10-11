/**
 * FrontierSWE's {@link CloneGradeSeam} (plan benchmark-suite-frontier-swe-2026-06-18 P-008; v2 grading: plan
 * benchmark-coverage-frontierswe-v2-2026-10-10 P-003 / D-003) — the per-benchmark clone/grade half that EVERY
 * coordination-topology arm shares (the C5 fairness invariant: identical across arms, differs across benchmarks).
 * su-37e53a76's topology runtime drives the agent inside the container per the arm's {@link CoordinationSpec};
 * THIS seam owns only the benchmark-specific lifecycle:
 *
 *   clone(task)   → `docker run -d <image> sleep infinity` → a live container handle (the agent execs in and
 *                   works in /app; the task workspace is baked into the image). `--gpus all` for GPU tasks.
 *   grade(task,h) → grade with the task's OWN verifier — v1: stage `tests/` into the arm container and run it
 *                   there; v2: a FRESH container from the digest-pinned verifier image, artifacts copied over
 *                   (D-003 §1-2) — and turn the reward into a continuous `score∈[0,1]`. We author NO verifier.
 *   teardown(h)   → `docker rm -f` (never-throw — always called, leak-free).
 *
 * grade() DELEGATES to {@link makeFrontierSweGrader} with the live primitives, so the seam and the standalone
 * OfficialGrader run literally the same code path — reward precedence, version pinning and the separate verifier
 * can never diverge between them. Subprocess is INJECTED ({@link ProcExec}) → unit-testable with a fake docker.
 */
import type { CloneGradeSeam } from './coordination-topology';
import type { BenchTask } from './types';
import type { GraderFs, ProcExec } from './grader/swe-bench-pro';
import { liveProcExec } from './grader/index';
import { liveBuildVerifierCommand, livePrepareSeparateVerifier, liveReadReward } from './grader/frontier-swe-live';
import { makeFrontierSweGrader, type FrontierSweGraderConfig } from './grader/frontier-swe';
import { checkContainerEvidenceIntegrity, FRONTIER_SWE_PROTECTED_PATHS, type EvidenceIntegrity } from './evidence-integrity';

/** The opaque environment handle for a FrontierSWE task — a live Docker container the arm operated. */
export interface FrontierSweEnvHandle {
  containerId: string;
  image: string;
  instanceId: string;
}

export interface FrontierSweSeamConfig {
  /**
   * The v1 grader version pin (repo commit / image-set tag). Needed only for v1 (history) tasks — a v1 task graded
   * without it is an error row. v2 tasks pin themselves from their corpus commit + verifier image digest.
   */
  version?: string;
  /** Inject a fake in tests; production uses the shell-free `liveProcExec` (execFile, no host shell). */
  exec?: ProcExec;
  /** Run the verifier in oracle mode (HARBOR_ORACLE_MODE=1) — the gold/positive control path. Default false. */
  oracle?: boolean;
  /**
   * The per-run `HARBOR_ORACLE_FLAG` secret for a v2 oracle run — the SAME value the driver passed to `solve.sh`.
   * Required with `oracle` for v2 tasks (the verifier refuses to treat the run as gold without it).
   */
  oracleFlag?: string;
  /** Extra `docker run` flags (e.g. resource limits) the driver wants applied uniformly. Default none. */
  extraRunArgs?: string[];
  /**
   * The vendored v1 Proximal-Labs/frontier-swe checkout (default PAPERCUSP_FRONTIER_SWE_DIR). For a v1 (shared)
   * task the seam `docker cp`s `<repoDir>/tasks/<id>/tests` into the container at `/tests` at GRADE time (and
   * `/solution` in oracle mode) — the v1 task image bakes only `/app`; Harbor uploads tests/ at verify time, so we
   * mirror that. Staging post-agent keeps the hidden tests away from the agent (anti-cheat). Confirmed against the
   * real harness 2026-06-18: gold control → 0.985, empty → 0.0 (libexpat-to-x86asm). v2 tasks need no staging:
   * their verifier image owns `/tests` (D-003 §1).
   */
  repoDir?: string;
  /** Override the separate-verifier lifecycle (tests); production uses {@link livePrepareSeparateVerifier}. */
  prepareVerifierEnv?: FrontierSweGraderConfig['prepareVerifierEnv'];
}

/** The seam never reads host files through the grader — the reward is read out of a container. */
const NO_HOST_FS: GraderFs = {
  mkdtemp: async () => {
    throw new Error('FrontierSWE seam: no host fs');
  },
  writeFile: async () => {
    throw new Error('FrontierSWE seam: no host fs');
  },
  readFile: async () => '',
  rm: async () => undefined,
};

/**
 * The protected set for one task: {@link FRONTIER_SWE_PROTECTED_PATHS} plus the task's optional
 * `graderMeta.protectedPaths` (verifier fixtures under /app; /app itself is the submission and cannot be
 * protected wholesale). A malformed declaration is `unverifiable`, never silently ignored.
 *
 * `oracle` (the gold control, P-007): the reference solution IS the attempt, and Harbor's oracle agent uploads it
 * to `/solution` before running it, so `/solution` is the one protected path an oracle run legitimately writes.
 * Every other protected path (the verifier, `/logs/verifier`, task fixtures) stays protected in oracle mode too.
 */
export async function checkFrontierSweIntegrity(
  exec: ProcExec,
  task: BenchTask,
  containerId: string,
  opts: { oracle?: boolean } = {},
): Promise<EvidenceIntegrity> {
  const base = opts.oracle ? FRONTIER_SWE_PROTECTED_PATHS.filter((p) => p !== '/solution') : [...FRONTIER_SWE_PROTECTED_PATHS];
  const declared = task.graderMeta?.['protectedPaths'];
  if (declared !== undefined && !(Array.isArray(declared) && declared.every((p) => typeof p === 'string'))) {
    return { verdict: 'unverifiable', protectedPaths: base, error: 'graderMeta.protectedPaths must be an array of strings' };
  }
  return checkContainerEvidenceIntegrity(exec, containerId, [...base, ...((declared as string[] | undefined) ?? [])]);
}

/** Build FrontierSWE's CloneGradeSeam — supplied once to the shared topology runtime; every arm uses it identically. */
export function makeFrontierSweCloneGradeSeam(cfg: FrontierSweSeamConfig): CloneGradeSeam<FrontierSweEnvHandle> {
  const exec = cfg.exec ?? liveProcExec;
  const grader = makeFrontierSweGrader(
    {
      version: cfg.version,
      prepareVerifierEnv: cfg.prepareVerifierEnv ?? livePrepareSeparateVerifier,
      buildVerifierCommand: (ctx) => liveBuildVerifierCommand({ ...ctx, oracle: cfg.oracle, oracleFlag: cfg.oracleFlag }),
      readReward: liveReadReward,
    },
    { exec, fs: NO_HOST_FS },
  );

  return {
    modality: 'in-container',

    async clone(task: BenchTask): Promise<FrontierSweEnvHandle> {
      const image = task.graderMeta?.['dockerImage'] as string | undefined;
      if (!image) throw new Error(`FrontierSWE clone: task ${task.instanceId} has no dockerImage in graderMeta`);
      const gpus = Number(task.graderMeta?.['gpus'] ?? 0);
      const runArgs = ['run', '-d'];
      if (gpus > 0) runArgs.push('--gpus', 'all');
      if (cfg.extraRunArgs?.length) runArgs.push(...cfg.extraRunArgs);
      // Keep the container alive so the topology runtime can exec the agent into the baked-in /app workspace.
      runArgs.push(image, 'sleep', 'infinity');
      const r = await exec('docker', runArgs);
      const containerId = r.stdout.trim().split('\n').pop() ?? '';
      if (r.code !== 0 || !containerId) {
        throw new Error(`FrontierSWE clone: docker run failed for ${task.instanceId} (${image}) — exit ${r.code}: ${r.stderr.slice(0, 300)}`);
      }
      return { containerId, image, instanceId: task.instanceId };
    },

    async grade(task: BenchTask, handle: FrontierSweEnvHandle) {
      // Pre-grade evidence integrity (P-020 / D-008) — FIRST, before v1 staging legitimately writes /tests and
      // /solution into this container. Tampering → 'invalid' (terminal, disclosed); an unreadable diff → 'error'.
      const integrity = await checkFrontierSweIntegrity(exec, task, handle.containerId, { oracle: cfg.oracle });
      if (integrity.verdict === 'tampered') return { resolved: null, score: null, graderStatus: 'invalid', detail: { integrity } };
      if (integrity.verdict === 'unverifiable') return { resolved: null, score: null, graderStatus: 'error', detail: { integrity } };
      const separate = task.graderMeta?.['verifierEnvironmentMode'] === 'separate';
      // v1 only: stage the hidden tests INTO the arm container at GRADE time (post-agent) — the v1 image bakes only
      // /app; Harbor uploads tests/ at verify time. Doing it here (not in clone) keeps /tests away from the agent.
      const repoDir = cfg.repoDir ?? process.env.PAPERCUSP_FRONTIER_SWE_DIR;
      if (repoDir && !separate) {
        try {
          await exec('docker', ['cp', `${repoDir}/tasks/${handle.instanceId}/tests`, `${handle.containerId}:/tests`]);
          if (cfg.oracle) await exec('docker', ['cp', `${repoDir}/tasks/${handle.instanceId}/solution`, `${handle.containerId}:/solution`]);
        } catch (e) {
          return { resolved: null, score: null, graderStatus: 'error', detail: { stageTestsError: e instanceof Error ? e.message : String(e), integrity } };
        }
      }

      const [g] = await grader.grade(
        [{ modality: 'in-container', instanceId: handle.instanceId, envRef: handle.containerId, prefix: 'seam' }],
        [task],
      );
      if (!g || g.graderError || g.score == null) {
        // Verifier produced no valid verdict → infra, surfaced + excluded (C6), never a silent 0.
        return {
          resolved: null,
          score: null,
          graderStatus: 'error',
          detail: { graderError: g?.graderError ?? 'no grade row', graderVersion: g?.graderVersion ?? null, raw: g?.rawGraderOutput ?? null, integrity },
        };
      }
      // A genuine capability outcome (incl. score 0). resolved = (score === 1) is degenerate for FrontierSWE.
      return {
        resolved: g.resolved,
        score: g.score,
        graderStatus: g.resolved ? 'passed' : 'failed',
        detail: { ...(g.rawGraderOutput as object), graderVersion: g.graderVersion, integrity },
      };
    },

    async teardown(handle: FrontierSweEnvHandle): Promise<void> {
      // Never-throw: teardown is ALWAYS called (success / capability-fail / infra-fail) — must not leak a container.
      try {
        await exec('docker', ['rm', '-f', handle.containerId]);
      } catch {
        /* swallow — a teardown failure must never break the run */
      }
    },
  };
}
