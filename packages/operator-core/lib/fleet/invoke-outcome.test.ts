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

  it('ran=true leaves failureClass undefined', () => {
    const r = agentProducedTurn(JSON.stringify({ ok: true, agentOutput: 'NEXT_WORKER' }), 'h/w');
    expect(r.ran).toBe(true);
    expect(r.failureClass).toBeUndefined();
  });
});

// P-006/H13 — a mid-turn capacity shed (the all-accounts gateway 429 storm) was being
// mislabeled infra_loss / "host dead/unstable", sending debuggers hunting a phantom host
// bug. It is now classified capacity_shed (retryable) iff BOTH the clean-mid-turn-exit
// fingerprint AND the live gateway-throttled corroboration hold.
describe('agentProducedTurn — capacity_shed vs infra_loss classification (P-006/H13)', () => {
  // The death fingerprint: exit 1, empty stderr, no timeout (1st gateway call produced
  // output, the 2nd hit the storm and the process exited 1 cleanly).
  const shedBody = JSON.stringify({ ok: false, exitCode: 1, timedOut: false, stderr: '', agentOutput: 'I will check…' });

  it('capacity_shed when the fingerprint holds AND the gateway was wholesale-throttled', () => {
    const r = agentProducedTurn(shedBody, 'h/queen', { gatewayThrottled: true });
    expect(r.ran).toBe(false);
    expect(r.failureClass).toBe('capacity_shed');
    expect(r.detail).toContain('capacity_shed');
    expect(r.detail).toContain('RETRYABLE');
    expect(r.detail).not.toContain('host dead');
    expect(r.detail).toContain('h/queen');
  });

  it('infra_loss (legacy) when the fingerprint holds but the gateway was NOT throttled', () => {
    const r = agentProducedTurn(shedBody, 'h/queen', { gatewayThrottled: false });
    expect(r.ran).toBe(false);
    expect(r.failureClass).toBe('infra_loss');
    expect(r.detail).toContain('produced no turn');
  });

  it('infra_loss when gatewayThrottled is omitted (conservative default — never flip on uncertainty)', () => {
    const r = agentProducedTurn(shedBody, 'h/queen');
    expect(r.failureClass).toBe('infra_loss');
  });

  it('infra_loss when the gateway was throttled but stderr is NON-empty (a real crash trail)', () => {
    const body = JSON.stringify({ ok: false, exitCode: 1, timedOut: false, stderr: 'Segmentation fault', agentOutput: '' });
    const r = agentProducedTurn(body, 'h/queen', { gatewayThrottled: true });
    expect(r.failureClass).toBe('infra_loss');
  });

  it('infra_loss when the gateway was throttled but the run TIMED OUT (not a clean mid-turn exit)', () => {
    const body = JSON.stringify({ ok: false, exitCode: 1, timedOut: true, stderr: '', agentOutput: '' });
    const r = agentProducedTurn(body, 'h/queen', { gatewayThrottled: true });
    expect(r.failureClass).toBe('infra_loss');
  });

  it('infra_loss when the gateway was throttled but exitCode is not 1 (signal kill / null)', () => {
    const body = JSON.stringify({ ok: false, exitCode: null, timedOut: false, stderr: '', agentOutput: '' });
    const r = agentProducedTurn(body, 'h/queen', { gatewayThrottled: true });
    expect(r.failureClass).toBe('infra_loss');
  });
});
