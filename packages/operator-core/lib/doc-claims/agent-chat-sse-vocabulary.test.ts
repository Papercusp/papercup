/**
 * Cross-writer contract: the agent-chat SSE vocabulary the operator EMITS must
 * be a subset of the vocabulary the pui TUI decoder ACCEPTS.
 *
 * WHY THIS EXISTS (EI-21748128304410352): a live interactive run of `pui`
 * rendered `agent chat stream: unsupported agent-chat SSE event ...` into the
 * Operator pane. The TUI decoder (apps/tui/src/agent_chats.rs) is deliberately
 * STRICT — its own test `rejects_event_name_type_mismatch_and_unknown_events`
 * pins that an unknown event name is an error rather than being ignored. That
 * strictness is load-bearing (it catches wire drift instead of silently
 * dropping turn content), but it means any event the operator adds on the loop
 * lane becomes a user-visible error line in the pane rather than a failing
 * test. This test moves that detection to CI, which is the half the strict
 * decoder was missing.
 *
 * DERIVED, NOT HAND-MAINTAINED (see /internal/docs/agent-insights/derived-truth-ladder):
 * both sides are parsed from the real writers, so a new event on either side
 * changes this test's inputs automatically. Do not replace either half with a
 * hand-authored list of event names — that is the drift this guard prevents.
 *
 * SCOPE — the loop lane only, on purpose. apps/tui/src/client.rs
 * `start_agent_chat_turn` is the ONLY production caller of
 * `decode_agent_chat_stream`, and it pins `engine:"loop"`, so the TUI can only
 * ever receive loop-lane frames. The legacy CLI-spawn lane emits `delta`, which
 * the TUI deliberately does not decode; that is correct, not a gap, and the
 * assertion below pins that reasoning so a future reader does not "fix" it.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = join(__dirname, '..', '..', '..', '..');
const TUI_DECODER = join(REPO_ROOT, 'apps', 'tui', 'src', 'agent_chats.rs');
const CHAT_ENGINE = join(REPO_ROOT, 'packages', 'operator-core', 'lib', 'agent-loop', 'chat-engine.ts');
const CHAT_ROUTE = join(
  REPO_ROOT,
  'packages',
  'operator-core',
  'lib',
  'endpoint-route',
  'routes',
  'agent-chats',
  'index.ts',
);

function read(path: string): string {
  return readFileSync(path, 'utf8');
}

/**
 * Event names the Rust decoder accepts, parsed from the `match
 * frame.event.as_str()` block in `decode_agent_chat_event`. Arms may be
 * or-patterns (`"text_delta" | "reasoning_delta" =>`), which is exactly the
 * shape a naive indentation-keyed grep misses.
 */
export function acceptedByTuiDecoder(source: string): Set<string> {
  const start = source.indexOf('match frame.event.as_str()');
  if (start === -1) throw new Error('decode_agent_chat_event match block not found in agent_chats.rs');
  const end = source.indexOf('other =>', start);
  if (end === -1) throw new Error('catch-all `other =>` arm not found; decoder shape changed');
  const block = source.slice(start, end);

  const accepted = new Set<string>();
  // Match arm heads: one or more "name" literals separated by `|`, then `=>`.
  const armRe = /((?:"[a-z_]+"\s*\|\s*)*"[a-z_]+")\s*=>/g;
  for (const m of block.matchAll(armRe)) {
    for (const lit of m[1].matchAll(/"([a-z_]+)"/g)) accepted.add(lit[1]);
  }
  return accepted;
}

/**
 * Event names the OWNED loop lane emits. Two sources:
 *  - explicit `opts.sink.event('name', ...)` / `sink.event('name', ...)` calls;
 *  - the pass-through `opts.sink.event(ev.type, ev)` in chat-engine.ts, which
 *    forwards the loop's own `ev.type` verbatim for the `case` labels that fall
 *    into it. Those case labels ARE wire event names and are invisible to a
 *    search for quoted sink.event arguments.
 */
export function emittedByLoopLane(engineSource: string, routeSource: string): Set<string> {
  const emitted = new Set<string>();

  for (const m of engineSource.matchAll(/\bsink\.event\(\s*'([a-z_]+)'/g)) emitted.add(m[1]);

  // Pass-through: collect `case 'x':` labels that reach `sink.event(ev.type, ev)`.
  const passThroughIdx = engineSource.indexOf('sink.event(ev.type, ev)');
  if (passThroughIdx === -1) {
    throw new Error(
      'chat-engine.ts no longer forwards `sink.event(ev.type, ev)`; update this guard to match the new shape',
    );
  }
  const beforePassThrough = engineSource.slice(0, passThroughIdx);
  const lastBreak = beforePassThrough.lastIndexOf('break;');
  const caseRun = beforePassThrough.slice(lastBreak === -1 ? 0 : lastBreak);
  for (const m of caseRun.matchAll(/case\s+'([a-z_]+)'\s*:/g)) emitted.add(m[1]);

  // Route-level loop-lane emitters live BEFORE the legacy CLI-spawn lane marker.
  const legacyIdx = routeSource.indexOf('legacy CLI-spawn engine lane');
  const loopRegion = legacyIdx === -1 ? routeSource : routeSource.slice(0, legacyIdx);
  for (const m of loopRegion.matchAll(/\bsink\.event\(\s*'([a-z_]+)'/g)) emitted.add(m[1]);

  return emitted;
}

describe('agent-chat SSE vocabulary: operator emits ⊆ pui TUI decodes', () => {
  const tui = read(TUI_DECODER);
  const engine = read(CHAT_ENGINE);
  const route = read(CHAT_ROUTE);

  const accepted = acceptedByTuiDecoder(tui);
  const emitted = emittedByLoopLane(engine, route);

  it('parses a non-trivial vocabulary from both writers', () => {
    // Calibration: if either parser silently matched nothing, the subset
    // assertion below would pass vacuously and report a false green.
    expect(accepted.size).toBeGreaterThanOrEqual(8);
    expect(emitted.size).toBeGreaterThanOrEqual(6);
    expect(accepted.has('done')).toBe(true);
    expect(emitted.has('done')).toBe(true);
    // The or-pattern arm is the one a naive grep misses; pin it explicitly.
    expect(accepted.has('text_delta')).toBe(true);
    expect(accepted.has('reasoning_delta')).toBe(true);
    // The pass-through case labels are the other invisible half.
    expect(emitted.has('step_start')).toBe(true);
  });

  it('every loop-lane event the operator emits is decodable by the TUI', () => {
    const undecodable = [...emitted].filter((name) => !accepted.has(name)).sort();
    expect(
      undecodable,
      `The operator's loop lane emits agent-chat SSE event(s) the pui TUI decoder does not handle: ` +
        `${JSON.stringify(undecodable)}. The decoder is deliberately strict, so each of these renders ` +
        `\`unsupported agent-chat SSE event\` into the user's Operator pane at runtime (EI-21748128304410352). ` +
        `Fix by adding the arm(s) to decode_agent_chat_event in apps/tui/src/agent_chats.rs — not by ` +
        `relaxing the decoder, and not by editing this list.`,
    ).toEqual([]);
  });

  it('pins that the legacy lane `delta` is intentionally not decoded', () => {
    // start_agent_chat_turn pins engine:"loop", so legacy frames never reach
    // the decoder. If the TUI ever stops pinning the loop engine, this
    // assertion is the tripwire that says the legacy vocabulary now matters.
    expect(read(join(REPO_ROOT, 'apps', 'tui', 'src', 'agent_chats.rs'))).toContain('"engine": "loop"');
    expect(accepted.has('delta')).toBe(false);
  });

  it('accepts the shared SSE wrapper keepalive', () => {
    // `heartbeat` is injected by the shared SSE response helper rather than by
    // either lane, so it is not in `emitted` and needs its own assertion.
    expect(accepted.has('heartbeat')).toBe(true);
  });
});

/**
 * FALSIFIABILITY CONTROLS — permanent, and deliberately synthetic.
 *
 * The subset assertion above currently passes, and a guard that has never
 * failed is a guard nobody has tested. These controls prove each parser
 * actually discriminates, WITHOUT mutating the real tree: on this shared
 * checkout a copy-out/restore probe races the git-sync sweep, which can commit
 * the mutant even when nothing goes wrong (see CLAUDE.md, "Proving a guard is
 * falsifiable"). Both parsers are pure functions of a source string, so
 * feeding them crafted sources is the zero-risk tier.
 */
describe('vocabulary parsers discriminate (controls)', () => {
  const DECODER_WITHOUT_SURPRISE = `
    match frame.event.as_str() {
        "heartbeat" => {}
        "text_delta" | "reasoning_delta" => {}
        "done" => {}
        other => Err(anyhow!("unsupported agent-chat SSE event \`{other}\`")),
    }`;

  it('detects an emitted event the decoder does not accept', () => {
    const accepted = acceptedByTuiDecoder(DECODER_WITHOUT_SURPRISE);
    const engine = `
      switch (ev.type) {
        case 'text_delta':
        case 'surprise_event':
          opts.sink.event(ev.type, ev);
          break;
      }
      opts.sink.event('done', {});`;
    const emitted = emittedByLoopLane(engine, '');
    // The pass-through case label is the shape a quoted-argument search misses.
    expect(emitted.has('surprise_event')).toBe(true);
    const undecodable = [...emitted].filter((n) => !accepted.has(n));
    expect(undecodable).toEqual(['surprise_event']);
  });

  it('does not credit the decoder for an or-pattern member it lacks', () => {
    const accepted = acceptedByTuiDecoder(DECODER_WITHOUT_SURPRISE);
    expect(accepted.has('text_delta')).toBe(true);
    expect(accepted.has('reasoning_delta')).toBe(true);
    expect(accepted.has('tool_call')).toBe(false);
  });

  it('ignores legacy-lane emitters that follow the lane marker', () => {
    const route = `
      sink.event('provenance', {});
      // ── legacy CLI-spawn engine lane ──
      sink.event('delta', { text });`;
    const emitted = emittedByLoopLane("opts.sink.event(ev.type, ev)\ncase 'step_start':", route);
    expect(emitted.has('provenance')).toBe(true);
    expect(emitted.has('delta')).toBe(false);
  });

  it('fails loudly if the pass-through shape disappears rather than passing vacuously', () => {
    expect(() => emittedByLoopLane("sink.event('done', {})", '')).toThrow(/no longer forwards/);
  });
});
