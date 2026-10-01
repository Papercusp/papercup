/**
 * P-010's shared presentation vocabulary. This leaf is client-safe: the intake
 * classifier imports node:crypto, while fleet metric parsers and UI need only
 * these stage keys and labels. Acceptance remains owned by agent-review-policy.
 */
export const WORK_ITEM_PRESENTATION_STAGES = [
  'observation', 'candidate', 'accepted-ready', 'accepted-active',
  'accepted-blocked', 'verified-completion', 'terminal-other', 'unknown',
] as const;
export type WorkItemPresentationStage = (typeof WORK_ITEM_PRESENTATION_STAGES)[number];

export const WORK_ITEM_PRESENTATION_LABELS: Record<WorkItemPresentationStage, string> = {
  observation: 'Observation evidence',
  candidate: 'Candidates awaiting decision or revision',
  'accepted-ready': 'Accepted ready work',
  'accepted-active': 'Active accepted work',
  'accepted-blocked': 'Blocked accepted work',
  'verified-completion': 'Verified accepted completions',
  'terminal-other': 'Other terminal history',
  unknown: 'Unknown legacy or malformed readiness',
};
