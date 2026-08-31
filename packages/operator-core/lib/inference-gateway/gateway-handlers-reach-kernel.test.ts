/**
 * RECURRENCE GUARD for WI-1408459 / P-008 (plan `gateway-kernel-adoption-2026-08-29`).
 *
 * THE GAP THIS CLOSES. P-008 asked for "a GUARD that FAILS if any registered lane
 * executes outside the kernel — so the duplication cannot grow back". Half of that is
 * already enforced by the COMPILER: `legacyEntryExecutor`, `executeGatewayLegacyLane`
 * and `executeLegacyLaneTask` are deleted (they survive only as explanatory comments),
 * so re-introducing a lane ENTRY outside the kernel does not typecheck, and
 * `request-kernel.test.ts` drives all 44 registry rows through the kernel.
 *
 * The other half was covered by nothing. Lane entry is not the only way the ladder can
 * grow back: a NEW handler inside `gateway.ts` can open its own upstream request and
 * hand-roll an attempt loop, stall timer and deadline BESIDE the kernel without
 * touching the lane registry at all. Measured 2026-08-31: no test read `gateway.ts`
 * source, and nothing asserted any correspondence between the file's request handlers
 * and its kernel call sites.
 *
 * THE PROPERTY. In the migrated design `gateway.ts` owns routing, admission and
 * telemetry — the TRANSPORT lives in the adapters, driven by the kernel. So the file's
 * own network-open census is the falsifier, and it is very small: measured at the time
 * of writing, ONE site, a self-loopback that re-enters the gateway's own front door.
 * Two assertions follow from that, and they cover each other's blind spot:
 *
 *   1. HANDLER LEVEL — a request handler that reaches a network open must also reach
 *      `executeGatewayRequestKernel`. Catches a whole new proxy handler.
 *   2. SITE LEVEL — every network-open site must carry an at-site marker saying why it
 *      is not an inference upstream. Catches a new branch added INSIDE an existing
 *      handler, which assertion 1 cannot see: `dispatchRequest` is a ~900-line span
 *      that already reaches the kernel, so a hand-rolled `fetch` added to one of its
 *      route branches would ride in under a handler-level verdict.
 *
 * WHY THE POPULATION IS DERIVED RATHER THAN LISTED. The same reason
 * `kernel-adapter-options-are-read.test.ts` (D-018) derives its own: a guard that
 * hard-codes today's five proxy functions is blind to the sixth, which is precisely
 * the thing it exists to catch. Handlers are identified STRUCTURALLY — a function
 * taking both `http.IncomingMessage` and `http.ServerResponse` — never by a `proxy*` /
 * `serve*` naming convention, because a convention is exactly what a new author has no
 * reason to follow. Measuring that predicate is also what stopped the first draft of
 * this guard from being wrong: `beginRequestTelemetry` takes both and legitimately
 * never touches the kernel, so "every handler reaches the kernel" would have been a
 * false positive on day one. The predicate is the CONJUNCTION — opens upstream AND
 * does not reach the kernel — not the handler shape alone.
 *
 * WHY THE CONTROLS ARE NOT OPTIONAL. Both predicates report violations by returning an
 * EMPTY list, so a matcher that silently stopped matching is indistinguishable from a
 * clean tree — a measurement that measured nothing, rendered as a pass. That is the
 * same defect class as the bugs this file family exists to catch, so each predicate is
 * calibrated against a synthetic positive, and the derived population is floor-checked.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The subject, overridable so falsifiability can be proven against a COPY. Without this
 * one line the only way to show this guard CAN fail is to mutate `gateway.ts` in the
 * shared tree — which the git-sync sweep can commit mid-probe even when nothing goes
 * wrong and no handler fails. A guard that has never failed is a guard nobody has tested.
 */
const GATEWAY = process.env.PROBE_GATEWAY_PATH ?? path.join(import.meta.dirname, 'gateway.ts');
const KERNEL = 'executeGatewayRequestKernel';

/**
 * Sites that OPEN a request, not ones that merely build a dispatcher. `new
 * undiciMod.Agent(...)` in `dispatcherFor` constructs the per-account egress agent that
 * is then handed to an adapter; it is not itself an upstream call, and counting it
 * would demand three markers that say nothing.
 */
const OPEN_RE = /\bfetch\s*\(|\bhttps?\.request\s*\(|\.request\s*\(|\.dispatch\s*\(|\b(?:net|tls)\.connect\s*\(/;

/**
 * At-site justification for a network open that is not an inference upstream. Deliberately
 * at the SITE and not in a list in this file: a list drifts out of sight, and a reviewer
 * reading the open needs the reason next to it. A reason is mandatory — the marker exists
 * to force the sentence, not to provide a mute opt-out.
 */
const MARKER_RE = /GATEWAY-NON-UPSTREAM:\s*\S/;
/** How far above a site its marker may sit, so a marker cannot drift onto an unrelated open. */
const MARKER_LOOKBACK = 8;

const DECL_RES = [
  /^(\s*)(?:export\s+)?(?:async\s+)?function\s+(\w+)\s*\(/,
  /^(\s*)(?:export\s+)?(?:const|let)\s+(\w+)\s*(?::[^=]*)?=\s*(?:async\s*)?\(/,
];

interface Span {
  name: string;
  start: number;
  end: number;
  /** The parameter list, paren-matched off the declaration — used for handler detection. */
  params: string;
  /** Everything after the parameter list, so a parameter type can never count as a body use. */
  body: string;
  /** In-file functions this one calls, for transitive reachability. */
  calls: Set<string>;
}

interface Analysis {
  spans: Span[];
  handlers: Span[];
  openSites: { line: number; text: string; marked: boolean }[];
  opensUpstream(span: Span): boolean;
  reachesKernel(span: Span): boolean;
}

function analyze(source: string): Analysis {
  const lines = source.split('\n');
  const spans: Span[] = [];

  for (let i = 0; i < lines.length; i++) {
    for (const re of DECL_RES) {
      const match = re.exec(lines[i]!);
      if (!match) continue;
      const indent = match[1]!;
      // A declaration ends at the first following line that is exactly its own indent
      // plus a closing brace. Every function in gateway.ts is either top level or one
      // level inside the factory closure, so this is unambiguous there — and a shape it
      // cannot bracket shows up as a span that swallows the rest of the file, which the
      // floor checks below turn into a failure rather than a silent miss.
      let end = lines.length - 1;
      for (let j = i + 1; j < lines.length; j++) {
        if (lines[j] === `${indent}}` || lines[j] === `${indent}};`) {
          end = j;
          break;
        }
      }
      const text = lines.slice(i, end + 1).join('\n');
      const open = text.indexOf('(', text.indexOf(match[2]!));
      let depth = 0;
      let close = open;
      for (let k = open; k < text.length; k++) {
        if (text[k] === '(') depth++;
        else if (text[k] === ')') {
          depth--;
          if (depth === 0) {
            close = k;
            break;
          }
        }
      }
      spans.push({
        name: match[2]!,
        start: i + 1,
        end: end + 1,
        params: text.slice(open + 1, close),
        body: text.slice(close + 1),
        calls: new Set<string>(),
      });
      break;
    }
  }

  const byName = new Map(spans.map((s) => [s.name, s]));
  for (const span of spans) {
    for (const call of span.body.matchAll(/\b(\w+)\s*\(/g)) {
      const name = call[1]!;
      if (name !== span.name && byName.has(name)) span.calls.add(name);
    }
  }

  const reach = (span: Span | undefined, pred: (body: string) => boolean, seen = new Set<string>()): boolean => {
    if (!span || seen.has(span.name)) return false;
    seen.add(span.name);
    if (pred(span.body)) return true;
    for (const call of span.calls) if (reach(byName.get(call), pred, seen)) return true;
    return false;
  };

  const openSites: Analysis['openSites'] = [];
  for (let i = 0; i < lines.length; i++) {
    if (!OPEN_RE.test(lines[i]!)) continue;
    const from = Math.max(0, i - MARKER_LOOKBACK);
    openSites.push({
      line: i + 1,
      text: lines[i]!.trim(),
      marked: lines.slice(from, i + 1).some((l) => MARKER_RE.test(l)),
    });
  }

  return {
    spans,
    handlers: spans.filter(
      (s) => /http\.IncomingMessage/.test(s.params) && /http\.ServerResponse/.test(s.params),
    ),
    openSites,
    opensUpstream: (span) => reach(span, (body) => OPEN_RE.test(body)),
    reachesKernel: (span) => reach(span, (body) => body.includes(KERNEL)),
  };
}

describe('gateway request handlers reach the kernel', () => {
  const source = readFileSync(GATEWAY, 'utf8');
  const gateway = analyze(source);

  it('parses a real handler population and a working call graph (anti "measured nothing")', () => {
    // Floors, not exact counts: the guard must keep working as handlers are added or
    // merged. What it may NEVER do is report a clean verdict over a population it
    // failed to parse, which is what every check here exists to prevent.
    expect(source).toContain(KERNEL);
    expect(
      gateway.handlers.length,
      'parsed too few (req, res) handlers — the declaration/brace parser is broken, so an empty violation list means nothing',
    ).toBeGreaterThanOrEqual(7);
    // If the reachability walk silently broke, BOTH predicates would go false and the
    // conjunction below would report zero violations while measuring nothing. This is
    // the check that makes that impossible.
    expect(
      gateway.handlers.filter((h) => gateway.reachesKernel(h)).length,
      'no handler resolves to the kernel — the call-graph walk is broken, not the tree',
    ).toBeGreaterThanOrEqual(5);
  });

  it('every handler that opens an upstream request reaches the kernel (P-008 re-growth)', () => {
    const regrown = gateway.handlers
      .filter((h) => gateway.opensUpstream(h) && !gateway.reachesKernel(h))
      .map((h) => `${h.name} (gateway.ts:${h.start})`);

    expect(
      regrown,
      'these handlers open a request without going through executeGatewayRequestKernel — ' +
        'the attempt loop, stall timer and deadline the kernel owns have grown back beside it',
    ).toEqual([]);
  });

  it('every network-open site is marked as non-upstream, with a reason', () => {
    const unmarked = gateway.openSites.filter((s) => !s.marked).map((s) => `gateway.ts:${s.line}: ${s.text}`);

    expect(
      unmarked,
      'gateway.ts owns routing and admission; the transport belongs to the adapters the kernel drives. ' +
        'Route this through executeGatewayRequestKernel, or explain at the site why it is not an ' +
        'inference upstream with a `GATEWAY-NON-UPSTREAM: <reason>` comment.',
    ).toEqual([]);
  });

  it('CONTROL: both predicates DO report a synthetic re-grown handler', () => {
    // Appended to the real source so the mutant is parsed by the same walk, under the
    // same indentation, as the handlers it sits beside. Without this, a regex typo or a
    // broken brace-matcher makes both assertions above pass forever.
    const mutant = analyze(
      `${source}\n` +
        '  async function proxyRegrown(req: http.IncomingMessage, res: http.ServerResponse, url: string) {\n' +
        '    for (let attempt = 0; attempt < 3; attempt++) {\n' +
        '      const upstream = await fetch(upstreamBase + url, { method: "POST" });\n' +
        '      if (upstream.status !== 429) { res.end(await upstream.text()); return; }\n' +
        '      await new Promise((done) => setTimeout(done, 1000 * attempt));\n' +
        '    }\n' +
        '  }\n',
    );

    const handler = mutant.handlers.find((h) => h.name === 'proxyRegrown');
    expect(handler, 'the synthetic handler was not even parsed — the control proves nothing').toBeDefined();
    expect(mutant.opensUpstream(handler!), 'the open-token matcher no longer fires').toBe(true);
    expect(mutant.reachesKernel(handler!), 'the kernel matcher reports a reach that does not exist').toBe(false);

    // Compared as a DELTA against the real file's own verdict, not as an absolute list.
    // Asserting `toEqual(['proxyRegrown'])` would also fail whenever the tree genuinely
    // has a re-grown handler — turning a real regression into three failures, one of them
    // pointing at this control instead of at the offending code. The delta keeps the
    // control selective (it still proves innocent handlers are not swept in) while
    // reporting only what the mutation itself introduced.
    const baseline = new Set(
      gateway.handlers.filter((h) => gateway.opensUpstream(h) && !gateway.reachesKernel(h)).map((h) => h.name),
    );
    expect(
      mutant.handlers
        .filter((h) => mutant.opensUpstream(h) && !mutant.reachesKernel(h))
        .map((h) => h.name)
        .filter((name) => !baseline.has(name)),
      'the handler-level predicate must report the re-grown handler, and nothing else new',
    ).toEqual(['proxyRegrown']);
    expect(
      mutant.openSites.filter((s) => !s.marked).length,
      'the site-level predicate must report the unmarked fetch the mutant introduced',
    ).toBeGreaterThan(gateway.openSites.filter((s) => !s.marked).length);
  });

  it('CONTROL: the open matcher recognises each transport form it claims to cover', () => {
    // A positive control per token, so shrinking OPEN_RE to something that matches
    // nothing cannot pass as a clean census.
    for (const form of [
      'const r = await fetch(url, { method: "POST" });',
      'const r = https.request(opts, cb);',
      'const r = http.request(opts, cb);',
      'const r = await client.request({ path });',
      'const r = await agent.dispatch(opts, handler);',
      'const s = net.connect(443, host);',
      'const s = tls.connect(443, host);',
    ]) {
      expect(OPEN_RE.test(form), `open matcher missed: ${form}`).toBe(true);
    }
    // And a negative control: building a dispatcher is not opening a request.
    expect(OPEN_RE.test('new undiciMod.Agent({ connect: { localAddress } });')).toBe(false);
  });

  it('CONTROL: a marker without a reason does not exempt a site', () => {
    expect(MARKER_RE.test('// GATEWAY-NON-UPSTREAM: self-loopback, re-enters our own front door')).toBe(true);
    expect(MARKER_RE.test('// GATEWAY-NON-UPSTREAM:')).toBe(false);
    expect(MARKER_RE.test('// GATEWAY-NON-UPSTREAM:   ')).toBe(false);
  });
});
