/**
 * result-door-prompt.ts — the standing-context teaching for the per-result door
 * (agent-context-firewall P-015).
 *
 * The load-bearing property is ANTI-DRIFT, and it is the only one worth testing
 * hard: the number the agent is TAUGHT must be the number the door ENFORCES. A
 * test that merely asserted "the section mentions 1500" would keep passing after
 * someone changed DOOR_SPLIT — the prompt would then confidently teach a cap that
 * no longer exists, which is worse than teaching nothing, because an agent that
 * trusts a stated cap stops checking. So the assertions below drive the renderer
 * with NON-DEFAULT constants and require the output to follow them.
 */

import { describe, expect, it } from 'vitest';
import { BAKED_DOOR_CONSTANTS, computeTurnDoors, type DoorConstants } from './context-doors';
import { RESULT_DOOR_TOKENS } from './result-door';
import { MAX_PICK_PATHS } from './result-projection/parse';
import { renderResultDoorSection, resultDoorPromptSlots, resultDoorPromptTokens } from './result-door-prompt';

/** A deliberately non-default constant set: floor doubled, so every door moves. */
const RAISED: DoorConstants = { ...BAKED_DOOR_CONSTANTS, maxTurnFloorTokens: 16_000 };

describe('result-door standing-context section', () => {
  it('teaches the SAME number the door enforces', () => {
    // result-door.ts derives RESULT_DOOR_TOKENS from computeTurnDoors(0).resultEach;
    // this is the pin between the enforcement path and the prompt.
    expect(resultDoorPromptTokens()).toBe(RESULT_DOOR_TOKENS);
    expect(resultDoorPromptTokens()).toBe(computeTurnDoors(0).resultEach);
  });

  it('BITES on drift — a changed door constant changes the rendered number', () => {
    const baseline = resultDoorPromptTokens();
    const raised = resultDoorPromptTokens(RAISED);
    expect(raised).not.toBe(baseline); // the fixture must actually move the door

    const text = renderResultDoorSection(RAISED);
    expect(text).toContain(raised.toLocaleString('en-US'));
    // The stale default must NOT appear — that is exactly the drift being guarded.
    expect(text).not.toContain(`~${baseline.toLocaleString('en-US')} tokens`);
  });

  it('renders the char budget from the token budget, not a second hardcoded number', () => {
    const text = renderResultDoorSection(RAISED);
    const chars = resultDoorPromptTokens(RAISED) * 4;
    expect(text).toContain(chars.toLocaleString('en-US'));
  });

  it('states the slot count from the same source', () => {
    expect(resultDoorPromptSlots()).toBe(computeTurnDoors(0).resultSlots);
    expect(renderResultDoorSection()).toContain(`${resultDoorPromptSlots()} result slots`);
  });

  it('teaches pick for JSON and keeps pipe for line-oriented text', () => {
    // Measured 2026-08-02: an MCP result is one-line JSON, so head/grep are
    // all-or-nothing on it and only `pick` reduces it. If this guidance is ever
    // softened back to "use pipe for tool output", agents get the all-or-nothing
    // behaviour and conclude the knob is broken.
    const text = renderResultDoorSection();
    expect(text).toMatch(/ONE line/);
    expect(text).toMatch(/`pick`/);
    expect(text).toMatch(/line-oriented text/);
  });

  it('teaches the parser-enforced maximum pick-list size', () => {
    expect(renderResultDoorSection()).toContain(`at most ${MAX_PICK_PATHS} paths`);
  });

  it('warns that `projection` is a dispatch arg, not a nested tools:invoke arg', () => {
    // The nested form is rejected by the inner tool as an unknown key
    // (EI-19386035445533031) — the single most likely way to mis-send it.
    const text = renderResultDoorSection();
    expect(text).toMatch(/NOT nested in `args`/);
  });

  it('teaches the real roots of the high-risk keyed envelopes', () => {
    const text = renderResultDoorSection();

    // events:status keeps exact-key inspection under event_inspection, while
    // work_items:get nests the work-item record inside each result row and
    // leaves checkpoint on that row. Generic roots such as event.current_state
    // and results[].state silently match nothing and can be misread as null.
    expect(text).toContain('event_inspection.current_generation');
    expect(text).toContain('event_inspection.current_state');
    expect(text).toContain('results[].id", "results[].workItem.state');
    expect(text).toContain('results[].workItem.state');
    expect(text).toContain('results[].workItem.assignee');
    expect(text).toContain('results[].checkpoint');
    expect(text).not.toContain('results[].state');
  });

  it('never emits a literal splice marker (psu-prompt-isolation)', () => {
    expect(renderResultDoorSection()).not.toContain('<!-- PAPERCUSP-SU:');
  });
});
