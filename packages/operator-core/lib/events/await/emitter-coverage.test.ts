/**
 * emitter-coverage.test — the RECURRENCE GUARD for EI-18676056143796303.
 *
 * The bug: `coord:inbox-wake:<ownerId>` — the most-fired key in the whole system
 * (8,989 fires across 118 owners), and the always-armed park that rescues a
 * stranded agent — emitted for months without ever being registered in
 * `./catalog`. So `events:await` reported a VALID registration on it as
 * `unknown_event_key`: "nothing in this system will ever fire it and this await
 * can only TIME OUT". An agent that believed that warning and re-parked on
 * something weaker stranded itself, which is the exact failure the inbox-wake
 * exists to prevent. Registering the families fixed the instance; the live-tree
 * assertion at the bottom of this file is what stops the next one.
 *
 * Structure: fixture-driven unit tests pin the scanner's semantics (so a future
 * edit to the regexes can't quietly stop detecting anything), then ONE assertion
 * runs it over the real repo.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  scanSourceForEventKeys,
  findUnregisteredEventKeys,
  formatUnregisteredEventKeys,
} from './emitter-coverage';
import { EVENT_CATALOG, type EventCatalogEntry } from './catalog';

/** Walk up until the directory looks like the monorepo root. */
function findRepoRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 12; i++) {
    if (existsSync(join(dir, 'packages')) && existsSync(join(dir, 'apps')) && existsSync(join(dir, 'package.json'))) {
      return dir;
    }
    dir = dirname(dir);
  }
  throw new Error('emitter-coverage.test: could not locate the repo root');
}

describe('scanSourceForEventKeys', () => {
  it('finds an inline string-literal key at an emit site', () => {
    const found = scanSourceForEventKeys(`await emitAwaitedEvent({ key: 'green-checkpoint:red' });`, 'f.ts');
    expect(found).toEqual([{ key: 'green-checkpoint:red', file: 'f.ts', line: 1, via: 'literal' }]);
  });

  it('takes the STATIC HEAD of a template-literal key and drops the dangling separator', () => {
    const found = scanSourceForEventKeys('await emitAwaitedEvent({ key: `escalation:resolved:${id}` });', 'f.ts');
    expect(found).toEqual([{ key: 'escalation:resolved', file: 'f.ts', line: 1, via: 'template' }]);
  });

  it('finds a NAMED KEY CONSTANT — the shape the live miss was emitted through', () => {
    // coord:inbox-wake is emitted via inboxWakeKey(), backed by this constant; a
    // call-site-literals-only scanner would have missed the very bug this guards.
    const found = scanSourceForEventKeys(
      `export const COORD_INBOX_WAKE_PREFIX = 'coord:inbox-wake:';\nemitAwaitedEvent({ key: inboxWakeKey(x) });`,
      'inbox-wake.ts',
    );
    expect(found).toEqual([{ key: 'coord:inbox-wake', file: 'inbox-wake.ts', line: 1, via: 'constant' }]);
  });

  it('matches the other key-constant name shapes (EVENT_KEY / KEY_PREFIX / WAKE_PREFIX / EVENT_PREFIX)', () => {
    const src = [
      `const REF_ANNOUNCE_EVENT_KEY = 'pot-git:ref-announce';`,
      `const A_KEY_PREFIX = 'aa:bb:';`,
      `const B_WAKE_PREFIX = 'cc:dd:';`,
      `const C_EVENT_PREFIX = 'ee:ff:';`,
    ].join('\n');
    expect(scanSourceForEventKeys(src, 'f.ts').map((f) => f.key)).toEqual([
      'pot-git:ref-announce',
      'aa:bb',
      'cc:dd',
      'ee:ff',
    ]);
  });

  it('IGNORES keys that appear only in comments — a documented example is not an emit', () => {
    const src = [
      `/** emits \`key: 'example:only-in-a-doc-comment'\` on every tick. */`,
      `// key: 'another:comment-example'`,
      `emitAwaitedEvent({ key: 'real:emitted-key' });`,
    ].join('\n');
    expect(scanSourceForEventKeys(src, 'f.ts').map((f) => f.key)).toEqual(['real:emitted-key']);
  });

  it('reports the line number from the ORIGINAL file (comment stripping must not shift lines)', () => {
    const src = ['/* a', '   multi-line', '   comment */', `emitAwaitedEvent({ key: 'x:y' });`].join('\n');
    expect(scanSourceForEventKeys(src, 'f.ts')[0]).toMatchObject({ key: 'x:y', line: 4 });
  });

  it('ignores non-key-shaped values (a single segment, a url, whitespace)', () => {
    const src = [`key: 'plain'`, `key: 'https://example.com/x'`, `key: 'has space:here'`].join('\n');
    expect(scanSourceForEventKeys(src, 'f.ts')).toEqual([]);
  });
});

describe('findUnregisteredEventKeys (over a synthetic tree)', () => {
  let repoRoot: string;

  beforeAll(() => {
    repoRoot = mkdtempSync(join(tmpdir(), 'emitter-coverage-'));
    mkdirSync(join(repoRoot, 'packages/x/node_modules/dep'), { recursive: true });
    mkdirSync(join(repoRoot, 'packages/x/nested'), { recursive: true });
    const write = (rel: string, text: string) => writeFileSync(join(repoRoot, rel), text);

    write(
      'packages/x/emits.ts',
      [
        `import { emitAwaitedEvent } from './engine';`,
        `emitAwaitedEvent({ key: \`release:deployed:\${sha}\` });`, // registered
        `emitAwaitedEvent({ key: 'totally:unregistered' });`, // NOT registered
      ].join('\n'),
    );
    // No emitAwaitedEvent ⇒ out of scope. `key:` is a very common property name
    // (auth tiers, UI interaction ids, perf-suite step names); scanning every file
    // that merely has one is ~75% false positives.
    write('packages/x/not-an-emitter.ts', `const rows = [{ key: 'auth:queen' }, { key: 'interaction:plan-popup-open' }];`);
    // A key invented by a test is not a real emitter.
    write('packages/x/emits.test.ts', `emitAwaitedEvent({ key: 'test-only:invented' });`);
    // Vendored code is never ours to register.
    write('packages/x/node_modules/dep/index.ts', `emitAwaitedEvent({ key: 'vendored:thing' });`);
    // …but a nested source dir IS walked.
    write('packages/x/nested/deep.ts', `emitAwaitedEvent({ key: 'nested:deep-key' });`);
  });

  afterAll(() => rmSync(repoRoot, { recursive: true, force: true }));

  it('flags emitted keys with no catalog family and stays quiet about registered ones', async () => {
    const res = await findUnregisteredEventKeys({ repoRoot, roots: ['packages'] });
    const keys = res.unregistered.map((u) => u.key);
    expect(keys).toContain('totally:unregistered');
    expect(keys).toContain('nested:deep-key'); // the walk recurses
    expect(res.scanned.map((s) => s.key)).toContain('release:deployed'); // seen, but registered
    expect(keys).not.toContain('release:deployed');
  });

  it('scopes to the emit surface and skips tests + node_modules', async () => {
    const res = await findUnregisteredEventKeys({ repoRoot, roots: ['packages'] });
    const keys = res.scanned.map((s) => s.key);
    expect(keys).not.toContain('auth:queen'); // no emitAwaitedEvent in that file
    expect(keys).not.toContain('interaction:plan-popup-open');
    expect(keys).not.toContain('test-only:invented'); // *.test.ts
    expect(keys).not.toContain('vendored:thing'); // node_modules
  });

  it('honours the ALLOW map and reports a STALE entry that matched nothing', async () => {
    const res = await findUnregisteredEventKeys({
      repoRoot,
      roots: ['packages'],
      allow: {
        'totally:unregistered': 'fixture: deliberately exempted',
        'nested:deep-key': 'fixture: deliberately exempted',
        'never:seen': 'fixture: matches nothing — must be reported stale',
      },
    });
    expect(res.unregistered).toEqual([]);
    expect(res.unusedAllow).toEqual(['never:seen']);
  });

  it('resolves against an INSTALLED-tier catalog when one is supplied', async () => {
    const withPack: EventCatalogEntry[] = [
      ...EVENT_CATALOG,
      {
        family: 'unregistered-pack',
        keyTemplate: 'totally:unregistered',
        params: [],
        describe: 'a pack-declared event',
        emitter: 'my-pack',
        exists: true,
      },
    ];
    const res = await findUnregisteredEventKeys({ repoRoot, roots: ['packages'], catalog: withPack });
    expect(res.unregistered.map((u) => u.key)).not.toContain('totally:unregistered');
  });

  it('formats a finding into a message that names the fix', () => {
    const msg = formatUnregisteredEventKeys([
      { key: 'coord:inbox-wake', file: 'packages/x/inbox-wake.ts', line: 36, via: 'constant' },
    ]);
    expect(msg).toContain('"coord:inbox-wake"');
    expect(msg).toContain('packages/x/inbox-wake.ts:36');
    expect(msg).toContain('catalog.ts');
  });

  it('formats empty findings as an empty string', () => {
    expect(formatUnregisteredEventKeys([])).toBe('');
  });
});

/**
 * Keys that legitimately have no catalog family. Each entry MUST carry a reason —
 * an unexplained exemption is how a real gap gets parked forever. Empty today:
 * every key the sweep found was a genuine family and got registered.
 */
const ALLOW: Record<string, string> = {};

describe('THE GUARD — every event key the source emits is registered in events:catalog', () => {
  it('finds no unregistered emitted key anywhere in the tree', async () => {
    const repoRoot = findRepoRoot();
    const res = await findUnregisteredEventKeys({
      repoRoot,
      roots: ['packages', 'apps', 'libs'],
      allow: ALLOW,
    });

    // Guard the guard: a scanner that silently stopped matching would pass this
    // test vacuously, which is the failure mode of every "assert nothing is
    // wrong" sweep. Pin a floor on what it must still be finding.
    expect(res.filesScanned).toBeGreaterThan(1000);
    expect(res.scanned.length).toBeGreaterThan(15);
    expect(res.scanned.map((s) => s.key)).toContain('coord:inbox-wake');

    expect(formatUnregisteredEventKeys(res.unregistered)).toBe('');
    expect(res.unusedAllow, 'stale ALLOW entries — delete them').toEqual([]);
  }, 30_000);
});
