import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const runGcloud = async (args) => (await exec('gcloud', args, {
  encoding: 'utf8', maxBuffer: 4 * 1024 * 1024, timeout: 1800_000,
})).stdout;

export function gcsPublicationTarget(bucket, digest) {
  // A bucket subdomain preserves the existing origin-only URL derivation and
  // bundleUrl + '.minisig' companion rule, without bearer query strings.
  if (!/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(bucket)) throw new Error('GCS bucket must be a DNS-safe bucket name without dots');
  if (!/^[a-f0-9]{64}$/.test(digest)) throw new Error('GCS publication requires the exact bundle digest');
  return { bucket, digest, origin: `https://${bucket}.storage.googleapis.com`,
    prefix: `artifacts/workspace-host/sha256/${digest}/` };
}

export async function verifyGcsPublicBytes(url, expected, fetchImpl = fetch) {
  const response = await fetchImpl(url, { signal: AbortSignal.timeout(900_000) });
  if (!response.ok || !response.body) throw new Error(`GCS public verification failed: HTTP ${response.status}`);
  const hash = createHash('sha256');
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.byteLength;
    if (size > expected.sizeBytes) throw new Error('GCS public object exceeds admitted size');
    hash.update(chunk);
  }
  const digest = hash.digest('hex');
  if (size !== expected.sizeBytes || digest !== expected.sha256) throw new Error('GCS public bytes differ from the admitted artifact');
  return { sha256: digest, sizeBytes: size };
}

export async function publishGcsObjects({ target, objects, expiresAt, ctx, runMutation,
  planOnly = false, fetchImpl = fetch, gcloud = runGcloud, log = console.log }) {
  if (!objects.length || objects.some(o => !/^[a-z0-9.-]+$/.test(o.name) || !/^[a-f0-9]{64}$/.test(o.sha256) ||
      !Number.isSafeInteger(o.sizeBytes) || o.sizeBytes <= 0)) throw new Error('invalid GCS object plan');
  const bucketUri = `gs://${target.bucket}`;
  const condition = {
    title: `workspace-host-${target.digest.slice(0, 20)}`,
    expression: `resource.name.startsWith("projects/_/buckets/${target.bucket}/objects/${target.prefix}") && request.time < timestamp("${expiresAt}")`,
  };
  // This read also proves which account can access the existing bucket. Preview
  // never modifies IAM or objects and requires no GitHub/R2 credential.
  await gcloud(['storage', 'buckets', 'describe', bucketUri, '--format=json']);
  if (planOnly) return { planOnly: true, provider: 'gcs', target, objects, condition };
  if (!ctx || !runMutation) throw new Error('GCS writes require the original release journal');
  const inspectObject = async (object) => {
    let metadata;
    try {
      metadata = JSON.parse(await gcloud(['storage', 'objects', 'describe',
        `${bucketUri}/${target.prefix}${object.name}`, '--raw', '--format=json']));
    } catch (error) {
      // Authentication/transport failures are UNKNOWN, never permission to
      // upload again. Only the provider's explicit missing-object reply is absent.
      if (/not found: 404\./.test(String(error.stderr ?? error.message))) return { state: 'absent' };
      throw error;
    }
    if (Number(metadata.size) !== object.sizeBytes || metadata.metadata?.sha256 !== object.sha256) {
      throw new Error(`GCS object conflicts with the admitted bytes: ${object.name}`);
    }
    return { state: 'committed', value: { generation: String(metadata.generation), sha256: object.sha256 },
      evidenceRefs: [`gcs:${target.bucket}/${target.prefix}${object.name}#${metadata.generation}`] };
  };
  const inspectGrant = async () => {
    const policy = JSON.parse(await gcloud(['storage', 'buckets', 'get-iam-policy', bucketUri, '--format=json']));
    const present = policy.bindings?.some(b => b.role === 'roles/storage.objectViewer' &&
      b.members?.includes('allUsers') && b.condition?.title === condition.title &&
      b.condition?.expression === condition.expression);
    return present ? { state: 'committed', value: condition, evidenceRefs: [`gcs:iam:${condition.title}`] } : { state: 'absent' };
  };
  await runMutation(ctx, {
    stage: 'publish.gcs.access', input: { bucket: target.bucket, condition }, reconcile: inspectGrant,
    mutate: async () => {
      await gcloud(['storage', 'buckets', 'add-iam-policy-binding', bucketUri,
        '--member=allUsers', '--role=roles/storage.objectViewer',
        `--condition=expression=${condition.expression},title=${condition.title}`, '--format=json', '--quiet']);
      const result = await inspectGrant();
      if (result.state !== 'committed') throw new Error('GCS scoped publication grant did not persist');
      return result;
    },
  });
  for (const object of objects) {
    log(`GCS publish ${object.name} (${object.sizeBytes} bytes)`);
    const uri = `${bucketUri}/${target.prefix}${object.name}`;
    await runMutation(ctx, {
      stage: `publish.gcs.object.${object.name}`,
      input: { uri, sha256: object.sha256, sizeBytes: object.sizeBytes },
      reconcile: () => inspectObject(object),
      mutate: async () => {
        const prior = await inspectObject(object);
        if (prior.state === 'committed') return prior;
        await gcloud(['storage', 'cp', object.path, uri, '--if-generation-match=0',
          `--custom-metadata=sha256=${object.sha256}`, `--content-type=${object.contentType}`,
          '--cache-control=public,max-age=31536000,immutable', '--quiet']);
        const result = await inspectObject(object);
        if (result.state !== 'committed') throw new Error(`GCS upload did not persist: ${object.name}`);
        return result;
      },
    });
  }
  // A committed upload receipt never substitutes for reading the anonymously
  // served bytes. Run this on every resume; it catches IAM, truncation and
  // metadata/content disagreement before a VM receives a download URL.
  const verified = [];
  for (const object of objects) {
    const url = `${target.origin}/${target.prefix}${object.name}`;
    verified.push({ name: object.name, url, ...await verifyGcsPublicBytes(url, object, fetchImpl) });
  }
  await runMutation(ctx, { stage: 'publish.gcs.verify',
    input: { bucket: target.bucket, objects: verified },
    mutate: async () => ({ value: verified, evidenceRefs: verified.map(o => `public:sha256:${o.sha256}:${o.sizeBytes}`) }),
    reconcile: async () => ({ state: 'committed', value: verified }),
  });
  const publicUrl = `${target.origin}/${target.prefix}server.tgz`;
  log(`PUBLIC_URL=${publicUrl}`);
  return { provider: 'gcs', publicUrl, manifestUrl: `${target.origin}/${target.prefix}manifest.json`, verified, expiresAt };
}
