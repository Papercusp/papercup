/**
 * WI-4608: context-death detection must fire on a REAL claude-code window-overflow
 * error and NOT on the phrase "Prompt is too long" appearing as DATA a session read.
 *
 * The prior `tail.includes('Prompt is too long')` false-fired every wake for the
 * overwatch (kettle) + mug — they survey escalations, and the compaction-watchdog's
 * OWN escalations embed the phrase ("... died on \"Prompt is too long\" ..."), so
 * each read flagged them "dead" and filed a new escalation carrying the phrase: a
 * self-amplifying false-death loop, even though those turns peaked at ~3k tokens on
 * a 1M window. `tailCarriesContextDeath` keys on the phrase being the value-START of
 * an UNESCAPED JSON string (claude-code's real error entry) instead.
 *
 * The fixtures below are the EXACT shapes captured from live transcripts (2026-07-13):
 * the real death from doc-steward runs, the false positives from kettle/cup runs.
 */
import { describe, expect, it } from 'vitest';
import { tailCarriesContextDeath } from './compaction-usage';

describe('tailCarriesContextDeath — real overflow vs. phrase-as-data (WI-4608)', () => {
  it('TRUE: a real claude-code overflow — the marker is a standalone assistant text-block value', () => {
    // Exact shape from a live doc-steward context death (exit_code=1).
    const tail =
      '{"type":"assistant","message":{"model":"claude-sonnet-5[1m]","usage":{"input_tokens":0},' +
      '"content":[{"type":"text","text":"Prompt is too long"}],"context_management":null},' +
      '"parent_tool_use_id":null,"session_id":"65d428a3","uuid":"77a000db","error":"invalid_request"}\n';
    expect(tailCarriesContextDeath(tail)).toBe(true);
  });

  it('FALSE: a coord:escalations summary the overwatch/mug READ (the self-amplifying loop)', () => {
    // The phrase is embedded behind an ESCAPED quote inside a tool_result JSON string.
    const tail =
      '{"type":"user","message":{"content":[{"type":"tool_result","content":[{"type":"text",' +
      '"text":"{\\"from\\":\\"compaction-watchdog\\",\\"kind\\":\\"escalation\\",' +
      '\\"summary\\":\\"fleet member su · su-efc53 died on \\\\\\"Prompt is too long\\\\\\" — ' +
      'context overflowed its model window; it cannot take another turn\\"}"}]}]}}\n';
    expect(tailCarriesContextDeath(tail)).toBe(false);
  });

  it('FALSE: a cup/worker that Read source code containing the phrase in a comment', () => {
    // Read tool_result of this very file — the phrase sits behind an escaped quote.
    const tail =
      '{"type":"user","message":{"content":[{"type":"tool_result","content":[{"type":"text",' +
      '"text":"5329-      // names+descriptions (~165k, MEASURED) inline (that DOA\'d sessions with\\n' +
      '5330-      // \\\\\\"Prompt is too long\\\\\\"), so the up-front load is the waste."}]}]}}\n';
    expect(tailCarriesContextDeath(tail)).toBe(false);
  });

  it('FALSE: the OverwatchBrief / an assistant tool_use arg embedding the phrase mid-string', () => {
    // The overwatch composing its OWN escalation — the phrase is inside the tool_use input,
    // embedded mid-value, never the value-start of an unescaped string.
    const tail =
      '{"type":"assistant","message":{"content":[{"type":"tool_use","name":"coord:send",' +
      '"input":{"summary":"Mug/Kettle sessions dying from context-overflow — died on ' +
      '\\"Prompt is too long\\" on ~every wake"}}]}}\n';
    expect(tailCarriesContextDeath(tail)).toBe(false);
  });

  it('FALSE: an empty / marker-less tail', () => {
    expect(tailCarriesContextDeath('')).toBe(false);
    expect(tailCarriesContextDeath('{"type":"assistant","message":{"content":[{"type":"text","text":"done, all green"}]}}\n')).toBe(false);
  });

  it('TRUE: real overflow even if a hook/summary line trails the error entry', () => {
    const tail =
      '{"type":"assistant","message":{"content":[{"type":"text","text":"Prompt is too long"}]},"error":"invalid_request"}\n' +
      '{"type":"summary","isCompactSummary":false,"summary":"hook trailer"}\n';
    expect(tailCarriesContextDeath(tail)).toBe(true);
  });
});
