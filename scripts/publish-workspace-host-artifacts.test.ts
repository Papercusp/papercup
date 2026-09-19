import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { test } from 'vitest';
import { DEFAULT_WORKSPACE_HOST_BOOTSTRAP_ENTRYPOINTS } from '@papercusp/deployment-driver';

import type {
  TaskReleaseJournal,
  TaskReleaseReceipt,
  TaskReleaseReceiptInput,
} from '@papercusp/operator-core/lib/task-manager/store';

// @ts-expect-error Runtime script is intentionally executable ESM and has no declaration artifact.
import * as publisher from './publish-workspace-host-artifacts.mjs';

const {
  publishWorkspaceHostArtifacts,
  releaseStageInputHash,
  releaseStageRequestIdentity,
  request,
  runJournaledMutation,
  parseArgs,
  hashAndPlan,
} = publisher;

const execFileAsync = promisify(execFile);
const PUBLISHER_SCRIPT = new URL('./publish-workspace-host-artifacts.mjs', import.meta.url);

const SOURCE_SHA = 'a'.repeat(40);
const VERSION = '0.0.19-20260908.0450';
const OPERATION_ID = 'release-operation-20260908';
const TASK_ID = 'releasetask01';

test('the CLI help path is side-effect-free and does not require --dir or credentials', async () => {
  assert.deepEqual(parseArgs(['--help'], {}), {
    base: 'https://cupboard.papercusp.com',
    planOnly: false,
    concurrency: 4,
    help: true,
  });

  const result = await execFileAsync(process.execPath, [PUBLISHER_SCRIPT.pathname, '--help'], {
    encoding: 'utf8',
  });
  assert.match(result.stdout, /Usage:.*publish-workspace-host-artifacts/s);
  assert.doesNotMatch(result.stdout, /PUBLISH_VERDICT=/);
  assert.doesNotMatch(result.stderr, /gh auth token|credential/i);
});

for (const loader of [[], ['--import', 'tsx']]) {
  test(`the real CLI rejects an incomplete signed-bundle candidate with loader ${loader.join(' ') || 'native Node'}`, async () => {
    const missing = DEFAULT_WORKSPACE_HOST_BOOTSTRAP_ENTRYPOINTS.install;
    const fixture = await publicationFixture({ omitEntry: missing });
    try {
      await assert.rejects(execFileAsync(process.execPath, [
        ...loader, PUBLISHER_SCRIPT.pathname,
        '--dir', fixture.dir, '--plan-only', '--base', 'http://127.0.0.1:1',
      ], { encoding: 'utf8' }), (error: Error & { stderr?: string }) => {
        assert.match(error.stderr ?? '', /bundle cannot bootstrap/);
        assert.ok(error.stderr?.includes(missing));
        assert.doesNotMatch(error.stderr ?? '', /gh auth token|ECONNREFUSED|does not provide an export|Cannot find module/);
        return true;
      });
    } finally {
      await rm(fixture.dir, { recursive: true, force: true });
    }
  });
}

function sha256(value: string | Buffer) {
  return createHash('sha256').update(value).digest('hex');
}

interface ArtifactDescriptor {
  sha256: string;
  sizeBytes: number;
}

interface MultipartReceipt {
  sha256: string;
  bytes: number;
  etag: string;
}

interface MultipartUpload {
  sizeBytes: number;
  parts: Array<Record<string, unknown>>;
  receipts: Map<number, MultipartReceipt>;
}

function createLedger(overrides: Partial<TaskReleaseJournal> = {}) {
  const release: TaskReleaseJournal = {
    schemaVersion: 1,
    operationId: OPERATION_ID,
    source: { sha: SOURCE_SHA, gitlinks: { 'papercusp-desktop': 'b'.repeat(40) } },
    artifactIdentity: { sourceSha: SOURCE_SHA, version: VERSION },
    credential: { generation: null, expiresAt: null },
    cursor: 0,
    currentStage: null,
    currentState: null,
    spentOperationIds: [],
    receipts: [],
    ...overrides,
  };
  const task = { taskId: TASK_ID, detail: { release } };

  function parse(detail: { release?: TaskReleaseJournal } | null | undefined): TaskReleaseJournal | null {
    const value = detail?.release;
    if (
      !value ||
      value.schemaVersion !== 1 ||
      !Array.isArray(value.receipts) ||
      value.receipts.length !== value.cursor
    ) return null;
    return value;
  }

  return {
    task,
    async getTask(taskId: string) {
      return taskId === TASK_ID ? task : null;
    },
    taskReleaseJournalFromDetail: parse,
    async appendTaskReleaseReceipt(
      taskId: string,
      expectedCursor: number,
      input: TaskReleaseReceiptInput,
    ) {
      if (taskId !== TASK_ID) return { ok: false, reason: 'task_not_found', journal: null };
      const journal = parse(task.detail);
      if (!journal) return { ok: false, reason: 'journal_missing', journal: null };
      if (journal.operationId !== input.operationId) {
        return { ok: false, reason: 'operation_identity_mismatch', journal };
      }
      if (journal.cursor !== expectedCursor) return { ok: false, reason: 'cursor_mismatch', journal };
      const matching = journal.receipts.filter((entry) => entry.requestIdentity === input.requestIdentity);
      if (matching.some((entry) => entry.stage !== input.stage || entry.inputHash !== input.inputHash)) {
        return { ok: false, reason: 'request_identity_conflict', journal };
      }
      const prior = matching.at(-1);
      const valid = input.state === 'intent'
        ? matching.length === 0
        : input.state === 'unknown'
          ? prior?.state === 'intent'
          : prior?.state === 'intent' || prior?.state === 'unknown';
      if (!valid) return { ok: false, reason: 'invalid_transition', journal };
      const receipt: TaskReleaseReceipt = {
        sequence: journal.cursor,
        operationId: input.operationId,
        requestIdentity: input.requestIdentity,
        stage: input.stage,
        state: input.state,
        inputHash: input.inputHash,
        evidenceRefs: [...(input.evidenceRefs ?? [])],
        credentialGeneration: input.credentialGeneration ?? null,
        credentialExpiresAt: input.credentialExpiresAt ?? null,
        recordedAt: input.recordedAt ?? new Date(0).toISOString(),
      };
      journal.receipts.push(receipt);
      journal.cursor += 1;
      journal.currentStage = receipt.stage;
      journal.currentState = receipt.state;
      if (receipt.state === 'intent') journal.spentOperationIds.push(receipt.requestIdentity);
      return { ok: true, journal, receipt };
    },
  };
}

async function publicationFixture(options: {
  omitEntry?: string;
  nonExecutableEntry?: string;
  symlinkEntry?: string;
  duplicateEntry?: string;
  invalidArchive?: boolean;
  largePayload?: boolean;
} = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'publisher-journal-'));
  const payload = join(dir, 'payload');
  await mkdir(join(payload, 'bin'), { recursive: true });
  await Promise.all(Object.values(DEFAULT_WORKSPACE_HOST_BOOTSTRAP_ENTRYPOINTS).map(async (path) => {
    if (path === options.omitEntry) return;
    if (path === options.symlinkEntry) {
      await symlink('missing-runtime', join(payload, path));
      return;
    }
    await writeFile(join(payload, path), '#!/bin/sh\nexit 0\n', {
      mode: path === options.nonExecutableEntry ? 0o644 : 0o755,
    });
  }));
  if (options.largePayload) {
    // Incompressible bytes cross the publisher's real 32 MiB part boundary.
    await writeFile(join(payload, 'runtime.bin'), randomBytes(33 * 1024 * 1024));
  }
  const bundlePath = join(dir, 'server.tgz');
  await execFileAsync('tar', [
    '-czf', bundlePath, '-C', payload, '.',
    ...(options.duplicateEntry ? [`./${options.duplicateEntry}`] : []),
  ]);
  if (options.invalidArchive) await writeFile(bundlePath, 'not a gzip archive');
  const bundle = await readFile(bundlePath);
  const signature = Buffer.from('trusted minisign signature');
  const bundleSha256 = sha256(bundle);
  const manifest = {
    schemaVersion: 1,
    kind: 'papercusp-workspace-host-release',
    artifact: {
      image: { version: VERSION },
      buildManifest: { source: { revision: SOURCE_SHA } },
      release: { version: VERSION, bundleSha256 },
    },
    files: {
      bundle: { name: 'server.tgz', sha256: bundleSha256, sizeBytes: bundle.byteLength },
      signature: {
        name: 'server.tgz.minisig',
        sha256: sha256(signature),
        sizeBytes: signature.byteLength,
      },
    },
  };
  await Promise.all([
    writeFile(join(dir, 'server.tgz'), bundle),
    writeFile(join(dir, 'server.tgz.minisig'), signature),
    writeFile(join(dir, 'manifest.json'), JSON.stringify(manifest)),
  ]);
  return { dir, bundle, bundleSha256, signature, manifest };
}

test('archive verification preserves whole-file and multipart digests across compressed part boundaries', async () => {
  const fixture = await publicationFixture({ largePayload: true });
  try {
    const plan = await hashAndPlan(join(fixture.dir, 'server.tgz'));
    assert.equal(plan.sha256, fixture.bundleSha256);
    assert.equal(plan.size, fixture.bundle.length);
    assert.equal(plan.parts.length, 2);
    let offset = 0;
    for (const part of plan.parts) {
      assert.equal(part.sha256, sha256(fixture.bundle.subarray(offset, offset + part.sizeBytes)));
      offset += part.sizeBytes;
    }
    assert.equal(offset, fixture.bundle.length);
  } finally {
    await rm(fixture.dir, { recursive: true, force: true });
  }
});

// WI-10001865: digest/signature agreement alone let an incomplete r32 bundle
// publish successfully and then fail at phase:install-runtime on a real VM.
// Exercise the real publication boundary with valid manifests over bad archives.
for (const entrypoint of Object.values(DEFAULT_WORKSPACE_HOST_BOOTSTRAP_ENTRYPOINTS)) {
  for (const defect of ['omitEntry', 'nonExecutableEntry'] as const) {
    test(`publication refuses ${defect} ${entrypoint} before any provider request`, async () => {
      const fixture = await publicationFixture({ [defect]: entrypoint });
      const ledger = createLedger();
      let requests = 0;
      try {
        await assert.rejects(publishWorkspaceHostArtifacts({
          dir: fixture.dir, base: 'https://cupboard.example.test', token: 'fixture-token',
          taskId: TASK_ID, operationId: OPERATION_ID, planOnly: false,
        }, {
          ledger, env: {}, log: () => {},
          fetch: async () => { requests += 1; throw new Error('unexpected provider request'); },
        }), (error: Error) => error.message.includes(entrypoint)
          && error.message.includes('bundle cannot bootstrap'));
        assert.equal(requests, 0);
        assert.equal(ledger.task.detail.release.receipts.length, 0);
      } finally {
        await rm(fixture.dir, { recursive: true, force: true });
      }
    });
  }
}

for (const options of [
  { symlinkEntry: DEFAULT_WORKSPACE_HOST_BOOTSTRAP_ENTRYPOINTS.node },
  { duplicateEntry: DEFAULT_WORKSPACE_HOST_BOOTSTRAP_ENTRYPOINTS.install },
  { invalidArchive: true },
]) {
  test(`publication refuses ambiguous or malformed archive ${JSON.stringify(options)}`, async () => {
    const fixture = await publicationFixture(options);
    let requests = 0;
    try {
      await assert.rejects(publishWorkspaceHostArtifacts({
        dir: fixture.dir, base: 'https://cupboard.example.test', token: 'fixture-token', planOnly: true,
      }, {
        env: {}, log: () => {},
        fetch: async () => { requests += 1; throw new Error('unexpected provider request'); },
      }), /bundle cannot bootstrap|incorrect header check/);
      assert.equal(requests, 0);
    } finally {
      await rm(fixture.dir, { recursive: true, force: true });
    }
  });
}

function json(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function createArtifactProvider({ loseResponses = [] }: { loseResponses?: string[] } = {}) {
  const uploads = new Map<string, MultipartUpload>();
  const direct = new Map<string, ArtifactDescriptor>();
  const losses = new Set(loseResponses);
  const counters = {
    initiate: 0,
    part: 0,
    complete: 0,
    minisig: 0,
    manifest: 0,
    finalize: 0,
  };
  let bundle: ArtifactDescriptor | null = null;
  let finalized = false;
  let corruptPublicHead = false;

  async function respond<T>(stage: string, mutate: () => boolean, response: () => T | Promise<T>): Promise<T> {
    const changed = mutate();
    if (changed && losses.delete(stage)) {
      throw new TypeError(`simulated lost response after ${stage} provider acceptance`);
    }
    return response();
  }

  return {
    counters,
    setCorruptPublicHead(value: boolean) {
      corruptPublicHead = value;
    },
    async fetch(rawUrl: string | URL, init: RequestInit = {}) {
      const url = new URL(rawUrl);
      const method = String(init.method ?? 'GET').toUpperCase();
      const headers = new Headers(init.headers);
      const multipart = url.pathname.endsWith('/server.tgz/multipart');

      if (multipart && method === 'POST') {
        const uploadId = headers.get('x-operation-id')!;
        const sizeBytes = Number(headers.get('x-artifact-size'));
        const parts = JSON.parse(String(init.body)).parts as Array<Record<string, unknown>>;
        if (bundle) return json({ ok: true, deduped: true, sha256: bundle.sha256, bytes: bundle.sizeBytes });
        return respond(
          'publish.multipart.initiate',
          () => {
            if (uploads.has(uploadId)) return false;
            counters.initiate += 1;
            uploads.set(uploadId, { sizeBytes, parts, receipts: new Map() });
            return true;
          },
          () => json({ ok: true, uploadId, operationId: uploadId, partCount: parts.length, deduped: false }),
        );
      }

      if (multipart && method === 'GET') {
        const uploadId = url.searchParams.get('uploadId')!;
        const partNumber = Number(url.searchParams.get('partNumber'));
        if (bundle) return json({ ok: true, uploadId, completed: true, bundle });
        const upload = uploads.get(uploadId);
        if (!upload) return json({ error: 'multipart_upload_not_found' }, 404);
        const receipt = upload.receipts.get(partNumber);
        return receipt
          ? json({ ok: true, uploadId, partNumber, state: 'committed', ...receipt })
          : json({ ok: true, uploadId, partNumber, state: 'absent' });
      }

      const partMatch = url.pathname.match(/\/server\.tgz\/multipart\/parts\/(\d+)$/);
      if (partMatch && method === 'PUT') {
        const partNumber = Number(partMatch[1]);
        const uploadId = url.searchParams.get('uploadId')!;
        const upload = uploads.get(uploadId);
        if (!upload) return json({ error: 'multipart_upload_not_found' }, 404);
        const sha = headers.get('x-part-sha256')!;
        const bytes = Number(headers.get('x-part-size'));
        const etag = `etag-${partNumber}-${sha.slice(0, 8)}`;
        return respond(
          `publish.multipart.part.${partNumber}`,
          () => {
            if (upload.receipts.has(partNumber)) return false;
            counters.part += 1;
            upload.receipts.set(partNumber, { sha256: sha, bytes, etag });
            return true;
          },
          () => json({ ok: true, uploadId, partNumber, sha256: sha, bytes, etag }),
        );
      }

      if (url.pathname.endsWith('/server.tgz/multipart/complete') && method === 'POST') {
        const uploadId = url.searchParams.get('uploadId')!;
        const upload = uploads.get(uploadId);
        if (bundle) return json({ ok: true, deduped: true, sha256: bundle.sha256, bytes: bundle.sizeBytes });
        if (!upload) return json({ error: 'multipart_upload_not_found' }, 404);
        const sha = url.pathname.split('/sha256/')[1].split('/')[0];
        return respond(
          'publish.multipart.complete',
          () => {
            counters.complete += 1;
            bundle = { sha256: sha, sizeBytes: upload.sizeBytes };
            uploads.delete(uploadId);
            return true;
          },
          () => json({ ok: true, sha256: sha, bytes: upload.sizeBytes, deduped: false }),
        );
      }

      const directMatch = url.pathname.match(/\/sha256\/([a-f0-9]{64})\/(server\.tgz\.minisig|manifest\.json)$/);
      if (directMatch && method === 'PUT') {
        const name = directMatch[2];
        const expected = {
          sha256: headers.get('x-artifact-sha256')!,
          sizeBytes: Number(headers.get('x-artifact-size')),
        };
        const prior = direct.get(name);
        if (prior) {
          return prior.sha256 === expected.sha256 && prior.sizeBytes === expected.sizeBytes
            ? json({ ok: true, file: name, sha256: prior.sha256, bytes: prior.sizeBytes, deduped: true })
            : json({ error: 'artifact_conflict' }, 409);
        }
        const stage = `publish.direct.${name}`;
        return respond(
          stage,
          () => {
            counters[name === 'manifest.json' ? 'manifest' : 'minisig'] += 1;
            direct.set(name, expected);
            return true;
          },
          () => json({ ok: true, file: name, sha256: expected.sha256, bytes: expected.sizeBytes, deduped: false }, 201),
        );
      }

      if (url.pathname.endsWith('/finalize') && method === 'POST') {
        const manifest = direct.get('manifest.json');
        if (finalized) return json({ ok: true, manifestSha256: manifest!.sha256, deduped: true });
        if (!bundle || direct.size !== 2) return json({ error: 'uploads_incomplete' }, 409);
        return respond(
          'publish.finalize',
          () => {
            counters.finalize += 1;
            finalized = true;
            return true;
          },
          () => json({ ok: true, manifestSha256: manifest!.sha256, deduped: false }, 201),
        );
      }

      const publicMatch = url.pathname.match(/\/artifacts\/workspace-host\/sha256\/[a-f0-9]{64}\/(server\.tgz|server\.tgz\.minisig|manifest\.json)$/);
      if (publicMatch && method === 'HEAD') {
        if (!finalized) return new Response(null, { status: 404 });
        const name = publicMatch[1];
        const descriptor = (name === 'server.tgz' ? bundle : direct.get(name))!;
        return new Response(null, {
          status: 200,
          headers: {
            'x-artifact-sha256': descriptor.sha256,
            'content-length': String(
              name === 'server.tgz' && corruptPublicHead
                ? descriptor.sizeBytes + 1
                : descriptor.sizeBytes,
            ),
          },
        });
      }

      throw new Error(`unhandled fake request ${method} ${url}`);
    },
  };
}

test('rejected fetch renders stage, redacted URL, and nested Error.cause fields', async () => {
  const originalFetch = globalThis.fetch;
  const cause = Object.assign(
    new Error('connect ECONNREFUSED token=inner-secret'),
    {
      code: 'ECONNREFUSED',
      errno: -111,
      syscall: 'connect',
      address: '127.0.0.1',
      port: 8788,
    },
  );
  const rejection = new TypeError('fetch failed', { cause });

  try {
    globalThis.fetch = async () => {
      throw rejection;
    };

    await assert.rejects(
      request(
        'https://user:password@example.test/admin/artifacts?uploadId=capability-secret&safe=yes',
        { headers: { authorization: 'Bearer header-secret' } },
        1,
        'initiate multipart',
      ),
      (error) => {
        assert.ok(error instanceof Error);
        assert.equal(error.cause, rejection);
        assert.match(error.message, /^initiate multipart request failed URL=/);
        assert.match(error.message, /example\.test/);
        assert.match(error.message, /"cause":\{"name":"Error"/);
        assert.match(error.message, /ECONNREFUSED/);
        assert.match(error.message, /127\.0\.0\.1/);
        assert.doesNotMatch(
          error.message,
          /password|capability-secret|inner-secret|header-secret/,
        );
        return true;
      },
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('request refuses blind mutation retries before fetch', async () => {
  let calls = 0;
  await assert.rejects(
    request(
      'https://example.test/mutate',
      { method: 'POST' },
      2,
      'provider mutation',
      async () => {
        calls += 1;
        return json({ ok: true });
      },
    ),
    /refused a blind POST retry/,
  );
  assert.equal(calls, 0);
});

test('stage input hashes and request UUIDs are canonical, stable, and attempt-distinct', () => {
  const left = releaseStageInputHash({ b: [2, 3], a: 1 });
  const right = releaseStageInputHash({ a: 1, b: [2, 3] });
  assert.equal(left, right);
  const first = releaseStageRequestIdentity(OPERATION_ID, 'publish.stage', left, 0);
  assert.match(first, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.equal(first, releaseStageRequestIdentity(OPERATION_ID, 'publish.stage', right, 0));
  assert.notEqual(first, releaseStageRequestIdentity(OPERATION_ID, 'publish.stage', right, 1));
});

test('missing or malformed task journal fails before any provider mutation', async () => {
  const ledger = createLedger({ receipts: [], cursor: 1 });
  let mutations = 0;
  await assert.rejects(
    runJournaledMutation(
      {
        taskId: TASK_ID,
        operationId: OPERATION_ID,
        credentialGeneration: 'generation-1',
        credentialExpiresAt: null,
        ledger,
        now: () => new Date(0),
      },
      {
        stage: 'publish.stage',
        input: { immutable: true },
        mutate: async () => {
          mutations += 1;
          return { value: {} };
        },
        reconcile: async () => ({ state: 'absent' }),
      },
    ),
    /no complete task_ledger\.detail\.release journal/,
  );
  assert.equal(mutations, 0);
});

test('expired credential fails at the action boundary before a provider mutation', async () => {
  const ledger = createLedger();
  let mutations = 0;
  await assert.rejects(
    runJournaledMutation(
      {
        taskId: TASK_ID,
        operationId: OPERATION_ID,
        credentialGeneration: 'generation-expired',
        credentialExpiresAt: '2026-09-08T03:00:00.000Z',
        ledger,
        now: () => new Date('2026-09-08T04:00:00.000Z'),
      },
      {
        stage: 'publish.stage',
        input: { immutable: true },
        mutate: async () => {
          mutations += 1;
          return { value: {} };
        },
        reconcile: async () => ({ state: 'absent' }),
      },
    ),
    /release credential generation-expired expired/,
  );
  assert.equal(mutations, 0);
});

test('lost accepted responses plus a restart after every stage produce zero duplicate provider mutations', async () => {
  const fixture = await publicationFixture();
  const ledger = createLedger();
  const stages = [
    'publish.multipart.initiate',
    'publish.multipart.part.1',
    'publish.multipart.complete',
    'publish.direct.server.tgz.minisig',
    'publish.direct.manifest.json',
    'publish.finalize',
  ];
  const provider = createArtifactProvider({ loseResponses: stages });
  const interrupted = new Set();
  const args = {
    dir: fixture.dir,
    base: 'https://cupboard.example.test',
    token: 'fixture-token',
    taskId: TASK_ID,
    operationId: OPERATION_ID,
    planOnly: false,
    concurrency: 4,
  };
  const injected = {
    ledger,
    fetch: provider.fetch,
    env: {},
    sleep: async () => {},
    log: () => {},
    afterStage(stage: string) {
      if (!interrupted.has(stage)) {
        interrupted.add(stage);
        throw new Error(`simulated process stop after ${stage}`);
      }
    },
  };

  try {
    let result = null;
    for (let restart = 0; restart < stages.length + 2 && !result; restart += 1) {
      try {
        result = await publishWorkspaceHostArtifacts(args, injected);
      } catch (error) {
        if (!(error instanceof Error) || !/simulated process stop after/.test(error.message)) throw error;
      }
    }
    assert.ok(result, 'publisher did not settle after the bounded restart matrix');
    assert.deepEqual([...interrupted].sort(), [...stages].sort());
    assert.deepEqual(provider.counters, {
      initiate: 1,
      part: 1,
      complete: 1,
      minisig: 1,
      manifest: 1,
      finalize: 1,
    });

    const journal = ledger.task.detail.release;
    assert.equal(journal.currentStage, 'publish.finalize');
    assert.equal(journal.currentState, 'committed');
    assert.equal(new Set(journal.spentOperationIds).size, stages.length);
    for (const stage of stages) {
      const states = journal.receipts
        .filter((receipt) => receipt.stage === stage)
        .map((receipt) => receipt.state);
      assert.deepEqual(states, ['intent', 'unknown', 'committed'], stage);
    }

    let providerCalls = 0;
    await assert.rejects(
      runJournaledMutation(
        {
          taskId: TASK_ID,
          operationId: OPERATION_ID,
          credentialGeneration: 'generation-1',
          credentialExpiresAt: null,
          ledger,
          now: () => new Date(0),
        },
        {
          stage: 'publish.direct.manifest.json',
          input: { changed: true },
          mutate: async () => {
            providerCalls += 1;
            return { value: {} };
          },
          reconcile: async () => ({ state: 'absent' }),
        },
      ),
      /input changed within operation/,
    );
    assert.equal(providerCalls, 0);

    provider.setCorruptPublicHead(true);
    await assert.rejects(
      publishWorkspaceHostArtifacts(args, { ...injected, afterStage: undefined }),
      /public object is .* expected/,
    );
    assert.deepEqual(provider.counters, {
      initiate: 1,
      part: 1,
      complete: 1,
      minisig: 1,
      manifest: 1,
      finalize: 1,
    });
  } finally {
    await rm(fixture.dir, { recursive: true, force: true });
  }
});
