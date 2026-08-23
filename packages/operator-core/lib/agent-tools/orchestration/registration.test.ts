import { describe, expect, it } from 'vitest';
import { listAllProjectedTools } from '@papercusp/agent-mcp';

// A tool module that is not imported from the full agent-tools registry is
// invisible on every projected surface even when its focused handler tests pass.
import '../index';

const findTool = (name: string) => {
  const tool = listAllProjectedTools().find((candidate) => candidate.expose.mcp?.name === name);
  if (!tool) throw new Error(`${name} is not registered through agent-tools/index.ts`);
  return tool;
};

describe('orchestrate:* registry and migration guidance', () => {
  it('registers the complete preferred model-facing suite through the full registry', () => {
    for (const name of ['orchestrate:search', 'orchestrate:inspect', 'orchestrate:run']) {
      expect(findTool(name).agentRoles?.length ?? 0).toBeGreaterThan(0);
    }
  });

  it('steers discovery through one search → inspect → run chain', () => {
    const search = findTool('orchestrate:search');
    const inspect = findTool('orchestrate:inspect');
    const run = findTool('orchestrate:run');

    expect(search.description).toContain('Preferred');
    expect(search.guidance?.when).toContain('Before authoring');
    expect(search.guidance?.chaining).toContain('orchestrate:inspect');
    expect(inspect.guidance?.chaining).toContain('orchestrate:run');
    expect(run.description).toContain('Preferred');
  });

  it('keeps direct execution doors discoverable as compatibility surfaces', () => {
    const seeAlso = findTool('orchestrate:run').guidance?.seeAlso ?? [];

    expect(seeAlso).toContain('code:run (compatibility door)');
    expect(seeAlso).toContain('recipes:run (compatibility door)');
    expect(findTool('code:run')).toBeTruthy();
    expect(findTool('recipes:run')).toBeTruthy();
  });
});
