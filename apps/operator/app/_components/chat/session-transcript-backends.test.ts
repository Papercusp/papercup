/**
 * The HUD conversation popup, end to end, per backend (WI-41499).
 *
 * The popup renders `mapSessionTimeline(parser(line))` — a backend's raw
 * transcript line, through that backend's parser, into `ChatMessage[]`. Every
 * existing test covers ONE of those two hops with hand-written input to the
 * second, so all three of WI-41496/97/98 were invisible: the omp popup streamed
 * permanently empty, and ~97% of codex tool chips rendered naming a tool with
 * nothing it was called with. Both look like "the agent is quiet", not a bug.
 *
 * These run REAL wire records (from `transcript-wire-fixtures`, transcribed off
 * live transcripts) all the way to the messages the owner sees. The assertions
 * are deliberately about RENDERED CONTENT — a chip's input, a message's text —
 * because emptiness is exactly the failure that kept passing.
 */

import { describe, expect, it } from 'vitest';

import { mapSessionTimeline } from './session-transcript-mapping';
import type { TimelineEntry } from '../../harness/AgentThinkingStream';
import {
  createCodexTimelineParser,
  createOmpTimelineParser,
} from '@papercusp/operator-core/lib/session-timeline-parsers';
import { createAgentTimelineParser } from '@papercusp/operator-core/lib/endpoint-route/routes/harness/streams';

/** Run a whole mini-transcript through one backend's parser, as the route does. */
function runTranscript(
  makeParser: () => { parseLine(line: string): TimelineEntry[]; flush(): TimelineEntry[] },
  records: unknown[],
): TimelineEntry[] {
  const parser = makeParser();
  const entries: TimelineEntry[] = [];
  for (const rec of records) entries.push(...parser.parseLine(JSON.stringify(rec)));
  entries.push(...parser.flush());
  return entries;
}

// ── One real turn per backend: owner asks, agent answers, agent runs a tool ──

const CODEX_TURN = [
  {
    timestamp: '2026-08-25T01:22:36.408Z',
    type: 'response_item',
    payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'show the turn history' }] },
  },
  // 244 of 399 real message records are injected instruction blocks.
  {
    timestamp: '2026-08-25T01:22:36.500Z',
    type: 'response_item',
    payload: { type: 'message', role: 'developer', content: [{ type: 'input_text', text: '<skills_instructions>…' }] },
  },
  {
    timestamp: '2026-08-25T01:22:43.346Z',
    type: 'response_item',
    payload: {
      type: 'message', role: 'assistant', phase: 'final',
      content: [{ type: 'output_text', text: 'Reading the rollout now.' }],
    },
  },
  {
    timestamp: '2026-08-25T01:22:44.015Z',
    type: 'response_item',
    payload: {
      type: 'custom_tool_call', name: 'exec', call_id: 'call_lX8F', status: 'completed',
      input: 'text(ALL_TOOLS.length)\n',
    },
  },
  {
    timestamp: '2026-08-25T01:22:44.289Z',
    type: 'response_item',
    payload: {
      type: 'custom_tool_call_output', call_id: 'call_lX8F',
      output: [{ type: 'input_text', text: 'Script completed\nWall time 0.2 seconds' }],
    },
  },
];

const OMP_TURN = [
  { type: 'session', id: '01a0334a', timestamp: '2026-08-24T10:21:33.155Z', version: '0.4.11' },
  {
    type: 'message', id: 'evt_1', timestamp: '2026-08-24T10:21:50.768Z',
    message: { role: 'user', content: [{ type: 'text', text: 'drain the non-p2p bug lane' }] },
  },
  {
    type: 'message', id: 'evt_2', timestamp: '2026-08-24T10:22:19.407Z',
    message: {
      role: 'assistant',
      content: [
        { type: 'thinking', thinking: 'Let me get oriented.' },
        {
          type: 'toolCall', name: 'read',
          id: '07224da1|fc_tmp_4c3f',
          arguments: { path: 'xd://mcp__papercusp_su_scheduler_get_next' },
          intent: 'Read the schema before first use',
        },
      ],
    },
  },
  {
    type: 'message', id: 'evt_3', parentId: 'evt_2', timestamp: '2026-08-24T10:22:20.534Z',
    message: { role: 'toolResult', content: [{ type: 'text', text: '# scheduler:get_next — claim the next item.' }] },
  },
  {
    type: 'message', id: 'evt_4', timestamp: '2026-08-24T10:22:41.900Z',
    message: { role: 'assistant', content: [{ type: 'text', text: 'Claimed WI-40012.' }] },
  },
];

const CLAUDE_TURN = [
  {
    type: 'user', uuid: 'u1', sessionId: 'c0ed9f5c', timestamp: '2026-08-25T02:56:37.669Z',
    message: { content: 'write the per-backend tests' },
  },
  {
    type: 'assistant', uuid: 'a1', sessionId: 'c0ed9f5c', timestamp: '2026-08-25T02:56:43.301Z',
    message: { content: [{ type: 'text', text: 'Starting with the fixtures.' }] },
  },
  {
    type: 'assistant', uuid: 'a2', sessionId: 'c0ed9f5c', timestamp: '2026-08-25T02:56:43.953Z',
    message: {
      content: [{ type: 'tool_use', name: 'Read', id: 'toolu_01Xn', input: { file_path: 'lib/transcript-wire.ts' } }],
    },
  },
  {
    type: 'user', uuid: 'u2', sessionId: 'c0ed9f5c', timestamp: '2026-08-25T02:56:46.171Z',
    message: {
      content: [{ type: 'tool_result', tool_use_id: 'toolu_01Xn', content: 'export function blockPayloadText…' }],
    },
  },
];

const BACKENDS = [
  { backend: 'codex', parser: createCodexTimelineParser, records: CODEX_TURN, prompt: 'show the turn history', tool: 'exec' },
  { backend: 'omp', parser: createOmpTimelineParser, records: OMP_TURN, prompt: 'drain the non-p2p bug lane', tool: 'read' },
  { backend: 'claude', parser: createAgentTimelineParser, records: CLAUDE_TURN, prompt: 'write the per-backend tests', tool: 'Read' },
] as const;

describe('a real turn reaches the popup — every backend', () => {
  it.each(BACKENDS)('$backend: renders a non-empty conversation', ({ parser, records, prompt }) => {
    // THE WI-41496 SHAPE. An omp popup that renders nothing is indistinguishable
    // from an agent that has not spoken yet, which is why it went unnoticed
    // against a transcript that was 25 KB and actively being appended.
    const messages = mapSessionTimeline(runTranscript(parser, records)).messages;

    expect(messages.length).toBeGreaterThan(0);
    expect(messages[0]).toMatchObject({ role: 'user', content: prompt });
    expect(messages.some((m) => m.role === 'assistant')).toBe(true);
  });

  it.each(BACKENDS)('$backend: the tool chip carries what the tool was CALLED WITH', ({ parser, records, tool }) => {
    // THE WI-41498 SHAPE, at the layer the owner actually sees. The parser
    // emitting `toolInput: undefined` produced a chip naming a tool and showing
    // nothing — a wall of contentless `exec` rows that still looked like a
    // populated pane.
    const messages = mapSessionTimeline(runTranscript(parser, records)).messages;
    const chips = messages.flatMap((m) => m.tools ?? []);

    expect(chips.map((c) => c.name)).toContain(tool);
    const chip = chips.find((c) => c.name === tool)!;
    expect(chip.input).toBeDefined();
    expect(chip.input).not.toBeNull();
    expect(JSON.stringify(chip.input)).not.toBe('{}');
    expect(String(JSON.stringify(chip.input)).length).toBeGreaterThan(2);
  });

  it.each(BACKENDS)('$backend: the assistant text is the agent’s words, not a JSON dump', ({ parser, records }) => {
    const messages = mapSessionTimeline(runTranscript(parser, records)).messages;
    const assistant = messages.filter((m) => m.role === 'assistant');

    expect(assistant.length).toBeGreaterThan(0);
    for (const m of assistant) {
      // The pre-fix codex rendering leaked the raw block array into the pane.
      expect(m.content ?? '').not.toContain('"type":"input_text"');
      expect(m.content ?? '').not.toMatch(/^\[\{"type"/);
    }
  });

  it.each(BACKENDS)('$backend: tool RESULTS are dropped as noise, chips are kept', ({ parser, records }) => {
    // The mapping's own contract — asserted here per backend because each one
    // signals a tool result differently (a role, a record type, a block type),
    // and a backend whose results leaked through would bury the conversation.
    const entries = runTranscript(parser, records);
    expect(entries.some((e) => e.kind === 'tool_result')).toBe(true);

    const messages = mapSessionTimeline(entries).messages;
    const rendered = messages.map((m) => m.content ?? '').join('\n');
    expect(rendered).not.toContain('Wall time');
    expect(rendered).not.toContain('claim the next item');
    expect(rendered).not.toContain('export function blockPayloadText');
  });
});

describe('per-backend noise filtering', () => {
  it('codex: injected developer instruction blocks never reach the owner', () => {
    const messages = mapSessionTimeline(runTranscript(createCodexTimelineParser, CODEX_TURN)).messages;
    expect(JSON.stringify(messages)).not.toContain('skills_instructions');
  });

  it('omp: thinking is a status entry and is filtered out of the chat rendering', () => {
    const entries = runTranscript(createOmpTimelineParser, OMP_TURN);
    expect(entries.some((e) => e.kind === 'status' && e.text?.startsWith('[thinking]'))).toBe(true);

    const messages = mapSessionTimeline(entries).messages;
    expect(JSON.stringify(messages)).not.toContain('Let me get oriented');
  });

  it('omp: a machine-injected kickoff is NOT rendered as the owner speaking', () => {
    // Cross-check with the envelope rule the mapping already enforces: an omp
    // fleet member's first user record is a kickoff, not a person.
    const kickoff = [{
      type: 'message', id: 'evt_0', timestamp: '2026-08-24T10:21:50.768Z',
      message: { role: 'user', content: [{ type: 'text', text: '⟦turn-origin:fleet-kickoff nonce:1c032720⟧\nDrain the lane.' }] },
    }];
    const messages = mapSessionTimeline(runTranscript(createOmpTimelineParser, kickoff)).messages;
    expect(messages.filter((m) => m.role === 'user')).toEqual([]);
  });

  it('every backend maps its own turn boundary — one prompt, one turn', () => {
    for (const { backend, parser, records } of BACKENDS) {
      const messages = mapSessionTimeline(runTranscript(parser, records)).messages;
      expect(messages.filter((m) => m.role === 'user'), `${backend} turn count`).toHaveLength(1);
    }
  });
});

describe('anchor translation survives the parser hop', () => {
  it.each(BACKENDS)('$backend: every entry index maps to a real message or -1', ({ parser, records }) => {
    // The stream's search deep-link answers with an index into the FLAT entry
    // array; the mapper collapses that array, so the two indices are not
    // interchangeable. Per backend because each produces a different entry
    // count for the same visible turn.
    const entries = runTranscript(parser, records);
    const mapped = mapSessionTimeline(entries);

    expect(entries.length).toBeGreaterThan(0);
    for (let i = 0; i < entries.length; i++) {
      const idx = mapped.messageIndexForEntryIndex(i);
      expect(idx === -1 || (idx >= 0 && idx < mapped.messages.length)).toBe(true);
    }
    // Out of range is answered, not thrown.
    expect(mapped.messageIndexForEntryIndex(entries.length + 50)).toBe(-1);
  });
});
