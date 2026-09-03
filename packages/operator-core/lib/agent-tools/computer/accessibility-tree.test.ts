/**
 * Unit tests for the pure AT-SPI observation path (P-007 / D-010).
 *
 * Every assertion here runs with NO live display and NO a11y bus: the module is
 * pure by construction, and the fixture below is a faithful reduction of a real
 * walk (GTK's characteristic deep filler/panel nesting, a menubar whose unopened
 * items are live-but-not-showing, and an application root with no extents).
 */
import { describe, it, expect } from 'vitest';
import {
  ATSPI_SENTINEL,
  ATSPI_WALKER_JS,
  A11Y_APP_ENV,
  buildA11yTree,
  compressA11yTree,
  elementClickPoint,
  estimateImageTokens,
  estimateTextTokens,
  findByRef,
  isInteractive,
  a11yBusCommand,
  actionCommand,
  parseA11yBusAddress,
  parseWalkerOutput,
  parseA11yActionOutput,
  screenBoundsAreTrustworthy,
  ATSPI_ACTION_JS,
  HOST_BUS_ENV_KEYS,
  NoAccessibilityBusError,
  renderA11yTree,
  walkerCommand,
  type A11yNode,
  type RawA11yNode,
} from './accessibility-tree';

const node = (p: string, r: string, n = '', over: Partial<RawA11yNode> = {}): RawA11yNode => ({
  p,
  r,
  n,
  s: ['showing', 'visible', 'enabled'],
  e: [0, 0, 100, 40],
  a: [],
  v: '',
  ...over,
});

/** A reduced but structurally real GTK dialog walk. */
const FIXTURE: RawA11yNode[] = [
  node('0', 'application', 'zenity', { s: [], e: null }),
  node('0/0', 'frame', 'Probe Form', { e: [0, 0, 400, 220] }),
  node('0/0/0', 'filler', '', { e: [0, 0, 400, 220] }),
  node('0/0/0/0', 'panel', '', { e: [0, 0, 400, 220] }),
  node('0/0/0/0/0', 'label', 'Sign in', { e: [10, 10, 80, 20] }),
  node('0/0/0/0/1', 'entry', 'Username', {
    s: ['showing', 'visible', 'enabled', 'focusable', 'editable', 'focused'],
    e: [10, 40, 200, 30],
    v: 'avi',
  }),
  node('0/0/0/0/2', 'password text', 'Password', {
    s: ['showing', 'visible', 'enabled', 'focusable', 'editable'],
    e: [10, 80, 200, 30],
  }),
  node('0/0/0/0/3', 'push button', 'OK', {
    s: ['showing', 'visible', 'enabled', 'focusable'],
    e: [300, 160, 80, 30],
    a: ['click'],
  }),
  // Disabled button — must survive compression and be flagged.
  node('0/0/0/0/4', 'push button', 'Apply', {
    s: ['showing', 'visible', 'focusable'],
    e: [200, 160, 80, 30],
    a: ['click'],
  }),
  // A live but NOT-showing menu subtree, exactly as GTK reports an unopened menu.
  node('0/0/1', 'menu bar', '', { e: [0, 0, 400, 20] }),
  node('0/0/1/0', 'menu', 'File', { s: ['visible', 'enabled'], e: [0, 0, 40, 20] }),
  node('0/0/1/0/0', 'menu item', 'Quit', { s: ['visible', 'enabled'], e: [0, 0, 0, 0], a: ['click'] }),
  // Decorative leaf with nothing to say.
  node('0/0/2', 'filler', '', { e: [0, 218, 400, 2] }),
];

describe('parseWalkerOutput', () => {
  it('finds the sentinel line amid the toolkit noise that always surrounds it', () => {
    const noisy = [
      'libEGL warning: DRI3 error: Could not get DRI3 device',
      '(zenity:123): GLib-GIO-CRITICAL **: Error while sending AddMatch()',
      `${ATSPI_SENTINEL}{"ok":true,"init":0,"apps":1,"nodes":[{"p":"0","r":"application","n":"z","s":[],"e":null,"a":[],"v":""}]}`,
      '(zenity:123): Gtk-WARNING **: teardown',
    ].join('\n');
    const parsed = parseWalkerOutput(noisy);
    expect(parsed?.ok).toBe(true);
    expect(parsed?.apps).toBe(1);
    expect(parsed?.nodes).toHaveLength(1);
  });

  it('returns null when no sentinel is present — "the walker never ran" is NOT "the screen is empty"', () => {
    expect(parseWalkerOutput('gjs: command not found')).toBeNull();
    expect(parseWalkerOutput('')).toBeNull();
  });

  it('returns null rather than a partial tree when the sentinel payload is unparseable', () => {
    expect(parseWalkerOutput(`${ATSPI_SENTINEL}{"ok":true,"nodes":`)).toBeNull();
    // Well-formed JSON that is not a walk result is also refused.
    expect(parseWalkerOutput(`${ATSPI_SENTINEL}{"ok":true}`)).toBeNull();
  });

  it('takes the LAST sentinel, so a warning quoting the sentinel cannot shadow the result', () => {
    const out = [
      `Gtk-WARNING: something mentioned ${ATSPI_SENTINEL}{"ok":false,"init":1,"apps":0,"nodes":[]}`,
      `${ATSPI_SENTINEL}{"ok":true,"init":0,"apps":2,"nodes":[]}`,
    ].join('\n');
    expect(parseWalkerOutput(out)?.apps).toBe(2);
  });
});

// WI-40906 — the walk and the activation programs print the SAME sentinel with
// DIFFERENT payloads. Parsing one with the other's parser type-checks behind a cast and
// is silently always-wrong: `computer:click_element` used parseWalkerOutput, which
// requires a `nodes` array an action payload never has, so it returned null for every
// successful activation and the tool reported failure unconditionally. These assert the
// two are mutually exclusive, which is the property that makes the confusion impossible
// rather than merely fixed at one call site.
describe('parseA11yActionOutput', () => {
  const ACTION = '@@ATSPI@@{"ok":true,"role":"push button","name":"Cancel","performed":"click","result":true}';
  const WALK = '@@ATSPI@@{"apps":1,"nodes":[{"p":"0","r":"application","n":"a"}]}';

  it('parses a real activation payload', () => {
    expect(parseA11yActionOutput(ACTION)).toMatchObject({ ok: true, performed: 'click', name: 'Cancel' });
  });

  it('parses a FAILED activation rather than treating it as unparseable', () => {
    // ok:false is a real answer carrying the reason; conflating it with "no sentinel"
    // would throw away the only diagnostic the program emits.
    expect(parseA11yActionOutput('@@ATSPI@@{"ok":false,"error":"no such ref"}')).toMatchObject({
      ok: false,
      error: 'no such ref',
    });
  });

  it('REFUSES a walk payload', () => {
    expect(parseA11yActionOutput(WALK)).toBeNull();
  });

  it('and parseWalkerOutput REFUSES an action payload', () => {
    // The direction that actually shipped broken.
    expect(parseWalkerOutput(ACTION)).toBeNull();
  });

  it('returns null when there is no sentinel at all', () => {
    expect(parseA11yActionOutput('Gtk-CRITICAL **: some warning\n')).toBeNull();
  });

  it('reads past toolkit noise printed BEFORE the result', () => {
    // The failure that actually occurs: GTK chatters during init, then our program
    // prints its sentinel last. Taking the LAST sentinel line is what makes that
    // harmless — the documented trade-off is that anything printing a quoted sentinel
    // after us would win, which nothing does because the program then exits.
    const out = `Gtk-CRITICAL **: cannot open display\nsome other noise\n${ACTION}\n`;
    expect(parseA11yActionOutput(out)).toMatchObject({ ok: true, performed: 'click' });
  });
});

describe('buildA11yTree', () => {
  it('rebuilds parent/child purely from the index paths', () => {
    const roots = buildA11yTree(FIXTURE);
    expect(roots).toHaveLength(1);
    expect(roots[0]!.role).toBe('application');
    expect(roots[0]!.children[0]!.name).toBe('Probe Form');
    expect(roots[0]!.children[0]!.children[0]!.children[0]!.children).toHaveLength(5);
  });

  it('promotes an orphan to a root instead of dropping it, so truncation loses shape not content', () => {
    const roots = buildA11yTree([node('0', 'application', 'a', { s: [], e: null }), node('7/3', 'push button', 'Orphan')]);
    expect(roots).toHaveLength(2);
    expect(roots[1]!.name).toBe('Orphan');
  });

  // WI-40906 — the walker is a separate gjs process driving a C library through
  // introspection, so every field's type is a CLAIM. Measured on GTK 4.14: a label's
  // text interface returns an OBJECT, which serialises as {} and passes `?? ''`
  // untouched, then throws `node.value.trim is not a function` three call-frames away
  // in compression. These pin the boundary against exactly what was measured, plus the
  // neighbouring types it could equally well return.
  describe('coerces walker fields whose type the toolkit did not honour', () => {
    it('turns a non-string value into the empty string rather than passing it through', () => {
      const roots = buildA11yTree([{ p: '0', r: 'label', n: 'Username', v: {} } as never]);
      expect(roots[0]!.value).toBe('');
      // The property that actually matters: everything downstream may call string
      // methods on it without a guard of its own.
      expect(() => roots[0]!.value.trim()).not.toThrow();
    });

    it('coerces a non-string role and name to their documented fallbacks', () => {
      const roots = buildA11yTree([{ p: '0', r: 42, n: {}, v: 'x' } as never]);
      expect(roots[0]!.role).toBe('?');
      expect(roots[0]!.name).toBe('');
    });

    it('drops a node whose path is not a string, since nothing could address it', () => {
      // The ref indexes the parent map and is what `findByRef` resolves; a non-string
      // one would sit in the tree permanently unreachable.
      const roots = buildA11yTree([node('0', 'application', 'a', { s: [], e: null }), { p: 7, r: 'label' } as never]);
      expect(roots).toHaveLength(1);
    });

    it('keeps only the string members of states and actions', () => {
      const roots = buildA11yTree([{ p: '0', r: 'push button', n: 'OK', s: ['SENSITIVE', 3, null], a: ['click', {}] } as never]);
      expect(roots[0]!.states).toEqual(['SENSITIVE']);
      expect(roots[0]!.actions).toEqual(['click']);
    });

    it('still passes real strings through untouched', () => {
      // The calibration case: a coercion that "fixed" everything by emptying it would
      // pass all four assertions above.
      const roots = buildA11yTree([{ p: '0', r: 'entry', n: 'Username', v: 'typed text', s: ['FOCUSED'] } as never]);
      expect(roots[0]!).toMatchObject({ role: 'entry', name: 'Username', value: 'typed text', states: ['FOCUSED'] });
    });
  });
});

describe('isInteractive', () => {
  const mk = (over: Partial<A11yNode>): A11yNode => ({
    ref: '0/0', role: 'panel', name: '', states: [], bounds: null, actions: [], value: '', children: [], ...over,
  });

  it('treats a button with an EMPTY action list as interactive (GTK3 exports none)', () => {
    expect(isInteractive(mk({ role: 'push button', actions: [] }))).toBe(true);
  });

  it('does NOT treat a GTK4 label as interactive despite its eight clipboard actions', () => {
    // Measured verbatim on GTK 4.14.5 — every static label exports these.
    const label = mk({
      role: 'label',
      name: 'Sign in',
      actions: ['clipboard.copy', 'selection.delete', 'clipboard.paste', 'link.open',
                'clipboard.cut', 'link.copy', 'menu.popup', 'selection.select-all'],
    });
    expect(isInteractive(label)).toBe(false);
  });

  it('does not treat a focusable window/frame/dialog as a clickable element', () => {
    expect(isInteractive(mk({ role: 'window', states: ['focusable'] }))).toBe(false);
    expect(isInteractive(mk({ role: 'frame', states: ['focusable'] }))).toBe(false);
    // A GTK4 dialog exports these two and is focusable; "click the dialog" is not an
    // action to offer when the model wants a button inside it.
    expect(isInteractive(mk({ role: 'dialog', states: ['focusable'], actions: ['window.close', 'default.activate'] }))).toBe(false);
  });

  it('treats plain layout scaffolding as non-interactive', () => {
    expect(isInteractive(mk({ role: 'filler' }))).toBe(false);
    expect(isInteractive(mk({ role: 'panel' }))).toBe(false);
  });
});

describe('screenBoundsAreTrustworthy', () => {
  it('rejects the GTK4/X11 signature: every node at (0,0) with its own real size', () => {
    // Measured on GTK 4.14.5: SCREEN=(0,0 162x44) for a button whose WINDOW=(14,231 …).
    const gtk4 = buildA11yTree([
      node('0', 'application', 'zenity', { s: [], e: null }),
      node('0/0', 'dialog', 'Probe Form', { e: [0, 0, 333, 275] }),
      node('0/0/0', 'push button', 'Cancel', { e: [0, 0, 162, 44], a: ['click'] }),
      node('0/0/1', 'push button', 'OK', { e: [0, 0, 162, 44], a: ['click'] }),
      node('0/0/2', 'label', 'Sign in', { e: [0, 0, 44, 19] }),
    ]);
    expect(screenBoundsAreTrustworthy(gtk4)).toBe(false);
  });

  it('accepts a tree whose elements report distinct origins', () => {
    expect(screenBoundsAreTrustworthy(compressA11yTree(buildA11yTree(FIXTURE)).roots)).toBe(true);
  });

  it('does not condemn a small tree that happens to sit at the origin', () => {
    const tiny = buildA11yTree([
      node('0', 'application', 'a', { s: [], e: null }),
      node('0/0', 'push button', 'Only', { e: [0, 0, 10, 10], a: ['click'] }),
    ]);
    expect(screenBoundsAreTrustworthy(tiny)).toBe(true);
  });
});

describe('actionCommand', () => {
  it('activates via the a11y bus, carrying the ref and the chosen action', () => {
    const cmd = actionCommand(':99', BUS, '#0/0/2', 'click');
    expect(cmd.bin).toBe('gjs');
    expect(cmd.args[1]).toBe(ATSPI_ACTION_JS);
    expect(cmd.args[2]).toBe('0/0/2');
    expect(cmd.args[3]).toBe('click');
    expect(cmd.env.AT_SPI_BUS_ADDRESS).toBe(BUS);
    expect(cmd.env.DISPLAY).toBe(':99');
  });

  it('rejects anything that is not an element ref, with the shape it wanted', () => {
    expect(() => actionCommand(':99', BUS, 'OK button')).toThrow(/is not an element ref/);
    expect(() => actionCommand(':99', BUS, '')).toThrow(/is not an element ref/);
    expect(() => actionCommand(':99', BUS, '0//2')).toThrow(/is not an element ref/);
  });

  it('inherits the sandbox and bus rails from walkerCommand', () => {
    expect(() => actionCommand(':0', BUS, '0/0')).toThrow(/HOST display/);
    expect(() => actionCommand(':99', '', '0/0')).toThrow(NoAccessibilityBusError);
  });

  it('carries an action program that always emits a sentinel, on every exit path', () => {
    // Each `emit(...)` is one sentinel use; a path that returns without emitting
    // would parse as "the action never ran".
    expect(ATSPI_ACTION_JS.split(ATSPI_SENTINEL).length - 1).toBe(1);
    expect(ATSPI_ACTION_JS).toContain('imports.system.exit(0)');
  });
});

describe('compressA11yTree', () => {
  const compressed = () => compressA11yTree(buildA11yTree(FIXTURE));

  it('lifts widgets out of the unnamed scaffolding boxes GTK nests everything in', () => {
    const { roots } = compressed();
    // application > frame > [widgets]; the filler AND the multi-child panel are
    // spliced away, which a collapse-1-child-chains rule could not have done.
    const frame = roots[0]!.children[0]!;
    expect(frame.role).toBe('frame');
    const kids = frame.children.map((c) => c.role);
    expect(kids).not.toContain('filler');
    expect(kids).not.toContain('panel');
    expect(kids).toEqual(['label', 'entry', 'password text', 'push button', 'push button']);
  });

  it('measurably shrinks the tree it was given', () => {
    const { stats } = compressed();
    expect(stats.rawNodes).toBe(FIXTURE.length);
    expect(stats.keptNodes).toBeLessThan(stats.rawNodes);
  });

  it('NEVER drops a showing interactive node — the invariant the whole design rests on', () => {
    const { roots } = compressed();
    const rendered = renderA11yTree(roots);
    expect(rendered).toContain('"OK"');
    expect(rendered).toContain('"Apply"');
    expect(rendered).toContain('"Username"');
    expect(rendered).toContain('"Password"');
  });

  it('DOES drop a not-showing menu subtree, so the model cannot click items that are not on screen', () => {
    const { roots } = compressed();
    const rendered = renderA11yTree(roots);
    expect(rendered).not.toContain('"Quit"');
    expect(rendered).not.toContain('"File"');
  });

  it('keeps a hidden subtree when the caller explicitly asks for it', () => {
    const { roots } = compressA11yTree(buildA11yTree(FIXTURE), { includeHidden: true });
    expect(renderA11yTree(roots)).toContain('"Quit"');
  });

  it('drops decorative leaves that carry no name, text, children or actions', () => {
    const { roots } = compressed();
    expect(renderA11yTree(roots)).not.toContain('filler');
  });

  it('always keeps the application root, so an empty app is distinguishable from no app', () => {
    const bare = buildA11yTree([node('0', 'application', 'ghost-app', { s: [], e: null })]);
    const { roots } = compressA11yTree(bare);
    expect(roots).toHaveLength(1);
    expect(roots[0]!.name).toBe('ghost-app');
  });

  it('caps same-role siblings and reports how many it hid', () => {
    const many: RawA11yNode[] = [node('0', 'application', 'list-app', { s: [], e: null }), node('0/0', 'frame', 'L')];
    for (let i = 0; i < 50; i++) {
      many.push(node(`0/0/${i}`, 'list item', `row ${i}`, { s: ['showing', 'visible', 'enabled'] }));
    }
    const { roots, stats } = compressA11yTree(buildA11yTree(many), { maxSiblingsPerRole: 5 });
    const rendered = renderA11yTree(roots);
    expect(rendered).toContain('row 0');
    expect(rendered).not.toContain('row 40');
    expect(rendered).toContain('… +45 more');
    expect(stats.truncated).toBe(true);
  });

  it('enforces the global node cap and flags the truncation', () => {
    const { stats } = compressA11yTree(buildA11yTree(FIXTURE), { maxNodes: 3 });
    expect(stats.keptNodes).toBeLessThanOrEqual(3);
    expect(stats.truncated).toBe(true);
  });

  it('clips long names rather than letting one tooltip dominate the observation', () => {
    const long = 'x'.repeat(500);
    const tree = buildA11yTree([
      node('0', 'application', 'a', { s: [], e: null }),
      node('0/0', 'push button', long, { s: ['showing', 'visible', 'enabled'], a: ['click'] }),
    ]);
    const { roots } = compressA11yTree(tree, { maxNameChars: 20 });
    expect(roots[0]!.children[0]!.name).toHaveLength(20);
    expect(roots[0]!.children[0]!.name.endsWith('…')).toBe(true);
  });
});

describe('renderA11yTree', () => {
  it('emits a #ref for interactive nodes and none for static context', () => {
    const { roots } = compressA11yTree(buildA11yTree(FIXTURE));
    const lines = renderA11yTree(roots).split('\n');
    const okLine = lines.find((l) => l.includes('"OK"'))!;
    const labelLine = lines.find((l) => l.includes('"Sign in"'))!;
    expect(okLine).toContain('#0/0/0/0/3');
    expect(labelLine).not.toContain('#');
  });

  it('renders state flags, including disabled as the absence of enabled', () => {
    const { roots } = compressA11yTree(buildA11yTree(FIXTURE));
    const lines = renderA11yTree(roots).split('\n');
    expect(lines.find((l) => l.includes('"Username"'))).toContain('[focused editable]');
    expect(lines.find((l) => l.includes('"Apply"'))).toContain('disabled');
    expect(lines.find((l) => l.includes('"OK"'))).not.toContain('disabled');
  });

  it('does NOT call a GTK4 widget disabled just because it reports sensitive, not enabled', () => {
    // GTK 4.14.5 sets SENSITIVE and never ENABLED. Testing ENABLED alone would label
    // every widget in every GTK4 app disabled.
    const gtk4 = buildA11yTree([
      node('0', 'application', 'zenity', { s: [], e: null }),
      node('0/0', 'push button', 'Cancel', {
        s: ['showing', 'visible', 'sensitive', 'focusable'], a: ['click'], e: [10, 10, 80, 30],
      }),
    ]);
    const { roots } = compressA11yTree(gtk4);
    expect(renderA11yTree(roots)).not.toContain('disabled');
  });

  it('renders an entry\'s text value, which a screenshot can only show as pixels', () => {
    const { roots } = compressA11yTree(buildA11yTree(FIXTURE));
    expect(renderA11yTree(roots)).toContain('= "avi"');
  });

  it('omits bounds by default and includes them on request', () => {
    const { roots } = compressA11yTree(buildA11yTree(FIXTURE));
    expect(renderA11yTree(roots)).not.toContain('300,160');
    expect(renderA11yTree(roots, { includeBounds: true })).toContain('(300,160 80x30)');
  });
});

describe('findByRef + elementClickPoint', () => {
  const roots = () => compressA11yTree(buildA11yTree(FIXTURE)).roots;

  it('resolves a ref with or without the rendered # prefix', () => {
    expect(findByRef(roots(), '0/0/0/0/3')?.name).toBe('OK');
    expect(findByRef(roots(), '#0/0/0/0/3')?.name).toBe('OK');
  });

  it('returns null for an unknown or blank ref instead of guessing a neighbour', () => {
    expect(findByRef(roots(), '9/9/9')).toBeNull();
    expect(findByRef(roots(), '')).toBeNull();
  });

  it('clicks the CENTRE of the element in DISPLAY space — never scaled by capture geometry', () => {
    const ok = findByRef(roots(), '0/0/0/0/3')!;
    // Bounds [300,160,80,30] -> centre (340,175). The same point regardless of the
    // capture box, which is the structural advantage of an element click over a
    // pixel click under D-006 downscaling.
    expect(elementClickPoint(ok, { width: 1920, height: 1080 })).toEqual([340, 175]);
    expect(elementClickPoint(ok, { width: 1024, height: 768 })).toEqual([340, 175]);
  });

  it('clamps a centre that falls outside the display', () => {
    const off: A11yNode = {
      ref: '0/1', role: 'push button', name: 'Far', states: ['showing'], bounds: [5000, 5000, 20, 20],
      actions: ['click'], value: '', children: [],
    };
    expect(elementClickPoint(off, { width: 1024, height: 768 })).toEqual([1023, 767]);
  });

  it('refuses a zero-area element loudly instead of clicking its corner', () => {
    const zero: A11yNode = {
      ref: '0/2', role: 'menu item', name: 'Quit', states: ['visible'], bounds: [0, 0, 0, 0],
      actions: ['click'], value: '', children: [],
    };
    expect(() => elementClickPoint(zero, { width: 1024, height: 768 })).toThrow(/zero-area/);
  });

  it('refuses an element with no bounds at all', () => {
    const none: A11yNode = {
      ref: '0', role: 'application', name: 'a', states: [], bounds: null, actions: [], value: '', children: [],
    };
    expect(() => elementClickPoint(none, { width: 1024, height: 768 })).toThrow(/no on-screen bounds/);
  });
});

const BUS = 'unix:path=/run/user/1000/at-spi/bus_99,guid=abc';

describe('parseA11yBusAddress', () => {
  it('parses gdbus\'s tuple — the PRIMARY probe\'s output shape', () => {
    expect(parseA11yBusAddress(`('${BUS}',)`)).toBe(BUS);
  });

  it('parses xprop\'s property line — the fallback probe\'s shape, same parser', () => {
    expect(parseA11yBusAddress(`AT_SPI_BUS(STRING) = "${BUS}"`)).toBe(BUS);
  });

  it('accepts a bare address', () => {
    expect(parseA11yBusAddress(BUS)).toBe(BUS);
    expect(parseA11yBusAddress('unix:abstract=/tmp/dbus-x')).toBe('unix:abstract=/tmp/dbus-x');
  });

  it('returns null for the absent-property answer — a real "no a11y bus here"', () => {
    expect(parseA11yBusAddress('AT_SPI_BUS:  no such atom on any window.')).toBeNull();
    expect(parseA11yBusAddress('')).toBeNull();
    expect(parseA11yBusAddress('GDBus.Error:org.freedesktop.DBus.Error.ServiceUnknown')).toBeNull();
  });
});

describe('a11yBusCommand', () => {
  it('asks the desktop\'s OWN session bus, and carries no DISPLAY to be steered by', () => {
    const cmd = a11yBusCommand('unix:path=/tmp/dbus-abc');
    expect(cmd.bin).toBe('gdbus');
    expect(cmd.args).toContain('org.a11y.Bus');
    expect(cmd.args).toContain('org.a11y.Bus.GetAddress');
    expect(cmd.env.DBUS_SESSION_BUS_ADDRESS).toBe('unix:path=/tmp/dbus-abc');
    expect(cmd.env.DISPLAY).toBeUndefined();
  });

  it('refuses without a session bus address rather than probing the ambient one', () => {
    expect(() => a11yBusCommand('')).toThrow(/requires the desktop's session bus address/);
  });
});

describe('walkerCommand', () => {
  it('inherits the sandbox rail — reading a desktop is as guarded as driving one', () => {
    expect(() => walkerCommand(':0', BUS)).toThrow(/HOST display/);
    expect(() => walkerCommand('not-a-display', BUS)).toThrow(/invalid display/);
  });

  it('binds DISPLAY to the sandbox and carries the walker on argv', () => {
    const cmd = walkerCommand(':99', BUS);
    expect(cmd.bin).toBe('gjs');
    expect(cmd.args[0]).toBe('-c');
    expect(cmd.args[1]).toBe(ATSPI_WALKER_JS);
    expect(cmd.env.DISPLAY).toBe(':99');
  });

  it('PINS the a11y bus and strips the host bus keys — the 69-app leak guard', () => {
    const cmd = walkerCommand(':99', BUS);
    expect(cmd.env.AT_SPI_BUS_ADDRESS).toBe(BUS);
    for (const key of HOST_BUS_ENV_KEYS) {
      if (key === 'AT_SPI_BUS_ADDRESS') continue;
      expect(cmd.env[key]).toBeUndefined();
    }
  });

  it('strips an INHERITED host bus address rather than letting it win', () => {
    const dirty = {
      ...process.env,
      DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/1000/bus',
      AT_SPI_BUS_ADDRESS: 'unix:path=/run/user/1000/at-spi/bus',
    } as NodeJS.ProcessEnv;
    const restore = { ...process.env };
    try {
      Object.assign(process.env, dirty);
      const cmd = walkerCommand(':99', BUS);
      expect(cmd.env.AT_SPI_BUS_ADDRESS).toBe(BUS);
      expect(cmd.env.DBUS_SESSION_BUS_ADDRESS).toBeUndefined();
    } finally {
      for (const k of Object.keys(process.env)) if (!(k in restore)) delete process.env[k];
      Object.assign(process.env, restore);
    }
  });

  it('REFUSES to walk without a bus address instead of silently reading the host session', () => {
    expect(() => walkerCommand(':99', '')).toThrow(NoAccessibilityBusError);
    expect(() => walkerCommand(':99', '   ')).toThrow(/REFUSING to fall back/);
  });

  it('carries a walker that prints exactly one sentinel line on both paths', () => {
    // Cheap structural guard: the success and failure paths must BOTH emit the
    // sentinel, or a walk that throws would parse as "the walker never ran".
    const emissions = ATSPI_WALKER_JS.split(ATSPI_SENTINEL).length - 1;
    expect(emissions).toBe(2);
  });
});

describe('A11Y_APP_ENV', () => {
  it('enables the bridge for GTK3, GTK4 and Qt in one env — no per-toolkit guess', () => {
    expect(A11Y_APP_ENV.GTK_A11Y).toBe('atspi');
    expect(A11Y_APP_ENV.GTK_MODULES).toContain('atk-bridge');
    expect(A11Y_APP_ENV.NO_AT_BRIDGE).toBe('0');
    expect(A11Y_APP_ENV.QT_ACCESSIBILITY).toBe('1');
  });
});

describe('token estimates', () => {
  it('keeps the image constant identical to the one D-006 measured with', () => {
    expect(estimateImageTokens(1024, 576)).toBe(786);
    expect(estimateImageTokens(1920, 1080)).toBe(2765);
  });

  it('makes the P-007 comparison a ratio between two observations of one screen', () => {
    const { roots } = compressA11yTree(buildA11yTree(FIXTURE));
    const text = renderA11yTree(roots);
    const treeTokens = estimateTextTokens(text);
    const shotTokens = estimateImageTokens(1024, 576);
    expect(treeTokens).toBeGreaterThan(0);
    expect(treeTokens).toBeLessThan(shotTokens);
  });
});

/**
 * EI-22074168424155872 — the refusal's REMEDY, which is the half that misleads.
 *
 * The guard itself is correct and deliberately unweakened here. What was wrong is
 * that the remedy asserted a cause nobody measured ("it needs at-spi2-core + gjs"),
 * so it read as *your host is missing packages* on a host where every one of them
 * was installed. The cause it never named is the one that actually holds: only
 * `provisionSandboxDesktop` starts a per-display at-spi bus and publishes it on the
 * root window, so a hand-rolled Xvfb cannot be observed however complete the host is.
 */
describe('NoAccessibilityBusError remedy', () => {
  const msg = new NoAccessibilityBusError(':111').message;

  it('names the display and keeps the fail-closed rationale that must not be weakened', () => {
    expect(msg).toContain(':111');
    expect(msg).toContain('REFUSING to fall back to the ambient session bus');
  });

  it('leads with the provisioner discriminator, not with the host packages', () => {
    expect(msg).toContain('computer:provision_desktop');
    expect(msg).toContain('computer:list_desktops');
    // Ordering is the assertion: the reader acts on the first cause they are given,
    // and the package cause is the one that was false in the filed report.
    expect(msg.indexOf('computer:provision_desktop')).toBeLessThan(msg.indexOf('at-spi2-core'));
  });

  it('still offers the fallback that always works', () => {
    expect(msg).toContain('capability:computer screenshot');
  });

  it('qualifies the host-package cause instead of prescribing it outright', () => {
    // The control: the old text said "To fix: provision the desktop with
    // accessibility enabled (it needs …)" — an unconditional prescription.
    expect(msg).not.toContain('To fix: provision the desktop with accessibility enabled');
    expect(msg).toContain('Only if this display WAS provisioned');
  });
});
