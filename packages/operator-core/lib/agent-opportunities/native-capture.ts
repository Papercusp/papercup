/** Source-defined native capture reconciliation. The activity ledger is an index,
 * never the population. Only host-issued runtime roots define the expected calls;
 * no request can supply a source path, a completeness flag, or a historical floor. */
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, readdir, realpath } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { codexHomeForSessionKey, sessionClaudeConfigDir } from '@papercusp/orchestrator/session-launch-dirs';
import { getOrgPg } from '@papercusp/db-org';
import { ompAgentHomeForSessionKey } from '../session-transcript-resolvers';
import { nativeTranscriptSources, NATIVE_PROVIDERS, type NativeProvider } from './native-operation';
import type { SearchSource } from './search-reformulation';

type Client = ReturnType<typeof getOrgPg>['sql'];
type Binding = { id: string; owner: string; provider: NativeProvider; harness: string | null };
type CaptureReceipt = { manifest?: Record<string, string[]>; enrolling?: boolean;
  population?: string; cursor?: string };
const ENROLLMENT_BATCH = 32;
export interface NativeCaptureOptions {
  workspaceId: string; harnessSlug: string; sourceBoundary: string; since: string; until: string;
  client?: Client; authorize: () => Promise<boolean>;
}
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const micros = (value: string) => BigInt(Date.parse(value)) * 1000n
  + BigInt(((/\.(\d+)/.exec(value)?.[1] ?? '').padEnd(6, '0').slice(3, 6)) || '0');
const uuid = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
/** Internal source reader shared with hydration. Its paths are derived from the
 * authenticated runtime binding, including predecessors left by managed carries. */
export async function canonicalNativeRuntimeSources(binding: Binding, context: {
  workspaceId: string; harnessSlug: string; sourceBoundary: string;
}, deadline = Date.now() + 1000) {
  if (!/^\d+$/.test(binding.id) || !/^[\w-]+$/.test(binding.owner)
    || !NATIVE_PROVIDERS.includes(binding.provider)) throw new Error('native_capture_binding');
  const root = binding.provider === 'codex' ? join(codexHomeForSessionKey(binding.id), 'sessions')
    : binding.provider === 'claude' ? join(sessionClaudeConfigDir(binding.owner), 'projects')
      : join(ompAgentHomeForSessionKey(binding.id), 'sessions');
  if (await realpath(root) !== resolve(root)) throw new Error('native_capture_source_kind');
  const pattern = new RegExp(binding.provider === 'codex' ? `^rollout-.*-(${uuid})\\.jsonl$`
    : binding.provider === 'claude' ? `^(${uuid})\\.jsonl$` : '^.*_([A-Za-z0-9_-]{6,})\\.jsonl$', 'i');
  let entries = 0, bytesRead = 0;
  const files: { path: string; sessionId: string; stamp: string }[] = [];
  const walk = async (dir: string, depth: number): Promise<void> => {
    if (Date.now() >= deadline || depth > 4 || (await lstat(dir)).isSymbolicLink()) throw new Error('native_capture_bound');
    const children = await readdir(dir, { withFileTypes: true });
    entries += children.length;
    if (entries > 5000) throw new Error('native_capture_bound');
    for (const child of children.sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(dir, child.name);
      if (child.isDirectory()) { await walk(path, depth + 1); continue; }
      if (!child.isFile()) throw new Error('native_capture_source_kind');
      // Native sidecars are not transcripts. An unidentified JSONL is a gap.
      if (!child.name.endsWith('.jsonl')) continue;
      const match = pattern.exec(child.name);
      if (!match) throw new Error('native_capture_unidentified_source');
      const stat = await lstat(path, { bigint: true });
      files.push({ path, sessionId: match[1]!, stamp: [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].join(':') });
    }
  };
  await walk(root, 0);
  if (!files.length || files.length > 1000 || new Set(files.map(f => f.sessionId)).size !== files.length)
    throw new Error('native_capture_population');
  const sources: SearchSource[] = [], stamps: string[] = [];
  for (const file of files) {
    const handle = await open(file.path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const before = await handle.stat({ bigint: true });
      const stamp = [before.dev, before.ino, before.size, before.mtimeNs, before.ctimeNs].join(':');
      bytesRead += Number(before.size);
      if (stamp !== file.stamp || bytesRead > 32 * 1024 * 1024 || Date.now() >= deadline) throw new Error('native_capture_bound');
      const buffer = Buffer.alloc(Number(before.size) + 1);
      let length = 0;
      while (length < buffer.length) {
        if (Date.now() >= deadline) throw new Error('native_capture_bound');
        const read = await handle.read(buffer, length, buffer.length - length, length);
        if (!read.bytesRead) break;
        length += read.bytesRead;
      }
      const bytes = buffer.subarray(0, length);
      const after = await handle.stat({ bigint: true });
      if (stamp !== [after.dev, after.ino, after.size, after.mtimeNs, after.ctimeNs].join(':')
        || BigInt(bytes.length) !== before.size || bytes.at(-1) !== 10) throw new Error('native_capture_changed');
      const text = bytes.toString('utf8');
      if (!Buffer.from(text).equals(bytes)) throw new Error('native_capture_encoding');
      const lines = text.trimEnd().split('\n');
      // The maintained parser's bounded contract is preserved. No partial file
      // becomes a successful receipt, including an oversized historical source.
      if (lines.length > 4000 || lines.some(line => line.length > 256_000)) throw new Error('native_capture_bound');
      const records = lines.map(line => JSON.parse(line) as Record<string, unknown>);
      if (records.some(r => !r || typeof r !== 'object' || Array.isArray(r))) throw new Error('native_capture_encoding');
      if (binding.provider === 'codex' && (records[0]?.type !== 'session_meta'
        || (records[0]?.payload as { id?: string })?.id !== file.sessionId)) throw new Error('native_capture_identity');
      if (binding.provider === 'omp' && (records[0]?.type !== 'session' || records[0]?.id !== file.sessionId))
        throw new Error('native_capture_identity');
      if (binding.provider === 'claude' && (!records.some(r => r.sessionId === file.sessionId)
        || records.some(r => r.sessionId != null && r.sessionId !== file.sessionId))) throw new Error('native_capture_identity');
      const parsed = nativeTranscriptSources(lines, { ...context, authorizationScope: context.sourceBoundary,
        actor: binding.owner, verifiedAgent: true, origin: 'agent', provider: binding.provider,
        sessionId: file.sessionId, complete: true });
      const expected = records.reduce((n, record) => {
        const payload = record.payload as { type?: string } | undefined;
        const message = record.message as { content?: { type?: string }[] } | undefined;
        return n + (binding.provider === 'codex'
          ? Number(record.type === 'response_item' && ['function_call', 'custom_tool_call'].includes(payload?.type ?? ''))
          : Array.isArray(message?.content) ? message.content.filter(b => b.type === (binding.provider === 'claude' ? 'tool_use' : 'toolCall')).length : 0);
      }, 0);
      if (expected !== parsed.length) throw new Error('native_capture_parser_gap');
      sources.push(...parsed);
      stamps.push(digest([file.sessionId, stamp, createHash('sha256').update(bytes).digest('hex')]));
    } finally { await handle.close(); }
  }
  // Re-census detects a deleted/added predecessor and any source rewrite during IO.
  const previous = JSON.stringify(files); files.length = 0; entries = 0;
  await walk(root, 0);
  if (JSON.stringify(files) !== previous) throw new Error('native_capture_changed');
  return { sources, fingerprint: digest(stamps), identities: files.map(file =>
    digest([binding.id, binding.owner, binding.provider, file.sessionId])) };
}

/** A fresh canonical-source reconciliation, not a cached callback attestation.
 * Missing sources, an index rewrite, changed authority, future windows and the
 * pre-install period remain UNKNOWN/gap. Only opaque digests/counts are retained. */
export async function reconcileNativeCapture(opts: NativeCaptureOptions): Promise<'complete' | 'gap' | 'unknown'> {
  const sql = opts.client ?? getOrgPg().sql, deadline = Date.now() + 1000;
  try {
    if (!opts.harnessSlug || !opts.sourceBoundary || !Number.isFinite(Date.parse(opts.since))
      || !Number.isFinite(Date.parse(opts.until)) || Date.parse(opts.since) >= Date.parse(opts.until)
      || !await opts.authorize()) return 'unknown';
    const [ready] = await sql<{ ready: boolean }[]>`SELECT
      EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('harness_shared.sql_intent_progress')
        AND attname='native_capture_receipt' AND NOT attisdropped)
      AND (SELECT count(*)=3 FROM pg_trigger WHERE tgrelid=to_regclass('harness_shared.agent_activity')
        AND tgenabled='A' AND NOT tgisinternal AND (tgname,tgtype,tgfoid) IN (
        ('native_capture_index_delete',8,to_regprocedure('harness_shared.native_capture_index_changed()')),
        ('native_capture_index_update',16,to_regprocedure('harness_shared.native_capture_index_changed()')),
        ('native_capture_index_truncate',32,to_regprocedure('harness_shared.native_capture_index_truncated()'))))
      AND (SELECT count(*)=2 FROM pg_trigger WHERE tgrelid=to_regclass('harness_shared.adv_sessions')
        AND tgenabled='A' AND NOT tgisinternal AND (tgname,tgtype,tgfoid) IN (
        ('native_capture_population_delete',8,to_regprocedure('harness_shared.native_capture_population_changed()')),
        ('native_capture_population_update',16,to_regprocedure('harness_shared.native_capture_population_changed()'))))
      AND EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid=to_regclass('harness_shared.adv_sessions')
        AND tgenabled='A' AND tgname='native_capture_population_truncate' AND tgtype=32
        AND tgfoid=to_regprocedure('harness_shared.native_capture_index_truncated()'))
      AND (SELECT count(*)=3 FROM pg_trigger WHERE tgrelid=to_regclass('harness_shared.session_briefs')
        AND tgenabled='A' AND NOT tgisinternal AND (tgname,tgtype,tgfoid) IN (
        ('native_capture_authority_delete',8,to_regprocedure('harness_shared.native_capture_authority_changed()')),
        ('native_capture_authority_update',16,to_regprocedure('harness_shared.native_capture_authority_changed()')),
        ('native_capture_authority_truncate',32,to_regprocedure('harness_shared.native_capture_index_truncated()')))) AS ready`;
    if (!ready?.ready) return 'unknown';
    const scope = `native:${digest([opts.workspaceId, opts.harnessSlug, opts.sourceBoundary])}`;
    await sql`INSERT INTO harness_shared.sql_intent_progress (workspace_id,scope_id,harness_slug)
      VALUES (${opts.workspaceId},${scope},${opts.harnessSlug}) ON CONFLICT DO NOTHING`;
    const [progress] = await sql<{ revision: string; since: string; historical: boolean; future: boolean;
      receipt: CaptureReceipt | null }[]>`
      SELECT native_capture_revision::text AS revision,
        native_capture_receipt AS receipt,
        to_char(GREATEST(native_capture_from,${opts.since}::timestamptz) AT TIME ZONE 'UTC',
          'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS since,
        native_capture_from > ${opts.since}::timestamptz AS historical,
        ${opts.until}::timestamptz > clock_timestamp() AS future
      FROM harness_shared.sql_intent_progress WHERE workspace_id=${opts.workspaceId} AND scope_id=${scope}`;
    if (!progress || progress.future) return 'unknown';
    const population = async () => {
      const rows: Binding[] = [];
      let cursor = '0';
      for (;;) {
        if (Date.now() >= deadline) throw new Error('native_capture_bound');
        const page = await sql<Binding[]>`SELECT s.id::text,s.coord_owner_id AS owner,s.agent AS provider,
          harness_shared.harness_slug_for_usage_attribution(s.workspace_id,s.coord_owner_id,s.session_id,s.id) AS harness
          FROM harness_shared.adv_sessions s WHERE s.workspace_id=${opts.workspaceId} AND s.id > ${cursor}::bigint
            AND s.first_seen_at < ${opts.until}::timestamptz
            AND (s.ended_at IS NULL OR s.ended_at >= ${progress.since}::timestamptz)
          ORDER BY s.id LIMIT 250`;
        rows.push(...page);
        if (page.length < 250) return rows;
        cursor = page.at(-1)!.id;
      }
    };
    const roster = await population();
    const bindings = roster.filter(r => r.harness === opts.harnessSlug);
    if (!bindings.length) return 'unknown';
    if (!progress.receipt || progress.receipt.enrolling) {
      // Enrollment is prospective: a partial manifest certifies no interval.
      // Save opaque source identities between calls instead of rescanning every
      // already-enrolled home before a large roster can make any progress.
      const populationHash = digest(roster);
      // Inserts can grow the roster between batches. Detector revisions already
      // revoke deletion/rebinding, so retain earlier identities and enroll only
      // newly discovered bindings instead of restarting on every insertion.
      const pending = progress.receipt?.enrolling ? progress.receipt : null;
      const manifest = { ...pending?.manifest };
      const remaining = bindings.filter(b => !manifest[digest([b.id, b.owner, b.provider])]);
      let index = 0;
      for (; index < Math.min(ENROLLMENT_BATCH, remaining.length); index++) {
        // Leave budget for the authority/population recheck and durable write.
        if (Date.now() >= deadline - 100) break;
        try {
          const binding = remaining[index]!;
          const read = await canonicalNativeRuntimeSources(binding, opts, deadline - 100);
          manifest[digest([binding.id, binding.owner, binding.provider])] = read.identities;
        } catch { break; } // Retain earlier progress, but never skip a failed root.
      }
      if (!await opts.authorize() || JSON.stringify(await population()) !== JSON.stringify(roster)) return 'unknown';
      // Unknown attribution remains in the population and blocks completion.
      // It does not prevent preparation of the positively attributed roots.
      const complete = index === remaining.length && !roster.some(r => !r.harness);
      const receipt = complete
        ? { version: 1, baseline: true, sources: Object.values(manifest).reduce((n, ids) => n + ids.length, 0),
            manifest, population: populationHash, revision: progress.revision }
        : { version: 1, enrolling: true, manifest, population: populationHash,
            cursor: index ? digest([remaining[index - 1]!.id, remaining[index - 1]!.owner,
              remaining[index - 1]!.provider]) : pending?.cursor ?? null, revision: progress.revision };
      const previous = progress.receipt == null ? null : sql.json(progress.receipt);
      const written = await sql`UPDATE harness_shared.sql_intent_progress SET
        native_capture_from=CASE WHEN ${complete} THEN GREATEST(native_capture_from,clock_timestamp()) ELSE native_capture_from END,
        native_capture_receipt=${sql.json(receipt)}
        WHERE workspace_id=${opts.workspaceId} AND scope_id=${scope}
          AND native_capture_revision=${progress.revision}::bigint
          AND native_capture_receipt IS NOT DISTINCT FROM ${previous}::jsonb RETURNING 1`;
      return complete && written.length ? 'gap' : 'unknown';
    }
    // Null attribution is not evidence that a session is outside this harness.
    if (roster.some(r => !r.harness)) return 'unknown';
    const sources: SearchSource[] = [], fingerprints: string[] = [], identities: string[] = [];
    const manifest: Record<string, string[]> = {};
    for (const binding of bindings) {
      const read = await canonicalNativeRuntimeSources(binding, opts, deadline);
      sources.push(...read.sources); fingerprints.push(read.fingerprint); identities.push(...read.identities);
      const runtime = digest([binding.id, binding.owner, binding.provider]);
      manifest[runtime] = read.identities;
      if (progress.receipt?.manifest?.[runtime]?.some(identity => !read.identities.includes(identity))) return 'unknown';
    }
    if (sources.some(s => !s.callId || !Number.isFinite(Date.parse(s.at)))) return 'unknown';
    const calls = sources.filter(s => micros(s.at) >= micros(progress.since) && micros(s.at) < micros(opts.until));
    if (calls.length > 2000 || JSON.stringify(await population()) !== JSON.stringify(roster) || !await opts.authorize()) return 'unknown';
    // Call IDs identify requests; same-ID conflicting copies cannot be repaired.
    const unique = new Map<string, SearchSource>();
    for (const source of calls) {
      const key = JSON.stringify([source.actor, source.provider, source.namespace, source.callId]);
      const prior = unique.get(key);
      if (prior && digest([prior.tool, prior.args, prior.at]) !== digest([source.tool, source.args, source.at])) return 'unknown';
      unique.set(key, source);
    }
    if (micros(progress.since) >= micros(opts.until)) return 'gap';
    // Use the existing canonical index. Retain no command, arguments, result body
    // or path in the reconciliation write. Hydration rereads canonical sources.
    if (Date.now() >= deadline || !await opts.authorize()) return 'unknown';
    const expected = [...unique.values()].map(s => ({ actor: s.actor, provider: s.provider,
      session: s.namespace, call: s.callId, tool: s.tool, at: s.at }));
    if (expected.length) {
      // Two set operations, not two round trips per call. The bounded census
      // must remain practical for a real native window containing many calls.
      await sql`INSERT INTO harness_shared.agent_activity
        (workspace_id,harness_slug,owner_id,agent,session_id,kind,tool_name,phase,tool_use_id,summary,detail,created_at)
        SELECT ${opts.workspaceId},${opts.harnessSlug},s.actor,s.provider,s.session,'tool',s.tool,'pre',
          s.call,'Canonical native operation','{}'::jsonb,s.at::timestamptz
        FROM jsonb_to_recordset(${sql.json(expected)}::jsonb)
          AS s(actor text,provider text,session text,call text,tool text,at text)
        WHERE NOT EXISTS (SELECT 1 FROM harness_shared.agent_activity a WHERE a.workspace_id=${opts.workspaceId}
          AND a.harness_slug=${opts.harnessSlug} AND a.owner_id=s.actor AND a.agent=s.provider
          AND a.session_id=s.session AND a.tool_use_id=s.call AND a.kind='tool')`;
      // Compare again rather than inferring that successful INSERTs covered calls.
      const [row] = await sql<{ complete: boolean }[]>`SELECT NOT EXISTS(
        SELECT 1 FROM jsonb_to_recordset(${sql.json(expected)}::jsonb)
          AS s(actor text,provider text,session text,call text,tool text,at text)
        WHERE NOT EXISTS (SELECT 1 FROM harness_shared.agent_activity a WHERE a.workspace_id=${opts.workspaceId}
          AND a.harness_slug=${opts.harnessSlug} AND a.owner_id=s.actor AND a.agent=s.provider
          AND a.session_id=s.session AND a.tool_use_id=s.call AND a.tool_name=s.tool AND a.kind='tool'
          AND a.created_at >= ${progress.since}::timestamptz AND a.created_at < ${opts.until}::timestamptz)) AS complete`;
      if (!row?.complete) return 'unknown';
    }
    for (let i = 0; i < bindings.length; i++) {
      const current = await canonicalNativeRuntimeSources(bindings[i]!, opts, deadline);
      if (current.fingerprint !== fingerprints[i]) return 'unknown';
    }
    if (Date.now() >= deadline || !await opts.authorize() || JSON.stringify(await population()) !== JSON.stringify(roster)) return 'unknown';
    const receipt = { version: 1, since: progress.since, until: opts.until, sources: identities.length, manifest,
      runtimes: fingerprints.length,
      calls: unique.size, population: digest(roster), canonical: digest(fingerprints), revision: progress.revision };
    const written = await sql`UPDATE harness_shared.sql_intent_progress SET native_capture_receipt=${sql.json(receipt)}
      WHERE workspace_id=${opts.workspaceId} AND scope_id=${scope} AND native_capture_revision=${progress.revision}::bigint
      RETURNING 1`;
    return written.length ? progress.historical ? 'gap' : 'complete' : 'unknown';
  } catch { return 'unknown'; }
}
