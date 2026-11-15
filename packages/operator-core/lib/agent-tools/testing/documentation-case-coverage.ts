/**
 * P-017: mechanical reconciliation at the existing recorded-population seam.
 * Inputs must come from the canonical pre-run capture and run readers. This
 * result alone establishes neither reference authority, currentness, semantic
 * causality nor independent validator qualification.
 */
import { z } from 'zod';
import {
  isRecordedPopulationIdentity, parseRecordedNativePopulation, RECORDED_TEST_LAYERS,
  POPULATION_CAPTURE_STATUSES,
  type RecordedPopulationIdentity, type RecordedPopulationCase,
} from '@papercusp/test-config/execution-details';

const text = z.string().min(1).refine(value => value.trim().length > 0);
const fingerprint = z.string().regex(/^[a-f0-9]{64}$/);
const plan = z.string().min(1).max(120).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
const requirement = z.string().regex(/^R-[1-9]\d*$/);
const identity = z.custom<RecordedPopulationIdentity>(isRecordedPopulationIdentity);
const layer = z.enum(RECORDED_TEST_LAYERS);
const position = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const declaration = z.object({
  identity, testLayer: layer,
  source: z.object({ file: text, contentHash: fingerprint, line1: position, column1: position }).strict(),
  controlFamily: text.optional(),
}).strict();

export const documentationCaseCoverageInputSchema = z.object({
  capture: z.object({
    subjectPlan: plan, candidateTreeFingerprint: fingerprint, runGroupId: z.string().uuid(),
    requirements: z.array(z.object({
      requirementId: requirement, layers: z.array(layer).min(1),
      controlFamilies: z.array(text).min(1),
    }).strict()).min(1),
    declarations: z.array(declaration).min(1),
  }).strict(),
  executions: z.array(z.object({
    testRunId: position, runGroupId: z.string().uuid(), subjectPlan: plan,
    candidateTreeFingerprint: fingerprint, testLayer: layer, population: z.unknown(),
    testFile: text, projectName: z.string().nullable(),
    populationCaptureStatus: z.enum(POPULATION_CAPTURE_STATUSES),
    execution: z.object({
      passed: z.number().int().nonnegative(), failed: z.number().int().nonnegative(),
      skipped: z.number().int().nonnegative(), collectionFailed: z.boolean(),
    }).strict(),
  }).strict()),
  causalPairs: z.array(z.object({
    baseline: identity, falsifier: identity, controlFamily: text,
    changedCause: text, predictedReason: text, observedReason: text,
  }).strict()),
}).strict();
export type DocumentationCaseCoverageInput = z.infer<typeof documentationCaseCoverageInputSchema>;

export interface DocumentationCaseTag {
  subjectPlan: string;
  requirementId: string;
  role: 'baseline' | 'falsifier';
}

/** Titles may change; their one plan/requirement/role attribution must remain explicit. */
export function readDocumentationCaseTag(title: string): DocumentationCaseTag | null {
  const tags = [...title.matchAll(/\[([^\]\r\n]+)\]/g)].map(match => match[1]!);
  const plans = tags.filter(tag => tag.startsWith('plan:'));
  const requirements = tags.filter(tag => /^R-/.test(tag));
  const roles = tags.filter(tag => tag === 'baseline' || tag === 'falsifier');
  if (plans.length !== 1 || requirements.length !== 1 || roles.length !== 1) return null;
  const subjectPlan = plans[0]!.slice(5);
  if (!plan.safeParse(subjectPlan).success || !requirement.safeParse(requirements[0]).success) return null;
  return { subjectPlan, requirementId: requirements[0]!, role: roles[0] as DocumentationCaseTag['role'] };
}

export interface DocumentationCaseCoverageResult {
  status: 'complete' | 'incomplete' | 'invalid';
  reasons: Array<{ code: string; ref?: string }>;
  expectedCaseCount: number | null;
  observedCaseCount: number | null;
  matchedCaseCount: number | null;
}

const keyOf = (value: RecordedPopulationIdentity) => JSON.stringify(value);
const cellOf = (requirementId: string, testLayer: string, role: string) =>
  JSON.stringify([requirementId, testLayer, role]);

/** No observed subset or aggregate pass count can replace the captured denominator. */
export function reconcileDocumentationCaseCoverage(input: unknown): DocumentationCaseCoverageResult {
  const parsed = documentationCaseCoverageInputSchema.safeParse(input);
  if (!parsed.success) return {
    status: 'invalid', reasons: [{ code: 'input_invalid' }],
    expectedCaseCount: null, observedCaseCount: null, matchedCaseCount: null,
  };
  const { capture, executions, causalPairs } = parsed.data;
  const reasons: DocumentationCaseCoverageResult['reasons'] = [];
  const reject = (code: string, ref?: string) => reasons.push({ code, ...(ref ? { ref } : {}) });
  const requirements = new Map(capture.requirements.map(row => [row.requirementId, row]));
  if (requirements.size !== capture.requirements.length) reject('requirement_duplicate');
  for (const row of capture.requirements) {
    if (new Set(row.layers).size !== row.layers.length) reject('requirement_layer_duplicate', row.requirementId);
    if (new Set(row.controlFamilies).size !== row.controlFamilies.length)
      reject('control_family_duplicate', row.requirementId);
  }
  const declared = new Map<string, { row: (typeof capture.declarations)[number]; tag: DocumentationCaseTag }>();
  const cells = new Set<string>();
  for (const row of capture.declarations) {
    const key = keyOf(row.identity);
    if (row.identity[4] !== 'test') reject('declaration_not_test', key);
    const tag = readDocumentationCaseTag(row.identity[2]);
    if (!tag) { reject('case_tags_invalid', key); continue; }
    if (tag.subjectPlan !== capture.subjectPlan) reject('declaration_plan_mismatch', key);
    if (row.source.file !== row.identity[1]) reject('declaration_source_mismatch', key);
    const required = requirements.get(tag.requirementId);
    if (!required || !required.layers.includes(row.testLayer)) reject('declaration_requirement_mismatch', key);
    if (tag.role === 'falsifier' && (!row.controlFamily || !required?.controlFamilies.includes(row.controlFamily)))
      reject('declaration_control_family_mismatch', key);
    if (declared.has(key)) reject('declaration_duplicate', key);
    else declared.set(key, { row, tag });
    cells.add(cellOf(tag.requirementId, row.testLayer, tag.role));
  }
  for (const row of capture.requirements) for (const testLayer of row.layers)
    for (const role of ['baseline', 'falsifier'])
      if (!cells.has(cellOf(row.requirementId, testLayer, role)))
        reject('required_role_missing', cellOf(row.requirementId, testLayer, role));

  const observed = new Map<string, { row: RecordedPopulationCase; testLayer: string }>();
  const runIds = new Set<number>();
  let observedCaseCount = 0;
  for (const execution of executions) {
    if (runIds.has(execution.testRunId)) reject('execution_duplicate', String(execution.testRunId));
    runIds.add(execution.testRunId);
    if (execution.subjectPlan !== capture.subjectPlan || execution.runGroupId !== capture.runGroupId)
      reject('execution_scope_mismatch', String(execution.testRunId));
    if (execution.candidateTreeFingerprint !== capture.candidateTreeFingerprint)
      reject('execution_candidate_mismatch', String(execution.testRunId));
    const population = parseRecordedNativePopulation(execution, {
      testFile: execution.testFile, projectName: execution.projectName,
    });
    if (!population) { reject('execution_population_invalid', String(execution.testRunId)); continue; }
    for (const row of population.cases) {
      observedCaseCount++;
      const key = keyOf(row.identity);
      if (observed.has(key)) reject('case_execution_duplicate', key);
      else observed.set(key, { row, testLayer: execution.testLayer });
      const expected = declared.get(key);
      if (!expected) reject('case_unexpected', key);
      else if (expected.row.testLayer !== execution.testLayer) reject('case_layer_mismatch', key);
      if (!row.selected || row.outcome !== 'passed') reject('case_not_passing', key);
    }
  }
  for (const key of declared.keys()) if (!observed.has(key)) reject('case_missing', key);

  const paired = new Set<string>();
  const coveredFamilies = new Set<string>();
  for (const pair of causalPairs) {
    const baselineKey = keyOf(pair.baseline), falsifierKey = keyOf(pair.falsifier);
    const baseline = declared.get(baselineKey), falsifier = declared.get(falsifierKey);
    for (const key of [baselineKey, falsifierKey]) {
      if (paired.has(key)) reject('causal_pair_duplicate', key);
      paired.add(key);
    }
    if (!baseline || !falsifier) { reject('causal_pair_unresolved', falsifierKey); continue; }
    if (baseline.tag.role !== 'baseline' || falsifier.tag.role !== 'falsifier'
      || baseline.tag.requirementId !== falsifier.tag.requirementId
      || baseline.row.testLayer !== falsifier.row.testLayer
      || falsifier.row.controlFamily !== pair.controlFamily) {
      reject('causal_pair_mismatch', falsifierKey); continue;
    }
    if (pair.predictedReason !== pair.observedReason) {
      reject('causal_reason_mismatch', falsifierKey); continue;
    }
    const results = [observed.get(baselineKey), observed.get(falsifierKey)];
    if (results.some(result => !result || !result.row.selected || result.row.outcome !== 'passed')) {
      reject('causal_pair_unexecuted', falsifierKey); continue;
    }
    coveredFamilies.add(JSON.stringify([falsifier.tag.requirementId, falsifier.row.testLayer, pair.controlFamily]));
  }
  for (const key of declared.keys()) if (!paired.has(key)) reject('case_unpaired', key);
  for (const row of capture.requirements) for (const testLayer of row.layers)
    for (const family of row.controlFamilies) {
      const ref = JSON.stringify([row.requirementId, testLayer, family]);
      if (!coveredFamilies.has(ref)) reject('control_family_missing', ref);
    }
  return {
    status: reasons.length ? 'incomplete' : 'complete', reasons,
    expectedCaseCount: capture.declarations.length, observedCaseCount,
    matchedCaseCount: [...declared.keys()].filter(key => observed.has(key)).length,
  };
}
