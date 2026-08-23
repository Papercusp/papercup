/**
 * accessibility-live.test.ts — P-007's required evidence, measured rather than asserted.
 *
 * The plan item asks for the accessibility path "verified against GTK apps on a sandbox
 * desktop, measuring the per-step token reduction". This file is that verification: a
 * real Xvfb, a real per-desktop accessibility bus, a real GTK application, and a real
 * `gjs` walk of its tree.
 *
 * WHY IT CANNOT BE A UNIT TEST. Every transformation in `accessibility-tree.ts` is pure
 * and unit-tested, but all of them are only a MODEL of what a toolkit publishes, and the
 * model was wrong in three separate ways that no in-process test could have caught —
 * each discovered only by walking a live GTK 4.14.5 app:
 *
 *   1. Static labels export EIGHT actions (clipboard.copy, link.open, …), so "has
 *      actions" marks every caption clickable.
 *   2. Widgets report SENSITIVE and never ENABLED, so an ENABLED test labels a live
 *      button `disabled`.
 *   3. SCREEN extents are ZEROED — every element reports (0,0) with its real size —
 *      so a click point computed from them is wrong for every element at once.
 *
 * A fixture encodes whatever the author believed on the day. Only a live toolkit can
 * falsify the belief, which is why this suite exists alongside the unit tests rather
 * than instead of them.
 *
 * TEST DECOMPOSITION IS BY DEPENDENCY, NOT BY TOPIC — the same discipline P-006 arrived
 * at the expensive way. `ctx.skip()` marks a whole test SKIPPED even for assertions that
 * already ran and PASSED, so folding a precondition-dependent check in with the evidence
 * silently discards the evidence while still exiting 0. Claims that hold whatever is on
 * screen (the walker runs, the bus is pinned, the isolation guard refuses) always run;
 * only claims needing a REGISTERED GTK APP live in the test that may skip.
 *
 * GUARDED like the other live desktop suites — a normal `test:affected` / CI run skips it:
 *   PAPERCUSP_A11Y_LIVE=1 npx vitest run lib/agent-tools/computer/accessibility-live.test.ts
 */
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import {
  a11yBusFromRootCommand,
  actionCommand,
  buildA11yTree,
  compressA11yTree,
  estimateImageTokens,
  estimateTextTokens,
  findByRef,
  isInteractive,
  parseA11yBusAddress,
  parseWalkerOutput,
  parseA11yActionOutput,
  renderA11yTree,
  screenBoundsAreTrustworthy,
  walkerCommand,
  type A11yNode,
} from './accessibility-tree';
import { provisionSandboxDesktop, type SandboxDesktop } from './desktop-provisioner';

const LIVE = process.env.PAPERCUSP_A11Y_LIVE === '1';
const TIMEOUT = 120_000;

let desktop: SandboxDesktop | null = null;
afterEach(async () => {
  if (desktop) await desktop.release().catch(() => {});
  desktop = null;
});

function run(bin: string, args: string[], env: Record<string, string>): { out: string; err: string; code: number | null } {
  const r = spawnSync(bin, args, { encoding: 'utf8', env, timeout: 40_000 });
  return { out: r.stdout ?? '', err: r.stderr ?? '', code: r.status };
}

/** Resolve the bus the desktop advertises on its own root window. */
function busFor(display: string): string | null {
  const probe = a11yBusFromRootCommand(display);
  return parseA11yBusAddress(run(probe.bin, probe.args, probe.env).out);
}

function walk(display: string, bus: string) {
  const cmd = walkerCommand(display, bus);
  const r = run(cmd.bin, cmd.args, cmd.env);
  const parsed = parseWalkerOutput(r.out);
  if (!parsed) throw new Error(`walker produced no sentinel line (exit ${r.code}): ${r.err.slice(0, 400)}`);
  return parsed;
}

/**
 * A registered app is a precondition this suite PROVISIONS, so its absence is a
 * failure — never a skip.
 *
 * The distinction is the whole point: a precondition supplied by the environment
 * (a display, a toolkit) may reasonably be skipped, but one the suite creates
 * itself cannot be, because "it isn't there" means the suite's own setup broke.
 * Written as a log-and-`return` it PASSES, and an early return is indistinguishable
 * from a real pass in every report vitest prints — worse than `ctx.skip()`, which at
 * least appears in the summary as its own count. That is not hypothetical: three
 * tests here reported green for a day while the GTK app silently failed to start
 * (WI-40906 — `systemd-run` could not create the scope, and the caller's
 * `stdio: 'ignore'` swallowed the reason).
 */
function expectRegisteredApp(apps: number): void {
  expect(
    apps,
    'no application registered on the a11y bus — this suite launches one, so its absence is a ' +
      'FAILURE of the desktop/app-spawn path, not a reason to skip. Check that the app process ' +
      'is actually running on the display (a confined spawn that cannot create its scope dies ' +
      'silently under stdio:"ignore").',
  ).toBeGreaterThan(0);
}

/** Stand up a desktop with a GTK dialog on it and let it settle. */
async function gtkDesktop(): Promise<SandboxDesktop> {
  const d = await provisionSandboxDesktop({
    width: 1024,
    height: 768,
    apps: [['zenity', '--forms', '--title=Papercusp Probe', '--text=Sign in',
            '--add-entry=Username', '--add-password=Password']],
    launchedBy: 'test:accessibility-live',
  });
  desktop = d;
  await new Promise((r) => setTimeout(r, 9000));
  return d;
}

describe.skipIf(!LIVE)('accessibility observation — live', () => {
  it('provisions a desktop that advertises its OWN accessibility bus, keyed to its display', async () => {
    const d = await gtkDesktop();
    expect(d.a11y, 'provisioner did not bring up an a11y bus').toBeTruthy();
    const bus = busFor(d.display);
    expect(bus, `no AT_SPI_BUS published on ${d.display}`).toBeTruthy();
    // The bus is named after the display — this is what makes a fleet of desktops
    // isolated from each other rather than sharing one tree.
    expect(bus).toContain(`bus_${d.number}`);
    expect(bus).toBe(d.a11y!.a11yBus);
    // eslint-disable-next-line no-console
    console.log(`[P-007] display=${d.display} a11yBus=${bus}`);
  }, TIMEOUT);

  it('REFUSES to walk a display with no accessibility bus rather than reading the host session', async () => {
    // The measured leak: with no bus pinned, atspi falls through to $XDG_RUNTIME_DIR/bus
    // — the operator's real desktop — and returns a rich, plausible, wrong tree.
    expect(() => walkerCommand(':199', '')).toThrow(/REFUSING to fall back/);
    // And the sandbox rail still holds for the observation path.
    expect(() => walkerCommand(':0', 'unix:path=/tmp/x')).toThrow(/HOST display/);
  });

  it('walks a real GTK application and finds its interactive widgets', async () => {
    const d = await gtkDesktop();
    const bus = busFor(d.display);
    if (!bus) throw new Error('precondition: desktop published no a11y bus');
    const parsed = walk(d.display, bus);

    // PRECONDITION, checked FIRST and separately so a failure to START the app is not
    // misread as an accessibility-path regression. It is still a FAILURE: this suite
    // launches the app itself, so nothing registering means the thing under test never
    // happened. It used to log and `return`, which PASSES — and a suite of those exits
    // 0 while proving nothing (measured: 3 of 5 tests here were green and vacuous while
    // the GTK app was silently failing to start).
    expectRegisteredApp(parsed.apps);

    const { roots, stats } = compressA11yTree(buildA11yTree(parsed.nodes));
    const tree = renderA11yTree(roots);
    // eslint-disable-next-line no-console
    console.log(`[P-007] apps=${parsed.apps} raw=${stats.rawNodes} kept=${stats.keptNodes}\n${tree}`);

    // The isolation claim, measured: this walk sees ONLY the app we launched. The
    // number matters — the leaked host walk returned 69.
    expect(parsed.apps).toBeLessThanOrEqual(2);
    expect(tree).toContain('Username');
    expect(tree).toContain('Password');

    // The widgets a model would act on carry refs and resolve back to real nodes.
    const interactive: A11yNode[] = [];
    const visit = (n: A11yNode): void => { if (isInteractive(n)) interactive.push(n); n.children.forEach(visit); };
    roots.forEach(visit);
    expect(interactive.length, 'no interactive elements found in a form dialog').toBeGreaterThan(0);
    for (const n of interactive) expect(findByRef(roots, n.ref)).toBe(n);

    // A live, usable GTK4 widget must NOT be reported as disabled — it reports
    // SENSITIVE and never ENABLED, and getting this wrong tells the model not to try.
    expect(tree).not.toContain('disabled');
  }, TIMEOUT);

  it('MEASURES the per-step token reduction against a screenshot of the same screen', async () => {
    const d = await gtkDesktop();
    const bus = busFor(d.display);
    if (!bus) throw new Error('precondition: desktop published no a11y bus');
    const parsed = walk(d.display, bus);
    expectRegisteredApp(parsed.apps);
    const { roots, stats } = compressA11yTree(buildA11yTree(parsed.nodes));
    const tree = renderA11yTree(roots);

    const treeTokens = estimateTextTokens(tree);
    // The screenshot cost for THIS desktop after D-006's downscale — the honest
    // comparison, since that is what an agent actually pays per observation today.
    const shotTokens = estimateImageTokens(1024, 768);
    const ratio = shotTokens / Math.max(1, treeTokens);

    // eslint-disable-next-line no-console
    console.log(
      `[P-007] TOKEN MEASUREMENT: tree=${treeTokens} tokens (${tree.length} chars, ` +
        `${stats.keptNodes} of ${stats.rawNodes} elements) vs screenshot=${shotTokens} tokens ` +
        `(1024x768 post-D-006) => ${ratio.toFixed(2)}x cheaper per observation`,
    );

    // The claim P-007 exists to establish. A dialog is the SMALL end of the range;
    // this is deliberately a floor, not a headline number.
    expect(treeTokens).toBeGreaterThan(0);
    expect(treeTokens).toBeLessThan(shotTokens);

    // Compression must actually compress — a tree that kept every node would still
    // beat a screenshot here, and would silently stop doing so on a real application.
    expect(stats.keptNodes).toBeLessThan(stats.rawNodes);
  }, TIMEOUT);

  it('ACTIVATES an element by ref over the accessibility bus, and the app reacts', async () => {
    const d = await gtkDesktop();
    const bus = busFor(d.display);
    if (!bus) throw new Error('precondition: desktop published no a11y bus');
    const before = walk(d.display, bus);
    expectRegisteredApp(before.apps);
    const { roots } = compressA11yTree(buildA11yTree(before.nodes));

    // GTK4's zeroed SCREEN extents are why activation is the primary click path. Assert
    // the detector agrees with what was measured, so a future toolkit that FIXES its
    // coordinates makes this test fail loudly rather than silently changing the design.
    // eslint-disable-next-line no-console
    console.log(`[P-007] screenBoundsAreTrustworthy=${screenBoundsAreTrustworthy(roots)}`);

    const cancel: A11yNode[] = [];
    const visit = (n: A11yNode): void => {
      if (/cancel|close/i.test(n.name) && isInteractive(n)) cancel.push(n);
      n.children.forEach(visit);
    };
    roots.forEach(visit);
    // Also suite-provisioned: the dialog this suite launches HAS a Cancel button, so
    // its absence is a real finding about the walker, not a reason to pass quietly.
    expect(
      cancel.length,
      'no Cancel-like interactive element in a dialog that has one — the walk or the interactivity test is wrong',
    ).toBeGreaterThan(0);

    const cmd = actionCommand(d.display, bus, cancel[0]!.ref, 'click');
    const res = run(cmd.bin, cmd.args, cmd.env);
    // Not parseWalkerOutput: the two programs share a sentinel but not a shape, and
    // reaching for the walk parser here is exactly the bug this test caught (it needs
    // a `nodes` array, so it returns null for every successful activation).
    const acted = parseA11yActionOutput(res.out);
    // eslint-disable-next-line no-console
    console.log(`[P-007] activate #${cancel[0]!.ref} "${cancel[0]!.name}" -> ${JSON.stringify(acted)}`);
    expect(acted?.ok, `activation failed: ${acted?.error ?? res.err.slice(0, 300)}`).toBe(true);

    // The falsifiable half: the app must actually have RESPONDED. An action that
    // returns true and changes nothing is exactly the failure a return-code assertion
    // cannot see.
    await new Promise((r) => setTimeout(r, 3000));
    const after = walk(d.display, bus);
    expect(after.apps, 'Cancel was activated but the dialog is still registered').toBeLessThan(before.apps);
  }, TIMEOUT);
});
