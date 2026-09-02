/**
 * episodic-ei.test.ts — the shared episodic durable-EI escalator seam (EI-9030a).
 *
 * The two production bindings (replication-stall-ei.ts, own-log-fork-ei.ts) pin
 * the full behavior contract through their own suites; this file pins the
 * config plumbing the factory owns and the bindings don't isolate: the
 * topics = [topic, ...extraTopics] default, recoveryOwner defaulting to
 * createdBy, severity/provenance passthrough, and per-instance in-flight
 * isolation.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

const { listIssuesMock, setIssueStateMock, setWorkItemStateMock } = vi.hoisted(() => ({
  listIssuesMock: vi.fn(),
  setIssueStateMock: vi.fn(),
  setWorkItemStateMock: vi.fn(),
}));

// The production collapse deps load both modules lazily. Keep this test at the
// default-dependency boundary so it catches a regression back to the legacy
// issues-engineer writer rather than only testing an injected fake seam.
vi.mock('../issues-engineer', () => ({
  listIssues: listIssuesMock,
  setIssueState: setIssueStateMock,
}));
vi.mock('../work-items', () => ({ setWorkItemState: setWorkItemStateMock }));

import {
  collapseDuplicateOpenEis,
  cooldownLookbackFilter,
  createEpisodicEscalator,
  defaultCollapseDeps,
  DUPLICATE_COLLAPSE_OWNER,
  unionPopulation,
  type CollapsibleOpenEi,
  type DuplicateCollapseDeps,
  type EpisodicEiDeps,
} from './episodic-ei';

type Ep = { key: string; detail: string };
type Rec = { key: string; detail: string };

const title = (x: Ep | Rec) => `[demo] key=${x.key}`;

function fakeDeps(
  open: Array<{ id?: string; title: string }>,
  recent?: Array<{ id?: string; title: string; createdAt: string }>,
  extra?: { commentOnRecurrence?: EpisodicEiDeps<'major'>['commentOnRecurrence'] },
): {
  deps: EpisodicEiDeps<'major'>;
  created: Array<Parameters<EpisodicEiDeps<'major'>['create']>[0]>;
  resolved: Array<{ id: string; note: string }>;
} {
  const created: Array<Parameters<EpisodicEiDeps<'major'>['create']>[0]> = [];
  const resolved: Array<{ id: string; note: string }> = [];
  return {
    created,
    resolved,
    deps: {
      listOpenByTopic: async () => open.map((o) => ({ id: o.id ?? 'EI-OPEN', title: o.title })),
      create: async (input) => {
        created.push(input);
        return { id: 'EI-777' };
      },
      resolve: async (id, note) => {
        resolved.push({ id, note });
      },
      ...(recent
        ? {
            listRecentByTopic: async () =>
              recent.map((r) => ({ id: r.id ?? 'EI-RECENT', title: r.title, createdAt: r.createdAt })),
          }
        : {}),
      ...(extra?.commentOnRecurrence ? { commentOnRecurrence: extra.commentOnRecurrence } : {}),
    },
  };
}

const make = (over: Partial<Parameters<typeof createEpisodicEscalator<Ep, Rec, 'major'>>[0]> = {}) =>
  createEpisodicEscalator<Ep, Rec, 'major'>({
    topic: 'demo-topic',
    stableTitle: title,
    buildBody: (e) => `body for ${e.key}: ${e.detail}`,
    resolveNote: (r) => `recovered — ${r.detail}`,
    severity: 'major',
    createdBy: 'system:demo',
    foundDuring: 'demo-detector',
    ...over,
  });

describe('createEpisodicEscalator config plumbing', () => {
  let reset: (() => void) | null = null;
  afterEach(() => {
    reset?.();
    reset = null;
  });

  it('tags topics = [topic, ...extraTopics] (default federation) and stamps severity/provenance', async () => {
    const esc = make();
    reset = esc._resetForTests;
    const { deps, created } = fakeDeps([]);
    const id = await esc.file({ key: 'k1', detail: 'd' }, deps);
    expect(id).toBe('EI-777');
    expect(created[0]!.topics).toEqual(['demo-topic', 'federation']);
    expect(created[0]!.severity).toBe('major');
    expect(created[0]!.createdBy).toBe('system:demo');
    expect(created[0]!.foundDuring).toBe('demo-detector');
    expect(created[0]!.title).toBe(title({ key: 'k1', detail: 'd' }));
    expect(created[0]!.body).toBe('body for k1: d');
  });

  it('honors an explicit extraTopics override', async () => {
    const esc = make({ extraTopics: ['a', 'b'] });
    reset = esc._resetForTests;
    const { deps, created } = fakeDeps([]);
    await esc.file({ key: 'k1', detail: 'd' }, deps);
    expect(created[0]!.topics).toEqual(['demo-topic', 'a', 'b']);
  });

  it('exposes topic + recoveryOwner; recoveryOwner defaults to createdBy', () => {
    expect(make().recoveryOwner).toBe('system:demo');
    expect(make({ recoveryOwner: 'system:other' }).recoveryOwner).toBe('system:other');
    expect(make().topic).toBe('demo-topic');
  });

  it('dedupes against an open EI with the same title', async () => {
    const esc = make();
    reset = esc._resetForTests;
    const { deps, created } = fakeDeps([{ title: title({ key: 'k1', detail: 'x' }) }]);
    const id = await esc.file({ key: 'k1', detail: 'd' }, deps);
    expect(id).toBeNull();
    expect(created).toHaveLength(0);
  });

  it('the VITEST gate returns null (file) / [] (resolve) without deps', async () => {
    const esc = make();
    reset = esc._resetForTests;
    expect(await esc.file({ key: 'k1', detail: 'd' })).toBeNull();
    expect(await esc.resolve({ key: 'k1', detail: 'd' })).toEqual([]);
  });

  it('resolve closes ALL matching open EIs with the resolveNote', async () => {
    const esc = make();
    reset = esc._resetForTests;
    const t = title({ key: 'k1', detail: 'x' });
    const { deps, resolved } = fakeDeps([
      { id: 'EI-1', title: t },
      { id: 'EI-2', title: t },
    ]);
    const ids = await esc.resolve({ key: 'k1', detail: 'store reset' }, deps);
    expect(ids.sort()).toEqual(['EI-1', 'EI-2']);
    expect(resolved.map((r) => r.note)).toEqual(['recovered — store reset', 'recovered — store reset']);
  });

  describe('standing-condition cooldown (WI-5762)', () => {
    it('with no standingCooldownMs configured, a since-closed title re-files (pre-existing behavior, byte-identical)', async () => {
      const esc = make(); // no standingCooldownMs
      reset = esc._resetForTests;
      const t = title({ key: 'k1', detail: 'x' });
      // No open EI (it was closed) AND a recent (resolved) EI exists — but since
      // the config never opted into the cooldown, this must still file.
      const { deps, created } = fakeDeps([], [{ title: t, createdAt: new Date().toISOString() }]);
      const id = await esc.file({ key: 'k1', detail: 'd' }, deps);
      expect(id).toBe('EI-777');
      expect(created).toHaveLength(1);
    });

    it('suppresses a re-file when the SAME title was seen (any state) inside the cooldown window', async () => {
      // WI-2142025: suppressing now WARNS, so this must mock console.warn out —
      // vitest-fail-on-console fails the test otherwise. That this assertion had
      // to be added at all is the proof the path was previously silent.
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        const esc = make({ standingCooldownMs: 60 * 60 * 1000 }); // 1h
        reset = esc._resetForTests;
        const t = title({ key: 'k1', detail: 'x' });
        // No OPEN match (it was closed 10 minutes ago) — open-only dedup would
        // re-file here; the cooldown must catch it instead.
        const tenMinAgo = new Date(Date.now() - 10 * 60 * 1000).toISOString();
        const { deps, created } = fakeDeps([], [{ title: t, createdAt: tenMinAgo }]);
        const id = await esc.file({ key: 'k1', detail: 'd' }, deps);
        expect(id).toBeNull();
        expect(created).toHaveLength(0);
        expect(warn).toHaveBeenCalledTimes(1);
      } finally {
        warn.mockRestore();
      }
    });

    it('files fresh once the cooldown window has elapsed', async () => {
      const esc = make({ standingCooldownMs: 60 * 60 * 1000 }); // 1h
      reset = esc._resetForTests;
      const t = title({ key: 'k1', detail: 'x' });
      const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
      const { deps, created } = fakeDeps([], [{ title: t, createdAt: twoHoursAgo }]);
      const id = await esc.file({ key: 'k1', detail: 'd' }, deps);
      expect(id).toBe('EI-777');
      expect(created).toHaveLength(1);
    });

    it('an unrelated title in the recent list never suppresses this one', async () => {
      const esc = make({ standingCooldownMs: 60 * 60 * 1000 });
      reset = esc._resetForTests;
      const other = title({ key: 'other-key', detail: 'x' });
      const { deps, created } = fakeDeps([], [{ title: other, createdAt: new Date().toISOString() }]);
      const id = await esc.file({ key: 'k1', detail: 'd' }, deps);
      expect(id).toBe('EI-777');
      expect(created).toHaveLength(1);
    });

    it('fails OPEN (still files) when listRecentByTopic throws', async () => {
      const esc = make({ standingCooldownMs: 60 * 60 * 1000 });
      reset = esc._resetForTests;
      const { deps, created } = fakeDeps([]);
      deps.listRecentByTopic = async () => {
        throw new Error('pg unavailable');
      };
      const id = await esc.file({ key: 'k1', detail: 'd' }, deps);
      expect(id).toBe('EI-777');
      expect(created).toHaveLength(1);
    });

    it('is skipped entirely when deps omits listRecentByTopic even with the cooldown configured', async () => {
      const esc = make({ standingCooldownMs: 60 * 60 * 1000 });
      reset = esc._resetForTests;
      const { deps, created } = fakeDeps([]); // no listRecentByTopic on this deps object
      const id = await esc.file({ key: 'k1', detail: 'd' }, deps);
      expect(id).toBe('EI-777');
      expect(created).toHaveLength(1);
    });

    /**
     * WI-2142025: the suppression used to be a bare `return null` with NO output,
     * so a cooldown started by a benign 9-minute episode silenced the durable EI
     * for a genuinely new 8-hour outage with nothing observable anywhere. These
     * pin the notice. They are falsifiable by construction: against the pre-fix
     * source the gate emitted nothing at all, so every `toHaveBeenCalled` here
     * fails on it — and the calibration case below proves the spy is really wired
     * (a warn on the NON-suppressed path would mean these pass vacuously).
     */
    describe('suppression is observable (WI-2142025)', () => {
      const HOUR = 60 * 60 * 1000;
      const tenMinAgo = () => new Date(Date.now() - 10 * 60 * 1000).toISOString();

      it('speaks on the FIRST swallowed episode, naming the expiry and the resolved-blindness', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        try {
          const esc = make({ standingCooldownMs: HOUR });
          reset = esc._resetForTests;
          const lastFiled = tenMinAgo();
          const { deps, created } = fakeDeps([], [{ title: title({ key: 'k1', detail: 'x' }), createdAt: lastFiled }]);

          // Calibration: a filing that is NOT suppressed must stay silent, or the
          // assertions below would pass for the wrong reason.
          const other = make({ standingCooldownMs: HOUR });
          const { deps: quietDeps } = fakeDeps([]);
          await other.file({ key: 'k9', detail: 'd' }, quietDeps);
          other._resetForTests();
          expect(warn).not.toHaveBeenCalled();

          const id = await esc.file({ key: 'k1', detail: 'd' }, deps);
          expect(id).toBeNull();
          expect(created).toHaveLength(0);
          expect(warn).toHaveBeenCalledTimes(1);

          const msg = String(warn.mock.calls[0]?.[0] ?? '');
          expect(msg).toContain('standing-cooldown SUPPRESSED a durable EI');
          expect(msg).toContain('topic=demo-topic');
          expect(msg).toContain(`lastFiledAt=${lastFiled}`);
          expect(msg).toContain(`cooldownExpiresAt=${new Date(Date.parse(lastFiled) + HOUR).toISOString()}`);
          expect(msg).toContain('episodesSuppressedSinceLastFiling=1');
          // The whole point: the reader must be told the prior EI may be RESOLVED.
          expect(msg).toContain('RESOLVED');
        } finally {
          warn.mockRestore();
        }
      });

      it('throttles the run — silent between the 1st and the 25th, then speaks again', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        try {
          const esc = make({ standingCooldownMs: HOUR });
          reset = esc._resetForTests;
          const { deps } = fakeDeps([], [{ title: title({ key: 'k1', detail: 'x' }), createdAt: tenMinAgo() }]);

          for (let i = 0; i < 24; i++) await esc.file({ key: 'k1', detail: 'd' }, deps);
          expect(warn).toHaveBeenCalledTimes(1); // the 1st only

          await esc.file({ key: 'k1', detail: 'd' }, deps); // the 25th
          expect(warn).toHaveBeenCalledTimes(2);
          expect(String(warn.mock.calls[1]?.[0] ?? '')).toContain('episodesSuppressedSinceLastFiling=25');
        } finally {
          warn.mockRestore();
        }
      });

      it('WI-2142025 fault 2b: posts a durable recurrence comment on the SUPPRESSING EI, id-correct', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        try {
          const escalator = make({ standingCooldownMs: 24 * 60 * 60_000 });
          const comments: Array<{ id: string; body: string }> = [];
          const { deps } = fakeDeps(
            [],
            [{ id: 'EI-999', title: title({ key: 'k1', detail: '' }), createdAt: new Date(Date.now() - 1000).toISOString() }],
            { commentOnRecurrence: async (id, body) => void comments.push({ id, body }) },
          );
          const id = await escalator.file({ key: 'k1', detail: 'd1' }, deps);
          expect(id).toBeNull();
          expect(comments).toHaveLength(1);
          expect(comments[0].id).toBe('EI-999'); // the EXACT suppressing row, not a placeholder
          expect(comments[0].body).toContain('Recurred:');
          expect(comments[0].body).toContain('WI-5762');
          expect(comments[0].body).toContain('body for k1: d1'); // buildBody(episode) inlined
        } finally {
          warn.mockRestore();
        }
      });

      it('calibration: a non-suppressed (fresh) filing posts NO recurrence comment', async () => {
        const escalator = make({ standingCooldownMs: 24 * 60 * 60_000 });
        const comments: Array<{ id: string; body: string }> = [];
        const { deps } = fakeDeps([], [], {
          commentOnRecurrence: async (id, body) => void comments.push({ id, body }),
        });
        const id = await escalator.file({ key: 'k1', detail: 'd1' }, deps);
        expect(id).toBe('EI-777');
        expect(comments).toHaveLength(0);
      });

      it('a comment failure never throws back into file() — best-effort', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        try {
          const escalator = make({ standingCooldownMs: 24 * 60 * 60_000 });
          const { deps } = fakeDeps(
            [],
            [{ id: 'EI-999', title: title({ key: 'k1', detail: '' }), createdAt: new Date(Date.now() - 1000).toISOString() }],
            {
              commentOnRecurrence: async () => {
                throw new Error('pg down');
              },
            },
          );
          await expect(escalator.file({ key: 'k1', detail: 'd1' }, deps)).resolves.toBeNull();
        } finally {
          warn.mockRestore();
        }
      });

      it('is skipped when deps omits commentOnRecurrence, even while suppressing', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        try {
          const escalator = make({ standingCooldownMs: 24 * 60 * 60_000 });
          const { deps } = fakeDeps(
            [],
            [{ id: 'EI-999', title: title({ key: 'k1', detail: '' }), createdAt: new Date(Date.now() - 1000).toISOString() }],
          );
          await expect(escalator.file({ key: 'k1', detail: 'd1' }, deps)).resolves.toBeNull();
        } finally {
          warn.mockRestore();
        }
      });

      it('a real filing ends the run, so the next suppression speaks again from 1', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        try {
          const esc = make({ standingCooldownMs: HOUR });
          reset = esc._resetForTests;
          const t = title({ key: 'k1', detail: 'x' });
          const recent = [{ title: t, createdAt: tenMinAgo() }];
          const { deps } = fakeDeps([], recent);

          await esc.file({ key: 'k1', detail: 'd' }, deps);
          expect(warn).toHaveBeenCalledTimes(1);

          // Cooldown lapses (the recent filing ages out) and the title files for real…
          recent[0]!.createdAt = new Date(Date.now() - 2 * HOUR).toISOString();
          expect(await esc.file({ key: 'k1', detail: 'd' }, deps)).toBe('EI-777');

          // …so a later suppression is a NEW run and must announce itself, rather
          // than being throttled against the stale tally from before the filing.
          recent[0]!.createdAt = tenMinAgo();
          expect(await esc.file({ key: 'k1', detail: 'd' }, deps)).toBeNull();
          expect(warn).toHaveBeenCalledTimes(2);
          expect(String(warn.mock.calls[1]?.[0] ?? '')).toContain('episodesSuppressedSinceLastFiling=1');
        } finally {
          warn.mockRestore();
        }
      });
    });
  });

  it('two escalators keep independent in-flight guards', async () => {
    const a = make();
    const b = make();
    reset = () => {
      a._resetForTests();
      b._resetForTests();
    };
    // Hold a's create pending so its inFlight stays set, then confirm b is unaffected.
    let releaseA!: (v: { id: string }) => void;
    const pendingA = new Promise<{ id: string }>((r) => (releaseA = r));
    const depsA = fakeDeps([]).deps;
    depsA.create = () => pendingA;
    const pA = a.file({ key: 'k1', detail: 'd' }, depsA);
    const { deps: depsB, created: createdB } = fakeDeps([]);
    const idB = await b.file({ key: 'k1', detail: 'd' }, depsB);
    expect(idB).toBe('EI-777'); // b filed even though a holds the same title in-flight
    expect(createdB).toHaveLength(1);
    releaseA({ id: 'EI-777' });
    await pA;
  });
});

describe('collapseDuplicateOpenEis (WI-6986)', () => {
  const NOTE = 'duplicate of an identical stable title';

  it('routes default duplicate retirement through the unified lifecycle writer', async () => {
    setWorkItemStateMock.mockResolvedValue(null);

    const deps = await defaultCollapseDeps();
    await deps.drop('EI-2', NOTE);

    expect(setWorkItemStateMock).toHaveBeenCalledWith('EI-2', 'dropped', {
      by: DUPLICATE_COLLAPSE_OWNER,
      completionRef: NOTE,
    });
    expect(setIssueStateMock).not.toHaveBeenCalled();
  });

  function collapseDeps(open: CollapsibleOpenEi[], unmutable: string[] = []) {
    const dropped: Array<{ id: string; note: string }> = [];
    const deps: DuplicateCollapseDeps = {
      listOpenByTopic: async () => open,
      drop: async (id, note) => {
        if (unmutable.includes(id)) {
          throw new Error(`work_item '${id}' is remote-authored and cannot be mutated locally`);
        }
        dropped.push({ id, note });
      },
    };
    return { deps, dropped };
  }

  const ei = (id: string, title: string, createdAt: string): CollapsibleOpenEi => ({
    id,
    title,
    createdAt,
  });

  it('keeps the OLDEST row per title and drops the rest', async () => {
    const { deps, dropped } = collapseDeps([
      ei('EI-3', 'A', '2026-07-03T00:00:00Z'),
      ei('EI-1', 'A', '2026-07-01T00:00:00Z'),
      ei('EI-2', 'A', '2026-07-02T00:00:00Z'),
    ]);
    const r = await collapseDuplicateOpenEis('demo', NOTE, deps);
    expect(dropped.map((d) => d.id).sort()).toEqual(['EI-2', 'EI-3']);
    expect(r.collapsedIds.sort()).toEqual(['EI-2', 'EI-3']);
    expect(r.duplicatedTitles).toBe(1);
    expect(r.checked).toBe(3);
    expect(dropped[0].note).toBe(NOTE);
  });

  it('leaves a title with a single open EI untouched', async () => {
    const { deps, dropped } = collapseDeps([
      ei('EI-1', 'A', '2026-07-01T00:00:00Z'),
      ei('EI-2', 'B', '2026-07-01T00:00:00Z'),
    ]);
    const r = await collapseDuplicateOpenEis('demo', NOTE, deps);
    expect(dropped).toHaveLength(0);
    expect(r.duplicatedTitles).toBe(0);
    expect(r.collapsedIds).toEqual([]);
  });

  it('counts a peer-authored refusal as skippedUnmutable, not an error, and still drops its siblings', async () => {
    const { deps, dropped } = collapseDeps(
      [
        ei('EI-1', 'A', '2026-07-01T00:00:00Z'),
        ei('EI-2', 'A', '2026-07-02T00:00:00Z'),
        ei('EI-3', 'A', '2026-07-03T00:00:00Z'),
      ],
      ['EI-2'],
    );
    const r = await collapseDuplicateOpenEis('demo', NOTE, deps);
    expect(r.skippedUnmutable).toBe(1);
    expect(r.collapsedIds).toEqual(['EI-3']); // the refusal did not strand EI-3
    expect(dropped.map((d) => d.id)).toEqual(['EI-3']);
  });

  it('is DETERMINISTIC across nodes, so they cannot collectively drop every row', async () => {
    const rows = [
      ei('EI-b', 'A', '2026-07-01T00:00:00Z'),
      ei('EI-a', 'A', '2026-07-01T00:00:00Z'), // identical timestamp — id breaks the tie
      ei('EI-c', 'A', '2026-07-05T00:00:00Z'),
    ];
    // Two nodes observe the SAME replicated set in different orders.
    const nodeA = collapseDeps([...rows]);
    const nodeB = collapseDeps([...rows].reverse());
    await collapseDuplicateOpenEis('demo', NOTE, nodeA.deps);
    await collapseDuplicateOpenEis('demo', NOTE, nodeB.deps);
    const keptA = rows.filter((r) => !nodeA.dropped.some((d) => d.id === r.id)).map((r) => r.id);
    const keptB = rows.filter((r) => !nodeB.dropped.some((d) => d.id === r.id)).map((r) => r.id);
    expect(keptA).toEqual(['EI-a']);
    expect(keptB).toEqual(['EI-a']); // same survivor regardless of observation order
  });

  it('never lets a malformed createdAt win the keeper slot', async () => {
    const { deps, dropped } = collapseDeps([
      ei('EI-bad', 'A', 'not-a-date'),
      ei('EI-good', 'A', '2026-07-09T00:00:00Z'),
    ]);
    await collapseDuplicateOpenEis('demo', NOTE, deps);
    expect(dropped.map((d) => d.id)).toEqual(['EI-bad']); // the parseable row survives
  });

  it('a listing failure degrades to a no-op instead of throwing', async () => {
    const deps: DuplicateCollapseDeps = {
      listOpenByTopic: async () => {
        throw new Error('PG down');
      },
      drop: async () => {},
    };
    await expect(collapseDuplicateOpenEis('demo', NOTE, deps)).resolves.toEqual({
      checked: 0,
      duplicatedTitles: 0,
      collapsedIds: [],
      skippedUnmutable: 0,
    });
  });

  it('the VITEST gate returns an empty result without deps', async () => {
    const r = await collapseDuplicateOpenEis('demo', NOTE);
    expect(r).toEqual({
      checked: 0,
      duplicatedTitles: 0,
      collapsedIds: [],
      skippedUnmutable: 0,
    });
  });
});

/**
 * WI-37499 — `unionPopulation` is the primitive that stops a detector's sweeps
 * from being blinded by a missing topic tag. Both legs are load-bearing:
 * measured on the live store 2026-08-09, 60 open `[replication-liveness]` rows
 * matched the title prefix with NO topic edge, and 4 tagged rows did NOT match
 * the prefix — so either leg alone silently under-selects.
 */
describe('unionPopulation (WI-37499)', () => {
  type Row = { id: string; title: string };
  /** A fake store: a topic read answers `tagged`, a prefix read answers `prefixed`. */
  function reader(tagged: Row[], prefixed: Row[]) {
    const calls: Array<{ topic?: string; titlePrefix?: string }> = [];
    return {
      calls,
      read: async (f: { topic?: string; titlePrefix?: string }) => {
        calls.push(f);
        return f.topic ? tagged : prefixed;
      },
    };
  }

  it('returns the topic leg UNCHANGED — and never issues a second read — with no prefix', async () => {
    const { read, calls } = reader([{ id: 'a', title: 'A' }], [{ id: 'zzz', title: 'Z' }]);
    const rows = await unionPopulation(read, 'demo', undefined);
    expect(rows.map((r) => r.id)).toEqual(['a']);
    // Every OTHER escalator must stay byte-identical: exactly one read, topic-only.
    expect(calls).toEqual([{ topic: 'demo' }]);
  });

  it('adds title-prefixed rows the topic tag misses (the blind spot this closes)', async () => {
    const { read } = reader([{ id: 'tagged-1', title: 'A' }], [{ id: 'untagged-1', title: 'B' }]);
    const rows = await unionPopulation(read, 'demo', '[demo] ');
    expect(rows.map((r) => r.id).sort()).toEqual(['tagged-1', 'untagged-1']);
  });

  it('keeps tagged rows that do NOT match the prefix (a prefix-only read would lose them)', async () => {
    const { read } = reader([{ id: 'odd-title', title: 'does not match prefix' }], []);
    const rows = await unionPopulation(read, 'demo', '[demo] ');
    expect(rows.map((r) => r.id)).toEqual(['odd-title']);
  });

  it('dedupes by id so a correctly-tagged row is never returned (or resolved) twice', async () => {
    const { read } = reader(
      [{ id: 'same', title: 'A' }],
      [
        { id: 'same', title: 'A' },
        { id: 'extra', title: 'B' },
      ],
    );
    const rows = await unionPopulation(read, 'demo', '[demo] ');
    expect(rows.map((r) => r.id)).toEqual(['same', 'extra']);
  });
});

describe('cooldownLookbackFilter (WI-5762) — the cooldown lookback is bounded by TIME, not row count', () => {
  const NOW = Date.parse('2026-08-16T12:00:00.000Z');
  const H = 60 * 60 * 1000;

  // CONTROL: an escalator that never opted into the cooldown must be completely
  // unaffected. This is what makes the change safe for the other bindings on
  // this shared seam (precision-alert-ei, own-log-fork-ei, give-up-ei).
  it('with NO cooldown configured, emits the pre-WI-5762 filter unchanged (no createdSince)', () => {
    const f = cooldownLookbackFilter(undefined, NOW);
    expect(f).toEqual({ limit: 100 });
    expect(f.createdSince).toBeUndefined();
  });

  it('with a cooldown configured, bounds the read by created_at over the whole window', () => {
    const f = cooldownLookbackFilter(24 * H, NOW);
    expect(f.createdSince).toBe(new Date(NOW - 24 * H).toISOString());
  });

  // THE REGRESSION. The defect was that `limit: 100` — not the cooldown — decided
  // how far back the gate could see, so the lookback silently shortened as filing
  // volume rose. A time bound cannot shorten under load.
  it('the lookback horizon is independent of filing volume (the actual defect)', () => {
    const f = cooldownLookbackFilter(24 * H, NOW);
    expect(Date.parse(f.createdSince!)).toBe(NOW - 24 * H);
  });

  // CONTROL: derived from config, not a hardcoded horizon. If someone re-tunes
  // standingCooldownMs, the lookback must follow or the gate half-applies it.
  it('tracks the configured cooldown rather than a fixed horizon', () => {
    const day = cooldownLookbackFilter(24 * H, NOW);
    const twoDay = cooldownLookbackFilter(48 * H, NOW);
    expect(Date.parse(day.createdSince!)).toBe(NOW - 24 * H);
    expect(Date.parse(twoDay.createdSince!)).toBe(NOW - 48 * H);
    expect(twoDay.createdSince).not.toBe(day.createdSince);
  });

  // The boundary must line up with the gate's own comparison. The gate suppresses
  // when `Date.now() - lastFiledAt < cooldownMs`; `createdSince` is INCLUSIVE
  // (`created_at >= …`), so a row exactly on the edge is fetched and then
  // correctly NOT suppressed by the strict `<`. Erring the other way would hide
  // the edge row from the gate entirely.
  it('the horizon is exactly now - cooldownMs, matching the gate strict-< comparison', () => {
    const f = cooldownLookbackFilter(24 * H, NOW);
    expect(NOW - Date.parse(f.createdSince!)).toBe(24 * H);
    expect(NOW - Date.parse(f.createdSince!) < 24 * H).toBe(false);
  });

  it('raises the row cap alongside the time bound so the window is not re-truncated', () => {
    // At the observed peak (399 filings/day) a 24h window holds well over 100
    // rows, so leaving the cap at 100 would reintroduce truncation by the back door.
    expect(cooldownLookbackFilter(24 * H, NOW).limit).toBeGreaterThan(100);
  });
});
