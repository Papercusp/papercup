/**
 * The ONE wake-source predicate (parked-agent-census-resumption-and-root-cause-2026-10-09, D-008 (1),
 * D-009; P-009). Pure cases only — the readers are exercised through their callers.
 */
import { describe, expect, it } from 'vitest';
import {
  BOUNDED_AWAIT_DEFAULT_TIMEOUT_SEC,
  boundedAwaitTemplateFor,
  exhaustedPushParkCoversHeldWork,
  type ExhaustedPushParkProof,
  countWakeSourcesBySubscriber,
  guaranteesWake,
  isWakeSource,
  nonWakeReason,
  parseWorkItemAwaitKey,
  workItemIdsNamedBy,
  type HeldWorkItem,
  type WorkItemAwaitTarget,
} from './wake-source-predicate';

import { createWaitEpisode, claimWaitEpisode, settleWaitEpisode } from './wait-episode';

const PREFIX = 'coord:inbox-wake:';
const ME = 'su-me';
const targets = (entries: Record<string, WorkItemAwaitTarget[]>) => new Map(Object.entries(entries));
const NONE = targets({});

describe('parseWorkItemAwaitKey', () => {
  it('parses a per-item key and ignores the id-less backlog watch and other families', () => {
    expect(parseWorkItemAwaitKey('work-item:done:WI-10008160')).toEqual({ verb: 'done', itemId: 'WI-10008160' });
    expect(parseWorkItemAwaitKey('work-item:unblocked:EI-25641375587421128')).toEqual({
      verb: 'unblocked',
      itemId: 'EI-25641375587421128',
    });
    expect(parseWorkItemAwaitKey('work-item:claimable')).toBeNull();
    expect(parseWorkItemAwaitKey('release:green')).toBeNull();
    expect(workItemIdsNamedBy([{ eventKey: 'work-item:done:WI-1' }, { eventKey: 'work-item:unblocked:WI-1' }])).toEqual([
      'WI-1',
    ]);
  });
});

describe('nonWakeReason / isWakeSource (D-008 (1))', () => {
  it("excludes the session's own unbounded inbox watcher (D-006)", () => {
    const keepalive = { subscriberId: ME, eventKey: PREFIX + ME, expiresTs: null, timeoutBehavior: 'expire', once: false };
    expect(nonWakeReason(keepalive, NONE, PREFIX)).toBe('inbox-watcher');
    // An unbounded deliberate park on the same key still fires only on an inbound message.
    expect(nonWakeReason({ subscriberId: ME, eventKey: PREFIX + ME, expiresTs: null }, NONE, PREFIX)).toBe(
      'inbox-watcher',
    );
  });

  it('counts a deliberate BOUNDED wake-on-timeout await on the own inbox key (WI-2146110)', () => {
    const bounded = { subscriberId: ME, eventKey: PREFIX + ME, expiresTs: '2026-10-11T03:00:00.000Z', timeoutBehavior: 'wake' };
    expect(isWakeSource(bounded, NONE, PREFIX)).toBe(true);
  });

  it("does not treat another agent's inbox key as this session's watcher", () => {
    expect(isWakeSource({ subscriberId: ME, eventKey: PREFIX + 'su-peer', expiresTs: null }, NONE, PREFIX)).toBe(true);
  });

  it('excludes a done-await on an item the subscriber itself holds (self-deadlock)', () => {
    const t = targets({ 'WI-1': [{ status: 'wip', takenBy: ME }] });
    expect(nonWakeReason({ subscriberId: ME, eventKey: 'work-item:done:WI-1' }, t, PREFIX)).toBe('self-held-done');
  });

  it('keeps a done-await on an item someone ELSE holds, and an unblocked-await on a self-held blocked item', () => {
    expect(
      isWakeSource({ subscriberId: ME, eventKey: 'work-item:done:WI-1' }, targets({ 'WI-1': [{ status: 'wip', takenBy: 'su-peer' }] }), PREFIX),
    ).toBe(true);
    expect(
      isWakeSource(
        { subscriberId: ME, eventKey: 'work-item:unblocked:WI-1' },
        targets({ 'WI-1': [{ status: 'blocked', takenBy: ME }] }),
        PREFIX,
      ),
    ).toBe(true);
  });

  it('excludes an await on a terminal or a missing item', () => {
    expect(nonWakeReason({ subscriberId: ME, eventKey: 'work-item:done:WI-1' }, targets({ 'WI-1': [{ status: 'done', takenBy: null }] }), PREFIX)).toBe(
      'terminal-target',
    );
    expect(nonWakeReason({ subscriberId: ME, eventKey: 'work-item:unblocked:WI-1' }, targets({ 'WI-1': [] }), PREFIX)).toBe(
      'missing-target',
    );
  });

  it('keeps a bounded settled await live when the target is already terminal', () => {
    const settled = {
      subscriberId: ME,
      eventKey: 'work-item:settled:WI-1',
      expiresTs: '2026-10-11T03:00:00.000Z',
      timeoutBehavior: 'wake',
    };
    const terminal = targets({ 'WI-1': [{ status: 'done', takenBy: null }] });

    expect(nonWakeReason(settled, terminal, PREFIX)).toBeNull();
    expect(guaranteesWake(settled, terminal, PREFIX)).toBe(true);
  });

  it('treats an item that was NOT looked up as live (positive-finding-only)', () => {
    expect(isWakeSource({ subscriberId: ME, eventKey: 'work-item:done:WI-9' }, NONE, PREFIX)).toBe(true);
  });

  it('resolves a multi-harness id toward LIVE: terminal only when every row is', () => {
    const t = targets({ 'WI-1': [{ status: 'done', takenBy: null }, { status: 'open', takenBy: 'su-peer' }] });
    expect(isWakeSource({ subscriberId: ME, eventKey: 'work-item:done:WI-1' }, t, PREFIX)).toBe(true);
  });
});

describe('guaranteesWake (D-009)', () => {
  it('requires a live source that is bounded AND wakes on its deadline', () => {
    expect(guaranteesWake({ subscriberId: ME, eventKey: 'release:green', expiresTs: null }, NONE, PREFIX)).toBe(false);
    expect(
      guaranteesWake({ subscriberId: ME, eventKey: 'release:green', expiresTs: '2026-10-11T03:00:00.000Z', timeoutBehavior: 'wake' }, NONE, PREFIX),
    ).toBe(true);
    expect(
      guaranteesWake({ subscriberId: ME, eventKey: 'release:green', expiresTs: '2026-10-11T03:00:00.000Z', timeoutBehavior: 'expire' }, NONE, PREFIX),
    ).toBe(false);
  });

  it('never counts a bounded await that is dead', () => {
    const t = targets({ 'WI-1': [{ status: 'wip', takenBy: ME }] });
    expect(
      guaranteesWake({ subscriberId: ME, eventKey: 'work-item:done:WI-1', expiresTs: '2026-10-11T03:00:00.000Z' }, t, PREFIX),
    ).toBe(false);
  });
});

describe('countWakeSourcesBySubscriber', () => {
  it('counts only wake sources, per subscriber', () => {
    const t = targets({ 'WI-1': [{ status: 'wip', takenBy: ME }] });
    const counts = countWakeSourcesBySubscriber(
      [
        { subscriberId: ME, eventKey: PREFIX + ME, expiresTs: null },
        { subscriberId: ME, eventKey: 'work-item:done:WI-1' },
        { subscriberId: ME, eventKey: 'conversation:answered:conv-1' },
        { subscriberId: 'su-other', eventKey: 'work-item:done:WI-1' },
      ],
      t,
      PREFIX,
    );
    expect(counts.get(ME)).toBe(1);
    expect(counts.get('su-other')).toBe(1);
  });
});

describe('boundedAwaitTemplateFor', () => {
  const NOW = Date.parse('2026-10-11T01:00:00.000Z');
  const item = (over: Partial<HeldWorkItem>): HeldWorkItem => ({
    id: 'WI-1',
    harness: 'papercusp',
    status: 'wip',
    eventBlockers: [],
    ...over,
  });

  it('prefers a typed event blocker, bounding the wait by its recheckAt', () => {
    const tpl = boundedAwaitTemplateFor(
      [
        item({ id: 'WI-1', status: 'blocked' }),
        item({ id: 'WI-2', eventBlockers: [{ ref: 'release:green', summary: 'gate', recheckAt: '2026-10-11T03:00:00.000Z' }] }),
      ],
      NOW,
    );
    expect(tpl).toEqual({
      itemId: 'WI-2',
      args: { event: 'release:green', timeout_sec: 7200, on_timeout: 'wake', note: expect.stringContaining('WI-2') },
    });
  });

  it('clamps a recheckAt bound into [300s, 24h]', () => {
    const soon = boundedAwaitTemplateFor(
      [item({ eventBlockers: [{ ref: 'e:x', summary: '', recheckAt: '2026-10-11T01:00:10.000Z' }] })],
      NOW,
    );
    const far = boundedAwaitTemplateFor(
      [item({ eventBlockers: [{ ref: 'e:x', summary: '', recheckAt: '2026-10-20T01:00:00.000Z' }] })],
      NOW,
    );
    expect(soon?.args.timeout_sec).toBe(300);
    expect(far?.args.timeout_sec).toBe(86_400);
  });

  it('does not infer an unblocked emitter from lifecycle-blocked status alone', () => {
    expect(boundedAwaitTemplateFor([item({ id: 'WI-1' }), item({ id: 'WI-2', status: 'blocked' })], NOW)).toBeNull();
  });

  it.each(['work-item:done', 'work-item:status', 'claim:released'])(
    'skips a typed %s event on any held item and continues to an external blocker',
    (prefix) => {
      const tpl = boundedAwaitTemplateFor([
        item({ eventBlockers: [
          { ref: `${prefix}:WI-2`, summary: 'self-held lifecycle', recheckAt: null },
          { ref: 'work-item:done:WI-3', summary: 'peer publication', recheckAt: null },
        ] }),
        item({ id: 'WI-2', status: 'blocked' }),
      ], NOW);
      expect(tpl?.args).toMatchObject({
        event: 'work-item:done:WI-3',
        timeout_sec: BOUNDED_AWAIT_DEFAULT_TIMEOUT_SEC,
        on_timeout: 'wake',
      });
    },
  );

  it('returns no template when the only typed blocker waits on its own completion', () => {
    expect(boundedAwaitTemplateFor([
      item({ status: 'blocked', eventBlockers: [{ ref: 'work-item:done:WI-1', summary: '', recheckAt: null }] }),
    ], NOW)).toBeNull();
  });

  it('returns null when no held item states a blocker', () => {
    expect(boundedAwaitTemplateFor([item({}), item({ id: 'WI-2', status: 'open' })], NOW)).toBeNull();
  });
});


describe('canonical exhausted push-only park admission (EI-28701246782258193)', () => {
  function fixture() {
    const eventKey = 'work-item:done:WI-9';
    const ref = { kind: 'event' as const, ref: eventKey };
    const claimed = claimWaitEpisode(createWaitEpisode({
      workspaceId: 'ws', harness: 'papercusp', drivingWorkItemId: 'WI-1', custodianId: ME, nowMs: 0,
      contract: { dependencyRef: eventKey, predicateKey: eventKey, sourceOwnerId: 'su-peer',
        sourceGeneration: 1, expectedCondition: null, payloadFilter: null, noDeltaBudget: 1,
        cadenceMs: 1000, evidence: null, substages: [] },
    }), { callback: 'timeout', nowMs: 1000 });
    const episode = settleWaitEpisode(claimed.episode, claimed.receipt!,
      { kind: 'observed', checkedAtMs: 1000 }).episode;
    const payload = { waitEpisodes: { [episode.id]: episode }, blockerResolution: { schemaVersion: 1, history: [{
      id: 'decision', revision: 1, workItemId: 'WI-1', authorId: ME, sessionId: ME,
      recordedAt: new Date(0).toISOString(), requestHash: 'a'.repeat(64),
      decision: { schemaVersion: 1, idempotencyKey: 'park', disposition: 'defer',
        symptom: 'pending dependency', investigation: [{ action: 'Read dependency', outcome: 'Live peer owns it', evidenceRefs: [ref] }],
        attempts: [], evidenceRefs: [ref], deferral: { reason: 'active-peer', reasonEvidenceRefs: [ref],
          responsibleParty: 'su-peer', nextAction: 'Resume on exact completion push', recheckRef: { ...ref } } },
    }] } };
    const proof: ExhaustedPushParkProof = {
      item: { id: 'WI-1', harness: 'papercusp', status: 'blocked', workspaceId: 'ws', custodianId: ME, payload,
        eventBlockers: [{ ref: eventKey, summary: 'pending', recheckAt: null }] },
      awaited: { subscriberId: ME, eventKey, expiresTs: null, timeoutBehavior: 'wake', once: true,
        policy: 'wake', firedAt: null, cancelledAt: null,
        settlement: { id: episode.id, state: 'exhausted', remainingNoDeltaBudget: 0, disposition: 'push-only' },
        producerHealthCertificate: {
          version: 1, producer: { kind: 'bounded-dependency', id: 'producer' },
          owner: { ownerId: 'su-peer', workItemId: 'WI-9' }, issuedAtMs: 0, lastProgressAtMs: null,
          lastFireAtMs: null, expectedCadenceMs: 1000, verificationDeadlineMs: 1000,
          waitEpisode: { workspaceId: 'ws', harness: 'papercusp', drivingWorkItemId: 'WI-1', id: episode.id },
          waitEpisodeReceipt: structuredClone(episode.receipt!),
        } },
      source: { status: 'available', condition: 'pending', reachable: true, liveOwnerId: 'su-peer', responsibleParty: 'su-peer' },
    };
    return { proof, episode, payload };
  }
  const admits = (f: ReturnType<typeof fixture>) => exhaustedPushParkCoversHeldWork({
    ownerId: ME, workspaceId: 'ws', held: [f.proof.item], proofs: [f.proof],
  });

  it('admits a settled exhausted episode bound to its live await and current peer, without guaranteeing a wake', () => {
    const f = fixture();
    expect(admits(f)).toBe(true);
    expect(guaranteesWake(f.proof.awaited, NONE, PREFIX)).toBe(false);
  });

  const invalid: Array<[string, (f: ReturnType<typeof fixture>) => void]> = [
    ['unknown push-only result', f => { f.episode.state = 'unknown'; }],
    ['cancelled tombstone', f => { f.episode.state = 'cancelled'; }],
    ['active episode', f => { f.episode.state = 'active'; }],
    ['unspent budget', f => { f.episode.remainingNoDeltaBudget = 1; }],
    ['pending receipt', f => { f.episode.receipt!.state = 'pending'; }],
    ['unknown host settlement', f => { f.proof.awaited.settlement!.state = 'unknown'; }],
    ['missing host settlement', f => { f.proof.awaited.settlement = null; }],
    ['different host settlement budget', f => { f.proof.awaited.settlement!.remainingNoDeltaBudget = 1; }],
    ['missing host receipt', f => { delete f.proof.awaited.producerHealthCertificate!.waitEpisodeReceipt; }],
    ['different host receipt', f => { f.proof.awaited.producerHealthCertificate!.waitEpisodeReceipt!.claimToken = 'other'; }],
    ['different episode', f => { f.proof.awaited.producerHealthCertificate!.waitEpisode!.id = 'other'; }],
    ['different harness', f => { f.proof.awaited.producerHealthCertificate!.waitEpisode!.harness = 'other'; }],
    ['different workspace', f => { f.proof.item.workspaceId = 'other'; }],
    ['different custodian', f => { f.proof.item.custodianId = 'su-peer'; }],
    ['unblocked work', f => { f.proof.item.status = 'open'; }],
    ['fired await', f => { f.proof.awaited.firedAt = new Date(0).toISOString(); }],
    ['cancelled await', f => { f.proof.awaited.cancelledAt = new Date(0).toISOString(); }],
    ['expiring await', f => { f.proof.awaited.expiresTs = new Date(0).toISOString(); }],
    ['standing watch', f => { f.proof.awaited.once = false; }],
    ['announcement', f => { f.proof.awaited.policy = 'announce'; }],
    ['foreign subscriber', f => { f.proof.awaited.subscriberId = 'other'; }],
    ['unknown source', f => { f.proof.source = { status: 'unknown', detail: 'not measured' }; }],
    ['missing source', f => { f.proof.source = { status: 'absent', detail: 'no target' }; }],
    ['ownerless source', f => { f.proof.source = { status: 'available', condition: 'pending', reachable: true }; }],
    ['terminal source', f => { f.proof.source = { status: 'available', condition: 'satisfied', reachable: true, liveOwnerId: 'su-peer', responsibleParty: 'su-peer' }; }],
    ['unrelated await', f => { f.proof.awaited.eventKey = 'work-item:done:WI-8'; }],
    ['unrelated deferral', f => { f.payload.blockerResolution.history[0].decision.deferral.recheckRef.ref = 'other'; }],
    ['foreign decision author', f => { f.payload.blockerResolution.history[0].authorId = 'other'; }],
    ['foreign decision subject', f => { f.payload.blockerResolution.history[0].workItemId = 'WI-8'; }],
    ['prose-only budget', f => { f.proof.item.payload = { checkpoint: 'budget 0; push only' }; }],
  ];
  it.each(invalid)('refuses %s', (_name, mutate) => {
    const f = fixture();
    mutate(f);
    expect(admits(f)).toBe(false);
  });

  it('requires separate coverage for every held item, including the same id in another harness', () => {
    const f = fixture();
    for (const other of [{ ...f.proof.item, id: 'WI-2' }, { ...f.proof.item, harness: 'other' }]) {
      expect(exhaustedPushParkCoversHeldWork({ ownerId: ME, workspaceId: 'ws',
        held: [f.proof.item, other], proofs: [f.proof] })).toBe(false);
    }
  });

  it('refuses the held-population sentinel and self-held completion dependencies', () => {
    const f = fixture();
    expect(exhaustedPushParkCoversHeldWork({ ownerId: ME, workspaceId: 'ws',
      held: Array.from({ length: 51 }, () => f.proof.item), proofs: [f.proof] })).toBe(false);
    expect(exhaustedPushParkCoversHeldWork({ ownerId: ME, workspaceId: 'ws',
      held: [f.proof.item, { ...f.proof.item, id: 'WI-9' }], proofs: [f.proof] })).toBe(false);
  });
});
