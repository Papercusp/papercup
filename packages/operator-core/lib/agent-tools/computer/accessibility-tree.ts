/**
 * accessibility-tree.ts — the pure AT-SPI observation path that sits BESIDE the
 * screenshot path (agent-virtual-desktops-2026-08-23 P-007; D-010).
 *
 * WHY THIS EXISTS. A computer-use loop pays for its eyes on EVERY step. D-006 cut
 * the per-observation image bill by capturing at 1024-wide instead of native
 * (1920x1080 -> 1024x576, 2,765 -> 786 tokens), but 786 tokens is the FLOOR for a
 * screenshot: the model is billed by area, so a screen with three buttons on it
 * costs exactly what a dense IDE costs. An accessibility tree is billed by CONTENT
 * instead — a simple dialog is a few dozen tokens — and it is the only observation
 * of the two that carries the semantics the model actually wants (which node is a
 * button, what it is called, whether it is focused, what the entry contains).
 *
 * THIS IS NOT A REPLACEMENT FOR THE SCREENSHOT and must never be sold as one. It
 * sees only what the toolkit EXPORTS: a GTK/Qt/Electron app publishes a rich tree,
 * a canvas-drawn app or a video publishes an empty box, and `xterm` — which is a
 * plain X11 client with no ATK bridge — publishes NOTHING AT ALL (measured on the
 * box 2026-08-23: a live 484x316 xterm window is entirely absent from the a11y
 * desktop). So an empty tree is genuinely ambiguous between "nothing is running"
 * and "this app is invisible to accessibility", which is precisely why `observe`
 * reports the app census it walked rather than just the tree: the caller can see
 * that it found zero applications and fall back to a screenshot.
 *
 * MECHANICS. AT-SPI2 exposes the tree over a per-session D-Bus. The bus address is
 * advertised on the X ROOT WINDOW as the `AT_SPI_BUS` property, which is what makes
 * this work per-display in a fleet of sandbox desktops: binding `DISPLAY` to the
 * sandbox is sufficient to reach that sandbox's OWN a11y bus and no other's
 * (measured: `AT_SPI_BUS(STRING) = "unix:path=/run/user/1000/at-spi/bus_114"` on
 * display :114). The walker is a `gjs` one-liner passed on argv — deliberately NOT
 * a checked-in `.js` asset, because operator-core is bundled and a runtime asset
 * path is one more thing that can be wrong in a release checkout that is right in
 * the source tree.
 *
 * This module is FRAMEWORK-INDEPENDENT and PURE by the same discipline as
 * `desktop-driver.ts`: no MCP imports, no process spawning. Every transformation
 * below unit-tests against a fixture with no live display.
 */

/** Debian/Ubuntu packages a desktop needs before ANY accessibility observation works. */
export const A11Y_APT_PACKAGES: readonly string[] = Object.freeze(['at-spi2-core', 'gjs']);

/**
 * Env that turns the accessibility bridge ON for a launched app.
 *
 * `GTK_A11Y=atspi` is the GTK4 selector; `GTK_MODULES=gail:atk-bridge` is the GTK3
 * one; `NO_AT_BRIDGE=0` un-does the opt-out some images set; `QT_ACCESSIBILITY=1`
 * covers Qt. They are additive and harmless where they do not apply, which is why
 * this is one constant rather than a per-toolkit branch the provisioner would have
 * to guess at before it knows what the app is.
 */
export const A11Y_APP_ENV: Readonly<Record<string, string>> = Object.freeze({
  GTK_A11Y: 'atspi',
  GTK_MODULES: 'gail:atk-bridge',
  NO_AT_BRIDGE: '0',
  QT_ACCESSIBILITY: '1',
});

/**
 * The sentinel the walker prefixes its ONE result line with.
 *
 * Load-bearing, not decoration: a headless GTK app floods stdout/stderr with
 * `libEGL warning`, `GLib-GIO-CRITICAL` and xdg-desktop-portal chatter (measured:
 * ~120 lines of it around a 3-line result). Scanning for a sentinel is what makes
 * the parse robust to noise that is guaranteed to be there.
 */
export const ATSPI_SENTINEL = '@@ATSPI@@';

/**
 * The walker, as a gjs program. Walks the a11y desktop and prints ONE sentinel line
 * of JSON. Keys are single letters because this is an internal wire format between
 * two halves of the same feature and every byte crosses a pipe on every observation.
 *
 * Everything is individually try/caught: a node can vanish mid-walk (the app is
 * live and repainting), and losing one node's name must degrade that node, never
 * abort the observation.
 */
export const ATSPI_WALKER_JS = `
imports.gi.versions.Atspi = '2.0';
const { Atspi } = imports.gi;
const MAX_NODES = ${5000};
const MAX_DEPTH = ${16};
const init = Atspi.init();
const out = [];
let truncated = false;
function states(n) {
  const s = [];
  try {
    const set = n.get_state_set();
    const M = [['showing', Atspi.StateType.SHOWING], ['visible', Atspi.StateType.VISIBLE],
               ['focused', Atspi.StateType.FOCUSED], ['focusable', Atspi.StateType.FOCUSABLE],
               ['enabled', Atspi.StateType.ENABLED], ['checked', Atspi.StateType.CHECKED],
               ['selected', Atspi.StateType.SELECTED], ['expanded', Atspi.StateType.EXPANDED],
               ['editable', Atspi.StateType.EDITABLE]];
    for (let i = 0; i < M.length; i++) if (set.contains(M[i][1])) s.push(M[i][0]);
  } catch (e) {}
  return s;
}
function extents(n) {
  try { const r = n.get_extents(Atspi.CoordType.SCREEN); return [r.x, r.y, r.width, r.height]; }
  catch (e) { return null; }
}
function actions(n) {
  const a = [];
  try { const c = n.get_n_actions(); for (let i = 0; i < c && i < 6; i++) a.push(n.get_action_name(i)); }
  catch (e) {}
  return a;
}
function value(n) {
  try {
    const t = n.get_text_iface();
    if (!t) return '';
    const len = t.get_character_count();
    if (!len) return '';
    return t.get_text(0, Math.min(len, 200)) || '';
  } catch (e) { return ''; }
}
function walk(n, path, depth) {
  if (depth > MAX_DEPTH || out.length >= MAX_NODES) { truncated = true; return; }
  let name = '', role = '?';
  try { name = n.get_name() || ''; } catch (e) {}
  try { role = n.get_role_name() || '?'; } catch (e) {}
  out.push({ p: path, r: role, n: name, s: states(n), e: extents(n), a: actions(n), v: value(n) });
  let count = 0;
  try { count = n.get_child_count(); } catch (e) { return; }
  for (let i = 0; i < count; i++) {
    let c = null;
    try { c = n.get_child_at_index(i); } catch (e) { continue; }
    if (c) walk(c, path + '/' + i, depth + 1);
  }
}
let apps = 0;
try {
  const desktop = Atspi.get_desktop(0);
  apps = desktop.get_child_count();
  for (let i = 0; i < apps; i++) {
    const app = desktop.get_child_at_index(i);
    if (app) walk(app, String(i), 0);
  }
} catch (e) {
  print('${ATSPI_SENTINEL}' + JSON.stringify({ ok: false, error: String(e), init, apps: 0, nodes: [] }));
  imports.system.exit(0);
}
print('${ATSPI_SENTINEL}' + JSON.stringify({ ok: true, init, apps, truncated, nodes: out }));
`;

/** One node exactly as the walker emitted it. */
export interface RawA11yNode {
  /** Child-index path from the a11y desktop, e.g. "0/2/1". THE ref. */
  p: string;
  /** AT-SPI role name, e.g. "push button". */
  r: string;
  /** Accessible name. */
  n: string;
  /** The subset of states the walker reports. */
  s: string[];
  /** [x, y, w, h] in SCREEN (display) pixels, or null when unobtainable. */
  e: [number, number, number, number] | null;
  /** Action names exposed by the Action interface. */
  a: string[];
  /** Text content for nodes implementing the Text interface (capped at 200 chars). */
  v: string;
}

export interface A11yWalkResult {
  ok: boolean;
  /** `Atspi.init()` return code. */
  init: number;
  /** How many applications were registered on the a11y bus. */
  apps: number;
  truncated?: boolean;
  error?: string;
  nodes: RawA11yNode[];
}

/** A node after the raw list is rebuilt into a tree. */
export interface A11yNode {
  /** The stable, STATELESS reference — the child-index path. */
  ref: string;
  role: string;
  name: string;
  states: string[];
  /** [x, y, w, h] in DISPLAY-space pixels (never capture space — see `elementClickPoint`). */
  bounds: [number, number, number, number] | null;
  actions: string[];
  value: string;
  children: A11yNode[];
  /** Set by compression when sibling capping dropped nodes after this one. */
  omittedSiblings?: number;
}

/**
 * Find the walker's one result line among the toolkit's noise and parse it.
 *
 * Returns null when no sentinel line is present, which is a REAL and distinct
 * outcome from an empty tree: it means the walker never ran (no gjs, no a11y bus,
 * a crash) and the caller must not report "nothing on screen".
 */
export function parseWalkerOutput(stdout: string): A11yWalkResult | null {
  const lines = (stdout ?? '').split('\n');
  // Scan from the END: the sentinel line is the last thing printed, and a GTK app
  // can emit warnings AFTER it that happen to contain the sentinel in a quoted
  // error string.
  for (let i = lines.length - 1; i >= 0; i--) {
    const at = lines[i]!.indexOf(ATSPI_SENTINEL);
    if (at < 0) continue;
    const json = lines[i]!.slice(at + ATSPI_SENTINEL.length).trim();
    try {
      const parsed = JSON.parse(json) as A11yWalkResult;
      if (!Array.isArray(parsed.nodes)) return null;
      return parsed;
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * Rebuild the flat, path-ordered node list into a forest (one root per application).
 *
 * The walker emits parents before children, so a single pass with a path->node map
 * is sufficient; a node whose parent path is missing (it was truncated away) becomes
 * a root rather than being dropped, so truncation degrades the SHAPE and never the
 * CONTENT.
 */
export function buildA11yTree(nodes: readonly RawA11yNode[]): A11yNode[] {
  const byPath = new Map<string, A11yNode>();
  const roots: A11yNode[] = [];
  for (const raw of nodes) {
    const node: A11yNode = {
      ref: raw.p,
      role: raw.r ?? '?',
      name: raw.n ?? '',
      states: Array.isArray(raw.s) ? raw.s : [],
      bounds: raw.e ?? null,
      actions: Array.isArray(raw.a) ? raw.a : [],
      value: raw.v ?? '',
      children: [],
    };
    byPath.set(node.ref, node);
    const slash = node.ref.lastIndexOf('/');
    const parent = slash < 0 ? undefined : byPath.get(node.ref.slice(0, slash));
    if (parent) parent.children.push(node);
    else roots.push(node);
  }
  return roots;
}

/** Roles that are pure layout scaffolding — they carry no meaning of their own. */
const SCAFFOLD_ROLES = new Set(['filler', 'panel', 'separator', 'redundant object', 'section', 'grouping']);

/**
 * Roles a model would plausibly ACT on. Used for two things: deciding which nodes
 * keep their ref in the rendering, and refusing to compress away something clickable.
 *
 * Membership is by role because `actions` is unreliable across toolkits — GTK4 in
 * particular exports a focusable, obviously-clickable button with an EMPTY action
 * list, so an actions-only test would silently strip the very nodes the tree exists
 * to expose.
 */
const INTERACTIVE_ROLES = new Set([
  'push button', 'button', 'toggle button', 'check box', 'radio button', 'link',
  'menu item', 'check menu item', 'radio menu item', 'menu', 'combo box', 'list item',
  'entry', 'text', 'password text', 'spin button', 'slider', 'page tab', 'tree item',
  'table cell', 'color chooser', 'calendar', 'switch',
]);

export function isInteractive(node: A11yNode): boolean {
  if (node.states.includes('editable')) return true;
  if (node.actions.length > 0) return true;
  if (node.states.includes('focusable') && node.role !== 'window' && node.role !== 'frame') return true;
  return INTERACTIVE_ROLES.has(node.role);
}

export interface CompressOptions {
  /** Hard cap on nodes kept. Default 200. */
  maxNodes?: number;
  /** Deepest level rendered, 0-based from the application. Default 12. */
  maxDepth?: number;
  /** Keep at most this many same-role siblings under one parent. Default 12. */
  maxSiblingsPerRole?: number;
  /** Truncate names/values to this many characters. Default 80. */
  maxNameChars?: number;
  /** Keep nodes the toolkit reports as not showing. Default false. */
  includeHidden?: boolean;
}

export interface CompressStats {
  /** Nodes the walker returned. */
  rawNodes: number;
  /** Nodes surviving compression. */
  keptNodes: number;
  /** True when a cap (nodes/depth/siblings) dropped something. */
  truncated: boolean;
}

/**
 * Squeeze the raw tree down to what a model can act on.
 *
 * The ordering of these passes is the whole design, because they are not
 * commutative: pruning must happen BOTTOM-UP (a scaffolding panel is only
 * droppable once we know whether anything under it survived), and collapsing must
 * happen AFTER pruning (a 1-child chain is usually only a 1-child chain once the
 * hidden siblings are gone). Running them the other way around keeps whole
 * subtrees of empty GTK boxes — which is exactly the noise this exists to remove.
 *
 * What is deliberately NOT dropped: anything `isInteractive`, whatever its name,
 * size or nesting. A compression that can hide a button is worse than no
 * compression at all, because the model cannot tell the difference between "there
 * is no Save button" and "the Save button was compressed away", and will confidently
 * report the former.
 */
export function compressA11yTree(
  roots: readonly A11yNode[],
  opts: CompressOptions = {},
): { roots: A11yNode[]; stats: CompressStats } {
  const maxNodes = opts.maxNodes ?? 200;
  const maxDepth = opts.maxDepth ?? 12;
  const maxSiblings = opts.maxSiblingsPerRole ?? 12;
  const maxChars = opts.maxNameChars ?? 80;
  const includeHidden = opts.includeHidden ?? false;

  let rawNodes = 0;
  let truncated = false;

  const clip = (s: string): string => (s.length > maxChars ? `${s.slice(0, maxChars - 1)}…` : s);

  /** Pass 1+2: bottom-up prune, then collapse. Returns null when the node is dropped. */
  const prune = (node: A11yNode, depth: number): A11yNode | null => {
    rawNodes += 1;
    if (depth > maxDepth) {
      truncated = true;
      return null;
    }
    const kids: A11yNode[] = [];
    for (const child of node.children) {
      const kept = prune(child, depth + 1);
      if (kept) kids.push(kept);
    }

    // Sibling capping, per role, so a 500-row list costs a line and a count rather
    // than 500 lines. Applied here (post-prune) so the cap counts nodes that SURVIVED.
    const capped: A11yNode[] = [];
    const perRole = new Map<string, number>();
    let dropped = 0;
    for (const child of kids) {
      const seen = perRole.get(child.role) ?? 0;
      if (seen >= maxSiblings) {
        dropped += 1;
        truncated = true;
        continue;
      }
      perRole.set(child.role, seen + 1);
      capped.push(child);
    }
    if (dropped > 0 && capped.length > 0) capped[capped.length - 1]!.omittedSiblings = dropped;

    const isApp = depth === 0;
    const interactive = isInteractive(node);
    const named = node.name.trim().length > 0;
    const hasText = node.value.trim().length > 0;

    // An application root is always kept: it is the census the caller needs in order
    // to tell "no apps on the a11y bus" from "apps present, nothing interesting".
    if (isApp) {
      return { ...node, name: clip(node.name), value: clip(node.value), children: capped };
    }

    // Hidden / zero-area nodes go, unless something under them survived. A GTK menu
    // that has never been opened is a real, fully-populated subtree reported as not
    // showing; rendering it would invite the model to click items that are not there.
    if (!includeHidden && capped.length === 0) {
      const showing = node.states.includes('showing') || node.states.includes('visible');
      if (!showing) return null;
      const area = node.bounds ? node.bounds[2] * node.bounds[3] : 0;
      if (area <= 0 && !interactive) return null;
    }

    // A leaf carrying no meaning at all.
    if (capped.length === 0 && !interactive && !named && !hasText) return null;

    // Scaffolding: an unnamed, non-interactive layout box. Its children are lifted
    // into its parent by returning a marker the caller splices — handled below by
    // returning the single child directly when there is exactly one, and by keeping
    // the box otherwise (a box with several children is genuine grouping information).
    if (SCAFFOLD_ROLES.has(node.role) && !named && !interactive && capped.length === 1) {
      return capped[0]!;
    }

    return { ...node, name: clip(node.name), value: clip(node.value), children: capped };
  };

  const pruned: A11yNode[] = [];
  for (const root of roots) {
    const kept = prune(root, 0);
    if (kept) pruned.push(kept);
  }

  // Pass 3: the global node cap, applied depth-first so the cut is a suffix of the
  // rendering rather than a hole in the middle of it.
  let budget = maxNodes;
  const capTree = (node: A11yNode): A11yNode | null => {
    if (budget <= 0) {
      truncated = true;
      return null;
    }
    budget -= 1;
    const kids: A11yNode[] = [];
    for (const child of node.children) {
      const kept = capTree(child);
      if (kept) kids.push(kept);
    }
    return { ...node, children: kids };
  };
  const out: A11yNode[] = [];
  for (const root of pruned) {
    const kept = capTree(root);
    if (kept) out.push(kept);
  }

  let keptNodes = 0;
  const count = (n: A11yNode): void => {
    keptNodes += 1;
    n.children.forEach(count);
  };
  out.forEach(count);

  return { roots: out, stats: { rawNodes, keptNodes, truncated } };
}

/** State flags worth a byte in the rendering. `showing`/`visible` are the norm, so
 *  rendering them would spend tokens saying "normal" on nearly every line. */
const RENDERED_STATES = ['focused', 'checked', 'selected', 'expanded', 'editable'] as const;

export interface RenderOptions {
  /** Include [x,y w×h] bounds on every node. Default false — the ref makes them
   *  unnecessary for clicking, and they are ~12 tokens per line. */
  includeBounds?: boolean;
}

/**
 * Render the tree as the text the model reads.
 *
 * Format is one node per line, indented by depth:
 *
 *     zenity
 *       frame "Probe Form"
 *         label "Sign in"
 *         entry "Username" #0/0/0/1 [editable]
 *
 * A `#ref` is emitted ONLY for interactive nodes. That is a deliberate token trade:
 * refs exist to be passed back to `computer:click_element`, and a ref on a static
 * label is a token spent on something nobody will ever click. Static nodes still
 * appear — they are the context that makes the interactive ones legible.
 */
export function renderA11yTree(roots: readonly A11yNode[], opts: RenderOptions = {}): string {
  const lines: string[] = [];
  const emit = (node: A11yNode, depth: number): void => {
    const pad = '  '.repeat(depth);
    let line = `${pad}${node.role}`;
    if (node.name) line += ` "${node.name}"`;
    if (node.value && node.value !== node.name) line += ` = "${node.value}"`;
    if (isInteractive(node)) line += ` #${node.ref}`;
    const flags = RENDERED_STATES.filter((s) => node.states.includes(s));
    if (!node.states.includes('enabled') && !SCAFFOLD_ROLES.has(node.role)) flags.push('disabled' as never);
    if (flags.length) line += ` [${flags.join(' ')}]`;
    if (opts.includeBounds && node.bounds) {
      const [x, y, w, h] = node.bounds;
      line += ` (${x},${y} ${w}x${h})`;
    }
    lines.push(line);
    for (const child of node.children) emit(child, depth + 1);
    if (node.omittedSiblings) lines.push(`${pad}… +${node.omittedSiblings} more`);
  };
  for (const root of roots) emit(root, 0);
  return lines.join('\n');
}

/** Resolve a `#ref` (a child-index path) back to its node. */
export function findByRef(roots: readonly A11yNode[], ref: string): A11yNode | null {
  const wanted = (ref ?? '').trim().replace(/^#/, '');
  if (!wanted) return null;
  const stack: A11yNode[] = [...roots];
  while (stack.length) {
    const node = stack.pop()!;
    if (node.ref === wanted) return node;
    for (const child of node.children) stack.push(child);
  }
  return null;
}

/**
 * The point `computer:click_element` drives the pointer to — the CENTRE of the
 * element, in DISPLAY space, clamped to the display.
 *
 * ⚠ DISPLAY space, NOT capture space, and that asymmetry with `capability:computer`
 * is the point rather than an oversight. AT-SPI reports `SCREEN` extents in real X
 * pixels, so an element click is structurally immune to the D-006 downscale that
 * every pixel-coordinate click has to be mapped through. It is also why an element
 * click stays correct when the capture geometry changes underneath it.
 */
export function elementClickPoint(
  node: A11yNode,
  display: { width: number; height: number },
): [number, number] {
  if (!node.bounds) throw new Error(`computer:click_element — element #${node.ref} reports no on-screen bounds`);
  const [x, y, w, h] = node.bounds;
  if (!(w > 0) || !(h > 0)) {
    throw new Error(
      `computer:click_element — element #${node.ref} (${node.role}${node.name ? ` "${node.name}"` : ''}) ` +
        `has a zero-area box (${w}x${h}); it is present in the tree but not on screen.`,
    );
  }
  const cx = Math.round(x + w / 2);
  const cy = Math.round(y + h / 2);
  return [
    Math.max(0, Math.min(cx, display.width - 1)),
    Math.max(0, Math.min(cy, display.height - 1)),
  ];
}

/**
 * The walker invocation for a display. `gjs -c <program>` rather than a checked-in
 * script path — see the module header for why an asset path is the wrong dependency
 * for a bundled package.
 */
export function walkerCommand(display: string): { bin: string; args: string[] } {
  return { bin: 'gjs', args: ['-c', ATSPI_WALKER_JS] };
}

/**
 * ~Tokens for a piece of observation text, and for an image of a given size, using
 * ONE stated method so the P-007 comparison is apples-to-apples.
 *
 * Image: Claude meters at roughly (w*h)/750 — the same constant D-006's measurement
 * used, kept here so the two numbers remain comparable.
 * Text: ~4 characters per token, the standard English approximation.
 *
 * Both are ESTIMATES and are labelled as such wherever they surface. The comparison
 * they support is a ratio between two observations of the SAME screen, which is
 * robust to the constant being a few percent off in either direction; an absolute
 * token count from this function is not evidence of anything.
 */
export function estimateImageTokens(width: number, height: number): number {
  return Math.round((width * height) / 750);
}

export function estimateTextTokens(text: string): number {
  return Math.ceil((text ?? '').length / 4);
}
