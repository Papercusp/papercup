import { describe, expect, it } from 'vitest';
// @ts-expect-error — plain .mjs module (same pattern as the other script tests)
import {
  FRAMEWORKS,
  FRAMEWORK_DESCRIPTIONS,
  INTRO_BANNER,
  buildHandoffArgs,
  mapFrameworkToAgent,
  parseArgs,
} from '../onboard-launcher.mjs';

describe('mapFrameworkToAgent', () => {
  it('maps a framework id to its psu agent id (identity: claude/codex/omp)', () => {
    expect(mapFrameworkToAgent('claude')).toBe('claude');
    expect(mapFrameworkToAgent('codex')).toBe('codex');
    expect(mapFrameworkToAgent('omp')).toBe('omp');
  });
});

describe('buildHandoffArgs', () => {
  it('launches a scripted psu session on the chosen agent', () => {
    expect(buildHandoffArgs('claude', {})).toEqual([
      '--no-picker',
      '--agent=claude',
      '--no-plan',
    ]);
  });

  it('threads harness + tutor launch-context from env (the P-005 seam)', () => {
    const args = buildHandoffArgs('codex', {
      PAPERCUSP_ONBOARD_HARNESS: 'my-pot',
      PAPERCUSP_ONBOARD_LAUNCH_CONTEXT: '/tmp/tutor.md',
    });
    expect(args).toContain('--agent=codex');
    expect(args).toContain('--harness=my-pot');
    expect(args).toContain('--launch-context=/tmp/tutor.md');
  });
});

describe('parseArgs', () => {
  it('parses framework, operator url, and tutorial mode', () => {
    expect(
      parseArgs(['--framework=codex', '--operator-url=http://127.0.0.1:3170', '--tutorial']),
    ).toEqual({
      framework: 'codex',
      operatorUrl: 'http://127.0.0.1:3170',
      tutorialOnly: true,
      tab: null,
    });
  });

  it('accepts omp as a framework', () => {
    expect(parseArgs(['--framework=omp']).framework).toBe('omp');
  });

  it('throws on an unknown framework', () => {
    expect(() => parseArgs(['--framework=gpt'])).toThrow(/unknown --framework/);
  });

  it('exports claude/codex/omp frameworks (each with a picker description) and the owner-verbatim banner', () => {
    expect(FRAMEWORKS).toEqual(['claude', 'codex', 'omp']);
    for (const f of FRAMEWORKS) expect(typeof FRAMEWORK_DESCRIPTIONS[f]).toBe('string');
    expect(INTRO_BANNER).toContain('Welcome to papercusp');
    expect(INTRO_BANNER).toContain('brief 10 minute setup procedure and tutorial');
  });
});
