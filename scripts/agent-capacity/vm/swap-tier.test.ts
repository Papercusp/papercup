import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// swap-tier.py drives the WI-10005475 swap-tier test on a VM; swap-tier-stub-api.py answers the
// agents' model requests. These tests import both modules' pure parts through python3 (the files
// are hyphenated, so by path) and check the reply plan and the report reduction.
const HERE = dirname(fileURLToPath(import.meta.url));
const DRIVER = process.env.SWAP_TIER_PATH ?? join(HERE, 'swap-tier.py');
const STUB = process.env.SWAP_TIER_STUB_PATH ?? join(HERE, 'swap-tier-stub-api.py');

function py(module: string, expr: string, input: unknown): any {
  const code = [
    'import importlib.util, json, sys',
    `spec = importlib.util.spec_from_file_location("m", ${JSON.stringify(module)})`,
    'm = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)',
    'inp = json.loads(sys.stdin.read())',
    `print(json.dumps(${expr}))`,
  ].join('\n');
  const r = spawnSync('python3', ['-c', code], { input: JSON.stringify(input), encoding: 'utf8' });
  if (r.status !== 0) throw new Error(r.stderr);
  return JSON.parse(r.stdout);
}

const plan = (messages: unknown[]) => py(STUB, 'list(m.plan_reply({"messages": inp}, ["/f0.py", "/f1.py"]))', messages);
const user = (text: string) => ({ role: 'user', content: [{ type: 'text', text }] });
const toolResult = { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'file body' }] };
const toolUse = { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Read', input: {} }] };

describe('stub reply plan', () => {
  it('answers a WARM prompt with a Read of warm file k, then a DONE text once the tool ran', () => {
    expect(plan([user('Please do step WARM-a3-1 now')])).toEqual(['warm-tool', 'WARM-a3-1', ['tool', '/f1.py']]);
    const done = plan([user('Please do step WARM-a3-1 now'), toolUse, toolResult]);
    expect(done[0]).toBe('warm-done');
    expect(done[2][1]).toMatch(/DONE-WARM-a3-1$/);
  });

  it('still sees the tool result when the CLI appends a reminder-only user message after it', () => {
    // The first prototype looped 2,500 Reads: it only looked for the tool result in the LAST message.
    const reminder = user('<system-reminder>todo list is empty</system-reminder>');
    expect(plan([user('step WARM-a1-0'), toolUse, toolResult, reminder])[0]).toBe('warm-done');
  });

  it('answers a WAKE prompt with DONE-WAKE-<nonce>, and a markerless side request with a short text', () => {
    expect(plan([user('Wake up WAKE-zram123a4 please')])).toEqual(['wake', 'WAKE-zram123a4', ['text', 'Back. DONE-WAKE-zram123a4']]);
    expect(plan([user('generate a title for this conversation')])).toEqual(['side', null, ['text', 'ok']]);
  });

  it('follows the newest marker, not an older WARM one still in the history', () => {
    const msgs = [user('step WARM-a1-0'), toolUse, toolResult, { role: 'assistant', content: [{ type: 'text', text: 'DONE' }] }, user('WAKE-x1a1')];
    expect(plan(msgs)[0]).toBe('wake');
  });
});

const MiB = 2 ** 20;
// anon defaults to current: in these fixtures all of an agent's resident memory is anonymous.
const st = (current: number, swap: number, majflt = 0, anon = current) => ({
  current: current * MiB,
  swap: swap * MiB,
  anon: anon * MiB,
  file: 0,
  majflt,
});

describe('report reduction', () => {
  const rows = [
    { t: 100, kind: 'arm-start', arm: 'zram', device: '/dev/zram0' },
    { t: 101, kind: 'reclaimed', arm: 'zram', agent: 'a1', seconds: 1.0, before: st(300, 0), after: st(20, 250) },
    { t: 102, kind: 'reclaimed', arm: 'zram', agent: 'a2', seconds: 1.0, before: st(300, 0), after: st(30, 230) },
    { t: 103, kind: 'phase', arm: 'zram', phase: 'reclaim', edge: 'end', host: { zram: { orig: 480 * MiB, compr: 100 * MiB, used: 120 * MiB } } },
    { t: 164, kind: 'idle', arm: 'zram', before: { a1: st(20, 250), a2: st(30, 230) }, after: { a1: st(25, 245), a2: st(30, 230) } },
    { t: 170, kind: 'phase', arm: 'zram', phase: 'single', edge: 'start' },
    { t: 172, kind: 'phase', arm: 'zram', phase: 'single', edge: 'end' },
    { t: 173, kind: 'wake', arm: 'zram', phase: 'single', agent: 'a1', t0: 170, tEcho: 170.5, tEnter: 170.5, tDone: 171.5, pre: st(25, 245, 10), post: st(200, 70, 4010) },
    { t: 180, kind: 'phase', arm: 'zram', phase: 'storm', edge: 'start' },
    { t: 190, kind: 'phase', arm: 'zram', phase: 'storm', edge: 'end' },
    { t: 191, kind: 'wake', arm: 'zram', phase: 'storm', agent: 'a2', t0: 180, tEcho: 182, tEnter: 182, tDone: 186, pre: st(30, 230), post: st(210, 50) },
    { t: 211, kind: 'arm-end', arm: 'zram', host: {}, agents: { a1: st(200, 60), a2: st(210, 40) } },
  ];
  const probe = [
    [171, 2, 0],
    [171.1, 40, 3],
    [185, 900, 50],
    [300, 1, 0],
  ];
  const [arm] = py(DRIVER, 'm.summarize(inp["rows"], [tuple(p) for p in inp["probe"]])', { rows, probe });

  it('reports how much each parked agent moved to swap, what stayed resident, and the zram ratio', () => {
    expect(arm.reclaim).toMatchObject({ agents: 2, beforeMiBPerAgent: 300, swappedMiBPerAgent: 240, residentAfterMiBPerAgent: 25, seconds: 2 });
    expect(arm.reclaim.swapOutMiBps).toBe(240);
    expect(arm.zram).toMatchObject({ origMiB: 480, usedMiB: 120, ratio: 4 });
    expect(arm.idleRegainedMiB).toBe(5);
  });

  it('times single and storm wakes from the typed prompt, with paged-back memory and the probe inside each window', () => {
    expect(arm.single.totalSec.p50).toBe(1.5);
    expect(arm.single.echoSec.p50).toBe(0.5);
    expect(arm.single.regainedMiBPerAgent).toBe(175);
    expect(arm.single.majfltPerAgent).toBe(4000);
    expect(arm.single.probeExecMs).toMatchObject({ samples: 2, max: 40 });
    expect(arm.storm.allDoneSec).toBe(6);
    expect(arm.storm.probeExecMs).toMatchObject({ samples: 1, max: 900 });
    expect(arm.swapAfterStormMiB).toBe(100);
    expect(arm.residentAfterStormMiB).toBe(410);
  });

  // Measured 14 Oct 2026 (WI-10005475): on a disk swap device the kernel keeps each swap slot
  // after reading the page back (swap cache), so swap-used stays flat while the agent pages
  // itself back in. The first summary used the swap-used drop and reported ~0 MiB regained on
  // every disk tier while resident memory had grown by ~1.1 GiB.
  it('measures memory regained from resident growth, not swap-used, so disk swap cache cannot hide it', () => {
    const disk = [
      { t: 100, kind: 'arm-start', arm: 'pd-ssd', device: '/dev/sdc' },
      { t: 101, kind: 'reclaimed', arm: 'pd-ssd', agent: 'a1', seconds: 0.5, before: st(152, 0), after: st(3, 150, 0, 1) },
      { t: 164, kind: 'idle', arm: 'pd-ssd', before: { a1: st(3, 150, 0, 1) }, after: { a1: st(60, 150, 0, 58) } },
      { t: 170, kind: 'phase', arm: 'pd-ssd', phase: 'single', edge: 'start' },
      { t: 172, kind: 'phase', arm: 'pd-ssd', phase: 'single', edge: 'end' },
      { t: 173, kind: 'wake', arm: 'pd-ssd', phase: 'single', agent: 'a1', t0: 170, tEcho: 170.5, tEnter: 170.5, tDone: 171.5, pre: st(60, 150, 0, 58), post: st(130, 149, 900, 128) },
      { t: 200, kind: 'arm-end', arm: 'pd-ssd', host: {}, agents: { a1: st(130, 149, 900, 128) } },
    ];
    const [d] = py(DRIVER, 'm.summarize(inp, [])', disk);
    expect(d.idleRegainedMiB).toBe(57);
    expect(d.single.regainedMiBPerAgent).toBe(70);
    expect(d.swapAfterStormMiB).toBe(149);
    expect(d.residentAfterStormMiB).toBe(128);
  });

  it('counts a wake that never rendered as failed instead of dropping it', () => {
    const lost = rows.map((r) => (r.kind === 'wake' && r.phase === 'storm' ? { ...r, tDone: null } : r));
    const [a] = py(DRIVER, 'm.summarize(inp, [])', lost);
    expect(a.storm.failed).toBe(1);
    expect(a.storm.allDoneSec).toBeNull();
  });
});

describe('arm specs', () => {
  it('accepts none, zram and <label>=<device>, and refuses anything else', () => {
    expect(py(DRIVER, '[m.parse_arm(s) for s in inp]', ['none', 'zram', 'pd-ssd=/dev/disk/by-id/google-swapssd'])).toEqual([
      { name: 'none', kind: 'none' },
      { name: 'zram', kind: 'zram' },
      { name: 'pd-ssd', kind: 'device', device: '/dev/disk/by-id/google-swapssd' },
    ]);
    expect(() => py(DRIVER, 'm.parse_arm(inp)', 'pd-ssd')).toThrow(/expects none, zram/);
  });
});
