import { describe, expect, it, vi } from 'vitest';
import { fleetCommsOrigin, fleetCommsRoute, fleetCommsRescore, measureFleetComms, summarizeFleetComms,
  rateFleetComms, FLEET_COMMS_MAX_ROWS, FLEET_COMMS_MAX_BYTES, type FleetCommsRow } from './execution-comms';

const window = { workspaceId: 'ws', harnessSlug: 'h', fleet: 'f',
  windowStart: '2026-10-01T00:00:00Z', windowEnd: '2026-10-08T00:00:00Z' };
const message = (id: string, patch: Partial<FleetCommsRow> = {}): FleetCommsRow => ({ id, msg_id: id,
  writer_key: 'member', was_leader: false, envelope_type: 'object', kind: 'message', auto: null,
  system_expects: false, summary_text: `summary ${id}`, body_text: `body ${id}`, lifecycle: null,
  audience: null, recipients: ['peer'], expects: 'none', ...patch });
const summary = (messages: number, closes = 1) => ({ members: 2, nonleaders: 1, messages, bytes: 100, closes });

describe('literal fleet communication method', () => {
  it('keeps missing historical provenance authored and excludes every typed machine origin', () => {
    const rows = [message('authored'), message('auto', { auto: 'true' }), message('system', { system_expects: true }),
      message('ack', { kind: 'ack' }), message('notify', { kind: 'notify' }), message('leader', { was_leader: true })];
    const m = summarizeFleetComms(window, summary(rows.length), rows);
    expect(m.unavailableReason).toBeNull();
    expect(m.cohorts.allDeclaredMembers).toMatchObject({ raw: 6, authored: 2, excluded: 4, unqualified: 0,
      excludedShare: 4 / 6, dispositions: { none: 2 } });
    expect(m.cohorts.nonleaderMembers).toMatchObject({ raw: 5, authored: 1, excluded: 4 });
    expect(rateFleetComms(m).rating).toBe('healthy');
  });

  it.each([
    ['unknown-envelope', { envelope_type: 'array' }], ['unknown-kind', { kind: null }],
    ['unqualified-consult-router', { summary_text: '✅ answer on consult 123' }],
    ['unqualified-consult-router', { summary_text: '💬 reply on consult 123' }],
  ] as const)('keeps %s unqualified instead of awarding a healthy grade', (origin, patch) => {
    const row = message('1', patch);
    expect(fleetCommsOrigin(row)).toBe(origin);
    const m = summarizeFleetComms(window, summary(1), [row]);
    expect(m.cohorts.nonleaderMembers.unqualified).toBe(1);
    expect(rateFleetComms(m).rating).toBe('unknown');
  });

  it('uses original audiences after expansion and records each destination class', () => {
    expect(fleetCommsRoute(message('1', { audience: ['@fleet:f'], recipients: ['su-1', 'su-2'] }), 'f')).toBe('this-fleet-selector');
    expect(fleetCommsRoute(message('1', { audience: ['@fleet-leader:f'] }), 'f')).toBe('leader-selector');
    expect(fleetCommsRoute(message('1', { recipients: ['*'] }), 'f')).toBe('global-star');
    expect(fleetCommsRoute(message('1', { audience: ['@fleet:other'] }), 'f')).toBe('other-fleet-selector');
    expect(fleetCommsRoute(message('1', { audience: ['@plan:p'] }), 'f')).toBe('other-selector');
    expect(fleetCommsRoute(message('1', { recipients: ['peer'] }), 'f')).toBe('directed');
    for (const recipients of [null, [], ['peer', 1]]) {
      const m = summarizeFleetComms(window, summary(1), [message('1', { recipients })]);
      expect(rateFleetComms(m).rating).toBe('unknown');
    }
  });

  it('unions nonempty summary and body duplicates without counting overlap twice', () => {
    const rows = [message('1', { summary_text: 'same' }), message('2', { summary_text: 'same' }),
      message('3', { body_text: 'same body' }), message('4', { summary_text: 'same', body_text: 'same body' }),
      message('5', { summary_text: '', body_text: '' }), message('6', { summary_text: '', body_text: '' })];
    const c = summarizeFleetComms(window, summary(6), rows).cohorts.nonleaderMembers;
    expect(c).toMatchObject({ duplicateBeyondFirst: 2, duplicateParticipants: 4,
      duplicateBeyondFirstShare: 2 / 6, duplicateParticipantShare: 4 / 6 });
    expect(c.lifecycleHeuristic.total).toBe(6);
  });

  it.each([[5, 'healthy'], [6, 'degraded'], [15, 'degraded'], [16, 'broken']] as const)(
    'uses strict message thresholds at %s per close', (count, rating) => {
      expect(rateFleetComms(summarizeFleetComms(window, summary(count),
        Array.from({ length: count }, (_, i) => message(String(i))))).rating).toBe(rating);
    });

  it('uses the strict ten-percent participant boundary and never turns zero closes into zero cost', () => {
    const rows = Array.from({ length: 20 }, (_, i) => message(String(i), { summary_text: i < 2 ? 'repeat' : String(i) }));
    expect(rateFleetComms(summarizeFleetComms(window, summary(20, 20), rows)).rating).toBe('healthy');
    rows[2]!.summary_text = 'repeat';
    expect(rateFleetComms(summarizeFleetComms(window, summary(20, 20), rows)).rating).toBe('degraded');
    expect(rateFleetComms(summarizeFleetComms(window, summary(20, 0), rows)).rating).toBe('unknown');
  });

  it('refuses incomplete, oversized and malformed source partitions', () => {
    for (const counts of [{ ...summary(1), messages: FLEET_COMMS_MAX_ROWS + 1 },
      { ...summary(1), bytes: FLEET_COMMS_MAX_BYTES + 1 }, { ...summary(1), members: 0 },
      { ...summary(1), closes: -1 }, summary(2)]) {
      const m = summarizeFleetComms(window, counts, [message('1')]);
      expect(rateFleetComms(m).rating).toBe('unknown'); expect(m.cohorts.nonleaderMembers.authored).toBe(0);
    }
    expect(rateFleetComms(summarizeFleetComms(window, summary(2), [message('1'), message('1')])).rating).toBe('unknown');
  });

  it.each([{ ...window, fleet: '*' }, { ...window, windowStart: 'invalid' },
    { ...window, windowEnd: window.windowStart }, { ...window, workspaceId: '' }])(
    'refuses invalid scope before reading any SQL', async input => {
      const begin = vi.fn();
      expect((await measureFleetComms(input, { begin } as never)).unavailableReason).toBeTruthy();
      expect(begin).not.toHaveBeenCalled();
    });

  it('requires a typed fleet subject', async () => {
    expect(await fleetCommsRescore().resolve({ ...window, subject: { kind: 'plan', ref: 'f' } })).toMatchObject({ verdict: 'unknown' });
  });
});
