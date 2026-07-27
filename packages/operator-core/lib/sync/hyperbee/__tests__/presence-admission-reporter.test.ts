/**
 * presence-gossip inbound-admission signal (EI-18769392276881557).
 *
 * The receiver's membership gate is fail-closed AND, before this, silent — the
 * defect that let WI-559 present as a network fault for weeks: fed-b's binding
 * resolved zero attested members, so it dropped every frame fed-a sent while
 * fed-a admitted fed-b normally, with clean logs on both machines.
 *
 * Hermetic: the reporter is a pure factory over injected clock + log seams.
 */

import { describe, it, expect } from 'vitest';
import { createAdmissionReporter } from '../presence-gossip-wiring';

function harness(startMs = 1_000) {
  const warns: string[] = [];
  const infos: string[] = [];
  let nowMs = startMs;
  const reporter = createAdmissionReporter({
    now: () => nowMs,
    warnIntervalMs: 60_000,
    warn: (m) => warns.push(m),
    info: (m) => infos.push(m),
  });
  return { reporter, warns, infos, advance: (ms: number) => (nowMs += ms) };
}

const TOPIC = 'aabbccddeeff00112233445566778899';
const OTHER_TOPIC = '99887766554433221100ffeeddccbbaa';

describe('createAdmissionReporter — empty membership', () => {
  it('warns naming the hive scope and the one-directional consequence', () => {
    const { reporter, warns } = harness();
    reporter.noteEmptyMembership(TOPIC, 'workspace-b31a7a01', 'octocat-spoon-knife');
    expect(warns).toHaveLength(1);
    expect(warns[0]).toContain('NO admitted devices');
    expect(warns[0]).toContain('aabbccddeeff');
    expect(warns[0]).toContain('workspace-b31a7a01::octocat-spoon-knife');
    expect(warns[0]).toContain('pot_members');
    // The consequence must be spelled out — the whole point is that a reader
    // should not have to already know the mechanism to act on the line.
    expect(warns[0]).toMatch(/DROP EVERY inbound presence frame/);
    expect(warns[0]).toMatch(/one-directional/);
  });

  it('throttles repeats per topic but reports a second topic immediately', () => {
    const { reporter, warns, advance } = harness();
    reporter.noteEmptyMembership(TOPIC, 'ws', 'pot');
    reporter.noteEmptyMembership(TOPIC, 'ws', 'pot');
    advance(59_000);
    reporter.noteEmptyMembership(TOPIC, 'ws', 'pot');
    expect(warns).toHaveLength(1);

    reporter.noteEmptyMembership(OTHER_TOPIC, 'ws', 'pot2');
    expect(warns).toHaveLength(2);

    advance(2_000); // now past the 60s window for TOPIC
    reporter.noteEmptyMembership(TOPIC, 'ws', 'pot');
    expect(warns).toHaveLength(3);
  });
});

describe('createAdmissionReporter — rejections', () => {
  it('warns on the FIRST rejection so a fault is visible at once', () => {
    const { reporter, warns } = harness();
    reporter.noteRejected(TOPIC, 'ZGV2aWNlLXB1YmtleQ==', 0);
    expect(warns).toHaveLength(1);
    expect(warns[0]).toContain('REJECTED inbound presence frame');
    expect(warns[0]).toContain('ZGV2aWNlLXB1');
    expect(warns[0]).toContain('0 admitted device(s)');
  });

  it('carries a rising rejection count and throttles the line', () => {
    const { reporter, warns, advance } = harness();
    for (let i = 0; i < 5; i += 1) reporter.noteRejected(TOPIC, 'pk', 2);
    expect(warns).toHaveLength(1);
    expect(warns[0]).toContain('1 rejection(s) so far');

    advance(61_000);
    reporter.noteRejected(TOPIC, 'pk', 2);
    expect(warns).toHaveLength(2);
    expect(warns[1]).toContain('6 rejection(s) so far');
  });

  it('reports RECOVERY once when a frame is admitted after a rejection streak', () => {
    const { reporter, warns, infos } = harness();
    reporter.noteRejected(TOPIC, 'pk', 1);
    reporter.noteRejected(TOPIC, 'pk', 1);
    reporter.noteAdmitted(TOPIC);
    expect(infos).toHaveLength(1);
    expect(infos[0]).toContain('ADMITTED again');
    expect(infos[0]).toContain('after 2 rejected frame(s)');
    expect(warns).toHaveLength(1);

    // A steady-state admitted flow stays silent.
    reporter.noteAdmitted(TOPIC);
    reporter.noteAdmitted(TOPIC);
    expect(infos).toHaveLength(1);
  });

  it('tracks rejection streaks per topic', () => {
    const { reporter, infos } = harness();
    reporter.noteRejected(TOPIC, 'pk', 1);
    reporter.noteAdmitted(OTHER_TOPIC); // never rejected here → silent
    expect(infos).toHaveLength(0);
    reporter.noteAdmitted(TOPIC);
    expect(infos).toHaveLength(1);
  });
});

describe('createAdmissionReporter — unregistered topic', () => {
  it('warns once per topic and names the boot-vs-sustained distinction', () => {
    const { reporter, warns } = harness();
    reporter.noteUnregisteredTopic(TOPIC);
    reporter.noteUnregisteredTopic(TOPIC);
    expect(warns).toHaveLength(1);
    expect(warns[0]).toContain('UNREGISTERED topic');
    expect(warns[0]).toMatch(/boot/i);
  });
});
