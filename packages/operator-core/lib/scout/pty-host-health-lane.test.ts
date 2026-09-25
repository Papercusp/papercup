import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { buildPtyHostHealthPatterns, classifyPtyHostEvent, type PtyHostEventAggregate } from './pty-host-health-lane';
import { flattenDigest } from './lenses';
import type { CorpusDigest } from './types';

const row = (kind: string, count: number, latestId = '42'): PtyHostEventAggregate => ({
  kind,
  count,
  owners: 2,
  latestId,
  lastAt: '2026-09-25 14:00:00+00',
});

describe('PTY host event classification for Blender', () => {
  it('separates the reported recovered retry from a terminal submit failure', () => {
    expect(classifyPtyHostEvent('turn-delivered-after-retry')).toBe('recovered');
    expect(classifyPtyHostEvent('submit-verify-unconfirmed')).toBe('failure');
    expect(classifyPtyHostEvent('submit-verify-exhausted')).toBe('failure');
    expect(classifyPtyHostEvent('turn-delivered')).toBe('routine');
    expect(classifyPtyHostEvent('duplicate-delivery-id')).toBe('routine');
  });

  it('covers the existing and newly logged host failure classes', () => {
    for (const kind of [
      'busy-gate-expired', 'respawn-carry-dropped', 'host-code-stale',
      'quota-block-detected', 'control-payload-unaddressed',
      'pty-load-failed', 'pty-spawn-failed', 'resume-finalization-report-failed',
      'resume-finalization-callback-failed', 'startup-turn-dropped',
      'session-port-delivery-ack-failed', 'managed-kickoff-failed',
      'gated-delivery-pipeline-error', 'control-socket-error',
      'control-socket-rebind-failed', 'session-scope-cleanup-partial',
      'session-scope-cleanup-failed', 'session-port-failure-ack-failed',
    ]) {
      expect(classifyPtyHostEvent(kind), kind).toBe('failure');
    }
    expect(classifyPtyHostEvent('future-unrecognized-event')).toBe('unclassified');
  });

  it('classifies every kind observed in the production 24-hour host-event census', () => {
    const observed = [
      'wake-turn-deferred-for-pending-respawn', 'turn-delivered', 'respawn-carry-delivered',
      'startup-turn-written', 'respawned', 'backend-tui-start-observed',
      'wake-rearm-queued', 'busy-gate-expired', 'wake-rearm-delivered',
      'backend-session-frame-observed', 'respawn-carry-dropped', 'respawn-rearm-queued',
      'wake-rearm-scheduled', 'host-code-stale', 'host-teardown',
      'headless-codex-model-choice-kept-existing', 'respawn-carry-turn-start-retry',
      'respawn-rearm-superseded', 'launch-kickoff-backend-frame-timeout',
      'control-payload-unaddressed', 'turn-start-unverified', 'stale-fire-dropped',
      'turn-verifier-unsupported', 'respawn-carry-fresh-epoch-retry',
      'host-code-adopting', 'submit-verify-unconfirmed',
      'launch-kickoff-marker-echo-confirmed', 'quota-block-detected',
      'launch-kickoff-marker-echo-unconfirmed', 'submit-verify-human-input-retry',
      'launch-kickoff-model-turn-absent', 'launch-kickoff-model-turn-retry-result',
      'wake-rearm-dropped', 'turn-deferred-quota-blocked', 'quota-block-cleared',
      'wake-rearm-unsupported', 'model-capacity-detected',
      'turn-deferred-for-owner-input', 'quota-recovery-started',
      'headless-claude-onboarding-expired', 'quota-recovery-ready',
      'orphan-teardown', 'submit-verify-exhausted', 'mcp-reconnect-dropped',
      'owner-composer-wedge-cleared',
    ];
    expect(observed).toHaveLength(45);
    expect(observed.filter((kind) => classifyPtyHostEvent(kind) === 'unclassified')).toEqual([]);
  });

  it('classifies every literal event kind emitted by the PTY host', () => {
    const hostSource = readFileSync(
      new URL('../../../../apps/operator/scripts/psu-pty-host.mjs', import.meta.url),
      'utf8',
    );
    const kinds = [...new Set(
      [...hostSource.matchAll(/appendHostEvent\(\s*ownerId,\s*['"]([^'"]+)['"]/g)]
        .map((match) => match[1]!),
    )].sort();
    expect(kinds.length).toBeGreaterThan(0);
    expect(kinds.filter((kind) => classifyPtyHostEvent(kind) === 'unclassified')).toEqual([]);
    expect(classifyPtyHostEvent('control-payload-rejected')).toBe('failure');
    expect(classifyPtyHostEvent('persona-refresh-skipped')).toBe('failure');
    expect(classifyPtyHostEvent('headless-codex-model-choice-select-existing')).toBe('routine');
  });

  it('places persisted failures and recovered retries in the flattened ideator corpus', () => {
    const lane = buildPtyHostHealthPatterns([
      row('turn-delivered', 20),
      row('turn-delivered-after-retry', 3, '43'),
      row('submit-verify-unconfirmed', 2, '44'),
      row('duplicate-delivery-id', 8),
    ]);
    const digest = {
      recurringFriction: [], timeTokenSinks: [], chronicDeferrals: [], capabilityGaps: [],
      ptyHostHealth: lane,
    } satisfies CorpusDigest;
    const flat = flattenDigest(digest);
    expect(flat.map((p) => p.ref)).toEqual([
      'pty-host:kind:submit-verify-unconfirmed',
      'pty-host:kind:turn-delivered-after-retry',
    ]);
    expect(flat[0]).toMatchObject({ category: 'pty-host-health' });
    expect(flat[0]?.detail).toContain('psu_pty_host_events.id=44');
    expect(flat[1]?.detail).toContain('not a final failure');
  });

  it('discloses both the pattern cap and database read cap', () => {
    const lane = buildPtyHostHealthPatterns([
      row('pty-load-failed', 2), row('control-socket-error', 1), row('future-event', 1),
    ], { limit: 1, totalKinds: 5 });
    expect(lane).toHaveLength(2);
    expect(lane[1]).toMatchObject({ ref: 'pty-host:coverage-residue' });
    expect(lane[1]?.detail).toContain('2 kinds outside');
  });
});
