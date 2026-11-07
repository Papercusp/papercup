import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { defaultBlobBatchReader, type BlobBatchReader } from './committed-tree-reader';
import { scanRepository } from '../../../../../scripts/check-fire-and-forget-classification.mjs';
import {
  __resetTreeInstrumentMemoForTest,
  emittedSubscribeSelectors,
  foldTreeInstrumentFingerprint,
  measureTreeInstrumentAtCommit,
} from './tree-instruments';

let root: string;
const git = (...args: string[]) => execFileSync('git', ['-C', root, '-c', 'user.name=Tree test',
  '-c', 'user.email=tree-test@example.invalid', '-c', 'commit.gpgsign=false', ...args], { encoding: 'utf8' }).trim();

async function put(files: Record<string, string>): Promise<string> {
  for (const [path, body] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), body);
  }
  git('add', '-A');
  git('commit', '-qm', 'step', '--allow-empty');
  return git('rev-parse', 'HEAD');
}

beforeEach(async () => {
  __resetTreeInstrumentMemoForTest();
  root = await realpath(await mkdtemp(join(tmpdir(), 'tree-instrument-')));
  git('init', '-q');
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('provider-specific-census tree instrument', () => {
  it('reports the census of the committed tree, not of the working tree', async () => {
    const commit = await put({
      'packages/operator-core/lib/integrations/provider-options.ts': 'export {};\n',
      'packages/operator-core/lib/integrations/discord-bridge.ts': 'export {};\n',
      'packages/operator-core/lib/chat/thread-poster.ts': "await fetch('https://slack.com/api/chat.postMessage');\n",
      'packages/operator-core/lib/chat/thread-poster.test.ts': "fetch('https://slack.com/api/chat.postMessage');\n",
      'packages/operator-core/node_modules/slack/index.js': 'export {};\n',
      'libs/papercusp/plugins/slack/provider.mjs': "fetch('https://slack.com/api/chat.postMessage');\n",
    });
    // Uncommitted planted module: not in the committed tree, so not in the census.
    await writeFile(join(root, 'packages/operator-core/lib/integrations/asana-sync.ts'), 'export {};\n');
    expect(await measureTreeInstrumentAtCommit('provider-specific-census', root, commit)).toEqual({
      providerSpecificPaths: ['packages/operator-core/lib/integrations/discord-bridge.ts'],
      strictViolations: ['packages/operator-core/lib/chat/thread-poster.ts: slack'],
    });
  });

  it('stays current across an unrelated commit and goes stale when a provider module is planted', async () => {
    const base = await put({
      'packages/operator-core/lib/integrations/provider-options.ts': 'export const a = 1;\n',
      'apps/operator/app/page.tsx': 'export {};\n',
    });
    const before = await measureTreeInstrumentAtCommit('provider-specific-census', root, base);
    const unrelated = await put({
      'packages/operator-core/lib/integrations/provider-options.ts': 'export const a = 2;\n',
      'packages/operator-core/lib/integrations/new-helper.ts': 'export const helper = 1;\n',
      'docs/notes.md': 'slack discord\n',
    });
    const afterUnrelated = await measureTreeInstrumentAtCommit('provider-specific-census', root, unrelated);
    expect(afterUnrelated).toEqual(before);
    const fp = (output: unknown) => foldTreeInstrumentFingerprint('sha256-file-set-v1:x', 'provider-specific-census', output);
    expect(fp(afterUnrelated)).toBe(fp(before));

    const planted = await put({ 'apps/operator/app/settings/TelegramCard.tsx': 'export {};\n' });
    const afterPlant = await measureTreeInstrumentAtCommit('provider-specific-census', root, planted);
    expect(afterPlant).toEqual({ providerSpecificPaths: ['apps/operator/app/settings/TelegramCard.tsx'], strictViolations: [] });
    expect(fp(afterPlant)).not.toBe(fp(before));
  });

  it('goes stale when a neutral path starts speaking a strict protocol, and honours allowances', async () => {
    const base = await put({
      'packages/operator-core/lib/intake/message-classifier.ts': 'export const classify = () => null;\n',
      'packages/operator-core/lib/data-governance/pilot-processing-map.ts': "export const t = ['harness_shared.chat_bug_suggestions'];\n",
    });
    expect(await measureTreeInstrumentAtCommit('provider-specific-census', root, base))
      .toEqual({ providerSpecificPaths: [], strictViolations: [] });
    const changed = await put({
      'packages/operator-core/lib/intake/message-classifier.ts': "if (payload.callback_id === 'report_bug') file();\n",
      'packages/operator-core/lib/data-governance/pilot-processing-map.ts':
        "export const t = ['harness_shared.chat_bug_suggestions'];\nexport const r = ':bug:';\n",
    });
    expect(await measureTreeInstrumentAtCommit('provider-specific-census', root, changed)).toEqual({
      providerSpecificPaths: [],
      strictViolations: [
        'packages/operator-core/lib/data-governance/pilot-processing-map.ts: bug-workflow',
        'packages/operator-core/lib/intake/message-classifier.ts: bug-workflow',
      ],
    });
  });

  it('re-reads only the blobs a new commit changed', async () => {
    const read: string[] = [];
    const counting: BlobBatchReader = async (dir, blobs) => { read.push(...blobs); return defaultBlobBatchReader(dir, blobs); };
    const first = await put({
      'packages/operator-core/lib/a.ts': 'export const a = 1;\n',
      'packages/operator-core/lib/b.ts': 'export const b = 1;\n',
      'bin/c.mjs': 'export const c = 1;\n',
    });
    await measureTreeInstrumentAtCommit('provider-specific-census', root, first, { readBlobs: counting });
    expect(read).toHaveLength(3);
    read.length = 0;
    const second = await put({ 'packages/operator-core/lib/b.ts': 'export const b = 2;\n' });
    await measureTreeInstrumentAtCommit('provider-specific-census', root, second, { readBlobs: counting });
    expect(read).toEqual([git('rev-parse', `${second}:packages/operator-core/lib/b.ts`)]);
    read.length = 0;
    await measureTreeInstrumentAtCommit('provider-specific-census', root, second, { readBlobs: counting });
    expect(read).toEqual([]);
  });

  it('refuses a submodule the walk would descend into instead of silently dropping it', async () => {
    await put({ 'packages/operator-core/lib/a.ts': 'export {};\n' });
    const head = git('rev-parse', 'HEAD');
    git('update-index', '--add', '--cacheinfo', `160000,${head},packages/operator-core/lib/vendored`);
    git('commit', '-qm', 'gitlink');
    await expect(measureTreeInstrumentAtCommit('provider-specific-census', root, git('rev-parse', 'HEAD')))
      .rejects.toThrow('tree_instrument_nested_submodule_unsupported:packages/operator-core/lib/vendored');
  });

  it('lists nothing for an app root absent at the commit (the walk skips a missing root too)', async () => {
    const commit = await put({ 'bin/tool.mjs': 'export {};\n' });
    expect(await measureTreeInstrumentAtCommit('provider-specific-census', root, commit))
      .toEqual({ providerSpecificPaths: [], strictViolations: [] });
  });
});

describe('state-subscribe-handle-census tree instrument', () => {
  const key = 'state-subscribe-handle-census' as const;
  const prefix = 'packages/operator-core/lib/agent-tools/';
  const emitter = prefix + 'dev/pipeline_position.ts';
  const handle = "tool: 'state:subscribe', selector: \"{ cell: 'gate.greenCheckpoint.verdict' }\"";
  const fp = (output: unknown) => foldTreeInstrumentFingerprint('sha256-file-set-v1:x', key, output);

  it('shares the exact selector matcher and records committed bytes in the scanner population', async () => {
    expect(emittedSubscribeSelectors('a.ts', handle + '\n' + "tool: 'other', selector: '{}'")).toEqual([
      { file: 'a.ts', selector: "{ cell: 'gate.greenCheckpoint.verdict' }" },
    ]);
    const commit = await put({
      [emitter]: handle,
      [prefix + 'release/checkpoint-run.ts']: "tool: 'state:subscribe', selector: '{ cell: \"other\" }'",
      [prefix + 'ignored.test.ts']: handle,
      [prefix + 'ignored.js']: handle,
      'apps/operator/lib/outside.ts': handle,
    });
    await writeFile(join(root, emitter), "tool: 'state:subscribe', selector: '{}'");
    await writeFile(join(root, prefix + 'untracked.ts'), handle);
    expect(await measureTreeInstrumentAtCommit(key, root, commit)).toEqual({
      schemaVersion: 1,
      handles: [
        { file: 'dev/pipeline_position.ts', selector: "{ cell: 'gate.greenCheckpoint.verdict' }" },
        { file: 'release/checkpoint-run.ts', selector: '{ cell: "other" }' },
      ],
    });
  });

  it('retains unrelated edits but changes the witness for new, changed and removed selectors', async () => {
    const base = await put({ [emitter]: handle });
    const before = await measureTreeInstrumentAtCommit(key, root, base);
    const unrelated = await put({ [emitter]: '// moved\n' + handle, [prefix + 'unrelated.ts']: 'export {};' });
    expect(fp(await measureTreeInstrumentAtCommit(key, root, unrelated))).toBe(fp(before));
    const changed = await put({ [emitter]: handle.replace('gate.greenCheckpoint.verdict', 'different') });
    const afterChange = await measureTreeInstrumentAtCommit(key, root, changed);
    expect(fp(afterChange)).not.toBe(fp(before));
    const planted = await put({ [prefix + 'new/emitter.ts']: handle });
    const afterPlant = await measureTreeInstrumentAtCommit(key, root, planted);
    expect(fp(afterPlant)).not.toBe(fp(afterChange));
    const removed = await put({ [prefix + 'new/emitter.ts']: 'export {};' });
    expect(fp(await measureTreeInstrumentAtCommit(key, root, removed))).toBe(fp(afterChange));
  });

  it('measures the full population beyond the ordinary glob bound and retains invalid literals', async () => {
    const commit = await put(Object.fromEntries(Array.from({ length: 150 }, (_, i) => [
      prefix + 'emit-' + String(i).padStart(3, '0') + '.ts',
      "tool: 'state:subscribe', selector: '{ invalid'",
    ])));
    const output = await measureTreeInstrumentAtCommit(key, root, commit) as { handles: Array<{ selector: string }> };
    expect(output.handles).toHaveLength(150);
    expect(output.handles.every(site => site.selector === '{ invalid')).toBe(true);
  });

  it('refuses a symlink or gitlink reached by the real recursive scanner', async () => {
    await put({ [emitter]: handle });
    await symlink('dev/pipeline_position.ts', join(root, prefix + 'linked.ts'));
    git('add', '-A');
    git('commit', '-qm', 'symlink');
    await expect(measureTreeInstrumentAtCommit(key, root, git('rev-parse', 'HEAD')))
      .rejects.toThrow('tree_instrument_symlink_unsupported:' + prefix + 'linked.ts');
    await rm(join(root, prefix + 'linked.ts'));
    git('add', '-A');
    git('update-index', '--add', '--cacheinfo', '160000,' + git('rev-parse', 'HEAD') + ',' + prefix + 'vendored');
    git('commit', '-qm', 'gitlink');
    await expect(measureTreeInstrumentAtCommit(key, root, git('rev-parse', 'HEAD')))
      .rejects.toThrow('tree_instrument_nested_submodule_unsupported:' + prefix + 'vendored');
  });
});

describe('plan-content-writer-census tree instrument', () => {
  const key = 'plan-content-writer-census' as const;
  const writer = 'packages/operator-core/lib/neutral-writer.ts';
  const insert = 'await tx`INSERT INTO harness_shared.harness_plans (content, content_hash) VALUES (body, hash)`;';
  const good = `${insert}\nawait recordPlanRevisionInTransaction(tx, args);`;
  const fp = (output: unknown) => foldTreeInstrumentFingerprint('sha256-file-set-v1:x', key, output);

  it('detects a newly planted writer and a missing recorder/hash in an existing writer', async () => {
    const base = await put({ [writer]: good });
    const before = await measureTreeInstrumentAtCommit(key, root, base);
    expect(before).toMatchObject({ writers: [{ file: writer, recorded: true, missingHashes: [] }] });
    const unrelated = await put({ 'apps/operator/lib/unrelated.ts': 'export const n = 1;' });
    expect(fp(await measureTreeInstrumentAtCommit(key, root, unrelated))).toBe(fp(before));
    const planted = await put({ 'apps/operator/lib/new-writer.ts': insert });
    const afterPlant = await measureTreeInstrumentAtCommit(key, root, planted);
    expect(afterPlant).toMatchObject({ writers: [
      { file: 'apps/operator/lib/new-writer.ts', recorded: false, missingHashes: [] },
      { file: writer, recorded: true, missingHashes: [] },
    ] });
    expect(fp(afterPlant)).not.toBe(fp(before));
    const broken = await put({ [writer]: good.replace('content, content_hash', 'content') });
    expect(await measureTreeInstrumentAtCommit(key, root, broken)).toMatchObject({ writers: [
      { file: 'apps/operator/lib/new-writer.ts', recorded: false },
      { file: writer, recorded: true, missingHashes: [expect.stringContaining('(content)')] },
    ] });
    const noRecorder = await put({ [writer]: insert });
    expect(await measureTreeInstrumentAtCommit(key, root, noRecorder)).toMatchObject({ writers: [
      { file: 'apps/operator/lib/new-writer.ts', recorded: false },
      { file: writer, recorded: false },
    ] });
  });

  it('uses committed bytes, ignores comments and matches the maintained scanner scope', async () => {
    const base = await put({
      [writer]: good,
      'apps/operator/lib/comment.ts': `// ${insert}\nexport {};`,
      'apps/operator/lib/writer.test.ts': insert,
      'apps/operator/lib/writer.spec.ts': insert,
      'apps/operator/lib/writer.d.ts': insert,
      'apps/operator/lib/__tests__/writer.ts': insert,
      'apps/operator/lib/.hidden/writer.ts': insert,
      'apps/operator/lib/node_modules/writer.ts': insert,
      'apps/operator/app/outside.ts': insert,
    });
    await writeFile(join(root, writer), insert);
    await writeFile(join(root, 'apps/operator/lib/untracked.ts'), insert);
    expect(await measureTreeInstrumentAtCommit(key, root, base)).toMatchObject({
      writers: [{ file: writer, recorded: true, missingHashes: [] }],
    });
  });

  it('preserves the full writer population beyond the ordinary glob limit', async () => {
    const files = Object.fromEntries(Array.from({ length: 150 }, (_, i) => [
      `packages/operator-core/lib/writer-${i}.ts`, good,
    ]));
    const base = await put(files);
    const output = await measureTreeInstrumentAtCommit(key, root, base) as { writers: unknown[] };
    expect(output.writers).toHaveLength(150);
  });

  it('measures exemption validity and notices when its writer disappears or becomes canonical', async () => {
    const exempt = 'packages/operator-core/lib/search/lexical/test-pg/bm25-test-db.ts';
    const privateWriter = `await sql\`CREATE DATABASE isolated\`;\nawait sql\`CREATE TABLE harness_shared.harness_plans (content text)\`;\n${insert}`;
    const base = await put({ [exempt]: privateWriter });
    expect(await measureTreeInstrumentAtCommit(key, root, base)).toMatchObject({
      writers: [{ file: exempt, exemption: { valid: true } }], missingExemptions: [],
    });
    const canonical = await put({ [exempt]: `${privateWriter}\ngetOrgPg();` });
    expect(await measureTreeInstrumentAtCommit(key, root, canonical)).toMatchObject({
      writers: [{ file: exempt, exemption: { valid: false } }],
    });
    const removed = await put({ [exempt]: 'export {};' });
    expect(await measureTreeInstrumentAtCommit(key, root, removed)).toMatchObject({
      writers: [], missingExemptions: [exempt],
    });
  });
});

describe('embedded-terminal-host-census tree instrument', () => {
  const key = 'embedded-terminal-host-census' as const;

  it('discovers committed runtime imports and excludes type imports, comments and test fixtures', async () => {
    const commit = await put({
      'apps/operator/app/dev/Terminal.tsx': "const { Terminal } = await import('@xterm/xterm');",
      'apps/operator/lib/host.ts': "import { Terminal } from '@xterm/xterm';",
      'packages/operator-ui/src/types.ts': "import type { Terminal } from '@xterm/xterm';",
      'packages/operator-ui/src/named-types.ts': "import { type Terminal } from '@xterm/xterm';",
      'apps/operator/app/example.tsx': "// import { Terminal } from '@xterm/xterm';",
      'apps/operator/app/host.test.tsx': "import { Terminal } from '@xterm/xterm';",
      'apps/operator/app/e2e/host.ts': "import { Terminal } from '@xterm/xterm';",
    });
    await writeFile(join(root, 'apps/operator/app/untracked.tsx'), "import { Terminal } from '@xterm/xterm';");
    expect(await measureTreeInstrumentAtCommit(key, root, commit)).toEqual({ schemaVersion: 1, hosts: [
      { path: 'apps/operator/app/dev/Terminal.tsx', sha256: expect.stringMatching(/^[a-f0-9]{64}$/) },
      { path: 'apps/operator/lib/host.ts', sha256: expect.stringMatching(/^[a-f0-9]{64}$/) },
    ] });
  });

  it('ignores unrelated edits and changes for extra, removed or modified hosts', async () => {
    const before = await put({ 'apps/operator/app/host.tsx': "import '@xterm/xterm';" });
    const base = await measureTreeInstrumentAtCommit(key, root, before);
    const unrelated = await put({ 'apps/operator/app/other.tsx': 'export const value = 1;' });
    expect(await measureTreeInstrumentAtCommit(key, root, unrelated)).toEqual(base);
    const added = await put({ 'apps/operator/lib/new-host.ts': "await import('@xterm/xterm');" });
    expect(await measureTreeInstrumentAtCommit(key, root, added)).not.toEqual(base);
    const removed = await put({ 'apps/operator/lib/new-host.ts': 'export {};', 'apps/operator/app/host.tsx': 'export {};' });
    expect(await measureTreeInstrumentAtCommit(key, root, removed)).toEqual({ schemaVersion: 1, hosts: [] });
    const modified = await put({ 'apps/operator/app/host.tsx': "import '@xterm/xterm'; export const changed = true;" });
    expect(await measureTreeInstrumentAtCommit(key, root, modified)).not.toEqual(base);
  });

  it('covers source populations larger than the ordinary glob cap', async () => {
    const files = Object.fromEntries(Array.from({ length: 150 }, (_, i) => [
      `apps/operator/app/ordinary-${i}.tsx`, 'export {};',
    ]));
    const commit = await put({ ...files, 'apps/operator/app/host.tsx': "import '@xterm/xterm';" });
    expect(await measureTreeInstrumentAtCommit(key, root, commit)).toMatchObject({
      hosts: [{ path: 'apps/operator/app/host.tsx' }],
    });
  });
});

describe('notification-classification-census tree instrument', () => {
  const key = 'notification-classification-census' as const;

  it('matches the tracked detector inputs at the pin and ignores uncommitted source', async () => {
    const commit = await put({
      'src/quoted "通知".ts': 'void notifyOwner();',
      'src/app.test.ts': 'void notifyHidden();',
      'dist/generated.ts': 'void notifyHidden();',
      'package.json': '{"name":"fixture"}',
    });
    const expected = scanRepository(root);
    await writeFile(join(root, 'src/quoted "通知".ts'), 'export const quiet = true;');
    await writeFile(join(root, 'src/untracked.ts'), 'void notifyNew();');
    expect(await measureTreeInstrumentAtCommit(key, root, commit)).toMatchObject({
      files: expected.files.length, sites: expected.sites.length,
      sourceDigest: expected.sourceDigest, gaps: [], submodules: [],
    });
  });

  it('ignores excluded edits but changes for new tracked calls and resolution-only edits', async () => {
    const base = await put({ 'src/app.ts': 'export const ready = true;', 'tsconfig.json': '{}' });
    const before = await measureTreeInstrumentAtCommit(key, root, base);
    const docs = await put({ 'docs/note.md': 'void notifyOwner();' });
    expect(await measureTreeInstrumentAtCommit(key, root, docs)).toEqual(before);
    const call = await put({ 'src/app.ts': 'void notifyOwner();' });
    const withCall = await measureTreeInstrumentAtCommit(key, root, call);
    expect(withCall).not.toEqual(before);
    expect(withCall).toMatchObject({ sites: 1 });
    const resolution = await put({ 'tsconfig.json': '{"compilerOptions":{"paths":{"@/*":["./src/*"]}}}' });
    expect(await measureTreeInstrumentAtCommit(key, root, resolution)).not.toEqual(withCall);
  });

  it('descends actual submodules at the parent pin and refuses an unavailable pinned repository', async () => {
    const bus = await realpath(await mkdtemp(join(tmpdir(), 'notify-tree-submodule-')));
    const busGit = (...args: string[]) => execFileSync('git', ['-C', bus, '-c', 'user.name=Tree test',
      '-c', 'user.email=tree-test@example.invalid', '-c', 'commit.gpgsign=false', ...args], { encoding: 'utf8' }).trim();
    try {
      busGit('init', '-q');
      await mkdir(join(bus, 'src'));
      await writeFile(join(bus, 'src/index.ts'), 'export const relay = notifyOwner;');
      await writeFile(join(bus, 'package.json'), '{"name":"@fixture/bus","exports":"./src/index.ts"}');
      busGit('add', '-A'); busGit('commit', '-qm', 'bus');
      git('-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', bus, 'libs/bus');
      const base = await put({ 'src/app.ts': 'import {relay} from "@fixture/bus"; void relay();' });
      const expected = scanRepository(root);
      const pinned = await measureTreeInstrumentAtCommit(key, root, base);
      expect(pinned).toMatchObject({ sites: 1, sourceDigest: expected.sourceDigest, submodules: ['libs/bus'], gaps: [] });

      await writeFile(join(root, 'libs/bus/src/index.ts'), 'export const relay = () => null;');
      git('-C', join(root, 'libs/bus'), 'add', '-A');
      git('-C', join(root, 'libs/bus'), 'commit', '-qm', 'new bus head');
      __resetTreeInstrumentMemoForTest();
      expect(await measureTreeInstrumentAtCommit(key, root, base)).toEqual(pinned);
      const movedPin = await put({});
      expect(await measureTreeInstrumentAtCommit(key, root, movedPin)).toMatchObject({ sites: 0, submodules: ['libs/bus'] });

      await rm(join(root, 'libs/bus'), { recursive: true, force: true });
      await mkdir(join(root, 'libs/bus'));
      __resetTreeInstrumentMemoForTest();
      await expect(measureTreeInstrumentAtCommit(key, root, base)).rejects.toThrow('tree_instrument_submodule_unavailable:libs/bus');
    } finally {
      await rm(bus, { recursive: true, force: true });
    }
  });

  it('reports a declared submodule without a committed gitlink as a population gap', async () => {
    const commit = await put({
      'src/app.ts': 'void notifyOwner();',
      '.gitmodules': '[submodule "bus"]\npath = libs/bus\nurl = https://example.invalid/bus.git\n',
    });
    expect(await measureTreeInstrumentAtCommit(key, root, commit)).toMatchObject({
      declaredSubmodules: ['libs/bus'], submodules: [],
      gaps: [{ path: 'libs/bus', kind: 'declared-submodule-without-gitlink' }],
    });
  });

  it('refuses a reachable symlink or an empty committed population', async () => {
    const empty = await put({ 'docs/note.md': 'No product source.' });
    await expect(measureTreeInstrumentAtCommit(key, root, empty)).rejects.toThrow('tree_instrument_empty_notification_population');
    await symlink('../docs/note.md', join(root, 'linked.ts'));
    const linked = await put({});
    await expect(measureTreeInstrumentAtCommit(key, root, linked)).rejects.toThrow('tree_instrument_symlink_unsupported:linked.ts');
  });
});
