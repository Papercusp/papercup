__vite_ssr_exportName__("MANDATED_INVARIANTS", () => { try { return MANDATED_INVARIANTS } catch {} });
__vite_ssr_exportName__("MATCHING_INVARIANTS", () => { try { return MATCHING_INVARIANTS } catch {} });
__vite_ssr_exportName__("RECONCILIATION_INVARIANTS", () => { try { return RECONCILIATION_INVARIANTS } catch {} });
__vite_ssr_exportName__("reconciliationPeriod", () => { try { return reconciliationPeriod } catch {} });
__vite_ssr_exportName__("entryNetCashCents", () => { try { return entryNetCashCents } catch {} });
__vite_ssr_exportName__("daoCreditedOffChain", () => { try { return daoCreditedOffChain } catch {} });
__vite_ssr_exportName__("evaluateReconciliation", () => { try { return evaluateReconciliation } catch {} });
__vite_ssr_exportName__("planBreakActions", () => { try { return planBreakActions } catch {} });
__vite_ssr_exportName__("transferGate", () => { try { return transferGate } catch {} });
__vite_ssr_exportName__("runReconciliation", () => { try { return runReconciliation } catch {} });
__vite_ssr_exportName__("memoryReconciliationStore", () => { try { return memoryReconciliationStore } catch {} });
const __vite_ssr_import_0__ = await __vite_ssr_import__("/@fs/home/marsh-office/papercupai-workspace/papercusp/packages/operator-core/lib/cupboard/money-journal.ts", {"importedNames":["MICROS_PER_CENT","externalRefKey","trialBalance"]});

const MANDATED_INVARIANTS = [
  "credit-reserve-covers-outstanding-credits",
  "dao-payable-equals-accrued-minus-transferred",
  "safe-balance-equals-receipts-minus-approved-spends"
];
const MATCHING_INVARIANTS = ["journal-matches-stripe", "journal-matches-bank", "journal-matches-chain"];
const RECONCILIATION_INVARIANTS = [...MANDATED_INVARIANTS, ...MATCHING_INVARIANTS];
function monthStartMs(year, monthIndex) {
  return Date.UTC(year, monthIndex, 1);
}
function monthLabel(ms) {
  const d = new Date(ms);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}
function reconciliationPeriod(mode, nowMs) {
  const now = new Date(nowMs);
  const currentStart = monthStartMs(now.getUTCFullYear(), now.getUTCMonth());
  if (mode === "provisional") return { mode, fromMs: currentStart, untilMs: nowMs, month: monthLabel(currentStart) };
  const previousStart = monthStartMs(now.getUTCFullYear(), now.getUTCMonth() - 1);
  return { mode, fromMs: previousStart, untilMs: currentStart, month: monthLabel(previousStart) };
};
const REF_KIND_FOR_MATCH = {
  "journal-matches-stripe": "stripe-balance-transaction",
  "journal-matches-bank": "bank-transaction",
  "journal-matches-chain": "chain-tx"
};
const SOURCE_FOR_MATCH = {
  "journal-matches-stripe": "stripe",
  "journal-matches-bank": "bank",
  "journal-matches-chain": "chain"
};
function entryNetCashCents(entry) {
  let net = 0;
  for (const line of entry.lines) {
    if (line.account !== "operating") continue;
    net += line.side === "debit" ? line.cents : -line.cents;
  };
  return net;
};
function unavailable(invariant, read, source, mode, mandated) {
  if (read.status === "failed") return { invariant, status: "unknown", detail: `${source} could not be read: ${read.detail}` };
  if (mode === "final" && mandated) {
    return { invariant, status: "unknown", detail: `${source} is not configured, so the final figure cannot be established` };
  };
  return { invariant, status: "not-configured", detail: `${source} is not configured in this deployment` };
}
function matchingVerdict(invariant, entries, read, period) {
  const source = SOURCE_FOR_MATCH[invariant];
  const refKind = REF_KIND_FOR_MATCH[invariant];
  const inPeriod = entries.filter(
    (e) => e.externalRef.kind === refKind && e.movement !== "usage-settlement" && e.occurredAtMs >= period.fromMs && e.occurredAtMs < period.untilMs
  );
  if (read.status !== "ok") {
    if (read.status === "not-configured" && inPeriod.length > 0) {
      return {
        invariant,
        status: "broken",
        detail: `${inPeriod.length} journal entr${inPeriod.length === 1 ? "y cites" : "ies cite"} ${refKind} but no ${source} source is configured to confirm them`
      };
    };
    return unavailable(invariant, read, source, period.mode, false);
  };
  const journal = /* @__PURE__ */ new Map();
  for (const entry of inPeriod) {
    const key = (0,__vite_ssr_import_0__.externalRefKey)(entry.externalRef);
    const list = journal.get(key) ?? [];
    list.push(entryNetCashCents(entry));
    journal.set(key, list);
  };
  const problems = [];
  const seen = /* @__PURE__ */ new Set();
  for (const movement of read.value) {
    if (seen.has(movement.ref)) {
      problems.push(`${source} lists ${movement.ref} twice`);
      continue;
    };
    seen.add(movement.ref);
    const posted = journal.get(movement.ref);
    if (!posted) problems.push(`${movement.ref} (${movement.netCents}c) has no journal entry`);
    else if (posted.length > 1) problems.push(`${movement.ref} is journaled ${posted.length} times`);
    else if (posted[0] !== movement.netCents) {
      problems.push(`${movement.ref}: journal moves ${posted[0]}c of cash, ${source} moved ${movement.netCents}c`);
    }
  };
  for (const key of journal.keys()) {
    if (!seen.has(key)) problems.push(`journal entry ${key} has no ${source} movement`);
  };
  if (problems.length === 0) {
    return { invariant, status: "ok", detail: `${read.value.length} ${source} movement(s) each match one journal entry` };
  };
  const shown = problems.slice(0, 5).join("; ");
  return {
    invariant,
    status: "broken",
    detail: problems.length > 5 ? `${shown}; and ${problems.length - 5} more` : shown
  };
}
function daoCreditedOffChain(entries) {
  let cents = 0;
  for (const entry of entries) {
    if (entry.externalRef.kind === "chain-tx") continue;
    for (const line of entry.lines) if (line.account === "dao-payable" && line.side === "credit") cents += line.cents;
  };
  return cents;
};
function evaluateReconciliation(input) {
  const { sources, period } = input;
  const upToEnd = input.entries.filter((e) => e.occurredAtMs < period.untilMs);
  const tb = (0,__vite_ssr_import_0__.trialBalance)(upToEnd);
  const balance = (account) => tb.accounts.find((a) => a.account === account)?.balanceCents ?? 0;
  const credited = (account) => tb.accounts.find((a) => a.account === account)?.creditCents ?? 0;
  const verdicts = [];
  {
    const invariant = "credit-reserve-covers-outstanding-credits";
    const read = sources.credits;
    if (read.status !== "ok") verdicts.push(unavailable(invariant, read, "the prepaid-credit store", period.mode, true));
    else {
      const reserveMicros = balance("customer-credit-reserve") * __vite_ssr_import_0__.MICROS_PER_CENT;
      const outstanding = read.value.outstandingMicros;
      const ok = reserveMicros >= outstanding;
      verdicts.push({
        invariant,
        status: ok ? "ok" : "broken",
        detail: `credit reserve ${reserveMicros} micros ${ok ? ">=" : "<"} outstanding credits ${outstanding} micros`
      });
    }
  }
  {
    const invariant = "dao-payable-equals-accrued-minus-transferred";
    const read = sources.dao;
    if (read.status !== "ok") verdicts.push(unavailable(invariant, read, "the DAO transfer record on chain", period.mode, true));
    else {
      const payable = balance("dao-payable");
      const offChain = daoCreditedOffChain(upToEnd);
      const accrued = offChain + read.value.chainAccruedCents;
      const expected = accrued - read.value.transferredCents;
      verdicts.push({
        invariant,
        status: payable === expected ? "ok" : "broken",
        detail: `journal dao-payable ${payable}c; accrued ${accrued}c (off-chain journal ${offChain}c + final settlements ${read.value.chainAccruedCents}c) - transferred on chain ${read.value.transferredCents}c = ${expected}c`
      });
    }
  }
  {
    const invariant = "safe-balance-equals-receipts-minus-approved-spends";
    const read = sources.safe;
    if (read.status !== "ok") verdicts.push(unavailable(invariant, read, "the DAO Safe", period.mode, true));
    else {
      const { balanceMicros, receiptsMicros, approvedSpendsMicros } = read.value;
      const expected = receiptsMicros - approvedSpendsMicros;
      verdicts.push({
        invariant,
        status: balanceMicros === expected ? "ok" : "broken",
        detail: `Safe balance ${balanceMicros} micros; receipts ${receiptsMicros} - approved spends ${approvedSpendsMicros} = ${expected} micros`
      });
    }
  }
  for (const invariant of MATCHING_INVARIANTS) {
    verdicts.push(matchingVerdict(invariant, input.entries, sources[SOURCE_FOR_MATCH[invariant]], period));
  };
  return verdicts;
};
function planBreakActions(verdicts, open, mode = "provisional") {
  const openByInvariant = new Map(open.map((b) => [b.invariant, b]));
  const actions = [];
  for (const verdict of verdicts) {
    const existing = openByInvariant.get(verdict.invariant);
    const closedMonthBreak = existing?.openedMode === "final" && mode !== "final";
    if (verdict.status === "broken") {
      if (!existing) actions.push({ kind: "open", verdict });
      else if (!closedMonthBreak) actions.push({ kind: "keep", open: existing, verdict });
    } else if (closedMonthBreak) continue;
    else if (existing && verdict.status === "ok") actions.push({ kind: "resolve", open: existing, verdict });
    else if (existing) actions.push({ kind: "keep", open: existing, verdict });
  };
  return actions;
};
function transferGate(verdicts, openAfterRun) {
  const reasons = [];
  for (const invariant of openAfterRun) reasons.push(`break open: ${invariant}`);
  for (const v of verdicts) {
    if (v.status === "unknown" && MANDATED_INVARIANTS.includes(v.invariant)) {
      reasons.push(`cannot evaluate ${v.invariant}: ${v.detail}`);
    }
  };
  return { open: reasons.length === 0, reasons };
};
async function runReconciliation(input, deps) {
  const startedAtMs = input.startedAtMs ?? deps.now();
  const runId = deps.newRunId();
  const period = reconciliationPeriod(input.mode, startedAtMs);
  const verdicts = evaluateReconciliation({ entries: input.entries, sources: input.sources, period });
  const open = await deps.store.listOpenBreaks(input.workspaceId);
  const actions = planBreakActions(verdicts, open, input.mode);
  const opened = [];
  const resolved = [];
  const stillOpen = new Set(open.map((b) => b.invariant));
  for (const action of actions) {
    const invariant = action.verdict.invariant;
    if (action.kind === "open") {
      const row = { invariant, workItemId: null, openedAtMs: startedAtMs, openedByRunId: runId, openedMode: input.mode };
      stillOpen.add(invariant);
      if (!await deps.store.openBreak(input.workspaceId, row, action.verdict.detail)) continue;
      opened.push(invariant);
      const workItemId = await deps.filer.fileBreak({ workspaceId: input.workspaceId, verdict: action.verdict, period, runId });
      await deps.store.setBreakWorkItem(input.workspaceId, invariant, workItemId);
    } else if (action.kind === "keep") {
      await deps.store.touchBreak(input.workspaceId, invariant, runId, action.verdict.detail);
      if (!action.open.workItemId) {
        const workItemId = await deps.filer.fileBreak({ workspaceId: input.workspaceId, verdict: action.verdict, period, runId });
        await deps.store.setBreakWorkItem(input.workspaceId, invariant, workItemId);
      }
    } else {
      await deps.store.resolveBreak(input.workspaceId, invariant, runId, startedAtMs);
      stillOpen.delete(invariant);
      resolved.push(invariant);
      if (action.open.workItemId) {
        await deps.filer.noteResolved({ workspaceId: input.workspaceId, workItemId: action.open.workItemId, verdict: action.verdict, runId });
      }
    }
  };
  const gate = transferGate(verdicts, [...stillOpen]);
  const gatePublish = await deps.gate.publish({ workspaceId: input.workspaceId, gate, runId, atMs: startedAtMs });
  const record = {
    runId,
    workspaceId: input.workspaceId,
    period,
    startedAtMs,
    finishedAtMs: deps.now(),
    verdicts,
    opened,
    resolved,
    gate,
    gatePublish
  };
  await deps.store.recordRun(record);
  return record;
};
function memoryReconciliationStore() {
  const rows = /* @__PURE__ */ new Map();
  const runs = [];
  const key = (ws, inv) => `${ws}\0${inv}`;
  return {
    rows,
    runs,
    async listOpenBreaks(ws) {
      return [...rows.entries()].filter(([k, r]) => k.startsWith(`${ws}\0`) && r.resolvedAtMs === null).map(([, r]) => ({
        invariant: r.invariant,
        workItemId: r.workItemId,
        openedAtMs: r.openedAtMs,
        openedByRunId: r.openedByRunId,
        // Like the PG store, the mode is known only once the opening run recorded.
        openedMode: runs.find((run) => run.runId === r.openedByRunId)?.period.mode
      }));
    },
    async openBreak(ws, b, detail) {
      const existing = rows.get(key(ws, b.invariant));
      if (existing && existing.resolvedAtMs === null) return false;
      rows.set(key(ws, b.invariant), { ...b, detail, lastRunId: b.openedByRunId, resolvedAtMs: null });
      return true;
    },
    async setBreakWorkItem(ws, inv, id) {
      const r = rows.get(key(ws, inv));
      if (r) rows.set(key(ws, inv), { ...r, workItemId: id });
    },
    async touchBreak(ws, inv, runId, detail) {
      const r = rows.get(key(ws, inv));
      if (r) rows.set(key(ws, inv), { ...r, lastRunId: runId, detail });
    },
    async resolveBreak(ws, inv, runId, atMs) {
      const r = rows.get(key(ws, inv));
      if (r) rows.set(key(ws, inv), { ...r, lastRunId: runId, resolvedAtMs: atMs });
    },
    async recordRun(run) {
      runs.push(run);
    }
  };
}
//# sourceMappingSource=vite-generated
//# sourceMappingURL=data:application/json;base64,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QUNBLE1BQU0sV0FBVyxJQUFJLEtBQUssT0FBTyxRQUFRO0FBQ3ZDLFlBQU0sSUFBSSxLQUFLLElBQUksSUFBSSxJQUFJLEdBQUcsQ0FBQztBQUMvQixVQUFJLEVBQUcsTUFBSyxJQUFJLElBQUksSUFBSSxHQUFHLEdBQUcsRUFBRSxHQUFHLEdBQUcsV0FBVyxPQUFPLE9BQU8sQ0FBQztBQUFBLElBQ2xFO0FBQUEsSUFDQSxNQUFNLGFBQWEsSUFBSSxLQUFLLE9BQU8sTUFBTTtBQUN2QyxZQUFNLElBQUksS0FBSyxJQUFJLElBQUksSUFBSSxHQUFHLENBQUM7QUFDL0IsVUFBSSxFQUFHLE1BQUssSUFBSSxJQUFJLElBQUksR0FBRyxHQUFHLEVBQUUsR0FBRyxHQUFHLFdBQVcsT0FBTyxjQUFjLEtBQUssQ0FBQztBQUFBLElBQzlFO0FBQUEsSUFDQSxNQUFNLFVBQVUsS0FBSztBQUNuQixXQUFLLEtBQUssR0FBRztBQUFBLElBQ2Y7QUFBQSxFQUNGO0FBQ0YiLCJuYW1lcyI6W10sImlnbm9yZUxpc3QiOltdLCJzb3VyY2VzIjpbInJlY29uY2lsaWF0aW9uLnRzIl0sInNvdXJjZXNDb250ZW50IjpbIi8qKlxuICogTW9uZXkgcmVjb25jaWxpYXRpb24gKGFnZW50LWVjb25vbXktZmx5d2hlZWwtMjAyNi0wOC0zMCBQLTA0MywgUi0zMSwgRC0wMjUpLlxuICpcbiAqIFRoZSBqb3VybmFsIChQLTA0MikgaXMgcmVjb25jaWxlZCBhZ2FpbnN0IHdoYXQgYWN0dWFsbHkgaGFwcGVuZWQgb3V0c2lkZSBpdDpcbiAqIFN0cmlwZSBiYWxhbmNlIHRyYW5zYWN0aW9ucywgdGhlIGJhbmsgZmVlZCwgYW5kIHRoZSBjaGFpbiAodGhlIERBTyBTYWZlIGFuZFxuICogdGhlIHNldHRsZW1lbnQgY29udHJhY3QpLiBIb3VybHkgcnVucyBnaXZlIFBST1ZJU0lPTkFMIGZpZ3VyZXMgZm9yIHRoZSBvcGVuXG4gKiBtb250aDsgYSBydW4gYWZ0ZXIgbW9udGggY2xvc2UgZ2l2ZXMgdGhlIEZJTkFMIGZpZ3VyZXMgZm9yIHRoZSBjbG9zZWQgbW9udGguXG4gKlxuICogVGhyZWUgaW52YXJpYW50cyBhcmUgbWFuZGF0ZWQgYnkgdGhlIHBsYW46XG4gKlxuICogICBjcmVkaXQtcmVzZXJ2ZS1jb3ZlcnMtb3V0c3RhbmRpbmctY3JlZGl0c1xuICogICAgIGpvdXJuYWwgY3VzdG9tZXItY3JlZGl0LXJlc2VydmUgID49ICBvdXRzdGFuZGluZyBwcmVwYWlkIGNyZWRpdHNcbiAqICAgZGFvLXBheWFibGUtZXF1YWxzLWFjY3J1ZWQtbWludXMtdHJhbnNmZXJyZWRcbiAqICAgICBqb3VybmFsIGRhby1wYXlhYmxlICA9PSAgREFPIHNoYXJlIGFjY3J1ZWQgIC0gIERBTyB0cmFuc2ZlcnMgc2VlbiBvbiBjaGFpblxuICogICBzYWZlLWJhbGFuY2UtZXF1YWxzLXJlY2VpcHRzLW1pbnVzLWFwcHJvdmVkLXNwZW5kc1xuICogICAgIFNhZmUgdG9rZW4gYmFsYW5jZSAgPT0gIG9uLWNoYWluIHJlY2VpcHRzICAtICBhcHByb3ZlZCBzcGVuZHNcbiAqXG4gKiBhbmQgdGhyZWUgbWF0Y2hpbmcgY2hlY2tzIGtlZXAgdGhlIGpvdXJuYWwgdGhvc2UgaW52YXJpYW50cyByZWFkIGhvbmVzdDpcbiAqIGV2ZXJ5IGV4dGVybmFsIG1vdmVtZW50IGhhcyBleGFjdGx5IG9uZSBqb3VybmFsIGVudHJ5IHdpdGggdGhlIHNhbWUgbmV0IGNhc2hcbiAqIGVmZmVjdCwgYW5kIGV2ZXJ5IGpvdXJuYWwgZW50cnkncyBleHRlcm5hbCByZWZlcmVuY2UgZXhpc3RzIGF0IGl0cyBzb3VyY2UuXG4gKlxuICogQSBCUkVBSyBvcGVucyBleGFjdGx5IG9uZSB3b3JrIGl0ZW0gcGVyIGludmFyaWFudCBhbmQgc3RheXMgb3BlbiAoZGVkdXBlZClcbiAqIHVudGlsIGEgbGF0ZXIgcnVuIHNlZXMgdGhlIGludmFyaWFudCBob2xkIGFnYWluLiBEQU8gdHJhbnNmZXJzIGFyZSBwYXVzZWRcbiAqIHdoaWxlIGFueSBicmVhayBpcyBvcGVuLCBvciB3aGlsZSBhIG1hbmRhdGVkIGludmFyaWFudCBjYW5ub3QgYmUgZXZhbHVhdGVkXG4gKiBiZWNhdXNlIGl0cyBzb3VyY2UgZmFpbGVkOiBhIHJlY29uY2lsaWF0aW9uIHRoYXQgY2Fubm90IHNlZSBtdXN0IG5vdCBsZWF2ZVxuICogbW9uZXkgbW92aW5nLlxuICpcbiAqIFRoaXMgbW9kdWxlIGlzIHB1cmUgYXBhcnQgZnJvbSB0aGUgaW5qZWN0ZWQgYFJlY29uY2lsaWF0aW9uRGVwc2A7IHRoZSBQR1xuICogc3RvcmUsIHRoZSBzb3VyY2UgYWRhcHRlcnMsIHRoZSB3b3JrLWl0ZW0gZmlsZXIgYW5kIHRoZSBnYXRlIHB1Ymxpc2hlciBsaXZlXG4gKiBpbiByZWNvbmNpbGlhdGlvbi1ydW50aW1lLnRzLlxuICovXG5pbXBvcnQge1xuICBNSUNST1NfUEVSX0NFTlQsXG4gIGV4dGVybmFsUmVmS2V5LFxuICB0cmlhbEJhbGFuY2UsXG4gIHR5cGUgRXh0ZXJuYWxSZWZLaW5kLFxuICB0eXBlIEpvdXJuYWxFbnRyeSxcbn0gZnJvbSAnLi9tb25leS1qb3VybmFsJztcblxuZXhwb3J0IGNvbnN0IE1BTkRBVEVEX0lOVkFSSUFOVFMgPSBbXG4gICdjcmVkaXQtcmVzZXJ2ZS1jb3ZlcnMtb3V0c3RhbmRpbmctY3JlZGl0cycsXG4gICdkYW8tcGF5YWJsZS1lcXVhbHMtYWNjcnVlZC1taW51cy10cmFuc2ZlcnJlZCcsXG4gICdzYWZlLWJhbGFuY2UtZXF1YWxzLXJlY2VpcHRzLW1pbnVzLWFwcHJvdmVkLXNwZW5kcycsXG5dIGFzIGNvbnN0O1xuXG5leHBvcnQgY29uc3QgTUFUQ0hJTkdfSU5WQVJJQU5UUyA9IFsnam91cm5hbC1tYXRjaGVzLXN0cmlwZScsICdqb3VybmFsLW1hdGNoZXMtYmFuaycsICdqb3VybmFsLW1hdGNoZXMtY2hhaW4nXSBhcyBjb25zdDtcblxuZXhwb3J0IGNvbnN0IFJFQ09OQ0lMSUFUSU9OX0lOVkFSSUFOVFMgPSBbLi4uTUFOREFURURfSU5WQVJJQU5UUywgLi4uTUFUQ0hJTkdfSU5WQVJJQU5UU10gYXMgY29uc3Q7XG5leHBvcnQgdHlwZSBSZWNvbmNpbGlhdGlvbkludmFyaWFudCA9ICh0eXBlb2YgUkVDT05DSUxJQVRJT05fSU5WQVJJQU5UUylbbnVtYmVyXTtcblxuZXhwb3J0IHR5cGUgUmVjb25jaWxpYXRpb25Nb2RlID0gJ3Byb3Zpc2lvbmFsJyB8ICdmaW5hbCc7XG5cbi8qKlxuICogT25lIHNvdXJjZSByZWFkLiBgbm90LWNvbmZpZ3VyZWRgIG1lYW5zIHRoZSByYWlsIGRvZXMgbm90IGV4aXN0IGluIHRoaXNcbiAqIGRlcGxveW1lbnQgKG5vIGJhbmsgY29ubmVjdGVkLCBubyBTYWZlIGRlcGxveWVkKTsgYGZhaWxlZGAgbWVhbnMgaXQgZXhpc3RzXG4gKiBhbmQgY291bGQgbm90IGJlIHJlYWQuIFRoZXkgYXJlIGRpZmZlcmVudCBmYWN0cyBhbmQgYXJlIG5ldmVyIG1lcmdlZC5cbiAqL1xuZXhwb3J0IHR5cGUgU291cmNlUmVhZDxUPiA9XG4gIHwgeyByZWFkb25seSBzdGF0dXM6ICdvayc7IHJlYWRvbmx5IHZhbHVlOiBUIH1cbiAgfCB7IHJlYWRvbmx5IHN0YXR1czogJ2ZhaWxlZCc7IHJlYWRvbmx5IGRldGFpbDogc3RyaW5nIH1cbiAgfCB7IHJlYWRvbmx5IHN0YXR1czogJ25vdC1jb25maWd1cmVkJyB9O1xuXG4vKiogT25lIG1vdmVtZW50IGFzIGl0cyBzb3VyY2UgcmVjb3JkcyBpdC4gYG5ldENlbnRzYCBpcyB0aGUgc2lnbmVkIGVmZmVjdCBvbiBjYXNoIChpbmZsb3cgcG9zaXRpdmUpLiAqL1xuZXhwb3J0IGludGVyZmFjZSBFeHRlcm5hbE1vdmVtZW50IHtcbiAgcmVhZG9ubHkgcmVmOiBzdHJpbmc7XG4gIHJlYWRvbmx5IG5ldENlbnRzOiBudW1iZXI7XG59XG5cbmV4cG9ydCBpbnRlcmZhY2UgQ3JlZGl0c1NuYXBzaG90IHtcbiAgLyoqIFByZXBhaWQgY3JlZGl0cyBzdGlsbCBvd2VkIHRvIGN1c3RvbWVycyAoYXZhaWxhYmxlICsgcmVzZXJ2ZWQpLCBpbiBtaWNyby1VU0QuICovXG4gIHJlYWRvbmx5IG91dHN0YW5kaW5nTWljcm9zOiBudW1iZXI7XG59XG5cbmV4cG9ydCBpbnRlcmZhY2UgRGFvU25hcHNob3Qge1xuICAvKiogREFPIHRyYW5zZmVycyBzZXR0bGVkIG9uIGNoYWluLCBpbiB3aG9sZSBjZW50cyAodGhlIHVuaXQgdGhlIGpvdXJuYWwgcmVjb3JkcyB0aGVtIGluKS4gKi9cbiAgcmVhZG9ubHkgdHJhbnNmZXJyZWRDZW50czogbnVtYmVyO1xuICAvKipcbiAgICogVGhlIERBTyBzaGFyZSBhY2NydWVkIG9uIHRoZSBDSEFJTiByYWlsIGFjY29yZGluZyB0byB0aGUgY29tbWVyY2UgbGVkZ2VyLCBub3RcbiAgICogdGhlIGpvdXJuYWw6IHRoZSBXb3JrZXIncyBEQU8gYWxsb2NhdGlvbiBvZiBldmVyeSBGSU5BTCBzZXR0bGVtZW50IGJhdGNoXG4gICAqIGZpbmFsaXplZCBiZWZvcmUgdGhlIHBlcmlvZCBlbmQsIHJvdW5kZWQgdG8gY2VudHMgcGVyIGJhdGNoIGV4YWN0bHkgYXMgdGhlXG4gICAqIGltcG9ydCByb3VuZHMgaXQgKEQtMDMyKS4gVGhlIGVuZ2luZSBhZGRzIHRoZSBqb3VybmFsJ3MgZGFvLXBheWFibGUgY3JlZGl0c1xuICAgKiBvbiBvZmYtY2hhaW4gZW50cmllcyAodGhlIFN0cmlwZSBhbmQgYmFuayByYWlscywgdGllZCB0byB0aG9zZSBzb3VyY2VzIGJ5XG4gICAqIHRoZWlyIG1hdGNoaW5nIGNoZWNrcyksIHNvIGEgbWlzc2luZywgZHVwbGljYXRlZCBvciBtaXMtc3BsaXQgY2hhaW4tcmFpbFxuICAgKiBhY2NydWFsIGluIHRoZSBqb3VybmFsIGJyZWFrcyB0aGUgaW52YXJpYW50LlxuICAgKi9cbiAgcmVhZG9ubHkgY2hhaW5BY2NydWVkQ2VudHM6IG51bWJlcjtcbn1cblxuZXhwb3J0IGludGVyZmFjZSBTYWZlU25hcHNob3Qge1xuICByZWFkb25seSBiYWxhbmNlTWljcm9zOiBudW1iZXI7XG4gIHJlYWRvbmx5IHJlY2VpcHRzTWljcm9zOiBudW1iZXI7XG4gIHJlYWRvbmx5IGFwcHJvdmVkU3BlbmRzTWljcm9zOiBudW1iZXI7XG59XG5cbmV4cG9ydCBpbnRlcmZhY2UgUmVjb25jaWxpYXRpb25Tb3VyY2VzIHtcbiAgcmVhZG9ubHkgc3RyaXBlOiBTb3VyY2VSZWFkPHJlYWRvbmx5IEV4dGVybmFsTW92ZW1lbnRbXT47XG4gIHJlYWRvbmx5IGJhbms6IFNvdXJjZVJlYWQ8cmVhZG9ubHkgRXh0ZXJuYWxNb3ZlbWVudFtdPjtcbiAgcmVhZG9ubHkgY2hhaW46IFNvdXJjZVJlYWQ8cmVhZG9ubHkgRXh0ZXJuYWxNb3ZlbWVudFtdPjtcbiAgcmVhZG9ubHkgY3JlZGl0czogU291cmNlUmVhZDxDcmVkaXRzU25hcHNob3Q+O1xuICByZWFkb25seSBkYW86IFNvdXJjZVJlYWQ8RGFvU25hcHNob3Q+O1xuICByZWFkb25seSBzYWZlOiBTb3VyY2VSZWFkPFNhZmVTbmFwc2hvdD47XG59XG5cbmV4cG9ydCB0eXBlIEludmFyaWFudFN0YXR1cyA9ICdvaycgfCAnYnJva2VuJyB8ICd1bmtub3duJyB8ICdub3QtY29uZmlndXJlZCc7XG5cbmV4cG9ydCBpbnRlcmZhY2UgSW52YXJpYW50VmVyZGljdCB7XG4gIHJlYWRvbmx5IGludmFyaWFudDogUmVjb25jaWxpYXRpb25JbnZhcmlhbnQ7XG4gIHJlYWRvbmx5IHN0YXR1czogSW52YXJpYW50U3RhdHVzO1xuICAvKiogT25lIGxpbmUgYSBwZXJzb24gY2FuIGFjdCBvbjogdGhlIHR3byBzaWRlcyBvZiB0aGUgY29tcGFyaXNvbiwgb3Igd2h5IGl0IGNvdWxkIG5vdCBiZSBtYWRlLiAqL1xuICByZWFkb25seSBkZXRhaWw6IHN0cmluZztcbn1cblxuZXhwb3J0IGludGVyZmFjZSBSZWNvbmNpbGlhdGlvblBlcmlvZCB7XG4gIHJlYWRvbmx5IG1vZGU6IFJlY29uY2lsaWF0aW9uTW9kZTtcbiAgLyoqIEluY2x1c2l2ZSBzdGFydCBvZiB0aGUgcGVyaW9kIChVVEMgbW9udGggc3RhcnQpLiAqL1xuICByZWFkb25seSBmcm9tTXM6IG51bWJlcjtcbiAgLyoqIEV4Y2x1c2l2ZSBlbmQ6IGBub3dgIGZvciBhIHByb3Zpc2lvbmFsIHJ1biwgdGhlIG5leHQgbW9udGggc3RhcnQgZm9yIGEgZmluYWwgb25lLiAqL1xuICByZWFkb25seSB1bnRpbE1zOiBudW1iZXI7XG4gIC8qKiBgWVlZWS1NTWAsIHRoZSBtb250aCB0aGUgcnVuIGNvdmVycy4gKi9cbiAgcmVhZG9ubHkgbW9udGg6IHN0cmluZztcbn1cblxuZnVuY3Rpb24gbW9udGhTdGFydE1zKHllYXI6IG51bWJlciwgbW9udGhJbmRleDogbnVtYmVyKTogbnVtYmVyIHtcbiAgcmV0dXJuIERhdGUuVVRDKHllYXIsIG1vbnRoSW5kZXgsIDEpO1xufVxuXG5mdW5jdGlvbiBtb250aExhYmVsKG1zOiBudW1iZXIpOiBzdHJpbmcge1xuICBjb25zdCBkID0gbmV3IERhdGUobXMpO1xuICByZXR1cm4gYCR7ZC5nZXRVVENGdWxsWWVhcigpfS0ke1N0cmluZyhkLmdldFVUQ01vbnRoKCkgKyAxKS5wYWRTdGFydCgyLCAnMCcpfWA7XG59XG5cbi8qKiBUaGUgb3BlbiBtb250aCBmb3IgYSBwcm92aXNpb25hbCBydW47IHRoZSBtb250aCB0aGF0IGp1c3QgY2xvc2VkIGZvciBhIGZpbmFsIG9uZS4gKi9cbmV4cG9ydCBmdW5jdGlvbiByZWNvbmNpbGlhdGlvblBlcmlvZChtb2RlOiBSZWNvbmNpbGlhdGlvbk1vZGUsIG5vd01zOiBudW1iZXIpOiBSZWNvbmNpbGlhdGlvblBlcmlvZCB7XG4gIGNvbnN0IG5vdyA9IG5ldyBEYXRlKG5vd01zKTtcbiAgY29uc3QgY3VycmVudFN0YXJ0ID0gbW9udGhTdGFydE1zKG5vdy5nZXRVVENGdWxsWWVhcigpLCBub3cuZ2V0VVRDTW9udGgoKSk7XG4gIGlmIChtb2RlID09PSAncHJvdmlzaW9uYWwnKSByZXR1cm4geyBtb2RlLCBmcm9tTXM6IGN1cnJlbnRTdGFydCwgdW50aWxNczogbm93TXMsIG1vbnRoOiBtb250aExhYmVsKGN1cnJlbnRTdGFydCkgfTtcbiAgY29uc3QgcHJldmlvdXNTdGFydCA9IG1vbnRoU3RhcnRNcyhub3cuZ2V0VVRDRnVsbFllYXIoKSwgbm93LmdldFVUQ01vbnRoKCkgLSAxKTtcbiAgcmV0dXJuIHsgbW9kZSwgZnJvbU1zOiBwcmV2aW91c1N0YXJ0LCB1bnRpbE1zOiBjdXJyZW50U3RhcnQsIG1vbnRoOiBtb250aExhYmVsKHByZXZpb3VzU3RhcnQpIH07XG59XG5cbmNvbnN0IFJFRl9LSU5EX0ZPUl9NQVRDSDogUmVhZG9ubHk8UmVjb3JkPCh0eXBlb2YgTUFUQ0hJTkdfSU5WQVJJQU5UUylbbnVtYmVyXSwgRXh0ZXJuYWxSZWZLaW5kPj4gPSB7XG4gICdqb3VybmFsLW1hdGNoZXMtc3RyaXBlJzogJ3N0cmlwZS1iYWxhbmNlLXRyYW5zYWN0aW9uJyxcbiAgJ2pvdXJuYWwtbWF0Y2hlcy1iYW5rJzogJ2JhbmstdHJhbnNhY3Rpb24nLFxuICAnam91cm5hbC1tYXRjaGVzLWNoYWluJzogJ2NoYWluLXR4Jyxcbn07XG5cbmNvbnN0IFNPVVJDRV9GT1JfTUFUQ0g6IFJlYWRvbmx5PFJlY29yZDwodHlwZW9mIE1BVENISU5HX0lOVkFSSUFOVFMpW251bWJlcl0sICdzdHJpcGUnIHwgJ2JhbmsnIHwgJ2NoYWluJz4+ID0ge1xuICAnam91cm5hbC1tYXRjaGVzLXN0cmlwZSc6ICdzdHJpcGUnLFxuICAnam91cm5hbC1tYXRjaGVzLWJhbmsnOiAnYmFuaycsXG4gICdqb3VybmFsLW1hdGNoZXMtY2hhaW4nOiAnY2hhaW4nLFxufTtcblxuLyoqIFRoZSBlbnRyeSdzIHNpZ25lZCBlZmZlY3Qgb24gY2FzaDogb3BlcmF0aW5nIGRlYml0cyBtaW51cyBvcGVyYXRpbmcgY3JlZGl0cy4gKi9cbmV4cG9ydCBmdW5jdGlvbiBlbnRyeU5ldENhc2hDZW50cyhlbnRyeTogSm91cm5hbEVudHJ5KTogbnVtYmVyIHtcbiAgbGV0IG5ldCA9IDA7XG4gIGZvciAoY29uc3QgbGluZSBvZiBlbnRyeS5saW5lcykge1xuICAgIGlmIChsaW5lLmFjY291bnQgIT09ICdvcGVyYXRpbmcnKSBjb250aW51ZTtcbiAgICBuZXQgKz0gbGluZS5zaWRlID09PSAnZGViaXQnID8gbGluZS5jZW50cyA6IC1saW5lLmNlbnRzO1xuICB9XG4gIHJldHVybiBuZXQ7XG59XG5cbmZ1bmN0aW9uIHVuYXZhaWxhYmxlKFxuICBpbnZhcmlhbnQ6IFJlY29uY2lsaWF0aW9uSW52YXJpYW50LFxuICByZWFkOiB7IHN0YXR1czogJ2ZhaWxlZCc7IGRldGFpbDogc3RyaW5nIH0gfCB7IHN0YXR1czogJ25vdC1jb25maWd1cmVkJyB9LFxuICBzb3VyY2U6IHN0cmluZyxcbiAgbW9kZTogUmVjb25jaWxpYXRpb25Nb2RlLFxuICBtYW5kYXRlZDogYm9vbGVhbixcbik6IEludmFyaWFudFZlcmRpY3Qge1xuICBpZiAocmVhZC5zdGF0dXMgPT09ICdmYWlsZWQnKSByZXR1cm4geyBpbnZhcmlhbnQsIHN0YXR1czogJ3Vua25vd24nLCBkZXRhaWw6IGAke3NvdXJjZX0gY291bGQgbm90IGJlIHJlYWQ6ICR7cmVhZC5kZXRhaWx9YCB9O1xuICAvLyBBIG1vbnRoIGNhbm5vdCBiZSBjbG9zZWQgb24gYSBtYW5kYXRlZCBpbnZhcmlhbnQgbm9ib2R5IGNhbiBldmFsdWF0ZS5cbiAgaWYgKG1vZGUgPT09ICdmaW5hbCcgJiYgbWFuZGF0ZWQpIHtcbiAgICByZXR1cm4geyBpbnZhcmlhbnQsIHN0YXR1czogJ3Vua25vd24nLCBkZXRhaWw6IGAke3NvdXJjZX0gaXMgbm90IGNvbmZpZ3VyZWQsIHNvIHRoZSBmaW5hbCBmaWd1cmUgY2Fubm90IGJlIGVzdGFibGlzaGVkYCB9O1xuICB9XG4gIHJldHVybiB7IGludmFyaWFudCwgc3RhdHVzOiAnbm90LWNvbmZpZ3VyZWQnLCBkZXRhaWw6IGAke3NvdXJjZX0gaXMgbm90IGNvbmZpZ3VyZWQgaW4gdGhpcyBkZXBsb3ltZW50YCB9O1xufVxuXG5mdW5jdGlvbiBtYXRjaGluZ1ZlcmRpY3QoXG4gIGludmFyaWFudDogKHR5cGVvZiBNQVRDSElOR19JTlZBUklBTlRTKVtudW1iZXJdLFxuICBlbnRyaWVzOiByZWFkb25seSBKb3VybmFsRW50cnlbXSxcbiAgcmVhZDogU291cmNlUmVhZDxyZWFkb25seSBFeHRlcm5hbE1vdmVtZW50W10+LFxuICBwZXJpb2Q6IFJlY29uY2lsaWF0aW9uUGVyaW9kLFxuKTogSW52YXJpYW50VmVyZGljdCB7XG4gIGNvbnN0IHNvdXJjZSA9IFNPVVJDRV9GT1JfTUFUQ0hbaW52YXJpYW50XTtcbiAgY29uc3QgcmVmS2luZCA9IFJFRl9LSU5EX0ZPUl9NQVRDSFtpbnZhcmlhbnRdO1xuICBjb25zdCBpblBlcmlvZCA9IGVudHJpZXMuZmlsdGVyKFxuICAgIChlKSA9PlxuICAgICAgZS5leHRlcm5hbFJlZi5raW5kID09PSByZWZLaW5kICYmXG4gICAgICBlLm1vdmVtZW50ICE9PSAndXNhZ2Utc2V0dGxlbWVudCcgJiZcbiAgICAgIGUub2NjdXJyZWRBdE1zID49IHBlcmlvZC5mcm9tTXMgJiZcbiAgICAgIGUub2NjdXJyZWRBdE1zIDwgcGVyaW9kLnVudGlsTXMsXG4gICk7XG4gIGlmIChyZWFkLnN0YXR1cyAhPT0gJ29rJykge1xuICAgIC8vIEpvdXJuYWwgZW50cmllcyBjaXRpbmcgYSByYWlsIHRoYXQgaXMgbm90IGNvbmZpZ3VyZWQgYXJlIHRoZW1zZWx2ZXMgYSBmaW5kaW5nOlxuICAgIC8vIG5vdGhpbmcgY2FuIGV2ZXIgY29uZmlybSB0aGVtLlxuICAgIGlmIChyZWFkLnN0YXR1cyA9PT0gJ25vdC1jb25maWd1cmVkJyAmJiBpblBlcmlvZC5sZW5ndGggPiAwKSB7XG4gICAgICByZXR1cm4ge1xuICAgICAgICBpbnZhcmlhbnQsXG4gICAgICAgIHN0YXR1czogJ2Jyb2tlbicsXG4gICAgICAgIGRldGFpbDogYCR7aW5QZXJpb2QubGVuZ3RofSBqb3VybmFsIGVudHIke2luUGVyaW9kLmxlbmd0aCA9PT0gMSA/ICd5IGNpdGVzJyA6ICdpZXMgY2l0ZSd9ICR7cmVmS2luZH0gYnV0IG5vICR7c291cmNlfSBzb3VyY2UgaXMgY29uZmlndXJlZCB0byBjb25maXJtIHRoZW1gLFxuICAgICAgfTtcbiAgICB9XG4gICAgcmV0dXJuIHVuYXZhaWxhYmxlKGludmFyaWFudCwgcmVhZCwgc291cmNlLCBwZXJpb2QubW9kZSwgZmFsc2UpO1xuICB9XG4gIGNvbnN0IGpvdXJuYWwgPSBuZXcgTWFwPHN0cmluZywgbnVtYmVyW10+KCk7XG4gIGZvciAoY29uc3QgZW50cnkgb2YgaW5QZXJpb2QpIHtcbiAgICBjb25zdCBrZXkgPSBleHRlcm5hbFJlZktleShlbnRyeS5leHRlcm5hbFJlZik7XG4gICAgY29uc3QgbGlzdCA9IGpvdXJuYWwuZ2V0KGtleSkgPz8gW107XG4gICAgbGlzdC5wdXNoKGVudHJ5TmV0Q2FzaENlbnRzKGVudHJ5KSk7XG4gICAgam91cm5hbC5zZXQoa2V5LCBsaXN0KTtcbiAgfVxuICBjb25zdCBwcm9ibGVtczogc3RyaW5nW10gPSBbXTtcbiAgY29uc3Qgc2VlbiA9IG5ldyBTZXQ8c3RyaW5nPigpO1xuICBmb3IgKGNvbnN0IG1vdmVtZW50IG9mIHJlYWQudmFsdWUpIHtcbiAgICBpZiAoc2Vlbi5oYXMobW92ZW1lbnQucmVmKSkge1xuICAgICAgcHJvYmxlbXMucHVzaChgJHtzb3VyY2V9IGxpc3RzICR7bW92ZW1lbnQucmVmfSB0d2ljZWApO1xuICAgICAgY29udGludWU7XG4gICAgfVxuICAgIHNlZW4uYWRkKG1vdmVtZW50LnJlZik7XG4gICAgY29uc3QgcG9zdGVkID0gam91cm5hbC5nZXQobW92ZW1lbnQucmVmKTtcbiAgICBpZiAoIXBvc3RlZCkgcHJvYmxlbXMucHVzaChgJHttb3ZlbWVudC5yZWZ9ICgke21vdmVtZW50Lm5ldENlbnRzfWMpIGhhcyBubyBqb3VybmFsIGVudHJ5YCk7XG4gICAgZWxzZSBpZiAocG9zdGVkLmxlbmd0aCA+IDEpIHByb2JsZW1zLnB1c2goYCR7bW92ZW1lbnQucmVmfSBpcyBqb3VybmFsZWQgJHtwb3N0ZWQubGVuZ3RofSB0aW1lc2ApO1xuICAgIGVsc2UgaWYgKHBvc3RlZFswXSAhPT0gbW92ZW1lbnQubmV0Q2VudHMpIHtcbiAgICAgIHByb2JsZW1zLnB1c2goYCR7bW92ZW1lbnQucmVmfTogam91cm5hbCBtb3ZlcyAke3Bvc3RlZFswXX1jIG9mIGNhc2gsICR7c291cmNlfSBtb3ZlZCAke21vdmVtZW50Lm5ldENlbnRzfWNgKTtcbiAgICB9XG4gIH1cbiAgZm9yIChjb25zdCBrZXkgb2Ygam91cm5hbC5rZXlzKCkpIHtcbiAgICBpZiAoIXNlZW4uaGFzKGtleSkpIHByb2JsZW1zLnB1c2goYGpvdXJuYWwgZW50cnkgJHtrZXl9IGhhcyBubyAke3NvdXJjZX0gbW92ZW1lbnRgKTtcbiAgfVxuICBpZiAocHJvYmxlbXMubGVuZ3RoID09PSAwKSB7XG4gICAgcmV0dXJuIHsgaW52YXJpYW50LCBzdGF0dXM6ICdvaycsIGRldGFpbDogYCR7cmVhZC52YWx1ZS5sZW5ndGh9ICR7c291cmNlfSBtb3ZlbWVudChzKSBlYWNoIG1hdGNoIG9uZSBqb3VybmFsIGVudHJ5YCB9O1xuICB9XG4gIGNvbnN0IHNob3duID0gcHJvYmxlbXMuc2xpY2UoMCwgNSkuam9pbignOyAnKTtcbiAgcmV0dXJuIHtcbiAgICBpbnZhcmlhbnQsXG4gICAgc3RhdHVzOiAnYnJva2VuJyxcbiAgICBkZXRhaWw6IHByb2JsZW1zLmxlbmd0aCA+IDUgPyBgJHtzaG93bn07IGFuZCAke3Byb2JsZW1zLmxlbmd0aCAtIDV9IG1vcmVgIDogc2hvd24sXG4gIH07XG59XG5cbi8qKlxuICogZGFvLXBheWFibGUgY3JlZGl0cyBwb3N0ZWQgYnkgZW50cmllcyB0aGF0IGRvIE5PVCBjaXRlIHRoZSBjaGFpbi4gVGhlIGNoYWluXG4gKiByYWlsJ3MgYWNjcnVhbCBjb21lcyBmcm9tIHRoZSBXb3JrZXIgaW5zdGVhZCAoRC0wMzIpLCBzbyBpdCBpcyB0aGUgb25lIHBhcnQgb2ZcbiAqIHRoZSBhY2NydWFsIHRoZSBqb3VybmFsIGNhbm5vdCB2b3VjaCBmb3IgaXRzZWxmLlxuICovXG5leHBvcnQgZnVuY3Rpb24gZGFvQ3JlZGl0ZWRPZmZDaGFpbihlbnRyaWVzOiByZWFkb25seSBKb3VybmFsRW50cnlbXSk6IG51bWJlciB7XG4gIGxldCBjZW50cyA9IDA7XG4gIGZvciAoY29uc3QgZW50cnkgb2YgZW50cmllcykge1xuICAgIGlmIChlbnRyeS5leHRlcm5hbFJlZi5raW5kID09PSAnY2hhaW4tdHgnKSBjb250aW51ZTtcbiAgICBmb3IgKGNvbnN0IGxpbmUgb2YgZW50cnkubGluZXMpIGlmIChsaW5lLmFjY291bnQgPT09ICdkYW8tcGF5YWJsZScgJiYgbGluZS5zaWRlID09PSAnY3JlZGl0JykgY2VudHMgKz0gbGluZS5jZW50cztcbiAgfVxuICByZXR1cm4gY2VudHM7XG59XG5cbi8qKiBFdmFsdWF0ZSBldmVyeSBpbnZhcmlhbnQgZm9yIG9uZSBwZXJpb2QuIEJhbGFuY2VzIGFyZSBzdG9ja3MgKGN1bXVsYXRpdmUgdG8gdGhlIHBlcmlvZCBlbmQpOyBtYXRjaGluZyBjb3ZlcnMgZmxvd3Mgd2l0aGluIGl0LiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGV2YWx1YXRlUmVjb25jaWxpYXRpb24oaW5wdXQ6IHtcbiAgcmVhZG9ubHkgZW50cmllczogcmVhZG9ubHkgSm91cm5hbEVudHJ5W107XG4gIHJlYWRvbmx5IHNvdXJjZXM6IFJlY29uY2lsaWF0aW9uU291cmNlcztcbiAgcmVhZG9ubHkgcGVyaW9kOiBSZWNvbmNpbGlhdGlvblBlcmlvZDtcbn0pOiBJbnZhcmlhbnRWZXJkaWN0W10ge1xuICBjb25zdCB7IHNvdXJjZXMsIHBlcmlvZCB9ID0gaW5wdXQ7XG4gIGNvbnN0IHVwVG9FbmQgPSBpbnB1dC5lbnRyaWVzLmZpbHRlcigoZSkgPT4gZS5vY2N1cnJlZEF0TXMgPCBwZXJpb2QudW50aWxNcyk7XG4gIGNvbnN0IHRiID0gdHJpYWxCYWxhbmNlKHVwVG9FbmQpO1xuICBjb25zdCBiYWxhbmNlID0gKGFjY291bnQ6IHN0cmluZykgPT4gdGIuYWNjb3VudHMuZmluZCgoYSkgPT4gYS5hY2NvdW50ID09PSBhY2NvdW50KT8uYmFsYW5jZUNlbnRzID8/IDA7XG4gIGNvbnN0IGNyZWRpdGVkID0gKGFjY291bnQ6IHN0cmluZykgPT4gdGIuYWNjb3VudHMuZmluZCgoYSkgPT4gYS5hY2NvdW50ID09PSBhY2NvdW50KT8uY3JlZGl0Q2VudHMgPz8gMDtcbiAgY29uc3QgdmVyZGljdHM6IEludmFyaWFudFZlcmRpY3RbXSA9IFtdO1xuXG4gIC8vIDEuIFByZXBhaWQgY3JlZGl0cyBvd2VkIHRvIGN1c3RvbWVycyBhcmUgY292ZXJlZCBieSB0aGUgcmVzZXJ2ZSB0aGF0IGhvbGRzIHRoZW0uXG4gIHtcbiAgICBjb25zdCBpbnZhcmlhbnQgPSAnY3JlZGl0LXJlc2VydmUtY292ZXJzLW91dHN0YW5kaW5nLWNyZWRpdHMnIGFzIGNvbnN0O1xuICAgIGNvbnN0IHJlYWQgPSBzb3VyY2VzLmNyZWRpdHM7XG4gICAgaWYgKHJlYWQuc3RhdHVzICE9PSAnb2snKSB2ZXJkaWN0cy5wdXNoKHVuYXZhaWxhYmxlKGludmFyaWFudCwgcmVhZCwgJ3RoZSBwcmVwYWlkLWNyZWRpdCBzdG9yZScsIHBlcmlvZC5tb2RlLCB0cnVlKSk7XG4gICAgZWxzZSB7XG4gICAgICBjb25zdCByZXNlcnZlTWljcm9zID0gYmFsYW5jZSgnY3VzdG9tZXItY3JlZGl0LXJlc2VydmUnKSAqIE1JQ1JPU19QRVJfQ0VOVDtcbiAgICAgIGNvbnN0IG91dHN0YW5kaW5nID0gcmVhZC52YWx1ZS5vdXRzdGFuZGluZ01pY3JvcztcbiAgICAgIGNvbnN0IG9rID0gcmVzZXJ2ZU1pY3JvcyA+PSBvdXRzdGFuZGluZztcbiAgICAgIHZlcmRpY3RzLnB1c2goe1xuICAgICAgICBpbnZhcmlhbnQsXG4gICAgICAgIHN0YXR1czogb2sgPyAnb2snIDogJ2Jyb2tlbicsXG4gICAgICAgIGRldGFpbDogYGNyZWRpdCByZXNlcnZlICR7cmVzZXJ2ZU1pY3Jvc30gbWljcm9zICR7b2sgPyAnPj0nIDogJzwnfSBvdXRzdGFuZGluZyBjcmVkaXRzICR7b3V0c3RhbmRpbmd9IG1pY3Jvc2AsXG4gICAgICB9KTtcbiAgICB9XG4gIH1cblxuICAvLyAyLiBXaGF0IHRoZSBqb3VybmFsIHNheXMgdGhlIERBTyBpcyBvd2VkIGVxdWFscyB3aGF0IGFjY3J1ZWQgbWludXMgd2hhdCB0aGUgY2hhaW4gc2hvd3Mgd2FzIHBhaWQuXG4gIHtcbiAgICBjb25zdCBpbnZhcmlhbnQgPSAnZGFvLXBheWFibGUtZXF1YWxzLWFjY3J1ZWQtbWludXMtdHJhbnNmZXJyZWQnIGFzIGNvbnN0O1xuICAgIGNvbnN0IHJlYWQgPSBzb3VyY2VzLmRhbztcbiAgICBpZiAocmVhZC5zdGF0dXMgIT09ICdvaycpIHZlcmRpY3RzLnB1c2godW5hdmFpbGFibGUoaW52YXJpYW50LCByZWFkLCAndGhlIERBTyB0cmFuc2ZlciByZWNvcmQgb24gY2hhaW4nLCBwZXJpb2QubW9kZSwgdHJ1ZSkpO1xuICAgIGVsc2Uge1xuICAgICAgY29uc3QgcGF5YWJsZSA9IGJhbGFuY2UoJ2Rhby1wYXlhYmxlJyk7XG4gICAgICBjb25zdCBvZmZDaGFpbiA9IGRhb0NyZWRpdGVkT2ZmQ2hhaW4odXBUb0VuZCk7XG4gICAgICBjb25zdCBhY2NydWVkID0gb2ZmQ2hhaW4gKyByZWFkLnZhbHVlLmNoYWluQWNjcnVlZENlbnRzO1xuICAgICAgY29uc3QgZXhwZWN0ZWQgPSBhY2NydWVkIC0gcmVhZC52YWx1ZS50cmFuc2ZlcnJlZENlbnRzO1xuICAgICAgdmVyZGljdHMucHVzaCh7XG4gICAgICAgIGludmFyaWFudCxcbiAgICAgICAgc3RhdHVzOiBwYXlhYmxlID09PSBleHBlY3RlZCA/ICdvaycgOiAnYnJva2VuJyxcbiAgICAgICAgZGV0YWlsOlxuICAgICAgICAgIGBqb3VybmFsIGRhby1wYXlhYmxlICR7cGF5YWJsZX1jOyBhY2NydWVkICR7YWNjcnVlZH1jIChvZmYtY2hhaW4gam91cm5hbCAke29mZkNoYWlufWMgKyBmaW5hbCBzZXR0bGVtZW50cyAke3JlYWQudmFsdWUuY2hhaW5BY2NydWVkQ2VudHN9YylgICtcbiAgICAgICAgICBgIC0gdHJhbnNmZXJyZWQgb24gY2hhaW4gJHtyZWFkLnZhbHVlLnRyYW5zZmVycmVkQ2VudHN9YyA9ICR7ZXhwZWN0ZWR9Y2AsXG4gICAgICB9KTtcbiAgICB9XG4gIH1cblxuICAvLyAzLiBUaGUgU2FmZSBob2xkcyBleGFjdGx5IHdoYXQgaXQgcmVjZWl2ZWQgbWludXMgd2hhdCB3YXMgYXBwcm92ZWQgdG8gbGVhdmUgaXQuXG4gIHtcbiAgICBjb25zdCBpbnZhcmlhbnQgPSAnc2FmZS1iYWxhbmNlLWVxdWFscy1yZWNlaXB0cy1taW51cy1hcHByb3ZlZC1zcGVuZHMnIGFzIGNvbnN0O1xuICAgIGNvbnN0IHJlYWQgPSBzb3VyY2VzLnNhZmU7XG4gICAgaWYgKHJlYWQuc3RhdHVzICE9PSAnb2snKSB2ZXJkaWN0cy5wdXNoKHVuYXZhaWxhYmxlKGludmFyaWFudCwgcmVhZCwgJ3RoZSBEQU8gU2FmZScsIHBlcmlvZC5tb2RlLCB0cnVlKSk7XG4gICAgZWxzZSB7XG4gICAgICBjb25zdCB7IGJhbGFuY2VNaWNyb3MsIHJlY2VpcHRzTWljcm9zLCBhcHByb3ZlZFNwZW5kc01pY3JvcyB9ID0gcmVhZC52YWx1ZTtcbiAgICAgIGNvbnN0IGV4cGVjdGVkID0gcmVjZWlwdHNNaWNyb3MgLSBhcHByb3ZlZFNwZW5kc01pY3JvcztcbiAgICAgIHZlcmRpY3RzLnB1c2goe1xuICAgICAgICBpbnZhcmlhbnQsXG4gICAgICAgIHN0YXR1czogYmFsYW5jZU1pY3JvcyA9PT0gZXhwZWN0ZWQgPyAnb2snIDogJ2Jyb2tlbicsXG4gICAgICAgIGRldGFpbDogYFNhZmUgYmFsYW5jZSAke2JhbGFuY2VNaWNyb3N9IG1pY3JvczsgcmVjZWlwdHMgJHtyZWNlaXB0c01pY3Jvc30gLSBhcHByb3ZlZCBzcGVuZHMgJHthcHByb3ZlZFNwZW5kc01pY3Jvc30gPSAke2V4cGVjdGVkfSBtaWNyb3NgLFxuICAgICAgfSk7XG4gICAgfVxuICB9XG5cbiAgZm9yIChjb25zdCBpbnZhcmlhbnQgb2YgTUFUQ0hJTkdfSU5WQVJJQU5UUykge1xuICAgIHZlcmRpY3RzLnB1c2gobWF0Y2hpbmdWZXJkaWN0KGludmFyaWFudCwgaW5wdXQuZW50cmllcywgc291cmNlc1tTT1VSQ0VfRk9SX01BVENIW2ludmFyaWFudF1dLCBwZXJpb2QpKTtcbiAgfVxuICByZXR1cm4gdmVyZGljdHM7XG59XG5cbi8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuLy8gQnJlYWtzOiBvbmUgb3BlbiByb3cgKGFuZCBvbmUgd29yayBpdGVtKSBwZXIgYnJva2VuIGludmFyaWFudC5cbi8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuXG5leHBvcnQgaW50ZXJmYWNlIE9wZW5CcmVhayB7XG4gIHJlYWRvbmx5IGludmFyaWFudDogUmVjb25jaWxpYXRpb25JbnZhcmlhbnQ7XG4gIHJlYWRvbmx5IHdvcmtJdGVtSWQ6IHN0cmluZyB8IG51bGw7XG4gIHJlYWRvbmx5IG9wZW5lZEF0TXM6IG51bWJlcjtcbiAgcmVhZG9ubHkgb3BlbmVkQnlSdW5JZDogc3RyaW5nO1xuICAvKiogVGhlIG1vZGUgb2YgdGhlIHJ1biB0aGF0IG9wZW5lZCBpdDsgYWJzZW50IHdoZW4gdGhhdCBydW4gbmV2ZXIgcmVjb3JkZWQgKHRyZWF0ZWQgYXMgcHJvdmlzaW9uYWwpLiAqL1xuICByZWFkb25seSBvcGVuZWRNb2RlPzogUmVjb25jaWxpYXRpb25Nb2RlO1xufVxuXG5leHBvcnQgdHlwZSBCcmVha0FjdGlvbiA9XG4gIHwgeyByZWFkb25seSBraW5kOiAnb3Blbic7IHJlYWRvbmx5IHZlcmRpY3Q6IEludmFyaWFudFZlcmRpY3QgfVxuICB8IHsgcmVhZG9ubHkga2luZDogJ2tlZXAnOyByZWFkb25seSBvcGVuOiBPcGVuQnJlYWs7IHJlYWRvbmx5IHZlcmRpY3Q6IEludmFyaWFudFZlcmRpY3QgfVxuICB8IHsgcmVhZG9ubHkga2luZDogJ3Jlc29sdmUnOyByZWFkb25seSBvcGVuOiBPcGVuQnJlYWs7IHJlYWRvbmx5IHZlcmRpY3Q6IEludmFyaWFudFZlcmRpY3QgfTtcblxuLyoqXG4gKiBEaWZmIHRoaXMgcnVuJ3MgdmVyZGljdHMgYWdhaW5zdCB0aGUgb3BlbiBicmVha3MuIEEgYnJlYWsgaXMgb25seSBSRVNPTFZFRCBieVxuICogYW4gYG9rYCB2ZXJkaWN0OiBhbiBpbnZhcmlhbnQgdGhhdCBjb3VsZCBub3QgYmUgZXZhbHVhdGVkIGtlZXBzIGl0cyBicmVhayBvcGVuLFxuICogYmVjYXVzZSBub3RoaW5nIGhhcyBzaG93biB0aGUgbW9uZXkgaXMgcmlnaHQgYWdhaW4uXG4gKlxuICogQSBicmVhayBvcGVuZWQgYnkgYSBGSU5BTCBydW4gY29uY2VybnMgYSBjbG9zZWQgbW9udGgsIHdoaWNoIGEgcHJvdmlzaW9uYWwgcnVuXG4gKiAob3ZlciB0aGUgb3BlbiBtb250aCkgbmV2ZXIgbG9va3MgYXQuIE9ubHkgYSBmaW5hbCBydW4gY2FuIHJlc29sdmUgaXQ7IGFcbiAqIHByb3Zpc2lvbmFsIHJ1biBsZWF2ZXMgaXQgb3BlbiBhbmQgdW50b3VjaGVkLCBzbyBpdHMgZGV0YWlsIGtlZXBzIHRoZSBldmlkZW5jZS5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHBsYW5CcmVha0FjdGlvbnMoXG4gIHZlcmRpY3RzOiByZWFkb25seSBJbnZhcmlhbnRWZXJkaWN0W10sXG4gIG9wZW46IHJlYWRvbmx5IE9wZW5CcmVha1tdLFxuICBtb2RlOiBSZWNvbmNpbGlhdGlvbk1vZGUgPSAncHJvdmlzaW9uYWwnLFxuKTogQnJlYWtBY3Rpb25bXSB7XG4gIGNvbnN0IG9wZW5CeUludmFyaWFudCA9IG5ldyBNYXAob3Blbi5tYXAoKGIpID0+IFtiLmludmFyaWFudCwgYl0pKTtcbiAgY29uc3QgYWN0aW9uczogQnJlYWtBY3Rpb25bXSA9IFtdO1xuICBmb3IgKGNvbnN0IHZlcmRpY3Qgb2YgdmVyZGljdHMpIHtcbiAgICBjb25zdCBleGlzdGluZyA9IG9wZW5CeUludmFyaWFudC5nZXQodmVyZGljdC5pbnZhcmlhbnQpO1xuICAgIGNvbnN0IGNsb3NlZE1vbnRoQnJlYWsgPSBleGlzdGluZz8ub3BlbmVkTW9kZSA9PT0gJ2ZpbmFsJyAmJiBtb2RlICE9PSAnZmluYWwnO1xuICAgIGlmICh2ZXJkaWN0LnN0YXR1cyA9PT0gJ2Jyb2tlbicpIHtcbiAgICAgIGlmICghZXhpc3RpbmcpIGFjdGlvbnMucHVzaCh7IGtpbmQ6ICdvcGVuJywgdmVyZGljdCB9KTtcbiAgICAgIGVsc2UgaWYgKCFjbG9zZWRNb250aEJyZWFrKSBhY3Rpb25zLnB1c2goeyBraW5kOiAna2VlcCcsIG9wZW46IGV4aXN0aW5nLCB2ZXJkaWN0IH0pO1xuICAgIH0gZWxzZSBpZiAoY2xvc2VkTW9udGhCcmVhaykgY29udGludWU7XG4gICAgZWxzZSBpZiAoZXhpc3RpbmcgJiYgdmVyZGljdC5zdGF0dXMgPT09ICdvaycpIGFjdGlvbnMucHVzaCh7IGtpbmQ6ICdyZXNvbHZlJywgb3BlbjogZXhpc3RpbmcsIHZlcmRpY3QgfSk7XG4gICAgZWxzZSBpZiAoZXhpc3RpbmcpIGFjdGlvbnMucHVzaCh7IGtpbmQ6ICdrZWVwJywgb3BlbjogZXhpc3RpbmcsIHZlcmRpY3QgfSk7XG4gIH1cbiAgcmV0dXJuIGFjdGlvbnM7XG59XG5cbmV4cG9ydCBpbnRlcmZhY2UgVHJhbnNmZXJHYXRlIHtcbiAgcmVhZG9ubHkgb3BlbjogYm9vbGVhbjtcbiAgLyoqIEVtcHR5IHdoZW4gb3Blbjsgb3RoZXJ3aXNlIHdoeSB0cmFuc2ZlcnMgYXJlIHBhdXNlZC4gKi9cbiAgcmVhZG9ubHkgcmVhc29uczogcmVhZG9ubHkgc3RyaW5nW107XG59XG5cbi8qKiBEQU8gdHJhbnNmZXJzIHJ1biBvbmx5IHdoaWxlIG5vIGJyZWFrIGlzIG9wZW4gYW5kIGV2ZXJ5IG1hbmRhdGVkIGludmFyaWFudCBjb3VsZCBiZSBldmFsdWF0ZWQuICovXG5leHBvcnQgZnVuY3Rpb24gdHJhbnNmZXJHYXRlKHZlcmRpY3RzOiByZWFkb25seSBJbnZhcmlhbnRWZXJkaWN0W10sIG9wZW5BZnRlclJ1bjogcmVhZG9ubHkgUmVjb25jaWxpYXRpb25JbnZhcmlhbnRbXSk6IFRyYW5zZmVyR2F0ZSB7XG4gIGNvbnN0IHJlYXNvbnM6IHN0cmluZ1tdID0gW107XG4gIGZvciAoY29uc3QgaW52YXJpYW50IG9mIG9wZW5BZnRlclJ1bikgcmVhc29ucy5wdXNoKGBicmVhayBvcGVuOiAke2ludmFyaWFudH1gKTtcbiAgZm9yIChjb25zdCB2IG9mIHZlcmRpY3RzKSB7XG4gICAgaWYgKHYuc3RhdHVzID09PSAndW5rbm93bicgJiYgKE1BTkRBVEVEX0lOVkFSSUFOVFMgYXMgcmVhZG9ubHkgc3RyaW5nW10pLmluY2x1ZGVzKHYuaW52YXJpYW50KSkge1xuICAgICAgcmVhc29ucy5wdXNoKGBjYW5ub3QgZXZhbHVhdGUgJHt2LmludmFyaWFudH06ICR7di5kZXRhaWx9YCk7XG4gICAgfVxuICB9XG4gIHJldHVybiB7IG9wZW46IHJlYXNvbnMubGVuZ3RoID09PSAwLCByZWFzb25zIH07XG59XG5cbi8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuLy8gT25lIHJ1biwgZW5kIHRvIGVuZCwgb3ZlciBpbmplY3RlZCBkZXBlbmRlbmNpZXMuXG4vLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cblxuZXhwb3J0IGludGVyZmFjZSBSZWNvbmNpbGlhdGlvblN0b3JlIHtcbiAgbGlzdE9wZW5CcmVha3Mod29ya3NwYWNlSWQ6IHN0cmluZyk6IFByb21pc2U8T3BlbkJyZWFrW10+O1xuICAvKiogSW5zZXJ0IHRoZSBvcGVuIHJvdzsgcmVzb2x2ZXMgYGZhbHNlYCB3aGVuIGEgY29uY3VycmVudCBydW4gYWxyZWFkeSBvcGVuZWQgdGhpcyBpbnZhcmlhbnQuICovXG4gIG9wZW5CcmVhayh3b3Jrc3BhY2VJZDogc3RyaW5nLCBiOiBPcGVuQnJlYWssIGRldGFpbDogc3RyaW5nKTogUHJvbWlzZTxib29sZWFuPjtcbiAgc2V0QnJlYWtXb3JrSXRlbSh3b3Jrc3BhY2VJZDogc3RyaW5nLCBpbnZhcmlhbnQ6IFJlY29uY2lsaWF0aW9uSW52YXJpYW50LCB3b3JrSXRlbUlkOiBzdHJpbmcpOiBQcm9taXNlPHZvaWQ+O1xuICB0b3VjaEJyZWFrKHdvcmtzcGFjZUlkOiBzdHJpbmcsIGludmFyaWFudDogUmVjb25jaWxpYXRpb25JbnZhcmlhbnQsIHJ1bklkOiBzdHJpbmcsIGRldGFpbDogc3RyaW5nKTogUHJvbWlzZTx2b2lkPjtcbiAgcmVzb2x2ZUJyZWFrKHdvcmtzcGFjZUlkOiBzdHJpbmcsIGludmFyaWFudDogUmVjb25jaWxpYXRpb25JbnZhcmlhbnQsIHJ1bklkOiBzdHJpbmcsIGF0TXM6IG51bWJlcik6IFByb21pc2U8dm9pZD47XG4gIHJlY29yZFJ1bihydW46IFJlY29uY2lsaWF0aW9uUnVuUmVjb3JkKTogUHJvbWlzZTx2b2lkPjtcbn1cblxuZXhwb3J0IGludGVyZmFjZSBCcmVha0ZpbGVyIHtcbiAgLyoqIEZpbGUgdGhlIHdvcmsgaXRlbSBmb3IgYSBORVcgYnJlYWs7IHJldHVybnMgaXRzIGlkLiAqL1xuICBmaWxlQnJlYWsoaW5wdXQ6IHsgd29ya3NwYWNlSWQ6IHN0cmluZzsgdmVyZGljdDogSW52YXJpYW50VmVyZGljdDsgcGVyaW9kOiBSZWNvbmNpbGlhdGlvblBlcmlvZDsgcnVuSWQ6IHN0cmluZyB9KTogUHJvbWlzZTxzdHJpbmc+O1xuICAvKiogTm90ZSBvbiB0aGUgZXhpc3RpbmcgaXRlbSB0aGF0IHRoZSBpbnZhcmlhbnQgaG9sZHMgYWdhaW4uICovXG4gIG5vdGVSZXNvbHZlZChpbnB1dDogeyB3b3Jrc3BhY2VJZDogc3RyaW5nOyB3b3JrSXRlbUlkOiBzdHJpbmc7IHZlcmRpY3Q6IEludmFyaWFudFZlcmRpY3Q7IHJ1bklkOiBzdHJpbmcgfSk6IFByb21pc2U8dm9pZD47XG59XG5cbmV4cG9ydCB0eXBlIEdhdGVQdWJsaXNoUmVzdWx0ID0geyByZWFkb25seSBwdWJsaXNoZWQ6IHRydWUgfSB8IHsgcmVhZG9ubHkgcHVibGlzaGVkOiBmYWxzZTsgcmVhZG9ubHkgZGV0YWlsOiBzdHJpbmcgfTtcblxuZXhwb3J0IGludGVyZmFjZSBHYXRlUHVibGlzaGVyIHtcbiAgcHVibGlzaChpbnB1dDogeyB3b3Jrc3BhY2VJZDogc3RyaW5nOyBnYXRlOiBUcmFuc2ZlckdhdGU7IHJ1bklkOiBzdHJpbmc7IGF0TXM6IG51bWJlciB9KTogUHJvbWlzZTxHYXRlUHVibGlzaFJlc3VsdD47XG59XG5cbmV4cG9ydCBpbnRlcmZhY2UgUmVjb25jaWxpYXRpb25SdW5SZWNvcmQge1xuICByZWFkb25seSBydW5JZDogc3RyaW5nO1xuICByZWFkb25seSB3b3Jrc3BhY2VJZDogc3RyaW5nO1xuICByZWFkb25seSBwZXJpb2Q6IFJlY29uY2lsaWF0aW9uUGVyaW9kO1xuICByZWFkb25seSBzdGFydGVkQXRNczogbnVtYmVyO1xuICByZWFkb25seSBmaW5pc2hlZEF0TXM6IG51bWJlcjtcbiAgcmVhZG9ubHkgdmVyZGljdHM6IHJlYWRvbmx5IEludmFyaWFudFZlcmRpY3RbXTtcbiAgcmVhZG9ubHkgb3BlbmVkOiByZWFkb25seSBSZWNvbmNpbGlhdGlvbkludmFyaWFudFtdO1xuICByZWFkb25seSByZXNvbHZlZDogcmVhZG9ubHkgUmVjb25jaWxpYXRpb25JbnZhcmlhbnRbXTtcbiAgcmVhZG9ubHkgZ2F0ZTogVHJhbnNmZXJHYXRlO1xuICByZWFkb25seSBnYXRlUHVibGlzaDogR2F0ZVB1Ymxpc2hSZXN1bHQ7XG59XG5cbmV4cG9ydCBpbnRlcmZhY2UgUmVjb25jaWxpYXRpb25EZXBzIHtcbiAgcmVhZG9ubHkgc3RvcmU6IFJlY29uY2lsaWF0aW9uU3RvcmU7XG4gIHJlYWRvbmx5IGZpbGVyOiBCcmVha0ZpbGVyO1xuICByZWFkb25seSBnYXRlOiBHYXRlUHVibGlzaGVyO1xuICByZWFkb25seSBub3c6ICgpID0+IG51bWJlcjtcbiAgcmVhZG9ubHkgbmV3UnVuSWQ6ICgpID0+IHN0cmluZztcbn1cblxuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIHJ1blJlY29uY2lsaWF0aW9uKFxuICBpbnB1dDoge1xuICAgIHJlYWRvbmx5IHdvcmtzcGFjZUlkOiBzdHJpbmc7XG4gICAgcmVhZG9ubHkgbW9kZTogUmVjb25jaWxpYXRpb25Nb2RlO1xuICAgIHJlYWRvbmx5IGVudHJpZXM6IHJlYWRvbmx5IEpvdXJuYWxFbnRyeVtdO1xuICAgIHJlYWRvbmx5IHNvdXJjZXM6IFJlY29uY2lsaWF0aW9uU291cmNlcztcbiAgICByZWFkb25seSBzdGFydGVkQXRNcz86IG51bWJlcjtcbiAgfSxcbiAgZGVwczogUmVjb25jaWxpYXRpb25EZXBzLFxuKTogUHJvbWlzZTxSZWNvbmNpbGlhdGlvblJ1blJlY29yZD4ge1xuICBjb25zdCBzdGFydGVkQXRNcyA9IGlucHV0LnN0YXJ0ZWRBdE1zID8/IGRlcHMubm93KCk7XG4gIGNvbnN0IHJ1bklkID0gZGVwcy5uZXdSdW5JZCgpO1xuICBjb25zdCBwZXJpb2QgPSByZWNvbmNpbGlhdGlvblBlcmlvZChpbnB1dC5tb2RlLCBzdGFydGVkQXRNcyk7XG4gIGNvbnN0IHZlcmRpY3RzID0gZXZhbHVhdGVSZWNvbmNpbGlhdGlvbih7IGVudHJpZXM6IGlucHV0LmVudHJpZXMsIHNvdXJjZXM6IGlucHV0LnNvdXJjZXMsIHBlcmlvZCB9KTtcbiAgY29uc3Qgb3BlbiA9IGF3YWl0IGRlcHMuc3RvcmUubGlzdE9wZW5CcmVha3MoaW5wdXQud29ya3NwYWNlSWQpO1xuICBjb25zdCBhY3Rpb25zID0gcGxhbkJyZWFrQWN0aW9ucyh2ZXJkaWN0cywgb3BlbiwgaW5wdXQubW9kZSk7XG4gIGNvbnN0IG9wZW5lZDogUmVjb25jaWxpYXRpb25JbnZhcmlhbnRbXSA9IFtdO1xuICBjb25zdCByZXNvbHZlZDogUmVjb25jaWxpYXRpb25JbnZhcmlhbnRbXSA9IFtdO1xuICBjb25zdCBzdGlsbE9wZW4gPSBuZXcgU2V0KG9wZW4ubWFwKChiKSA9PiBiLmludmFyaWFudCkpO1xuXG4gIGZvciAoY29uc3QgYWN0aW9uIG9mIGFjdGlvbnMpIHtcbiAgICBjb25zdCBpbnZhcmlhbnQgPSBhY3Rpb24udmVyZGljdC5pbnZhcmlhbnQ7XG4gICAgaWYgKGFjdGlvbi5raW5kID09PSAnb3BlbicpIHtcbiAgICAgIGNvbnN0IHJvdzogT3BlbkJyZWFrID0geyBpbnZhcmlhbnQsIHdvcmtJdGVtSWQ6IG51bGwsIG9wZW5lZEF0TXM6IHN0YXJ0ZWRBdE1zLCBvcGVuZWRCeVJ1bklkOiBydW5JZCwgb3BlbmVkTW9kZTogaW5wdXQubW9kZSB9O1xuICAgICAgc3RpbGxPcGVuLmFkZChpbnZhcmlhbnQpO1xuICAgICAgLy8gVGhlIHJvdyBpcyB3cml0dGVuIEJFRk9SRSB0aGUgaXRlbSBpcyBmaWxlZCwgc28gYSBjb25jdXJyZW50IHJ1biBsb3NlcyB0aGVcbiAgICAgIC8vIGluc2VydCBhbmQgZmlsZXMgbm90aGluZzogb25lIGJyZWFrLCBvbmUgaXRlbS5cbiAgICAgIGlmICghKGF3YWl0IGRlcHMuc3RvcmUub3BlbkJyZWFrKGlucHV0LndvcmtzcGFjZUlkLCByb3csIGFjdGlvbi52ZXJkaWN0LmRldGFpbCkpKSBjb250aW51ZTtcbiAgICAgIG9wZW5lZC5wdXNoKGludmFyaWFudCk7XG4gICAgICBjb25zdCB3b3JrSXRlbUlkID0gYXdhaXQgZGVwcy5maWxlci5maWxlQnJlYWsoeyB3b3Jrc3BhY2VJZDogaW5wdXQud29ya3NwYWNlSWQsIHZlcmRpY3Q6IGFjdGlvbi52ZXJkaWN0LCBwZXJpb2QsIHJ1bklkIH0pO1xuICAgICAgYXdhaXQgZGVwcy5zdG9yZS5zZXRCcmVha1dvcmtJdGVtKGlucHV0LndvcmtzcGFjZUlkLCBpbnZhcmlhbnQsIHdvcmtJdGVtSWQpO1xuICAgIH0gZWxzZSBpZiAoYWN0aW9uLmtpbmQgPT09ICdrZWVwJykge1xuICAgICAgYXdhaXQgZGVwcy5zdG9yZS50b3VjaEJyZWFrKGlucHV0LndvcmtzcGFjZUlkLCBpbnZhcmlhbnQsIHJ1bklkLCBhY3Rpb24udmVyZGljdC5kZXRhaWwpO1xuICAgICAgLy8gVGhlIG9wZW5pbmcgcnVuIGluc2VydGVkIHRoZSByb3cgYnV0IGZhaWxlZCBiZWZvcmUgaXRzIGl0ZW0gd2FzIGZpbGVkICh0aGVcbiAgICAgIC8vIGZpbGVyIHRocmV3LCBvciB0aGUgcHJvY2VzcyBkaWVkKTogZmlsZSBpdCBub3csIG9yIHRoZSBicmVhayBzdGF5cyBpbnZpc2libGUuXG4gICAgICBpZiAoIWFjdGlvbi5vcGVuLndvcmtJdGVtSWQpIHtcbiAgICAgICAgY29uc3Qgd29ya0l0ZW1JZCA9IGF3YWl0IGRlcHMuZmlsZXIuZmlsZUJyZWFrKHsgd29ya3NwYWNlSWQ6IGlucHV0LndvcmtzcGFjZUlkLCB2ZXJkaWN0OiBhY3Rpb24udmVyZGljdCwgcGVyaW9kLCBydW5JZCB9KTtcbiAgICAgICAgYXdhaXQgZGVwcy5zdG9yZS5zZXRCcmVha1dvcmtJdGVtKGlucHV0LndvcmtzcGFjZUlkLCBpbnZhcmlhbnQsIHdvcmtJdGVtSWQpO1xuICAgICAgfVxuICAgIH0gZWxzZSB7XG4gICAgICBhd2FpdCBkZXBzLnN0b3JlLnJlc29sdmVCcmVhayhpbnB1dC53b3Jrc3BhY2VJZCwgaW52YXJpYW50LCBydW5JZCwgc3RhcnRlZEF0TXMpO1xuICAgICAgc3RpbGxPcGVuLmRlbGV0ZShpbnZhcmlhbnQpO1xuICAgICAgcmVzb2x2ZWQucHVzaChpbnZhcmlhbnQpO1xuICAgICAgaWYgKGFjdGlvbi5vcGVuLndvcmtJdGVtSWQpIHtcbiAgICAgICAgYXdhaXQgZGVwcy5maWxlci5ub3RlUmVzb2x2ZWQoeyB3b3Jrc3BhY2VJZDogaW5wdXQud29ya3NwYWNlSWQsIHdvcmtJdGVtSWQ6IGFjdGlvbi5vcGVuLndvcmtJdGVtSWQsIHZlcmRpY3Q6IGFjdGlvbi52ZXJkaWN0LCBydW5JZCB9KTtcbiAgICAgIH1cbiAgICB9XG4gIH1cblxuICBjb25zdCBnYXRlID0gdHJhbnNmZXJHYXRlKHZlcmRpY3RzLCBbLi4uc3RpbGxPcGVuXSk7XG4gIGNvbnN0IGdhdGVQdWJsaXNoID0gYXdhaXQgZGVwcy5nYXRlLnB1Ymxpc2goeyB3b3Jrc3BhY2VJZDogaW5wdXQud29ya3NwYWNlSWQsIGdhdGUsIHJ1bklkLCBhdE1zOiBzdGFydGVkQXRNcyB9KTtcbiAgY29uc3QgcmVjb3JkOiBSZWNvbmNpbGlhdGlvblJ1blJlY29yZCA9IHtcbiAgICBydW5JZCxcbiAgICB3b3Jrc3BhY2VJZDogaW5wdXQud29ya3NwYWNlSWQsXG4gICAgcGVyaW9kLFxuICAgIHN0YXJ0ZWRBdE1zLFxuICAgIGZpbmlzaGVkQXRNczogZGVwcy5ub3coKSxcbiAgICB2ZXJkaWN0cyxcbiAgICBvcGVuZWQsXG4gICAgcmVzb2x2ZWQsXG4gICAgZ2F0ZSxcbiAgICBnYXRlUHVibGlzaCxcbiAgfTtcbiAgYXdhaXQgZGVwcy5zdG9yZS5yZWNvcmRSdW4ocmVjb3JkKTtcbiAgcmV0dXJuIHJlY29yZDtcbn1cblxuLyoqIEFuIGluLW1lbW9yeSBzdG9yZSB3aXRoIHRoZSBQRyBzdG9yZSdzIHNlbWFudGljcywgZm9yIHRlc3RzIGFuZCBkcnkgcnVucy4gKi9cbmV4cG9ydCBmdW5jdGlvbiBtZW1vcnlSZWNvbmNpbGlhdGlvblN0b3JlKCk6IFJlY29uY2lsaWF0aW9uU3RvcmUgJiB7XG4gIHJlYWRvbmx5IHJ1bnM6IFJlY29uY2lsaWF0aW9uUnVuUmVjb3JkW107XG4gIHJlYWRvbmx5IHJvd3M6IE1hcDxzdHJpbmcsIE9wZW5CcmVhayAmIHsgZGV0YWlsOiBzdHJpbmc7IGxhc3RSdW5JZDogc3RyaW5nOyByZXNvbHZlZEF0TXM6IG51bWJlciB8IG51bGwgfT47XG59IHtcbiAgY29uc3Qgcm93cyA9IG5ldyBNYXA8c3RyaW5nLCBPcGVuQnJlYWsgJiB7IGRldGFpbDogc3RyaW5nOyBsYXN0UnVuSWQ6IHN0cmluZzsgcmVzb2x2ZWRBdE1zOiBudW1iZXIgfCBudWxsIH0+KCk7XG4gIGNvbnN0IHJ1bnM6IFJlY29uY2lsaWF0aW9uUnVuUmVjb3JkW10gPSBbXTtcbiAgY29uc3Qga2V5ID0gKHdzOiBzdHJpbmcsIGludjogc3RyaW5nKSA9PiBgJHt3c31cXHUwMDAwJHtpbnZ9YDtcbiAgcmV0dXJuIHtcbiAgICByb3dzLFxuICAgIHJ1bnMsXG4gICAgYXN5bmMgbGlzdE9wZW5CcmVha3Mod3MpIHtcbiAgICAgIHJldHVybiBbLi4ucm93cy5lbnRyaWVzKCldXG4gICAgICAgIC5maWx0ZXIoKFtrLCByXSkgPT4gay5zdGFydHNXaXRoKGAke3dzfVxcdTAwMDBgKSAmJiByLnJlc29sdmVkQXRNcyA9PT0gbnVsbClcbiAgICAgICAgLm1hcCgoWywgcl0pID0+ICh7XG4gICAgICAgICAgaW52YXJpYW50OiByLmludmFyaWFudCxcbiAgICAgICAgICB3b3JrSXRlbUlkOiByLndvcmtJdGVtSWQsXG4gICAgICAgICAgb3BlbmVkQXRNczogci5vcGVuZWRBdE1zLFxuICAgICAgICAgIG9wZW5lZEJ5UnVuSWQ6IHIub3BlbmVkQnlSdW5JZCxcbiAgICAgICAgICAvLyBMaWtlIHRoZSBQRyBzdG9yZSwgdGhlIG1vZGUgaXMga25vd24gb25seSBvbmNlIHRoZSBvcGVuaW5nIHJ1biByZWNvcmRlZC5cbiAgICAgICAgICBvcGVuZWRNb2RlOiBydW5zLmZpbmQoKHJ1bikgPT4gcnVuLnJ1bklkID09PSByLm9wZW5lZEJ5UnVuSWQpPy5wZXJpb2QubW9kZSxcbiAgICAgICAgfSkpO1xuICAgIH0sXG4gICAgYXN5bmMgb3BlbkJyZWFrKHdzLCBiLCBkZXRhaWwpIHtcbiAgICAgIGNvbnN0IGV4aXN0aW5nID0gcm93cy5nZXQoa2V5KHdzLCBiLmludmFyaWFudCkpO1xuICAgICAgaWYgKGV4aXN0aW5nICYmIGV4aXN0aW5nLnJlc29sdmVkQXRNcyA9PT0gbnVsbCkgcmV0dXJuIGZhbHNlO1xuICAgICAgcm93cy5zZXQoa2V5KHdzLCBiLmludmFyaWFudCksIHsgLi4uYiwgZGV0YWlsLCBsYXN0UnVuSWQ6IGIub3BlbmVkQnlSdW5JZCwgcmVzb2x2ZWRBdE1zOiBudWxsIH0pO1xuICAgICAgcmV0dXJuIHRydWU7XG4gICAgfSxcbiAgICBhc3luYyBzZXRCcmVha1dvcmtJdGVtKHdzLCBpbnYsIGlkKSB7XG4gICAgICBjb25zdCByID0gcm93cy5nZXQoa2V5KHdzLCBpbnYpKTtcbiAgICAgIGlmIChyKSByb3dzLnNldChrZXkod3MsIGludiksIHsgLi4uciwgd29ya0l0ZW1JZDogaWQgfSk7XG4gICAgfSxcbiAgICBhc3luYyB0b3VjaEJyZWFrKHdzLCBpbnYsIHJ1bklkLCBkZXRhaWwpIHtcbiAgICAgIGNvbnN0IHIgPSByb3dzLmdldChrZXkod3MsIGludikpO1xuICAgICAgaWYgKHIpIHJvd3Muc2V0KGtleSh3cywgaW52KSwgeyAuLi5yLCBsYXN0UnVuSWQ6IHJ1bklkLCBkZXRhaWwgfSk7XG4gICAgfSxcbiAgICBhc3luYyByZXNvbHZlQnJlYWsod3MsIGludiwgcnVuSWQsIGF0TXMpIHtcbiAgICAgIGNvbnN0IHIgPSByb3dzLmdldChrZXkod3MsIGludikpO1xuICAgICAgaWYgKHIpIHJvd3Muc2V0KGtleSh3cywgaW52KSwgeyAuLi5yLCBsYXN0UnVuSWQ6IHJ1bklkLCByZXNvbHZlZEF0TXM6IGF0TXMgfSk7XG4gICAgfSxcbiAgICBhc3luYyByZWNvcmRSdW4ocnVuKSB7XG4gICAgICBydW5zLnB1c2gocnVuKTtcbiAgICB9LFxuICB9O1xufVxuIl0sImZpbGUiOiIvQGZzL2hvbWUvbWFyc2gtb2ZmaWNlL3BhcGVyY3VwYWktd29ya3NwYWNlL3BhcGVyY3VzcC9wYWNrYWdlcy9vcGVyYXRvci1jb3JlL2xpYi9jdXBib2FyZC9yZWNvbmNpbGlhdGlvbi50cyJ9

//# vitestCache=W3siZmlsZSI6IjEiLCJpZCI6IjEiLCJ1cmwiOiIyIiwiaW1wb3J0ZWRVcmxzIjoiMyIsIm1hcHBpbmdzIjpmYWxzZX0sIi9ob21lL21hcnNoLW9mZmljZS9wYXBlcmN1cGFpLXdvcmtzcGFjZS9wYXBlcmN1c3AvcGFja2FnZXMvb3BlcmF0b3ItY29yZS9saWIvY3VwYm9hcmQvcmVjb25jaWxpYXRpb24udHMiLCIvQGZzL2hvbWUvbWFyc2gtb2ZmaWNlL3BhcGVyY3VwYWktd29ya3NwYWNlL3BhcGVyY3VzcC9wYWNrYWdlcy9vcGVyYXRvci1jb3JlL2xpYi9jdXBib2FyZC9yZWNvbmNpbGlhdGlvbi50cyIsW11d