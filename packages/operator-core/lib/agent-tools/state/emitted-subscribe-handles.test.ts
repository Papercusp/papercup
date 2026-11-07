/**
 * EVERY `state:subscribe` HANDLE THE PLATFORM EMITS MUST BE A CALL THE TOOL ACCEPTS.
 * (state-plane-interest-and-hardening-2026-08-21 P-004.)
 *
 * ── the class this exists to stop coming back ────────────────────────────────
 *
 * Several tools hand the agent a ready-made follow-up call — `dev:pipeline_position`
 * and `release:checkpoint-run` both emit `state:subscribe { cell:
 * 'gate.greenCheckpoint.verdict' }` with the reason "wait for the verdict to CHANGE
 * instead of re-polling this tool". Those handles landed 2026-08-02. `on` was a
 * REQUIRED argument, so the suggested call could not be made.
 *
 * Measured consequence, from 2026-08-09 (a week later) through 2026-08-19: twelve
 * `state:subscribe` calls that passed no `on`, from ELEVEN DISTINCT AGENTS, on exactly
 * ONE cell — `gate.greenCheckpoint.verdict`. Every one was rejected. Eleven agents did
 * not independently misread a schema; they each followed a handle the platform gave
 * them, and the platform was wrong. The invalid_args refusal blamed the caller, so it
 * read as eleven separate agent errors rather than one platform defect, which is why it
 * survived ten days and only surfaced under a deliberate census.
 *
 * A handle is an INSTRUCTION. Emitting one that cannot be executed is worse than
 * emitting none: it costs the agent a turn, and its refusal teaches a wrong lesson
 * about a tool that was fine. So the two halves must be pinned to each other, and
 * neither the emitters nor the schema can move without this failing.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import subscribeTool from './subscribe';
import { emittedSubscribeSelectors } from '../plans/tree-instruments';

const AGENT_TOOLS_ROOT = join(__dirname, '..');

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) return walk(full);
    return full.endsWith('.ts') && !full.endsWith('.test.ts') ? [full] : [];
  });
}

interface EmittedHandle {
  file: string;
  selector: string;
  args: unknown;
}

/**
 * Find `tool: 'state:subscribe'` paired with its `selector:` literal. The selector is a
 * JS object literal in a string (`"{ cell: 'x' }"`), quoted with ' " or a backtick, so
 * it is evaluated rather than JSON-parsed. The input is this repo's own source.
 */
function collectEmittedHandles(): EmittedHandle[] {
  return walk(AGENT_TOOLS_ROOT).flatMap((file) => {
    const src = readFileSync(file, 'utf8');
    const found: EmittedHandle[] = [];
    for (const { selector } of emittedSubscribeSelectors(file.slice(AGENT_TOOLS_ROOT.length + 1), src)) {
      let args: unknown;
      try {
        args = new Function(`return (${selector})`)();
      } catch {
        args = { __unparseable: selector };
      }
      found.push({ file: file.slice(AGENT_TOOLS_ROOT.length + 1), selector, args });
    }
    return found;
  });
}

const handles = collectEmittedHandles();

describe('emitted state:subscribe handles', () => {
  it('POSITIVE CONTROL — the scan actually finds handles', () => {
    // Without this, every assertion below passes vacuously the moment the regex stops
    // matching (a reformat, a renamed field, a moved directory) — an empty scan is
    // indistinguishable from a clean one, which is the failure mode this whole file is
    // about. The known emitters are dev/pipeline_position.ts and release/checkpoint-run.ts.
    expect(handles.length).toBeGreaterThanOrEqual(2);
    expect(new Set(handles.map((h) => h.file)).size).toBeGreaterThanOrEqual(2);
  });

  it('every emitted selector is a literal this test could parse', () => {
    const unparseable = handles.filter(
      (h) => typeof h.args === 'object' && h.args !== null && '__unparseable' in h.args,
    );
    expect(unparseable).toEqual([]);
  });

  it('EVERY emitted selector is accepted by state:subscribe\'s real schema', () => {
    // The pin. `on` being optional is what makes the long-standing
    // `{ cell: 'gate.greenCheckpoint.verdict' }` handles executable; if anyone makes it
    // required again, or adds an emitter with a shape the tool rejects, this names the
    // exact file and selector rather than letting agents discover it one wasted turn
    // at a time.
    const rejected = handles
      .map((h) => ({ ...h, parsed: subscribeTool.args.safeParse(h.args) }))
      .filter((h) => !h.parsed.success)
      .map((h) => `${h.file}: ${h.selector} — ${h.parsed.success ? '' : h.parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`);

    expect(rejected).toEqual([]);
  });

  it('no emitted selector carries the RETIRED `of` knob — the schema check cannot catch this one', () => {
    // P-005/D-014 §4 renamed `of` to `target`, and `of` survives in the schema as a
    // plain string PURELY so the handler can refuse it by name. That means the
    // schema-acceptance assertion above would keep passing for an emitted
    // `of:'material'` handle while every agent that followed it got refused at
    // runtime — a guard that reads green about exactly the failure it exists to
    // prevent. Checked structurally instead.
    const stale = handles.filter((h) => typeof h.args === 'object' && h.args !== null && 'of' in h.args);
    expect(stale.map((h) => `${h.file}: ${h.selector}`)).toEqual([]);
    // Calibration: the predicate can see an `of` when one is there.
    expect('of' in ({ cell: 'x', of: 'material' } as Record<string, unknown>)).toBe(true);
  });

  it('CONTROL — the same check REJECTS a handle the tool would refuse', () => {
    // Calibration for the assertion above: it must be able to fail. A guard that has
    // never failed is a guard nobody has tested, and "every selector parsed" is exactly
    // the shape that reads identically whether the check is strict or broken. These are
    // the two ways an emitter could realistically be wrong — a missing `cell`, and an
    // events:await-shaped envelope (22 of the 50 measured failures carried one).
    expect(subscribeTool.args.safeParse({ on: { op: 'changed' } }).success).toBe(false);
    expect(
      subscribeTool.args.safeParse({ cell: 'gate.greenCheckpoint.verdict', timeout_sec: 3600 }).success,
    ).toBe(false);
  });

  it('the specific handle 11 agents were refused now parses', () => {
    // The regression case, stated concretely so its intent survives a refactor of the
    // scan above.
    const parsed = subscribeTool.args.safeParse({ cell: 'gate.greenCheckpoint.verdict' });
    expect(parsed.success).toBe(true);
  });
});
