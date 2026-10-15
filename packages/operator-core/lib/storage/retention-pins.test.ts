import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { isLeaseLive, readRetentionLeases } from '../release-cut-reclaim';
import { createRetentionPin, pinProtectsPath, readRetentionPins, removeRetentionPin } from './retention-pins';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'retention-pin-')); roots.push(root);
  const dir = join(root, 'leases'); const target = join(root, 'agent-output'); mkdirSync(target);
  const nowMs = Date.UTC(2026, 9, 15);
  return { root, dir, target, nowMs, expiresAt: new Date(nowMs + 3600_000).toISOString() };
}

describe('agent retention pins in the existing lease store', () => {
  it('round-trips owner, reason and finite expiry while existing deleters recognize the same lease', () => {
    const f = fixture();
    const pin = createRetentionPin({ path: f.target, owner: 'agent-a', reason: 'Avi’s review\nretain evidence', expiresAt: f.expiresAt }, f);
    expect(readRetentionPins(f)).toEqual({ pins: [pin], errors: [] });
    const leases = readRetentionLeases(f.dir);
    expect(leases.errors).toEqual([]); expect(leases.leases).toHaveLength(1);
    expect(isLeaseLive(leases.leases[0]!, f.nowMs)).toBe(true);
    expect(leases.leases[0]!.paths).toEqual([f.target]);
    expect(readdirSync(f.dir)).toEqual([`lease-agent-pin-${pin.id}.tsv`]);
  });

  it('protects ancestors and descendants, with no sibling-prefix collision, and stops exactly at expiry', () => {
    const f = fixture(); const pin = createRetentionPin({ path: f.target, owner: 'a', reason: 'review', expiresAt: f.expiresAt }, f);
    expect(pinProtectsPath(join(f.target, 'report.json'), [pin], f.nowMs)).toBe(true);
    expect(pinProtectsPath(f.root, [pin], f.nowMs)).toBe(true);
    expect(pinProtectsPath(`${f.target}-other`, [pin], f.nowMs)).toBe(false);
    expect(pinProtectsPath(f.target, [pin], Date.parse(f.expiresAt))).toBe(false);
    expect(readRetentionPins({ ...f, nowMs: Date.parse(f.expiresAt) }).pins).toEqual([]);
    expect(readRetentionPins({ ...f, nowMs: Date.parse(f.expiresAt), includeExpired: true }).pins).toEqual([pin]);
  });

  it('protects both the logical alias and the physical offloaded path', () => {
    const f = fixture(); const alias = join(f.root, 'alias'); symlinkSync(f.target, alias);
    const pin = createRetentionPin({ path: alias, owner: 'a', reason: 'offloaded evidence', expiresAt: f.expiresAt }, f);
    expect(pin.paths).toEqual([alias, f.target]);
    expect(pinProtectsPath(join(alias, 'x'), [pin], f.nowMs)).toBe(true);
    expect(pinProtectsPath(join(f.target, 'x'), [pin], f.nowMs)).toBe(true);
  });

  it('refuses missing paths, nonfinite/past expiries and newline injection without creating a lease', () => {
    const f = fixture(); const base = { path: f.target, owner: 'a', reason: 'review', expiresAt: f.expiresAt };
    for (const input of [{ ...base, path: join(f.root, 'missing') }, { ...base, path: `${f.target}\npath=/` },
      { ...base, expiresAt: 'never' }, { ...base, expiresAt: new Date(f.nowMs).toISOString() }, { ...base, reason: ' ' }]) {
      expect(() => createRetentionPin(input, f)).toThrow();
    }
    expect(readRetentionPins(f)).toEqual({ pins: [], errors: [] });
  });

  it('reports corrupt pin metadata instead of silently dropping protection', () => {
    const f = fixture(); const pin = createRetentionPin({ path: f.target, owner: 'a', reason: 'review', expiresAt: f.expiresAt }, f);
    const file = join(f.dir, `lease-agent-pin-${pin.id}.tsv`);
    writeFileSync(file, readFileSync(file, 'utf8').replace(/^tag=.*$/m, 'tag=agent-pin-invalid'));
    expect(readRetentionPins(f).errors).toHaveLength(1);
    // The existing lease reader still protects its path: damaged descriptive metadata cannot enable deletion.
    expect(readRetentionLeases(f.dir).leases[0]!.paths).toEqual([f.target]);
  });

  it('permits only the pin owner to release an exact id', () => {
    const f = fixture(); const pin = createRetentionPin({ path: f.target, owner: 'agent-a', reason: 'review', expiresAt: f.expiresAt }, f);
    expect(() => removeRetentionPin(pin.id, 'agent-b', f)).toThrow(/only the pin owner/);
    expect(readRetentionPins(f).pins).toEqual([pin]);
    expect(removeRetentionPin(pin.id, 'agent-a', f)).toBe(true);
    expect(removeRetentionPin(pin.id, 'agent-a', f)).toBe(false);
    expect(readRetentionPins(f)).toEqual({ pins: [], errors: [] });
  });
});
