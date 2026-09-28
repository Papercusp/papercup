import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  MANIFEST_SCHEMA,
  SiteWriteTally,
  gateFingerprint,
  hashSite,
  listSiteFiles,
  main,
  planOnlyPublish,
  planPublish,
  publishTarget,
  readManifest,
  stageFiles,
  writeIfChanged,
  type PublishManifest,
  type PublishPlan,
} from './release-site-delta';
import type { IdentityLiteral } from './release-content-scrub';

// WI-10003694 (absorbs WI-10003625): a one-page change must not re-gate and re-upload ~29k pages,
// and the incremental path must never let an ungated byte reach the host.

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'site-delta-'));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

function site(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(tmp, 'site-'));
  for (const [rel, body] of Object.entries(files)) {
    const full = path.join(dir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, body, 'utf8');
  }
  return dir;
}

const TARGET = publishTarget('bucket', 'secret-prefix');
const FP = 'fingerprint-a';
const BASE_FILES = {
  'index.html': '<h2>0.0.22</h2>',
  'history.json': '{}',
  'plans/p.html': 'plan',
  'work-items/WI-1.html': 'one',
  'work-items/WI-2.html': 'two',
  'changes/0.0.22.html': 'change',
  'assets/project-history.js': 'js',
};

function manifestFor(files: Record<string, string>, over: Partial<PublishManifest> = {}): PublishManifest {
  return {
    schema: MANIFEST_SCHEMA,
    target: TARGET,
    gateFingerprint: FP,
    publishedAt: '2026-09-28T00:00:00.000Z',
    files,
    ...over,
  };
}

describe('writeIfChanged — an unchanged page keeps its bytes AND its mtime', () => {
  it('does not rewrite identical content, so aws s3 sync and the delta both skip it', () => {
    const dir = site({ 'work-items/WI-1.html': 'same' });
    const file = path.join(dir, 'work-items/WI-1.html');
    const old = new Date('2020-01-01T00:00:00Z');
    fs.utimesSync(file, old, old);
    expect(writeIfChanged(file, 'same')).toBe('unchanged');
    expect(fs.statSync(file).mtime.getTime()).toBe(old.getTime());
  });

  it('writes changed content (same length included) and new files', () => {
    const dir = site({ 'a.html': 'aaaa' });
    expect(writeIfChanged(path.join(dir, 'a.html'), 'bbbb')).toBe('written');
    expect(fs.readFileSync(path.join(dir, 'a.html'), 'utf8')).toBe('bbbb');
    expect(writeIfChanged(path.join(dir, 'b.html'), 'new')).toBe('written');
  });

  it('SiteWriteTally counts what a regenerate actually changed', () => {
    const dir = site({ 'a.html': 'x' });
    const tally = new SiteWriteTally();
    tally.write(path.join(dir, 'a.html'), 'x');
    tally.write(path.join(dir, 'b.html'), 'y');
    expect({ written: tally.written, unchanged: tally.unchanged }).toEqual({ written: 1, unchanged: 1 });
  });
});

describe('hashSite / listSiteFiles — exactly what the publisher uploads', () => {
  it('covers index.html, history.json and the four published directories, and nothing else', () => {
    const dir = site({ ...BASE_FILES, 'stray.txt': 'not published', 'target/x.html': 'not published' });
    expect(listSiteFiles(dir)).toEqual(Object.keys(BASE_FILES).sort());
    const hashes = hashSite(dir);
    expect(Object.keys(hashes).sort()).toEqual(Object.keys(BASE_FILES).sort());
    expect(hashes['index.html']).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('planPublish — the safety argument', () => {
  const current = hashSite(site(BASE_FILES));

  it('falls back to FULL when there is no manifest (live state unknown)', () => {
    const plan = planPublish({ current, previous: null, target: TARGET, gateFingerprint: FP });
    expect(plan.mode).toBe('full');
    expect(plan.upload).toEqual(Object.keys(current).sort());
    expect(plan.gate).toEqual(plan.upload);
  });

  it('falls back to FULL for a different bucket/prefix, and on an explicit full request', () => {
    const other = manifestFor(current, { target: publishTarget('bucket', 'other-prefix') });
    expect(planPublish({ current, previous: other, target: TARGET, gateFingerprint: FP }).mode).toBe('full');
    const same = manifestFor(current);
    expect(planPublish({ current, previous: same, target: TARGET, gateFingerprint: FP, full: true }).mode).toBe('full');
  });

  it('uploads and gates ONLY the changed page when nothing else moved', () => {
    const changed = { ...current, 'index.html': 'new-hash' };
    const plan = planPublish({ current: changed, previous: manifestFor(current), target: TARGET, gateFingerprint: FP });
    expect(plan.mode).toBe('incremental');
    expect(plan.upload).toEqual(['index.html']);
    expect(plan.gate).toEqual(['index.html']);
    expect(plan.remove).toEqual([]);
    expect(plan.unchangedCount).toBe(Object.keys(current).length - 1);
    expect(plan.next?.files).toEqual(changed);
  });

  it('an unchanged site uploads nothing', () => {
    const plan = planPublish({ current, previous: manifestFor(current), target: TARGET, gateFingerprint: FP });
    expect(plan.upload).toEqual([]);
    expect(plan.gate).toEqual([]);
  });

  it('re-gates EVERY file when the identity rules changed, while still uploading only the delta', () => {
    const changed = { ...current, 'plans/p.html': 'new-hash' };
    const plan = planPublish({
      current: changed,
      previous: manifestFor(current, { gateFingerprint: 'old-rules' }),
      target: TARGET,
      gateFingerprint: FP,
    });
    expect(plan.upload).toEqual(['plans/p.html']);
    expect(plan.gate).toEqual(Object.keys(changed).sort());
  });

  it('removes vanished pages only from mirrored directories (plans/, work-items/)', () => {
    const previous = manifestFor({ ...current, 'work-items/WI-9.html': 'gone', 'changes/old.html': 'gone', 'assets/old.js': 'gone' });
    const plan = planPublish({ current, previous, target: TARGET, gateFingerprint: FP });
    expect(plan.remove).toEqual(['work-items/WI-9.html']);
  });
});

describe('planOnlyPublish — the caller-judged force never vouches for files it did not look at', () => {
  const only = { 'index.html': 'h1' };

  it('uploads and gates exactly the named files', () => {
    const plan = planOnlyPublish({ only, previous: null, target: TARGET, gateFingerprint: FP, reason: 'instructions only' });
    expect(plan.mode).toBe('only');
    expect(plan.upload).toEqual(['index.html']);
    expect(plan.gate).toEqual(['index.html']);
  });

  it('records nothing without a trustworthy prior manifest (no manifest, other target, other rules)', () => {
    for (const previous of [null, manifestFor({}, { target: 'x' }), manifestFor({}, { gateFingerprint: 'x' })]) {
      expect(planOnlyPublish({ only, previous, target: TARGET, gateFingerprint: FP, reason: 'r' }).next).toBeNull();
    }
  });

  it('advances a trustworthy manifest for just the named files', () => {
    const previous = manifestFor({ 'index.html': 'h0', 'plans/p.html': 'p0' });
    const plan = planOnlyPublish({ only, previous, target: TARGET, gateFingerprint: FP, reason: 'r' });
    expect(plan.next?.files).toEqual({ 'index.html': 'h1', 'plans/p.html': 'p0' });
  });
});

describe('gateFingerprint / readManifest', () => {
  const lits: IdentityLiteral[] = [
    { kind: 'user', value: 'jdoe' },
    { kind: 'git-name', value: 'Jane' },
  ];

  it('is order-independent over literals and changes when a literal or a rule source changes', () => {
    const base = gateFingerprint(lits, ['rules-v1']);
    expect(gateFingerprint([...lits].reverse(), ['rules-v1'])).toBe(base);
    expect(gateFingerprint([...lits, { kind: 'git-email', value: 'j@example.test' }], ['rules-v1'])).not.toBe(base);
    expect(gateFingerprint(lits, ['rules-v2'])).not.toBe(base);
  });

  it('treats absent, unreadable and foreign manifests as unknown (full publish), never as empty', () => {
    expect(readManifest(path.join(tmp, 'absent.json')).manifest).toBeNull();
    const bad = path.join(tmp, 'bad.json');
    fs.writeFileSync(bad, '{not json');
    expect(readManifest(bad).problem).toMatch(/unreadable/);
    const foreign = path.join(tmp, 'foreign.json');
    fs.writeFileSync(foreign, JSON.stringify({ schema: 'other', files: {} }));
    expect(readManifest(foreign).manifest).toBeNull();
  });
});

describe('stageFiles', () => {
  it('stages exactly the listed files at their relative paths', () => {
    const dir = site(BASE_FILES);
    const stage = path.join(tmp, `stage-${Date.now()}`);
    stageFiles(dir, stage, ['index.html', 'work-items/WI-2.html']);
    expect(listSiteFiles(stage)).toEqual(['index.html', 'work-items/WI-2.html']);
    expect(fs.readFileSync(path.join(stage, 'work-items/WI-2.html'), 'utf8')).toBe('two');
  });
});

describe('CLI plan → commit round trip', () => {
  const lits: IdentityLiteral[] = [{ kind: 'git-name', value: 'Jane' }];
  const env = { PAPERCUSP_PUBLISH_KEY_PREFIX: 'secret-prefix' } as NodeJS.ProcessEnv;
  let errors: ReturnType<typeof vi.spyOn>;
  let logs: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    logs = vi.spyOn(console, 'log').mockImplementation(() => {});
  });
  afterEach(() => {
    errors.mockRestore();
    logs.mockRestore();
  });

  async function plan(dir: string, manifest: string, extra: string[] = []): Promise<PublishPlan> {
    const out = path.join(tmp, `plan-${Math.random().toString(36).slice(2)}.json`);
    const code = await main(
      ['plan', dir, '--manifest', manifest, '--bucket', 'bucket', '--out', out,
        '--gate-list', `${out}.gate`, '--remove-list', `${out}.remove`, '--stage', `${out}.stage`, ...extra],
      env,
      lits,
    );
    expect(code).toBe(0);
    const parsed = JSON.parse(fs.readFileSync(out, 'utf8')) as PublishPlan;
    await expect(main(['commit', '--plan', out, '--manifest', manifest], env, lits)).resolves.toBe(0);
    return parsed;
  }

  it('first publish is full; after a one-page edit the next is incremental with that page alone', async () => {
    const dir = site(BASE_FILES);
    const manifest = path.join(tmp, `manifest-${Date.now()}.json`);
    expect((await plan(dir, manifest)).mode).toBe('full');
    fs.writeFileSync(path.join(dir, 'index.html'), '<h2>0.0.22</h2><p>new instructions</p>');
    const second = await plan(dir, manifest);
    expect(second.mode).toBe('incremental');
    expect(second.upload).toEqual(['index.html']);
    expect((await plan(dir, manifest)).upload).toEqual([]);
  });

  it('refuses an --only force without a reason, and a path outside the published set', async () => {
    const dir = site(BASE_FILES);
    const out = path.join(tmp, 'refuse.json');
    const common = ['plan', dir, '--manifest', path.join(tmp, 'm.json'), '--bucket', 'b', '--out', out,
      '--gate-list', `${out}.g`, '--remove-list', `${out}.r`];
    await expect(main([...common, '--only', 'index.html'], env, lits)).resolves.toBe(2);
    await expect(main([...common, '--only', '../etc/passwd', '--reason', 'long enough reason'], env, lits)).resolves.toBe(2);
  });

  it('refuses to plan without the secret prefix in the environment (never argv)', async () => {
    const dir = site(BASE_FILES);
    const out = path.join(tmp, 'noprefix.json');
    await expect(
      main(['plan', dir, '--manifest', path.join(tmp, 'm2.json'), '--bucket', 'b', '--out', out,
        '--gate-list', `${out}.g`, '--remove-list', `${out}.r`], {} as NodeJS.ProcessEnv, lits),
    ).resolves.toBe(2);
  });
});
