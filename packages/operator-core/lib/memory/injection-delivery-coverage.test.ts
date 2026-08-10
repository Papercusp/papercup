/**
 * injection-delivery-coverage.test.ts — the per-(client, PORT) grain (WI-37597).
 *
 * This module shipped able to answer "is this client being served context?" and
 * unable to answer it per port, which made one specific failure undetectable:
 * `recordInjectionCoverage` was called from `mid-turn-context.ts` and NOWHERE
 * else, so `context_injection_coverage` had never held a single `turn-start` row
 * for any client — while the reader summed both ports into one per-client number
 * that healthy mid-turn traffic kept green.
 *
 * So a turn-start outage was invisible twice over: nothing wrote the rows, and
 * nothing would have compared them if it had. That is why EI-20001110634702380,
 * a real turn-start injection failure, closed cause-undetermined.
 *
 * Two properties are guarded here:
 *   1. FOLD — one port's traffic must never make another port look observed.
 *   2. WRITERS — every port in the vocabulary must have a production writer,
 *      because a declared-but-unwritten port is exactly the state above.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import {
  foldInjectionCoverage,
  INJECTION_PORTS,
  type CoverageWindowRow,
  type CoverageEverRow,
} from './injection-delivery-coverage';

const fold = (o: {
  clients?: string[];
  windowRows?: CoverageWindowRow[];
  everRows?: CoverageEverRow[];
  sessions?: [string, number][];
}) =>
  foldInjectionCoverage({
    clients: o.clients ?? ['claude'],
    windowRows: o.windowRows ?? [],
    everRows: o.everRows ?? [],
    sessionsBy: new Map(o.sessions ?? [['claude', 10]]),
  });

const portOf = (c: { ports: { port: string }[] }, port: string) => {
  const hit = c.ports.find((p) => p.port === port);
  if (!hit) throw new Error(`no ${port} entry — ports must always carry every port`);
  return hit as { port: string; events: number; everObserved: boolean; driftTools: string[] };
};

describe('foldInjectionCoverage — one port must never mask another', () => {
  it('does NOT let heavy mid-turn traffic make turn-start look observed', () => {
    // The exact live shape on 2026-08-09: claude's mid-turn port working hard,
    // its turn-start port never having written a row in its life.
    const { clients } = fold({
      windowRows: [{ client: 'claude', port: 'mid-turn', outcome: 'recalled', tool: '', n: 500 }],
      everRows: [{ client: 'claude', port: 'mid-turn' }],
    });
    const c = clients[0]!;

    const turnStart = portOf(c, 'turn-start');
    expect(turnStart.events).toBe(0);
    // The load-bearing assertion. If this ever reads `true`, a dead turn-start
    // port has been handed a baseline it did not earn, and the classifier will
    // score it 'ok' forever.
    expect(turnStart.everObserved).toBe(false);

    expect(portOf(c, 'mid-turn').events).toBe(500);
    expect(portOf(c, 'mid-turn').everObserved).toBe(true);

    // The client-level total still sums both ports — the per-port view is an
    // addition, not a replacement.
    expect(c.events).toBe(500);
    expect(c.everObserved).toBe(true);
  });

  it('keeps a baselined-but-silent port distinguishable from a never-observed one', () => {
    // turn-start HAS written before and is silent now (a real regression);
    // mid-turn has never written at all (a known gap). The two must not blur —
    // only the first is ever pageable.
    const { clients } = fold({ everRows: [{ client: 'claude', port: 'turn-start' }] });
    const c = clients[0]!;
    expect(portOf(c, 'turn-start').everObserved).toBe(true);
    expect(portOf(c, 'turn-start').events).toBe(0);
    expect(portOf(c, 'mid-turn').everObserved).toBe(false);
  });

  it('attributes drift tools to the port that actually drifted', () => {
    const { clients } = fold({
      windowRows: [
        { client: 'claude', port: 'mid-turn', outcome: 'unknown-tool', tool: 'Edit', n: 3 },
        { client: 'claude', port: 'turn-start', outcome: 'recalled', tool: '', n: 1 },
      ],
      everRows: [
        { client: 'claude', port: 'mid-turn' },
        { client: 'claude', port: 'turn-start' },
      ],
    });
    const c = clients[0]!;
    expect(portOf(c, 'mid-turn').driftTools).toEqual(['Edit']);
    expect(portOf(c, 'turn-start').driftTools).toEqual([]);
    // …while the client-level roll-up still sees it.
    expect(c.driftTools).toEqual(['Edit']);
    expect(c.byOutcome['unknown-tool']).toBe(3);
  });

  it('always emits every port, in vocabulary order, even with no rows at all', () => {
    // A missing entry and a zeroed entry read identically to a consumer looping
    // over what it was given — and the zeroed one is the whole signal.
    const { clients } = fold({ clients: ['claude', 'codex', 'omp'], sessions: [] });
    expect(clients).toHaveLength(3);
    for (const c of clients) {
      expect(c.ports.map((p) => p.port)).toEqual([...INJECTION_PORTS]);
      expect(c.events).toBe(0);
      expect(c.everObserved).toBe(false);
    }
  });

  it('never credits one CLIENT with another client’s rows', () => {
    // Same blend, the other axis — the key is (client, port), not either alone.
    const { clients } = fold({
      clients: ['claude', 'omp'],
      windowRows: [{ client: 'claude', port: 'turn-start', outcome: 'recalled', tool: '', n: 7 }],
      everRows: [{ client: 'claude', port: 'turn-start' }],
      sessions: [
        ['claude', 5],
        ['omp', 5],
      ],
    });
    const omp = clients.find((c) => c.client === 'omp')!;
    expect(omp.events).toBe(0);
    expect(portOf(omp, 'turn-start').everObserved).toBe(false);
  });

  it('CONTROL: the client-keyed fold this replaced DOES mask the dead port', () => {
    // A deliberately-wrong reimplementation, kept permanently so the assertions
    // above are demonstrably falsifiable rather than merely descriptive of
    // today's behavior. This is the pre-WI-37597 logic: `ever` keyed on CLIENT
    // alone, exactly as the shipped reader did it.
    const rows: CoverageEverRow[] = [{ client: 'claude', port: 'mid-turn' }];
    const everByClientOnly = new Set(rows.map((r) => r.client));

    // Under the old keying a turn-start port that has NEVER written inherits a
    // baseline from its mid-turn sibling…
    expect(everByClientOnly.has('claude')).toBe(true);

    // …while the shipped fold refuses to.
    const { clients } = fold({ everRows: rows });
    expect(portOf(clients[0]!, 'turn-start').everObserved).toBe(false);

    // If these two ever agree, the masking is back: a dead turn-start port would
    // be handed a baseline it never earned, and classifyInjectionClient would
    // score it 'ok' forever instead of 'never-observed'.
  });

  it('sums the client total from exactly its ports', () => {
    const { clients, totalEvents } = fold({
      windowRows: [
        { client: 'claude', port: 'turn-start', outcome: 'recalled', tool: '', n: 2 },
        { client: 'claude', port: 'mid-turn', outcome: 'no-recall', tool: '', n: 3 },
      ],
    });
    const c = clients[0]!;
    expect(c.events).toBe(c.ports.reduce((a, p) => a + p.events, 0));
    expect(c.events).toBe(5);
    expect(totalEvents).toBe(5);
  });
});

// ── every declared port must have a production WRITER ────────────────────────

/**
 * Which ports are written by production code, derived from the source of the
 * files that actually call the recorder.
 *
 * PURE, and takes its corpus as an argument, so it can be pointed at a synthetic
 * one — which is the only way to prove this census can FAIL. A guard whose
 * negative has never been demonstrated is not a guard.
 */
export function portsWithWriters(sources: readonly { path: string; text: string }[]): Set<string> {
  const ports = new Set<string>();
  for (const { text } of sources) {
    if (!/recordInjectionCoverage\s*\(/.test(text)) continue;
    for (const m of text.matchAll(/port:\s*'([^']+)'/g)) ports.add(m[1]!);
  }
  return ports;
}

/** The dirs an injection writer legitimately lives in. A writer added outside
 *  these fails the census LOUDLY rather than silently passing — the safe
 *  direction: the fix is to widen this list on purpose. */
const WRITER_ROOTS = ['endpoint-route/routes/agent-mcp', 'memory'];

function readSources(): { path: string; text: string }[] {
  const libDir = fileURLToPath(new URL('../', import.meta.url));
  const out: { path: string; text: string }[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) {
        if (entry !== 'node_modules' && entry !== '_retired') walk(full);
        continue;
      }
      if (!entry.endsWith('.ts') || entry.includes('.test.')) continue;
      out.push({ path: full, text: readFileSync(full, 'utf8') });
    }
  };
  for (const root of WRITER_ROOTS) walk(join(libDir, root));
  return out;
}

describe('every declared injection port has a production writer', () => {
  it('finds a writer for every port in INJECTION_PORTS', () => {
    const written = portsWithWriters(readSources());
    for (const port of INJECTION_PORTS) {
      expect(
        written.has(port),
        `port '${port}' is in INJECTION_PORTS but NOTHING in production writes it. ` +
          `A declared-but-unwritten port cannot be distinguished from a dead one — ` +
          `that is the WI-37597 defect. Add its recordInjectionCoverage call, or ` +
          `remove the port from the vocabulary.`,
      ).toBe(true);
    }
  });

  it('CONTROL: reports the gap when a port has no writer', () => {
    // The pre-WI-37597 tree, exactly: a mid-turn writer and no turn-start one.
    // If this ever passes as "both written", the census has stopped measuring.
    const written = portsWithWriters([
      { path: 'mid-turn-context.ts', text: `void recordInjectionCoverage([{ port: 'mid-turn' }])` },
      // A file that mentions the port but never records — the shape that makes a
      // naive grep say "covered". turn-start-memory.ts genuinely looked like this:
      // it carried `port: 'turn-start'` for memory_recall_stats, a DIFFERENT sink.
      { path: 'turn-start-memory.ts', text: `session: { port: 'turn-start' }` },
    ]);
    expect(written.has('mid-turn')).toBe(true);
    expect(written.has('turn-start')).toBe(false);
  });

  it('CALIBRATION: reports both when both are genuinely written', () => {
    const written = portsWithWriters([
      { path: 'a.ts', text: `recordInjectionCoverage([{ port: 'mid-turn' }])` },
      { path: 'b.ts', text: `recordInjectionCoverage([{ port: 'turn-start' }])` },
    ]);
    expect([...written].sort()).toEqual(['mid-turn', 'turn-start']);
  });
});
