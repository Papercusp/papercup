/** Source and contract for revising the existing saved recipe, not another execution engine. */
import type { RecipeBindingSchemaV1, CapabilityManifestV1 } from '../../recipe-contract';

export const ACTIVATION_QUALITY_RECIPE_ID = 'persist-exact-passing-plan-specification-quality';
export const ACTIVATION_QUALITY_BINDINGS: RecipeBindingSchemaV1 = {
  version: 1, additionalProperties: false, properties: {
    harness: { type: 'string', required: true, lifetime: { kind: 'invocation-ephemeral' } },
    plan: { type: 'string', required: true, lifetime: { kind: 'invocation-ephemeral' } },
    expectedSpecSetHash: { type: 'string', lifetime: { kind: 'invocation-ephemeral' } },
  },
};
export const ACTIVATION_QUALITY_CAPABILITIES: CapabilityManifestV1 = {
  version: 1, representation: 'recipe-script', topology: { premises: ['host:same'] },
  requirements: [{ capability: 'tools:plans:evaluate-spec-quality' },
    { capability: 'tools:scorecards:emit' }, { capability: 'tools:scorecards:get' }],
  lifecycle: { allowed: ['foreground', 'background'], default: 'foreground' },
  replay: { class: 'checkpointed', reason: 'Use orchestrate:run durable execution for checkpointed publication. An uncertain emit stops for canonical reconciliation; never blindly retry.' },
  content: { emits: ['text', 'reference', 'replay-state'] },
};

export const ACTIVATION_QUALITY_PUBLICATION_SCRIPT = String.raw`
const quality = await tools.plans.evaluateSpecQuality({
  harness: inputs.harness, slug: inputs.plan, detail: 'full',
  expectedSpecSetHash: inputs.expectedSpecSetHash
});
const draft = quality?.scorecardDraft ?? null;
const specSetHash = quality?.specSetHash ?? null;
if (!quality || quality.ok !== true || quality.verdict !== 'pass' || !draft || !specSetHash ||
    (quality.partial ?? false) || (quality._partial ?? false) || (quality._projection?.truncated ?? false) ||
    (inputs.expectedSpecSetHash && specSetHash !== inputs.expectedSpecSetHash)) {
  return { status: 'evaluation-refused', ready: false, evaluation: quality };
}
// The evaluator owns every rating and evidence byte. targetHive is routing scope.
const emitted = await tools.scorecards.emit({ ...draft, targetHive: inputs.harness });
if (!emitted || emitted.ok !== true) {
  return { status: 'emit-refused', ready: false, specSetHash, receipt: emitted };
}
const completion = emitted.completionReceipt ?? null;
const issueId = emitted.issueId ?? emitted.previousIssueId ?? null;
if (!completion || completion.status !== 'recorded' || !issueId || completion.effectRef !== issueId) {
  return { status: 'needs-reconciliation', ready: false, specSetHash,
    receipt: emitted, nextAction: 'Reconcile this exact emission against canonical scorecards before any retry.' };
}
const observed = await tools.scorecards.get({ issueId });
const card = observed?.scorecard ?? null;
if (!observed || observed.ok !== true || !card || card.issueId !== issueId ||
    card.rubricRef !== draft?.rubricRef ||
    !card.subject || card.subject.ref !== draft?.subject?.ref) {
  return { status: 'needs-reconciliation', ready: false, specSetHash,
    receipt: emitted, observation: observed,
    nextAction: 'Resolve the exact recorded card; do not emit a replacement merely because readback is unavailable.' };
}
const auditState = card.gradingAudit ? card.gradingAudit.state : 'unknown';
return { status: auditState === 'pending' ? 'emitted-pending' : 'emitted', ready: false,
  specSetHash, subject: draft?.subject,
  evidenceFingerprint: card.evidenceFingerprint, issueId, receipt: emitted,
  auditState, auditCurrentness: card.gradingAuditCurrentness || null,
  nextAction: 'An emitted card is not plan readiness. Settle independent grading integrity, then use canonical plans:start and execution guards.' };
`;
