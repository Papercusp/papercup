/**
 * Resume byte verification of an existing independent dependency copy.
 * The release helper supplies its maintained tree census and exclusions. Its
 * incremental copier cannot be used here: it removes the existing destination.
 * Journal records are derived, private cache entries, never prepared receipts.
 */
import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { constants, createReadStream, closeSync, fsyncSync, lstatSync, mkdirSync,
  mkdtempSync, openSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { open } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { createInterface } from 'node:readline';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { withFsMutex, withFsMutexRead } from './fs-mutex.mjs';
import { installLockNameForRoot } from './install-lock-name.mjs';

const run = promisify(execFile);
const digest = value => createHash('sha256').update(value).digest('hex');
const schemaVersion = 'committed-dependency-resume-v1';
const verifierFingerprint = digest(readFileSync(fileURLToPath(import.meta.url)));
const within = (root, path) => path === root || path.startsWith(root + sep);
const fail = message => { throw new Error('retained dependency verification: ' + message); };
class Incomplete extends Error {}

function privateDirectory(path, roots) {
  if (typeof path !== 'string' || !isAbsolute(path)) fail('checkpointDir must be absolute');
  path = resolve(path);
  if (roots.some(root => within(root, path))) fail('checkpointDir must be outside both trees');
  const parents = [];
  for (let parent = path; parent !== dirname(parent); parent = dirname(parent)) parents.push(parent);
  for (const parent of parents.reverse()) {
    const stat = lstatSync(parent, { throwIfNoEntry: false });
    if (stat && (!stat.isDirectory() || stat.isSymbolicLink())) fail('unsafe checkpoint parent');
  }
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const stat = lstatSync(path);
  if (stat.uid !== process.getuid() || (stat.mode & 0o077) !== 0) fail('checkpointDir must be owned and private');
  return realpathSync(path);
}

function privateFile(path) {
  const stat = lstatSync(path, { throwIfNoEntry: false });
  if (!stat) return false;
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 ||
      stat.uid !== process.getuid() || (stat.mode & 0o077) !== 0 || stat.size > 1024 * 1024)
    fail('unsafe journal file: ' + path);
  return true;
}

function readJournal(path) {
  if (!privateFile(path)) return null;
  let entry;
  try { entry = JSON.parse(readFileSync(path, 'utf8')); } catch { fail('malformed journal'); }
  if (!entry || !entry.data || typeof entry.data !== 'object' || Array.isArray(entry.data) ||
      entry.sha256 !== digest(JSON.stringify(entry.data)) ||
      entry.data?.schemaVersion !== schemaVersion) fail('journal integrity mismatch');
  return entry.data;
}

function writeJournal(path, data) {
  privateFile(path);
  const temporary = path + '.' + randomUUID() + '.tmp';
  let fd;
  try {
    fd = openSync(temporary, 'wx', 0o600);
    writeFileSync(fd, JSON.stringify({ data, sha256: digest(JSON.stringify(data)) }) + '\n');
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    renameSync(temporary, path);
  } finally {
    if (fd !== undefined) closeSync(fd);
    rmSync(temporary, { force: true });
  }
}

function directoryIdentity(path) {
  const stat = lstatSync(path, { bigint: true });
  if (!stat.isDirectory() || stat.isSymbolicLink()) fail('dependency root must be physical: ' + path);
  return { dev: String(stat.dev), ino: String(stat.ino) };
}

function safeRelative(path) {
  if (!path || isAbsolute(path) || /[\x00-\x1f\x7f]/.test(path) ||
      path.split('/').some(part => !part || part === '.' || part === '..')) fail('unsafe census path');
  return path;
}

async function command(helper, args, script, deadline) {
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw new Incomplete();
  try {
    // GNU timeout owns and terminates the census process group, including find
    // and sort; a timed-out shell must not leave an unbounded orphan scanner.
    const result = await run('timeout', ['--signal=TERM', '--kill-after=1s',
      String(remaining / 1000) + 's', 'bash', '-c',
      'set -euo pipefail\nsource "$1"\n' + script, 'retained-census', helper, ...args],
    { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 });
    return result.stdout;
  } catch (error) {
    if (error.code === 124 || error.code === 137) throw new Incomplete();
    fail('census failed: ' + String(error.stderr || error.message).slice(0, 1500));
  }
}

async function selectGeneration(helper, donor, destination, deadline) {
  const text = await command(helper, [donor, destination, String(process.pid)], [
    'generation_root="$(dependency_generation_resolve_root "$2" "" 1)"',
    'dependency_generation_select_inputs "$3" "$generation_root"',
    'dependency_generation_acquire_selector_lease "$generation_root" "$DEPENDENCY_GENERATION_ID" "$4" "$DEPENDENCY_GENERATION_TOKEN"',
    'trap dependency_generation_release_selector_lease ERR',
    'printf "%s\\n" "$generation_root" "$DEPENDENCY_GENERATION_TREE" "$DEPENDENCY_GENERATION_SELECTOR_LEASE" "$DEPENDENCY_GENERATION_ID" "$DEPENDENCY_GENERATION_TOKEN"',
    'trap - ERR',
  ].join('\n'), deadline);
  const [root, tree, lease, identity, token, ...extra] = text.trimEnd().split('\n');
  if (extra.length || !isAbsolute(root || '') || !isAbsolute(tree || '') ||
      !isAbsolute(lease || '') || !within(join(root, '.leases'), lease) ||
      tree !== join(root, identity, 'tree') || !/^v1-[a-f0-9]{64}$/.test(identity) || !token)
    fail('invalid generation selection');
  return { root, tree, lease, identity, token };
}

async function census(helper, donor, destination, scratch, deadline, generation) {
  const sourceInputCommands = generation ? [
    // The generation contains dependency trees, not package/lock files. Reuse
    // the publisher's exact-input selector and revalidate its immutable token.
    'dependency_generation_select_inputs "$3" "$4"',
    '[ "$DEPENDENCY_GENERATION_ID" = "$5" ] && [ "$DEPENDENCY_GENERATION_TOKEN" = "$6" ] && [ "$DEPENDENCY_GENERATION_TREE" = "$2" ]',
    'printf "%s\\n" "$DEPENDENCY_GENERATION_INPUT_FINGERPRINT"',
  ] : ['dependency_generation_input_fingerprint "$2"'];
  const text = await command(helper, [donor, destination,
    ...(generation ? [generation.root, generation.identity, generation.token] : [])], [
    ...sourceInputCommands,
    'dependency_generation_input_fingerprint "$3"',
    'printf "%s\\n" "$DEPENDENCY_GENERATION_RACY_WINDOW_SEC"',
    'dependency_generation_configure_workspace_dirs "$2"',
    'dependency_generation_enumerate_node_modules "$2"',
    'printf "%s\\n" "---destination---"',
    'dependency_generation_configure_workspace_dirs "$3"',
    'dependency_generation_enumerate_node_modules "$3"',
  ].join('\n'), deadline);
  const [sourceInputs, destinationInputs, racySeconds, ...lines] = text.trimEnd().split('\n');
  if (!/^[a-f0-9]{64}$/.test(sourceInputs) || sourceInputs !== destinationInputs)
    fail('dependency inputs differ');
  const racyWindowMs = Number(racySeconds) * 1000;
  if (!Number.isFinite(racyWindowMs) || racyWindowMs < 0) fail('invalid racy window');
  const split = lines.indexOf('---destination---');
  if (split < 0) fail('incomplete tree census');
  const sourcePaths = lines.slice(0, split).map(path => safeRelative(relative(donor, path)))
    .filter(path => lstatSync(dirname(join(destination, path)), { throwIfNoEntry: false })?.isDirectory());
  const destinationPaths = lines.slice(split + 1).map(path => safeRelative(relative(destination, path)));
  sourcePaths.sort();
  destinationPaths.sort();
  if (JSON.stringify(sourcePaths) !== JSON.stringify(destinationPaths)) fail('dependency tree census differs');
  const trees = [];
  for (const [index, path] of sourcePaths.entries()) {
    const source = join(donor, path), target = join(destination, path);
    const sourceIdentity = directoryIdentity(source), destinationIdentity = directoryIdentity(target);
    const sourceRecords = join(scratch, String(index) + '.source');
    const destinationRecords = join(scratch, String(index) + '.destination');
    await command(helper, [source, sourceRecords, target, destinationRecords], [
      'dependency_generation_source_records "$2" "$3"',
      'dependency_generation_source_records "$4" "$5"',
    ].join('\n'), deadline);
    trees.push({ path, sourceIdentity, destinationIdentity, sourceRecords, destinationRecords });
  }
  return { sourceInputs, racyWindowMs, trees };
}

async function* records(file, deadline) {
  const signal = AbortSignal.timeout(Math.max(1, deadline - Date.now()));
  const stream = createReadStream(file, { signal });
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const raw of lines) {
      const parts = raw.split('\t');
      if (parts.length !== 10 || !['f', 'd', 'l'].includes(parts[1])) fail('invalid census record');
      safeRelative(parts[0]);
      // This is the existing materializer's rename of the helper's excluded
      // root .package-lock.json, not an additional dependency exclusion.
      if (parts[0] === '.papercusp-installed-package-lock.json') continue;
      yield { raw, path: parts[0], type: parts[1], mode: parts[2], uid: parts[3],
        gid: parts[4], size: parts[5], mtime: parts[6], ino: parts[7], ctime: parts[8], link: parts[9] };
    }
  } catch (error) {
    if (signal.aborted) throw new Incomplete();
    throw error;
  } finally { lines.close(); stream.destroy(); }
}

function projected(record, root, tree) {
  let link = '';
  if (record.type === 'l') {
    const target = resolve(dirname(join(root, tree.path, record.path)), record.link);
    if (!within(root, target)) fail('symlink escapes its snapshot: ' + record.path);
    link = relative(root, target);
  }
  return JSON.stringify([record.path, record.type, Number.parseInt(record.mode, 8) & 0o111,
    record.type === 'f' ? record.size : '', link]);
}

async function* pairs(scan, donor, destination, deadline) {
  for (const tree of scan.trees) {
    const source = records(tree.sourceRecords, deadline)[Symbol.asyncIterator]();
    const target = records(tree.destinationRecords, deadline)[Symbol.asyncIterator]();
    try {
      while (true) {
        const [left, right] = await Promise.all([source.next(), target.next()]);
        if (left.done && right.done) break;
        if (left.done || right.done || projected(left.value, donor, tree) !== projected(right.value, destination, tree))
          fail('dependency census differs: ' + tree.path + '/' + (left.value?.path || right.value?.path));
        yield { tree, source: left.value, target: right.value,
          path: tree.path + '/' + left.value.path };
      }
    } finally { await source.return?.(); await target.return?.(); }
  }
}

async function inspect(scan, donor, destination, deadline) {
  const semantic = createHash('sha256'), sourceRaw = createHash('sha256'), targetRaw = createHash('sha256');
  const donorInodes = new Set(), targetInodes = new Set(), sourceGroups = new Map(), targetGroups = new Map();
  let entries = 0;
  for await (const pair of pairs(scan, donor, destination, deadline)) {
    if (Date.now() >= deadline) throw new Incomplete();
    entries++;
    semantic.update(pair.tree.path + '\0' + projected(pair.source, donor, pair.tree) + '\n');
    sourceRaw.update(pair.path + '\0' + pair.source.raw + '\n');
    targetRaw.update(pair.path + '\0' + pair.target.raw + '\n');
    if (pair.source.type !== 'f') continue;
    const sourceId = pair.tree.sourceIdentity.dev + ':' + pair.source.ino;
    const targetId = pair.tree.destinationIdentity.dev + ':' + pair.target.ino;
    donorInodes.add(sourceId);
    targetInodes.add(targetId);
    if ((sourceGroups.has(sourceId) && sourceGroups.get(sourceId) !== targetId) ||
        (targetGroups.has(targetId) && targetGroups.get(targetId) !== sourceId))
      fail('dependency hardlink topology differs: ' + pair.path);
    sourceGroups.set(sourceId, targetId);
    targetGroups.set(targetId, sourceId);
  }
  for (const inode of targetInodes) if (donorInodes.has(inode)) fail('dependency copy shares a donor inode');
  return { semantic: semantic.digest('hex'), sourceRaw: sourceRaw.digest('hex'),
    targetRaw: targetRaw.digest('hex'), entries };
}

function nanos(value) {
  if (!/^-?\d+(?:\.\d+)?$/.test(value)) fail('invalid metadata timestamp');
  const negative = value.startsWith('-');
  const [seconds, fraction = ''] = (negative ? value.slice(1) : value).split('.');
  const result = BigInt(seconds) * 1_000_000_000n + BigInt((fraction + '000000000').slice(0, 9));
  return negative ? -result : result;
}

function sameMetadata(stat, record, device) {
  return stat.isFile() && String(stat.dev) === device && String(stat.ino) === record.ino &&
    String(stat.size) === record.size && (stat.mode & 0o7777n) === BigInt('0o' + record.mode) &&
    String(stat.uid) === record.uid && String(stat.gid) === record.gid &&
    stat.mtimeNs === nanos(record.mtime) && stat.ctimeNs === nanos(record.ctime);
}

async function fileDigest(root, pair, record, device, deadline) {
  if (Date.now() >= deadline) throw new Incomplete();
  const handle = await open(join(root, pair.path), constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    if (!sameMetadata(await handle.stat({ bigint: true }), record, device)) fail('dependency metadata changed: ' + pair.path);
    const hash = createHash('sha256');
    // Own the descriptor until both metadata checks finish. Destroying a
    // FileHandle stream closes its descriptor even with autoClose:false.
    const buffer = Buffer.allocUnsafe(64 * 1024);
    while (true) {
      if (Date.now() >= deadline) throw new Incomplete();
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      hash.update(buffer.subarray(0, bytesRead));
    }
    if (!sameMetadata(await handle.stat({ bigint: true }), record, device)) fail('dependency changed while hashing: ' + pair.path);
    return hash.digest('hex');
  } finally { await handle.close(); }
}

async function verifyBatch(batch, donor, destination, deadline) {
  const files = batch.filter(pair => pair.source.type === 'f');
  const proofs = [];
  for (let offset = 0; offset < files.length; offset += 4) {
    const results = await Promise.allSettled(files.slice(offset, offset + 4).map(async pair => {
      const hashes = await Promise.allSettled([
        fileDigest(donor, pair, pair.source, pair.tree.sourceIdentity.dev, deadline),
        fileDigest(destination, pair, pair.target, pair.tree.destinationIdentity.dev, deadline),
      ]);
      const failed = hashes.find(result => result.status === 'rejected');
      if (failed) throw failed.reason;
      if (hashes[0].value !== hashes[1].value) fail('dependency bytes differ: ' + pair.path);
      return hashes[0].value;
    }));
    const failed = results.find(result => result.status === 'rejected');
    if (failed) throw failed.reason;
    proofs.push(...results.map(result => result.value));
  }
  return proofs;
}

/** Return typed incomplete progress, or complete proof of the existing copy. */
export async function verifyRetainedDependencies(donor, destination, options, context) {
  const { checkpointDir, maxBatches = 64, maxDurationMs = 30_000, batchSize = 256 } = options;
  if (options.generation !== undefined && typeof options.generation !== 'boolean') fail('invalid generation option');
  for (const [name, value, maximum] of [['maxBatches', maxBatches, 1_000_000],
    ['maxDurationMs', maxDurationMs, 3600_000], ['batchSize', batchSize, 4096]])
    if (!Number.isSafeInteger(value) || value < 1 || value > maximum) fail('invalid ' + name);
  donor = realpathSync(donor);
  destination = realpathSync(destination);
  if (within(donor, destination) || within(destination, donor)) fail('dependency roots overlap');
  const checkpoint = privateDirectory(checkpointDir, [donor, destination]);
  const deadline = Date.now() + maxDurationMs;
  const progress = { verifiedEntries: 0, verifiedBatches: 0, reusedBatches: 0, hashedFiles: 0, totalEntries: 0 };
  const incomplete = () => ({ status: 'incomplete', progress: { ...progress } });
  const mutexOptions = { timeoutMs: maxDurationMs };
  let generation;
  try {
    if (options.generation) {
      generation = await selectGeneration(context.materializer, donor, destination, deadline);
      donor = realpathSync(generation.tree);
      if (within(donor, destination) || within(destination, donor)) fail('dependency roots overlap');
      privateDirectory(checkpoint, [donor, destination]);
    }
    return await withFsMutex('committed-dependency-verification-' + digest(checkpoint).slice(0, 24), () =>
    withFsMutexRead(installLockNameForRoot(donor), async () => {
      const scratch = mkdtempSync(join(checkpoint, '.scan-'));
      try {
        context.verifySource();
        const scan = await census(context.materializer, donor, destination, scratch, deadline, generation);
        const population = await inspect(scan, donor, destination, deadline);
        progress.totalEntries = population.entries;
        const rootIdentities = { donorRoot: directoryIdentity(donor), destinationRoot: directoryIdentity(destination) };
        const binding = digest(JSON.stringify({ schemaVersion, sourceCommit: context.sourceCommit,
          verifierFingerprint, materializer: digest(readFileSync(context.materializer)),
          donor, destination, ...rootIdentities,
          generation: generation ? { identity: generation.identity, token: generation.token } : null,
          inputs: scan.sourceInputs, trees: scan.trees.map(({ path, sourceIdentity, destinationIdentity }) =>
            ({ path, sourceIdentity, destinationIdentity })), semantic: population.semantic, batchSize }));
        const manifestPath = join(checkpoint, 'manifest.json');
        const manifest = readJournal(manifestPath);
        if (manifest && manifest.binding !== binding) fail('journal binding changed: source, inputs or census drift');
        if (!manifest) writeJournal(manifestPath, { schemaVersion, binding });
        let batch = [], index = 0, newBatches = 0;
        const finishBatch = async () => {
          const metadata = digest(JSON.stringify(batch.map(pair =>
            [pair.path, pair.source.raw, pair.target.raw])));
          const path = join(checkpoint, 'batch-' + String(index++).padStart(8, '0') + '.json');
          const cached = readJournal(path);
          if (cached && (!Array.isArray(cached.proofs) || cached.proofs.length !== cached.files ||
              !cached.proofs.every(value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value))))
            fail('invalid journal byte proof');
          const trusted = cached?.binding === binding && cached.metadata === metadata &&
            cached.files === batch.filter(pair => pair.source.type === 'f').length &&
            Number.isFinite(cached.capturedAtMs) && cached.capturedAtMs <= Date.now() &&
            batch.every(pair => [pair.source, pair.target].every(record =>
              Number(record.mtime) * 1000 < cached.capturedAtMs - scan.racyWindowMs &&
              Number(record.ctime) * 1000 < cached.capturedAtMs - scan.racyWindowMs));
          if (trusted) progress.reusedBatches++;
          else {
            if (newBatches >= maxBatches || Date.now() >= deadline) throw new Incomplete();
            // Digests follow the batch's regular-file order, bound by metadata.
            const proofs = await verifyBatch(batch, donor, destination, deadline);
            writeJournal(path, { schemaVersion, binding, metadata, capturedAtMs: Date.now(),
              files: proofs.length, proofs });
            newBatches++;
            progress.hashedFiles += proofs.length;
          }
          progress.verifiedEntries += batch.length;
          progress.verifiedBatches++;
          console.error('COMMITTED_DEPENDENCY_VERIFICATION ' + JSON.stringify(progress));
          batch = [];
        };
        for await (const pair of pairs(scan, donor, destination, deadline)) {
          if (Date.now() >= deadline) throw new Incomplete();
          batch.push(pair);
          if (batch.length === batchSize) await finishBatch();
        }
        if (batch.length) await finishBatch();
        const finalDirectory = join(scratch, 'final');
        mkdirSync(finalDirectory, { mode: 0o700 });
        const finalScan = await census(context.materializer, donor, destination, finalDirectory, deadline, generation);
        const finalPopulation = await inspect(finalScan, donor, destination, deadline);
        if (JSON.stringify(rootIdentities) !== JSON.stringify({ donorRoot: directoryIdentity(donor),
              destinationRoot: directoryIdentity(destination) }) || finalScan.sourceInputs !== scan.sourceInputs ||
            JSON.stringify(finalScan.trees.map(({ path, sourceIdentity, destinationIdentity }) =>
              ({ path, sourceIdentity, destinationIdentity }))) !==
            JSON.stringify(scan.trees.map(({ path, sourceIdentity, destinationIdentity }) =>
              ({ path, sourceIdentity, destinationIdentity }))) ||
            JSON.stringify(finalPopulation) !== JSON.stringify(population))
          fail('dependency census changed during verification');
        context.verifySource();
        return { status: 'complete', sourceRoot: donor, paths: scan.trees.map(tree => tree.path), progress };
      } catch (error) {
        if (error instanceof Incomplete) return incomplete();
        throw error;
      } finally { rmSync(scratch, { recursive: true, force: true }); }
    }, mutexOptions), mutexOptions);
  } finally {
    if (generation) await command(context.materializer, [generation.lease],
      'DEPENDENCY_GENERATION_SELECTOR_LEASE="$2"\ndependency_generation_release_selector_lease', Date.now() + 5000);
  }
}
