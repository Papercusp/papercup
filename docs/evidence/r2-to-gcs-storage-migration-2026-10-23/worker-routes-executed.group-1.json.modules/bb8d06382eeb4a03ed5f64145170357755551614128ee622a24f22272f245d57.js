__vite_ssr_exportName__("MONEY_JOURNAL_ACCOUNTS", () => { try { return MONEY_JOURNAL_ACCOUNTS } catch {} });
__vite_ssr_exportName__("ACCOUNT_NORMAL_SIDE", () => { try { return ACCOUNT_NORMAL_SIDE } catch {} });
__vite_ssr_exportName__("MICROS_PER_CENT", () => { try { return MICROS_PER_CENT } catch {} });
__vite_ssr_exportName__("EXTERNAL_REF_KINDS", () => { try { return EXTERNAL_REF_KINDS } catch {} });
__vite_ssr_exportName__("MOVEMENT_KINDS", () => { try { return MOVEMENT_KINDS } catch {} });
__vite_ssr_exportName__("MOVEMENT_REF_KINDS", () => { try { return MOVEMENT_REF_KINDS } catch {} });
__vite_ssr_exportName__("validateExternalRef", () => { try { return validateExternalRef } catch {} });
__vite_ssr_exportName__("externalRefKey", () => { try { return externalRefKey } catch {} });
__vite_ssr_exportName__("validateJournalEntry", () => { try { return validateJournalEntry } catch {} });
__vite_ssr_exportName__("entryTotalCents", () => { try { return entryTotalCents } catch {} });
__vite_ssr_exportName__("journalLinesForMovement", () => { try { return journalLinesForMovement } catch {} });
__vite_ssr_exportName__("journalEntryForMovement", () => { try { return journalEntryForMovement } catch {} });
__vite_ssr_exportName__("emptyMoneyJournal", () => { try { return emptyMoneyJournal } catch {} });
__vite_ssr_exportName__("postJournalEntry", () => { try { return postJournalEntry } catch {} });
__vite_ssr_exportName__("trialBalance", () => { try { return trialBalance } catch {} });
__vite_ssr_exportName__("parseMicrosDecimal", () => { try { return parseMicrosDecimal } catch {} });
__vite_ssr_exportName__("formatMicrosDecimal", () => { try { return formatMicrosDecimal } catch {} });
__vite_ssr_exportName__("addMicrosDecimals", () => { try { return addMicrosDecimals } catch {} });
__vite_ssr_exportName__("splitMicrosDecimal", () => { try { return splitMicrosDecimal } catch {} });
__vite_ssr_exportName__("emptyMicrosRollup", () => { try { return emptyMicrosRollup } catch {} });
__vite_ssr_exportName__("accrueMicros", () => { try { return accrueMicros } catch {} });
__vite_ssr_exportName__("daoShareCents", () => { try { return daoShareCents } catch {} });
__vite_ssr_exportName__("settleRollupIntoJournal", () => { try { return settleRollupIntoJournal } catch {} });
__vite_ssr_exportName__("rollupInvariant", () => { try { return rollupInvariant } catch {} });
const MONEY_JOURNAL_ACCOUNTS = [
  "operating",
  "customer-credit-reserve",
  "refund-chargeback-reserve",
  "tax-reserve",
  "dao-payable",
  "revenue",
  "provider-cost"
];
const ACCOUNT_NORMAL_SIDE = Object.freeze({
  operating: "debit",
  "customer-credit-reserve": "credit",
  "refund-chargeback-reserve": "credit",
  "tax-reserve": "credit",
  "dao-payable": "credit",
  revenue: "credit",
  "provider-cost": "debit"
});
const MICROS_PER_CENT = 1e4;
const EXTERNAL_REF_KINDS = ["stripe-balance-transaction", "bank-transaction", "chain-tx"];
const MOVEMENT_KINDS = [
  "customer-payment",
  "credit-purchase",
  "refund",
  "chargeback",
  "provider-payment",
  "dao-transfer",
  "tax-remittance",
  "usage-settlement"
];
const MOVEMENT_REF_KINDS = Object.freeze({
  "customer-payment": ["stripe-balance-transaction", "chain-tx"],
  "credit-purchase": ["stripe-balance-transaction", "chain-tx"],
  refund: ["stripe-balance-transaction", "chain-tx"],
  chargeback: ["stripe-balance-transaction"],
  "provider-payment": ["bank-transaction", "stripe-balance-transaction", "chain-tx"],
  "dao-transfer": ["chain-tx"],
  "tax-remittance": ["bank-transaction"],
  "usage-settlement": ["stripe-balance-transaction", "bank-transaction", "chain-tx"]
});
const reject = (code, detail) => ({ ok: false, code, detail });
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function isAccount(value) {
  return typeof value === "string" && MONEY_JOURNAL_ACCOUNTS.includes(value);
}
function isMovementKind(value) {
  return typeof value === "string" && MOVEMENT_KINDS.includes(value);
}
const STRIPE_BALANCE_TXN = /^txn_[A-Za-z0-9]{1,250}$/;
const CHAIN_TX_HASH = /^0x[0-9a-f]{64}$/;
const CURRENCY = /^[A-Z]{3}$/;
function validateExternalRef(raw) {
  if (raw === void 0 || raw === null) return reject("missing-external-reference", "an entry must carry the external reference of its movement");
  if (!isRecord(raw)) return reject("invalid-external-reference", "externalRef must be an object");
  switch (raw.kind) {
    case "stripe-balance-transaction":
      if (typeof raw.id !== "string" || !STRIPE_BALANCE_TXN.test(raw.id)) {
        return reject("invalid-external-reference", "a Stripe balance-transaction id looks like txn_…");
      };
      return { ok: true, ref: { kind: "stripe-balance-transaction", id: raw.id } };
    case "bank-transaction":
      if (typeof raw.id !== "string" || raw.id.trim().length === 0 || raw.id.length > 256 || raw.id !== raw.id.trim()) {
        return reject("invalid-external-reference", "a bank transaction id must be a non-empty trimmed string of at most 256 characters");
      };
      return { ok: true, ref: { kind: "bank-transaction", id: raw.id } };
    case "chain-tx":
      if (typeof raw.chainId !== "number" || !Number.isSafeInteger(raw.chainId) || raw.chainId <= 0) {
        return reject("invalid-external-reference", "chainId must be a positive integer (EIP-155)");
      };
      if (typeof raw.txHash !== "string" || !CHAIN_TX_HASH.test(raw.txHash)) {
        return reject("invalid-external-reference", "txHash must be 0x followed by 64 lowercase hex digits");
      };
      return { ok: true, ref: { kind: "chain-tx", chainId: raw.chainId, txHash: raw.txHash } };
    default:
      return reject("invalid-external-reference", `externalRef.kind must be one of ${EXTERNAL_REF_KINDS.join(", ")}`);
  }
};
function externalRefKey(ref) {
  return ref.kind === "chain-tx" ? `chain-tx:${ref.chainId}:${ref.txHash}` : `${ref.kind}:${ref.id}`;
};
function validateJournalEntry(raw) {
  if (!isRecord(raw)) return reject("invalid-entry", "entry must be an object");
  const { entryId, occurredAtMs, currency, movement, memo, rollupId, lines } = raw;
  if (typeof entryId !== "string" || entryId.length === 0 || entryId.length > 256) {
    return reject("invalid-entry", "entryId must be a string of 1-256 characters");
  };
  if (typeof occurredAtMs !== "number" || !Number.isSafeInteger(occurredAtMs) || occurredAtMs < 0) {
    return reject("invalid-entry", "occurredAtMs must be a non-negative integer");
  };
  if (typeof currency !== "string" || !CURRENCY.test(currency)) {
    return reject("invalid-entry", "currency must be an upper-case ISO-4217 code");
  };
  if (!isMovementKind(movement)) return reject("invalid-movement", `movement must be one of ${MOVEMENT_KINDS.join(", ")}`);
  if (memo !== void 0 && (typeof memo !== "string" || memo.length > 1e3)) {
    return reject("invalid-entry", "memo must be a string of at most 1000 characters");
  };
  if (rollupId !== void 0 && rollupId !== null && (typeof rollupId !== "string" || rollupId.length === 0 || rollupId.length > 256)) {
    return reject("invalid-entry", "rollupId must be null or a string of 1-256 characters");
  };
  const normalizedRollup = typeof rollupId === "string" ? rollupId : null;
  if (normalizedRollup !== null !== (movement === "usage-settlement")) {
    return reject("invalid-entry", "rollupId is required on a usage-settlement and forbidden on every other movement");
  };
  const ref = validateExternalRef(raw.externalRef);
  if (!ref.ok) return ref;
  if (!MOVEMENT_REF_KINDS[movement].includes(ref.ref.kind)) {
    return reject(
      "external-reference-kind-not-allowed",
      `a ${movement} is evidenced by ${MOVEMENT_REF_KINDS[movement].join(" or ")}, not ${ref.ref.kind}`
    );
  };
  if (!Array.isArray(lines)) return reject("invalid-entry", "lines must be an array");
  if (lines.length < 2) return reject("too-few-lines", "a double-entry posting needs at least one debit and one credit line");
  const normalized = [];
  let debits = 0;
  let credits = 0;
  for (const [index, line] of lines.entries()) {
    if (!isRecord(line)) return reject("invalid-entry", `line ${index} must be an object`);
    if ("micros" in line || line.unit === "micros") {
      return reject("micros-in-journal", `line ${index} carries micros; micros roll up outside the journal and only whole cents enter it`);
    };
    if (!isAccount(line.account)) return reject("unknown-account", `line ${index}: unknown account ${String(line.account)}`);
    if (line.side !== "debit" && line.side !== "credit") return reject("invalid-entry", `line ${index}: side must be debit or credit`);
    const cents = line.cents;
    if (typeof cents !== "number" || !Number.isFinite(cents)) return reject("invalid-entry", `line ${index}: cents must be a number`);
    if (!Number.isInteger(cents)) return reject("sub-cent-amount", `line ${index}: ${cents} is not a whole number of cents`);
    if (!Number.isSafeInteger(cents)) return reject("invalid-entry", `line ${index}: cents is outside the safe integer range`);
    if (cents <= 0) return reject("non-positive-amount", `line ${index}: amounts are positive; the side carries the direction`);
    if (line.side === "debit") debits += cents;
    else credits += cents;
    normalized.push({ account: line.account, side: line.side, cents });
  };
  if (!Number.isSafeInteger(debits) || !Number.isSafeInteger(credits)) {
    return reject("invalid-entry", "entry totals are outside the safe integer range");
  };
  if (debits !== credits) return reject("unbalanced", `debits ${debits} != credits ${credits}`);
  if (debits === 0) return reject("too-few-lines", "an entry needs at least one debit and one credit");
  return {
    ok: true,
    entry: {
      entryId,
      occurredAtMs,
      currency,
      movement,
      externalRef: ref.ref,
      rollupId: normalizedRollup,
      memo: typeof memo === "string" ? memo : "",
      lines: normalized
    }
  };
};
function entryTotalCents(entry) {
  return entry.lines.reduce((sum, line) => line.side === "debit" ? sum + line.cents : sum, 0);
};
function wholeCents(name, value, allowZero) {
  if (typeof value !== "number" || !Number.isFinite(value)) return reject("invalid-movement", `${name} must be a number`);
  if (!Number.isInteger(value)) return reject("sub-cent-amount", `${name} = ${value} is not a whole number of cents`);
  if (!Number.isSafeInteger(value)) return reject("invalid-movement", `${name} is outside the safe integer range`);
  if (value < 0 || !allowZero && value === 0) {
    return reject("invalid-movement", `${name} must be ${allowZero ? "zero or more" : "positive"}`);
  };
  return null;
}
function linesOf(parts) {
  return parts.filter(([, , cents]) => cents > 0).map(([account, side, cents]) => ({ account, side, cents }));
}
function journalLinesForMovement(movement) {
  switch (movement.kind) {
    case "customer-payment": {
      const { grossCents, feeCents, taxCents, daoCents, refundReserveCents } = movement;
      const bad = wholeCents("grossCents", grossCents, false) ?? wholeCents("feeCents", feeCents, true) ?? wholeCents("taxCents", taxCents, true) ?? wholeCents("daoCents", daoCents, true) ?? wholeCents("refundReserveCents", refundReserveCents, true);
      if (bad) return bad;
      if (feeCents > grossCents) return reject("invalid-movement", "the processing fee exceeds the gross payment");
      if (taxCents + daoCents + refundReserveCents > grossCents) {
        return reject("invalid-movement", "tax, the DAO share and the refund provision exceed the gross payment");
      };
      return {
        ok: true,
        lines: linesOf([
          ["operating", "debit", grossCents - feeCents],
          ["provider-cost", "debit", feeCents],
          ["tax-reserve", "credit", taxCents],
          ["dao-payable", "credit", daoCents],
          ["refund-chargeback-reserve", "credit", refundReserveCents],
          ["revenue", "credit", grossCents - taxCents - daoCents - refundReserveCents]
        ])
      };
    }
    case "credit-purchase": {
      const { grossCents, feeCents, taxCents } = movement;
      const bad = wholeCents("grossCents", grossCents, false) ?? wholeCents("feeCents", feeCents, true) ?? wholeCents("taxCents", taxCents, true);
      if (bad) return bad;
      if (feeCents > grossCents) return reject("invalid-movement", "the processing fee exceeds the gross payment");
      if (taxCents >= grossCents) return reject("invalid-movement", "tax must leave a positive credit amount");
      return {
        ok: true,
        lines: linesOf([
          ["operating", "debit", grossCents - feeCents],
          ["provider-cost", "debit", feeCents],
          ["tax-reserve", "credit", taxCents],
          ["customer-credit-reserve", "credit", grossCents - taxCents]
        ])
      };
    }
    case "refund": {
      const bad = wholeCents("amountCents", movement.amountCents, false) ?? wholeCents("taxCents", movement.taxCents, true);
      if (bad) return bad;
      if (movement.taxCents > movement.amountCents) return reject("invalid-movement", "refunded tax exceeds the refund");
      return {
        ok: true,
        lines: linesOf([
          ["refund-chargeback-reserve", "debit", movement.amountCents - movement.taxCents],
          ["tax-reserve", "debit", movement.taxCents],
          ["operating", "credit", movement.amountCents]
        ])
      };
    }
    case "chargeback": {
      const bad = wholeCents("amountCents", movement.amountCents, false) ?? wholeCents("feeCents", movement.feeCents, true);
      if (bad) return bad;
      return {
        ok: true,
        lines: linesOf([
          ["refund-chargeback-reserve", "debit", movement.amountCents],
          ["provider-cost", "debit", movement.feeCents],
          ["operating", "credit", movement.amountCents + movement.feeCents]
        ])
      };
    }
    case "provider-payment":
    case "dao-transfer":
    case "tax-remittance": {
      const bad = wholeCents("amountCents", movement.amountCents, false);
      if (bad) return bad;
      const debitAccount = movement.kind === "provider-payment" ? "provider-cost" : movement.kind === "dao-transfer" ? "dao-payable" : "tax-reserve";
      return {
        ok: true,
        lines: linesOf([
          [debitAccount, "debit", movement.amountCents],
          ["operating", "credit", movement.amountCents]
        ])
      };
    }
    case "usage-settlement": {
      const bad = wholeCents("cents", movement.cents, false) ?? wholeCents("daoCents", movement.daoCents, true);
      if (bad) return bad;
      if (movement.daoCents > movement.cents) return reject("invalid-movement", "the DAO share exceeds the settled cents");
      return {
        ok: true,
        lines: linesOf([
          ["customer-credit-reserve", "debit", movement.cents],
          ["dao-payable", "credit", movement.daoCents],
          ["revenue", "credit", movement.cents - movement.daoCents]
        ])
      };
    }
    default: {
      const unknownKind = movement;
      return reject("invalid-movement", `unknown movement ${JSON.stringify(unknownKind)}`);
    }
  }
};
function journalEntryForMovement(input) {
  const built = journalLinesForMovement(input.movement);
  if (!built.ok) return built;
  return validateJournalEntry({
    entryId: input.entryId,
    occurredAtMs: input.occurredAtMs,
    currency: input.currency,
    movement: input.movement.kind,
    externalRef: input.externalRef,
    memo: input.memo ?? "",
    rollupId: input.rollupId ?? null,
    lines: built.lines
  });
};
function zeroBalances() {
  return Object.fromEntries(MONEY_JOURNAL_ACCOUNTS.map((account) => [account, 0]));
}
function emptyMoneyJournal(currency = "USD") {
  if (!CURRENCY.test(currency)) throw new Error(`emptyMoneyJournal: invalid currency ${currency}`);
  return {
    currency,
    entries: [],
    entryIds: /* @__PURE__ */ new Set(),
    balancesCents: zeroBalances(),
    totalDebitCents: 0,
    totalCreditCents: 0,
    settledCentsByRollup: {}
  };
};
function postJournalEntry(state, raw) {
  const validated = validateJournalEntry(raw);
  if (!validated.ok) return validated;
  const entry = validated.entry;
  if (entry.currency !== state.currency) {
    return reject("currency-mismatch", `the journal is in ${state.currency}; the entry is in ${entry.currency}`);
  };
  if (state.entryIds.has(entry.entryId)) return reject("duplicate-entry", `entry ${entry.entryId} is already posted`);
  const balances = { ...state.balancesCents };
  let debit = state.totalDebitCents;
  let credit = state.totalCreditCents;
  for (const line of entry.lines) {
    if (line.side === "debit") {
      balances[line.account] += line.cents;
      debit += line.cents;
    } else {
      balances[line.account] -= line.cents;
      credit += line.cents;
    }
  };
  const settled = { ...state.settledCentsByRollup };
  if (entry.rollupId !== null) settled[entry.rollupId] = (settled[entry.rollupId] ?? 0) + entryTotalCents(entry);
  const entryIds = new Set(state.entryIds);
  entryIds.add(entry.entryId);
  return {
    ok: true,
    entry,
    state: {
      currency: state.currency,
      entries: [...state.entries, entry],
      entryIds,
      balancesCents: balances,
      totalDebitCents: debit,
      totalCreditCents: credit,
      settledCentsByRollup: settled
    }
  };
};
function trialBalance(entries, currency = "USD") {
  const debits = zeroBalances();
  const credits = zeroBalances();
  for (const entry of entries) {
    for (const line of entry.lines) {
      if (line.side === "debit") debits[line.account] += line.cents;
      else credits[line.account] += line.cents;
    }
  };
  const accounts = MONEY_JOURNAL_ACCOUNTS.map((account) => {
    const normalSide = ACCOUNT_NORMAL_SIDE[account];
    const net = debits[account] - credits[account];
    return {
      account,
      normalSide,
      debitCents: debits[account],
      creditCents: credits[account],
      balanceCents: normalSide === "debit" ? net : -net
    };
  });
  const debitCents = accounts.reduce((sum, a) => sum + a.debitCents, 0);
  const creditCents = accounts.reduce((sum, a) => sum + a.creditCents, 0);
  return { currency, debitCents, creditCents, balanced: debitCents === creditCents, accounts };
};
function parseMicrosDecimal(value) {
  if (typeof value !== "string" || !/^(?:0|[1-9][0-9]{0,31})(?:\.[0-9]{1,324})?$/.test(value)) {
    throw new Error("invalid exact micro amount");
  };
  const [whole, fraction = ""] = value.split(".");
  return { coefficient: BigInt(whole + fraction), scale: fraction.length };
};
function formatMicrosDecimal(coefficient, scale) {
  if (coefficient < 0n || !Number.isInteger(scale) || scale < 0 || scale > 324) throw new Error("invalid exact micro amount");
  const digits = coefficient.toString().padStart(scale + 1, "0");
  if (scale === 0) return digits;
  const fraction = digits.slice(-scale).replace(/0+$/, "");
  return digits.slice(0, -scale) + (fraction ? "." + fraction : "");
};
function addMicrosDecimals(...values) {
  const amounts = values.map(parseMicrosDecimal);
  const scale = Math.max(0, ...amounts.map((a) => a.scale));
  return formatMicrosDecimal(amounts.reduce((sum, a) => sum + a.coefficient * 10n ** BigInt(scale - a.scale), 0n), scale);
};
function splitMicrosDecimal(value) {
  const { coefficient, scale } = parseMicrosDecimal(value);
  const divisor = 10n ** BigInt(scale);
  if (coefficient > BigInt(Number.MAX_SAFE_INTEGER) * divisor) throw new Error("micro amount exceeds safe integer range");
  return { micros: Number(coefficient / divisor), exact: formatMicrosDecimal(coefficient, scale) };
};
function emptyMicrosRollup(rollupId, currency = "USD") {
  if (rollupId.length === 0 || rollupId.length > 256) throw new Error("emptyMicrosRollup: rollupId must be 1-256 characters");
  if (!CURRENCY.test(currency)) throw new Error(`emptyMicrosRollup: invalid currency ${currency}`);
  return { rollupId, currency, totalMicros: 0, settledCents: 0, roundingMicros: 0, accrualIds: /* @__PURE__ */ new Set() };
};
function accrueMicros(rollup, input) {
  if (typeof input.accrualId !== "string" || input.accrualId.length === 0 || input.accrualId.length > 256) {
    return { ok: false, code: "invalid-rollup", detail: "accrualId must be a string of 1-256 characters" };
  };
  let amount;
  try {
    amount = splitMicrosDecimal(input.microsExact ?? String(input.micros));
  } catch {
    return { ok: false, code: "invalid-micros", detail: "invalid exact micro amount" };
  };
  if (!Number.isSafeInteger(input.micros) || amount.micros !== input.micros || amount.exact === "0" || input.microsExact !== void 0 && amount.exact !== input.microsExact) {
    return { ok: false, code: "invalid-micros", detail: `micros must be a positive whole number, got ${String(input.micros)}` };
  };
  if (rollup.accrualIds.has(input.accrualId)) {
    const previous = rollup.accrualAmounts?.get(input.accrualId);
    if (previous !== void 0 && previous !== amount.exact) return { ok: false, code: "invalid-micros", detail: "accrual replay mismatch" };
    return { ok: true, rollup, duplicate: true };
  };
  let total;
  let rounding;
  try {
    total = splitMicrosDecimal(addMicrosDecimals(rollup.totalMicrosExact ?? String(rollup.totalMicros), amount.exact));
    rounding = splitMicrosDecimal(addMicrosDecimals(rollup.roundingMicrosExact ?? String(rollup.roundingMicros), amount.exact));
  } catch {
    return { ok: false, code: "invalid-micros", detail: "roll-up total exceeds the safe integer range" };
  };
  const accrualIds = new Set(rollup.accrualIds);
  accrualIds.add(input.accrualId);
  const accrualAmounts = new Map(rollup.accrualAmounts);
  accrualAmounts.set(input.accrualId, amount.exact);
  return {
    ok: true,
    duplicate: false,
    rollup: {
      ...rollup,
      totalMicros: total.micros,
      roundingMicros: rounding.micros,
      totalMicrosExact: total.exact.includes(".") ? total.exact : void 0,
      roundingMicrosExact: rounding.exact.includes(".") ? rounding.exact : void 0,
      accrualIds,
      accrualAmounts
    }
  };
};
function daoShareCents(cents, daoBasisPoints) {
  if (!Number.isSafeInteger(daoBasisPoints) || daoBasisPoints < 0 || daoBasisPoints > 1e4) {
    throw new Error(`daoShareCents: basis points must be 0-10000, got ${daoBasisPoints}`);
  };
  return Math.floor(cents * daoBasisPoints / 1e4);
};
function settleRollupIntoJournal(journal, rollup, input) {
  if (rollup.currency !== journal.currency) {
    return { ok: false, code: "currency-mismatch", detail: `roll-up is in ${rollup.currency}; the journal is in ${journal.currency}` };
  };
  const cents = Math.floor(rollup.roundingMicros / MICROS_PER_CENT);
  if (cents === 0) return { ok: true, journal, rollup, settledCents: 0, entry: null };
  const built = journalEntryForMovement({
    entryId: input.entryId,
    occurredAtMs: input.occurredAtMs,
    currency: journal.currency,
    externalRef: input.externalRef,
    memo: input.memo ?? "",
    rollupId: rollup.rollupId,
    movement: { kind: "usage-settlement", cents, daoCents: daoShareCents(cents, input.daoBasisPoints) }
  });
  if (!built.ok) return built;
  const posted = postJournalEntry(journal, built.entry);
  if (!posted.ok) return posted;
  return {
    ok: true,
    journal: posted.state,
    entry: posted.entry,
    settledCents: cents,
    rollup: {
      ...rollup,
      settledCents: rollup.settledCents + cents,
      roundingMicros: rollup.roundingMicros - cents * MICROS_PER_CENT,
      roundingMicrosExact: rollup.roundingMicrosExact === void 0 ? void 0 : formatMicrosDecimal(
        parseMicrosDecimal(rollup.roundingMicrosExact).coefficient - BigInt(cents * MICROS_PER_CENT) * 10n ** BigInt(parseMicrosDecimal(rollup.roundingMicrosExact).scale),
        parseMicrosDecimal(rollup.roundingMicrosExact).scale
      )
    }
  };
};
function rollupInvariant(entries, rollup) {
  const journalCents = entries.filter((entry) => entry.rollupId === rollup.rollupId).reduce((sum, entry) => sum + entryTotalCents(entry), 0);
  let exactHolds = false;
  try {
    const total = splitMicrosDecimal(rollup.totalMicrosExact ?? String(rollup.totalMicros));
    const rounding = splitMicrosDecimal(rollup.roundingMicrosExact ?? String(rollup.roundingMicros));
    exactHolds = total.micros === rollup.totalMicros && rounding.micros === rollup.roundingMicros && addMicrosDecimals(String(journalCents * MICROS_PER_CENT), rounding.exact) === total.exact;
  } catch {
  };
  return {
    rollupId: rollup.rollupId,
    totalMicros: rollup.totalMicros,
    journalCents,
    roundingMicros: rollup.roundingMicros,
    totalMicrosExact: rollup.totalMicrosExact,
    roundingMicrosExact: rollup.roundingMicrosExact,
    holds: journalCents * MICROS_PER_CENT + rollup.roundingMicros === rollup.totalMicros && journalCents === rollup.settledCents && rollup.roundingMicros >= 0 && exactHolds
  };
}
//# sourceMappingSource=vite-generated
//# sourceMappingURL=data:application/json;base64,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LEVBQTBFO0FBQ2xGLFNBQU87QUFBQSxJQUNMLFVBQVUsT0FBTztBQUFBLElBQ2pCLGFBQWEsT0FBTztBQUFBLElBQ3BCO0FBQUEsSUFDQSxnQkFBZ0IsT0FBTztBQUFBLElBQ3ZCLGtCQUFrQixPQUFPO0FBQUEsSUFDekIscUJBQXFCLE9BQU87QUFBQSxJQUM1QixPQUNFLGVBQWUsa0JBQWtCLE9BQU8sbUJBQW1CLE9BQU8sZUFDbEUsaUJBQWlCLE9BQU8sZ0JBQ3hCLE9BQU8sa0JBQWtCLEtBQUs7QUFBQSxFQUNsQztBQUNGIiwibmFtZXMiOltdLCJpZ25vcmVMaXN0IjpbXSwic291cmNlcyI6WyJtb25leS1qb3VybmFsLnRzIl0sInNvdXJjZXNDb250ZW50IjpbIi8qKlxuICogRG91YmxlLWVudHJ5IG1vbmV5IGpvdXJuYWwgKGFnZW50LWVjb25vbXktZmx5d2hlZWwtMjAyNi0wOC0zMCBQLTA0MiwgUi0zMCkuXG4gKlxuICogRXZlcnkgbW9uZXkgbW92ZW1lbnQgYmVjb21lcyBPTkUgYmFsYW5jZWQgam91cm5hbCBlbnRyeTogZGViaXRzIGVxdWFsXG4gKiBjcmVkaXRzLCBldmVyeSBhbW91bnQgaXMgYW4gZXhhY3Qgd2hvbGUgbnVtYmVyIG9mIGNlbnRzLCBhbmQgdGhlIGVudHJ5XG4gKiBjYXJyaWVzIHRoZSBleHRlcm5hbCByZWZlcmVuY2Ugb2YgdGhlIG1vdmVtZW50IGl0IHJlY29yZHMgKGEgU3RyaXBlXG4gKiBiYWxhbmNlLXRyYW5zYWN0aW9uIGlkLCBhIGJhbmsgdHJhbnNhY3Rpb24gaWQsIG9yIGEgY2hhaW4gdHggaGFzaCkuIFRoZVxuICogam91cm5hbCBpcyB3aGF0IFAtMDQzIHJlY29uY2lsZXMgYWdhaW5zdCBTdHJpcGUsIHRoZSBiYW5rIGZlZWQgYW5kIHRoZSBjaGFpbixcbiAqIHNvIGFuIGVudHJ5IHdpdGhvdXQgYSByZWZlcmVuY2UgaGFzIG5vdGhpbmcgdG8gcmVjb25jaWxlIGFnYWluc3QgYW5kIGlzXG4gKiByZWZ1c2VkLlxuICpcbiAqIFBlci11c2UgY2hhcmdlcyBhcmUgcHJpY2VkIGluIG1pY3JvLVVTRCAoc2hhcmVkLXBvdC1kYW8tY3VwYm9hcmQtdjEgRC0wNjIpLlxuICogTWljcm9zIG5ldmVyIGVudGVyIHRoZSBqb3VybmFsOiB0aGV5IHJvbGwgdXAgT1VUU0lERSBpdCBpbiBhIGBNaWNyb3NSb2xsdXBgLFxuICogYW5kIG9ubHkgd2hvbGUgY2VudHMgc2V0dGxlIGluLiBUaGUgc3ViLWNlbnQgcmVzaWR1ZSBzdGF5cyBpbiB0aGUgcm9sbC11cCdzXG4gKiBleHBsaWNpdCByb3VuZGluZyBiYWxhbmNlLCBzbyBmb3IgZXZlcnkgcm9sbC11cFxuICpcbiAqICAgKGNlbnRzIHRoZSBqb3VybmFsIHJlY2VpdmVkIGZyb20gaXQpIHggMTAsMDAwICsgcm91bmRpbmdNaWNyb3MgPSBtaWNyb3MgYWNjcnVlZFxuICpcbiAqIGhvbGRzIGV4YWN0bHk6IG5vIGZyYWN0aW9uIG9mIGEgY2VudCBpcyBsb3N0LCBhbmQgbm9uZSBpcyBpbnZlbnRlZC5cbiAqXG4gKiBUaGlzIG1vZHVsZSBpcyBwdXJlIChubyBJL08pLiBQb3N0Z3JlcyBwZXJzaXN0ZW5jZSwgdGhlIGRhdGFiYXNlLXNpZGVcbiAqIGd1YXJkcywgYW5kIHRoZSBoYXNoLWNoYWluIHN0cmVhbSBsaXZlIGluIG1vbmV5LWpvdXJuYWwtc3RvcmUudHMuXG4gKlxuICogQ2hhcnQgb2YgYWNjb3VudHMgYW5kIG5vcm1hbCBiYWxhbmNlczpcbiAqICAgb3BlcmF0aW5nICAgICAgICAgICAgICAgICAgZGViaXQgICBjYXNoIGhlbGQgYXQgU3RyaXBlLCB0aGUgYmFuayBhbmQgdGhlIFNhZmVcbiAqICAgY3VzdG9tZXItY3JlZGl0LXJlc2VydmUgICAgY3JlZGl0ICBwcmVwYWlkIGNyZWRpdHMgb3dlZCB0byBjdXN0b21lcnNcbiAqICAgcmVmdW5kLWNoYXJnZWJhY2stcmVzZXJ2ZSAgY3JlZGl0ICBwcm92aXNpb24gZm9yIHJlZnVuZHMgYW5kIGNoYXJnZWJhY2tzXG4gKiAgIHRheC1yZXNlcnZlICAgICAgICAgICAgICAgIGNyZWRpdCAgdGF4IGNvbGxlY3RlZCwgb3dlZCB0byB0YXggYXV0aG9yaXRpZXNcbiAqICAgZGFvLXBheWFibGUgICAgICAgICAgICAgICAgY3JlZGl0ICB0aGUgREFPJ3Mgc2hhcmUsIGFjY3J1ZWQgYW5kIG5vdCB5ZXQgdHJhbnNmZXJyZWRcbiAqICAgcmV2ZW51ZSAgICAgICAgICAgICAgICAgICAgY3JlZGl0ICByZWNvZ25pemVkIHJldmVudWVcbiAqICAgcHJvdmlkZXItY29zdCAgICAgICAgICAgICAgZGViaXQgICBpbmZlcmVuY2UgcHJvdmlkZXJzIGFuZCBwYXltZW50LXByb2Nlc3NpbmcgZmVlc1xuICovXG5cbmV4cG9ydCBjb25zdCBNT05FWV9KT1VSTkFMX0FDQ09VTlRTID0gW1xuICAnb3BlcmF0aW5nJyxcbiAgJ2N1c3RvbWVyLWNyZWRpdC1yZXNlcnZlJyxcbiAgJ3JlZnVuZC1jaGFyZ2ViYWNrLXJlc2VydmUnLFxuICAndGF4LXJlc2VydmUnLFxuICAnZGFvLXBheWFibGUnLFxuICAncmV2ZW51ZScsXG4gICdwcm92aWRlci1jb3N0Jyxcbl0gYXMgY29uc3Q7XG5leHBvcnQgdHlwZSBNb25leUpvdXJuYWxBY2NvdW50ID0gKHR5cGVvZiBNT05FWV9KT1VSTkFMX0FDQ09VTlRTKVtudW1iZXJdO1xuXG5leHBvcnQgdHlwZSBKb3VybmFsU2lkZSA9ICdkZWJpdCcgfCAnY3JlZGl0JztcblxuZXhwb3J0IGNvbnN0IEFDQ09VTlRfTk9STUFMX1NJREU6IFJlYWRvbmx5PFJlY29yZDxNb25leUpvdXJuYWxBY2NvdW50LCBKb3VybmFsU2lkZT4+ID0gT2JqZWN0LmZyZWV6ZSh7XG4gIG9wZXJhdGluZzogJ2RlYml0JyxcbiAgJ2N1c3RvbWVyLWNyZWRpdC1yZXNlcnZlJzogJ2NyZWRpdCcsXG4gICdyZWZ1bmQtY2hhcmdlYmFjay1yZXNlcnZlJzogJ2NyZWRpdCcsXG4gICd0YXgtcmVzZXJ2ZSc6ICdjcmVkaXQnLFxuICAnZGFvLXBheWFibGUnOiAnY3JlZGl0JyxcbiAgcmV2ZW51ZTogJ2NyZWRpdCcsXG4gICdwcm92aWRlci1jb3N0JzogJ2RlYml0Jyxcbn0pO1xuXG4vKiogMSBjZW50ID0gMTAsMDAwIG1pY3JvLVVTRC4gKi9cbmV4cG9ydCBjb25zdCBNSUNST1NfUEVSX0NFTlQgPSAxMF8wMDA7XG5cbmV4cG9ydCBjb25zdCBFWFRFUk5BTF9SRUZfS0lORFMgPSBbJ3N0cmlwZS1iYWxhbmNlLXRyYW5zYWN0aW9uJywgJ2JhbmstdHJhbnNhY3Rpb24nLCAnY2hhaW4tdHgnXSBhcyBjb25zdDtcbmV4cG9ydCB0eXBlIEV4dGVybmFsUmVmS2luZCA9ICh0eXBlb2YgRVhURVJOQUxfUkVGX0tJTkRTKVtudW1iZXJdO1xuXG5leHBvcnQgdHlwZSBFeHRlcm5hbFJlZiA9XG4gIHwgeyByZWFkb25seSBraW5kOiAnc3RyaXBlLWJhbGFuY2UtdHJhbnNhY3Rpb24nOyByZWFkb25seSBpZDogc3RyaW5nIH1cbiAgfCB7IHJlYWRvbmx5IGtpbmQ6ICdiYW5rLXRyYW5zYWN0aW9uJzsgcmVhZG9ubHkgaWQ6IHN0cmluZyB9XG4gIHwgeyByZWFkb25seSBraW5kOiAnY2hhaW4tdHgnOyByZWFkb25seSBjaGFpbklkOiBudW1iZXI7IHJlYWRvbmx5IHR4SGFzaDogc3RyaW5nIH07XG5cbmV4cG9ydCBjb25zdCBNT1ZFTUVOVF9LSU5EUyA9IFtcbiAgJ2N1c3RvbWVyLXBheW1lbnQnLFxuICAnY3JlZGl0LXB1cmNoYXNlJyxcbiAgJ3JlZnVuZCcsXG4gICdjaGFyZ2ViYWNrJyxcbiAgJ3Byb3ZpZGVyLXBheW1lbnQnLFxuICAnZGFvLXRyYW5zZmVyJyxcbiAgJ3RheC1yZW1pdHRhbmNlJyxcbiAgJ3VzYWdlLXNldHRsZW1lbnQnLFxuXSBhcyBjb25zdDtcbmV4cG9ydCB0eXBlIE1vdmVtZW50S2luZCA9ICh0eXBlb2YgTU9WRU1FTlRfS0lORFMpW251bWJlcl07XG5cbi8qKiBXaGljaCBleHRlcm5hbCByZWZlcmVuY2VzIGNhbiBldmlkZW5jZSBlYWNoIGtpbmQgb2YgbW92ZW1lbnQuICovXG5leHBvcnQgY29uc3QgTU9WRU1FTlRfUkVGX0tJTkRTOiBSZWFkb25seTxSZWNvcmQ8TW92ZW1lbnRLaW5kLCByZWFkb25seSBFeHRlcm5hbFJlZktpbmRbXT4+ID0gT2JqZWN0LmZyZWV6ZSh7XG4gICdjdXN0b21lci1wYXltZW50JzogWydzdHJpcGUtYmFsYW5jZS10cmFuc2FjdGlvbicsICdjaGFpbi10eCddLFxuICAnY3JlZGl0LXB1cmNoYXNlJzogWydzdHJpcGUtYmFsYW5jZS10cmFuc2FjdGlvbicsICdjaGFpbi10eCddLFxuICByZWZ1bmQ6IFsnc3RyaXBlLWJhbGFuY2UtdHJhbnNhY3Rpb24nLCAnY2hhaW4tdHgnXSxcbiAgY2hhcmdlYmFjazogWydzdHJpcGUtYmFsYW5jZS10cmFuc2FjdGlvbiddLFxuICAncHJvdmlkZXItcGF5bWVudCc6IFsnYmFuay10cmFuc2FjdGlvbicsICdzdHJpcGUtYmFsYW5jZS10cmFuc2FjdGlvbicsICdjaGFpbi10eCddLFxuICAnZGFvLXRyYW5zZmVyJzogWydjaGFpbi10eCddLFxuICAndGF4LXJlbWl0dGFuY2UnOiBbJ2JhbmstdHJhbnNhY3Rpb24nXSxcbiAgJ3VzYWdlLXNldHRsZW1lbnQnOiBbJ3N0cmlwZS1iYWxhbmNlLXRyYW5zYWN0aW9uJywgJ2JhbmstdHJhbnNhY3Rpb24nLCAnY2hhaW4tdHgnXSxcbn0pO1xuXG5leHBvcnQgaW50ZXJmYWNlIEpvdXJuYWxMaW5lIHtcbiAgcmVhZG9ubHkgYWNjb3VudDogTW9uZXlKb3VybmFsQWNjb3VudDtcbiAgcmVhZG9ubHkgc2lkZTogSm91cm5hbFNpZGU7XG4gIC8qKiBBIHBvc2l0aXZlIHdob2xlIG51bWJlciBvZiBjZW50cy4gTmV2ZXIgbWljcm9zLiAqL1xuICByZWFkb25seSBjZW50czogbnVtYmVyO1xufVxuXG5leHBvcnQgaW50ZXJmYWNlIEpvdXJuYWxFbnRyeSB7XG4gIC8qKiBJZGVtcG90ZW5jeSBrZXk6IHRoZSBzYW1lIG1vdmVtZW50IGFsd2F5cyBtYXBzIHRvIHRoZSBzYW1lIGlkLiAqL1xuICByZWFkb25seSBlbnRyeUlkOiBzdHJpbmc7XG4gIHJlYWRvbmx5IG9jY3VycmVkQXRNczogbnVtYmVyO1xuICByZWFkb25seSBjdXJyZW5jeTogc3RyaW5nO1xuICByZWFkb25seSBtb3ZlbWVudDogTW92ZW1lbnRLaW5kO1xuICByZWFkb25seSBleHRlcm5hbFJlZjogRXh0ZXJuYWxSZWY7XG4gIC8qKiBTZXQgb25seSBvbiBhIGB1c2FnZS1zZXR0bGVtZW50YDogdGhlIHJvbGwtdXAgd2hvc2Ugd2hvbGUgY2VudHMgaXQgc2V0dGxlcy4gKi9cbiAgcmVhZG9ubHkgcm9sbHVwSWQ6IHN0cmluZyB8IG51bGw7XG4gIHJlYWRvbmx5IG1lbW86IHN0cmluZztcbiAgcmVhZG9ubHkgbGluZXM6IHJlYWRvbmx5IEpvdXJuYWxMaW5lW107XG59XG5cbmV4cG9ydCB0eXBlIEpvdXJuYWxSZWplY3Rpb25Db2RlID1cbiAgfCAnaW52YWxpZC1lbnRyeSdcbiAgfCAnbWlzc2luZy1leHRlcm5hbC1yZWZlcmVuY2UnXG4gIHwgJ2ludmFsaWQtZXh0ZXJuYWwtcmVmZXJlbmNlJ1xuICB8ICdleHRlcm5hbC1yZWZlcmVuY2Uta2luZC1ub3QtYWxsb3dlZCdcbiAgfCAndW5rbm93bi1hY2NvdW50J1xuICB8ICd0b28tZmV3LWxpbmVzJ1xuICB8ICdub24tcG9zaXRpdmUtYW1vdW50J1xuICB8ICdzdWItY2VudC1hbW91bnQnXG4gIHwgJ21pY3Jvcy1pbi1qb3VybmFsJ1xuICB8ICd1bmJhbGFuY2VkJ1xuICB8ICdjdXJyZW5jeS1taXNtYXRjaCdcbiAgfCAnZHVwbGljYXRlLWVudHJ5J1xuICB8ICdpbnZhbGlkLW1vdmVtZW50JztcblxuZXhwb3J0IGludGVyZmFjZSBKb3VybmFsUmVqZWN0aW9uIHtcbiAgcmVhZG9ubHkgb2s6IGZhbHNlO1xuICByZWFkb25seSBjb2RlOiBKb3VybmFsUmVqZWN0aW9uQ29kZTtcbiAgcmVhZG9ubHkgZGV0YWlsOiBzdHJpbmc7XG59XG5cbmNvbnN0IHJlamVjdCA9IChjb2RlOiBKb3VybmFsUmVqZWN0aW9uQ29kZSwgZGV0YWlsOiBzdHJpbmcpOiBKb3VybmFsUmVqZWN0aW9uID0+ICh7IG9rOiBmYWxzZSwgY29kZSwgZGV0YWlsIH0pO1xuXG5mdW5jdGlvbiBpc1JlY29yZCh2YWx1ZTogdW5rbm93bik6IHZhbHVlIGlzIFJlY29yZDxzdHJpbmcsIHVua25vd24+IHtcbiAgcmV0dXJuIHR5cGVvZiB2YWx1ZSA9PT0gJ29iamVjdCcgJiYgdmFsdWUgIT09IG51bGwgJiYgIUFycmF5LmlzQXJyYXkodmFsdWUpO1xufVxuXG5mdW5jdGlvbiBpc0FjY291bnQodmFsdWU6IHVua25vd24pOiB2YWx1ZSBpcyBNb25leUpvdXJuYWxBY2NvdW50IHtcbiAgcmV0dXJuIHR5cGVvZiB2YWx1ZSA9PT0gJ3N0cmluZycgJiYgKE1PTkVZX0pPVVJOQUxfQUNDT1VOVFMgYXMgcmVhZG9ubHkgc3RyaW5nW10pLmluY2x1ZGVzKHZhbHVlKTtcbn1cblxuZnVuY3Rpb24gaXNNb3ZlbWVudEtpbmQodmFsdWU6IHVua25vd24pOiB2YWx1ZSBpcyBNb3ZlbWVudEtpbmQge1xuICByZXR1cm4gdHlwZW9mIHZhbHVlID09PSAnc3RyaW5nJyAmJiAoTU9WRU1FTlRfS0lORFMgYXMgcmVhZG9ubHkgc3RyaW5nW10pLmluY2x1ZGVzKHZhbHVlKTtcbn1cblxuY29uc3QgU1RSSVBFX0JBTEFOQ0VfVFhOID0gL150eG5fW0EtWmEtejAtOV17MSwyNTB9JC87XG5jb25zdCBDSEFJTl9UWF9IQVNIID0gL14weFswLTlhLWZdezY0fSQvO1xuY29uc3QgQ1VSUkVOQ1kgPSAvXltBLVpdezN9JC87XG5cbmV4cG9ydCB0eXBlIEV4dGVybmFsUmVmVmFsaWRhdGlvbiA9IHsgb2s6IHRydWU7IHJlZjogRXh0ZXJuYWxSZWYgfSB8IEpvdXJuYWxSZWplY3Rpb247XG5cbmV4cG9ydCBmdW5jdGlvbiB2YWxpZGF0ZUV4dGVybmFsUmVmKHJhdzogdW5rbm93bik6IEV4dGVybmFsUmVmVmFsaWRhdGlvbiB7XG4gIGlmIChyYXcgPT09IHVuZGVmaW5lZCB8fCByYXcgPT09IG51bGwpIHJldHVybiByZWplY3QoJ21pc3NpbmctZXh0ZXJuYWwtcmVmZXJlbmNlJywgJ2FuIGVudHJ5IG11c3QgY2FycnkgdGhlIGV4dGVybmFsIHJlZmVyZW5jZSBvZiBpdHMgbW92ZW1lbnQnKTtcbiAgaWYgKCFpc1JlY29yZChyYXcpKSByZXR1cm4gcmVqZWN0KCdpbnZhbGlkLWV4dGVybmFsLXJlZmVyZW5jZScsICdleHRlcm5hbFJlZiBtdXN0IGJlIGFuIG9iamVjdCcpO1xuICBzd2l0Y2ggKHJhdy5raW5kKSB7XG4gICAgY2FzZSAnc3RyaXBlLWJhbGFuY2UtdHJhbnNhY3Rpb24nOlxuICAgICAgaWYgKHR5cGVvZiByYXcuaWQgIT09ICdzdHJpbmcnIHx8ICFTVFJJUEVfQkFMQU5DRV9UWE4udGVzdChyYXcuaWQpKSB7XG4gICAgICAgIHJldHVybiByZWplY3QoJ2ludmFsaWQtZXh0ZXJuYWwtcmVmZXJlbmNlJywgJ2EgU3RyaXBlIGJhbGFuY2UtdHJhbnNhY3Rpb24gaWQgbG9va3MgbGlrZSB0eG5f4oCmJyk7XG4gICAgICB9XG4gICAgICByZXR1cm4geyBvazogdHJ1ZSwgcmVmOiB7IGtpbmQ6ICdzdHJpcGUtYmFsYW5jZS10cmFuc2FjdGlvbicsIGlkOiByYXcuaWQgfSB9O1xuICAgIGNhc2UgJ2JhbmstdHJhbnNhY3Rpb24nOlxuICAgICAgaWYgKHR5cGVvZiByYXcuaWQgIT09ICdzdHJpbmcnIHx8IHJhdy5pZC50cmltKCkubGVuZ3RoID09PSAwIHx8IHJhdy5pZC5sZW5ndGggPiAyNTYgfHwgcmF3LmlkICE9PSByYXcuaWQudHJpbSgpKSB7XG4gICAgICAgIHJldHVybiByZWplY3QoJ2ludmFsaWQtZXh0ZXJuYWwtcmVmZXJlbmNlJywgJ2EgYmFuayB0cmFuc2FjdGlvbiBpZCBtdXN0IGJlIGEgbm9uLWVtcHR5IHRyaW1tZWQgc3RyaW5nIG9mIGF0IG1vc3QgMjU2IGNoYXJhY3RlcnMnKTtcbiAgICAgIH1cbiAgICAgIHJldHVybiB7IG9rOiB0cnVlLCByZWY6IHsga2luZDogJ2JhbmstdHJhbnNhY3Rpb24nLCBpZDogcmF3LmlkIH0gfTtcbiAgICBjYXNlICdjaGFpbi10eCc6XG4gICAgICBpZiAodHlwZW9mIHJhdy5jaGFpbklkICE9PSAnbnVtYmVyJyB8fCAhTnVtYmVyLmlzU2FmZUludGVnZXIocmF3LmNoYWluSWQpIHx8IHJhdy5jaGFpbklkIDw9IDApIHtcbiAgICAgICAgcmV0dXJuIHJlamVjdCgnaW52YWxpZC1leHRlcm5hbC1yZWZlcmVuY2UnLCAnY2hhaW5JZCBtdXN0IGJlIGEgcG9zaXRpdmUgaW50ZWdlciAoRUlQLTE1NSknKTtcbiAgICAgIH1cbiAgICAgIGlmICh0eXBlb2YgcmF3LnR4SGFzaCAhPT0gJ3N0cmluZycgfHwgIUNIQUlOX1RYX0hBU0gudGVzdChyYXcudHhIYXNoKSkge1xuICAgICAgICByZXR1cm4gcmVqZWN0KCdpbnZhbGlkLWV4dGVybmFsLXJlZmVyZW5jZScsICd0eEhhc2ggbXVzdCBiZSAweCBmb2xsb3dlZCBieSA2NCBsb3dlcmNhc2UgaGV4IGRpZ2l0cycpO1xuICAgICAgfVxuICAgICAgcmV0dXJuIHsgb2s6IHRydWUsIHJlZjogeyBraW5kOiAnY2hhaW4tdHgnLCBjaGFpbklkOiByYXcuY2hhaW5JZCwgdHhIYXNoOiByYXcudHhIYXNoIH0gfTtcbiAgICBkZWZhdWx0OlxuICAgICAgcmV0dXJuIHJlamVjdCgnaW52YWxpZC1leHRlcm5hbC1yZWZlcmVuY2UnLCBgZXh0ZXJuYWxSZWYua2luZCBtdXN0IGJlIG9uZSBvZiAke0VYVEVSTkFMX1JFRl9LSU5EUy5qb2luKCcsICcpfWApO1xuICB9XG59XG5cbi8qKiBUaGUgcmVmZXJlbmNlIGFzIG9uZSBzdHJpbmcsIGUuZy4gYGNoYWluLXR4Ojg0NTMyOjB4YWLigKZgLiBVc2VkIGZvciBzdG9yYWdlIGFuZCByZWNvbmNpbGlhdGlvbiBqb2lucy4gKi9cbmV4cG9ydCBmdW5jdGlvbiBleHRlcm5hbFJlZktleShyZWY6IEV4dGVybmFsUmVmKTogc3RyaW5nIHtcbiAgcmV0dXJuIHJlZi5raW5kID09PSAnY2hhaW4tdHgnID8gYGNoYWluLXR4OiR7cmVmLmNoYWluSWR9OiR7cmVmLnR4SGFzaH1gIDogYCR7cmVmLmtpbmR9OiR7cmVmLmlkfWA7XG59XG5cbmV4cG9ydCB0eXBlIEpvdXJuYWxFbnRyeVZhbGlkYXRpb24gPSB7IG9rOiB0cnVlOyBlbnRyeTogSm91cm5hbEVudHJ5IH0gfCBKb3VybmFsUmVqZWN0aW9uO1xuXG4vKiogVmFsaWRhdGUgYSBjYW5kaWRhdGUgZW50cnkuIFJlZnVzYWxzIGFyZSB0eXBlZDsgbm90aGluZyBwYXJ0aWFsIGlzIGV2ZXIgYWNjZXB0ZWQuICovXG5leHBvcnQgZnVuY3Rpb24gdmFsaWRhdGVKb3VybmFsRW50cnkocmF3OiB1bmtub3duKTogSm91cm5hbEVudHJ5VmFsaWRhdGlvbiB7XG4gIGlmICghaXNSZWNvcmQocmF3KSkgcmV0dXJuIHJlamVjdCgnaW52YWxpZC1lbnRyeScsICdlbnRyeSBtdXN0IGJlIGFuIG9iamVjdCcpO1xuICBjb25zdCB7IGVudHJ5SWQsIG9jY3VycmVkQXRNcywgY3VycmVuY3ksIG1vdmVtZW50LCBtZW1vLCByb2xsdXBJZCwgbGluZXMgfSA9IHJhdztcbiAgaWYgKHR5cGVvZiBlbnRyeUlkICE9PSAnc3RyaW5nJyB8fCBlbnRyeUlkLmxlbmd0aCA9PT0gMCB8fCBlbnRyeUlkLmxlbmd0aCA+IDI1Nikge1xuICAgIHJldHVybiByZWplY3QoJ2ludmFsaWQtZW50cnknLCAnZW50cnlJZCBtdXN0IGJlIGEgc3RyaW5nIG9mIDEtMjU2IGNoYXJhY3RlcnMnKTtcbiAgfVxuICBpZiAodHlwZW9mIG9jY3VycmVkQXRNcyAhPT0gJ251bWJlcicgfHwgIU51bWJlci5pc1NhZmVJbnRlZ2VyKG9jY3VycmVkQXRNcykgfHwgb2NjdXJyZWRBdE1zIDwgMCkge1xuICAgIHJldHVybiByZWplY3QoJ2ludmFsaWQtZW50cnknLCAnb2NjdXJyZWRBdE1zIG11c3QgYmUgYSBub24tbmVnYXRpdmUgaW50ZWdlcicpO1xuICB9XG4gIGlmICh0eXBlb2YgY3VycmVuY3kgIT09ICdzdHJpbmcnIHx8ICFDVVJSRU5DWS50ZXN0KGN1cnJlbmN5KSkge1xuICAgIHJldHVybiByZWplY3QoJ2ludmFsaWQtZW50cnknLCAnY3VycmVuY3kgbXVzdCBiZSBhbiB1cHBlci1jYXNlIElTTy00MjE3IGNvZGUnKTtcbiAgfVxuICBpZiAoIWlzTW92ZW1lbnRLaW5kKG1vdmVtZW50KSkgcmV0dXJuIHJlamVjdCgnaW52YWxpZC1tb3ZlbWVudCcsIGBtb3ZlbWVudCBtdXN0IGJlIG9uZSBvZiAke01PVkVNRU5UX0tJTkRTLmpvaW4oJywgJyl9YCk7XG4gIGlmIChtZW1vICE9PSB1bmRlZmluZWQgJiYgKHR5cGVvZiBtZW1vICE9PSAnc3RyaW5nJyB8fCBtZW1vLmxlbmd0aCA+IDEwMDApKSB7XG4gICAgcmV0dXJuIHJlamVjdCgnaW52YWxpZC1lbnRyeScsICdtZW1vIG11c3QgYmUgYSBzdHJpbmcgb2YgYXQgbW9zdCAxMDAwIGNoYXJhY3RlcnMnKTtcbiAgfVxuICBpZiAocm9sbHVwSWQgIT09IHVuZGVmaW5lZCAmJiByb2xsdXBJZCAhPT0gbnVsbCAmJiAodHlwZW9mIHJvbGx1cElkICE9PSAnc3RyaW5nJyB8fCByb2xsdXBJZC5sZW5ndGggPT09IDAgfHwgcm9sbHVwSWQubGVuZ3RoID4gMjU2KSkge1xuICAgIHJldHVybiByZWplY3QoJ2ludmFsaWQtZW50cnknLCAncm9sbHVwSWQgbXVzdCBiZSBudWxsIG9yIGEgc3RyaW5nIG9mIDEtMjU2IGNoYXJhY3RlcnMnKTtcbiAgfVxuICBjb25zdCBub3JtYWxpemVkUm9sbHVwID0gdHlwZW9mIHJvbGx1cElkID09PSAnc3RyaW5nJyA/IHJvbGx1cElkIDogbnVsbDtcbiAgaWYgKChub3JtYWxpemVkUm9sbHVwICE9PSBudWxsKSAhPT0gKG1vdmVtZW50ID09PSAndXNhZ2Utc2V0dGxlbWVudCcpKSB7XG4gICAgcmV0dXJuIHJlamVjdCgnaW52YWxpZC1lbnRyeScsICdyb2xsdXBJZCBpcyByZXF1aXJlZCBvbiBhIHVzYWdlLXNldHRsZW1lbnQgYW5kIGZvcmJpZGRlbiBvbiBldmVyeSBvdGhlciBtb3ZlbWVudCcpO1xuICB9XG5cbiAgY29uc3QgcmVmID0gdmFsaWRhdGVFeHRlcm5hbFJlZihyYXcuZXh0ZXJuYWxSZWYpO1xuICBpZiAoIXJlZi5vaykgcmV0dXJuIHJlZjtcbiAgaWYgKCFNT1ZFTUVOVF9SRUZfS0lORFNbbW92ZW1lbnRdLmluY2x1ZGVzKHJlZi5yZWYua2luZCkpIHtcbiAgICByZXR1cm4gcmVqZWN0KFxuICAgICAgJ2V4dGVybmFsLXJlZmVyZW5jZS1raW5kLW5vdC1hbGxvd2VkJyxcbiAgICAgIGBhICR7bW92ZW1lbnR9IGlzIGV2aWRlbmNlZCBieSAke01PVkVNRU5UX1JFRl9LSU5EU1ttb3ZlbWVudF0uam9pbignIG9yICcpfSwgbm90ICR7cmVmLnJlZi5raW5kfWAsXG4gICAgKTtcbiAgfVxuXG4gIGlmICghQXJyYXkuaXNBcnJheShsaW5lcykpIHJldHVybiByZWplY3QoJ2ludmFsaWQtZW50cnknLCAnbGluZXMgbXVzdCBiZSBhbiBhcnJheScpO1xuICBpZiAobGluZXMubGVuZ3RoIDwgMikgcmV0dXJuIHJlamVjdCgndG9vLWZldy1saW5lcycsICdhIGRvdWJsZS1lbnRyeSBwb3N0aW5nIG5lZWRzIGF0IGxlYXN0IG9uZSBkZWJpdCBhbmQgb25lIGNyZWRpdCBsaW5lJyk7XG4gIGNvbnN0IG5vcm1hbGl6ZWQ6IEpvdXJuYWxMaW5lW10gPSBbXTtcbiAgbGV0IGRlYml0cyA9IDA7XG4gIGxldCBjcmVkaXRzID0gMDtcbiAgZm9yIChjb25zdCBbaW5kZXgsIGxpbmVdIG9mIGxpbmVzLmVudHJpZXMoKSkge1xuICAgIGlmICghaXNSZWNvcmQobGluZSkpIHJldHVybiByZWplY3QoJ2ludmFsaWQtZW50cnknLCBgbGluZSAke2luZGV4fSBtdXN0IGJlIGFuIG9iamVjdGApO1xuICAgIGlmICgnbWljcm9zJyBpbiBsaW5lIHx8IGxpbmUudW5pdCA9PT0gJ21pY3JvcycpIHtcbiAgICAgIHJldHVybiByZWplY3QoJ21pY3Jvcy1pbi1qb3VybmFsJywgYGxpbmUgJHtpbmRleH0gY2FycmllcyBtaWNyb3M7IG1pY3JvcyByb2xsIHVwIG91dHNpZGUgdGhlIGpvdXJuYWwgYW5kIG9ubHkgd2hvbGUgY2VudHMgZW50ZXIgaXRgKTtcbiAgICB9XG4gICAgaWYgKCFpc0FjY291bnQobGluZS5hY2NvdW50KSkgcmV0dXJuIHJlamVjdCgndW5rbm93bi1hY2NvdW50JywgYGxpbmUgJHtpbmRleH06IHVua25vd24gYWNjb3VudCAke1N0cmluZyhsaW5lLmFjY291bnQpfWApO1xuICAgIGlmIChsaW5lLnNpZGUgIT09ICdkZWJpdCcgJiYgbGluZS5zaWRlICE9PSAnY3JlZGl0JykgcmV0dXJuIHJlamVjdCgnaW52YWxpZC1lbnRyeScsIGBsaW5lICR7aW5kZXh9OiBzaWRlIG11c3QgYmUgZGViaXQgb3IgY3JlZGl0YCk7XG4gICAgY29uc3QgY2VudHMgPSBsaW5lLmNlbnRzO1xuICAgIGlmICh0eXBlb2YgY2VudHMgIT09ICdudW1iZXInIHx8ICFOdW1iZXIuaXNGaW5pdGUoY2VudHMpKSByZXR1cm4gcmVqZWN0KCdpbnZhbGlkLWVudHJ5JywgYGxpbmUgJHtpbmRleH06IGNlbnRzIG11c3QgYmUgYSBudW1iZXJgKTtcbiAgICBpZiAoIU51bWJlci5pc0ludGVnZXIoY2VudHMpKSByZXR1cm4gcmVqZWN0KCdzdWItY2VudC1hbW91bnQnLCBgbGluZSAke2luZGV4fTogJHtjZW50c30gaXMgbm90IGEgd2hvbGUgbnVtYmVyIG9mIGNlbnRzYCk7XG4gICAgaWYgKCFOdW1iZXIuaXNTYWZlSW50ZWdlcihjZW50cykpIHJldHVybiByZWplY3QoJ2ludmFsaWQtZW50cnknLCBgbGluZSAke2luZGV4fTogY2VudHMgaXMgb3V0c2lkZSB0aGUgc2FmZSBpbnRlZ2VyIHJhbmdlYCk7XG4gICAgaWYgKGNlbnRzIDw9IDApIHJldHVybiByZWplY3QoJ25vbi1wb3NpdGl2ZS1hbW91bnQnLCBgbGluZSAke2luZGV4fTogYW1vdW50cyBhcmUgcG9zaXRpdmU7IHRoZSBzaWRlIGNhcnJpZXMgdGhlIGRpcmVjdGlvbmApO1xuICAgIGlmIChsaW5lLnNpZGUgPT09ICdkZWJpdCcpIGRlYml0cyArPSBjZW50cztcbiAgICBlbHNlIGNyZWRpdHMgKz0gY2VudHM7XG4gICAgbm9ybWFsaXplZC5wdXNoKHsgYWNjb3VudDogbGluZS5hY2NvdW50LCBzaWRlOiBsaW5lLnNpZGUsIGNlbnRzIH0pO1xuICB9XG4gIGlmICghTnVtYmVyLmlzU2FmZUludGVnZXIoZGViaXRzKSB8fCAhTnVtYmVyLmlzU2FmZUludGVnZXIoY3JlZGl0cykpIHtcbiAgICByZXR1cm4gcmVqZWN0KCdpbnZhbGlkLWVudHJ5JywgJ2VudHJ5IHRvdGFscyBhcmUgb3V0c2lkZSB0aGUgc2FmZSBpbnRlZ2VyIHJhbmdlJyk7XG4gIH1cbiAgaWYgKGRlYml0cyAhPT0gY3JlZGl0cykgcmV0dXJuIHJlamVjdCgndW5iYWxhbmNlZCcsIGBkZWJpdHMgJHtkZWJpdHN9ICE9IGNyZWRpdHMgJHtjcmVkaXRzfWApO1xuICBpZiAoZGViaXRzID09PSAwKSByZXR1cm4gcmVqZWN0KCd0b28tZmV3LWxpbmVzJywgJ2FuIGVudHJ5IG5lZWRzIGF0IGxlYXN0IG9uZSBkZWJpdCBhbmQgb25lIGNyZWRpdCcpO1xuXG4gIHJldHVybiB7XG4gICAgb2s6IHRydWUsXG4gICAgZW50cnk6IHtcbiAgICAgIGVudHJ5SWQsXG4gICAgICBvY2N1cnJlZEF0TXMsXG4gICAgICBjdXJyZW5jeSxcbiAgICAgIG1vdmVtZW50LFxuICAgICAgZXh0ZXJuYWxSZWY6IHJlZi5yZWYsXG4gICAgICByb2xsdXBJZDogbm9ybWFsaXplZFJvbGx1cCxcbiAgICAgIG1lbW86IHR5cGVvZiBtZW1vID09PSAnc3RyaW5nJyA/IG1lbW8gOiAnJyxcbiAgICAgIGxpbmVzOiBub3JtYWxpemVkLFxuICAgIH0sXG4gIH07XG59XG5cbi8qKiBUaGUgZW50cnkncyB0b3RhbDogc3VtIG9mIGl0cyBkZWJpdHMgKD0gc3VtIG9mIGl0cyBjcmVkaXRzKS4gKi9cbmV4cG9ydCBmdW5jdGlvbiBlbnRyeVRvdGFsQ2VudHMoZW50cnk6IEpvdXJuYWxFbnRyeSk6IG51bWJlciB7XG4gIHJldHVybiBlbnRyeS5saW5lcy5yZWR1Y2UoKHN1bSwgbGluZSkgPT4gKGxpbmUuc2lkZSA9PT0gJ2RlYml0JyA/IHN1bSArIGxpbmUuY2VudHMgOiBzdW0pLCAwKTtcbn1cblxuLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG4vLyBQb3N0aW5nIHJ1bGVzOiBvbmUgbW92ZW1lbnQgLT4gdGhlIGxpbmVzIG9mIGl0cyBlbnRyeS5cbi8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuXG5leHBvcnQgdHlwZSBNb25leU1vdmVtZW50ID1cbiAgLyoqIEEgY3VzdG9tZXIgcGFpZCBmb3IgYSBzdWJzY3JpcHRpb24gb3IgYSBvbmUtdGltZSBwdXJjaGFzZS4gVGF4LCB0aGUgREFPIHNoYXJlIGFuZCBhIHJlZnVuZCBwcm92aXNpb24gY29tZSBvdXQgb2YgcmV2ZW51ZS4gKi9cbiAgfCB7XG4gICAgICByZWFkb25seSBraW5kOiAnY3VzdG9tZXItcGF5bWVudCc7XG4gICAgICByZWFkb25seSBncm9zc0NlbnRzOiBudW1iZXI7XG4gICAgICByZWFkb25seSBmZWVDZW50czogbnVtYmVyO1xuICAgICAgcmVhZG9ubHkgdGF4Q2VudHM6IG51bWJlcjtcbiAgICAgIHJlYWRvbmx5IGRhb0NlbnRzOiBudW1iZXI7XG4gICAgICByZWFkb25seSByZWZ1bmRSZXNlcnZlQ2VudHM6IG51bWJlcjtcbiAgICB9XG4gIC8qKiBBIGN1c3RvbWVyIGJvdWdodCBwcmVwYWlkIGNyZWRpdHM6IG93ZWQgYXMgc2VydmljZSwgbm90IHlldCByZXZlbnVlLiAqL1xuICB8IHsgcmVhZG9ubHkga2luZDogJ2NyZWRpdC1wdXJjaGFzZSc7IHJlYWRvbmx5IGdyb3NzQ2VudHM6IG51bWJlcjsgcmVhZG9ubHkgZmVlQ2VudHM6IG51bWJlcjsgcmVhZG9ubHkgdGF4Q2VudHM6IG51bWJlciB9XG4gIC8qKiBNb25leSByZXR1cm5lZCB0byBhIGN1c3RvbWVyLCBkcmF3biBmcm9tIHRoZSByZWZ1bmQgcHJvdmlzaW9uIChhbmQgdGhlIHRheCBpdCBjYXJyaWVkKS4gKi9cbiAgfCB7IHJlYWRvbmx5IGtpbmQ6ICdyZWZ1bmQnOyByZWFkb25seSBhbW91bnRDZW50czogbnVtYmVyOyByZWFkb25seSB0YXhDZW50czogbnVtYmVyIH1cbiAgLyoqIEEgbG9zdCBkaXNwdXRlOiB0aGUgYW1vdW50IHBsdXMgdGhlIHByb2Nlc3NvcidzIGRpc3B1dGUgZmVlIGxlYXZlIG9wZXJhdGluZy4gKi9cbiAgfCB7IHJlYWRvbmx5IGtpbmQ6ICdjaGFyZ2ViYWNrJzsgcmVhZG9ubHkgYW1vdW50Q2VudHM6IG51bWJlcjsgcmVhZG9ubHkgZmVlQ2VudHM6IG51bWJlciB9XG4gIC8qKiBQYXlpbmcgYW4gaW5mZXJlbmNlIHByb3ZpZGVyIG9yIG90aGVyIHByb3ZpZGVyLiAqL1xuICB8IHsgcmVhZG9ubHkga2luZDogJ3Byb3ZpZGVyLXBheW1lbnQnOyByZWFkb25seSBhbW91bnRDZW50czogbnVtYmVyIH1cbiAgLyoqIFBheWluZyB0aGUgREFPJ3MgYWNjcnVlZCBzaGFyZSB0byBpdHMgU2FmZS4gKi9cbiAgfCB7IHJlYWRvbmx5IGtpbmQ6ICdkYW8tdHJhbnNmZXInOyByZWFkb25seSBhbW91bnRDZW50czogbnVtYmVyIH1cbiAgLyoqIFBheWluZyBjb2xsZWN0ZWQgdGF4IHRvIHRoZSBhdXRob3JpdHkuICovXG4gIHwgeyByZWFkb25seSBraW5kOiAndGF4LXJlbWl0dGFuY2UnOyByZWFkb25seSBhbW91bnRDZW50czogbnVtYmVyIH1cbiAgLyoqIFdob2xlIGNlbnRzIHNldHRsZWQgb3V0IG9mIGEgcGVyLXVzZSBtaWNyb3Mgcm9sbC11cDogY3JlZGl0cyBjb25zdW1lZCBiZWNvbWUgcmV2ZW51ZSBhbmQgdGhlIERBTyBzaGFyZS4gKi9cbiAgfCB7IHJlYWRvbmx5IGtpbmQ6ICd1c2FnZS1zZXR0bGVtZW50JzsgcmVhZG9ubHkgY2VudHM6IG51bWJlcjsgcmVhZG9ubHkgZGFvQ2VudHM6IG51bWJlciB9O1xuXG5leHBvcnQgdHlwZSBNb3ZlbWVudExpbmVzID0geyBvazogdHJ1ZTsgbGluZXM6IEpvdXJuYWxMaW5lW10gfSB8IEpvdXJuYWxSZWplY3Rpb247XG5cbmZ1bmN0aW9uIHdob2xlQ2VudHMobmFtZTogc3RyaW5nLCB2YWx1ZTogbnVtYmVyLCBhbGxvd1plcm86IGJvb2xlYW4pOiBKb3VybmFsUmVqZWN0aW9uIHwgbnVsbCB7XG4gIGlmICh0eXBlb2YgdmFsdWUgIT09ICdudW1iZXInIHx8ICFOdW1iZXIuaXNGaW5pdGUodmFsdWUpKSByZXR1cm4gcmVqZWN0KCdpbnZhbGlkLW1vdmVtZW50JywgYCR7bmFtZX0gbXVzdCBiZSBhIG51bWJlcmApO1xuICBpZiAoIU51bWJlci5pc0ludGVnZXIodmFsdWUpKSByZXR1cm4gcmVqZWN0KCdzdWItY2VudC1hbW91bnQnLCBgJHtuYW1lfSA9ICR7dmFsdWV9IGlzIG5vdCBhIHdob2xlIG51bWJlciBvZiBjZW50c2ApO1xuICBpZiAoIU51bWJlci5pc1NhZmVJbnRlZ2VyKHZhbHVlKSkgcmV0dXJuIHJlamVjdCgnaW52YWxpZC1tb3ZlbWVudCcsIGAke25hbWV9IGlzIG91dHNpZGUgdGhlIHNhZmUgaW50ZWdlciByYW5nZWApO1xuICBpZiAodmFsdWUgPCAwIHx8ICghYWxsb3daZXJvICYmIHZhbHVlID09PSAwKSkge1xuICAgIHJldHVybiByZWplY3QoJ2ludmFsaWQtbW92ZW1lbnQnLCBgJHtuYW1lfSBtdXN0IGJlICR7YWxsb3daZXJvID8gJ3plcm8gb3IgbW9yZScgOiAncG9zaXRpdmUnfWApO1xuICB9XG4gIHJldHVybiBudWxsO1xufVxuXG5mdW5jdGlvbiBsaW5lc09mKHBhcnRzOiBSZWFkb25seUFycmF5PHJlYWRvbmx5IFtNb25leUpvdXJuYWxBY2NvdW50LCBKb3VybmFsU2lkZSwgbnVtYmVyXT4pOiBKb3VybmFsTGluZVtdIHtcbiAgcmV0dXJuIHBhcnRzLmZpbHRlcigoWywgLCBjZW50c10pID0+IGNlbnRzID4gMCkubWFwKChbYWNjb3VudCwgc2lkZSwgY2VudHNdKSA9PiAoeyBhY2NvdW50LCBzaWRlLCBjZW50cyB9KSk7XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBqb3VybmFsTGluZXNGb3JNb3ZlbWVudChtb3ZlbWVudDogTW9uZXlNb3ZlbWVudCk6IE1vdmVtZW50TGluZXMge1xuICBzd2l0Y2ggKG1vdmVtZW50LmtpbmQpIHtcbiAgICBjYXNlICdjdXN0b21lci1wYXltZW50Jzoge1xuICAgICAgY29uc3QgeyBncm9zc0NlbnRzLCBmZWVDZW50cywgdGF4Q2VudHMsIGRhb0NlbnRzLCByZWZ1bmRSZXNlcnZlQ2VudHMgfSA9IG1vdmVtZW50O1xuICAgICAgY29uc3QgYmFkID1cbiAgICAgICAgd2hvbGVDZW50cygnZ3Jvc3NDZW50cycsIGdyb3NzQ2VudHMsIGZhbHNlKSA/P1xuICAgICAgICB3aG9sZUNlbnRzKCdmZWVDZW50cycsIGZlZUNlbnRzLCB0cnVlKSA/P1xuICAgICAgICB3aG9sZUNlbnRzKCd0YXhDZW50cycsIHRheENlbnRzLCB0cnVlKSA/P1xuICAgICAgICB3aG9sZUNlbnRzKCdkYW9DZW50cycsIGRhb0NlbnRzLCB0cnVlKSA/P1xuICAgICAgICB3aG9sZUNlbnRzKCdyZWZ1bmRSZXNlcnZlQ2VudHMnLCByZWZ1bmRSZXNlcnZlQ2VudHMsIHRydWUpO1xuICAgICAgaWYgKGJhZCkgcmV0dXJuIGJhZDtcbiAgICAgIGlmIChmZWVDZW50cyA+IGdyb3NzQ2VudHMpIHJldHVybiByZWplY3QoJ2ludmFsaWQtbW92ZW1lbnQnLCAndGhlIHByb2Nlc3NpbmcgZmVlIGV4Y2VlZHMgdGhlIGdyb3NzIHBheW1lbnQnKTtcbiAgICAgIGlmICh0YXhDZW50cyArIGRhb0NlbnRzICsgcmVmdW5kUmVzZXJ2ZUNlbnRzID4gZ3Jvc3NDZW50cykge1xuICAgICAgICByZXR1cm4gcmVqZWN0KCdpbnZhbGlkLW1vdmVtZW50JywgJ3RheCwgdGhlIERBTyBzaGFyZSBhbmQgdGhlIHJlZnVuZCBwcm92aXNpb24gZXhjZWVkIHRoZSBncm9zcyBwYXltZW50Jyk7XG4gICAgICB9XG4gICAgICByZXR1cm4ge1xuICAgICAgICBvazogdHJ1ZSxcbiAgICAgICAgbGluZXM6IGxpbmVzT2YoW1xuICAgICAgICAgIFsnb3BlcmF0aW5nJywgJ2RlYml0JywgZ3Jvc3NDZW50cyAtIGZlZUNlbnRzXSxcbiAgICAgICAgICBbJ3Byb3ZpZGVyLWNvc3QnLCAnZGViaXQnLCBmZWVDZW50c10sXG4gICAgICAgICAgWyd0YXgtcmVzZXJ2ZScsICdjcmVkaXQnLCB0YXhDZW50c10sXG4gICAgICAgICAgWydkYW8tcGF5YWJsZScsICdjcmVkaXQnLCBkYW9DZW50c10sXG4gICAgICAgICAgWydyZWZ1bmQtY2hhcmdlYmFjay1yZXNlcnZlJywgJ2NyZWRpdCcsIHJlZnVuZFJlc2VydmVDZW50c10sXG4gICAgICAgICAgWydyZXZlbnVlJywgJ2NyZWRpdCcsIGdyb3NzQ2VudHMgLSB0YXhDZW50cyAtIGRhb0NlbnRzIC0gcmVmdW5kUmVzZXJ2ZUNlbnRzXSxcbiAgICAgICAgXSksXG4gICAgICB9O1xuICAgIH1cbiAgICBjYXNlICdjcmVkaXQtcHVyY2hhc2UnOiB7XG4gICAgICBjb25zdCB7IGdyb3NzQ2VudHMsIGZlZUNlbnRzLCB0YXhDZW50cyB9ID0gbW92ZW1lbnQ7XG4gICAgICBjb25zdCBiYWQgPVxuICAgICAgICB3aG9sZUNlbnRzKCdncm9zc0NlbnRzJywgZ3Jvc3NDZW50cywgZmFsc2UpID8/IHdob2xlQ2VudHMoJ2ZlZUNlbnRzJywgZmVlQ2VudHMsIHRydWUpID8/IHdob2xlQ2VudHMoJ3RheENlbnRzJywgdGF4Q2VudHMsIHRydWUpO1xuICAgICAgaWYgKGJhZCkgcmV0dXJuIGJhZDtcbiAgICAgIGlmIChmZWVDZW50cyA+IGdyb3NzQ2VudHMpIHJldHVybiByZWplY3QoJ2ludmFsaWQtbW92ZW1lbnQnLCAndGhlIHByb2Nlc3NpbmcgZmVlIGV4Y2VlZHMgdGhlIGdyb3NzIHBheW1lbnQnKTtcbiAgICAgIGlmICh0YXhDZW50cyA+PSBncm9zc0NlbnRzKSByZXR1cm4gcmVqZWN0KCdpbnZhbGlkLW1vdmVtZW50JywgJ3RheCBtdXN0IGxlYXZlIGEgcG9zaXRpdmUgY3JlZGl0IGFtb3VudCcpO1xuICAgICAgcmV0dXJuIHtcbiAgICAgICAgb2s6IHRydWUsXG4gICAgICAgIGxpbmVzOiBsaW5lc09mKFtcbiAgICAgICAgICBbJ29wZXJhdGluZycsICdkZWJpdCcsIGdyb3NzQ2VudHMgLSBmZWVDZW50c10sXG4gICAgICAgICAgWydwcm92aWRlci1jb3N0JywgJ2RlYml0JywgZmVlQ2VudHNdLFxuICAgICAgICAgIFsndGF4LXJlc2VydmUnLCAnY3JlZGl0JywgdGF4Q2VudHNdLFxuICAgICAgICAgIFsnY3VzdG9tZXItY3JlZGl0LXJlc2VydmUnLCAnY3JlZGl0JywgZ3Jvc3NDZW50cyAtIHRheENlbnRzXSxcbiAgICAgICAgXSksXG4gICAgICB9O1xuICAgIH1cbiAgICBjYXNlICdyZWZ1bmQnOiB7XG4gICAgICBjb25zdCBiYWQgPSB3aG9sZUNlbnRzKCdhbW91bnRDZW50cycsIG1vdmVtZW50LmFtb3VudENlbnRzLCBmYWxzZSkgPz8gd2hvbGVDZW50cygndGF4Q2VudHMnLCBtb3ZlbWVudC50YXhDZW50cywgdHJ1ZSk7XG4gICAgICBpZiAoYmFkKSByZXR1cm4gYmFkO1xuICAgICAgaWYgKG1vdmVtZW50LnRheENlbnRzID4gbW92ZW1lbnQuYW1vdW50Q2VudHMpIHJldHVybiByZWplY3QoJ2ludmFsaWQtbW92ZW1lbnQnLCAncmVmdW5kZWQgdGF4IGV4Y2VlZHMgdGhlIHJlZnVuZCcpO1xuICAgICAgcmV0dXJuIHtcbiAgICAgICAgb2s6IHRydWUsXG4gICAgICAgIGxpbmVzOiBsaW5lc09mKFtcbiAgICAgICAgICBbJ3JlZnVuZC1jaGFyZ2ViYWNrLXJlc2VydmUnLCAnZGViaXQnLCBtb3ZlbWVudC5hbW91bnRDZW50cyAtIG1vdmVtZW50LnRheENlbnRzXSxcbiAgICAgICAgICBbJ3RheC1yZXNlcnZlJywgJ2RlYml0JywgbW92ZW1lbnQudGF4Q2VudHNdLFxuICAgICAgICAgIFsnb3BlcmF0aW5nJywgJ2NyZWRpdCcsIG1vdmVtZW50LmFtb3VudENlbnRzXSxcbiAgICAgICAgXSksXG4gICAgICB9O1xuICAgIH1cbiAgICBjYXNlICdjaGFyZ2ViYWNrJzoge1xuICAgICAgY29uc3QgYmFkID0gd2hvbGVDZW50cygnYW1vdW50Q2VudHMnLCBtb3ZlbWVudC5hbW91bnRDZW50cywgZmFsc2UpID8/IHdob2xlQ2VudHMoJ2ZlZUNlbnRzJywgbW92ZW1lbnQuZmVlQ2VudHMsIHRydWUpO1xuICAgICAgaWYgKGJhZCkgcmV0dXJuIGJhZDtcbiAgICAgIHJldHVybiB7XG4gICAgICAgIG9rOiB0cnVlLFxuICAgICAgICBsaW5lczogbGluZXNPZihbXG4gICAgICAgICAgWydyZWZ1bmQtY2hhcmdlYmFjay1yZXNlcnZlJywgJ2RlYml0JywgbW92ZW1lbnQuYW1vdW50Q2VudHNdLFxuICAgICAgICAgIFsncHJvdmlkZXItY29zdCcsICdkZWJpdCcsIG1vdmVtZW50LmZlZUNlbnRzXSxcbiAgICAgICAgICBbJ29wZXJhdGluZycsICdjcmVkaXQnLCBtb3ZlbWVudC5hbW91bnRDZW50cyArIG1vdmVtZW50LmZlZUNlbnRzXSxcbiAgICAgICAgXSksXG4gICAgICB9O1xuICAgIH1cbiAgICBjYXNlICdwcm92aWRlci1wYXltZW50JzpcbiAgICBjYXNlICdkYW8tdHJhbnNmZXInOlxuICAgIGNhc2UgJ3RheC1yZW1pdHRhbmNlJzoge1xuICAgICAgY29uc3QgYmFkID0gd2hvbGVDZW50cygnYW1vdW50Q2VudHMnLCBtb3ZlbWVudC5hbW91bnRDZW50cywgZmFsc2UpO1xuICAgICAgaWYgKGJhZCkgcmV0dXJuIGJhZDtcbiAgICAgIGNvbnN0IGRlYml0QWNjb3VudDogTW9uZXlKb3VybmFsQWNjb3VudCA9XG4gICAgICAgIG1vdmVtZW50LmtpbmQgPT09ICdwcm92aWRlci1wYXltZW50JyA/ICdwcm92aWRlci1jb3N0JyA6IG1vdmVtZW50LmtpbmQgPT09ICdkYW8tdHJhbnNmZXInID8gJ2Rhby1wYXlhYmxlJyA6ICd0YXgtcmVzZXJ2ZSc7XG4gICAgICByZXR1cm4ge1xuICAgICAgICBvazogdHJ1ZSxcbiAgICAgICAgbGluZXM6IGxpbmVzT2YoW1xuICAgICAgICAgIFtkZWJpdEFjY291bnQsICdkZWJpdCcsIG1vdmVtZW50LmFtb3VudENlbnRzXSxcbiAgICAgICAgICBbJ29wZXJhdGluZycsICdjcmVkaXQnLCBtb3ZlbWVudC5hbW91bnRDZW50c10sXG4gICAgICAgIF0pLFxuICAgICAgfTtcbiAgICB9XG4gICAgY2FzZSAndXNhZ2Utc2V0dGxlbWVudCc6IHtcbiAgICAgIGNvbnN0IGJhZCA9IHdob2xlQ2VudHMoJ2NlbnRzJywgbW92ZW1lbnQuY2VudHMsIGZhbHNlKSA/PyB3aG9sZUNlbnRzKCdkYW9DZW50cycsIG1vdmVtZW50LmRhb0NlbnRzLCB0cnVlKTtcbiAgICAgIGlmIChiYWQpIHJldHVybiBiYWQ7XG4gICAgICBpZiAobW92ZW1lbnQuZGFvQ2VudHMgPiBtb3ZlbWVudC5jZW50cykgcmV0dXJuIHJlamVjdCgnaW52YWxpZC1tb3ZlbWVudCcsICd0aGUgREFPIHNoYXJlIGV4Y2VlZHMgdGhlIHNldHRsZWQgY2VudHMnKTtcbiAgICAgIHJldHVybiB7XG4gICAgICAgIG9rOiB0cnVlLFxuICAgICAgICBsaW5lczogbGluZXNPZihbXG4gICAgICAgICAgWydjdXN0b21lci1jcmVkaXQtcmVzZXJ2ZScsICdkZWJpdCcsIG1vdmVtZW50LmNlbnRzXSxcbiAgICAgICAgICBbJ2Rhby1wYXlhYmxlJywgJ2NyZWRpdCcsIG1vdmVtZW50LmRhb0NlbnRzXSxcbiAgICAgICAgICBbJ3JldmVudWUnLCAnY3JlZGl0JywgbW92ZW1lbnQuY2VudHMgLSBtb3ZlbWVudC5kYW9DZW50c10sXG4gICAgICAgIF0pLFxuICAgICAgfTtcbiAgICB9XG4gICAgZGVmYXVsdDoge1xuICAgICAgY29uc3QgdW5rbm93bktpbmQ6IG5ldmVyID0gbW92ZW1lbnQ7XG4gICAgICByZXR1cm4gcmVqZWN0KCdpbnZhbGlkLW1vdmVtZW50JywgYHVua25vd24gbW92ZW1lbnQgJHtKU09OLnN0cmluZ2lmeSh1bmtub3duS2luZCl9YCk7XG4gICAgfVxuICB9XG59XG5cbmV4cG9ydCBpbnRlcmZhY2UgTW92ZW1lbnRFbnRyeUlucHV0IHtcbiAgcmVhZG9ubHkgZW50cnlJZDogc3RyaW5nO1xuICByZWFkb25seSBvY2N1cnJlZEF0TXM6IG51bWJlcjtcbiAgcmVhZG9ubHkgY3VycmVuY3k6IHN0cmluZztcbiAgcmVhZG9ubHkgZXh0ZXJuYWxSZWY6IEV4dGVybmFsUmVmO1xuICByZWFkb25seSBtZW1vPzogc3RyaW5nO1xuICByZWFkb25seSByb2xsdXBJZD86IHN0cmluZyB8IG51bGw7XG4gIHJlYWRvbmx5IG1vdmVtZW50OiBNb25leU1vdmVtZW50O1xufVxuXG4vKiogQnVpbGQgYW5kIHZhbGlkYXRlIHRoZSBqb3VybmFsIGVudHJ5IGZvciBvbmUgbW92ZW1lbnQuICovXG5leHBvcnQgZnVuY3Rpb24gam91cm5hbEVudHJ5Rm9yTW92ZW1lbnQoaW5wdXQ6IE1vdmVtZW50RW50cnlJbnB1dCk6IEpvdXJuYWxFbnRyeVZhbGlkYXRpb24ge1xuICBjb25zdCBidWlsdCA9IGpvdXJuYWxMaW5lc0Zvck1vdmVtZW50KGlucHV0Lm1vdmVtZW50KTtcbiAgaWYgKCFidWlsdC5vaykgcmV0dXJuIGJ1aWx0O1xuICByZXR1cm4gdmFsaWRhdGVKb3VybmFsRW50cnkoe1xuICAgIGVudHJ5SWQ6IGlucHV0LmVudHJ5SWQsXG4gICAgb2NjdXJyZWRBdE1zOiBpbnB1dC5vY2N1cnJlZEF0TXMsXG4gICAgY3VycmVuY3k6IGlucHV0LmN1cnJlbmN5LFxuICAgIG1vdmVtZW50OiBpbnB1dC5tb3ZlbWVudC5raW5kLFxuICAgIGV4dGVybmFsUmVmOiBpbnB1dC5leHRlcm5hbFJlZixcbiAgICBtZW1vOiBpbnB1dC5tZW1vID8/ICcnLFxuICAgIHJvbGx1cElkOiBpbnB1dC5yb2xsdXBJZCA/PyBudWxsLFxuICAgIGxpbmVzOiBidWlsdC5saW5lcyxcbiAgfSk7XG59XG5cbi8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuLy8gVGhlIGpvdXJuYWwgc3RhdGUgYW5kIHBvc3RpbmcuXG4vLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cblxuZXhwb3J0IGludGVyZmFjZSBNb25leUpvdXJuYWxTdGF0ZSB7XG4gIHJlYWRvbmx5IGN1cnJlbmN5OiBzdHJpbmc7XG4gIHJlYWRvbmx5IGVudHJpZXM6IHJlYWRvbmx5IEpvdXJuYWxFbnRyeVtdO1xuICByZWFkb25seSBlbnRyeUlkczogUmVhZG9ubHlTZXQ8c3RyaW5nPjtcbiAgLyoqIFNpZ25lZCBwZXIgYWNjb3VudCwgZGViaXQtcG9zaXRpdmUuICovXG4gIHJlYWRvbmx5IGJhbGFuY2VzQ2VudHM6IFJlYWRvbmx5PFJlY29yZDxNb25leUpvdXJuYWxBY2NvdW50LCBudW1iZXI+PjtcbiAgcmVhZG9ubHkgdG90YWxEZWJpdENlbnRzOiBudW1iZXI7XG4gIHJlYWRvbmx5IHRvdGFsQ3JlZGl0Q2VudHM6IG51bWJlcjtcbiAgLyoqIENlbnRzIGVhY2ggbWljcm9zIHJvbGwtdXAgaGFzIHNldHRsZWQgaW50byB0aGUgam91cm5hbC4gKi9cbiAgcmVhZG9ubHkgc2V0dGxlZENlbnRzQnlSb2xsdXA6IFJlYWRvbmx5PFJlY29yZDxzdHJpbmcsIG51bWJlcj4+O1xufVxuXG5mdW5jdGlvbiB6ZXJvQmFsYW5jZXMoKTogUmVjb3JkPE1vbmV5Sm91cm5hbEFjY291bnQsIG51bWJlcj4ge1xuICByZXR1cm4gT2JqZWN0LmZyb21FbnRyaWVzKE1PTkVZX0pPVVJOQUxfQUNDT1VOVFMubWFwKChhY2NvdW50KSA9PiBbYWNjb3VudCwgMF0pKSBhcyBSZWNvcmQ8TW9uZXlKb3VybmFsQWNjb3VudCwgbnVtYmVyPjtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIGVtcHR5TW9uZXlKb3VybmFsKGN1cnJlbmN5ID0gJ1VTRCcpOiBNb25leUpvdXJuYWxTdGF0ZSB7XG4gIGlmICghQ1VSUkVOQ1kudGVzdChjdXJyZW5jeSkpIHRocm93IG5ldyBFcnJvcihgZW1wdHlNb25leUpvdXJuYWw6IGludmFsaWQgY3VycmVuY3kgJHtjdXJyZW5jeX1gKTtcbiAgcmV0dXJuIHtcbiAgICBjdXJyZW5jeSxcbiAgICBlbnRyaWVzOiBbXSxcbiAgICBlbnRyeUlkczogbmV3IFNldCgpLFxuICAgIGJhbGFuY2VzQ2VudHM6IHplcm9CYWxhbmNlcygpLFxuICAgIHRvdGFsRGViaXRDZW50czogMCxcbiAgICB0b3RhbENyZWRpdENlbnRzOiAwLFxuICAgIHNldHRsZWRDZW50c0J5Um9sbHVwOiB7fSxcbiAgfTtcbn1cblxuZXhwb3J0IHR5cGUgUG9zdFJlc3VsdCA9IHsgb2s6IHRydWU7IHN0YXRlOiBNb25leUpvdXJuYWxTdGF0ZTsgZW50cnk6IEpvdXJuYWxFbnRyeSB9IHwgSm91cm5hbFJlamVjdGlvbjtcblxuLyoqIFBvc3Qgb25lIGVudHJ5LiBUaGUgcmV0dXJuZWQgc3RhdGUgaXMgbmV3OyB0aGUgaW5wdXQgc3RhdGUgaXMgbmV2ZXIgbXV0YXRlZC4gKi9cbmV4cG9ydCBmdW5jdGlvbiBwb3N0Sm91cm5hbEVudHJ5KHN0YXRlOiBNb25leUpvdXJuYWxTdGF0ZSwgcmF3OiB1bmtub3duKTogUG9zdFJlc3VsdCB7XG4gIGNvbnN0IHZhbGlkYXRlZCA9IHZhbGlkYXRlSm91cm5hbEVudHJ5KHJhdyk7XG4gIGlmICghdmFsaWRhdGVkLm9rKSByZXR1cm4gdmFsaWRhdGVkO1xuICBjb25zdCBlbnRyeSA9IHZhbGlkYXRlZC5lbnRyeTtcbiAgaWYgKGVudHJ5LmN1cnJlbmN5ICE9PSBzdGF0ZS5jdXJyZW5jeSkge1xuICAgIHJldHVybiByZWplY3QoJ2N1cnJlbmN5LW1pc21hdGNoJywgYHRoZSBqb3VybmFsIGlzIGluICR7c3RhdGUuY3VycmVuY3l9OyB0aGUgZW50cnkgaXMgaW4gJHtlbnRyeS5jdXJyZW5jeX1gKTtcbiAgfVxuICBpZiAoc3RhdGUuZW50cnlJZHMuaGFzKGVudHJ5LmVudHJ5SWQpKSByZXR1cm4gcmVqZWN0KCdkdXBsaWNhdGUtZW50cnknLCBgZW50cnkgJHtlbnRyeS5lbnRyeUlkfSBpcyBhbHJlYWR5IHBvc3RlZGApO1xuICBjb25zdCBiYWxhbmNlcyA9IHsgLi4uc3RhdGUuYmFsYW5jZXNDZW50cyB9O1xuICBsZXQgZGViaXQgPSBzdGF0ZS50b3RhbERlYml0Q2VudHM7XG4gIGxldCBjcmVkaXQgPSBzdGF0ZS50b3RhbENyZWRpdENlbnRzO1xuICBmb3IgKGNvbnN0IGxpbmUgb2YgZW50cnkubGluZXMpIHtcbiAgICBpZiAobGluZS5zaWRlID09PSAnZGViaXQnKSB7XG4gICAgICBiYWxhbmNlc1tsaW5lLmFjY291bnRdICs9IGxpbmUuY2VudHM7XG4gICAgICBkZWJpdCArPSBsaW5lLmNlbnRzO1xuICAgIH0gZWxzZSB7XG4gICAgICBiYWxhbmNlc1tsaW5lLmFjY291bnRdIC09IGxpbmUuY2VudHM7XG4gICAgICBjcmVkaXQgKz0gbGluZS5jZW50cztcbiAgICB9XG4gIH1cbiAgY29uc3Qgc2V0dGxlZCA9IHsgLi4uc3RhdGUuc2V0dGxlZENlbnRzQnlSb2xsdXAgfTtcbiAgaWYgKGVudHJ5LnJvbGx1cElkICE9PSBudWxsKSBzZXR0bGVkW2VudHJ5LnJvbGx1cElkXSA9IChzZXR0bGVkW2VudHJ5LnJvbGx1cElkXSA/PyAwKSArIGVudHJ5VG90YWxDZW50cyhlbnRyeSk7XG4gIGNvbnN0IGVudHJ5SWRzID0gbmV3IFNldChzdGF0ZS5lbnRyeUlkcyk7XG4gIGVudHJ5SWRzLmFkZChlbnRyeS5lbnRyeUlkKTtcbiAgcmV0dXJuIHtcbiAgICBvazogdHJ1ZSxcbiAgICBlbnRyeSxcbiAgICBzdGF0ZToge1xuICAgICAgY3VycmVuY3k6IHN0YXRlLmN1cnJlbmN5LFxuICAgICAgZW50cmllczogWy4uLnN0YXRlLmVudHJpZXMsIGVudHJ5XSxcbiAgICAgIGVudHJ5SWRzLFxuICAgICAgYmFsYW5jZXNDZW50czogYmFsYW5jZXMsXG4gICAgICB0b3RhbERlYml0Q2VudHM6IGRlYml0LFxuICAgICAgdG90YWxDcmVkaXRDZW50czogY3JlZGl0LFxuICAgICAgc2V0dGxlZENlbnRzQnlSb2xsdXA6IHNldHRsZWQsXG4gICAgfSxcbiAgfTtcbn1cblxuZXhwb3J0IGludGVyZmFjZSBUcmlhbEJhbGFuY2VBY2NvdW50IHtcbiAgcmVhZG9ubHkgYWNjb3VudDogTW9uZXlKb3VybmFsQWNjb3VudDtcbiAgcmVhZG9ubHkgbm9ybWFsU2lkZTogSm91cm5hbFNpZGU7XG4gIHJlYWRvbmx5IGRlYml0Q2VudHM6IG51bWJlcjtcbiAgcmVhZG9ubHkgY3JlZGl0Q2VudHM6IG51bWJlcjtcbiAgLyoqIEJhbGFuY2Ugb24gdGhlIGFjY291bnQncyBub3JtYWwgc2lkZSAocG9zaXRpdmUgPSBub3JtYWwpLiAqL1xuICByZWFkb25seSBiYWxhbmNlQ2VudHM6IG51bWJlcjtcbn1cblxuZXhwb3J0IGludGVyZmFjZSBUcmlhbEJhbGFuY2Uge1xuICByZWFkb25seSBjdXJyZW5jeTogc3RyaW5nO1xuICByZWFkb25seSBkZWJpdENlbnRzOiBudW1iZXI7XG4gIHJlYWRvbmx5IGNyZWRpdENlbnRzOiBudW1iZXI7XG4gIHJlYWRvbmx5IGJhbGFuY2VkOiBib29sZWFuO1xuICByZWFkb25seSBhY2NvdW50czogcmVhZG9ubHkgVHJpYWxCYWxhbmNlQWNjb3VudFtdO1xufVxuXG4vKiogUmVjb21wdXRlIGRlYml0cyBhbmQgY3JlZGl0cyBmcm9tIHRoZSBlbnRyaWVzIHRoZW1zZWx2ZXMgKG5vdCBmcm9tIHRoZSBydW5uaW5nIHRvdGFscykuICovXG5leHBvcnQgZnVuY3Rpb24gdHJpYWxCYWxhbmNlKGVudHJpZXM6IHJlYWRvbmx5IEpvdXJuYWxFbnRyeVtdLCBjdXJyZW5jeSA9ICdVU0QnKTogVHJpYWxCYWxhbmNlIHtcbiAgY29uc3QgZGViaXRzID0gemVyb0JhbGFuY2VzKCk7XG4gIGNvbnN0IGNyZWRpdHMgPSB6ZXJvQmFsYW5jZXMoKTtcbiAgZm9yIChjb25zdCBlbnRyeSBvZiBlbnRyaWVzKSB7XG4gICAgZm9yIChjb25zdCBsaW5lIG9mIGVudHJ5LmxpbmVzKSB7XG4gICAgICBpZiAobGluZS5zaWRlID09PSAnZGViaXQnKSBkZWJpdHNbbGluZS5hY2NvdW50XSArPSBsaW5lLmNlbnRzO1xuICAgICAgZWxzZSBjcmVkaXRzW2xpbmUuYWNjb3VudF0gKz0gbGluZS5jZW50cztcbiAgICB9XG4gIH1cbiAgY29uc3QgYWNjb3VudHMgPSBNT05FWV9KT1VSTkFMX0FDQ09VTlRTLm1hcCgoYWNjb3VudCkgPT4ge1xuICAgIGNvbnN0IG5vcm1hbFNpZGUgPSBBQ0NPVU5UX05PUk1BTF9TSURFW2FjY291bnRdO1xuICAgIGNvbnN0IG5ldCA9IGRlYml0c1thY2NvdW50XSAtIGNyZWRpdHNbYWNjb3VudF07XG4gICAgcmV0dXJuIHtcbiAgICAgIGFjY291bnQsXG4gICAgICBub3JtYWxTaWRlLFxuICAgICAgZGViaXRDZW50czogZGViaXRzW2FjY291bnRdLFxuICAgICAgY3JlZGl0Q2VudHM6IGNyZWRpdHNbYWNjb3VudF0sXG4gICAgICBiYWxhbmNlQ2VudHM6IG5vcm1hbFNpZGUgPT09ICdkZWJpdCcgPyBuZXQgOiAtbmV0LFxuICAgIH07XG4gIH0pO1xuICBjb25zdCBkZWJpdENlbnRzID0gYWNjb3VudHMucmVkdWNlKChzdW0sIGEpID0+IHN1bSArIGEuZGViaXRDZW50cywgMCk7XG4gIGNvbnN0IGNyZWRpdENlbnRzID0gYWNjb3VudHMucmVkdWNlKChzdW0sIGEpID0+IHN1bSArIGEuY3JlZGl0Q2VudHMsIDApO1xuICByZXR1cm4geyBjdXJyZW5jeSwgZGViaXRDZW50cywgY3JlZGl0Q2VudHMsIGJhbGFuY2VkOiBkZWJpdENlbnRzID09PSBjcmVkaXRDZW50cywgYWNjb3VudHMgfTtcbn1cblxuLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG4vLyBUaGUgbWljcm9zIHJvbGwtdXAgKG91dHNpZGUgdGhlIGpvdXJuYWwpLlxuLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG5cbmV4cG9ydCBpbnRlcmZhY2UgTWljcm9zUm9sbHVwIHtcbiAgcmVhZG9ubHkgcm9sbHVwSWQ6IHN0cmluZztcbiAgcmVhZG9ubHkgY3VycmVuY3k6IHN0cmluZztcbiAgLyoqIEV2ZXJ5IG1pY3JvIGFjY3J1ZWQgaW50byB0aGlzIHJvbGwtdXAsIGV2ZXIuICovXG4gIHJlYWRvbmx5IHRvdGFsTWljcm9zOiBudW1iZXI7XG4gIC8qKiBXaG9sZSBjZW50cyBhbHJlYWR5IHNldHRsZWQgaW50byB0aGUgam91cm5hbC4gKi9cbiAgcmVhZG9ubHkgc2V0dGxlZENlbnRzOiBudW1iZXI7XG4gIC8qKiBUaGUgcm91bmRpbmcgYWNjb3VudDogbWljcm9zIGFjY3J1ZWQgYnV0IG5vdCB5ZXQgYSBzZXR0bGVkIHdob2xlIGNlbnQuICovXG4gIHJlYWRvbmx5IHJvdW5kaW5nTWljcm9zOiBudW1iZXI7XG4gIC8qKiBDYW5vbmljYWwgZGVjaW1hbCBtaWNybyBhbW91bnRzIHdoZW4gdGhlIGludGVnZXIgcHJvamVjdGlvbiBoYXMgcmVzaWR1ZS4gKi9cbiAgcmVhZG9ubHkgdG90YWxNaWNyb3NFeGFjdD86IHN0cmluZztcbiAgcmVhZG9ubHkgcm91bmRpbmdNaWNyb3NFeGFjdD86IHN0cmluZztcbiAgcmVhZG9ubHkgYWNjcnVhbElkczogUmVhZG9ubHlTZXQ8c3RyaW5nPjtcbiAgcmVhZG9ubHkgYWNjcnVhbEFtb3VudHM/OiBSZWFkb25seU1hcDxzdHJpbmcsIHN0cmluZz47XG59XG5cbi8qKiBFeGFjdCBkZWNpbWFsIGFyaXRobWV0aWMgb24gdGhlIGV4aXN0aW5nIG1pY3JvIHJhaWwuIE5vIGJpbmFyeS1mbG9hdCBtb25leVxuICogYXJpdGhtZXRpYyBvciBmaXhlZCBOVU1FUklDIHNjYWxlOiBldmVuIHN1Ym5vcm1hbCBwcm92aWRlciBudW1iZXJzIHN1cnZpdmUuXG4gKiBFeHRlcm5hbCBjb250cmFjdHMgcmVxdWlyZSB0aGlzIGNhbm9uaWNhbCBmb3JtOyBQRyBudW1lcmljIHJlYWRzIG1heSBoYXZlXG4gKiB0cmFpbGluZyB6ZXJvZXMgYW5kIGFyZSBub3JtYWxpemVkIGhlcmUuICovXG5leHBvcnQgZnVuY3Rpb24gcGFyc2VNaWNyb3NEZWNpbWFsKHZhbHVlOiBzdHJpbmcpOiB7IGNvZWZmaWNpZW50OiBiaWdpbnQ7IHNjYWxlOiBudW1iZXIgfSB7XG4gIGlmICh0eXBlb2YgdmFsdWUgIT09ICdzdHJpbmcnIHx8ICEvXig/OjB8WzEtOV1bMC05XXswLDMxfSkoPzpcXC5bMC05XXsxLDMyNH0pPyQvLnRlc3QodmFsdWUpKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKCdpbnZhbGlkIGV4YWN0IG1pY3JvIGFtb3VudCcpO1xuICB9XG4gIGNvbnN0IFt3aG9sZSwgZnJhY3Rpb24gPSAnJ10gPSB2YWx1ZS5zcGxpdCgnLicpO1xuICByZXR1cm4geyBjb2VmZmljaWVudDogQmlnSW50KHdob2xlISArIGZyYWN0aW9uKSwgc2NhbGU6IGZyYWN0aW9uLmxlbmd0aCB9O1xufVxuZXhwb3J0IGZ1bmN0aW9uIGZvcm1hdE1pY3Jvc0RlY2ltYWwoY29lZmZpY2llbnQ6IGJpZ2ludCwgc2NhbGU6IG51bWJlcik6IHN0cmluZyB7XG4gIGlmIChjb2VmZmljaWVudCA8IDBuIHx8ICFOdW1iZXIuaXNJbnRlZ2VyKHNjYWxlKSB8fCBzY2FsZSA8IDAgfHwgc2NhbGUgPiAzMjQpIHRocm93IG5ldyBFcnJvcignaW52YWxpZCBleGFjdCBtaWNybyBhbW91bnQnKTtcbiAgY29uc3QgZGlnaXRzID0gY29lZmZpY2llbnQudG9TdHJpbmcoKS5wYWRTdGFydChzY2FsZSArIDEsICcwJyk7XG4gIGlmIChzY2FsZSA9PT0gMCkgcmV0dXJuIGRpZ2l0cztcbiAgY29uc3QgZnJhY3Rpb24gPSBkaWdpdHMuc2xpY2UoLXNjYWxlKS5yZXBsYWNlKC8wKyQvLCAnJyk7XG4gIHJldHVybiBkaWdpdHMuc2xpY2UoMCwgLXNjYWxlKSArIChmcmFjdGlvbiA/ICcuJyArIGZyYWN0aW9uIDogJycpO1xufVxuZXhwb3J0IGZ1bmN0aW9uIGFkZE1pY3Jvc0RlY2ltYWxzKC4uLnZhbHVlczogc3RyaW5nW10pOiBzdHJpbmcge1xuICBjb25zdCBhbW91bnRzID0gdmFsdWVzLm1hcChwYXJzZU1pY3Jvc0RlY2ltYWwpO1xuICBjb25zdCBzY2FsZSA9IE1hdGgubWF4KDAsIC4uLmFtb3VudHMubWFwKGEgPT4gYS5zY2FsZSkpO1xuICByZXR1cm4gZm9ybWF0TWljcm9zRGVjaW1hbChhbW91bnRzLnJlZHVjZSgoc3VtLCBhKSA9PiBzdW0gKyBhLmNvZWZmaWNpZW50ICogMTBuICoqIEJpZ0ludChzY2FsZSAtIGEuc2NhbGUpLCAwbiksIHNjYWxlKTtcbn1cbmV4cG9ydCBmdW5jdGlvbiBzcGxpdE1pY3Jvc0RlY2ltYWwodmFsdWU6IHN0cmluZyk6IHsgbWljcm9zOiBudW1iZXI7IGV4YWN0OiBzdHJpbmcgfSB7XG4gIGNvbnN0IHsgY29lZmZpY2llbnQsIHNjYWxlIH0gPSBwYXJzZU1pY3Jvc0RlY2ltYWwodmFsdWUpO1xuICBjb25zdCBkaXZpc29yID0gMTBuICoqIEJpZ0ludChzY2FsZSk7XG4gIGlmIChjb2VmZmljaWVudCA+IEJpZ0ludChOdW1iZXIuTUFYX1NBRkVfSU5URUdFUikgKiBkaXZpc29yKSB0aHJvdyBuZXcgRXJyb3IoJ21pY3JvIGFtb3VudCBleGNlZWRzIHNhZmUgaW50ZWdlciByYW5nZScpO1xuICByZXR1cm4geyBtaWNyb3M6IE51bWJlcihjb2VmZmljaWVudCAvIGRpdmlzb3IpLCBleGFjdDogZm9ybWF0TWljcm9zRGVjaW1hbChjb2VmZmljaWVudCwgc2NhbGUpIH07XG59XG5cbmV4cG9ydCB0eXBlIFJvbGx1cFJlamVjdGlvbkNvZGUgPSAnaW52YWxpZC1taWNyb3MnIHwgJ2R1cGxpY2F0ZS1hY2NydWFsJyB8ICdpbnZhbGlkLXJvbGx1cCcgfCAnY3VycmVuY3ktbWlzbWF0Y2gnO1xuZXhwb3J0IGludGVyZmFjZSBSb2xsdXBSZWplY3Rpb24ge1xuICByZWFkb25seSBvazogZmFsc2U7XG4gIHJlYWRvbmx5IGNvZGU6IFJvbGx1cFJlamVjdGlvbkNvZGUgfCBKb3VybmFsUmVqZWN0aW9uQ29kZTtcbiAgcmVhZG9ubHkgZGV0YWlsOiBzdHJpbmc7XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBlbXB0eU1pY3Jvc1JvbGx1cChyb2xsdXBJZDogc3RyaW5nLCBjdXJyZW5jeSA9ICdVU0QnKTogTWljcm9zUm9sbHVwIHtcbiAgaWYgKHJvbGx1cElkLmxlbmd0aCA9PT0gMCB8fCByb2xsdXBJZC5sZW5ndGggPiAyNTYpIHRocm93IG5ldyBFcnJvcignZW1wdHlNaWNyb3NSb2xsdXA6IHJvbGx1cElkIG11c3QgYmUgMS0yNTYgY2hhcmFjdGVycycpO1xuICBpZiAoIUNVUlJFTkNZLnRlc3QoY3VycmVuY3kpKSB0aHJvdyBuZXcgRXJyb3IoYGVtcHR5TWljcm9zUm9sbHVwOiBpbnZhbGlkIGN1cnJlbmN5ICR7Y3VycmVuY3l9YCk7XG4gIHJldHVybiB7IHJvbGx1cElkLCBjdXJyZW5jeSwgdG90YWxNaWNyb3M6IDAsIHNldHRsZWRDZW50czogMCwgcm91bmRpbmdNaWNyb3M6IDAsIGFjY3J1YWxJZHM6IG5ldyBTZXQoKSB9O1xufVxuXG5leHBvcnQgdHlwZSBBY2NydWVSZXN1bHQgPSB7IG9rOiB0cnVlOyByb2xsdXA6IE1pY3Jvc1JvbGx1cDsgZHVwbGljYXRlOiBib29sZWFuIH0gfCBSb2xsdXBSZWplY3Rpb247XG5cbi8qKlxuICogQWNjcnVlIGEgcGVyLXVzZSBjaGFyZ2UgaW4gbWljcm9zLiBJZGVtcG90ZW50IG9uIGBhY2NydWFsSWRgIChhIG1ldGVyIG5vbmNlKTpcbiAqIGEgcmVwZWF0ZWQgYWNjcnVhbCBpcyBhIG5vLW9wIHJlcG9ydGVkIGFzIGBkdXBsaWNhdGVgLCBuZXZlciBkb3VibGUtY291bnRlZC5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGFjY3J1ZU1pY3Jvcyhyb2xsdXA6IE1pY3Jvc1JvbGx1cCwgaW5wdXQ6IHsgcmVhZG9ubHkgYWNjcnVhbElkOiBzdHJpbmc7IHJlYWRvbmx5IG1pY3JvczogbnVtYmVyOyByZWFkb25seSBtaWNyb3NFeGFjdD86IHN0cmluZyB9KTogQWNjcnVlUmVzdWx0IHtcbiAgaWYgKHR5cGVvZiBpbnB1dC5hY2NydWFsSWQgIT09ICdzdHJpbmcnIHx8IGlucHV0LmFjY3J1YWxJZC5sZW5ndGggPT09IDAgfHwgaW5wdXQuYWNjcnVhbElkLmxlbmd0aCA+IDI1Nikge1xuICAgIHJldHVybiB7IG9rOiBmYWxzZSwgY29kZTogJ2ludmFsaWQtcm9sbHVwJywgZGV0YWlsOiAnYWNjcnVhbElkIG11c3QgYmUgYSBzdHJpbmcgb2YgMS0yNTYgY2hhcmFjdGVycycgfTtcbiAgfVxuICBsZXQgYW1vdW50OiBSZXR1cm5UeXBlPHR5cGVvZiBzcGxpdE1pY3Jvc0RlY2ltYWw+O1xuICB0cnkgeyBhbW91bnQgPSBzcGxpdE1pY3Jvc0RlY2ltYWwoaW5wdXQubWljcm9zRXhhY3QgPz8gU3RyaW5nKGlucHV0Lm1pY3JvcykpOyB9XG4gIGNhdGNoIHsgcmV0dXJuIHsgb2s6IGZhbHNlLCBjb2RlOiAnaW52YWxpZC1taWNyb3MnLCBkZXRhaWw6ICdpbnZhbGlkIGV4YWN0IG1pY3JvIGFtb3VudCcgfTsgfVxuICBpZiAoIU51bWJlci5pc1NhZmVJbnRlZ2VyKGlucHV0Lm1pY3JvcykgfHwgYW1vdW50Lm1pY3JvcyAhPT0gaW5wdXQubWljcm9zIHx8IGFtb3VudC5leGFjdCA9PT0gJzAnXG4gICAgICB8fCAoaW5wdXQubWljcm9zRXhhY3QgIT09IHVuZGVmaW5lZCAmJiBhbW91bnQuZXhhY3QgIT09IGlucHV0Lm1pY3Jvc0V4YWN0KSkge1xuICAgIHJldHVybiB7IG9rOiBmYWxzZSwgY29kZTogJ2ludmFsaWQtbWljcm9zJywgZGV0YWlsOiBgbWljcm9zIG11c3QgYmUgYSBwb3NpdGl2ZSB3aG9sZSBudW1iZXIsIGdvdCAke1N0cmluZyhpbnB1dC5taWNyb3MpfWAgfTtcbiAgfVxuICBpZiAocm9sbHVwLmFjY3J1YWxJZHMuaGFzKGlucHV0LmFjY3J1YWxJZCkpIHtcbiAgICBjb25zdCBwcmV2aW91cyA9IHJvbGx1cC5hY2NydWFsQW1vdW50cz8uZ2V0KGlucHV0LmFjY3J1YWxJZCk7XG4gICAgaWYgKHByZXZpb3VzICE9PSB1bmRlZmluZWQgJiYgcHJldmlvdXMgIT09IGFtb3VudC5leGFjdCkgcmV0dXJuIHsgb2s6IGZhbHNlLCBjb2RlOiAnaW52YWxpZC1taWNyb3MnLCBkZXRhaWw6ICdhY2NydWFsIHJlcGxheSBtaXNtYXRjaCcgfTtcbiAgICByZXR1cm4geyBvazogdHJ1ZSwgcm9sbHVwLCBkdXBsaWNhdGU6IHRydWUgfTtcbiAgfVxuICBsZXQgdG90YWw6IFJldHVyblR5cGU8dHlwZW9mIHNwbGl0TWljcm9zRGVjaW1hbD47IGxldCByb3VuZGluZzogUmV0dXJuVHlwZTx0eXBlb2Ygc3BsaXRNaWNyb3NEZWNpbWFsPjtcbiAgdHJ5IHtcbiAgICB0b3RhbCA9IHNwbGl0TWljcm9zRGVjaW1hbChhZGRNaWNyb3NEZWNpbWFscyhyb2xsdXAudG90YWxNaWNyb3NFeGFjdCA/PyBTdHJpbmcocm9sbHVwLnRvdGFsTWljcm9zKSwgYW1vdW50LmV4YWN0KSk7XG4gICAgcm91bmRpbmcgPSBzcGxpdE1pY3Jvc0RlY2ltYWwoYWRkTWljcm9zRGVjaW1hbHMocm9sbHVwLnJvdW5kaW5nTWljcm9zRXhhY3QgPz8gU3RyaW5nKHJvbGx1cC5yb3VuZGluZ01pY3JvcyksIGFtb3VudC5leGFjdCkpO1xuICB9IGNhdGNoIHsgcmV0dXJuIHsgb2s6IGZhbHNlLCBjb2RlOiAnaW52YWxpZC1taWNyb3MnLCBkZXRhaWw6ICdyb2xsLXVwIHRvdGFsIGV4Y2VlZHMgdGhlIHNhZmUgaW50ZWdlciByYW5nZScgfTsgfVxuICBjb25zdCBhY2NydWFsSWRzID0gbmV3IFNldChyb2xsdXAuYWNjcnVhbElkcyk7XG4gIGFjY3J1YWxJZHMuYWRkKGlucHV0LmFjY3J1YWxJZCk7XG4gIGNvbnN0IGFjY3J1YWxBbW91bnRzID0gbmV3IE1hcChyb2xsdXAuYWNjcnVhbEFtb3VudHMpOyBhY2NydWFsQW1vdW50cy5zZXQoaW5wdXQuYWNjcnVhbElkLCBhbW91bnQuZXhhY3QpO1xuICByZXR1cm4ge1xuICAgIG9rOiB0cnVlLFxuICAgIGR1cGxpY2F0ZTogZmFsc2UsXG4gICAgcm9sbHVwOiB7IC4uLnJvbGx1cCwgdG90YWxNaWNyb3M6IHRvdGFsLm1pY3Jvcywgcm91bmRpbmdNaWNyb3M6IHJvdW5kaW5nLm1pY3JvcyxcbiAgICAgIHRvdGFsTWljcm9zRXhhY3Q6IHRvdGFsLmV4YWN0LmluY2x1ZGVzKCcuJykgPyB0b3RhbC5leGFjdCA6IHVuZGVmaW5lZCxcbiAgICAgIHJvdW5kaW5nTWljcm9zRXhhY3Q6IHJvdW5kaW5nLmV4YWN0LmluY2x1ZGVzKCcuJykgPyByb3VuZGluZy5leGFjdCA6IHVuZGVmaW5lZCwgYWNjcnVhbElkcywgYWNjcnVhbEFtb3VudHMgfSxcbiAgfTtcbn1cblxuLyoqIFNwbGl0IHdob2xlIGNlbnRzIGJldHdlZW4gdGhlIERBTyBhbmQgcmV2ZW51ZTogdGhlIERBTyBnZXRzIGZsb29yKGNlbnRzIHggYnBzIC8gMTAsMDAwKS4gKi9cbmV4cG9ydCBmdW5jdGlvbiBkYW9TaGFyZUNlbnRzKGNlbnRzOiBudW1iZXIsIGRhb0Jhc2lzUG9pbnRzOiBudW1iZXIpOiBudW1iZXIge1xuICBpZiAoIU51bWJlci5pc1NhZmVJbnRlZ2VyKGRhb0Jhc2lzUG9pbnRzKSB8fCBkYW9CYXNpc1BvaW50cyA8IDAgfHwgZGFvQmFzaXNQb2ludHMgPiAxMF8wMDApIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoYGRhb1NoYXJlQ2VudHM6IGJhc2lzIHBvaW50cyBtdXN0IGJlIDAtMTAwMDAsIGdvdCAke2Rhb0Jhc2lzUG9pbnRzfWApO1xuICB9XG4gIHJldHVybiBNYXRoLmZsb29yKChjZW50cyAqIGRhb0Jhc2lzUG9pbnRzKSAvIDEwXzAwMCk7XG59XG5cbmV4cG9ydCBpbnRlcmZhY2UgU2V0dGxlUm9sbHVwSW5wdXQge1xuICByZWFkb25seSBlbnRyeUlkOiBzdHJpbmc7XG4gIHJlYWRvbmx5IG9jY3VycmVkQXRNczogbnVtYmVyO1xuICByZWFkb25seSBleHRlcm5hbFJlZjogRXh0ZXJuYWxSZWY7XG4gIHJlYWRvbmx5IGRhb0Jhc2lzUG9pbnRzOiBudW1iZXI7XG4gIHJlYWRvbmx5IG1lbW8/OiBzdHJpbmc7XG59XG5cbmV4cG9ydCB0eXBlIFNldHRsZVJlc3VsdCA9XG4gIHwgeyBvazogdHJ1ZTsgam91cm5hbDogTW9uZXlKb3VybmFsU3RhdGU7IHJvbGx1cDogTWljcm9zUm9sbHVwOyBzZXR0bGVkQ2VudHM6IG51bWJlcjsgZW50cnk6IEpvdXJuYWxFbnRyeSB8IG51bGwgfVxuICB8IFJvbGx1cFJlamVjdGlvbjtcblxuLyoqXG4gKiBTZXR0bGUgdGhlIHJvbGwtdXAncyB3aG9sZSBjZW50cyBpbnRvIHRoZSBqb3VybmFsIGFzIG9uZSBgdXNhZ2Utc2V0dGxlbWVudGBcbiAqIGVudHJ5LiBUaGUgc3ViLWNlbnQgcmVtYWluZGVyIHN0YXlzIGluIHRoZSByb3VuZGluZyBiYWxhbmNlLiBTZXR0bGluZyBhXG4gKiByb2xsLXVwIGhvbGRpbmcgbGVzcyB0aGFuIGEgY2VudCBwb3N0cyBub3RoaW5nLlxuICovXG5leHBvcnQgZnVuY3Rpb24gc2V0dGxlUm9sbHVwSW50b0pvdXJuYWwoam91cm5hbDogTW9uZXlKb3VybmFsU3RhdGUsIHJvbGx1cDogTWljcm9zUm9sbHVwLCBpbnB1dDogU2V0dGxlUm9sbHVwSW5wdXQpOiBTZXR0bGVSZXN1bHQge1xuICBpZiAocm9sbHVwLmN1cnJlbmN5ICE9PSBqb3VybmFsLmN1cnJlbmN5KSB7XG4gICAgcmV0dXJuIHsgb2s6IGZhbHNlLCBjb2RlOiAnY3VycmVuY3ktbWlzbWF0Y2gnLCBkZXRhaWw6IGByb2xsLXVwIGlzIGluICR7cm9sbHVwLmN1cnJlbmN5fTsgdGhlIGpvdXJuYWwgaXMgaW4gJHtqb3VybmFsLmN1cnJlbmN5fWAgfTtcbiAgfVxuICBjb25zdCBjZW50cyA9IE1hdGguZmxvb3Iocm9sbHVwLnJvdW5kaW5nTWljcm9zIC8gTUlDUk9TX1BFUl9DRU5UKTtcbiAgaWYgKGNlbnRzID09PSAwKSByZXR1cm4geyBvazogdHJ1ZSwgam91cm5hbCwgcm9sbHVwLCBzZXR0bGVkQ2VudHM6IDAsIGVudHJ5OiBudWxsIH07XG4gIGNvbnN0IGJ1aWx0ID0gam91cm5hbEVudHJ5Rm9yTW92ZW1lbnQoe1xuICAgIGVudHJ5SWQ6IGlucHV0LmVudHJ5SWQsXG4gICAgb2NjdXJyZWRBdE1zOiBpbnB1dC5vY2N1cnJlZEF0TXMsXG4gICAgY3VycmVuY3k6IGpvdXJuYWwuY3VycmVuY3ksXG4gICAgZXh0ZXJuYWxSZWY6IGlucHV0LmV4dGVybmFsUmVmLFxuICAgIG1lbW86IGlucHV0Lm1lbW8gPz8gJycsXG4gICAgcm9sbHVwSWQ6IHJvbGx1cC5yb2xsdXBJZCxcbiAgICBtb3ZlbWVudDogeyBraW5kOiAndXNhZ2Utc2V0dGxlbWVudCcsIGNlbnRzLCBkYW9DZW50czogZGFvU2hhcmVDZW50cyhjZW50cywgaW5wdXQuZGFvQmFzaXNQb2ludHMpIH0sXG4gIH0pO1xuICBpZiAoIWJ1aWx0Lm9rKSByZXR1cm4gYnVpbHQ7XG4gIGNvbnN0IHBvc3RlZCA9IHBvc3RKb3VybmFsRW50cnkoam91cm5hbCwgYnVpbHQuZW50cnkpO1xuICBpZiAoIXBvc3RlZC5vaykgcmV0dXJuIHBvc3RlZDtcbiAgcmV0dXJuIHtcbiAgICBvazogdHJ1ZSxcbiAgICBqb3VybmFsOiBwb3N0ZWQuc3RhdGUsXG4gICAgZW50cnk6IHBvc3RlZC5lbnRyeSxcbiAgICBzZXR0bGVkQ2VudHM6IGNlbnRzLFxuICAgIHJvbGx1cDoge1xuICAgICAgLi4ucm9sbHVwLFxuICAgICAgc2V0dGxlZENlbnRzOiByb2xsdXAuc2V0dGxlZENlbnRzICsgY2VudHMsXG4gICAgICByb3VuZGluZ01pY3Jvczogcm9sbHVwLnJvdW5kaW5nTWljcm9zIC0gY2VudHMgKiBNSUNST1NfUEVSX0NFTlQsXG4gICAgICByb3VuZGluZ01pY3Jvc0V4YWN0OiByb2xsdXAucm91bmRpbmdNaWNyb3NFeGFjdCA9PT0gdW5kZWZpbmVkID8gdW5kZWZpbmVkXG4gICAgICAgIDogZm9ybWF0TWljcm9zRGVjaW1hbChwYXJzZU1pY3Jvc0RlY2ltYWwocm9sbHVwLnJvdW5kaW5nTWljcm9zRXhhY3QpLmNvZWZmaWNpZW50XG4gICAgICAgICAgLSBCaWdJbnQoY2VudHMgKiBNSUNST1NfUEVSX0NFTlQpICogMTBuICoqIEJpZ0ludChwYXJzZU1pY3Jvc0RlY2ltYWwocm9sbHVwLnJvdW5kaW5nTWljcm9zRXhhY3QpLnNjYWxlKSxcbiAgICAgICAgcGFyc2VNaWNyb3NEZWNpbWFsKHJvbGx1cC5yb3VuZGluZ01pY3Jvc0V4YWN0KS5zY2FsZSksXG4gICAgfSxcbiAgfTtcbn1cblxuZXhwb3J0IGludGVyZmFjZSBSb2xsdXBJbnZhcmlhbnQge1xuICByZWFkb25seSByb2xsdXBJZDogc3RyaW5nO1xuICByZWFkb25seSB0b3RhbE1pY3JvczogbnVtYmVyO1xuICByZWFkb25seSBqb3VybmFsQ2VudHM6IG51bWJlcjtcbiAgcmVhZG9ubHkgcm91bmRpbmdNaWNyb3M6IG51bWJlcjtcbiAgcmVhZG9ubHkgdG90YWxNaWNyb3NFeGFjdD86IHN0cmluZztcbiAgcmVhZG9ubHkgcm91bmRpbmdNaWNyb3NFeGFjdD86IHN0cmluZztcbiAgLyoqIGpvdXJuYWxDZW50cyB4IDEwLDAwMCArIHJvdW5kaW5nTWljcm9zID0gdG90YWxNaWNyb3MsIGFuZCB0aGUgcm9sbC11cCBhZ3JlZXMgd2l0aCB0aGUgam91cm5hbCBvbiBzZXR0bGVkIGNlbnRzLiAqL1xuICByZWFkb25seSBob2xkczogYm9vbGVhbjtcbn1cblxuLyoqIFRoZSBSLTMwIGlkZW50aXR5IGZvciBvbmUgcm9sbC11cCwgY29tcHV0ZWQgZnJvbSB0aGUgam91cm5hbCdzIG93biBlbnRyaWVzLiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHJvbGx1cEludmFyaWFudChlbnRyaWVzOiByZWFkb25seSBKb3VybmFsRW50cnlbXSwgcm9sbHVwOiBNaWNyb3NSb2xsdXApOiBSb2xsdXBJbnZhcmlhbnQge1xuICBjb25zdCBqb3VybmFsQ2VudHMgPSBlbnRyaWVzXG4gICAgLmZpbHRlcigoZW50cnkpID0+IGVudHJ5LnJvbGx1cElkID09PSByb2xsdXAucm9sbHVwSWQpXG4gICAgLnJlZHVjZSgoc3VtLCBlbnRyeSkgPT4gc3VtICsgZW50cnlUb3RhbENlbnRzKGVudHJ5KSwgMCk7XG4gIGxldCBleGFjdEhvbGRzID0gZmFsc2U7XG4gIHRyeSB7XG4gICAgY29uc3QgdG90YWwgPSBzcGxpdE1pY3Jvc0RlY2ltYWwocm9sbHVwLnRvdGFsTWljcm9zRXhhY3QgPz8gU3RyaW5nKHJvbGx1cC50b3RhbE1pY3JvcykpO1xuICAgIGNvbnN0IHJvdW5kaW5nID0gc3BsaXRNaWNyb3NEZWNpbWFsKHJvbGx1cC5yb3VuZGluZ01pY3Jvc0V4YWN0ID8/IFN0cmluZyhyb2xsdXAucm91bmRpbmdNaWNyb3MpKTtcbiAgICBleGFjdEhvbGRzID0gdG90YWwubWljcm9zID09PSByb2xsdXAudG90YWxNaWNyb3MgJiYgcm91bmRpbmcubWljcm9zID09PSByb2xsdXAucm91bmRpbmdNaWNyb3NcbiAgICAgICYmIGFkZE1pY3Jvc0RlY2ltYWxzKFN0cmluZyhqb3VybmFsQ2VudHMgKiBNSUNST1NfUEVSX0NFTlQpLCByb3VuZGluZy5leGFjdCkgPT09IHRvdGFsLmV4YWN0O1xuICB9IGNhdGNoIHsgLyogSW52YWxpZCBvciBvdmVyZmxvd2luZyBleGFjdCBhbW91bnRzIGRvIG5vdCBzYXRpc2Z5IHRoZSBpZGVudGl0eS4gKi8gfVxuICByZXR1cm4ge1xuICAgIHJvbGx1cElkOiByb2xsdXAucm9sbHVwSWQsXG4gICAgdG90YWxNaWNyb3M6IHJvbGx1cC50b3RhbE1pY3JvcyxcbiAgICBqb3VybmFsQ2VudHMsXG4gICAgcm91bmRpbmdNaWNyb3M6IHJvbGx1cC5yb3VuZGluZ01pY3JvcyxcbiAgICB0b3RhbE1pY3Jvc0V4YWN0OiByb2xsdXAudG90YWxNaWNyb3NFeGFjdCxcbiAgICByb3VuZGluZ01pY3Jvc0V4YWN0OiByb2xsdXAucm91bmRpbmdNaWNyb3NFeGFjdCxcbiAgICBob2xkczpcbiAgICAgIGpvdXJuYWxDZW50cyAqIE1JQ1JPU19QRVJfQ0VOVCArIHJvbGx1cC5yb3VuZGluZ01pY3JvcyA9PT0gcm9sbHVwLnRvdGFsTWljcm9zICYmXG4gICAgICBqb3VybmFsQ2VudHMgPT09IHJvbGx1cC5zZXR0bGVkQ2VudHMgJiZcbiAgICAgIHJvbGx1cC5yb3VuZGluZ01pY3JvcyA+PSAwICYmIGV4YWN0SG9sZHMsXG4gIH07XG59XG4iXSwiZmlsZSI6Ii9AZnMvaG9tZS9tYXJzaC1vZmZpY2UvcGFwZXJjdXBhaS13b3Jrc3BhY2UvcGFwZXJjdXNwL3BhY2thZ2VzL29wZXJhdG9yLWNvcmUvbGliL2N1cGJvYXJkL21vbmV5LWpvdXJuYWwudHMifQ==

//# vitestCache=W3siZmlsZSI6IjEiLCJpZCI6IjEiLCJ1cmwiOiIyIiwiaW1wb3J0ZWRVcmxzIjoiMyIsIm1hcHBpbmdzIjpmYWxzZX0sIi9ob21lL21hcnNoLW9mZmljZS9wYXBlcmN1cGFpLXdvcmtzcGFjZS9wYXBlcmN1c3AvcGFja2FnZXMvb3BlcmF0b3ItY29yZS9saWIvY3VwYm9hcmQvbW9uZXktam91cm5hbC50cyIsIi9AZnMvaG9tZS9tYXJzaC1vZmZpY2UvcGFwZXJjdXBhaS13b3Jrc3BhY2UvcGFwZXJjdXNwL3BhY2thZ2VzL29wZXJhdG9yLWNvcmUvbGliL2N1cGJvYXJkL21vbmV5LWpvdXJuYWwudHMiLFtdXQ==