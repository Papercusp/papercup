/** Worker-safe native-consult input contract and host adapter seam. */

import { z } from 'zod';
import type { AgentIdentity } from '../coordination/identity';
import { nativeConsultConstraintsSchema } from '../../consult/native-consult';

export const nativeConsultScenarioSchema = nativeConsultConstraintsSchema.extend({
  request_key: z.string().trim().min(1).max(160),
  question: z.string().trim().min(1).max(12000),
  tried: z.string().trim().min(1).max(12000),
  observed: z.string().trim().min(1).max(12000),
  decision_at_stake: z.string().trim().min(1).max(4000),
  subject_ref: z.string().trim().min(1).max(500).optional().describe(
    'Optional exact transcript corpus filter. It is matched against source-turn text before routing; use only a phrase or identifier expected to occur in eligible evidence, not a decision or experiment tag.',
  ),
}).strict();

export type NativeConsultScenario = z.infer<typeof nativeConsultScenarioSchema>;

export type NativeConsultScenarioInput = {
  scenario: NativeConsultScenario;
  identity: AgentIdentity;
  harnessSlug: string;
  workspaceId: string;
  workItemId: string;
};

type NativeConsultScenarioHandler = (input: NativeConsultScenarioInput) => Promise<unknown>;

let hostHandler: NativeConsultScenarioHandler | null = null;

/** Register the host-only acceptance implementation outside worker entry graphs. */
export function registerNativeConsultScenarioHandler(handler: NativeConsultScenarioHandler): void {
  hostHandler = handler;
}

/** Dispatch only after the host tool catalog has loaded its acceptance adapter. */
export async function invokeNativeConsultScenario(input: NativeConsultScenarioInput): Promise<unknown> {
  if (!hostHandler) throw new Error('native_consult_handler_unavailable');
  return hostHandler(input);
}
