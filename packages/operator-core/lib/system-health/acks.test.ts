/**
 * acks.test — pure ack-application semantics (health-tab-v2-2026-07-12 P-004,
 * decision D-A). No DB: applyHealthAcks is the pure half; the read/upsert/sweep
 * IO wrappers are exercised by the integration path (tick + health:ack tool).
 * Pins: coverage stamps panel.ack + excludes it from `overall`; a warn-ack does
 * not mute a crit; expired snoozes stop covering; ackedCount is honest.
 */
import { describe, it, expect } from 'vitest';
import { applyHealthAcks } from './acks';
import type { PanelAck, PanelStatus, SystemHealth } from './types';

const NOW = 1_700_000_000_000;

const panel = (key: string, status: PanelStatus, ack?: PanelAck) => ({
  key,
  label: key,
  status,
  summary: `${key} is ${status}`,
  metrics: [],
  data: null,
  ...(ack ? { ack } : {}),
});

/** A minimal snapshot — applyHealthAcks iterates whatever panels exist. */
const snapshot = (panels: Record<string, ReturnType<typeof panel>>): SystemHealth =>
  ({
    workspaceId: 'ws-test',
    evaluatedAt: NOW,
    overall: 'unknown', // recomputed by applyHealthAcks
    panels,
  }) as unknown as SystemHealth;

const ack = (status: 'warn' | 'crit', snoozeUntil: number | null = null): PanelAck => ({
  status,
  reason: 'known + accepted',
  ackedBy: 'owner',
  ackedAt: NOW - 60_000,
  snoozeUntil,
});

describe('applyHealthAcks — coverage → muted panel + recomputed overall (P-004/D-A)', () => {
  it('a covered warn panel is stamped and excluded from overall', () => {
    const h = snapshot({
      queen: panel('queen', 'warn'),
      infra: panel('infra', 'ok'),
    });
    applyHealthAcks(h, new Map([['queen', ack('warn')]]), NOW);
    expect(h.panels.queen.ack).toBeDefined();
    expect(h.overall).toBe('ok'); // the warn no longer tints the bar
    expect(h.ackedCount).toBe(1);
  });

  it('an ack taken at warn does NOT mute a later crit — escalation re-alarms', () => {
    const h = snapshot({
      queen: panel('queen', 'crit'),
      infra: panel('infra', 'ok'),
    });
    applyHealthAcks(h, new Map([['queen', ack('warn')]]), NOW);
    expect(h.panels.queen.ack).toBeUndefined();
    expect(h.overall).toBe('crit');
    expect(h.ackedCount).toBe(0);
  });

  it('a crit ack covers a crit panel', () => {
    const h = snapshot({
      queen: panel('queen', 'crit'),
      infra: panel('infra', 'warn'),
    });
    applyHealthAcks(h, new Map([['queen', ack('crit')]]), NOW);
    expect(h.panels.queen.ack).toBeDefined();
    expect(h.overall).toBe('warn'); // only the un-acked warn is left
  });

  it('an expired snooze stops covering; a live snooze still covers', () => {
    const expired = snapshot({ queen: panel('queen', 'warn'), infra: panel('infra', 'ok') });
    applyHealthAcks(expired, new Map([['queen', ack('warn', NOW - 1)]]), NOW);
    expect(expired.panels.queen.ack).toBeUndefined();
    expect(expired.overall).toBe('warn');

    const live = snapshot({ queen: panel('queen', 'warn'), infra: panel('infra', 'ok') });
    applyHealthAcks(live, new Map([['queen', ack('warn', NOW + 60_000)]]), NOW);
    expect(live.panels.queen.ack).toBeDefined();
    expect(live.overall).toBe('ok');
  });

  it('a stale stamped ack is REMOVED when it no longer covers (re-apply is honest)', () => {
    const h = snapshot({
      queen: panel('queen', 'ok', ack('warn')), // stamped by an earlier tick, panel recovered
      infra: panel('infra', 'ok'),
    });
    applyHealthAcks(h, new Map(), NOW); // ack rows swept away meanwhile
    expect(h.panels.queen.ack).toBeUndefined();
    expect(h.ackedCount).toBe(0);
    expect(h.overall).toBe('ok');
  });

  it('acking EVERY alarming panel leaves overall at the worst uncovered (ok) level', () => {
    const h = snapshot({
      queen: panel('queen', 'crit'),
      deploy: panel('deploy', 'warn'),
      infra: panel('infra', 'ok'),
      overwatch: panel('overwatch', 'unknown'),
    });
    applyHealthAcks(h, new Map([
      ['queen', ack('crit')],
      ['deploy', ack('warn')],
    ]), NOW);
    expect(h.overall).toBe('ok'); // unknown never rolls up (D-003), acked are excluded
    expect(h.ackedCount).toBe(2);
  });

  it('no acks = a no-op that still recomputes overall from all panels', () => {
    const h = snapshot({
      queen: panel('queen', 'warn'),
      infra: panel('infra', 'ok'),
    });
    applyHealthAcks(h, new Map(), NOW);
    expect(h.overall).toBe('warn');
    expect(h.ackedCount).toBe(0);
  });
});
