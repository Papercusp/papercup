import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { parse as parseYaml } from 'yaml';
import { describe, expect, it } from 'vitest';

import {
  LEARNING_MODEL_EFFORT,
  LEARNING_MODEL_ID,
  LEARNING_MODEL_SPEC,
  isCanonicalLearningModel,
  optionalModelSpec,
} from './model-policy';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');

type ModelBearingEdge = {
  id: string;
  classification: 'canonical-policy' | 'canonical-upstream';
  path: string;
  markers: readonly string[];
};

/**
 * The audited P-001 inventory. `canonical-policy` sites bind the shared policy
 * directly; `canonical-upstream` leaves deliberately receive the model from a
 * caller whose default/config is pinned elsewhere in this same inventory.
 *
 * Keeping the leaves here matters: a central constant can stay green while an
 * actual LLM call quietly stops using it. The marker checks below pin both the
 * policy sites and the final model-bearing call seams.
 */
const MODEL_BEARING_EDGES: readonly ModelBearingEdge[] = [
  {
    id: 'scout.phase-defaults',
    classification: 'canonical-policy',
    path: 'packages/operator-core/lib/scout/models.ts',
    markers: [
      'DEFAULT_SCOUT_IDEATOR_MODEL = LEARNING_MODEL_SPEC',
      'DEFAULT_SCOUT_CRITIC_MODEL = LEARNING_MODEL_SPEC',
      'DEFAULT_SCOUT_RECOMBINE_MODEL = LEARNING_MODEL_SPEC',
      'DEFAULT_SCOUT_REVISION_MODEL = LEARNING_MODEL_SPEC',
      'DEFAULT_SCOUT_EXPERIMENT_MODEL = LEARNING_MODEL_SPEC',
    ],
  },
  {
    id: 'scout.ideator',
    classification: 'canonical-upstream',
    path: 'packages/operator-core/lib/scout/ideators.ts',
    markers: ['SCOUT_IDEATOR_MODEL = DEFAULT_SCOUT_IDEATOR_MODEL', 'const model = opts.model ?? SCOUT_IDEATOR_MODEL'],
  },
  {
    id: 'scout.critic',
    classification: 'canonical-upstream',
    path: 'packages/operator-core/lib/scout/critics.ts',
    markers: ['DEFAULT_CRITIC_MODEL = DEFAULT_SCOUT_CRITIC_MODEL', 'model: ctx.model ?? DEFAULT_CRITIC_MODEL'],
  },
  {
    id: 'scout.recombine',
    classification: 'canonical-upstream',
    path: 'packages/operator-core/lib/scout/recombine.ts',
    markers: ['DEFAULT_RECOMBINE_MODEL = DEFAULT_SCOUT_RECOMBINE_MODEL', 'model: opts.model ?? DEFAULT_RECOMBINE_MODEL'],
  },
  {
    id: 'scout.revision',
    classification: 'canonical-upstream',
    path: 'packages/operator-core/lib/scout/revise.ts',
    markers: ['DEFAULT_REVISION_MODEL = DEFAULT_SCOUT_REVISION_MODEL', 'const model = deps.model ?? DEFAULT_REVISION_MODEL'],
  },
  {
    id: 'scout.experiment',
    classification: 'canonical-upstream',
    path: 'packages/operator-core/lib/scout/experiment-generate.ts',
    markers: ['DEFAULT_EXPERIMENT_GEN_MODEL = DEFAULT_SCOUT_EXPERIMENT_MODEL', 'model: opts.model ?? DEFAULT_EXPERIMENT_GEN_MODEL'],
  },
  {
    id: 'scout.capacity-fallback',
    classification: 'canonical-policy',
    path: 'packages/operator-core/lib/scout/register-scout-action.ts',
    markers: ['DEFAULT_SCOUT_CODEX_FALLBACK_MODEL = LEARNING_MODEL_SPEC'],
  },
  {
    id: 'gym.proposer',
    classification: 'canonical-policy',
    path: 'packages/operator-core/lib/gym/autoloop-cycle.ts',
    markers: ['process.env.GYM_LOOP_PROPOSER_MODEL ?? LEARNING_MODEL_SPEC', 'proposerModel: PROPOSER_MODEL'],
  },
  {
    id: 'gym.task-generator',
    classification: 'canonical-upstream',
    path: 'packages/operator-core/lib/gym/task-generator.ts',
    markers: ['model: input.generatorModel'],
  },
  {
    id: 'gym.probe-generator',
    classification: 'canonical-upstream',
    path: 'packages/operator-core/lib/gym/probe-generator.ts',
    markers: ['model: input.generatorModel'],
  },
  {
    id: 'gym.judge-and-rejudge',
    classification: 'canonical-policy',
    path: 'packages/operator-core/lib/gym/judge-scoring.ts',
    markers: ['model: LEARNING_MODEL_SPEC'],
  },
  {
    id: 'gym.spawned-roles',
    classification: 'canonical-policy',
    path: 'packages/operator-core/lib/gym/boot-spec.ts',
    markers: [
      'AGENT_ROLES.map((role) => [role, LEARNING_MODEL_SPEC])',
      'cfg.agentModels ?? CANONICAL_GYM_AGENT_MODELS',
    ],
  },
  {
    id: 'iq-battery.solver',
    classification: 'canonical-policy',
    path: 'packages/operator-core/lib/iq-battery/beekeeper-gen0-runner.ts',
    markers: ['bee: LEARNING_MODEL_SPEC'],
  },
  {
    id: 'iq-battery.judge',
    classification: 'canonical-policy',
    path: 'packages/operator-core/lib/iq-battery/beekeeper-gen0-runner.ts',
    markers: ['model: LEARNING_MODEL_SPEC'],
  },
  {
    id: 'transfer.distiller',
    classification: 'canonical-policy',
    path: 'packages/operator-core/lib/transfer/live-deps.ts',
    markers: ['TRANSFER_DISTILL_MODEL = LEARNING_MODEL_SPEC', 'opts.model ?? TRANSFER_DISTILL_MODEL'],
  },
  {
    id: 'transfer.student',
    classification: 'canonical-policy',
    path: 'packages/operator-core/lib/transfer/live-deps.ts',
    markers: ['TRANSFER_STUDENT_MODEL = LEARNING_MODEL_SPEC', 'opts.model ?? TRANSFER_STUDENT_MODEL'],
  },
  {
    id: 'replay.judge',
    classification: 'canonical-policy',
    path: 'packages/operator-core/lib/replay/battery.ts',
    markers: ['model: LEARNING_MODEL_SPEC'],
  },
  {
    id: 'regret.replay',
    classification: 'canonical-policy',
    path: 'packages/operator-core/lib/replay/regret/replay-adapter.ts',
    markers: ['DEFAULT_REGRET_REPLAY_MODEL = LEARNING_MODEL_SPEC', 'options.replayModel ?? DEFAULT_REGRET_REPLAY_MODEL'],
  },
  {
    id: 'prompt-ablation.sut-judge-simulator',
    classification: 'canonical-policy',
    path: 'packages/operator-core/lib/ablation/runner.ts',
    markers: [
      'sutModel: LEARNING_MODEL_SPEC',
      'judgeModel: LEARNING_MODEL_SPEC',
      'simModel: LEARNING_MODEL_SPEC',
    ],
  },
  {
    id: 'prompt-ablation.replay',
    classification: 'canonical-policy',
    path: 'packages/operator-core/lib/ablation/replay-leg.ts',
    markers: ['DEFAULT_ABLATION_REPLAY_MODEL = LEARNING_MODEL_SPEC', 'opts.model ?? DEFAULT_ABLATION_REPLAY_MODEL'],
  },
  {
    id: 'improvement.auto-implementation-worker',
    classification: 'canonical-policy',
    path: 'packages/operator-core/lib/harness/routines/improvement-actions.ts',
    markers: ['spawnModel: LEARNING_MODEL_SPEC'],
  },
] as const;

/** P-001's explicitly model-free learning operations. */
const DETERMINISTIC_MODEL_FREE_EDGES = [
  ['calibration', 'packages/operator-core/lib/blueprint-steps/ops/calibration-resolve.ts'],
  ['change-ledger', 'packages/operator-core/lib/blueprint-steps/ops/change-ledger-scan.ts'],
  ['deferral-interest', 'packages/operator-core/lib/blueprint-steps/ops/deferral-interest-refit.ts'],
  ['fleet-ekg', 'packages/operator-core/lib/blueprint-steps/ops/fleet-ekg-scan.ts'],
  ['graduation', 'packages/operator-core/lib/blueprint-steps/ops/graduation-scan.ts'],
  ['memory-precision', 'packages/operator-core/lib/blueprint-steps/ops/memory-precision-bench.ts'],
  ['memory-recall-canary', 'packages/operator-core/lib/blueprint-steps/ops/memory-live-recall-canary.ts'],
  ['negative-space', 'packages/operator-core/lib/blueprint-steps/ops/negative-space-scan.ts'],
  ['neologism', 'packages/operator-core/lib/blueprint-steps/ops/neologism-mine.ts'],
  ['red-queen', 'packages/operator-core/lib/blueprint-steps/ops/red-queen-drill.ts'],
] as const;

const EXPECTED_POLICY_IMPORTERS = [
  'packages/operator-core/lib/ablation/replay-leg.ts',
  'packages/operator-core/lib/ablation/runner.ts',
  'packages/operator-core/lib/gym/autoloop-cycle.ts',
  'packages/operator-core/lib/gym/boot-spec.ts',
  'packages/operator-core/lib/gym/judge-scoring.ts',
  'packages/operator-core/lib/harness/routines/improvement-actions.ts',
  'packages/operator-core/lib/iq-battery/beekeeper-gen0-runner.ts',
  'packages/operator-core/lib/replay/battery.ts',
  'packages/operator-core/lib/replay/regret/replay-adapter.ts',
  'packages/operator-core/lib/scout/models.ts',
  'packages/operator-core/lib/scout/register-scout-action.ts',
  'packages/operator-core/lib/transfer/live-deps.ts',
] as const;

const SCOPED_SOURCE_DIRS = [
  'packages/operator-core/lib/learning',
  'packages/operator-core/lib/scout',
  'packages/operator-core/lib/gym',
  'packages/operator-core/lib/iq-battery',
  'packages/operator-core/lib/transfer',
  'packages/operator-core/lib/replay',
  'packages/operator-core/lib/ablation',
] as const;

const LEGACY_GYM_LAUNCHER_MODELS = new Map<string, ReadonlySet<string>>([
  ['packages/operator-core/lib/gym/ab-run.ts', new Set(['claude-sonnet-4-6'])],
  ['packages/operator-core/lib/gym/autoloop-cycle.ts', new Set(['claude-sonnet-4-6'])],
  ['packages/operator-core/lib/gym/blueprint-cycle.ts', new Set(['claude-sonnet-4-6'])],
  ['packages/operator-core/lib/gym/wake-mode.ts', new Set(['claude-haiku-4-5-20251001'])],
]);

function sourceAt(path: string): string {
  return readFileSync(resolve(ROOT, path), 'utf8');
}

function productionTypeScriptFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === '__tests__') continue;
    const absolute = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...productionTypeScriptFiles(absolute));
    else if (entry.isFile() && entry.name.endsWith('.ts') && !/\.(?:test|spec)\.ts$/.test(entry.name)) files.push(absolute);
  }
  return files;
}

function scopedProductionSources(): string[] {
  const directoryFiles = SCOPED_SOURCE_DIRS.flatMap((path) => productionTypeScriptFiles(resolve(ROOT, path)));
  const improvementWorker = resolve(ROOT, 'packages/operator-core/lib/harness/routines/improvement-actions.ts');
  return [...new Set([...directoryFiles, improvementWorker])].sort();
}

const PROVIDER_MODEL_ID = /\b(?:gpt-\d+(?:\.\d+)*(?:-[a-z0-9]+)*(?::[a-z]+)?|claude-(?:opus|sonnet|haiku)-[a-z0-9.-]+)\b/g;

function providerModelIdsInTypeScript(path: string, source: string): string[] {
  const parsed = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const ids: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isStringLiteralLike(node)) {
      ids.push(...Array.from(node.text.matchAll(PROVIDER_MODEL_ID), (match) => match[0]));
    }
    ts.forEachChild(node, visit);
  };
  visit(parsed);
  return ids;
}

describe('canonical learning model policy', () => {
  it('preserves the exact Sol xhigh owner directive without a family alias', () => {
    // Owner-directed [owner 2026-08-27]: Codex limits reset, so learning moved
    // back to the exact Sol xhigh spec after the temporary Opus 5 switch.
    expect(LEARNING_MODEL_ID).toBe('gpt-5.6-sol');
    expect(LEARNING_MODEL_EFFORT).toBe('xhigh');
    expect(LEARNING_MODEL_SPEC).toBe('gpt-5.6-sol:xhigh');
    expect(isCanonicalLearningModel(LEARNING_MODEL_SPEC)).toBe(true);
    // A near-miss family alias and a wrong effort must BOTH still be rejected —
    // that is what "without a family alias" buys, and it has to keep holding
    // across the provider change.
    expect(isCanonicalLearningModel('gpt-5.6:xhigh')).toBe(false);
    expect(isCanonicalLearningModel('gpt-5.6-sol:high')).toBe(false);
    // The temporary fallback must not still read as canonical.
    expect(isCanonicalLearningModel('claude-opus-5:xhigh')).toBe(false);
  });

  it('keeps every audited model-bearing edge on its canonical policy seam', () => {
    const violations: string[] = [];
    for (const edge of MODEL_BEARING_EDGES) {
      const source = sourceAt(edge.path);
      for (const marker of edge.markers) {
        if (!source.includes(marker)) violations.push(`${edge.id} (${edge.classification}) missing ${marker} in ${edge.path}`);
      }
    }
    expect(violations).toEqual([]);
  });

  it('forces every new direct policy importer into the audited inventory', () => {
    const importers = scopedProductionSources()
      .filter((path) => /from ['"][^'"]*learning\/model-policy['"]/.test(readFileSync(path, 'utf8')))
      .map((path) => relative(ROOT, path))
      .sort();
    expect(importers).toEqual([...EXPECTED_POLICY_IMPORTERS].sort());
  });

  it('keeps explicitly deterministic learning operations model-free', () => {
    const modelBearingToken = /\b(?:LEARNING_MODEL_SPEC|llmCall|callLlm|spawnAgentInHarness|spawnInvokeOnce)\b/;
    const violations = DETERMINISTIC_MODEL_FREE_EDGES.flatMap(([id, path]) => {
      const match = sourceAt(path).match(modelBearingToken);
      return match ? [`${id} unexpectedly contains model-bearing token ${match[0]} in ${path}`] : [];
    });
    expect(violations).toEqual([]);
  });

  it('rejects noncanonical provider-model literals from scoped production learning code', () => {
    // The four Gym entrypoints retain a Claude-shaped AGENT_CMD only as the
    // compatibility launcher command; boot-spec's exhaustive AGENT_MODELS map
    // backend-swaps every real spawned role to the canonical learning policy.
    const violations: string[] = [];
    for (const absolute of scopedProductionSources()) {
      const path = relative(ROOT, absolute);
      for (const model of providerModelIdsInTypeScript(path, readFileSync(absolute, 'utf8'))) {
        if (model === LEARNING_MODEL_ID || model === LEARNING_MODEL_SPEC) continue;
        if (LEGACY_GYM_LAUNCHER_MODELS.get(path)?.has(model)) continue;
        violations.push(`${path}: ${model}`);
      }
    }
    expect(violations).toEqual([]);
  });

  it('keeps every built-in Gym rubric override canonical in source and sidecar projection', () => {
    const roots = [
      'libs/papercusp/packages/harness/blueprints',
      'apps/operator/dist-sidecar/blueprints',
    ];
    const violations: string[] = [];
    for (const root of roots) {
      const absoluteRoot = resolve(ROOT, root);
      for (const entry of readdirSync(absoluteRoot, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const path = join(absoluteRoot, entry.name, 'blueprint.yaml');
        const parsed = parseYaml(readFileSync(path, 'utf8')) as { gym?: { rubric?: { model?: unknown } } };
        const model = parsed.gym?.rubric?.model;
        if (model !== undefined && model !== LEARNING_MODEL_SPEC) {
          violations.push(`${relative(ROOT, path)}: gym.rubric.model=${String(model)}`);
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it('has a non-vacuous provider-model literal detector', () => {
    expect(providerModelIdsInTypeScript('bad.ts', "const model = 'claude-opus-4-8';")).toEqual(['claude-opus-4-8']);
  });
});

describe('optionalModelSpec', () => {
  it('treats absent and blank overrides as "no override" so the caller falls back to policy', () => {
    // undefined/null are "the payload did not set it". A blank or whitespace
    // string is the admin-UI-cleared-the-field case and must NOT reach a
    // backend as an empty model id.
    expect(optionalModelSpec(undefined, 'promoter')).toBeUndefined();
    expect(optionalModelSpec(null, 'promoter')).toBeUndefined();
    expect(optionalModelSpec('', 'promoter')).toBeUndefined();
    expect(optionalModelSpec('   ', 'promoter')).toBeUndefined();
  });

  it('trims a real override and passes a NONCANONICAL spec through untouched', () => {
    expect(optionalModelSpec('  gpt-5.6-sol:xhigh  ', 'promoter')).toBe(LEARNING_MODEL_SPEC);
    // The whole point of a per-run override is escaping the canonical spec —
    // e.g. routing away from a model whose account is rate-limited or, as on
    // 2026-08-27, unsupported by the backing account. It must NOT be validated
    // against isCanonicalLearningModel.
    expect(optionalModelSpec('claude-opus-5:xhigh', 'promoter')).toBe('claude-opus-5:xhigh');
  });

  it('rejects a non-string payload and names the routine that received it', () => {
    for (const bad of [42, true, {}, []]) {
      expect(() => optionalModelSpec(bad, 'daily digest')).toThrow(/daily digest expected a model spec string/);
    }
  });
});

describe('scheduled admission paths resolve their model identically', () => {
  /**
   * D-035 regression guard. The plan gave bulk-dedup and daily-digest an
   * `opts.model` override and a resolve-once seam, but the promoter kept
   * `model: LEARNING_MODEL_SPEC` inline at its llmCall AND at both ledger
   * writes. Nothing failed: the promoter simply could not be steered off a
   * model whose account was rejecting it, and it is the SCHEDULED component
   * whose failures produce the queue's fail-open share.
   *
   * These files sit outside SCOPED_SOURCE_DIRS, so the importer inventory
   * above cannot see them — which is precisely why the omission survived.
   */
  const ADMISSION_ACTIONS = [
    ['promoter', 'packages/operator-core/lib/harness/routines/work-item-admission-promoter-action.ts', 'admission promoter'],
    ['bulk-dedup', 'packages/operator-core/lib/harness/routines/work-item-admission-bulk-dedup-action.ts', 'bulk dedup'],
    ['daily-digest', 'packages/operator-core/lib/harness/routines/work-item-admission-daily-digest-action.ts', 'daily digest'],
  ] as const;

  it('routes every scheduled admission action payload through the shared helper', () => {
    const violations: string[] = [];
    for (const [id, path, label] of ADMISSION_ACTIONS) {
      const source = sourceAt(path);
      if (!/from ['"][^'"]*learning\/model-policy['"]/.test(source)) {
        violations.push(`${id} does not import the shared model policy (${path})`);
      }
      if (!source.includes(`optionalModelSpec(payload.model, '${label}')`)) {
        violations.push(`${id} does not pass payload.model through optionalModelSpec (${path})`);
      }
    }
    expect(violations).toEqual([]);
  });

  /**
   * The predicate, extracted so it can be run against synthetic sources. The
   * runner must resolve once into a local `model` and use THAT at the llmCall
   * and every ledger write, so admission_runs.model_id can never name a model
   * the run did not use.
   */
  const resolveOnceViolations = (label: string, source: string): string[] => {
    const violations: string[] = [];
    if (!/const model = opts\.model\?\.trim\(\) \|\| LEARNING_MODEL_SPEC;/.test(source)) {
      violations.push(`${label} lacks the resolve-once model seam`);
    }
    for (const seam of ['model: LEARNING_MODEL_SPEC', 'modelId: LEARNING_MODEL_SPEC']) {
      if (source.includes(seam)) violations.push(`${label} still binds the constant directly at "${seam}"`);
    }
    return violations;
  };

  it('leaves no admission RUNNER binding the policy constant at a call or ledger seam', () => {
    const runners = [
      'packages/operator-core/lib/work-items-admission-promoter.ts',
      'packages/operator-core/lib/work-items-admission-bulk-dedup.ts',
      'packages/operator-core/lib/work-items-admission-daily-digest.ts',
    ];
    expect(runners.flatMap((path) => resolveOnceViolations(path, sourceAt(path)))).toEqual([]);
  });

  it('control: the guard CATCHES the exact pre-fix promoter shape, and passes the fixed one', () => {
    // Non-vacuity, run against synthetic sources so nothing in the shared tree
    // is ever mutated to prove falsifiability. `preFix` is the body the
    // promoter actually had: inline at the llmCall and at both ledger writes.
    const preFix = [
      'const response = await opts.llmCall({',
      '  model: LEARNING_MODEL_SPEC,',
      '});',
      'await persistAdmissionPlan(sql, { modelId: LEARNING_MODEL_SPEC });',
    ].join('\n');
    const postFix = [
      'const model = opts.model?.trim() || LEARNING_MODEL_SPEC;',
      'const response = await opts.llmCall({',
      '  model,',
      '});',
      'await persistAdmissionPlan(sql, { modelId: model });',
    ].join('\n');

    const caught = resolveOnceViolations('synthetic', preFix);
    expect(caught).toContain('synthetic lacks the resolve-once model seam');
    expect(caught).toContain('synthetic still binds the constant directly at "model: LEARNING_MODEL_SPEC"');
    expect(caught).toContain('synthetic still binds the constant directly at "modelId: LEARNING_MODEL_SPEC"');
    // …and does not fire on the shape we actually shipped.
    expect(resolveOnceViolations('synthetic', postFix)).toEqual([]);
  });
});
