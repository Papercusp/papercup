/** Native acceptance uses the serving operator's corpus and configured accounts. */
import type { AgentIdentity } from '../coordination/identity';
import { acceptFeedbackRequestProd } from '../../consult/get-feedback-prod';
import type { readHeldWorkItems } from '../../carry-brief';
import {
  nativeConsultScenarioSchema,
  registerNativeConsultScenarioHandler,
  type NativeConsultScenario,
} from './native-consult-contract';

export { nativeConsultScenarioSchema } from './native-consult-contract';
export type { NativeConsultScenario } from './native-consult-contract';

// carry-brief reaches the testing registry; load it after schema initialization.
const readHeldWorkItemsProd: typeof readHeldWorkItems = async (...args) => {
  const { readHeldWorkItems } = await import('../../carry-brief');
  return readHeldWorkItems(...args);
};

export async function acceptNativeConsultScenario(input: {
  scenario: NativeConsultScenario; identity: AgentIdentity; harnessSlug: string;
  workspaceId: string; workItemId: string;
}, deps = { readHeldWorkItems: readHeldWorkItemsProd, accept: acceptFeedbackRequestProd }) {
  // Native agent resources require a measured hold; unreadable claims refuse.
  const held = await deps.readHeldWorkItems(input.identity.ownerId, input.workspaceId, { limit: 200 });
  if (!held.some(item => item.id === input.workItemId)) {
    return { ok: false, mode: 'native-consult', error: 'work_item_not_held' };
  }
  const { scenario } = input;
  const constraints = { sourceBackend: scenario.sourceBackend, targetBackend: scenario.targetBackend, sourceState: scenario.sourceState,
    ...(scenario.requireSourcePlanClaims === undefined ? {} : { requireSourcePlanClaims: scenario.requireSourcePlanClaims }) };
  const accepted = await deps.accept({
    workspaceId: input.workspaceId, requesterId: input.identity.ownerId,
    requestKey: scenario.request_key, question: scenario.question,
    tried: scenario.tried, observed: scenario.observed, decisionAtStake: scenario.decision_at_stake,
    subjectRef: scenario.subject_ref, originTaskRef: input.workItemId, harnessSlug: input.harnessSlug,
    nativeConsult: constraints, archiveFloor: 2, latencyContract: 'proceed',
  }, input.identity, { harnessSlug: input.harnessSlug, allowDispatch: true });
  // Acceptance is not a native receipt or an answer; there are no pass counts.
  return { ok: !('error' in accepted), mode: 'native-consult', workItemId: input.workItemId,
    evidencePlane: 'serving-operator', constraints, accepted };
}

registerNativeConsultScenarioHandler(acceptNativeConsultScenario);
