/**
 * Per-backend parser coverage driven by REAL wire records (WI-41499).
 *
 * The sibling `session-timeline-parsers.test.ts` asserts against payloads its
 * author invented, which is why it stayed green through WI-41498: it had no
 * `custom_tool_call` case at all (170 of 176 real codex tool calls), and its
 * output case passed `output:'patched'` — a plain string, a shape no current
 * Codex build writes. A test that invents its own input can only ever confirm
 * that the parser agrees with the test author.
 *
 * Every record below comes from `transcript-wire-fixtures.ts`, transcribed off
 * live transcripts on disk. `transcript-wire-live-guard.test.ts` re-checks those
 * same fixtures against the real files, so a backend that moves a field fails
 * there by name instead of silently emptying the HUD conversation popup.
 */

import { describe, expect, it } from 'vitest';

import { createCodexTimelineParser, createOmpTimelineParser } from './session-timeline-parsers';
import { createAgentTimelineParser } from './endpoint-route/routes/harness/streams';
import { blockPayloadText, codexToolCallArgsRaw } from './transcript-wire';
import {
  ALL_WIRE_FIXTURES,
  CLAUDE_WIRE_FIXTURES,
  CODEX_WIRE_FIXTURES,
  matchesDiscriminator,
  OMP_WIRE_FIXTURES,
  resolveWirePath,
  wireLine,
  type WireFixture,
} from './transcript-wire-fixtures';

const byName = (fixtures: readonly WireFixture[], fragment: string): WireFixture => {
  const hit = fixtures.find((f) => f.name.includes(fragment));
  if (!hit) throw new Error(`no fixture matching ${JSON.stringify(fragment)}`);
  return hit;
};

const parseCodex = (f: WireFixture) => createCodexTimelineParser().parseLine(wireLine(f));
const parseOmp = (f: WireFixture) => createOmpTimelineParser().parseLine(wireLine(f));
const parseClaude = (f: WireFixture) => createAgentTimelineParser().parseLine(wireLine(f));

// ─────────────────────────────────────────────────────────────────────────────

describe('wire fixtures are self-consistent', () => {
  // A fixture that does not actually carry the fields it claims to would make
  // the live guard vacuous — it would compare an absent path against an absent
  // path and pass.
  it.each(ALL_WIRE_FIXTURES)('$backend: $fixture.name — every readField resolves', ({ fixture }) => {
    for (const path of fixture.readFields) {
      expect(resolveWirePath(fixture.record, path), `readField ${path} missing from fixture`).not.toHaveLength(0);
    }
  });

  it.each(ALL_WIRE_FIXTURES)('$backend: $fixture.name — its discriminator matches itself', ({ fixture }) => {
    expect(matchesDiscriminator(fixture.record, fixture.discriminator)).toBe(true);
  });

  it('the payload-bearing fixtures test fields their discriminator does not already imply', () => {
    // A fixture selected BY the field it asserts would make the live guard
    // vacuous for that field — it could only ever pick real records that
    // already satisfy it, so a wire change would read as "type not observed"
    // rather than a failure. That is fine for the skip-this-record fixtures
    // (they assert nothing but selection); it is not fine for the ones whose
    // content the popup renders, which is where WI-41498 actually lived.
    const payloadBearing = ALL_WIRE_FIXTURES.filter(({ fixture }) =>
      /input|output|arguments|text|thinking/.test(fixture.readFields.join(' ')));
    expect(payloadBearing.length).toBeGreaterThan(0);

    for (const { fixture } of payloadBearing) {
      const discriminated = new Set(fixture.discriminator.map((d) => d.path));
      const independent = fixture.readFields.filter((p) => !discriminated.has(p));
      expect(independent, `${fixture.name} asserts nothing its selection did not already guarantee`)
        .not.toHaveLength(0);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// codex
// ─────────────────────────────────────────────────────────────────────────────

describe('createCodexTimelineParser — real rollout records', () => {
  it('custom_tool_call carries its args in `input`, and they reach the chip', () => {
    const f = byName(CODEX_WIRE_FIXTURES, 'custom_tool_call (the ~97% case)');
    const [entry] = parseCodex(f);

    expect(entry).toMatchObject({
      kind: 'tool_use',
      toolName: 'exec',
      toolId: 'call_lX8Fyf79r9o2c2GDpsFyRkm4',
      ts: '2026-08-25T01:22:44.015Z',
    });
    // THE WI-41498 REGRESSION. The record has no `arguments` field at all, so a
    // parser that reads only `arguments` emits an undefined toolInput — a tool
    // chip naming `exec` and showing nothing it ran.
    expect(f.record.payload).not.toHaveProperty('arguments');
    expect(entry!.toolInput).toBe(
      'const hits = ALL_TOOLS.filter(x => /plans|work_items/.test(x.name));\ntext(hits);\n',
    );
  });

  it('custom_tool_call_output flattens its BLOCK ARRAY instead of dumping JSON', () => {
    const f = byName(CODEX_WIRE_FIXTURES, 'custom_tool_call_output');
    const [entry] = parseCodex(f);

    expect(entry).toMatchObject({ kind: 'tool_result', toolId: 'call_lX8Fyf79r9o2c2GDpsFyRkm4' });
    expect(entry!.text).toBe('Script completed\nWall time 0.2 seconds\nOutput:\nTotal output lines: 1');
    // The pre-fix rendering, which reached 30 of 31 results in the measured
    // session: the raw block array stringified into the pane.
    expect(entry!.text).not.toContain('input_text');
    expect(entry!.text).not.toMatch(/^\[\{/);
  });

  it('mixed text and image blocks retain a marker for the text-less block', () => {
    expect(blockPayloadText([
      { type: 'input_text', text: 'Script completed' },
      { type: 'input_image', detail: 'auto', image_url: 'data:image/png;base64,abc' },
    ])).toBe('Script completed\n[input_image]');
    expect(blockPayloadText([
      { type: 'input_image', detail: 'auto', image_url: 'data:image/png;base64,abc' },
      { type: 'input_text', text: 'Script completed' },
    ])).toBe('[input_image]\nScript completed');
  });

  it('custom_tool_call_output also arrives as a bare STRING for a still-running cell', () => {
    // 6 of the 170 outputs in the sampled rollout. The same record type carries
    // two shapes, so a reader that assumed either one alone would blank ~4% or
    // ~96% of tool results depending on which it picked.
    const f = byName(CODEX_WIRE_FIXTURES, 'still-running variant');
    const [entry] = parseCodex(f);
    expect(entry).toMatchObject({ kind: 'tool_result', toolId: 'call_9Kt2ZzQe1mLp0oR4sTuVwXyZ' });
    expect(entry!.text).toBe('Script running with cell ID 19\nWall time 31.1 seconds\nOutput:\n');
  });

  it('function_call parses its JSON-string `arguments` into structured input', () => {
    const f = byName(CODEX_WIRE_FIXTURES, 'function_call —');
    const [entry] = parseCodex(f);

    expect(entry).toMatchObject({ kind: 'tool_use', toolName: 'wait', toolId: 'call_5HVc1fREEm78u8woS1eTWvW4' });
    // Both codex tool-call shapes must land in the SAME chip vocabulary even
    // though one ships a JSON string and the other raw text.
    expect(entry!.toolInput).toEqual({ cell_id: '19', yield_time_ms: 30000, max_tokens: 12000 });
  });

  it('function_call_output flattens its block array too', () => {
    const [entry] = parseCodex(byName(CODEX_WIRE_FIXTURES, 'function_call_output'));
    expect(entry).toMatchObject({ kind: 'tool_result', text: 'Script completed\nWall time 0.0 seconds' });
  });

  it('function_call_output also preserves a bare STRING from a still-running cell', () => {
    const [entry] = parseCodex(byName(CODEX_WIRE_FIXTURES, 'function_call_output (still-running variant)'));
    expect(entry).toMatchObject({
      kind: 'tool_result',
      toolId: 'call_3NytbeubCVm4GOslHcJZ9OdL',
      text: 'Script running with cell ID 3\nWall time 31.0 seconds\nOutput:\n',
    });
  });

  it('response_item/message maps assistant → text and user → prompt', () => {
    expect(parseCodex(byName(CODEX_WIRE_FIXTURES, 'message assistant'))).toEqual([
      { kind: 'text', text: "I'm reading the active plan's `## Now` block first.", ts: '2026-08-25T01:22:43.346Z' },
    ]);
    expect(parseCodex(byName(CODEX_WIRE_FIXTURES, 'message user'))).toEqual([
      { kind: 'prompt', text: 'show the turn history', ts: '2026-08-25T01:22:36.408Z' },
    ]);
  });

  it('skips developer messages — 244 of 399 real message records', () => {
    // These are injected instruction blocks (skills, AGENTS.md). Rendering them
    // would bury the conversation under its own scaffolding.
    expect(parseCodex(byName(CODEX_WIRE_FIXTURES, 'message developer'))).toEqual([]);
  });

  it('skips reasoning whose summary is empty — which is ALL of it on this build', () => {
    // Every one of the 227 reasoning records in the sampled rollout has
    // `summary: []` and encrypted content. A parser that emitted a status entry
    // per reasoning record would add 227 blank rows to the pane.
    expect(parseCodex(byName(CODEX_WIRE_FIXTURES, 'reasoning'))).toEqual([]);
  });

  it('does not duplicate a message written as BOTH event_msg and response_item', () => {
    // Older builds wrote each visible message twice. The fixtures are from a
    // current build (response_item only); this pins the cross-generation guard.
    const parser = createCodexTimelineParser();
    const legacy = JSON.stringify({
      timestamp: 't1',
      type: 'event_msg',
      payload: { type: 'agent_message', message: 'On it.' },
    });
    const current = JSON.stringify({
      timestamp: 't1',
      type: 'response_item',
      payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'On it.' }] },
    });
    expect(parser.parseLine(legacy)).toHaveLength(1);
    expect(parser.parseLine(current)).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// omp
// ─────────────────────────────────────────────────────────────────────────────

describe('createOmpTimelineParser — real session records', () => {
  it('splits an assistant record into its thinking and toolCall blocks', () => {
    const f = byName(OMP_WIRE_FIXTURES, 'assistant thinking + toolCall');
    expect(parseOmp(f)).toEqual([
      {
        kind: 'status',
        text: "[thinking] Let me get oriented. I'm a fleet member.",
        ts: '2026-08-24T10:22:19.407Z',
      },
      {
        kind: 'tool_use',
        toolName: 'read',
        // omp ships an OBJECT here where codex ships a JSON string — the chip
        // must receive it structured either way.
        toolInput: { i: 'Read the schema before first use', path: 'xd://mcp__papercusp_su_scheduler_get_next' },
        toolId: '07224da1-9da2-442e-9967-6d0bba3703a4|fc_tmp_4c3fkj9lb5y',
        ts: '2026-08-24T10:22:19.407Z',
      },
    ]);
  });

  it('maps assistant text → text', () => {
    expect(parseOmp(byName(OMP_WIRE_FIXTURES, 'assistant text'))).toEqual([
      { kind: 'text', text: 'Claimed WI-40012; starting on the resolver.', ts: '2026-08-24T10:22:41.900Z' },
    ]);
  });

  it('treats toolResult as a message ROLE, not a content-block type', () => {
    // 216 of 585 real records. Its blocks are ordinary `text` blocks — the role
    // is the only thing that distinguishes a tool result from assistant prose,
    // so a parser that dispatched on block type alone would render every tool
    // result as the agent talking.
    const f = byName(OMP_WIRE_FIXTURES, 'toolResult role');
    const entries = parseOmp(f);
    expect(entries.map((e) => e.kind)).toEqual(['tool_result', 'tool_result']);
    expect(entries[0]!.text).toContain('scheduler:get_next');
  });

  it('maps a user record whose content is an ARRAY of text blocks → prompt', () => {
    expect(parseOmp(byName(OMP_WIRE_FIXTURES, 'user —'))).toEqual([
      { kind: 'prompt', text: '⟦turn-origin:fleet-kickoff⟧\nDrain the non-p2p bug lane.', ts: '2026-08-24T10:21:50.768Z' },
    ]);
  });

  it('skips non-message records', () => {
    expect(parseOmp(byName(OMP_WIRE_FIXTURES, 'session —'))).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// claude
// ─────────────────────────────────────────────────────────────────────────────

describe('createAgentTimelineParser — real claude transcript records', () => {
  it('maps assistant tool_use blocks to chips', () => {
    const [entry] = parseClaude(byName(CLAUDE_WIRE_FIXTURES, 'assistant tool_use'));
    expect(entry).toEqual({
      kind: 'tool_use',
      toolName: 'ToolSearch',
      toolInput: { query: 'select:work_items_get' },
      toolId: 'toolu_01XnLShooyEUAJMYYyNzn53c',
      ts: '2026-08-25T02:56:43.953Z',
    });
  });

  it('maps assistant text', () => {
    expect(parseClaude(byName(CLAUDE_WIRE_FIXTURES, 'assistant text'))).toEqual([
      { kind: 'text', text: "I'll start by re-orienting and pulling the carry.", ts: '2026-08-25T02:56:43.301Z' },
    ]);
  });

  it('maps a user tool_result — and keeps its id even when the blocks carry no text', () => {
    // Real tool_result content is not always `{type:'text'}`: a ToolSearch
    // result is `{type:'tool_reference', tool_name}`. The entry must still be
    // emitted and still carry `toolId`, so the chip pairs with its call.
    const [entry] = parseClaude(byName(CLAUDE_WIRE_FIXTURES, 'user tool_result'));
    expect(entry).toMatchObject({ kind: 'tool_result', toolId: 'toolu_01XnLShooyEUAJMYYyNzn53c' });
    expect(entry!.text).toBe('');
  });

  it('maps a bare-string user record → prompt (a real turn boundary)', () => {
    expect(parseClaude(byName(CLAUDE_WIRE_FIXTURES, 'user plain prompt'))).toEqual([
      { kind: 'prompt', text: '⟦turn-origin:self-compaction⟧\nContinue WI-41499: write the tests.', ts: '2026-08-25T02:56:37.669Z' },
    ]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('falsifiability — the PRE-FIX readers, kept as permanent controls', () => {
  // A guard that has never failed is a guard nobody has tested, and this whole
  // work-item exists because a green suite sat over a broken popup for weeks.
  //
  // These are the two reads exactly as they were BEFORE WI-41498, kept here
  // rather than reconstructed by mutating the shared tree (a mutation probe
  // holds a file wrong for the length of a suite run, and git-sync sweeps the
  // whole tree on a schedule — it has committed a mutant that way before).
  // Each control is asserted to FAIL on the same real record the real reader
  // passes, so if someone reverts the fix, or writes a new reader with the old
  // assumption, the fixtures above are provably the thing that catches it.

  /** Pre-fix: `session-timeline-parsers` read ONLY `arguments`. */
  const preFixToolArgs = (payload: Record<string, unknown>): unknown => payload.arguments;

  /** Pre-fix: anything not a string was `JSON.stringify`d into the pane. */
  const preFixOutputText = (v: unknown): string => (typeof v === 'string' ? v : JSON.stringify(v) ?? '');

  it('the pre-fix args read returns NOTHING for a real custom_tool_call', () => {
    const payload = byName(CODEX_WIRE_FIXTURES, 'custom_tool_call (the ~97% case)').record.payload as Record<string, unknown>;

    expect(preFixToolArgs(payload)).toBeUndefined();       // ← the bug: an empty chip
    expect(codexToolCallArgsRaw(payload)).toBe(payload.input); // ← calibration: the fix reads it
  });

  it('the pre-fix args read STILL WORKS for function_call — which is why it looked fine', () => {
    // The reason this survived review: the shape the old test covered was the
    // one shape the old code got right. It was also 6 of 176 real tool calls.
    const payload = byName(CODEX_WIRE_FIXTURES, 'function_call —').record.payload as Record<string, unknown>;
    expect(preFixToolArgs(payload)).toBe(payload.arguments);
    expect(codexToolCallArgsRaw(payload)).toBe(payload.arguments);
  });

  it('the pre-fix output read dumps raw JSON for a real block-array output', () => {
    const payload = byName(CODEX_WIRE_FIXTURES, 'custom_tool_call_output —').record.payload as Record<string, unknown>;

    const old = preFixOutputText(payload.output);
    expect(old).toContain('"type":"input_text"');           // ← the bug: a JSON dump in the pane
    expect(blockPayloadText(payload.output)).not.toContain('input_text'); // ← calibration
    expect(blockPayloadText(payload.output)).toContain('Script completed');
  });

  it('the pre-fix output read is CORRECT for the string variant — the other reason it hid', () => {
    const payload = byName(CODEX_WIRE_FIXTURES, 'still-running variant').record.payload as Record<string, unknown>;
    expect(preFixOutputText(payload.output)).toBe(payload.output);
    expect(blockPayloadText(payload.output)).toBe(payload.output);
  });

  it('the invented shape the OLD test used does not occur in any real fixture', () => {
    // `output: 'patched'` — a short bare string standing in for a tool result.
    // The string variant IS real, but it is a still-running cell's progress
    // text, not a completed result: no real completed output looks like this.
    // Pinning it stops the old fixture style from creeping back in.
    const outputs = CODEX_WIRE_FIXTURES
      .filter((f) => f.name.includes('output'))
      .map((f) => (f.record.payload as { output?: unknown }).output);

    expect(outputs.length).toBeGreaterThan(1);
    for (const out of outputs) {
      if (typeof out !== 'string') continue;
      expect(out.length, 'a real codex output string is a multi-line report, not a token').toBeGreaterThan(20);
    }
  });
});

describe('every backend parser survives the others’ wire', () => {
  // The route picks ONE parser per request off `sessionThinkingKey`. If a key
  // ever selects the wrong one, the honest outcome is an empty pane — never a
  // throw that kills the SSE stream for the whole session.
  it.each(ALL_WIRE_FIXTURES)('$backend: $fixture.name — no parser throws', ({ fixture }) => {
    const line = wireLine(fixture);
    for (const make of [createCodexTimelineParser, createOmpTimelineParser, createAgentTimelineParser]) {
      expect(() => make().parseLine(line)).not.toThrow();
    }
  });

  it('every parser tolerates a truncated final line (the tail of a live file)', () => {
    const partial = wireLine(CODEX_WIRE_FIXTURES[0]!).slice(0, 40);
    for (const make of [createCodexTimelineParser, createOmpTimelineParser, createAgentTimelineParser]) {
      expect(make().parseLine(partial)).toEqual([]);
    }
  });
});
