import { dreamEvaluationProtocolHash, DreamEvaluationProtocolSchema, DreamPilotPinSchema, type DreamEvaluationArm, type DreamPilotPin } from '../../dream/dream-evaluation.ts';
import type { Sql } from 'postgres';
import { sumBlenderTicks, type BlenderTick } from './blender-guard.mts';

// These are blocks of ONE finite study. Changing model never resets admission.
export const STUDY_BLOCKS = {
  haiku: { file: 'protocol.json', pin: '23b3288077d2751dc57a1eeebe8f373809154e86e2a882302546a8100ed0b408' },
  luna: { file: 'protocol-luna.json', pin: '29a0a6e4914c26e79b13fbb561373596b18aca44966ab733feb72ac660ee7ddf' },
} as const;
export interface StudyBlock { protocol: unknown; pin: string }
export interface StudyTotal { pin: string; arm: DreamEvaluationArm; attempts: number; cost: number; graphTreatment?: 'graph' | 'control' | null }

function studyPins(blocks?: readonly StudyBlock[]) {
  if (blocks) validateStudyBlocks(blocks);
  return blocks ? blocks.map(block => block.pin) : Object.values(STUDY_BLOCKS).map(block => block.pin);
}

/** Read the existing production ledgers; a model block or entrypoint never resets the study. */
export async function readStudyTotals(sql: Sql, workspaceId: string, blocks?: readonly StudyBlock[]): Promise<StudyTotal[]> {
  const pins = studyPins(blocks);
  const dreams = await sql<StudyTotal[]>`
    SELECT outcome->'capabilityRun'->'evaluation'->>'protocolPin' AS pin,
           outcome->'capabilityRun'->'evaluation'->>'arm' AS arm,
           outcome->'capabilityRun'->'evaluation'->>'graphTreatment' AS "graphTreatment",
           COUNT(*)::int AS attempts,
           SUM(cost_usd + COALESCE((
             SELECT SUM(CASE WHEN call->>'status' = 'settled'
                              AND call->>'model' NOT LIKE 'local:%'
                              AND (call->'usage'->>'costUsd')::float8 = 0
                              AND COALESCE((call->'usage'->>'inputTokens')::bigint, 0) + COALESCE((call->'usage'->>'outputTokens')::bigint, 0) > 0
                             THEN (call->>'reservedUsd')::float8 ELSE 0 END)
             FROM jsonb_array_elements(outcome->'capabilityRun'->'calls') AS call
           ), 0))::float8 AS cost
      FROM harness_shared.dream_runs
     WHERE workspace_id = ${workspaceId} AND pot_slug = 'papercusp'
       AND outcome->'capabilityRun'->'evaluation'->>'protocolPin' = ANY(${pins}::text[])
     GROUP BY 1, 2, 3`;
  const blender = await sql<BlenderTick[]>`
    SELECT detail->'study'->>'cycleId' AS "cycleId", detail->'study'->>'protocolPin' AS pin,
           (detail->'study'->>'reservedUsd')::float8 AS "reservedUsd",
           COALESCE((detail->'study'->>'settled')::boolean, false) AS settled,
           (detail->'study'->>'costUsd')::float8 AS "costUsd"
      FROM harness_shared.scout_ticks
     WHERE workspace_id = ${workspaceId}
       AND detail->'study'->>'protocolPin' = ANY(${pins}::text[])
       AND detail->'study'->>'arm' = 'blender'`;
  return [...dreams, ...sumBlenderTicks(blender)];
}

export function validateStudyBlocks(blocks: readonly StudyBlock[]) {
  const expected = Object.values(STUDY_BLOCKS).map(b => b.pin);
  if (blocks.length < expected.length || new Set(blocks.map(b => b.pin)).size !== blocks.length ||
      expected.some(pin => !blocks.some(block => block.pin === pin)))
    throw new Error('Study accounting must retain every historical block');
  const limits = DreamEvaluationProtocolSchema.parse(blocks.find(block => block.pin === STUDY_BLOCKS.haiku.pin)!.protocol).limits;
  for (const block of blocks) {
    if (dreamEvaluationProtocolHash(block.protocol) !== block.pin)
      throw new Error('Study protocol hash changed');
    const protocol = DreamEvaluationProtocolSchema.parse(block.protocol);
    if (!expected.includes(block.pin as typeof expected[number]) &&
        (!protocol.comparison?.graphAblation || JSON.stringify(protocol.limits) !== JSON.stringify(limits)))
      throw new Error('New graph comparison must preserve the cumulative study limits');
  }
  return limits;
}

export function requireStudyRoom(rows: StudyTotal[], arm: DreamEvaluationArm, limits: ReturnType<typeof validateStudyBlocks>,
  options?: { blocks: readonly StudyBlock[]; pilot?: DreamPilotPin }) {
  const pins = studyPins(options?.blocks);
  if (options && JSON.stringify(validateStudyBlocks(options.blocks)) !== JSON.stringify(limits))
    throw new Error('Cumulative study limits changed');
  const nativeBlocks = new Map((options?.blocks ?? []).filter(block =>
    !Object.values(STUDY_BLOCKS).some(historical => historical.pin === block.pin))
    .map(block => [block.pin, DreamEvaluationProtocolSchema.parse(block.protocol)]));
  const seen = new Set<string>();
  let attempts = 0, cost = 0, armAttempts = 0, armCost = 0;
  for (const row of rows) {
    const native = nativeBlocks.has(row.pin);
    const key = row.pin + ':' + row.arm + ':' + (row.graphTreatment ?? 'legacy');
    if (!pins.includes(row.pin) || !['blender', 'uniform-pair', 'structured-pair', 'structured-triple'].includes(row.arm) ||
        (native ? row.arm !== 'structured-pair' || !['graph', 'control'].includes(row.graphTreatment ?? '') : row.graphTreatment != null) ||
        !Number.isInteger(row.attempts) || row.attempts < 1 || typeof row.cost !== 'number' || !Number.isFinite(row.cost) || row.cost < 0 ||
        seen.has(key)) throw new Error('Invalid cumulative study accounting');
    seen.add(key);
    attempts += row.attempts;
    cost += row.cost; // dream_runs.cost_usd includes conservative unknown reservations.
    if (row.arm === arm) { armAttempts += row.attempts; armCost += row.cost; }
  }
  if (attempts >= limits.attempts || armAttempts >= limits.attemptsPerArm ||
      cost + limits.cycleUsd > limits.discoveryUsd || armCost + limits.cycleUsd > limits.discoveryUsdPerArm)
    throw new Error('Cumulative study attempt or conservative monetary admission cap reached');
  if (!options?.pilot) {
    if (nativeBlocks.size) throw new Error('Graph study admission requires its registered treatment pin');
    return { attempts, accountedUsd: cost, armAttempts, armAccountedUsd: armCost };
  }
  const pilot = DreamPilotPinSchema.parse(options.pilot);
  const protocol = nativeBlocks.get(pilot.pin);
  if (!protocol || dreamEvaluationProtocolHash(pilot.protocol) !== pilot.pin || pilot.arm !== arm ||
      arm !== 'structured-pair' || !pilot.graphTreatment)
    throw new Error('Graph study admission requires its registered treatment pin');
  const ablation = protocol.comparison!.graphAblation!;
  const treatment = rows.find(row => row.pin === pilot.pin && row.graphTreatment === pilot.graphTreatment);
  const treatmentAttempts = treatment?.attempts ?? 0, treatmentCost = treatment?.cost ?? 0;
  if (treatmentAttempts >= ablation.attemptsPerTreatment || treatmentCost + limits.cycleUsd > ablation.usdPerTreatment)
    throw new Error('Graph study treatment attempt or conservative monetary admission cap reached');
  if (pilot.matchedPairIndex !== treatmentAttempts)
    throw new Error('Graph study matched assignment does not follow its recorded attempts');
  return { attempts, accountedUsd: cost, armAttempts, armAccountedUsd: armCost,
    treatmentAttempts, treatmentAccountedUsd: treatmentCost };
}
