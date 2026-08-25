/**
 * Guard: the fixtures still match what the backends actually write (WI-41499).
 *
 * `transcript-wire-fixtures.ts` is a COPY of the wire — and a copy of a truth
 * the code does not own is exactly the thing the derived-truth ladder says will
 * drift. It cannot be DERIVED (no backend publishes a schema here), so it takes
 * the next rung: ATTEST. This reads REAL transcripts off disk and checks that
 * every field the parsers depend on is still present, with the same coarse
 * type, in real records of the same variant.
 *
 * That is the check nobody had. WI-41498 shipped because the live-stream parser
 * read `payload.arguments` while current Codex writes `custom_tool_call` with
 * `input` — a change no test could see, because every test asserted against a
 * payload its author had invented. Nothing errored; ~97% of one session's tool
 * chips simply arrived empty, and the pane looked plausible enough that it took
 * a live measurement to notice.
 *
 * SKIPS when no transcripts exist (CI, a fresh checkout). That is deliberate:
 * this is an attestation against live data, not a hermetic unit test, and a
 * guard that fabricated its own evidence to stay green would be the very defect
 * it exists to catch. It is loud where the evidence is real — on the dev box
 * and any machine that has actually run agents.
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  CLAUDE_WIRE_FIXTURES,
  CODEX_WIRE_FIXTURES,
  OMP_WIRE_FIXTURES,
  matchesDiscriminator,
  resolveWirePath,
  wireTypeOf,
  type WireFixture,
} from './transcript-wire-fixtures';

const PAPERCUSP = join(homedir(), '.papercusp');

/** Bounded: enough real records to be representative, not enough to be slow. */
const MAX_FILES_PER_BACKEND = 3;
const MAX_BYTES_PER_FILE = 12 * 1024 * 1024;

/** Every `*.jsonl` under `root`, depth-bounded, newest first. */
function newestTranscripts(root: string, depth: number): string[] {
  if (!existsSync(root)) return [];
  const found: Array<{ path: string; mtimeMs: number }> = [];
  const walk = (dir: string, left: number) => {
    let entries: import('node:fs').Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = join(dir, e.name);
      if (e.isDirectory()) {
        if (left > 0) walk(p, left - 1);
      } else if (e.isFile() && e.name.endsWith('.jsonl')) {
        try {
          const st = statSync(p);
          if (st.size > 0) found.push({ path: p, mtimeMs: st.mtimeMs });
        } catch { /* raced with a rotation — skip */ }
      }
    }
  };
  walk(root, depth);
  return found
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
    .slice(0, MAX_FILES_PER_BACKEND)
    .map((f) => f.path);
}

const BACKENDS: Array<{
  backend: 'codex' | 'omp' | 'claude';
  fixtures: readonly WireFixture[];
  roots: () => string[];
}> = [
  {
    backend: 'codex',
    fixtures: CODEX_WIRE_FIXTURES,
    // ~/.papercusp/su-codex-homes/session-<advId>/sessions/YYYY/MM/DD/rollout-*.jsonl
    roots: () => newestTranscripts(join(PAPERCUSP, 'su-codex-homes'), 6),
  },
  {
    backend: 'omp',
    fixtures: OMP_WIRE_FIXTURES,
    // ~/.papercusp/su-omp-homes/session-<advId>/agent/sessions/<munged-cwd>/*.jsonl
    roots: () => newestTranscripts(join(PAPERCUSP, 'su-omp-homes'), 5),
  },
  {
    backend: 'claude',
    fixtures: CLAUDE_WIRE_FIXTURES,
    // ~/.papercusp/session-claude/<ownerId>/projects/<munged-cwd>/<uuid>.jsonl
    roots: () => newestTranscripts(join(PAPERCUSP, 'session-claude'), 4),
  },
];

/** Parsed records from the newest transcripts for one backend. */
function readRecords(paths: string[]): unknown[] {
  const out: unknown[] = [];
  for (const p of paths) {
    let text: string;
    try {
      if (statSync(p).size > MAX_BYTES_PER_FILE) continue;
      text = readFileSync(p, 'utf8');
    } catch {
      continue;
    }
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try {
        out.push(JSON.parse(line));
      } catch { /* a torn final line of a live file — the parsers skip these too */ }
    }
  }
  return out;
}

describe('transcript wire fixtures still match the live wire', () => {
  for (const { backend, fixtures, roots } of BACKENDS) {
    describe(backend, () => {
      const paths = roots();
      const records = paths.length ? readRecords(paths) : [];

      if (records.length === 0) {
        it.skip(`no ${backend} transcripts on this machine — nothing to attest against`, () => {});
        return;
      }

      it(`read real ${backend} records to check against`, () => {
        expect(records.length).toBeGreaterThan(0);
      });

      for (const fixture of fixtures) {
        it(`${fixture.name}`, () => {
          const real = records.filter((r) => matchesDiscriminator(r, fixture.discriminator));

          // A variant this session never produced is not a failure — a rollout
          // with no `function_call` records proves nothing either way. It is
          // reported so a variant that quietly STOPS appearing everywhere is
          // still visible to someone reading the run.
          if (real.length === 0) {
            console.warn(
              `[wire-guard] ${backend}: no real record matched "${fixture.name}" ` +
              `in ${paths.length} transcript(s) — variant not observed, not disproved.`,
            );
            return;
          }

          for (const path of fixture.readFields) {
            const expected = resolveWirePath(fixture.record, path);
            expect(expected, `fixture lost its own ${path}`).not.toHaveLength(0);
            const expectedTypes = new Set(expected.map(wireTypeOf));

            // EVERY matching real record must carry the field. One that does
            // not is precisely the WI-41498 shape: the parser reads it, the
            // wire stopped writing it, and the popup renders a blank chip.
            for (const rec of real) {
              const actual = resolveWirePath(rec, path);
              expect(
                actual,
                `${backend}: real record matching "${fixture.name}" has no ${path}. ` +
                `The wire moved — update transcript-wire-fixtures.ts AND the parser that reads it.`,
              ).not.toHaveLength(0);

              const actualTypes = new Set(actual.map(wireTypeOf));
              for (const t of actualTypes) {
                expect(
                  expectedTypes,
                  `${backend}: ${path} is now "${t}" on the wire but "${[...expectedTypes].join('|')}" ` +
                  `in the fixture. A shape change here silently reshapes what the popup renders.`,
                ).toContain(t);
              }
            }
          }
        });
      }

      it('the dominant record types all have a fixture', () => {
        // The other half of drift: not a moved field, but a whole record type
        // that becomes common while no fixture — and possibly no parser branch
        // — knows about it. `custom_tool_call` itself arrived this way.
        const census = new Map<string, number>();
        for (const rec of records) {
          const r = rec as { type?: unknown; payload?: { type?: unknown }; message?: { role?: unknown } };
          const top = typeof r.type === 'string' ? r.type : '?';
          const sub = typeof r.payload?.type === 'string'
            ? r.payload.type
            : typeof r.message?.role === 'string'
              ? r.message.role
              : '';
          const key = sub ? `${top}/${sub}` : top;
          census.set(key, (census.get(key) ?? 0) + 1);
        }

        const covered = new Set<string>();
        for (const fixture of fixtures) {
          for (const rec of records) {
            if (!matchesDiscriminator(rec, fixture.discriminator)) continue;
            const r = rec as { type?: unknown; payload?: { type?: unknown }; message?: { role?: unknown } };
            const top = typeof r.type === 'string' ? r.type : '?';
            const sub = typeof r.payload?.type === 'string'
              ? r.payload.type
              : typeof r.message?.role === 'string'
                ? r.message.role
                : '';
            covered.add(sub ? `${top}/${sub}` : top);
          }
        }

        // Record types the parser deliberately ignores (telemetry, turn
        // bookkeeping, per-item completion echoes). Listed rather than inferred
        // so ADDING one is a visible decision, not a silent widening.
        const IGNORED = new Set([
          'event_msg/token_count', 'event_msg/task_started', 'event_msg/task_complete',
          'event_msg/item_completed', 'event_msg/thread_settings_applied', 'event_msg/error',
          'turn_context', 'turn_context/?', 'session_meta', 'world_state', 'compacted',
          'custom', 'custom_message', 'branch_summary', 'ttsr_injection', 'title',
          'thinking_level_change', 'model_change', 'attachment', 'permission-mode',
          'mode', 'atis-latch', 'last-prompt', 'summary', 'system', 'file-history-snapshot',
        ]);

        const total = records.length;
        const uncovered = [...census.entries()]
          .filter(([key, n]) => !covered.has(key) && !IGNORED.has(key) && n / total >= 0.02)
          .sort((a, b) => b[1] - a[1]);

        expect(
          uncovered.map(([k, n]) => `${k} (${n}, ${((n / total) * 100).toFixed(1)}%)`),
          `${backend}: record type(s) at >=2% of the wire with no fixture and no explicit ignore. ` +
          `Either the parser should read them (WI-41498 was exactly this) or add them to IGNORED.`,
        ).toEqual([]);
      });
    });
  }
});
