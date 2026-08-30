/**
 * RECURRENCE GUARD for D-018 (plan `gateway-kernel-adoption-2026-08-29`).
 *
 * THE DEFECT THIS CATCHES. Migrating a hand-rolled retry ladder onto the request
 * kernel means re-expressing each of its behaviours as an adapter option. When one
 * of those behaviours is forgotten, the usual failure is loud — a missing option is
 * a type error. The QUIET failure is the one that actually happened: the option was
 * threaded all the way in and then never read.
 *
 * `overloadBackoffMs` was passed from gateway.ts and appeared nowhere in
 * claude-kernel-adapter.ts but its own declaration, so a 529 "backoff and retry"
 * branch re-asked the upstream instantly. Nothing typechecked wrong, no adapter test
 * failed, and `npm run lint:tsc` was clean — an interface field has no unused-symbol
 * diagnostic. The only symptom was a load-shaped tally in an unrelated rig drifting
 * by one, which reads exactly like a flake.
 *
 * NOT A STYLE RULE. A genuinely write-only option does not exist here: an adapter's
 * options ARE its behaviour. If a field is legitimately unread, the field is dead and
 * belongs deleted, not exempted.
 *
 * WHY EVERY STEP IS DERIVED RATHER THAN LISTED. The first draft of this guard assumed
 * the `…AdapterOptions` / `opts.` convention three of the four adapters happen to
 * share. `codex-cli` uses `CodexCliKernelAdapterDeps` / `deps.`, so that draft parsed
 * ZERO fields for it and — but for the calibration assertions below — would have
 * reported a confident pass over an adapter it never looked at. So the parameter name
 * and its type are both read off the factory signature, and a file the guard cannot
 * parse is a FAILURE, never a silent skip. That is the same defect class as the bug
 * itself: a measurement that measured nothing, rendered as a clean result.
 */
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const DIR = import.meta.dirname;

/** Every `*-kernel-adapter.ts` here — discovered, never listed, so a lane migrated
 *  tomorrow is covered without anyone remembering to enrol it. */
function adapterFiles(): string[] {
  return readdirSync(DIR)
    .filter((name) => name.endsWith('-kernel-adapter.ts'))
    .sort();
}

interface AdapterShape {
  /** The factory's parameter name — `opts`, `deps`, whatever it is called. */
  param: string;
  /** Top-level field names of the parameter's interface. */
  fields: string[];
  /** The interface's own source, excluded from the read-search so a field's own
   *  declaration and doc comment can never count as a use of it. */
  declaration: string;
}

function adapterShape(source: string): AdapterShape | null {
  const factory = /export function create\w*KernelAdapter\(\s*(\w+)\s*:\s*(\w+)/.exec(source);
  if (!factory) return null;
  const [, param, typeName] = factory as unknown as [string, string, string];

  const start = source.search(new RegExp(`^export interface ${typeName}\\b`, 'm'));
  if (start < 0) return null;
  const end = source.indexOf('\n}', start);
  const declaration = source.slice(start, end < 0 ? source.length : end);

  const fields: string[] = [];
  for (const line of declaration.split('\n')) {
    // Top-level members only (exactly two spaces of indent): a nested object type's
    // members are not fields the adapter reads off the parameter.
    const match = /^ {2}([a-zA-Z][a-zA-Z0-9]*)\??[:(]/.exec(line);
    if (match) fields.push(match[1]!);
  }
  return { param, fields, declaration };
}

/** Names pulled off the parameter by destructuring (`const { a, b } = deps`) — read
 *  just as much as `deps.a` is, and the obvious way a future adapter will do it. */
function destructuredFrom(source: string, param: string): Set<string> {
  const names = new Set<string>();
  const pattern = new RegExp(`\\{([^{}]*)\\}\\s*=\\s*${param}\\b`, 'g');
  for (const match of source.matchAll(pattern)) {
    for (const part of match[1]!.split(',')) {
      const name = /^\s*(\w+)/.exec(part)?.[1];
      if (name) names.add(name);
    }
  }
  return names;
}

describe('kernel adapter options', () => {
  it('every declared option is actually READ by its adapter (D-018)', () => {
    const files = adapterFiles();
    expect(files.length, 'no *-kernel-adapter.ts found — the guard measured nothing').toBeGreaterThanOrEqual(4);

    const unread: string[] = [];
    for (const file of files) {
      const source = readFileSync(path.join(DIR, file), 'utf8');
      const shape = adapterShape(source);
      // A file this guard cannot parse is a HOLE in the guard, so it fails here
      // rather than being skipped into a clean-looking result.
      expect(shape, `${file}: could not locate its factory + options interface`).not.toBeNull();
      const { param, fields, declaration } = shape!;
      expect(fields.length, `${file}: parsed ZERO option fields — the guard measured nothing`).toBeGreaterThan(0);

      const body = source.replace(declaration, '');
      const destructured = destructuredFrom(body, param);
      for (const field of fields) {
        const read = new RegExp(`${param}\\.${field}\\b`).test(body) || destructured.has(field);
        if (!read) unread.push(`${file}: ${param}.${field}`);
      }
    }

    expect(
      unread,
      'these options are threaded in and never read — the ladder behaviour they represent is silently gone',
    ).toEqual([]);
  });

  it('CONTROL: the same predicate DOES report a field that is declared but never read', () => {
    // Run against a synthetic adapter with one unread option, so an empty `unread[]`
    // above means "nothing is unread" rather than "the matcher stopped matching".
    // Without this, a regex typo makes the guard pass forever.
    const synthetic = [
      'export interface FakeKernelAdapterDeps {',
      '  usedOne: number;',
      '  destructuredOne: number;',
      '  neverRead: number;',
      '}',
      'export function createFakeKernelAdapter(wired: FakeKernelAdapterDeps) {',
      '  const { destructuredOne } = wired;',
      '  return wired.usedOne + destructuredOne;',
      '}',
    ].join('\n');

    const shape = adapterShape(synthetic);
    expect(shape?.param, 'the parameter name is read off the factory, not assumed').toBe('wired');
    expect(shape!.fields).toEqual(['usedOne', 'destructuredOne', 'neverRead']);

    const body = synthetic.replace(shape!.declaration, '');
    const destructured = destructuredFrom(body, shape!.param);
    const unread = shape!.fields.filter(
      (field) => !new RegExp(`${shape!.param}\\.${field}\\b`).test(body) && !destructured.has(field),
    );
    expect(unread, 'a destructured field counts as read; only the untouched one is reported').toEqual(['neverRead']);
  });
});
