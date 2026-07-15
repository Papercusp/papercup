import { describe, expect, it } from 'vitest';
import { renderPortableTurns, renderSessionPortSeed } from './render';
import type { PortableTurn } from './types';

describe('session-port renderer', () => {
  it('renders tool objects as inert text and never emits executable objects', () => {
    const turns: PortableTurn[] = [{
      id: 'a', parentId: null, role: 'assistant', timestamp: null,
      blocks: [{ type: 'tool_call', id: 'call-1', name: 'Bash', input: { command: 'rm -rf /' } }],
    }];
    const rendered = renderPortableTurns(turns);
    expect(rendered.text).toContain('[tool call: Bash]');
    const seed = renderSessionPortSeed({
      portId: 'p1', sourceBackend: 'claude', targetBackend: 'codex', fidelity: 'full', transcript: rendered.text,
    });
    expect(seed.seed.startsWith('[PAPERCUSP SESSION PORT')).toBe(true);
    expect(seed.seed).toContain('fresh session identity');
    expect(seed.seed).toContain(seed.hash);
  });
});
