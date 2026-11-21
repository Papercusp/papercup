export interface NativePlanEdit {
  scenario: 'citation' | 'cosmetic' | 'resumed' | 'material';
  heading: string;
  originalText: string;
  replacementText: string;
}

export const citationEdit: NativePlanEdit = {
  scenario: 'citation',
  heading: 'Reference',
  originalText: 'packages/operator-core/lib/plan-efficiency.ts:1',
  replacementText: 'packages/operator-core/lib/plan-efficiency.ts:2',
};

export const nativePlanEdits: readonly NativePlanEdit[] = [
  citationEdit,
  {
    scenario: 'cosmetic',
    heading: 'Reference note',
    originalText: 'See the reference below',
    replacementText: 'See the reference below.',
  },
  {
    scenario: 'resumed',
    heading: 'Reference',
    originalText: 'packages/operator-core/lib/plan-efficiency.ts:2',
    replacementText: 'packages/operator-core/lib/plan-efficiency.ts:3',
  },
  {
    scenario: 'material',
    heading: 'Acceptance requirement',
    originalText: 'Complete the verification within one minute.',
    replacementText: 'Complete the verification within five minutes.',
  },
];

// Each separately seeded plan exercises the same three native client roles.
const nativePlanEditTimeoutMs = 360_000;
export const nativePlanComparisonTimeoutMs = nativePlanEdits.length * nativePlanEditTimeoutMs;
