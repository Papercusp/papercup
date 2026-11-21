import { describe, expect, it } from 'vitest';
import {
  freshSuBootstrapBody, parseArgs, presetsFromArgs, psuLaunchArgvRecord,
  resumeLaunchArgvRecord, resumeOutsidePlanRef, forkBootstrapBody,
  validateOutsidePlanRef, reportSessionResumed,
} from './psu-launcher.mjs';

const selections = { agent: 'claude', workspace: 'ws', harness: 'h', plan: null };

describe('psu outside-plan launch contract', () => {
  it.each([199, 200])('carries an opaque %i-character label through argv and trusted bootstrap', size => {
    const ref = " tracker: a' $ `\n".padEnd(size, 'x');
    const args = parseArgs(['--agent=claude', '--plan-ref', ref]);
    expect(args.planRef).toBe(ref);
    expect(presetsFromArgs(args).needPlan).toBe(false);
    expect(psuLaunchArgvRecord(selections, args)).toContain(`--plan-ref=${ref}`);
    expect(freshSuBootstrapBody(selections, args)).toMatchObject({ plan_ref: ref });
  });
  it('rejects overflow, missing values and mixed plan bindings before bootstrap', () => {
    for (const value of ['', 'x'.repeat(201), 'x\0y']) expect(() => validateOutsidePlanRef(value)).toThrow();
    expect(() => parseArgs(['--plan-ref'])).toThrow(/plan-ref/);
    expect(() => parseArgs(['--plan-ref=X', '--plan=P'])).toThrow(/mutually exclusive/);
    expect(() => parseArgs(['--plan=P', '--plan-ref=X'])).toThrow(/mutually exclusive/);
  });
  it('preserves whitespace-only labels and matches the shared Unicode length bound', () => {
    expect(parseArgs(['--plan-ref=   ']).planRef).toBe('   ');
    expect(validateOutsidePlanRef('😀'.repeat(200))).toBe('😀'.repeat(200));
    expect(() => validateOutsidePlanRef('😀'.repeat(200) + 'x')).toThrow();
  });
  it('preserves the ordinary launch shape without the flag', () => {
    const args = parseArgs(['--agent=claude', '--plan=ordinary']);
    const body = freshSuBootstrapBody({ ...selections, plan: 'ordinary' }, args);
    expect(body).not.toHaveProperty('plan_ref');
    expect(body.launch_argv).toContain('--plan=ordinary');
    expect(body.launch_argv.some((a: string) => a.startsWith('--plan-ref'))).toBe(false);
    expect(presetsFromArgs(parseArgs(['--agent=claude'])).needPlan).toBe(true);
  });
  it('retains the persisted binding on resume/fork and refuses a conflicting resume', () => {
    const session = { id: 42, sessionId: 'native', agent: 'claude', workspaceId: 'ws', planSlug: null,
      outsidePlanRef: 'tracker:X', launchArgv: ['psu', '--agent=claude', '--plan-ref=stale-argv'] };
    expect(resumeOutsidePlanRef(session, undefined)).toBe('tracker:X');
    expect(() => resumeOutsidePlanRef(session, 'tracker:Y')).toThrow(/persisted/);
    expect(() => resumeOutsidePlanRef({ planSlug: 'P' }, 'tracker:X')).toThrow(/mutually exclusive/);
    expect(resumeLaunchArgvRecord(session)).toContain('--plan-ref=tracker:X');
    expect(forkBootstrapBody(session)).toMatchObject({ plan_ref: 'tracker:X' });
  });
  it('passes the binding to server-side resume admission', async () => {
    let sent: any;
    const outcome = await reportSessionResumed(42, {
      token: 'test', operatorUrl: 'http://127.0.0.1:1', resumeClaimKey: 'attempt', planRef: 'tracker:X',
      fetchImpl: async (_url: unknown, init: RequestInit) => {
        sent = JSON.parse(String(init.body));
        return Response.json({ ok: true, acquired: true, status: 'acquired', resumeClaimKey: 'attempt' });
      },
    });
    expect(outcome.claimed).toBe(true);
    expect(sent).toMatchObject({ advSessionId: 42, planRef: 'tracker:X' });
  });
});
