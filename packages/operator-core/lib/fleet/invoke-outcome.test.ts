import { describe, it, expect } from 'vitest';
import { agentProducedTurn } from './invoke-outcome';

describe('agentProducedTurn — the shared no-turn rule (docs-audit #1)', () => {
  it('ran=true when ok:true and agentOutput is non-empty', () => {
    const r = agentProducedTurn(JSON.stringify({ ok: true, agentOutput: 'NEXT_WORKER chunk-1' }), 'h/worker');
    expect(r.ran).toBe(true);
    expect(r.detail).toBe('');
  });

  it('ran=false when ok:false (the agent reported failure)', () => {
    const r = agentProducedTurn(JSON.stringify({ ok: false, exitCode: 1, agentOutput: '' }), 'h/queen');
    expect(r.ran).toBe(false);
    expect(r.detail).toContain('produced no turn');
    expect(r.detail).toContain('h/queen');
  });

  it('ran=false when ok:true but output is EMPTY (0-token wake) — the silent-swallow case', () => {
    const r = agentProducedTurn(JSON.stringify({ ok: true, agentOutput: '   ' }), 'h/doc-steward');
    expect(r.ran).toBe(false);
    expect(r.detail).toContain('h/doc-steward');
    expect(r.detail).toContain('outLen=0');
  });

  it('falls back to stdout when agentOutput is absent', () => {
    expect(agentProducedTurn(JSON.stringify({ ok: true, stdout: 'done' }), 'h/r').ran).toBe(true);
    expect(agentProducedTurn(JSON.stringify({ ok: true, stdout: '' }), 'h/r').ran).toBe(false);
  });

  // Never flip a spawn to failed on uncertainty — the most load-bearing path.
  it('ran=true (assume done) on an unreadable/empty body', () => {
    expect(agentProducedTurn('', 'h/r').ran).toBe(true);
  });

  it('ran=true (assume done) on an unparseable body', () => {
    expect(agentProducedTurn('not json {{{', 'h/r').ran).toBe(true);
  });

  it('ran=true (assume done) on a non-invoke-result body (no boolean ok)', () => {
    expect(agentProducedTurn(JSON.stringify({ message: 'queued' }), 'h/r').ran).toBe(true);
  });
});
