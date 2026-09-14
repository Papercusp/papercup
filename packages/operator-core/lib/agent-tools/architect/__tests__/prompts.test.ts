import { describe, expect, it, vi } from 'vitest';

vi.mock('../../../harness-registry', () => ({}));
vi.mock('../../../harness-core', () => ({
  harnessDir: () => '/tmp/architect-prompt-test',
  safeRead: () => null,
  parseFeatures: async () => [],
  resolvePhasedProject: async () => null,
}));
vi.mock('../../../harness-phases', () => ({
  phasePhaseLabel: (phase: string | undefined) => phase ?? 'staging',
}));
vi.mock('../../../memory/injection', () => ({
  buildMemoryContextBlock: async () => null,
}));
vi.mock('../../../workspace-registry', () => ({ activeWorkspaceId: () => 'test-workspace' }));

import { composeArchitectPrompt } from '../prompts';

describe('composeArchitectPrompt plan proposal format', () => {
  it('emits item lines accepted by the live plan parser', async () => {
    const prompt = await composeArchitectPrompt(
      { slug: 'prompt-test' } as Parameters<typeof composeArchitectPrompt>[0],
      [],
      'draft a plan',
    );

    expect(prompt).toContain('- **P-001** `todo` <Concrete work item — imperative, testable, one sentence>');
    expect(prompt).toContain('- **P-002** `todo` <Next item>');
    expect(prompt).toContain('- **P-003** `todo` <…>');
    expect(prompt).toContain('Plan items must use the parser grammar');
    expect(prompt).not.toContain('- [ ] P-001');
    expect(prompt).not.toContain('- [ ] P-002');
    expect(prompt).not.toContain('- [ ] P-003');
  });
});
