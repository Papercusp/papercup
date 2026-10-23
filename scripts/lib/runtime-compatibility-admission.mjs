/** Actual admission-ledger operations against an explicitly identified test DB.
 * This is a source baseline, not global background-owner or candidate proof.
 */
import postgres from 'postgres';

export async function perform() {
  const url = new URL(process.env.PAPERCUSP_PROBE_PG_URL ?? '');
  const nonce = process.env.PAPERCUSP_PROBE_NONCE;
  const attempt = process.env.PAPERCUSP_PROBE_ATTEMPT;
  const action = process.env.PAPERCUSP_PROBE_ACTION;
  const nowMs = Number(process.env.PAPERCUSP_PROBE_NOW);
  if (!/^runtime_admission_[a-f0-9]{12}$/.test(url.pathname.slice(1))
      || !nonce || !attempt || !Number.isFinite(nowMs)
      || !['enqueue', 'lease', 'hold', 'stale', 'complete'].includes(action)) {
    throw new Error('An isolated runtime_admission database and explicit fixture identity are required');
  }
  const sql = postgres(url.href, { prepare: false, max: 2, connect_timeout: 5,
    connection: { statement_timeout: 15_000 }, onnotice: () => {} });
  try {
    const [guard] = await sql`SELECT nonce FROM runtime_probe.guard WHERE nonce=${nonce}`;
    if (!guard) throw new Error('Runtime admission fixture identity mismatch');
    const load = async path => {
      const source = new URL('../../packages/operator-core/lib/resource-governor/' + path, import.meta.url);
      return process.versions.bun ? import(source.href)
        : (await import('tsx/esm/api')).tsImport(source.href, import.meta.url);
    };
    const [{ PgAdmissionLedgerQueueStore }, { WorkItemAdmissionQueueDriver }, { Governor }] =
      await Promise.all([load('admission-ledger-store.ts'), load('queue.ts'), load('admission.ts')]);
    const store = new PgAdmissionLedgerQueueStore({ sql, workspaceId: 'runtime-admission',
      // Expiry, rather than the ambient session registry, drives recovery here.
      resolveSessionStatesFn: async subjects => new Map(subjects.map(({ ownerId }) =>
        [ownerId, { sessionState: 'live' }])) });
    const driver = new WorkItemAdmissionQueueDriver(store, {
      namespace: 'runtime-admission', now: () => nowMs, leaseIdFactory: () => attempt,
    });
    await sql`INSERT INTO runtime_probe.attempts (attempt, pid) VALUES (${attempt}, ${process.pid})`;
    if (action === 'enqueue') {
      const result = await new Governor(driver, { now: () => nowMs }).admit({
        idempotencyKey: 'same-request', admissionClass: 'process', demand: { cpuWeight: 1 },
      });
      return { queued: result.kind === 'queued' };
    }
    const receiptId = process.env.PAPERCUSP_PROBE_RECEIPT;
    const oldLease = process.env.PAPERCUSP_PROBE_OLD_LEASE;
    if (!receiptId) throw new Error('A target receipt is required');
    if (action === 'stale') {
      if (!oldLease) throw new Error('A stale lease token is required');
      return {
        running: (await driver.markRunning(receiptId, oldLease))?.changed ?? false,
        completed: (await driver.complete(receiptId, oldLease, 'stale-result'))?.changed ?? false,
      };
    }
    if (action === 'complete') {
      if (!oldLease) throw new Error('The current lease token is required');
      return { completed: (await driver.complete(receiptId, oldLease, 'runtime-result'))?.changed ?? false };
    }
    const claim = await driver.leaseReceipt({ receiptId, owner: attempt, ttlMs: 1_000 });
    const running = claim
      ? (await driver.markRunning(receiptId, claim.lease.leaseId))?.changed === true : false;
    if (running) await sql`INSERT INTO runtime_probe.effects (attempt, pid) VALUES (${attempt}, ${process.pid})`;
    // The parent kills this exact detached child only after observing its
    // persisted running lease/effect. No completion receipt can precede death.
    if (action === 'hold' && running) await new Promise(() => setInterval(() => {}, 1_000));
    return { leased: Boolean(claim), running };
  } finally { await sql.end({ timeout: 2 }); }
}
