/** One producer-owned source-only view. Historical receipts never grant live authority. */
import { createHash, randomUUID } from 'node:crypto';
import { lstat, readFile, readlink, realpath, rm } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { z } from 'zod';
import type { RunGitStdin } from '../../sync/pot-git/storage';
import { createScratchClone, type ScratchGitRunner } from '../../scratch-git-clone';
import { parseGitSyncCandidateCapture, readGitSyncCandidate, SOURCE_CUSTODY_REF_PREFIX,
  type GitSyncCandidateCapture, type RunGit } from './run-git-sync';

function freeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

/** Explicit JSON domain: JSON.stringify's lossy/coercive cases are not receipt bytes. */
export function custodySourceCanonicalBytes(value: unknown): string {
  const visiting = new Set<object>();
  const encode = (item: unknown): string => {
    if (item === null || typeof item === 'boolean' || typeof item === 'string') return JSON.stringify(item);
    if (typeof item === 'number' && Number.isFinite(item)) return JSON.stringify(item);
    if (!item || typeof item !== 'object' || visiting.has(item)) throw Error('custody-non-json');
    visiting.add(item);
    try {
      const keys = Reflect.ownKeys(item);
      if (keys.some(key => typeof key !== 'string')) throw Error('custody-non-json-key');
      if (Array.isArray(item)) {
        if (keys.length !== item.length + 1) throw Error('custody-sparse-array');
        const rows: string[] = [];
        for (let i = 0; i < item.length; i++) {
          if (!Object.hasOwn(item, i)) throw Error('custody-sparse-array');
          const descriptor = Object.getOwnPropertyDescriptor(item, String(i))!;
          if (!descriptor.enumerable || !('value' in descriptor)) throw Error('custody-non-json-property');
          rows.push(encode(descriptor.value));
        }
        return '[' + rows.join(',') + ']';
      }
      if (Object.getPrototypeOf(item) !== Object.prototype && Object.getPrototypeOf(item) !== null) throw Error('custody-non-plain');
      return '{' + (keys as string[]).sort().map(key => {
        const descriptor = Object.getOwnPropertyDescriptor(item, key)!;
        if (!descriptor.enumerable || !('value' in descriptor)) throw Error('custody-non-json-property');
        return JSON.stringify(key) + ':' + encode(descriptor.value);
      }).join(',') + '}';
    } finally { visiting.delete(item); }
  };
  return encode(value) + '\n';
}
const digest = (value: unknown) => createHash('sha256').update(custodySourceCanonicalBytes(value)).digest('hex');
const oid = z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/);
const absolute = z.string().min(1).refine(path => isAbsolute(path) && resolve(path) === path && !/[\0\\]/.test(path));
const reference = z.string().min(1).refine(ref => ref.trim() === ref && !/\s/.test(ref) &&
  /^(?:WI-|EI-|plan:|coord-|[a-z0-9][a-z0-9-]*#)/.test(ref));
const iso = z.string().refine(value => Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value);
const candidateSchema = z.unknown().transform((value, ctx): GitSyncCandidateCapture => {
  try { return parseGitSyncCandidateCapture(value); }
  catch { ctx.addIssue({ code: 'custom', message: 'custody-candidate-schema' }); return z.NEVER; }
});
const receiptSchema = z.object({ schemaVersion: z.literal('custody-source-artifact-v1'), authority: z.literal('source-only'),
  capture: z.object({ ref: z.string().regex(new RegExp('^' + SOURCE_CUSTODY_REF_PREFIX + '[a-f0-9]{64}$')),
    candidate: candidateSchema }).strict(),
  artifact: z.object({ root: absolute, commit: oid, parent: oid, tree: oid }).strict(),
  objects: z.object({ selfContained: z.literal(false), donorRepository: absolute,
    cleanupOrder: z.tuple([z.literal('exporter'), z.literal('artifact'), z.literal('donor')]) }).strict(),
  custody: z.object({ ownerId: z.string().min(1), workItemRef: reference, leaseId: z.string().min(1),
    issuedAt: iso, expiresAt: iso, releaseCondition: z.literal('producer-chain-settled') }).strict(),
  qualifications: z.object({ ancestry: z.literal('UNKNOWN'), sourceCensus: z.literal('UNKNOWN'), compiler: z.literal('UNKNOWN'),
    publication: z.literal(false), fullOutput: z.literal(false), runtime: z.literal(false), native: z.literal(false),
    activation: z.literal(false), workerRegistration: z.literal(false), suiteStart: z.literal(false), shipment: z.literal(false) }).strict(),
}).strict();
export type CustodySourceArtifactReceipt = z.infer<typeof receiptSchema>;
export function parseCustodySourceArtifactReceipt(value: unknown): CustodySourceArtifactReceipt {
  custodySourceCanonicalBytes(value);
  const receipt = receiptSchema.parse(value);
  const c = receipt.capture.candidate;
  if (receipt.artifact.parent !== c.base || receipt.artifact.tree !== c.tree ||
      receipt.objects.donorRepository !== c.repository || receipt.artifact.root === c.repository ||
      Date.parse(receipt.custody.issuedAt) >= Date.parse(receipt.custody.expiresAt)) throw Error('custody-receipt-binding');
  return freeze(receipt);
}

const sourcePath = z.string().min(1).refine(path => !isAbsolute(path) && !/[\0\\]/.test(path) &&
  path.split('/').every(part => part !== '' && part !== '.' && part !== '..'));
const sourceMembers = z.record(sourcePath, oid).refine(members => Object.keys(members).length > 0);
const sourcePaths = z.array(sourcePath).min(1).refine(paths => new Set(paths).size === paths.length);
const approvalRef = z.union([reference, z.string().regex(/^thread-post:[1-9]\d*$/)]);
const sha256 = z.string().regex(/^[a-f0-9]{64}$/);
const contentMembers = z.record(sourcePath, sha256).refine(members => Object.keys(members).length > 0);
const captureSchema = z.object({ ref: z.string().regex(new RegExp('^' + SOURCE_CUSTODY_REF_PREFIX + '[a-f0-9]{64}$')),
  candidate: candidateSchema }).strict();
const prospectivePacketSchema = z.object({
  schemaVersion: z.literal('custody-prospective-source-v1'), authority: z.literal('source-only'),
  producerOwnerId: z.string().min(1),
  // Historical expectedBlobMap values are content SHA256, never Git object IDs.
  original: z.object({ capture: captureSchema, members: contentMembers }).strict(),
  subject: z.object({ repository: absolute, captureRef: captureSchema.shape.ref, tree: oid,
    route: z.literal('direct-tsx'), entrypoints: sourcePaths, members: sourceMembers,
    contentSha256: contentMembers }).strict(),
  differences: z.array(z.object({ path: sourcePath, original: sha256, prospective: sha256 }).strict()),
  closure: z.object({ source: sourcePaths, config: sourcePaths, tests: sourcePaths,
    unresolved: z.tuple([]) }).strict(),
  rule: z.object({ ref: approvalRef, sha256 }).strict(),
  // Source admission cannot turn the original UNKNOWNs into runtime qualifications.
  qualifications: receiptSchema.shape.qualifications,
}).strict();
// Both subjects need their own retained acceptance decision. The same independent
// reviewer/post may assess both; this literal checker does not authenticate posts
// or recompute the external rule artifact. Those are upstream acceptance duties.
const sourceApproval = z.object({ ref: approvalRef, reviewerOwnerId: z.string().min(1), subjectSha256: sha256 }).strict();
const prospectiveReceiptSchema = prospectivePacketSchema.extend({ approvals: z.object({
  rule: sourceApproval, packet: sourceApproval }).strict() }).strict();
export type ProspectiveCustodySourceReceipt = z.infer<typeof prospectiveReceiptSchema>;

/** Hash only the separately labelled packet; approval records are not self-hashed. */
export function prospectiveCustodySourcePacketSha256(value: unknown): string {
  custodySourceCanonicalBytes(value);
  return digest(prospectivePacketSchema.parse(value));
}

/** Literal admission evidence, not a compiler/runtime observation or approval issuer.
 * The independently retained expectation remains the authority for every member and
 * both approval records. Git object closure is still checked by the existing adapter;
 * the unchanged exporter retains its own accepted-manifest and blob checks. */
export function verifyProspectiveCustodySourceReceipt(value: unknown, expected: unknown): ProspectiveCustodySourceReceipt {
  const parse = (input: unknown) => {
    custodySourceCanonicalBytes(input);
    const receipt = prospectiveReceiptSchema.parse(input);
    const { approvals, ...packet } = receipt;
    const members = Object.keys(receipt.subject.members).sort();
    const partition = [...receipt.closure.source, ...receipt.closure.config, ...receipt.closure.tests].sort();
    if (new Set(partition).size !== partition.length || custodySourceCanonicalBytes(partition) !== custodySourceCanonicalBytes(members) ||
        custodySourceCanonicalBytes(Object.keys(receipt.subject.contentSha256).sort()) !== custodySourceCanonicalBytes(members) ||
        receipt.subject.entrypoints.some(path => !receipt.closure.source.includes(path))) throw Error('custody-prospective-closure');
    const differences = Object.keys(receipt.original.members).sort().flatMap(path => {
      const original = receipt.original.members[path];
      if (!Object.hasOwn(receipt.subject.members, path)) throw Error('custody-prospective-original-member');
      const prospective = receipt.subject.contentSha256[path];
      return original === prospective ? [] : [{ path, original, prospective }];
    });
    if (custodySourceCanonicalBytes(differences) !== custodySourceCanonicalBytes(receipt.differences) ||
        receipt.subject.repository !== receipt.original.capture.candidate.repository) throw Error('custody-prospective-history');
    if (approvals.rule.subjectSha256 !== receipt.rule.sha256 || approvals.packet.subjectSha256 !== digest(packet) ||
        approvals.rule.reviewerOwnerId === receipt.producerOwnerId || approvals.packet.reviewerOwnerId === receipt.producerOwnerId) {
      throw Error('custody-prospective-approval');
    }
    return freeze(receipt);
  };
  // Parse/copy both synchronously; an awaiting consumer cannot rebaseline them.
  const retained = parse(expected), supplied = parse(value);
  if (custodySourceCanonicalBytes(supplied) !== custodySourceCanonicalBytes(retained)) throw Error('custody-prospective-substitution');
  return supplied;
}

const recipient = (role: 'source' | 'metadata' | 'p001') => z.object({ role: z.literal(role),
  authorityRef: reference, ownerId: z.string().min(1) }).strict();
const handoffExpectation = z.object({ recipients: z.tuple([recipient('source'), recipient('metadata'), recipient('p001')]),
  remainingObligations: z.array(reference).min(1).refine(rows => new Set(rows).size === rows.length) }).strict();
export type CustodySourceHandoffExpectation = z.infer<typeof handoffExpectation>;
const handoffSchema = handoffExpectation.extend({ schemaVersion: z.literal('custody-source-handoff-v1'),
  authority: z.literal('source-only'), receipt: receiptSchema, receiptSha256: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
export function parseCustodySourceHandoff(value: unknown, expected: unknown) {
  custodySourceCanonicalBytes(value); custodySourceCanonicalBytes(expected);
  const snapshot = freeze(handoffExpectation.parse(expected));
  const parsed = handoffSchema.parse(value);
  const receipt = parseCustodySourceArtifactReceipt(parsed.receipt);
  if (digest(receipt) !== parsed.receiptSha256 ||
      custodySourceCanonicalBytes({ recipients: parsed.recipients, remainingObligations: parsed.remainingObligations }) !==
      custodySourceCanonicalBytes(snapshot)) throw Error('custody-handoff-expectation');
  return freeze({ ...parsed, receipt });
}

export interface CustodySourceCleanup {
  schemaVersion: 'custody-source-cleanup-v1'; leaseId: string; receiptSha256: string | null; artifactRoot: string;
  exportersReleased: boolean; artifactRemoved: boolean; donorDeleted: false;
  outcome: 'success' | 'failed' | 'aborted'; closedAt: string;
}
export type CustodySourceArtifactResult<T> =
  | { status: 'success'; value: T; receipt: CustodySourceArtifactReceipt; cleanup: CustodySourceCleanup }
  | { status: 'failed' | 'aborted'; error: { name: string; message: string };
      receipt: CustodySourceArtifactReceipt | null; cleanup: CustodySourceCleanup | null };
export interface CustodySourceConsumerContext {
  receipt: CustodySourceArtifactReceipt; signal: AbortSignal; env: Readonly<Record<string, string>>;
}
export interface CustodySourceArtifactScope {
  readonly receipt: CustodySourceArtifactReceipt;
  verify(): Promise<void>;
  use<T>(consumer: { run(context: CustodySourceConsumerContext): Promise<T>;
    release(): Promise<void> }): Promise<T>;
}
export interface CustodySourceArtifactOptions {
  repository: string; expectedCapture: { ref: string; candidate: GitSyncCandidateCapture };
  destination: string; runGit: RunGit; ownerId: string; workItemRef: string;
  deadline: string; signal: AbortSignal; now?: () => number;
  /** Optional separately approved prospective case; generic UNKNOWN receipts stay unchanged. */
  prospectiveSource?: { receipt: unknown; expected: unknown };
  /** Existing binary-safe Git seam, required only for prospective content-SHA256 checks. */
  runGitStdin?: RunGitStdin;
  /** Fault-injection seam for the owned removal only; never receives a donor path. */
  removeArtifact?: (path: string) => Promise<void>;
}

/** All calls use the supplied existing runner. No host environment or canonical Git write. */
export async function withCustodySourceArtifact<T>(input: CustodySourceArtifactOptions,
  use: (scope: CustodySourceArtifactScope) => Promise<T>): Promise<CustodySourceArtifactResult<T>> {
  const options = Object.freeze({ ...input });
  const now = options.now ?? Date.now;
  const leaseId = randomUUID();
  let receipt: CustodySourceArtifactReceipt | null = null;
  let root = options.destination;
  const lifecycle: { owned: { dev: number; ino: number } | null; failure: Error | null } = { owned: null, failure: null };
  let value: T | undefined;
  let prospectiveSource: ProspectiveCustodySourceReceipt | null = null;
  let verifyProspectiveMembers: (() => Promise<void>) | null = null;
  let accepting = true;
  let exportersReleased = true;
  const controller = new AbortController();
  const pending = new Set<Promise<unknown>>();
  const abort = () => controller.abort();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const fail = (error: unknown) => { lifecycle.failure ??= error instanceof Error ? error : Error(String(error)); };
  const assertLive = () => {
    if (!accepting || controller.signal.aborted || options.signal.aborted || now() >= Date.parse(options.deadline)) {
      if (now() >= Date.parse(options.deadline)) controller.abort();
      const error = Error('custody-invocation-closed-aborted-or-expired'); error.name = 'AbortError'; throw error;
    }
  };
  try {
    // Both independent expectations are copied synchronously, before the first await or effect.
    custodySourceCanonicalBytes(options.expectedCapture);
    const expected = freeze(z.object({ ref: z.string().min(1), candidate: candidateSchema }).strict().parse(options.expectedCapture));
    if (options.prospectiveSource) {
      prospectiveSource = verifyProspectiveCustodySourceReceipt(options.prospectiveSource.receipt, options.prospectiveSource.expected);
      if (prospectiveSource.subject.captureRef !== expected.ref || prospectiveSource.subject.tree !== expected.candidate.tree ||
          prospectiveSource.subject.repository !== expected.candidate.repository) throw Error('custody-prospective-subject');
      if (!options.runGitStdin) throw Error('custody-prospective-binary-reader');
    }
    const repository = absolute.parse(options.repository);
    root = absolute.parse(options.destination);
    const deadline = iso.parse(options.deadline);
    const issued = now();
    if (!Number.isFinite(issued) || issued >= Date.parse(deadline) || !options.ownerId || !reference.safeParse(options.workItemRef).success) {
      throw Error('custody-invocation-identity-deadline');
    }
    options.signal.addEventListener('abort', abort, { once: true });
    // Re-arm long finite deadlines instead of Node's overflow-to-1ms behavior.
    const arm = () => { const left = Date.parse(deadline) - now();
      if (left <= 0) controller.abort(); else timer = setTimeout(arm, Math.min(left, 2_147_483_647)); };
    arm(); assertLive();
    const env = freeze({ GIT_NO_LAZY_FETCH: '1', GIT_OPTIONAL_LOCKS: '0', GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_PARAMETERS: '', GIT_NO_REPLACE_OBJECTS: '1',
      GIT_CONFIG_COUNT: '4', GIT_CONFIG_KEY_0: 'protocol.allow', GIT_CONFIG_VALUE_0: 'never',
      GIT_CONFIG_KEY_1: 'core.hooksPath', GIT_CONFIG_VALUE_1: '/dev/null',
      GIT_CONFIG_KEY_2: 'submodule.recurse', GIT_CONFIG_VALUE_2: 'false',
      GIT_CONFIG_KEY_3: 'core.fsmonitor', GIT_CONFIG_VALUE_3: 'false' });
    const git: RunGit = async (args, cwd, callOptions) => {
      assertLive();
      const cloning = args.includes('clone');
      if (cloning && (args.at(-2) !== repository || args.at(-1) !== root || !args.includes('--local') || !args.includes('--shared'))) {
        throw Error('custody-nonlocal-clone');
      }
      const result = await options.runGit(['-c', 'protocol.allow=never', '-c', 'core.hooksPath=/dev/null',
        ...(cloning ? ['-c', 'protocol.file.allow=always'] : []), ...args], cwd,
      { ...callOptions, env: freeze({ ...callOptions?.env, ...env }) });
      assertLive(); return result;
    };
    const checked = async (args: string[], cwd = repository) => {
      const r = await git(args, cwd);
      if (r.code !== 0) throw Error('custody-git: ' + args[0] + ': ' + r.stderr.trim());
      return r.stdout.trim();
    };
    if (await realpath(repository) !== repository) throw Error('custody-repository-realpath');
    if (await realpath(dirname(root)) !== dirname(root) || root === repository ||
        root.startsWith(repository + sep) || repository.startsWith(root + sep)) throw Error('custody-destination-isolation');
    const destination = await lstat(root).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return null; throw error;
    });
    if (destination) throw Error('custody-destination-exists');
    const capture = await readGitSyncCandidate(git, repository, expected.candidate);
    if (!capture.ok) throw Error('custody-read: ' + capture.error);
    const actual = { ref: capture.ref, candidate: parseGitSyncCandidateCapture(capture.candidate) };
    if (custodySourceCanonicalBytes(actual) !== custodySourceCanonicalBytes(expected)) throw Error('custody-capture-substitution');
    const manifest = await git(['show', capture.ref + ':manifest.json'], repository);
    if (manifest.code !== 0 || manifest.stdout !== custodySourceCanonicalBytes(actual.candidate)) throw Error('custody-manifest-noncanonical');
    const candidate = expected.candidate;
    if (!candidate.base || await checked(['cat-file', '-t', candidate.base]) !== 'commit' ||
        await checked(['rev-parse', '--verify', candidate.base + '^{tree}']) !== candidate.baseTree) throw Error('custody-base');
    const pinnedOwner = async (owner: string, path: string, commit: string) => {
      if (!sourcePath.safeParse(path).success) throw Error('custody-prospective-gitlink-path');
      const child = join(owner, path), stat = await lstat(child).catch(() => null);
      if (!stat?.isDirectory() || stat.isSymbolicLink() || await realpath(child) !== child ||
          await checked(['rev-parse', '--show-toplevel'], child) !== child ||
          await checked(['cat-file', '-t', commit], child) !== 'commit') throw Error('custody-prospective-gitlink: ' + path);
      return { owner: child, tree: await checked(['rev-parse', '--verify', commit + '^{tree}'], child) };
    };
    const seen = new Set<string>();
    const closure = async (object: string, type: 'tree' | 'blob', owner = repository, prefix = '', pins = false): Promise<void> => {
      const key = owner + '\0' + type + object + (pins ? '\0pins:' + prefix : '\0generic');
      if (seen.has(key)) return;
      if (await checked(['cat-file', '-t', object], owner) !== type) throw Error('custody-object-type');
      seen.add(key);
      if (type !== 'tree') return;
      const listing = await git(['ls-tree', '-z', object], owner);
      if (listing.code !== 0) throw Error('custody-object-closure');
      for (const row of listing.stdout.split('\0').filter(Boolean)) {
        const match = /^(040000|100644|100755|120000|160000) (tree|blob|commit) ([a-f0-9]{40}|[a-f0-9]{64})\t/.exec(row);
        if (!match) throw Error('custody-object-entry');
        const path = prefix + row.slice(match[0].length);
        if (match[1] === '160000' && match[2] === 'commit') {
          // Only the prospective subject requires complete pinned availability.
          // Original base/dependency history and the generic case stay UNKNOWN.
          if (pins) {
            const child = await pinnedOwner(owner, path, match[3]);
            await closure(child.tree, 'tree', child.owner, '', true);
          }
          continue;
        }
        if ((match[1] === '040000') !== (match[2] === 'tree') || match[2] === 'commit') throw Error('custody-object-mode');
        await closure(match[3], match[2] as 'tree' | 'blob', owner, path + '/', pins);
      }
    };
    for (const tree of [candidate.tree, candidate.baseTree, ...(candidate.dependencies ?? []).flatMap(row => row.tree === null ? [] : [row.tree])]) {
      await closure(tree, 'tree', repository, '', prospectiveSource !== null && tree === candidate.tree);
    }
    if (prospectiveSource) {
      // Resolve only approved paths against their immutable tree/gitlink pins.
      // This uses the injected hardened runner: the exporter's synchronous
      // resolver cannot supply this invocation's read-only Git profile.
      const verifyMembers = async () => {
        for (const [path, blob] of Object.entries(prospectiveSource!.subject.members)) {
          let owner = repository, tree = candidate.tree, prefix: string[] = [];
          const parts = path.split('/');
          for (let i = 0; i < parts.length; i++) {
            const part = parts[i]; prefix.push(part);
            const listing = await git(['--literal-pathspecs', 'ls-tree', '-z', tree, '--', part], owner);
            const rows = listing.stdout.split('\0').filter(Boolean), row = rows[0] ?? '';
            const tab = row.indexOf('\t'), [mode, type, object] = row.slice(0, tab).split(' ');
            if (listing.code !== 0 || rows.length !== 1 || row.slice(tab + 1) !== part) throw Error('custody-prospective-source-member: ' + path);
            if (i === parts.length - 1) {
              if (type !== 'blob' || !['100644', '100755'].includes(mode) || object !== blob) throw Error('custody-prospective-source-member: ' + path);
              if (await checked(['cat-file', '-t', object], owner) !== 'blob') throw Error('custody-prospective-source-member: ' + path);
              // Keep content SHA256 distinct from Git's object-format hash, and
              // hash exact bytes: UTF-8 decoding would corrupt binary inputs.
              const contents = await options.runGitStdin!(['-c', 'protocol.allow=never', '-c', 'core.hooksPath=/dev/null',
                'cat-file', 'blob', object], owner, '', { env, signal: controller.signal,
                timeoutMs: Math.max(1, Math.min(30_000, Date.parse(deadline) - now())) });
              assertLive();
              if (contents.code !== 0 || !Buffer.isBuffer(contents.stdout) ||
                  createHash('sha256').update(contents.stdout).digest('hex') !== prospectiveSource!.subject.contentSha256[path]) {
                throw Error('custody-prospective-content-digest: ' + path);
              }
            } else if (type === 'tree' && mode === '040000') {
              tree = object;
            } else if (type === 'commit' && mode === '160000') {
              const child = await pinnedOwner(owner, prefix.join('/'), object);
              tree = child.tree; owner = child.owner; prefix = [];
            } else throw Error('custody-prospective-source-member: ' + path);
          }
        }
      };
      await verifyMembers();
      verifyProspectiveMembers = verifyMembers;
    }
    const snapshotSource = async () => {
      const common = candidate.repository;
      const files = await git(['ls-files', '-z', '--cached', '--others', '--exclude-standard'], repository);
      if (files.code !== 0) throw Error('custody-source-files');
      const bytes: unknown[] = [];
      for (const path of [...new Set(files.stdout.split('\0').filter(Boolean))].sort()) {
        const full = join(repository, path);
        const s = await lstat(full).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return null; throw error; });
        if (!s) bytes.push([path, null]);
        else if (s.isSymbolicLink()) bytes.push([path, s.mode, await readlink(full)]);
        else if (s.isFile()) bytes.push([path, s.mode, createHash('sha256').update(await readFile(full)).digest('hex')]);
        else bytes.push([path, s.mode, 'directory']);
      }
      const rawFiles = await Promise.all(['HEAD', 'index', 'config'].map(async path =>
        [path, await readFile(join(common, path)).then(b => b.toString('base64')).catch((error: NodeJS.ErrnoException) => {
          if (error.code === 'ENOENT') return null; throw error;
        })]));
      return digest({ bytes, rawFiles, refs: await checked(['for-each-ref', '--format=%(refname) %(objectname)']),
        objects: (await checked(['cat-file', '--batch-all-objects', '--batch-check=%(objectname) %(objecttype) %(objectsize)'])).split('\n').sort() });
    };
    const sourceBefore = await snapshotSource();
    const scratchRunner: ScratchGitRunner = async (args, cwd) => {
      if (args.includes('clone')) {
        const stat = await lstat(root);
        if (!stat.isDirectory() || stat.isSymbolicLink() || await realpath(root) !== root) throw Error('custody-destination-identity');
        lifecycle.owned = { dev: stat.dev, ino: stat.ino };
      }
      const r = await git(args, cwd); return { code: r.code, output: r.stdout + r.stderr };
    };
    await createScratchClone({ source: repository, ref: candidate.base, destination: root,
      includeSubmodules: false, signal: controller.signal, runGit: scratchRunner });
    const commit = await checked(['-c', 'user.name=Custody source artifact', '-c', 'user.email=custody@papercusp.local',
      'commit-tree', candidate.tree, '-p', candidate.base, '-m', 'Private source-only custody view'], root);
    oid.parse(commit);
    await checked(['-c', 'advice.detachedHead=false', 'checkout', '--detach', '--quiet', commit], root);
    receipt = parseCustodySourceArtifactReceipt({ schemaVersion: 'custody-source-artifact-v1', authority: 'source-only',
      capture: expected, artifact: { root, commit, parent: candidate.base, tree: candidate.tree },
      objects: { selfContained: false, donorRepository: candidate.repository, cleanupOrder: ['exporter', 'artifact', 'donor'] },
      custody: { ownerId: options.ownerId, workItemRef: options.workItemRef, leaseId, issuedAt: new Date(issued).toISOString(),
        expiresAt: deadline, releaseCondition: 'producer-chain-settled' },
      qualifications: { ancestry: 'UNKNOWN', sourceCensus: 'UNKNOWN', compiler: 'UNKNOWN', publication: false,
        fullOutput: false, runtime: false, native: false, activation: false, workerRegistration: false, suiteStart: false, shipment: false } });
    const stableReceipt = receipt;
    const verify = async () => {
      assertLive();
      if (await realpath(candidate.repository) !== candidate.repository || await realpath(root) !== root ||
          await checked(['rev-parse', 'HEAD'], root) !== commit ||
          await checked(['show', '-s', '--format=%T %P', commit], root) !== candidate.tree + ' ' + candidate.base ||
          (await git(['symbolic-ref', '-q', 'HEAD'], root)).code !== 1 ||
          await checked(['remote'], root) !== '' || await snapshotSource() !== sourceBefore) throw Error('custody-view-drift');
      const reread = await readGitSyncCandidate(git, repository, candidate);
      if (!reread.ok || custodySourceCanonicalBytes({ ref: reread.ref, candidate: reread.candidate }) !==
          custodySourceCanonicalBytes(expected)) throw Error('custody-donor-capture-drift');
      await verifyProspectiveMembers?.();
      assertLive();
    };
    await verify();
    const track = <U>(operation: Promise<U>): Promise<U> => {
      pending.add(operation);
      void operation.then(() => pending.delete(operation), error => { fail(error); pending.delete(operation); });
      return operation;
    };
    const scope: CustodySourceArtifactScope = Object.freeze({ receipt: stableReceipt,
      verify: () => track(verify()),
      use<U>(consumer: { run(context: CustodySourceConsumerContext): Promise<U>; release(): Promise<void> }): Promise<U> {
        assertLive();
        const operation = (async () => {
          try { await verify(); const result = await consumer.run({ receipt: stableReceipt, signal: controller.signal, env }); assertLive(); return result; }
          finally { try { await consumer.release(); } catch (error) { exportersReleased = false; throw error; } }
        })();
        return track(operation);
      } });
    value = await use(scope);
    if (pending.size) throw Error('custody-unjoined-consumer');
    await verify();
  } catch (error) { fail(error); }
  finally {
    accepting = false; controller.abort(); clearTimeout(timer); options.signal.removeEventListener('abort', abort);
    // Cancellation is a signal, never evidence that a child has stopped.
    await Promise.allSettled([...pending]);
  }
  let artifactRemoved = false;
  if (lifecycle.owned && exportersReleased) {
    try {
      const identity = await lstat(root).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return null; throw error; });
      if (identity && (!identity.isDirectory() || identity.isSymbolicLink() || identity.dev !== lifecycle.owned.dev || identity.ino !== lifecycle.owned.ino)) {
        throw Error('custody-cleanup-ownership-changed');
      }
      if (identity) await (options.removeArtifact ?? (path => rm(path, { recursive: true, force: true })))(root);
      artifactRemoved = !(await lstat(root).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return null; throw error; }));
      if (!artifactRemoved) throw Error('custody-cleanup-incomplete');
    } catch (error) { fail(error); }
  }
  if (options.signal.aborted || now() >= Date.parse(options.deadline)) {
    const error = Error('custody-invocation-aborted-or-expired'); error.name = 'AbortError'; fail(error);
  }
  const status = lifecycle.failure ? (lifecycle.failure.name === 'AbortError' || options.signal.aborted || now() >= Date.parse(options.deadline) ? 'aborted' : 'failed') : 'success';
  const cleanup: CustodySourceCleanup | null = lifecycle.owned ? freeze({ schemaVersion: 'custody-source-cleanup-v1', leaseId,
    receiptSha256: receipt ? digest(receipt) : null, artifactRoot: root, exportersReleased, artifactRemoved,
    donorDeleted: false, outcome: status, closedAt: new Date(now()).toISOString() }) : null;
  if (status === 'success' && receipt && cleanup && exportersReleased && artifactRemoved) return { status, value: value as T, receipt, cleanup };
  const error = lifecycle.failure ?? Error('custody-cleanup-not-successful');
  return { status: status === 'aborted' ? 'aborted' : 'failed', error: { name: error.name, message: error.message }, receipt, cleanup };
}
