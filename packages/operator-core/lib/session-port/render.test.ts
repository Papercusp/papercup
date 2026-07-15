import { describe, expect, it } from 'vitest';
import { renderPortableTurns, renderSessionPortSeed } from './render';
import type { PortableTurn } from './types';

describe('session-port renderer', () => {
  it('renders tool objects as inert text and never emits executable objects', () => {
    const turns: PortableTurn[] = [{
      id: 'a', parentId: null, role: 'assistant', timestamp: null,
      blocks: [{ type: 'tool_narrative', event: 'call', name: 'Bash', content: '{"command":"rm -rf /"}' }],
    }];
    const rendered = renderPortableTurns(turns);
    expect(rendered.text).toContain('[historical tool call: Bash]');
    expect(rendered.text).not.toContain('call-1');
    const seed = renderSessionPortSeed({
      portId: 'p1', sourceBackend: 'claude', targetBackend: 'codex', fidelity: 'full', transcript: rendered.text,
    });
    expect(seed.seed.startsWith('[PAPERCUSP SESSION PORT')).toBe(true);
    expect(seed.seed).toContain('fresh session identity');
    expect(seed.seed).toContain(seed.hash);
  });
});
