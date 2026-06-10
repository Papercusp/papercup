/**
 * claude-credential-sync.test.ts — the newest-wins credential reconciler
 * (claude-credential-sync-2026-06-10 P-001).
 *
 * The contract: every real-file `.credentials.json` (global + per-session
 * forks) converges on the newest valid `claudeAiOauth` bundle; symlink aliases
 * are untouched; `mcpOAuth` stays per-file; implausible or refresh-less
 * bundles never win; a converged tree produces zero writes.
 */
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { reconcileClaudeCredentials } from './claude-credential-sync';

const NOW = 1_780_000_000_000;
const HOUR = 60 * 60 * 1000;

let home: string;
let sessionRoot: string;

function bundle(expiresAt: number, tag: string, extra: Record<string, unknown> = {}) {
  return {
    accessToken: `sk-ant-oat01-${tag}`,
    refreshToken: `sk-ant-ort01-${tag}`,
    expiresAt,
    scopes: ['user:inference'],
    subscriptionType: 'max',
    ...extra,
  };
}

function writeCreds(path: string, json: unknown) {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, JSON.stringify(json, null, 2), { mode: 0o600 });
}

function globalPath() {
  return join(home, '.claude', '.credentials.json');
}

function sessionPath(id: string) {
  return join(sessionRoot, id, '.credentials.json');
}

function readJson(path: string): Record<string, any> {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function run() {
  return reconcileClaudeCredentials({ home, sessionRoot, now: NOW });
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'credsync-home-'));
  sessionRoot = mkdtempSync(join(tmpdir(), 'credsync-sessions-'));
  mkdirSync(join(home, '.claude'), { recursive: true });
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  rmSync(sessionRoot, { recursive: true, force: true });
});

describe('reconcileClaudeCredentials', () => {
  it('propagates the newest session bundle to the global file and stale forks', () => {
    writeCreds(globalPath(), { claudeAiOauth: bundle(NOW + 1 * HOUR, 'old'), mcpOAuth: { g: 1 } });
    writeCreds(sessionPath('su-stale'), { claudeAiOauth: bundle(NOW + 2 * HOUR, 'mid'), mcpOAuth: { s: 2 } });
    writeCreds(sessionPath('su-fresh'), { claudeAiOauth: bundle(NOW + 8 * HOUR, 'new') });

    const r = run();

    expect(r.winner?.path).toBe(sessionPath('su-fresh'));
    expect(r.updated.sort()).toEqual([globalPath(), sessionPath('su-stale')].sort());
    expect(readJson(globalPath()).claudeAiOauth.accessToken).toBe('sk-ant-oat01-new');
    expect(readJson(sessionPath('su-stale')).claudeAiOauth.accessToken).toBe('sk-ant-oat01-new');
    // mcpOAuth (and any sibling keys) stay per-file.
    expect(readJson(globalPath()).mcpOAuth).toEqual({ g: 1 });
    expect(readJson(sessionPath('su-stale')).mcpOAuth).toEqual({ s: 2 });
    // The winner itself is never rewritten.
    expect(readJson(sessionPath('su-fresh')).accessToken).toBeUndefined();
    // Atomic writes keep credentials private.
    expect(statSync(globalPath()).mode & 0o777).toBe(0o600);
  });

  it('is idempotent: a converged tree produces zero writes', () => {
    writeCreds(globalPath(), { claudeAiOauth: bundle(NOW + 8 * HOUR, 'new') });
    writeCreds(sessionPath('su-a'), { claudeAiOauth: bundle(NOW + 1 * HOUR, 'old') });

    expect(run().updated).toEqual([sessionPath('su-a')]);
    expect(run().updated).toEqual([]);
  });

  it('skips symlinked session entries (they alias the global file)', () => {
    writeCreds(globalPath(), { claudeAiOauth: bundle(NOW + 1 * HOUR, 'old') });
    mkdirSync(join(sessionRoot, 'su-linked'), { recursive: true });
    symlinkSync(globalPath(), sessionPath('su-linked'));
    writeCreds(sessionPath('su-fresh'), { claudeAiOauth: bundle(NOW + 8 * HOUR, 'new') });

    const r = run();

    expect(lstatSync(sessionPath('su-linked')).isSymbolicLink()).toBe(true);
    expect(r.updated).toEqual([globalPath()]);
    // The alias sees the propagated bundle THROUGH the global file.
    expect(readJson(sessionPath('su-linked')).claudeAiOauth.accessToken).toBe('sk-ant-oat01-new');
  });

  it('never lets invalid bundles win: no refreshToken, implausible expiry, garbage', () => {
    writeCreds(globalPath(), { claudeAiOauth: bundle(NOW + 1 * HOUR, 'real') });
    // A setup-token-shaped bundle (no refreshToken) with a 1-year expiry.
    writeCreds(sessionPath('su-setup'), {
      claudeAiOauth: { ...bundle(NOW + 365 * 24 * HOUR, 'setup'), refreshToken: undefined },
    });
    // Forged absurd-future expiry.
    writeCreds(sessionPath('su-forged'), { claudeAiOauth: bundle(NOW + 60 * 24 * HOUR, 'forged') });
    // Corrupt JSON (half-written file).
    mkdirSync(join(sessionRoot, 'su-corrupt'), { recursive: true });
    writeFileSync(sessionPath('su-corrupt'), '{"claudeAiOauth": {"accessTo');

    const r = run();

    expect(r.winner?.path).toBe(globalPath());
    // The corrupt fork is healed with the winner; invalid-but-parseable forks too.
    expect(readJson(sessionPath('su-corrupt')).claudeAiOauth.accessToken).toBe('sk-ant-oat01-real');
    expect(readJson(sessionPath('su-forged')).claudeAiOauth.accessToken).toBe('sk-ant-oat01-real');
  });

  it('restores a missing global file from the freshest fork', () => {
    writeCreds(sessionPath('su-only'), { claudeAiOauth: bundle(NOW + 8 * HOUR, 'new'), mcpOAuth: { s: 1 } });

    const r = run();

    expect(r.updated).toEqual([globalPath()]);
    expect(readJson(globalPath()).claudeAiOauth.accessToken).toBe('sk-ant-oat01-new');
    // A restored global is bundle-only — it does NOT inherit the fork's mcpOAuth.
    expect(readJson(globalPath()).mcpOAuth).toBeUndefined();
    expect(statSync(globalPath()).mode & 0o777).toBe(0o600);
  });

  it('no-ops when nothing valid exists anywhere', () => {
    writeCreds(globalPath(), { mcpOAuth: { g: 1 } });
    const r = run();
    expect(r.winner).toBeNull();
    expect(r.updated).toEqual([]);
    expect(readJson(globalPath())).toEqual({ mcpOAuth: { g: 1 } });
  });

  it('expired-but-newest still wins (an expired family member may still refresh)', () => {
    writeCreds(globalPath(), { claudeAiOauth: bundle(NOW - 4 * HOUR, 'older') });
    writeCreds(sessionPath('su-a'), { claudeAiOauth: bundle(NOW - 1 * HOUR, 'newest') });

    const r = run();

    expect(r.winner?.path).toBe(sessionPath('su-a'));
    expect(readJson(globalPath()).claudeAiOauth.accessToken).toBe('sk-ant-oat01-newest');
  });
});
