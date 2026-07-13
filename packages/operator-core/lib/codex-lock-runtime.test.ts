import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { codexLockOwnerMarkerName, readCodexLockRuntimeVerdict } from './codex-lock-runtime';

const dirs: string[] = [];
const owner = 'su-test:owner';
function temp(): string {
  const dir = mkdtempSync(join(tmpdir(), 'codex-lock-runtime-'));
  dirs.push(dir);
  mkdirSync(dir, { recursive: true });
  return dir;
}
function marker(dir: string, kind: 'decision' | 'success' | 'error', value: object) {
  writeFileSync(join(dir, codexLockOwnerMarkerName(owner, kind)), JSON.stringify(value));
}
afterEach(() => dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })));

describe('readCodexLockRuntimeVerdict', () => {
  it('fails closed to manual when hooks are missing', () => {
    expect(readCodexLockRuntimeVerdict({ ownerId: owner, hooksConfigured: false, cacheDir: temp() })).toMatchObject({
      lockMode: 'manual',
      hookHealth: 'missing',
      runtimeProbed: false,
    });
  });

  it('treats configured-without-owner-proof as manual', () => {
    expect(readCodexLockRuntimeVerdict({ ownerId: owner, hooksConfigured: true, cacheDir: temp() })).toMatchObject({
      lockMode: 'manual',
      hookHealth: 'configured-unverified',
    });
  });

  it('selects automatic only for a fresh owner-scoped decision and success', () => {
    const dir = temp();
    marker(dir, 'decision', { ts: '2026-07-13T20:00:00Z', owner, decision: 'granted' });
    marker(dir, 'success', { ts: '2026-07-13T20:00:01Z', owner });
    expect(
      readCodexLockRuntimeVerdict({
        ownerId: owner,
        hooksConfigured: true,
        cacheDir: dir,
        nowMs: Date.parse('2026-07-13T20:01:00Z'),
      }),
    ).toMatchObject({
      lockMode: 'automatic',
      hookHealth: 'verified',
      runtimeProbed: true,
      effectiveInstruction: expect.stringContaining('verified PreToolUse hook'),
    });
  });

  it('returns manual when a later owner-scoped error supersedes success', () => {
    const dir = temp();
    marker(dir, 'decision', { ts: '2026-07-13T20:00:00Z', owner, decision: 'granted' });
    marker(dir, 'success', { ts: '2026-07-13T20:00:01Z', owner });
    marker(dir, 'error', { ts: '2026-07-13T20:00:02Z', owner, detail: 'offline' });
    expect(readCodexLockRuntimeVerdict({ ownerId: owner, hooksConfigured: true, cacheDir: dir })).toMatchObject({
      lockMode: 'manual',
      hookHealth: 'unhealthy',
    });
  });

  it('does not accept a decision written for a different owner', () => {
    const dir = temp();
    marker(dir, 'decision', { ts: '2026-07-13T20:00:00Z', owner: 'su-peer', decision: 'granted' });
    marker(dir, 'success', { ts: '2026-07-13T20:00:01Z', owner: 'su-peer' });
    expect(readCodexLockRuntimeVerdict({ ownerId: owner, hooksConfigured: true, cacheDir: dir })).toMatchObject({
      lockMode: 'manual',
      hookHealth: 'configured-unverified',
    });
  });
});
