---
rel_path: "evidence/c52-luna-r1-20261106/live-gate12-source-clearer-qualification-20261108-v1.json"
updated_at: 1794167213620
_body: "content"
---

{
  "schemaVersion": "luna-r1-live-gate12-source-clearer-qualification-v1",
  "workItem": "WI-6554700010045700",
  "generatedAt": "2026-11-08T19:46:31.408876+00:00",
  "scope": "Exact original 12 live-gate-ops restrictions using saved evidence and current static source only; no LIVE_GATE_OPS, gate status read or peer monitoring.",
  "inputs": [
    {
      "path": "/home/marsh-office/.papercusp/evidence/c52-luna-r1-20261106/causal-ledger-v4.jsonl",
      "sha256": "7f1962fb5c22f1bc2be9625406b315f6b5f4fd190b4743d7f972a4fb2c935866"
    },
    {
      "path": "/home/marsh-office/papercupai-workspace/papercusp/.papercusp/evidence/c52-luna-r1-20261106/control-reconciliation-20261108T1520Z.jsonl",
      "sha256": "d04302cfc9978475fc458970e7fa6659443ca0465cdc377d47bfecf820cd0960"
    },
    {
      "path": "/home/marsh-office/papercupai-workspace/papercusp/.papercusp/evidence/c52-luna-r1-20261106/control-reconciliation-metadata-20261108T1520Z.json",
      "sha256": "492721ebaeb4c53ed059da741fb18b431402fa13eac902b9dd647581555b734b"
    },
    {
      "path": "/home/marsh-office/papercupai-workspace/papercusp/.papercusp/evidence/c52-luna-r1-20261106/causal-qualification-20261107T1800Z.jsonl",
      "sha256": "a4b3b764123263d73e1b871719ebfa5a9c9d1b5fac9ff5a883076919e4e6ce16"
    },
    {
      "path": "/home/marsh-office/.papercusp/evidence/c52-luna-r1-20261106/restriction-authority-registry-v1.json",
      "sha256": "1b51f4be4a288749652dfaf9f7c7d4547aae962dd0d33a798f8e729f9e49dfbe"
    }
  ],
  "savedControlBatches": [
    {
      "artifact": "papercusp:evidence/c52-luna-r1-20261106/current-control-20261108-batch14.json",
      "localPath": "/tmp/c52-r1-current-control-20261108-batch14.json",
      "sha256": "d507976d876a183f14b74136e39390164d0e2e2322427b4d64705c2a5be9c936",
      "observedAt": "2026-11-08 15:02:23.578069+00",
      "population": 400
    }
  ],
  "counts": {
    "population": 12,
    "frozenHashesVerified": 12,
    "datedKeysBound": 12,
    "metrics": {
      "red-adding-admission": 4,
      "round-cycle-time": 4,
      "time-since-verdict": 2,
      "queue-idle": 2
    },
    "savedNovember8States": {
      "open": 10,
      "blocked": 2
    },
    "savedNovember8DurableParks": 11,
    "savedNovember7LiveGateFloorPresent": 12
  },
  "sourceWitnesses": [
    {
      "path": "packages/operator-core/lib/work-items-admission.ts",
      "sha256": "30b3bf5fb6ada5d380ed0ca0ee478e2aceb7592f31d8b2737995a51388135f34",
      "startLine": 1497,
      "endLine": 1602,
      "excerpt": "export const GATE_RED_STREAK_CONDITION_PREFIX = 'gate-red-streak:';\n\n/**\n * Condition singletons that OWN live release-gate operations. They are ordinary\n * issue-family bugs so the stop-the-line repair exemption correctly keeps the\n * repair LANE flowing, but the singleton itself must never circulate through\n * opportunistic self-select: exactly one registered gate fixer claims it by id.\n *\n * Keep this list intentionally narrower than ACTIONABLE_CONDITION_PREFIXES.\n * Most actionable alarms are normal repair work; only these two prefixes (plus the\n * live-gate green-main-slo metrics below) carry the live gate-control-plane\n * exclusivity contract (release/gate-red-ownership).\n */\nexport const LIVE_GATE_OPS_CONDITION_PREFIXES = [GATE_RED_STREAK_CONDITION_PREFIX, 'green-stall:'] as const;\n\n/**\n * Key prefix of the green-main-slo watchdog's alarm items. The full key is\n * `alarm:green-main-slo:` + encodeURIComponent(JSON.stringify([workspace, install,\n * metric, episode, subject])) — built by greenMainSloConditionKey in\n * release/green-main-slo-watchdog.ts, whose real output the tests pin against.\n */\nexport const GREEN_MAIN_SLO_CONDITION_PREFIX = 'alarm:green-main-slo:';\n\n/**\n * Which green-main-slo breach metrics are LIVE_GATE_OPS. EI-27062367026577459: these\n * alarm rows were bridge-minted as ordinary bugs, so self-select handed them to generic\n * fleet members who each claimed, found the gate held by its live fixer, and released.\n * One row took 18 claims from 7 holders in 6h. An exhaustive Record so a new metric is\n * a compile-time decision, never a silent default.\n *  - time-since-green / time-since-verdict: the gate has no green or no verdict; greening\n *    and re-running it is the live fixer's job.\n *  - red-adding-admission / round-cycle-time / queue-idle: the subject is the frozen\n *    repair-queue candidate, so the remedy is repair-queue mutation.\n *  - per-sync-red-rate: the subject is a sync fleet whose commits add reds; that is\n *    ordinary repair work for the fleet, not the gate's control plane.\n *  - non-verdict-reason: the watchdog files these as reason items ASSIGNED to the live\n *    gate owner; the alarm row records why runs fail to conclude (GATE_SYSTEM_DEV).\n * The watchdog resolves each alarm itself on measured recovery, so a reserved row\n * never needs a self-selecting claimant to close.\n */\nconst GREEN_MAIN_SLO_METRIC_IS_LIVE_GATE_OPS: Readonly<Record<GreenMainSloBreachMetric, boolean>> = {\n  'time-since-green': true,\n  'time-since-verdict': true,\n  'red-adding-admission': true,\n  'round-cycle-time': true,\n  'queue-idle': true,\n  'per-sync-red-rate': false,\n  'non-verdict-reason': false,\n};\n\nexport const LIVE_GATE_OPS_GREEN_MAIN_SLO_METRICS: readonly GreenMainSloBreachMetric[] = (\n  Object.keys(GREEN_MAIN_SLO_METRIC_IS_LIVE_GATE_OPS) as GreenMainSloBreachMetric[]\n).filter((metric) => GREEN_MAIN_SLO_METRIC_IS_LIVE_GATE_OPS[metric]);\n\n/** The metric's encoded slot inside a green-main-slo key: `,\"<metric>\",` (third array element). */\nconst greenMainSloMetricNeedle = (metric: string): string => encodeURIComponent(`,\"${metric}\",`);\n\n/** Escape LIKE metacharacters for Postgres' default backslash escape. */\nconst likeLiteral = (text: string): string => text.replace(/[\\\\%_]/g, (c) => `\\\\${c}`);\n\n/**\n * The LIKE patterns the reservation floor excludes from self-select: every\n * LIVE_GATE_OPS singleton prefix, plus one pattern per live-gate green-main-slo metric.\n * The encoded key itself contains `%`, so each literal segment is escaped.\n */\nexport function liveGateOpsReservedPatterns(): string[] {\n  return [\n    ...LIVE_GATE_OPS_CONDITION_PREFIXES.map((prefix) => `${likeLiteral(prefix)}%`),\n    ...LIVE_GATE_OPS_GREEN_MAIN_SLO_METRICS.map(\n      (metric) => `${likeLiteral(GREEN_MAIN_SLO_CONDITION_PREFIX)}%${likeLiteral(greenMainSloMetricNeedle(metric))}%`,\n    ),\n  ];\n}\n\n/** JS form of {@link liveGateOpsSelfSelectExclusionSql}'s reservation (TRUE = reserved). */\nexport function isLiveGateOpsConditionKey(conditionKey: string | null | undefined): boolean {\n  if (!conditionKey) return false;\n  if (LIVE_GATE_OPS_CONDITION_PREFIXES.some((prefix) => conditionKey.startsWith(prefix))) return true;\n  return conditionKey.startsWith(GREEN_MAIN_SLO_CONDITION_PREFIX) &&\n    LIVE_GATE_OPS_GREEN_MAIN_SLO_METRICS.some((metric) => conditionKey.includes(greenMainSloMetricNeedle(metric)));\n}\n\n/**\n * TRUE means an issue row may survive the LIVE_GATE_OPS reservation floor.\n * This fragment is composed only into issue-family SELF-SELECT reads/writes;\n * the named claim-by-id path deliberately bypasses it, which is how the\n * registered live gate fixer acquires the singleton.\n */\nexport function liveGateOpsSelfSelectExclusionSql(sql: OrgSql) {\n  return sql`(\n    wi.condition_key IS NULL\n    OR NOT (wi.condition_key LIKE ANY(${liveGateOpsReservedPatterns()}::text[]))\n  )`;\n}\n\n/** Static per-id refusal text; unlike stop-the-line, no harness-specific value is needed. */\nexport function liveGateOpsSelfSelectExplanation(): string {\n  return (\n    'LIVE_GATE_OPS condition (gate-red-streak: or green-stall: singleton, or an ' +\n    `alarm:green-main-slo: ${LIVE_GATE_OPS_GREEN_MAIN_SLO_METRICS.join('/')} alarm) — reserved to the ` +\n    'one registered live gate fixer and excluded from opportunistic self-select. A leader/owner ' +\n    'may still dispatch or claim it BY ID after checking gate.greenCheckpoint.ownership.'\n  );\n}\n\n/**\n"
    },
    {
      "path": "packages/operator-core/lib/work-items.ts",
      "sha256": "75d40cfbd5d8eb2cd19e2707ee28999dde1ff1d786fc912515b75d2a7e178967",
      "startLine": 9090,
      "endLine": 9120,
      "excerpt": "    // predicate (no PRESENT non-terminal blocker across BOTH families). One readiness source\n    // of truth with the issue-claim path, so this never drifts from what claim_next serves.\n    const issueReadyRows = await sql<{ n: number }[]>`\n      SELECT count(*)::int AS n\n        FROM harness_shared.work_items wi\n       WHERE wi.item_kind IN (${sql.unsafe(ISSUE_FAMILY_KINDS_SQL_LIST)})\n         AND wi.workspace_id = ${issueWs}\n         AND (wi.harness_slug = ${filter.harness} OR wi.harness_slug = ${operatorScopeSlug})\n         AND (wi.taken_by IS NULL OR btrim(wi.taken_by) = '' OR lower(btrim(wi.taken_by)) = 'unassigned')\n         AND wi.status = ANY(${issueStates}::text[])\n         -- work-item-status-full-unify: mirror claimNextIssueWorkItem's origin floor (own-node aware)\n         -- so READY counts what the claim actually serves. Previously this query had NO origin floor\n         -- at all → it over-counted true-remote issues as ready while the claim (origin='local')\n         -- refused them (a \"ready>0 but claim keeps missing\" hot-retry mismatch). Now both admit\n         -- exactly (origin local/null OR our own-node author key).\n         AND ${isIssueLocallyClaimableWhereSql(sql, issueWs)}\n         AND ${admittedWhereSqlWi(sql)}\n         -- EI-22685972259555805: live gate-control condition singletons belong to the\n         -- one registered LIVE_GATE_OPS fixer, never the opportunistic issue pool.\n         -- Keep them in POOL (real work exists) but out of READY; an explicit by-id\n         -- claim remains the ownership-aware escape.\n         AND ${liveGateOpsSelfSelectExclusionSql(sql)}\n         AND ${filter.swarmId ? sql`(wi.swarm_affinity IS NULL OR wi.swarm_affinity = ${filter.swarmId})` : sql`TRUE`}\n         AND ${filter.excludeRedundant ? sql`(wi.redundancy IS NULL OR wi.redundancy <= 1)` : sql`TRUE`}\n         -- The blocking floor, from the ONE shared definition (D-007). This is the READY\n         -- diagnosis, so it must apply exactly what claimNextIssueWorkItem enforces — the\n         -- same reason the reserved-plan-lane comment below gives: \"the miss diagnosis never\n         -- disagrees with what claim_next actually serves\". Sharing the fragment is what\n         -- makes that promise structural rather than a convention two copies have to keep.\n         AND ${depsBlockedExclusionSql(sql)}\n         -- WI-2118 (P-009 leak): a reserved-plan-lane item is NOT ready to self-select — count it\n"
    },
    {
      "path": "packages/operator-core/lib/work-items.ts",
      "sha256": "75d40cfbd5d8eb2cd19e2707ee28999dde1ff1d786fc912515b75d2a7e178967",
      "startLine": 9360,
      "endLine": 9400,
      "excerpt": "    issueWs: string;\n    assignee: string;\n    cooldown: number;\n    rigAvailable?: boolean;\n    claimantFleetSlug?: string;\n    claimSpecReferencesFleet?: boolean;\n    claimSpecReferencesGoal?: boolean;\n    /** Complete identity set selected by the enclosing read, never a display cap. */\n    candidateIds?: readonly string[];\n  },\n) {\n  const {\n    issueWs,\n    assignee,\n    cooldown,\n    rigAvailable,\n    claimantFleetSlug,\n    claimSpecReferencesFleet,\n    claimSpecReferencesGoal,\n  } = opts;\n  return sql`\n    (wi.taken_by IS NULL OR wi.taken_by = '')                              AS ok_untaken,\n    (${isIssueLocallyClaimableWhereSql(sql, issueWs)})                     AS ok_origin,\n    (${admittedWhereSqlWi(sql)})                                           AS ok_admission,\n    (${failOpenExclusionSql(sql, 'wi')})                                   AS admission_fail_open_exclusion,\n    (${liveGateOpsSelfSelectExclusionSql(sql)})                            AS ok_live_gate_ops,\n    (${observationLaneExclusionSql(sql)})                                  AS ok_observation,\n    (${needsOwnerActionExclusionSql(sql)})                                 AS ok_needs_owner_action,\n    (${intakeStageClaimFloorSql(sql)})                                AS ok_agent_review,\n    (${externalBlockersExclusionSql(sql)})                                 AS ok_external_blocker,\n    (${claimHoldExclusionSql(sql)})                                        AS ok_claim_hold,\n    (${admissionRecoveryExclusionSql(sql)})                               AS ok_admission_recovery,\n    (${admissionHoldExclusionSql(sql)})                                   AS ok_admission_hold,\n    (${reservedPlanLaneExclusionSql(sql, assignee, 'wi.payload', {\n      claimantFleetSlug,\n      claimSpecReferencesFleet,\n      claimSpecReferencesGoal,\n      decisionCandidates: opts.candidateIds ? { workspaceId: issueWs, ids: opts.candidateIds } : undefined,\n    })})                                                                  AS ok_plan_lane,\n    (${federationDetectorExclusionSql(sql)})                               AS ok_federation,\n    (${loopIterationNoiseExclusionSql(sql)})                               AS ok_loop_noise,\n"
    },
    {
      "path": "packages/operator-core/lib/work-items.ts",
      "sha256": "75d40cfbd5d8eb2cd19e2707ee28999dde1ff1d786fc912515b75d2a7e178967",
      "startLine": 9938,
      "endLine": 9960,
      "excerpt": "          -- path (gated by engineer_issues_view_dml's EI-7833 remote-skip) it had NO origin\n          -- guard at all — a self-select could actually SUCCEED in locally mutating taken_by\n          -- on a federated row, violating the \"authoring peer owns it\" LWW invariant.\n          -- work-item-status-full-unify (owner 2026-07-20): own-node aware — a self-authored row\n          -- that round-tripped federation (origin='remote' but OUR own substrate author key) IS\n          -- self-selectable (the issue-family analog of the feature family's ownAuthorWhereSql leg;\n          -- without it, node-identity drift permanently strands this box's own bugs). A true-peer\n          -- remote row stays excluded. Shared with the READY diagnose so the two never diverge.\n          AND ${isIssueLocallyClaimableWhereSql(tx, issueWs)}\n          -- P-002 born-pending: the promoter owns this lifecycle transition.\n          AND ${admittedWhereSqlWi(tx)}\n          -- EI-22685972259555805: the gate-red-streak:/green-stall: singleton is\n          -- exclusive LIVE_GATE_OPS control-plane work. Ordinary repair bugs still\n          -- flow, while the registered fixer retains the explicit by-id claim path.\n          AND ${liveGateOpsSelfSelectExclusionSql(tx)}\n          -- P-013/D-012 stop-the-line: while this harness's gate-red-streak condition item\n          -- has been open >24h, non-repair rows are not self-selectable (bugs and\n          -- alarm-condition items exempt; a named by-id claim still bypasses, which is the\n          -- owner-directed escape). SAME shared fragment as the claimability preview's\n          -- ok_stop_line (issueClaimCandidateSubquery), so read and claim cannot diverge.\n          AND ${stopTheLineExclusionSql(tx, 'issue-wi')}\n          -- P-017/D-032 red-inflow preclaim: repair items on an 8h+ red harness only.\n          AND ${opts.repairFirstOnly ? redInflowRepairItemSql(tx) : tx`TRUE`}\n"
    },
    {
      "path": "packages/operator-core/lib/work-items-stop-the-line.test.ts",
      "sha256": "2de1f0219361eb167720ccd87e4492c31ac189992bdde17152bd02cd1f7e52d0",
      "startLine": 60,
      "endLine": 118,
      "excerpt": "    // Every prefix ends in ':' — a bare word would prefix-match unrelated keys via LIKE.\n    for (const p of STOP_THE_LINE_EXEMPT_CONDITION_PREFIXES) {\n      expect(p.endsWith(':')).toBe(true);\n    }\n  });\n\n  it('the trigger prefix matches the trackGateStall producer key shape', () => {\n    expect(GATE_RED_STREAK_CONDITION_PREFIX).toBe('gate-red-streak:');\n    expect(STOP_THE_LINE_RED_HOURS).toBe(24);\n  });\n\n  it('reserves only the two LIVE_GATE_OPS singleton prefixes for explicit by-id claims', () => {\n    expect(LIVE_GATE_OPS_CONDITION_PREFIXES).toEqual(['gate-red-streak:', 'green-stall:']);\n    for (const prefix of LIVE_GATE_OPS_CONDITION_PREFIXES) expect(prefix.endsWith(':')).toBe(true);\n\n    const text = liveGateOpsSelfSelectExplanation();\n    expect(text).toContain('gate-red-streak:');\n    expect(text).toContain('green-stall:');\n    expect(text).toContain('alarm:green-main-slo:');\n    expect(text).toContain('BY ID');\n    expect(text).toContain('gate.greenCheckpoint.ownership');\n  });\n\n  it('EI-27062367026577459: live-gate green-main-slo alarms are reserved; per-sync and reason alarms are not', () => {\n    expect([...LIVE_GATE_OPS_GREEN_MAIN_SLO_METRICS].sort()).toEqual(\n      ['queue-idle', 'red-adding-admission', 'round-cycle-time', 'time-since-green', 'time-since-verdict'],\n    );\n    // The watchdog's key prefix is the one the floor anchors on.\n    expect(sloKey('queue-idle').startsWith(GREEN_MAIN_SLO_CONDITION_PREFIX)).toBe(true);\n\n    // Production keys of the rows that circulated through self-select on 2026-10-26.\n    const recycled = [\n      'alarm:green-main-slo:%5B%22papercusp-workspace%22%2C%22papercusp%22%2C%22red-adding-admission%22%2C%22green-main-slo%3Apapercusp%3Ared-adding-admission%3A55bbd12ce1686d8e722b5a733f5a68783f40b08d%22%2C%224a0ab75652bda2698d296eee96aa340f0eb3a620%22%5D',\n      'alarm:green-main-slo:%5B%22papercusp-workspace%22%2C%22papercusp%22%2C%22round-cycle-time%22%2C%22green-main-slo%3Apapercusp%3Around-cycle-time%3A0a16d4a6fac24e6df84192786ab07129978ab561%3A2%22%2C%220a16d4a6fac24e6df84192786ab07129978ab561%22%5D',\n    ];\n    const reserved = [...recycled, ...LIVE_GATE_OPS_GREEN_MAIN_SLO_METRICS.map((m) => sloKey(m)), sloKey('time-since-green', null)];\n    const open = [\n      sloKey('per-sync-red-rate', 'luna-max'),\n      sloKey('non-verdict-reason', 'suite-timeout'),\n      // A reserved metric's name in the SUBJECT slot (last element) must not match.\n      sloKey('per-sync-red-rate', 'queue-idle'),\n      sloKey('non-verdict-reason', 'red-adding-admission'),\n      'alarm:sync-read-budget:papercusp-workspace:papercusp:breach',\n      'deploy-parity:papercusp',\n    ];\n    for (const key of reserved) {\n      expect(isLiveGateOpsConditionKey(key), key).toBe(true);\n      expect(reservedBySql(key), key).toBe(true);\n    }\n    for (const key of open) {\n      expect(isLiveGateOpsConditionKey(key), key).toBe(false);\n      expect(reservedBySql(key), key).toBe(false);\n    }\n    // The singleton prefixes keep their existing reservation.\n    expect(reservedBySql('gate-red-streak:papercusp')).toBe(true);\n    expect(reservedBySql('green-stall:papercusp')).toBe(true);\n    expect(isLiveGateOpsConditionKey(null)).toBe(false);\n  });\n\n"
    },
    {
      "path": "packages/operator-core/lib/release/green-main-slo-watchdog.ts",
      "sha256": "694537f529b7e1a009749dfadd4935639e310e1263f9f106f51e06832cd141af",
      "startLine": 85,
      "endLine": 101,
      "excerpt": "\n/**\n * The alarm item's condition key. Exported so the LIVE_GATE_OPS reservation\n * (work-items-admission.ts liveGateOpsReservedPatterns) is tested against the real encoding.\n */\nexport const greenMainSloConditionKey = (\n  scope: Pick<GreenMainSloPassDeps, 'workspaceId' | 'installSlug'>,\n  metric: string,\n  episode: string,\n  subject: string | null = null,\n): string =>\n  `alarm:green-main-slo:${encodeURIComponent(JSON.stringify([scope.workspaceId, scope.installSlug, metric, episode, subject]))}`;\nconst conditionKey = greenMainSloConditionKey;\n\nconst epoch = (value: unknown, nowMs: number): value is number =>\n  typeof value === 'number' && Number.isFinite(value) && value > 0 && value <= nowMs;\n\n"
    },
    {
      "path": "packages/operator-core/lib/release/green-main-slo-watchdog.ts",
      "sha256": "694537f529b7e1a009749dfadd4935639e310e1263f9f106f51e06832cd141af",
      "startLine": 125,
      "endLine": 211,
      "excerpt": "\nasync function readSloConditions(): Promise<readonly SloCondition[]> {\n  const { computeConditionStates, readConditionEnvelopes } = await import('../agent-tools/coordination/tools/conditions');\n  return computeConditionStates(await readConditionEnvelopes());\n}\n\n/** Historical red-adding admissions clear only when a later measured round repairs their added failures. */\nfunction repairedAdmissionAt(queue: GreenMainSloQueue | null, head: string, nowMs: number): number | null {\n  if (!queue) return null;\n  const admission = queue.admissions?.find((a) => a.toRepairHead === head);\n  if (!admission || !epoch(admission.atMs, nowMs)) return null;\n  const rounds = [...(queue.convergenceRounds ?? [])].sort((a, b) => a.atMs - b.atMs);\n  const before = rounds.filter((r) => r.atMs <= admission.atMs).at(-1);\n  const after = rounds.find((r) => r.atMs > admission.atMs);\n  if (!before || !after || after.failingCount <= before.failingCount) return null;\n  return rounds.find((r) => r.atMs > after.atMs && epoch(r.atMs, nowMs) &&\n    Number.isInteger(r.failingCount) && r.failingCount >= 0 && r.failingCount <= before.failingCount)?.atMs ?? null;\n}\n\n/** A later valid queue is the explicit supersession boundary for metrics tied to the prior frozen candidate. */\nfunction explicitlySupersededByNewQueue(\n  metric: string,\n  exactSubject: string | null,\n  openedAtMs: number,\n  nowMs: number,\n  queue: GreenMainSloQueue | null,\n): boolean {\n  const queueMetrics = ['red-adding-admission', 'round-cycle-time', 'queue-idle'];\n  if (!queueMetrics.includes(metric) || !exactSubject || !queue || !measuredQueue(queue, nowMs) ||\n      queue.candidate === exactSubject || !epoch(openedAtMs, nowMs)) return false;\n  return queue.openedAtMs > openedAtMs;\n}\n\n/** Positive exact-subject observations only; a missing row or a skipped input never clears an episode. */\nfunction measuredRecovery(\n  metric: string, episode: string, exactSubject: string | null, openedAtMs: number, deps: GreenMainSloPassDeps, slo: GreenMainSlo,\n  green: number | null, verdict: number | null, queue: GreenMainSloQueue | null,\n  tallies: readonly SyncBatchFleetTally[] | null,\n  reasons: GateNonVerdictReasons | null,\n): boolean {\n  if (!epoch(openedAtMs, deps.nowMs)) return false;\n  const prefix = `green-main-slo:${deps.installSlug}:${metric}:`;\n  if (!episode.startsWith(prefix)) return false;\n  const subject = episode.slice(prefix.length);\n  if (metric === 'time-since-green' || metric === 'time-since-verdict') {\n    const stamp = metric === 'time-since-green' ? green : verdict;\n    const threshold = metric === 'time-since-green' ? slo.thresholds.redPageMs : slo.thresholds.noVerdictPageMs;\n    return epoch(stamp, deps.nowMs) && /^\\d+$/.test(subject) && stamp > Number(subject) &&\n      stamp >= openedAtMs && deps.nowMs - stamp < threshold;\n  }\n  if (metric === 'per-sync-red-rate') {\n    return (tallies ?? []).some((t) => t.fleet === exactSubject && subject.startsWith(`${t.fleet ?? 'all'}:`) &&\n      /^\\d+$/.test(subject.slice(`${t.fleet ?? 'all'}:`.length)) &&\n      Number(subject.slice(`${t.fleet ?? 'all'}:`.length)) <= Math.floor(deps.nowMs / 86_400_000) &&\n      epoch(t.observedAtMs, deps.nowMs) && t.observedAtMs >= openedAtMs &&\n      Number.isInteger(t.judgedBatches) && t.judgedBatches >= slo.thresholds.perSyncRedMinBatches &&\n      Number.isInteger(t.redBatches) && t.redBatches >= 0 && t.redBatches <= t.judgedBatches &&\n      t.redBatches / t.judgedBatches <= slo.thresholds.perSyncRedRateAlert);\n  }\n  if (metric === 'non-verdict-reason') {\n    if (!reasons || !exactSubject || !subject.startsWith(`${exactSubject}:`) ||\n        !/^\\d+$/.test(subject.slice(exactSubject.length + 1)) || reasons.measuredAtMs < openedAtMs) return false;\n    return (reasons.reasons.find((r) => r.reason === exactSubject)?.count ?? 0) < slo.thresholds.nonVerdictReasonMinCount;\n  }\n  if (!queue || !epoch(queue.openedAtMs, deps.nowMs) || typeof queue.candidate !== 'string' || queue.candidate !== exactSubject) return false;\n  if (metric === 'red-adding-admission') {\n    const repairedAt = repairedAdmissionAt(queue, subject, deps.nowMs);\n    return repairedAt !== null && repairedAt >= openedAtMs;\n  }\n  if (!subject.startsWith(`${queue.candidate}:`)) return false;\n  const rounds = queue.convergenceRounds ?? [];\n  if (rounds.some((r) => !epoch(r.atMs, deps.nowMs) || !Number.isInteger(r.round) || r.round < 0)) return false;\n  if (metric === 'round-cycle-time') {\n    const latest = rounds.reduce<(typeof rounds)[number] | undefined>((a, r) => !a || r.atMs > a.atMs ? r : a, undefined);\n    const oldRound = subject.slice(queue.candidate.length + 1);\n    return !!latest && /^\\d+$/.test(oldRound) && latest.round > Number(oldRound) && latest.atMs >= openedAtMs &&\n      slo.metrics.roundCycleTime.lastMs !== null && slo.metrics.roundCycleTime.lastMs <= slo.thresholds.roundCycleAlertMs;\n  }\n  if (metric === 'queue-idle') {\n    const latency = frozenRepairLatency(queue, deps.nowMs);\n    return !latency.inadmissibleStamps?.length && slo.metrics.queueIdleMs !== null &&\n      slo.metrics.queueIdleMs <= slo.thresholds.queueIdleAlertMs &&\n      [latency.stamps.fixerSpawnedAtMs, latency.stamps.lastResumeRunStartedAtMs, latency.stamps.lastVerdictAtMs]\n        .some((stamp) => epoch(stamp, deps.nowMs) && stamp >= openedAtMs);\n  }\n  return false;\n}\n"
    },
    {
      "path": "packages/operator-core/lib/release/green-main-slo-watchdog.ts",
      "sha256": "694537f529b7e1a009749dfadd4935639e310e1263f9f106f51e06832cd141af",
      "startLine": 249,
      "endLine": 338,
      "excerpt": "  const slo = computeGreenMainSlo(\n    { installSlug: deps.installSlug, nowMs: deps.nowMs, lastGreenAtMs, lastVerdictAtMs, queue, syncTallies, nonVerdictReasons },\n    deps.thresholds,\n  );\n\n  const deliveries: GreenMainSloDelivery[] = [];\n  const conditionErrors: string[] = [];\n  const reasonItems: GreenMainSloPassResult['reasonItems'] = [];\n  const reasonFilingSkips: GreenMainSloPassResult['reasonFilingSkips'] = [];\n  let conditions: readonly SloCondition[] | null = null;\n  try {\n    conditions = await (deps.readConditions ?? readSloConditions)();\n    if (!Array.isArray(conditions)) throw new Error('invalid condition census');\n  }\n  catch (e) { conditions = null; conditionErrors.push(`read conditions: ${message(e)}`); }\n  for (const breach of slo.breaches) {\n    const key = conditionKey(deps, breach.metric, breach.episodeKey, breach.subject);\n    if (breach.metric === 'non-verdict-reason') {\n      try {\n        if (!deps.fileNonVerdictReason) throw new Error('owned reason filer unavailable');\n        const item = await deps.fileNonVerdictReason(breach);\n        if ('skipped' in item) {\n          reasonFilingSkips.push({ reason: breach.subject!, cause: item.skipped });\n        } else {\n          if (!item?.id || !item.assignee) throw new Error('reason filing returned no accountable holder');\n          reasonItems.push({ reason: breach.subject!, ...item });\n        }\n      } catch (e) { conditionErrors.push(`file ${breach.subject}: ${message(e)}`); }\n    }\n    // A historical admission can remain in the SLO panel after a later round fixed it.\n    const repaired = breach.metric === 'red-adding-admission' && repairedAdmissionAt(queue, breach.episodeKey.slice(\n      `green-main-slo:${deps.installSlug}:${breach.metric}:`.length), deps.nowMs) !== null;\n    if (!repaired && !conditions?.some((c) => c.condition_key === key && c.open)) {\n      try {\n        const event = { conditionKey: key, summary: breach.title, body: breach.detail, oneShot: true };\n        const delivered = deps.rail?.broadcast\n          ? await deps.rail.broadcast(event)\n          : await broadcastSevereEvent(event);\n        if (!delivered) conditionErrors.push(`open ${key}: delivery returned false`);\n      } catch (e) { conditionErrors.push(`open ${key}: ${message(e)}`); }\n    }\n    try {\n      const res = await deps.notifyOnce({\n        kind: 'intervention',\n        title: breach.title,\n        body: breach.detail,\n        importance: breach.severity === 'page' ? 'urgent' : 'normal',\n        harnessSlug: deps.installSlug,\n        workspaceId: deps.workspaceId,\n        dedupeKey: breach.episodeKey,\n        data: {\n          source: 'green-main-slo',\n          metric: breach.metric,\n          severity: breach.severity,\n          value: breach.value,\n          threshold: breach.threshold,\n          conditionKey: key,\n        },\n      });\n      deliveries.push({ episodeKey: breach.episodeKey, severity: breach.severity, deduped: res.deduped });\n    } catch (e) {\n      deliveries.push({ episodeKey: breach.episodeKey, severity: breach.severity, deduped: false, error: message(e) });\n    }\n  }\n  for (const condition of conditions ?? []) {\n    if (!condition.open || !condition.condition_key.startsWith('alarm:green-main-slo:')) continue;\n    try {\n      const scope: unknown = JSON.parse(decodeURIComponent(condition.condition_key.slice('alarm:green-main-slo:'.length)));\n      if (!Array.isArray(scope) || scope.length !== 5 || scope.slice(0, 4).some((s) => typeof s !== 'string') ||\n        (scope[4] !== null && typeof scope[4] !== 'string') ||\n        scope[0] !== deps.workspaceId || scope[1] !== deps.installSlug ||\n        conditionKey(deps, scope[2], scope[3], scope[4]) !== condition.condition_key) continue;\n      const openedAtMs = Date.parse(condition.open_since ?? condition.last_seen);\n      const superseded = explicitlySupersededByNewQueue(scope[2], scope[4], openedAtMs, deps.nowMs, queue);\n      const recovered = !superseded &&\n        measuredRecovery(scope[2], scope[3], scope[4], openedAtMs, deps, slo, lastGreenAtMs, lastVerdictAtMs, queue, syncTallies, nonVerdictReasons);\n      if (superseded || recovered) {\n        const resolutionSummary = superseded\n          ? 'green-main-slo ' + scope[2] + ' episode for candidate ' + String(scope[4]).slice(0, 12) +\n            ' superseded by later repair queue candidate ' + String(queue?.candidate).slice(0, 12)\n          : undefined;\n        const resolved = await resolveAlarm(condition.condition_key, 'green-main-slo', deps.rail, resolutionSummary);\n        if (!resolved) conditionErrors.push(`resolve ${condition.condition_key}: delivery returned false`);\n      }\n    } catch (e) { conditionErrors.push(`reconcile ${condition.condition_key}: ${message(e)}`); }\n  }\n  return { slo, deliveries, readErrors, conditionErrors, reasonItems, reasonFilingSkips };\n}\n\n/**\n"
    }
  ],
  "rows": [
    {
      "id": "WI-6554700010009908",
      "frozenSource": {
        "path": "/mnt/data/papercusp-audit-inputs/c52-r1-frozen-20261106T1917Z/WI-6554700010009908.json",
        "sha256": "9be586ca9d386e95e531f2827c56914d4caa1c3c47c8d2f680dcf470ad6cae86",
        "raw": {
          "id": "WI-6554700010009908",
          "kind": "bug",
          "family": "issue",
          "harness": "papercusp",
          "title": "[alarm:green-main-slo:%5B%22papercusp-workspace%22%2C%22papercusp%22%2C%22red-adding-admission%22%2C%22green-main-slo%3Apapercusp%3Ared-adding-admission%3A0cb83",
          "summary": "Owning work-item for condition 'alarm:green-main-slo:%5B%22papercusp-workspace%22%2C%22papercusp%22%2C%22red-adding-admission%22%2C%22green-main-slo%3Apapercusp%3Ared-adding-admission%3A0cb836840549a7e802e86acea568e47bc59963f9%22%2C%220a16d4a6fac24e6df84192786ab07129978ab561%22%5D', minted by the condition bridge (P-003, gate-ownership-condition-singleton-2026-08-03). This item is the SINGLETON for this condition — the partial unique index on work_items.condition_key guarantees at most one open owner, so claim THIS rather than filing another.\n\nLatest alarm: An admission added red on papercusp\nFirst seen: 2026-10-13T06:30:51.749Z · open since: 2026-10-13T06:30:51.749Z · alarms: 1\n\nLatest alarm detail (from the emitter):\nThe round after admitting 0cb836840549 recorded more failures than the round before it.\n\n— emitted by pid 1496768, process started 2026-10-13T05:50:11.675Z (up 40m), cwd /home/marsh-office/papercupai-workspace/papercusp/apps/operator. If that start time PREDATES the fix you are checking, this process never loaded it (no hot-reload) and no deploy will reach it — restart that host instead of re-investigating the alarm.",
          "state": "open",
          "assignee": null,
          "takenAt": null,
          "lastProgressAt": "2026-10-14T16:24:31.590Z",
          "assignedBy": null,
          "createdBy": null,
          "severity": "major",
          "goalId": null,
          "tags": null,
          "sourcePlanSlug": null,
          "sourcePlanItemIds": null,
          "redundancy": null,
          "expectedCostCents": null,
          "parent": null,
          "payload": {
            "_ei": {
              "scope": "harness:papercusp",
              "source": "engineer",
              "severity": "major",
              "signal_origin": "organic"
            },
            "_bridge": {
              "mintedAt": "2026-10-13T06:31:03.094Z",
              "conditionKey": "alarm:green-main-slo:%5B%22papercusp-workspace%22%2C%22papercusp%22%2C%22red-adding-admission%22%2C%22green-main-slo%3Apapercusp%3Ared-adding-admission%3A0cb836840549a7e802e86acea568e47bc59963f9%22%2C%220a16d4a6fac24e6df84192786ab07129978ab561%22%5D"
            },
            "reporter": {
              "at": "2026-10-13T06:31:03.095Z",
              "id": null,
              "kind": "watchdog",
              "basis": "no-session"
            },
            "_claimHold": true,
            "claim_hold_at": "2026-10-14T16:25:48.679Z",
            "claim_hold_by": "su-8fe094cc-f823-4a88-a587-e301bd9972e8",
            "reporterKinds": [
              "watchdog"
            ],
            "claim_hold_reason": "Focused SLO validation is checkpointed and its evidence was sent once to the live gate owner. Current-red triage is held by WI-10006055; park this alarm until that gate item completes.",
            "freshnessEnvelope": {
              "observedAt": "2026-10-13T06:31:03.095Z",
              "linkedFixRefs": [],
              "reporterSession": null,
              "observedSourceSha": "62493910da",
              "toolSchemaVersion": null,
              "observedRuntimeSha": "62493910da",
              "deployBuildIdentity": "62493910da@0.0.0",
              "reporterRuntimeVersion": "0.0.0",
              "lastSuccessfulReproductionAt": null
            },
            "claim_hold_release": {
              "owner": "su-6f6f3aa0-77b0-4ab3-a9e5-126b5853a81c",
              "trigger": "work-item:done:WI-10006055",
              "evidence": "a live resolver or producer registration can still satisfy the condition",
              "condition": "Re-evaluate the historical red-admission alarm after the live green-checkpoint owner completes WI-10006055.",
              "reachability": "reachable"
            },
            "claim_history_post_id": 9001788375295,
            "implementationReadiness": {
              "reason": "no-acceptance-evidence-at-creation",
              "source": "creation-enrollment",
              "status": "unknown",
              "updatedAt": "2026-10-13T06:31:03.095Z",
              "schemaVersion": "implementation-readiness-v1"
            }
          },
          "definition": null,
          "rank": null,
          "rankWriter": null,
          "rankUpdatedAt": null,
          "priority": null,
          "terminalOwner": null,
          "terminalCompletionRef": null,
          "terminalCompletionEvidence": null,
          "completionAuthority": null,
          "origin": "local",
          "auditVerdict": null,
          "verifiedAuthorGithubUserId": null,
          "createdAt": "2026-10-13T06:31:03.095Z",
          "updatedAt": "2026-10-14T16:25:48.679Z",
          "closedAt": null
        }
      },
      "originalLedgerRow": {
        "id": "WI-6554700010009908",
        "source": "/mnt/data/papercusp-audit-inputs/c52-r1-frozen-20261106T1917Z/WI-6554700010009908.json",
        "sourceSha256": "9be586ca9d386e95e531f2827c56914d4caa1c3c47c8d2f680dcf470ad6cae86",
        "manifestSha256": "75f699e3073a53df71db467214e8d3271ab3df35aca42fd3a5dcd1918f9af1ad",
        "state": "open",
        "rowAgeSecondsAtSnapshot": 2119506.533262,
        "rawRestrictionVerdict": {
          "id": "WI-6554700010009908",
          "admissible": false,
          "refusedBy": "live-gate-ops",
          "failedFloors": [
            "live-gate-ops",
            "claim-hold"
          ],
          "detail": "LIVE_GATE_OPS condition (gate-red-streak: or green-stall: singleton, or an alarm:green-main-slo: time-since-green/time-since-verdict/red-adding-admission/round-cycle-time/queue-idle alarm) — reserved to the one registered live gate fixer and excluded from opportunistic self-select. A leader/owner may still dispatch or claim it BY ID after checking gate.greenCheckpoint.ownership."
        },
        "restrictions": [
          {
            "floor": "live-gate-ops",
            "stateProducerRecorded": null,
            "enteredAtRecorded": null,
            "ageSecondsAtSnapshot": null,
            "accountableClearerRecorded": null,
            "releaseConditionRecordedOrEvaluatorRule": "Registered live gate owner progresses this lane; no competing takeover or repeated gate status read.",
            "currentEvidence": {
              "scope": "LIVE_GATE_OPS",
              "status": "excluded from this investigation lane"
            },
            "verification": "unassessed; recorded values and evaluator rules do not establish legitimacy",
            "unknownFields": [
              "stateProducer",
              "enteredAt",
              "accountableClearer"
            ]
          },
          {
            "floor": "claim-hold",
            "stateProducerRecorded": "su-8fe094cc-f823-4a88-a587-e301bd9972e8",
            "enteredAtRecorded": "2026-10-14T16:25:48.679Z",
            "ageSecondsAtSnapshot": 1997420.949262,
            "accountableClearerRecorded": "su-6f6f3aa0-77b0-4ab3-a9e5-126b5853a81c",
            "releaseConditionRecordedOrEvaluatorRule": "Re-evaluate the historical red-admission alarm after the live green-checkpoint owner completes WI-10006055.",
            "currentEvidence": {
              "claim_hold_at": "2026-10-14T16:25:48.679Z",
              "claim_hold_by": "su-8fe094cc-f823-4a88-a587-e301bd9972e8",
              "claim_hold_reason": "Focused SLO validation is checkpointed and its evidence was sent once to the live gate owner. Current-red triage is held by WI-10006055; park this alarm until that gate item completes.",
              "claim_hold_release": {
                "owner": "su-6f6f3aa0-77b0-4ab3-a9e5-126b5853a81c",
                "trigger": "work-item:done:WI-10006055",
                "evidence": "a live resolver or producer registration can still satisfy the condition",
                "condition": "Re-evaluate the historical red-admission alarm after the live green-checkpoint owner completes WI-10006055.",
                "reachability": "reachable"
              }
            },
            "verification": "unassessed; recorded values and evaluator rules do not establish legitimacy",
            "unknownFields": [],
            "writerProvenanceVerification": {
              "sourceRules": "work-items.ts:setWorkItemClaimHold and work-items-admission-promoter.ts:qualifiedAgentPark; corroboration grants no release authority",
              "checks": [
                {
                  "convention": "claim_hold",
                  "recordedActor": "su-8fe094cc-f823-4a88-a587-e301bd9972e8",
                  "corroboratedCanonicalWriter": true,
                  "criteria": {
                    "latestIsCanonicalSet": true,
                    "auditActorMatches": true,
                    "modeMatches": true,
                    "byMatches": true,
                    "reasonMatches": true,
                    "timestampMatches": true,
                    "releaseContractMatches": true
                  },
                  "auditId": "wi-claim-hold-mv8bn636-d9y8bl",
                  "notProven": [
                    "current actor authority",
                    "legitimacy of underlying reason",
                    "truth of arbitrary release condition",
                    "clearance",
                    "execution"
                  ]
                }
              ],
              "noConventionRecorded": false
            }
          }
        ],
        "controlEvidence": {
          "implementationReadiness": {
            "reason": "no-acceptance-evidence-at-creation",
            "source": "creation-enrollment",
            "status": "unknown",
            "updatedAt": "2026-10-13T06:31:03.095Z",
            "schemaVersion": "implementation-readiness-v1"
          },
          "_claimHold": true,
          "claim_hold_at": "2026-10-14T16:25:48.679Z",
          "claim_hold_by": "su-8fe094cc-f823-4a88-a587-e301bd9972e8",
          "claim_hold_reason": "Focused SLO validation is checkpointed and its evidence was sent once to the live gate owner. Current-red triage is held by WI-10006055; park this alarm until that gate item completes.",
          "claim_hold_release": {
            "owner": "su-6f6f3aa0-77b0-4ab3-a9e5-126b5853a81c",
            "trigger": "work-item:done:WI-10006055",
            "evidence": "a live resolver or producer registration can still satisfy the condition",
            "condition": "Re-evaluate the historical red-admission alarm after the live green-checkpoint owner completes WI-10006055.",
            "reachability": "reachable"
          },
          "reporter": {
            "at": "2026-10-13T06:31:03.095Z",
            "id": null,
            "kind": "watchdog",
            "basis": "no-session"
          },
          "freshnessEnvelope": {
            "observedAt": "2026-10-13T06:31:03.095Z",
            "linkedFixRefs": [],
            "reporterSession": null,
            "observedSourceSha": "62493910da",
            "toolSchemaVersion": null,
            "observedRuntimeSha": "62493910da",
            "deployBuildIdentity": "62493910da@0.0.0",
            "reporterRuntimeVersion": "0.0.0",
            "lastSuccessfulReproductionAt": null
          }
        },
        "accountableInvestigator": "su-c52a1707-13f5-4080-870b-f7143c271d73",
        "disposition": "unassessed",
        "legitimateException": null,
        "executionEvidence": null,
        "remainingVerification": [
          "Actual source writer and recorded producer",
          "Restriction evidence, age, accountable authorized clearer and exact release condition",
          "Legitimacy or false-restriction repair",
          "Same-ID execution or explicit Avi disposition"
        ],
        "schemaVersion": "luna-r1-causal-evidence-ledger-v4",
        "sourceQualification": {
          "status": "clearance mechanisms mapped; row-specific causal/legitimacy verification remains open",
          "registry": "/home/marsh-office/.papercusp/evidence/c52-luna-r1-20261106/restriction-authority-registry-v1.json",
          "registrySha256": "1b51f4be4a288749652dfaf9f7c7d4547aae962dd0d33a798f8e729f9e49dfbe",
          "floorMappings": [
            {
              "floor": "live-gate-ops",
              "mechanismRef": "/home/marsh-office/.papercusp/evidence/c52-luna-r1-20261106/restriction-authority-registry-v1.json#/floors/live-gate-ops",
              "rowVerification": "unassessed",
              "requiredRowEvidence": [
                "exact condition_key",
                "condition producer",
                "registered ownership evidence supplied by that lane"
              ]
            },
            {
              "floor": "claim-hold",
              "mechanismRef": "/home/marsh-office/.papercusp/evidence/c52-luna-r1-20261106/restriction-authority-registry-v1.json#/floors/claim-hold",
              "rowVerification": "unassessed",
              "requiredRowEvidence": [
                "both provenance conventions",
                "typed release contract or precise legacy condition",
                "condition-specific proof",
                "current assignment/fingerprint",
                "owner authority if required"
              ],
              "recordedReleaseContractOwner": "su-6f6f3aa0-77b0-4ab3-a9e5-126b5853a81c",
              "recordedLeaseHolder": null,
              "recordedParker": "su-8fe094cc-f823-4a88-a587-e301bd9972e8",
              "authorityVerified": false
            }
          ]
        },
        "postFreezeControlContext": {
          "artifact": "/home/marsh-office/.papercusp/evidence/c52-luna-r1-20261106/live-control-enrichment-20261106T1950Z-v2.json",
          "observedAt": "2026-11-06 19:48:21.753008+00",
          "record": {
            "id": "WI-6554700010009908",
            "state": "open",
            "harness": "papercusp",
            "takenAt": null,
            "takenBy": null,
            "admission": "auto",
            "createdAt": 1791873063095,
            "updatedAt": 1791995148679,
            "admittedAt": "2026-10-13T06:31:03.095+00:00",
            "admittedBy": "bypass:condition-key",
            "duplicateOf": null,
            "conditionKey": "alarm:green-main-slo:%5B%22papercusp-workspace%22%2C%22papercusp%22%2C%22red-adding-admission%22%2C%22green-main-slo%3Apapercusp%3Ared-adding-admission%3A0cb836840549a7e802e86acea568e47bc59963f9%22%2C%220a16d4a6fac24e6df84192786ab07129978ab561%22%5D",
            "holderPresence": null,
            "sourcePlanSlug": null,
            "sourcePlanItemIds": null
          },
          "limitations": [
            "Presence absence does not establish holder death or authorize release",
            "Current terminal state alone does not prove execution",
            "Admission values are current post-freeze evidence; historical producer/state-transition audit still required"
          ]
        },
        "postFreezeDependencyContext": {
          "artifact": "/home/marsh-office/.papercusp/evidence/c52-luna-r1-20261106/dependency-enrichment-20261106T1930Z.json",
          "observedAt": "2026-11-06T19:26:36.952682Z",
          "edges": [],
          "coverage": "not queried by this enrichment; empty list is not absence evidence"
        },
        "historicalAuditEvidence": {
          "artifact": "/home/marsh-office/.papercusp/evidence/c52-luna-r1-20261106/historical-audit-enrichment-20261106T2010Z.json",
          "sha256": "4b396df0818120147036644a9e33893170b4d271e5a5fd1a87e0e720a9884410",
          "recordPointer": "/queryResult/rows/0/items/5811",
          "observedAt": "2026-11-06 20:03:09.124326+00",
          "eventCutoffMs": 1793992569628,
          "eventCount": 1,
          "coverage": "Available work_items:% audit only; empty is not no-transition proof; nonterminal changes and some needs-human changes are undated."
        }
      },
      "savedNovember7Qualification": {
        "schemaVersion": "luna-r1-causal-qualification-v1",
        "id": "WI-6554700010009908",
        "sourceLedger": {
          "path": "/home/marsh-office/.papercusp/evidence/c52-luna-r1-20261106/causal-ledger-v4.jsonl",
          "sha256": "7f1962fb5c22f1bc2be9625406b315f6b5f4fd190b4743d7f972a4fb2c935866",
          "rowSourceSha256": "9be586ca9d386e95e531f2827c56914d4caa1c3c47c8d2f680dcf470ad6cae86"
        },
        "frozenState": "open",
        "frozenFloors": [
          "claim-hold",
          "live-gate-ops"
        ],
        "currentControlObservedAt": "2026-11-07 11:32:12.960427-05",
        "currentState": "open",
        "currentHolder": null,
        "currentFloorVerdict": {
          "id": "WI-6554700010009908",
          "admissible": false,
          "refusedBy": "live-gate-ops",
          "failedFloors": [
            "live-gate-ops",
            "claim-hold"
          ],
          "detail": "LIVE_GATE_OPS condition (gate-red-streak: or green-stall: singleton, or an alarm:green-main-slo: time-since-green/time-since-verdict/red-adding-admission/round-cycle-time/queue-idle alarm) — reserved to the one registered live gate fixer and excluded from opportunistic self-select. A leader/owner may still dispatch or claim it BY ID after checking gate.greenCheckpoint.ownership."
        },
        "floorDifference": {
          "noLongerObserved": [],
          "newlyObserved": []
        },
        "adoptionQualification": null,
        "parkQualification": {
          "artifact": ".papercusp/evidence/c52-luna-r1-20261106/current-park-qualification-20261107T1715Z.json",
          "controlSnapshotAt": "2026-11-07 11:32:12.960427-05",
          "measuredAt": "2026-11-07T17:28:35.494Z",
          "qualificationAsMeasured": "reachable",
          "certification": "reachability-only; underlying release condition and clearer authority unverified"
        },
        "disposition": "unassessed",
        "executionEvidence": null,
        "nextActions": [
          "preserve park; qualify its exact condition and authorized clearer, with no automatic release from reachability"
        ],
        "limits": [
          "separately dated observations; not an immutable current-state snapshot",
          "a correct floor or release path does not prove underlying legitimacy",
          "adoption eligibility is report revision, not permission to implement"
        ]
      },
      "savedNovember8": {
        "observedAt": "2026-11-08 15:02:23.578069+00",
        "batch": 14,
        "recordPointer": "/rows/0/items/211",
        "rawProjectedRecord": {
          "id": "WI-6554700010009908",
          "state": "open",
          "holder": null,
          "control": {
            "_claimHold": true,
            "claim_hold_at": "2026-10-14T16:25:48.679Z",
            "claim_hold_by": "su-8fe094cc-f823-4a88-a587-e301bd9972e8",
            "claim_hold_reason": "Focused SLO validation is checkpointed and its evidence was sent once to the live gate owner. Current-red triage is held by WI-10006055; park this alarm until that gate item completes.",
            "claim_hold_release": {
              "owner": "su-6f6f3aa0-77b0-4ab3-a9e5-126b5853a81c",
              "trigger": "work-item:done:WI-10006055",
              "evidence": "a live resolver or producer registration can still satisfy the condition",
              "condition": "Re-evaluate the historical red-admission alarm after the live green-checkpoint owner completes WI-10006055.",
              "reachability": "reachable"
            },
            "implementationReadiness": {
              "reason": "no-acceptance-evidence-at-creation",
              "source": "creation-enrollment",
              "status": "unknown",
              "updatedAt": "2026-10-13T06:31:03.095Z",
              "schemaVersion": "implementation-readiness-v1"
            }
          },
          "takenAt": null,
          "admission": "auto",
          "updatedAt": 1791995148679,
          "admittedAt": "2026-10-13T06:31:03.095+00:00",
          "admittedBy": "bypass:condition-key",
          "sourcePlan": null,
          "duplicateOf": null,
          "sourceItems": null,
          "conditionKey": "alarm:green-main-slo:%5B%22papercusp-workspace%22%2C%22papercusp%22%2C%22red-adding-admission%22%2C%22green-main-slo%3Apapercusp%3Ared-adding-admission%3A0cb836840549a7e802e86acea568e47bc59963f9%22%2C%220a16d4a6fac24e6df84192786ab07129978ab561%22%5D",
          "stateChangedAt": "2026-10-13T06:31:03.095+00:00"
        }
      },
      "reconciliation": {
        "id": "WI-6554700010009908",
        "frozenSourceSha256": "9be586ca9d386e95e531f2827c56914d4caa1c3c47c8d2f680dcf470ad6cae86",
        "frozenState": "open",
        "frozenFloors": [
          "live-gate-ops",
          "claim-hold"
        ],
        "priorDisposition": "unassessed",
        "currentBatch": 14,
        "currentState": "open",
        "currentHolder": null,
        "currentAdmission": "auto",
        "currentControlKeys": [
          "_claimHold",
          "claim_hold_at",
          "claim_hold_by",
          "claim_hold_reason",
          "claim_hold_release",
          "implementationReadiness"
        ],
        "changedProjectedControlKeys": [],
        "unmeasuredFrozenControlKeys": [
          "freshnessEnvelope",
          "reporter"
        ],
        "assessment": "condition-and-clearer-legitimacy-unresolved",
        "finalR1Disposition": "unresolved"
      },
      "conditionIdentity": {
        "key": "alarm:green-main-slo:%5B%22papercusp-workspace%22%2C%22papercusp%22%2C%22red-adding-admission%22%2C%22green-main-slo%3Apapercusp%3Ared-adding-admission%3A0cb836840549a7e802e86acea568e47bc59963f9%22%2C%220a16d4a6fac24e6df84192786ab07129978ab561%22%5D",
        "decodedWorkspaceInstallMetricEpisodeSubject": [
          "papercusp-workspace",
          "papercusp",
          "red-adding-admission",
          "green-main-slo:papercusp:red-adding-admission:0cb836840549a7e802e86acea568e47bc59963f9",
          "0a16d4a6fac24e6df84192786ab07129978ab561"
        ],
        "datedPostFreezeKeyEqual": true,
        "frozenRawExportOmitsConditionKey": true,
        "historicalFrozenKeyUnproven": true
      },
      "sourceConditionedReservation": "The saved exact metric-slot key matches the witnessed current self-select reservation. The SQL floor depends on condition_key, not current gate ownership or holder liveness. No historical loaded-source identity is asserted.",
      "clearerQualification": {
        "conditionProducer": "greenMainSloConditionKey/runGreenMainSloPass source witness; historical emission not read",
        "conditionResolver": "Existing watchdog: measuredRecovery or explicitlySupersededByNewQueue, with distinct resolution summary. Supersession is not measured recovery or a durable fix.",
        "manualParkReleaseContract": {
          "owner": "su-6f6f3aa0-77b0-4ab3-a9e5-126b5853a81c",
          "trigger": "work-item:done:WI-10006055",
          "evidence": "a live resolver or producer registration can still satisfy the condition",
          "condition": "Re-evaluate the historical red-admission alarm after the live green-checkpoint owner completes WI-10006055.",
          "reachability": "reachable"
        },
        "recordedReleaseOwner": "su-6f6f3aa0-77b0-4ab3-a9e5-126b5853a81c",
        "currentAuthenticatedNamedClearer": null,
        "currentGateOwnership": "UNMEASURED; intentionally not queried",
        "triggerLimit": "Gate-item completion or release:green is a wake/recheck trigger, not exact episode recovery or park clearance proof.",
        "independentControls": "Self-select reservation, durable park, external blocker, review/readiness and lifecycle guards remain separate."
      },
      "executionQualification": "No new execution or original-scope fix demonstrated. Saved state and missing holder do not authorize claim, release or monitoring.",
      "finalR1Disposition": "UNRESOLVED: historical condition truth/source identity, legitimate exception, current named authenticated authority and original-scope execution."
    },
    {
      "id": "WI-6554700010009909",
      "frozenSource": {
        "path": "/mnt/data/papercusp-audit-inputs/c52-r1-frozen-20261106T1917Z/WI-6554700010009909.json",
        "sha256": "1889ddb098caf7f6e225c3db2fe63fb87dfdef0ae71d74fecad9477673dca1ff",
        "raw": {
          "id": "WI-6554700010009909",
          "kind": "bug",
          "family": "issue",
          "harness": "papercusp",
          "title": "[alarm:green-main-slo:%5B%22papercusp-workspace%22%2C%22papercusp%22%2C%22red-adding-admission%22%2C%22green-main-slo%3Apapercusp%3Ared-adding-admission%3Acabba",
          "summary": "Owning work-item for condition 'alarm:green-main-slo:%5B%22papercusp-workspace%22%2C%22papercusp%22%2C%22red-adding-admission%22%2C%22green-main-slo%3Apapercusp%3Ared-adding-admission%3Acabba37d710342f1a7fefdc165a6acbbc85def2c%22%2C%220a16d4a6fac24e6df84192786ab07129978ab561%22%5D', minted by the condition bridge (P-003, gate-ownership-condition-singleton-2026-08-03). This item is the SINGLETON for this condition — the partial unique index on work_items.condition_key guarantees at most one open owner, so claim THIS rather than filing another.\n\nLatest alarm: An admission added red on papercusp\nFirst seen: 2026-10-13T06:30:49.115Z · open since: 2026-10-13T06:30:49.115Z · alarms: 1\n\nLatest alarm detail (from the emitter):\nThe round after admitting cabba37d7103 recorded more failures than the round before it.\n\n— emitted by pid 1496768, process started 2026-10-13T05:50:12.058Z (up 40m), cwd /home/marsh-office/papercupai-workspace/papercusp/apps/operator. If that start time PREDATES the fix you are checking, this process never loaded it (no hot-reload) and no deploy will reach it — restart that host instead of re-investigating the alarm.",
          "state": "open",
          "assignee": null,
          "takenAt": null,
          "lastProgressAt": "2026-10-14T16:29:26.718Z",
          "assignedBy": null,
          "createdBy": null,
          "severity": "major",
          "goalId": null,
          "tags": null,
          "sourcePlanSlug": null,
          "sourcePlanItemIds": null,
          "redundancy": null,
          "expectedCostCents": null,
          "parent": null,
          "payload": {
            "_ei": {
              "scope": "harness:papercusp",
              "source": "engineer",
              "severity": "major",
              "signal_origin": "organic"
            },
            "_bridge": {
              "mintedAt": "2026-10-13T06:31:03.424Z",
              "conditionKey": "alarm:green-main-slo:%5B%22papercusp-workspace%22%2C%22papercusp%22%2C%22red-adding-admission%22%2C%22green-main-slo%3Apapercusp%3Ared-adding-admission%3Acabba37d710342f1a7fefdc165a6acbbc85def2c%22%2C%220a16d4a6fac24e6df84192786ab07129978ab561%22%5D"
            },
            "reporter": {
              "at": "2026-10-13T06:31:03.430Z",
              "id": null,
              "kind": "watchdog",
              "basis": "no-session"
            },
            "_claimHold": true,
            "claim_hold_at": "2026-10-14T16:30:38.877Z",
            "claim_hold_by": "su-2633542a-1ba8-4973-b488-29ed04a24fa1",
            "reporterKinds": [
              "watchdog"
            ],
            "claim_hold_reason": "Parked from bug-drain selection while another live agent owns the related LIVE_GATE_OPS lane; evidence and checkpoint are recorded.",
            "freshnessEnvelope": {
              "observedAt": "2026-10-13T06:31:03.430Z",
              "linkedFixRefs": [],
              "reporterSession": null,
              "observedSourceSha": "62493910da",
              "toolSchemaVersion": null,
              "observedRuntimeSha": "62493910da",
              "deployBuildIdentity": "62493910da@0.0.0",
              "reporterRuntimeVersion": "0.0.0",
              "lastSuccessfulReproductionAt": null
            },
            "claim_hold_release": {
              "owner": "su-6f6f3aa0-77b0-4ab3-a9e5-126b5853a81c",
              "trigger": "work-item:done:WI-10006055",
              "evidence": "a live resolver or producer registration can still satisfy the condition",
              "condition": "The live gate owner’s work-item WI-10006055 is done; then re-read gate.greenCheckpoint.ownership and this exact historical condition before deciding whether this bug remains actionable.",
              "reachability": "reachable"
            },
            "claim_history_post_id": 9001788375295,
            "implementationReadiness": {
              "reason": "no-acceptance-evidence-at-creation",
              "source": "creation-enrollment",
              "status": "unknown",
              "updatedAt": "2026-10-13T06:31:03.430Z",
              "schemaVersion": "implementation-readiness-v1"
            }
          },
          "definition": null,
          "rank": null,
          "rankWriter": null,
          "rankUpdatedAt": null,
          "priority": null,
          "terminalOwner": null,
          "terminalCompletionRef": null,
          "terminalCompletionEvidence": null,
          "completionAuthority": null,
          "origin": "local",
          "auditVerdict": null,
          "verifiedAuthorGithubUserId": null,
          "createdAt": "2026-10-13T06:31:03.430Z",
          "updatedAt": "2026-10-14T16:30:38.877Z",
          "closedAt": null
        }
      },
      "originalLedgerRow": {
        "id": "WI-6554700010009909",
        "source": "/mnt/data/papercusp-audit-inputs/c52-r1-frozen-20261106T1917Z/WI-6554700010009909.json",
        "sourceSha256": "1889ddb098caf7f6e225c3db2fe63fb87dfdef0ae71d74fecad9477673dca1ff",
        "manifestSha256": "75f699e3073a53df71db467214e8d3271ab3df35aca42fd3a5dcd1918f9af1ad",
        "state": "open",
        "rowAgeSecondsAtSnapshot": 2119506.198262,
        "rawRestrictionVerdict": {
          "id": "WI-6554700010009909",
          "admissible": false,
          "refusedBy": "live-gate-ops",
          "failedFloors": [
            "live-gate-ops",
            "claim-hold"
          ],
          "detail": "LIVE_GATE_OPS condition (gate-red-streak: or green-stall: singleton, or an alarm:green-main-slo: time-since-green/time-since-verdict/red-adding-admission/round-cycle-time/queue-idle alarm) — reserved to the one registered live gate fixer and excluded from opportunistic self-select. A leader/owner may still dispatch or claim it BY ID after checking gate.greenCheckpoint.ownership."
        },
        "restrictions": [
          {
            "floor": "live-gate-ops",
            "stateProducerRecorded": null,
            "enteredAtRecorded": null,
            "ageSecondsAtSnapshot": null,
            "accountableClearerRecorded": null,
            "releaseConditionRecordedOrEvaluatorRule": "Registered live gate owner progresses this lane; no competing takeover or repeated gate status read.",
            "currentEvidence": {
              "scope": "LIVE_GATE_OPS",
              "status": "excluded from this investigation lane"
            },
            "verification": "unassessed; recorded values and evaluator rules do not establish legitimacy",
            "unknownFields": [
              "stateProducer",
              "enteredAt",
              "accountableClearer"
            ]
          },
          {
            "floor": "claim-hold",
            "stateProducerRecorded": "su-2633542a-1ba8-4973-b488-29ed04a24fa1",
            "enteredAtRecorded": "2026-10-14T16:30:38.877Z",
            "ageSecondsAtSnapshot": 1997130.751262,
            "accountableClearerRecorded": "su-6f6f3aa0-77b0-4ab3-a9e5-126b5853a81c",
            "releaseConditionRecordedOrEvaluatorRule": "The live gate owner’s work-item WI-10006055 is done; then re-read gate.greenCheckpoint.ownership and this exact historical condition before deciding whether this bug remains actionable.",
            "currentEvidence": {
              "claim_hold_at": "2026-10-14T16:30:38.877Z",
              "claim_hold_by": "su-2633542a-1ba8-4973-b488-29ed04a24fa1",
              "claim_hold_reason": "Parked from bug-drain selection while another live agent owns the related LIVE_GATE_OPS lane; evidence and checkpoint are recorded.",
              "claim_hold_release": {
                "owner": "su-6f6f3aa0-77b0-4ab3-a9e5-126b5853a81c",
                "trigger": "work-item:done:WI-10006055",
                "evidence": "a live resolver or producer registration can still satisfy the condition",
                "condition": "The live gate owner’s work-item WI-10006055 is done; then re-read gate.greenCheckpoint.ownership and this exact historical condition before deciding whether this bug remains actionable.",
                "reachability": "reachable"
              }
            },
            "verification": "unassessed; recorded values and evaluator rules do not establish legitimacy",
            "unknownFields": [],
            "writerProvenanceVerification": {
              "sourceRules": "work-items.ts:setWorkItemClaimHold and work-items-admission-promoter.ts:qualifiedAgentPark; corroboration grants no release authority",
              "checks": [
                {
                  "convention": "claim_hold",
                  "recordedActor": "su-2633542a-1ba8-4973-b488-29ed04a24fa1",
                  "corroboratedCanonicalWriter": true,
                  "criteria": {
                    "latestIsCanonicalSet": true,
                    "auditActorMatches": true,
                    "modeMatches": true,
                    "byMatches": true,
                    "reasonMatches": true,
                    "timestampMatches": true,
                    "releaseContractMatches": true
                  },
                  "auditId": "wi-claim-hold-mv8btggv-hljdq0",
                  "notProven": [
                    "current actor authority",
                    "legitimacy of underlying reason",
                    "truth of arbitrary release condition",
                    "clearance",
                    "execution"
                  ]
                }
              ],
              "noConventionRecorded": false
            }
          }
        ],
        "controlEvidence": {
          "implementationReadiness": {
            "reason": "no-acceptance-evidence-at-creation",
            "source": "creation-enrollment",
            "status": "unknown",
            "updatedAt": "2026-10-13T06:31:03.430Z",
            "schemaVersion": "implementation-readiness-v1"
          },
          "_claimHold": true,
          "claim_hold_at": "2026-10-14T16:30:38.877Z",
          "claim_hold_by": "su-2633542a-1ba8-4973-b488-29ed04a24fa1",
          "claim_hold_reason": "Parked from bug-drain selection while another live agent owns the related LIVE_GATE_OPS lane; evidence and checkpoint are recorded.",
          "claim_hold_release": {
            "owner": "su-6f6f3aa0-77b0-4ab3-a9e5-126b5853a81c",
            "trigger": "work-item:done:WI-10006055",
            "evidence": "a live resolver or producer registration can still satisfy the condition",
            "condition": "The live gate owner’s work-item WI-10006055 is done; then re-read gate.greenCheckpoint.ownership and this exact historical condition before deciding whether this bug remains actionable.",
            "reachability": "reachable"
          },
          "reporter": {
            "at": "2026-10-13T06:31:03.430Z",
            "id": null,
            "kind": "watchdog",
            "basis": "no-session"
          },
          "freshnessEnvelope": {
            "observedAt": "2026-10-13T06:31:03.430Z",
            "linkedFixRefs": [],
            "reporterSession": null,
            "observedSourceSha": "62493910da",
            "toolSchemaVersion": null,
            "observedRuntimeSha": "62493910da",
            "deployBuildIdentity": "62493910da@0.0.0",
            "reporterRuntimeVersion": "0.0.0",
            "lastSuccessfulReproductionAt": null
          }
        },
        "accountableInvestigator": "su-c52a1707-13f5-4080-870b-f7143c271d73",
        "disposition": "unassessed",
        "legitimateException": null,
        "executionEvidence": null,
        "remainingVerification": [
          "Actual source writer and recorded producer",
          "Restriction evidence, age, accountable authorized clearer and exact release condition",
          "Legitimacy or false-restriction repair",
          "Same-ID execution or explicit Avi disposition"
        ],
        "schemaVersion": "luna-r1-causal-evidence-ledger-v4",
        "sourceQualification": {
          "status": "clearance mechanisms mapped; row-specific causal/legitimacy verification remains open",
          "registry": "/home/marsh-office/.papercusp/evidence/c52-luna-r1-20261106/restriction-authority-registry-v1.json",
          "registrySha256": "1b51f4be4a288749652dfaf9f7c7d4547aae962dd0d33a798f8e729f9e49dfbe",
          "floorMappings": [
            {
              "floor": "live-gate-ops",
              "mechanismRef": "/home/marsh-office/.papercusp/evidence/c52-luna-r1-20261106/restriction-authority-registry-v1.json#/floors/live-gate-ops",
              "rowVerification": "unassessed",
              "requiredRowEvidence": [
                "exact condition_key",
                "condition producer",
                "registered ownership evidence supplied by that lane"
              ]
            },
            {
              "floor": "claim-hold",
              "mechanismRef": "/home/marsh-office/.papercusp/evidence/c52-luna-r1-20261106/restriction-authority-registry-v1.json#/floors/claim-hold",
              "rowVerification": "unassessed",
              "requiredRowEvidence": [
                "both provenance conventions",
                "typed release contract or precise legacy condition",
                "condition-specific proof",
                "current assignment/fingerprint",
                "owner authority if required"
              ],
              "recordedReleaseContractOwner": "su-6f6f3aa0-77b0-4ab3-a9e5-126b5853a81c",
              "recordedLeaseHolder": null,
              "recordedParker": "su-2633542a-1ba8-4973-b488-29ed04a24fa1",
              "authorityVerified": false
            }
          ]
        },
        "postFreezeControlContext": {
          "artifact": "/home/marsh-office/.papercusp/evidence/c52-luna-r1-20261106/live-control-enrichment-20261106T1950Z-v2.json",
          "observedAt": "2026-11-06 19:48:21.753008+00",
          "record": {
            "id": "WI-6554700010009909",
            "state": "open",
            "harness": "papercusp",
            "takenAt": null,
            "takenBy": null,
            "admission": "auto",
            "createdAt": 1791873063430,
            "updatedAt": 1791995438877,
            "admittedAt": "2026-10-13T06:31:03.43+00:00",
            "admittedBy": "bypass:condition-key",
            "duplicateOf": null,
            "conditionKey": "alarm:green-main-slo:%5B%22papercusp-workspace%22%2C%22papercusp%22%2C%22red-adding-admission%22%2C%22green-main-slo%3Apapercusp%3Ared-adding-admission%3Acabba37d710342f1a7fefdc165a6acbbc85def2c%22%2C%220a16d4a6fac24e6df84192786ab07129978ab561%22%5D",
            "holderPresence": null,
            "sourcePlanSlug": null,
            "sourcePlanItemIds": null
          },
          "limitations": [
            "Presence absence does not establish holder death or authorize release",
            "Current terminal state alone does not prove execution",
            "Admission values are current post-freeze evidence; historical producer/state-transition audit still required"
          ]
        },
        "postFreezeDependencyContext": {
          "artifact": "/home/marsh-office/.papercusp/evidence/c52-luna-r1-20261106/dependency-enrichment-20261106T1930Z.json",
          "observedAt": "2026-11-06T19:26:36.952682Z",
          "edges": [],
          "coverage": "not queried by this enrichment; empty list is not absence evidence"
        },
        "historicalAuditEvidence": {
          "artifact": "/home/marsh-office/.papercusp/evidence/c52-luna-r1-20261106/historical-audit-enrichment-20261106T2010Z.json",
          "sha256": "4b396df0818120147036644a9e33893170b4d271e5a5fd1a87e0e720a9884410",
          "recordPointer": "/queryResult/rows/0/items/5812",
          "observedAt": "2026-11-06 20:03:09.124326+00",
          "eventCutoffMs": 1793992569628,
          "eventCount": 1,
          "coverage": "Available work_items:% audit only; empty is not no-transition proof; nonterminal changes and some needs-human changes are undated."
        }
      },
      "savedNovember7Qualification": {
        "schemaVersion": "luna-r1-causal-qualification-v1",
        "id": "WI-6554700010009909",
        "sourceLedger": {
          "path": "/home/marsh-office/.papercusp/evidence/c52-luna-r1-20261106/causal-ledger-v4.jsonl",
          "sha256": "7f1962fb5c22f1bc2be9625406b315f6b5f4fd190b4743d7f972a4fb2c935866",
          "rowSourceSha256": "1889ddb098caf7f6e225c3db2fe63fb87dfdef0ae71d74fecad9477673dca1ff"
        },
        "frozenState": "open",
        "frozenFloors": [
          "claim-hold",
          "live-gate-ops"
        ],
        "currentControlObservedAt": "2026-11-07 11:32:12.960427-05",
        "currentState": "open",
        "currentHolder": null,
        "currentFloorVerdict": {
          "id": "WI-6554700010009909",
          "admissible": false,
          "refusedBy": "live-gate-ops",
          "failedFloors": [
            "live-gate-ops",
            "claim-hold"
          ],
          "detail": "LIVE_GATE_OPS condition (gate-red-streak: or green-stall: singleton, or an alarm:green-main-slo: time-since-green/time-since-verdict/red-adding-admission/round-cycle-time/queue-idle alarm) — reserved to the one registered live gate fixer and excluded from opportunistic self-select. A leader/owner may still dispatch or claim it BY ID after checking gate.greenCheckpoint.ownership."
        },
        "floorDifference": {
          "noLongerObserved": [],
          "newlyObserved": []
        },
        "adoptionQualification": null,
        "parkQualification": {
          "artifact": ".papercusp/evidence/c52-luna-r1-20261106/current-park-qualification-20261107T1715Z.json",
          "controlSnapshotAt": "2026-11-07 11:32:12.960427-05",
          "measuredAt": "2026-11-07T17:28:35.995Z",
          "qualificationAsMeasured": "reachable",
          "certification": "reachability-only; underlying release condition and clearer authority unverified"
        },
        "disposition": "unassessed",
        "executionEvidence": null,
        "nextActions": [
          "preserve park; qualify its exact condition and authorized clearer, with no automatic release from reachability"
        ],
        "limits": [
          "separately dated observations; not an immutable current-state snapshot",
          "a correct floor or release path does not prove underlying legitimacy",
          "adoption eligibility is report revision, not permission to implement"
        ]
      },
      "savedNovember8": {
        "observedAt": "2026-11-08 15:02:23.578069+00",
        "batch": 14,
        "recordPointer": "/rows/0/items/212",
        "rawProjectedRecord": {
          "id": "WI-6554700010009909",
          "state": "open",
          "holder": null,
          "control": {
            "_claimHold": true,
            "claim_hold_at": "2026-10-14T16:30:38.877Z",
            "claim_hold_by": "su-2633542a-1ba8-4973-b488-29ed04a24fa1",
            "claim_hold_reason": "Parked from bug-drain selection while another live agent owns the related LIVE_GATE_OPS lane; evidence and checkpoint are recorded.",
            "claim_hold_release": {
              "owner": "su-6f6f3aa0-77b0-4ab3-a9e5-126b5853a81c",
              "trigger": "work-item:done:WI-10006055",
              "evidence": "a live resolver or producer registration can still satisfy the condition",
              "condition": "The live gate owner’s work-item WI-10006055 is done; then re-read gate.greenCheckpoint.ownership and this exact historical condition before deciding whether this bug remains actionable.",
              "reachability": "reachable"
            },
            "implementationReadiness": {
              "reason": "no-acceptance-evidence-at-creation",
              "source": "creation-enrollment",
              "status": "unknown",
              "updatedAt": "2026-10-13T06:31:03.430Z",
              "schemaVersion": "implementation-readiness-v1"
            }
          },
          "takenAt": null,
          "admission": "auto",
          "updatedAt": 1791995438877,
          "admittedAt": "2026-10-13T06:31:03.43+00:00",
          "admittedBy": "bypass:condition-key",
          "sourcePlan": null,
          "duplicateOf": null,
          "sourceItems": null,
          "conditionKey": "alarm:green-main-slo:%5B%22papercusp-workspace%22%2C%22papercusp%22%2C%22red-adding-admission%22%2C%22green-main-slo%3Apapercusp%3Ared-adding-admission%3Acabba37d710342f1a7fefdc165a6acbbc85def2c%22%2C%220a16d4a6fac24e6df84192786ab07129978ab561%22%5D",
          "stateChangedAt": "2026-10-13T06:31:03.43+00:00"
        }
      },
      "reconciliation": {
        "id": "WI-6554700010009909",
        "frozenSourceSha256": "1889ddb098caf7f6e225c3db2fe63fb87dfdef0ae71d74fecad9477673dca1ff",
        "frozenState": "open",
        "frozenFloors": [
          "live-gate-ops",
          "claim-hold"
        ],
        "priorDisposition": "unassessed",
        "currentBatch": 14,
        "currentState": "open",
        "currentHolder": null,
        "currentAdmission": "auto",
        "currentControlKeys": [
          "_claimHold",
          "claim_hold_at",
          "claim_hold_by",
          "claim_hold_reason",
          "claim_hold_release",
          "implementationReadiness"
        ],
        "changedProjectedControlKeys": [],
        "unmeasuredFrozenControlKeys": [
          "freshnessEnvelope",
          "reporter"
        ],
        "assessment": "condition-and-clearer-legitimacy-unresolved",
        "finalR1Disposition": "unresolved"
      },
      "conditionIdentity": {
        "key": "alarm:green-main-slo:%5B%22papercusp-workspace%22%2C%22papercusp%22%2C%22red-adding-admission%22%2C%22green-main-slo%3Apapercusp%3Ared-adding-admission%3Acabba37d710342f1a7fefdc165a6acbbc85def2c%22%2C%220a16d4a6fac24e6df84192786ab07129978ab561%22%5D",
        "decodedWorkspaceInstallMetricEpisodeSubject": [
          "papercusp-workspace",
          "papercusp",
          "red-adding-admission",
          "green-main-slo:papercusp:red-adding-admission:cabba37d710342f1a7fefdc165a6acbbc85def2c",
          "0a16d4a6fac24e6df84192786ab07129978ab561"
        ],
        "datedPostFreezeKeyEqual": true,
        "frozenRawExportOmitsConditionKey": true,
        "historicalFrozenKeyUnproven": true
      },
      "sourceConditionedReservation": "The saved exact metric-slot key matches the witnessed current self-select reservation. The SQL floor depends on condition_key, not current gate ownership or holder liveness. No historical loaded-source identity is asserted.",
      "clearerQualification": {
        "conditionProducer": "greenMainSloConditionKey/runGreenMainSloPass source witness; historical emission not read",
        "conditionResolver": "Existing watchdog: measuredRecovery or explicitlySupersededByNewQueue, with distinct resolution summary. Supersession is not measured recovery or a durable fix.",
        "manualParkReleaseContract": {
          "owner": "su-6f6f3aa0-77b0-4ab3-a9e5-126b5853a81c",
          "trigger": "work-item:done:WI-10006055",
          "evidence": "a live resolver or producer registration can still satisfy the condition",
          "condition": "The live gate owner’s work-item WI-10006055 is done; then re-read gate.greenCheckpoint.ownership and this exact historical condition before deciding whether this bug remains actionable.",
          "reachability": "reachable"
        },
        "recordedReleaseOwner": "su-6f6f3aa0-77b0-4ab3-a9e5-126b5853a81c",
        "currentAuthenticatedNamedClearer": null,
        "currentGateOwnership": "UNMEASURED; intentionally not queried",
        "triggerLimit": "Gate-item completion or release:green is a wake/recheck trigger, not exact episode recovery or park clearance proof.",
        "independentControls": "Self-select reservation, durable park, external blocker, review/readiness and lifecycle guards remain separate."
      },
      "executionQualification": "No new execution or original-scope fix demonstrated. Saved state and missing holder do not authorize claim, release or monitoring.",
      "finalR1Disposition": "UNRESOLVED: historical condition truth/source identity, legitimate exception, current named authenticated authority and original-scope execution."
    },
    {
      "id": "WI-6554700010009910",
      "frozenSource": {
        "path": "/mnt/data/papercusp-audit-inputs/c52-r1-frozen-20261106T1917Z/WI-6554700010009910.json",
        "sha256": "9423ebc7d7c75e86a92e0ec53329913fff3660bb576ce200153802352bf82d7f",
        "raw": {
          "id": "WI-6554700010009910",
          "kind": "bug",
          "family": "issue",
          "harness": "papercusp",
          "title": "[alarm:green-main-slo:%5B%22papercusp-workspace%22%2C%22papercusp%22%2C%22round-cycle-time%22%2C%22green-main-slo%3Apapercusp%3Around-cycle-time%3A0a16d4a6fac24",
          "summary": "Owning work-item for condition 'alarm:green-main-slo:%5B%22papercusp-workspace%22%2C%22papercusp%22%2C%22round-cycle-time%22%2C%22green-main-slo%3Apapercusp%3Around-cycle-time%3A0a16d4a6fac24e6df84192786ab07129978ab561%3A2%22%2C%220a16d4a6fac24e6df84192786ab07129978ab561%22%5D', minted by the condition bridge (P-003, gate-ownership-condition-singleton-2026-08-03). This item is the SINGLETON for this condition — the partial unique index on work_items.condition_key guarantees at most one open owner, so claim THIS rather than filing another.\n\nLatest alarm: Repair round 2 took 3.1h on papercusp\nFirst seen: 2026-10-13T06:30:46.085Z · open since: 2026-10-13T06:30:46.085Z · alarms: 1\n\nLatest alarm detail (from the emitter):\nFrozen candidate 0a16d4a6fac2: the newest round interval exceeds the 2.0h target.\n\n— emitted by pid 1496768, process started 2026-10-13T05:50:12.303Z (up 40m), cwd /home/marsh-office/papercupai-workspace/papercusp/apps/operator. If that start time PREDATES the fix you are checking, this process never loaded it (no hot-reload) and no deploy will reach it — restart that host instead of re-investigating the alarm.",
          "state": "blocked",
          "assignee": null,
          "takenAt": null,
          "lastProgressAt": null,
          "assignedBy": null,
          "createdBy": null,
          "severity": "major",
          "goalId": null,
          "tags": null,
          "sourcePlanSlug": null,
          "sourcePlanItemIds": null,
          "redundancy": null,
          "expectedCostCents": null,
          "parent": null,
          "payload": {
            "_ei": {
              "scope": "harness:papercusp",
              "source": "engineer",
              "severity": "major",
              "signal_origin": "organic"
            },
            "_bridge": {
              "mintedAt": "2026-10-13T06:31:03.809Z",
              "conditionKey": "alarm:green-main-slo:%5B%22papercusp-workspace%22%2C%22papercusp%22%2C%22round-cycle-time%22%2C%22green-main-slo%3Apapercusp%3Around-cycle-time%3A0a16d4a6fac24e6df84192786ab07129978ab561%3A2%22%2C%220a16d4a6fac24e6df84192786ab07129978ab561%22%5D"
            },
            "reporter": {
              "at": "2026-10-13T06:31:03.810Z",
              "id": null,
              "kind": "watchdog",
              "basis": "no-session"
            },
            "reporterKinds": [
              "watchdog"
            ],
            "externalBlockers": [
              {
                "ref": "git-sync:papercusp",
                "kind": "runtime",
                "status": "cleared",
                "summary": "The active shared git-sync exclusive lease continues to block a safe staging restart.",
                "evidence": "Recheck at 2026-10-25T22:13Z still showed system:git-sync PID 3235268 holding exclusive git-sync:papercusp, now through 22:23:27.670Z. logs:read at 22:14Z showed active submodule work plus PG 57014 lock/statement timeouts on git-sync:hive-canary and a quartermaster heartbeat failure; the canary tick was skipped. This does not establish the cause of the October 13 round-cycle alarm.",
                "nextVerb": "At the next armed wake, re-read locks:list and recent papercusp-bg-host.service logs; after release, verify :3170 build identity before deciding whether to restart.",
                "clearedAt": "2026-10-25T22:22:39.582Z",
                "clearedBy": "su-c75d2c51-7f41-4ef3-abdc-900bb0e6a4ba",
                "createdAt": "2026-10-25T22:12:39.287Z",
                "createdBy": "su-c75d2c51-7f41-4ef3-abdc-900bb0e6a4ba",
                "updatedAt": "2026-10-25T22:22:39.582Z",
                "capability": "live-dependency",
                "capabilitySource": "inferred"
              },
              {
                "ref": "resource:released:git-sync:papercusp",
                "kind": "event",
                "status": "active",
                "summary": "The active system git-sync lease blocks staging from incorporating the watchdog source commit.",
                "evidence": "Current locks:list showed system:git-sync:3341748 holding exclusive git-sync:papercusp, acquired 2026-10-25T22:48:14Z and still held. Filtered bg-host logs show the sync advancing through submodule batches; the latest pipeline_position read showed the watchdog target committed locally but not on staging.",
                "nextVerb": "Await resource:released:git-sync:papercusp, then re-read the lock and ensure the target commit is pushed. Advance the isolated staging generation with papercup-staging-sync, verify its process cwd/build SHA, run a current-build SLO pass, and re-read the exact condition.",
                "createdAt": "2026-10-25T23:02:02.464Z",
                "createdBy": "su-c75d2c51-7f41-4ef3-abdc-900bb0e6a4ba",
                "recheckAt": "2026-11-06T18:30:34.724Z",
                "updatedAt": "2026-11-06T17:30:34.724Z",
                "capability": "live-dependency",
                "recheckedAt": "2026-11-06T17:30:34.724Z",
                "reachability": {
                  "basis": "unmeasured",
                  "verdict": "unknown",
                  "evidence": "trigger \"resource:released:git-sync:papercusp\" may wake a consumer but cannot establish the specific release condition; subject-bound evidence is required",
                  "checkedAt": "2026-11-06T17:39:52.095Z",
                  "authoritative": false,
                  "uncertifiedReason": "broad"
                },
                "recheckSource": "system:unprovable-wait-backfill",
                "capabilitySource": "inferred",
                "recheckDisposition": "escalated"
              }
            ],
            "freshnessEnvelope": {
              "observedAt": "2026-10-13T06:31:03.810Z",
              "linkedFixRefs": [],
              "reporterSession": null,
              "observedSourceSha": "62493910da",
              "toolSchemaVersion": null,
              "observedRuntimeSha": "62493910da",
              "deployBuildIdentity": "62493910da@0.0.0",
              "reporterRuntimeVersion": "0.0.0",
              "lastSuccessfulReproductionAt": null
            },
            "claim_history_post_id": 9001788375295,
            "implementationReadiness": {
              "reason": "no-acceptance-evidence-at-creation",
              "source": "creation-enrollment",
              "status": "unknown",
              "updatedAt": "2026-10-13T06:31:03.810Z",
              "schemaVersion": "implementation-readiness-v1"
            }
          },
          "definition": null,
          "externalBlockers": [
            {
              "ref": "git-sync:papercusp",
              "kind": "runtime",
              "status": "cleared",
              "summary": "The active shared git-sync exclusive lease continues to block a safe staging restart.",
              "evidence": "Recheck at 2026-10-25T22:13Z still showed system:git-sync PID 3235268 holding exclusive git-sync:papercusp, now through 22:23:27.670Z. logs:read at 22:14Z showed active submodule work plus PG 57014 lock/statement timeouts on git-sync:hive-canary and a quartermaster heartbeat failure; the canary tick was skipped. This does not establish the cause of the October 13 round-cycle alarm.",
              "nextVerb": "At the next armed wake, re-read locks:list and recent papercusp-bg-host.service logs; after release, verify :3170 build identity before deciding whether to restart.",
              "clearedAt": "2026-10-25T22:22:39.582Z",
              "clearedBy": "su-c75d2c51-7f41-4ef3-abdc-900bb0e6a4ba",
              "createdAt": "2026-10-25T22:12:39.287Z",
              "createdBy": "su-c75d2c51-7f41-4ef3-abdc-900bb0e6a4ba",
              "updatedAt": "2026-10-25T22:22:39.582Z",
              "capability": "live-dependency",
              "capabilitySource": "inferred"
            },
            {
              "ref": "resource:released:git-sync:papercusp",
              "kind": "event",
              "status": "active",
              "summary": "The active system git-sync lease blocks staging from incorporating the watchdog source commit.",
              "evidence": "Current locks:list showed system:git-sync:3341748 holding exclusive git-sync:papercusp, acquired 2026-10-25T22:48:14Z and still held. Filtered bg-host logs show the sync advancing through submodule batches; the latest pipeline_position read showed the watchdog target committed locally but not on staging.",
              "nextVerb": "Await resource:released:git-sync:papercusp, then re-read the lock and ensure the target commit is pushed. Advance the isolated staging generation with papercup-staging-sync, verify its process cwd/build SHA, run a current-build SLO pass, and re-read the exact condition.",
              "createdAt": "2026-10-25T23:02:02.464Z",
              "createdBy": "su-c75d2c51-7f41-4ef3-abdc-900bb0e6a4ba",
              "recheckAt": "2026-11-06T18:30:34.724Z",
              "updatedAt": "2026-11-06T17:30:34.724Z",
              "capability": "live-dependency",
              "recheckedAt": "2026-11-06T17:30:34.724Z",
              "reachability": {
                "basis": "unmeasured",
                "verdict": "unknown",
                "evidence": "trigger \"resource:released:git-sync:papercusp\" may wake a consumer but cannot establish the specific release condition; subject-bound evidence is required",
                "checkedAt": "2026-11-06T17:39:52.095Z",
                "authoritative": false,
                "uncertifiedReason": "broad"
              },
              "recheckSource": "system:unprovable-wait-backfill",
              "capabilitySource": "inferred",
              "recheckDisposition": "escalated"
            }
          ],
          "rank": null,
          "rankWriter": null,
          "rankUpdatedAt": null,
          "priority": null,
          "terminalOwner": null,
          "terminalCompletionRef": null,
          "terminalCompletionEvidence": null,
          "completionAuthority": null,
          "origin": "local",
          "auditVerdict": null,
          "verifiedAuthorGithubUserId": null,
          "createdAt": "2026-10-13T06:31:03.810Z",
          "updatedAt": "2026-11-06T17:39:52.467Z",
          "closedAt": null
        }
      },
      "originalLedgerRow": {
        "id": "WI-6554700010009910",
        "source": "/mnt/data/papercusp-audit-inputs/c52-r1-frozen-20261106T1917Z/WI-6554700010009910.json",
        "sourceSha256": "9423ebc7d7c75e86a92e0ec53329913fff3660bb576ce200153802352bf82d7f",
        "manifestSha256": "75f699e3073a53df71db467214e8d3271ab3df35aca42fd3a5dcd1918f9af1ad",
        "state": "blocked",
        "rowAgeSecondsAtSnapshot": 2119505.818262,
        "rawRestrictionVerdict": {
          "id": "WI-6554700010009910",
          "admissible": false,
          "refusedBy": "not-claimable-status",
          "failedFloors": [
            "not-claimable-status",
            "live-gate-ops",
            "external-blocker"
          ],
          "detail": "status is terminal or otherwise not in the claimable set"
        },
        "restrictions": [
          {
            "floor": "not-claimable-status",
            "stateProducerRecorded": null,
            "enteredAtRecorded": null,
            "ageSecondsAtSnapshot": null,
            "accountableClearerRecorded": null,
            "releaseConditionRecordedOrEvaluatorRule": "Canonical authorized state transition after all underlying restrictions are satisfied; status alone is not causal explanation.",
            "currentEvidence": {
              "state": "blocked",
              "updatedAt": "2026-11-06T17:39:52.467Z"
            },
            "verification": "unassessed; recorded values and evaluator rules do not establish legitimacy",
            "unknownFields": [
              "stateProducer",
              "enteredAt",
              "accountableClearer"
            ]
          },
          {
            "floor": "live-gate-ops",
            "stateProducerRecorded": null,
            "enteredAtRecorded": null,
            "ageSecondsAtSnapshot": null,
            "accountableClearerRecorded": null,
            "releaseConditionRecordedOrEvaluatorRule": "Registered live gate owner progresses this lane; no competing takeover or repeated gate status read.",
            "currentEvidence": {
              "scope": "LIVE_GATE_OPS",
              "status": "excluded from this investigation lane"
            },
            "verification": "unassessed; recorded values and evaluator rules do not establish legitimacy",
            "unknownFields": [
              "stateProducer",
              "enteredAt",
              "accountableClearer"
            ]
          },
          {
            "floor": "external-blocker",
            "stateProducerRecorded": [
              "su-c75d2c51-7f41-4ef3-abdc-900bb0e6a4ba"
            ],
            "enteredAtRecorded": "2026-10-25T23:02:02.464Z",
            "ageSecondsAtSnapshot": 1023247.164262,
            "accountableClearerRecorded": [
              "resource:released:git-sync:papercusp"
            ],
            "releaseConditionRecordedOrEvaluatorRule": [
              "Await resource:released:git-sync:papercusp, then re-read the lock and ensure the target commit is pushed. Advance the isolated staging generation with papercup-staging-sync, verify its process cwd/build SHA, run a current-build SLO pass, and re-read the exact condition."
            ],
            "currentEvidence": [
              {
                "ref": "git-sync:papercusp",
                "kind": "runtime",
                "status": "cleared",
                "summary": "The active shared git-sync exclusive lease continues to block a safe staging restart.",
                "evidence": "Recheck at 2026-10-25T22:13Z still showed system:git-sync PID 3235268 holding exclusive git-sync:papercusp, now through 22:23:27.670Z. logs:read at 22:14Z showed active submodule work plus PG 57014 lock/statement timeouts on git-sync:hive-canary and a quartermaster heartbeat failure; the canary tick was skipped. This does not establish the cause of the October 13 round-cycle alarm.",
                "nextVerb": "At the next armed wake, re-read locks:list and recent papercusp-bg-host.service logs; after release, verify :3170 build identity before deciding whether to restart.",
                "clearedAt": "2026-10-25T22:22:39.582Z",
                "clearedBy": "su-c75d2c51-7f41-4ef3-abdc-900bb0e6a4ba",
                "createdAt": "2026-10-25T22:12:39.287Z",
                "createdBy": "su-c75d2c51-7f41-4ef3-abdc-900bb0e6a4ba",
                "updatedAt": "2026-10-25T22:22:39.582Z",
                "capability": "live-dependency",
                "capabilitySource": "inferred"
              },
              {
                "ref": "resource:released:git-sync:papercusp",
                "kind": "event",
                "status": "active",
                "summary": "The active system git-sync lease blocks staging from incorporating the watchdog source commit.",
                "evidence": "Current locks:list showed system:git-sync:3341748 holding exclusive git-sync:papercusp, acquired 2026-10-25T22:48:14Z and still held. Filtered bg-host logs show the sync advancing through submodule batches; the latest pipeline_position read showed the watchdog target committed locally but not on staging.",
                "nextVerb": "Await resource:released:git-sync:papercusp, then re-read the lock and ensure the target commit is pushed. Advance the isolated staging generation with papercup-staging-sync, verify its process cwd/build SHA, run a current-build SLO pass, and re-read the exact condition.",
                "createdAt": "2026-10-25T23:02:02.464Z",
                "createdBy": "su-c75d2c51-7f41-4ef3-abdc-900bb0e6a4ba",
                "recheckAt": "2026-11-06T18:30:34.724Z",
                "updatedAt": "2026-11-06T17:30:34.724Z",
                "capability": "live-dependency",
                "recheckedAt": "2026-11-06T17:30:34.724Z",
                "reachability": {
                  "basis": "unmeasured",
                  "verdict": "unknown",
                  "evidence": "trigger \"resource:released:git-sync:papercusp\" may wake a consumer but cannot establish the specific release condition; subject-bound evidence is required",
                  "checkedAt": "2026-11-06T17:39:52.095Z",
                  "authoritative": false,
                  "uncertifiedReason": "broad"
                },
                "recheckSource": "system:unprovable-wait-backfill",
                "capabilitySource": "inferred",
                "recheckDisposition": "escalated"
              }
            ],
            "verification": "unassessed; recorded values and evaluator rules do not establish legitimacy",
            "unknownFields": []
          }
        ],
        "controlEvidence": {
          "implementationReadiness": {
            "reason": "no-acceptance-evidence-at-creation",
            "source": "creation-enrollment",
            "status": "unknown",
            "updatedAt": "2026-10-13T06:31:03.810Z",
            "schemaVersion": "implementation-readiness-v1"
          },
          "externalBlockers": [
            {
              "ref": "git-sync:papercusp",
              "kind": "runtime",
              "status": "cleared",
              "summary": "The active shared git-sync exclusive lease continues to block a safe staging restart.",
              "evidence": "Recheck at 2026-10-25T22:13Z still showed system:git-sync PID 3235268 holding exclusive git-sync:papercusp, now through 22:23:27.670Z. logs:read at 22:14Z showed active submodule work plus PG 57014 lock/statement timeouts on git-sync:hive-canary and a quartermaster heartbeat failure; the canary tick was skipped. This does not establish the cause of the October 13 round-cycle alarm.",
              "nextVerb": "At the next armed wake, re-read locks:list and recent papercusp-bg-host.service logs; after release, verify :3170 build identity before deciding whether to restart.",
              "clearedAt": "2026-10-25T22:22:39.582Z",
              "clearedBy": "su-c75d2c51-7f41-4ef3-abdc-900bb0e6a4ba",
              "createdAt": "2026-10-25T22:12:39.287Z",
              "createdBy": "su-c75d2c51-7f41-4ef3-abdc-900bb0e6a4ba",
              "updatedAt": "2026-10-25T22:22:39.582Z",
              "capability": "live-dependency",
              "capabilitySource": "inferred"
            },
            {
              "ref": "resource:released:git-sync:papercusp",
              "kind": "event",
              "status": "active",
              "summary": "The active system git-sync lease blocks staging from incorporating the watchdog source commit.",
              "evidence": "Current locks:list showed system:git-sync:3341748 holding exclusive git-sync:papercusp, acquired 2026-10-25T22:48:14Z and still held. Filtered bg-host logs show the sync advancing through submodule batches; the latest pipeline_position read showed the watchdog target committed locally but not on staging.",
              "nextVerb": "Await resource:released:git-sync:papercusp, then re-read the lock and ensure the target commit is pushed. Advance the isolated staging generation with papercup-staging-sync, verify its process cwd/build SHA, run a current-build SLO pass, and re-read the exact condition.",
              "createdAt": "2026-10-25T23:02:02.464Z",
              "createdBy": "su-c75d2c51-7f41-4ef3-abdc-900bb0e6a4ba",
              "recheckAt": "2026-11-06T18:30:34.724Z",
              "updatedAt": "2026-11-06T17:30:34.724Z",
              "capability": "live-dependency",
              "recheckedAt": "2026-11-06T17:30:34.724Z",
              "reachability": {
                "basis": "unmeasured",
                "verdict": "unknown",
                "evidence": "trigger \"resource:released:git-sync:papercusp\" may wake a consumer but cannot establish the specific release condition; subject-bound evidence is required",
                "checkedAt": "2026-11-06T17:39:52.095Z",
                "authoritative": false,
                "uncertifiedReason": "broad"
              },
              "recheckSource": "system:unprovable-wait-backfill",
              "capabilitySource": "inferred",
              "recheckDisposition": "escalated"
            }
          ],
          "reporter": {
            "at": "2026-10-13T06:31:03.810Z",
            "id": null,
            "kind": "watchdog",
            "basis": "no-session"
          },
          "freshnessEnvelope": {
            "observedAt": "2026-10-13T06:31:03.810Z",
            "linkedFixRefs": [],
            "reporterSession": null,
            "observedSourceSha": "62493910da",
            "toolSchemaVersion": null,
            "observedRuntimeSha": "62493910da",
            "deployBuildIdentity": "62493910da@0.0.0",
            "reporterRuntimeVersion": "0.0.0",
            "lastSuccessfulReproductionAt": null
          }
        },
        "accountableInvestigator": "su-c52a1707-13f5-4080-870b-f7143c271d73",
        "disposition": "unassessed",
        "legitimateException": null,
        "executionEvidence": null,
        "remainingVerification": [
          "Actual source writer and recorded producer",
          "Restriction evidence, age, accountable authorized clearer and exact release condition",
          "Legitimacy or false-restriction repair",
          "Same-ID execution or explicit Avi disposition"
        ],
        "schemaVersion": "luna-r1-causal-evidence-ledger-v4",
        "sourceQualification": {
          "status": "clearance mechanisms mapped; row-specific causal/legitimacy verification remains open",
          "registry": "/home/marsh-office/.papercusp/evidence/c52-luna-r1-20261106/restriction-authority-registry-v1.json",
          "registrySha256": "1b51f4be4a288749652dfaf9f7c7d4547aae962dd0d33a798f8e729f9e49dfbe",
          "floorMappings": [
            {
              "floor": "not-claimable-status",
              "mechanismRef": "/home/marsh-office/.papercusp/evidence/c52-luna-r1-20261106/restriction-authority-registry-v1.json#/floors/not-claimable-status",
              "rowVerification": "unassessed",
              "requiredRowEvidence": [
                "state-transition history",
                "underlying restrictions",
                "current assignment and plan controls"
              ]
            },
            {
              "floor": "live-gate-ops",
              "mechanismRef": "/home/marsh-office/.papercusp/evidence/c52-luna-r1-20261106/restriction-authority-registry-v1.json#/floors/live-gate-ops",
              "rowVerification": "unassessed",
              "requiredRowEvidence": [
                "exact condition_key",
                "condition producer",
                "registered ownership evidence supplied by that lane"
              ]
            },
            {
              "floor": "external-blocker",
              "mechanismRef": "/home/marsh-office/.papercusp/evidence/c52-luna-r1-20261106/restriction-authority-registry-v1.json#/floors/external-blocker",
              "rowVerification": "unassessed",
              "requiredRowEvidence": [
                "every active entry",
                "kind and capability",
                "actual condition evidence",
                "authenticated accountable clearer",
                "canonical settlement receipt"
              ],
              "capabilityRoutes": [
                {
                  "ref": "resource:released:git-sync:papercusp",
                  "kind": "event",
                  "capability": "live-dependency",
                  "resolutionRoleFromCurrentSource": "dependency-owner",
                  "recordedCreator": "su-c75d2c51-7f41-4ef3-abdc-900bb0e6a4ba",
                  "namedAuthorizedClearer": null,
                  "authorityVerified": false
                }
              ],
              "v1AccountableClearerFieldCaution": "v1 extracted blocker ref values, which name resources/conditions and are not authenticated named clearers"
            }
          ]
        },
        "postFreezeControlContext": {
          "artifact": "/home/marsh-office/.papercusp/evidence/c52-luna-r1-20261106/live-control-enrichment-20261106T1950Z-v2.json",
          "observedAt": "2026-11-06 19:48:21.753008+00",
          "record": {
            "id": "WI-6554700010009910",
            "state": "blocked",
            "harness": "papercusp",
            "takenAt": null,
            "takenBy": null,
            "admission": "auto",
            "createdAt": 1791873063810,
            "updatedAt": 1793986792467,
            "admittedAt": "2026-10-13T06:31:03.81+00:00",
            "admittedBy": "bypass:condition-key",
            "duplicateOf": null,
            "conditionKey": "alarm:green-main-slo:%5B%22papercusp-workspace%22%2C%22papercusp%22%2C%22round-cycle-time%22%2C%22green-main-slo%3Apapercusp%3Around-cycle-time%3A0a16d4a6fac24e6df84192786ab07129978ab561%3A2%22%2C%220a16d4a6fac24e6df84192786ab07129978ab561%22%5D",
            "holderPresence": null,
            "sourcePlanSlug": null,
            "sourcePlanItemIds": null
          },
          "limitations": [
            "Presence absence does not establish holder death or authorize release",
            "Current terminal state alone does not prove execution",
            "Admission values are current post-freeze evidence; historical producer/state-transition audit still required"
          ]
        },
        "postFreezeDependencyContext": {
          "artifact": "/home/marsh-office/.papercusp/evidence/c52-luna-r1-20261106/dependency-enrichment-20261106T1930Z.json",
          "observedAt": "2026-11-06T19:26:36.952682Z",
          "edges": [],
          "coverage": "not queried by this enrichment; empty list is not absence evidence"
        },
        "historicalAuditEvidence": {
          "artifact": "/home/marsh-office/.papercusp/evidence/c52-luna-r1-20261106/historical-audit-enrichment-20261106T2010Z.json",
          "sha256": "4b396df0818120147036644a9e33893170b4d271e5a5fd1a87e0e720a9884410",
          "recordPointer": "/queryResult/rows/0/items/5813",
          "observedAt": "2026-11-06 20:03:09.124326+00",
          "eventCutoffMs": 1793992569628,
          "eventCount": 5,
          "coverage": "Available work_items:% audit only; empty is not no-transition proof; nonterminal changes and some needs-human changes are undated."
        }
      },
      "savedNovember7Qualification": {
        "schemaVersion": "luna-r1-causal-qualification-v1",
        "id": "WI-6554700010009910",
        "sourceLedger": {
          "path": "/home/marsh-office/.papercusp/evidence/c52-luna-r1-20261106/causal-ledger-v4.jsonl",
          "sha256": "7f1962fb5c22f1bc2be9625406b315f6b5f4fd190b4743d7f972a4fb2c935866",
          "rowSourceSha256": "9423ebc7d7c75e86a92e0ec53329913fff3660bb576ce200153802352bf82d7f"
        },
        "frozenState": "blocked",
        "frozenFloors": [
          "external-blocker",
          "live-gate-ops",
          "not-claimable-status"
        ],
        "currentControlObservedAt": "2026-11-07 11:32:12.960427-05",
        "currentState": "blocked",
        "currentHolder": null,
        "currentFloorVerdict": {
          "id": "WI-6554700010009910",
          "admissible": false,
          "refusedBy": "not-claimable-status",
          "failedFloors": [
            "not-claimable-status",
            "live-gate-ops",
            "external-blocker"
          ],
          "detail": "status is terminal or otherwise not in the claimable set"
        },
        "floorDifference": {
          "noLongerObserved": [],
          "newlyObserved": []
        },
        "adoptionQualification": null,
        "parkQualification": null,
        "disposition": "unassessed",
        "executionEvidence": null,
        "nextActions": [
          "resolve current recorded floors through existing mapped authority; final legitimacy remains unassessed"
        ],
        "limits": [
          "separately dated observations; not an immutable current-state snapshot",
          "a correct floor or release path does not prove underlying legitimacy",
          "adoption eligibility is report revision, not permission to implement"
        ]
      },
      "savedNovember8": {
        "observedAt": "2026-11-08 15:02:23.578069+00",
        "batch": 14,
        "recordPointer": "/rows/0/items/213",
        "rawProjectedRecord": {
          "id": "WI-6554700010009910",
          "state": "blocked",
          "holder": null,
          "control": {
            "externalBlockers": [
              {
                "ref": "git-sync:papercusp",
                "kind": "runtime",
                "status": "cleared",
                "summary": "The active shared git-sync exclusive lease continues to block a safe staging restart.",
                "evidence": "Recheck at 2026-10-25T22:13Z still showed system:git-sync PID 3235268 holding exclusive git-sync:papercusp, now through 22:23:27.670Z. logs:read at 22:14Z showed active submodule work plus PG 57014 lock/statement timeouts on git-sync:hive-canary and a quartermaster heartbeat failure; the canary tick was skipped. This does not establish the cause of the October 13 round-cycle alarm.",
                "nextVerb": "At the next armed wake, re-read locks:list and recent papercusp-bg-host.service logs; after release, verify :3170 build identity before deciding whether to restart.",
                "clearedAt": "2026-10-25T22:22:39.582Z",
                "clearedBy": "su-c75d2c51-7f41-4ef3-abdc-900bb0e6a4ba",
                "createdAt": "2026-10-25T22:12:39.287Z",
                "createdBy": "su-c75d2c51-7f41-4ef3-abdc-900bb0e6a4ba",
                "updatedAt": "2026-10-25T22:22:39.582Z",
                "capability": "live-dependency",
                "capabilitySource": "inferred"
              },
              {
                "ref": "resource:released:git-sync:papercusp",
                "kind": "event",
                "status": "active",
                "summary": "The active system git-sync lease blocks staging from incorporating the watchdog source commit.",
                "evidence": "Current locks:list showed system:git-sync:3341748 holding exclusive git-sync:papercusp, acquired 2026-10-25T22:48:14Z and still held. Filtered bg-host logs show the sync advancing through submodule batches; the latest pipeline_position read showed the watchdog target committed locally but not on staging.",
                "nextVerb": "Await resource:released:git-sync:papercusp, then re-read the lock and ensure the target commit is pushed. Advance the isolated staging generation with papercup-staging-sync, verify its process cwd/build SHA, run a current-build SLO pass, and re-read the exact condition.",
                "createdAt": "2026-10-25T23:02:02.464Z",
                "createdBy": "su-c75d2c51-7f41-4ef3-abdc-900bb0e6a4ba",
                "recheckAt": "2026-11-08T15:36:21.961Z",
                "updatedAt": "2026-11-08T14:36:21.961Z",
                "capability": "live-dependency",
                "recheckedAt": "2026-11-08T14:36:21.961Z",
                "reachability": {
                  "basis": "unmeasured",
                  "verdict": "unknown",
                  "evidence": "trigger \"resource:released:git-sync:papercusp\" may wake a consumer but cannot establish the specific release condition; subject-bound evidence is required",
                  "checkedAt": "2026-11-08T14:49:01.434Z",
                  "authoritative": false,
                  "uncertifiedReason": "broad"
                },
                "recheckSource": "system:unprovable-wait-backfill",
                "capabilitySource": "inferred",
                "recheckDisposition": "escalated"
              }
            ],
            "implementationReadiness": {
              "reason": "no-acceptance-evidence-at-creation",
              "source": "creation-enrollment",
              "status": "unknown",
              "updatedAt": "2026-10-13T06:31:03.810Z",
              "schemaVersion": "implementation-readiness-v1"
            }
          },
          "takenAt": null,
          "admission": "auto",
          "updatedAt": 1794149341696,
          "admittedAt": "2026-10-13T06:31:03.81+00:00",
          "admittedBy": "bypass:condition-key",
          "sourcePlan": null,
          "duplicateOf": null,
          "sourceItems": null,
          "conditionKey": "alarm:green-main-slo:%5B%22papercusp-workspace%22%2C%22papercusp%22%2C%22round-cycle-time%22%2C%22green-main-slo%3Apapercusp%3Around-cycle-time%3A0a16d4a6fac24e6df84192786ab07129978ab561%3A2%22%2C%220a16d4a6fac24e6df84192786ab07129978ab561%22%5D",
          "stateChangedAt": "2026-10-25T23:02:02.541821+00:00"
        }
      },
      "reconciliation": {
        "id": "WI-6554700010009910",
        "frozenSourceSha256": "9423ebc7d7c75e86a92e0ec53329913fff3660bb576ce200153802352bf82d7f",
        "frozenState": "blocked",
        "frozenFloors": [
          "not-claimable-status",
          "live-gate-ops",
          "external-blocker"
        ],
        "priorDisposition": "unassessed",
        "currentBatch": 14,
        "currentState": "blocked",
        "currentHolder": null,
        "currentAdmission": "auto",
        "currentControlKeys": [
          "externalBlockers",
          "implementationReadiness"
        ],
        "changedProjectedControlKeys": [
          "externalBlockers"
        ],
        "unmeasuredFrozenControlKeys": [
          "freshnessEnvelope",
          "reporter"
        ],
        "assessment": "condition-and-clearer-legitimacy-unresolved",
        "finalR1Disposition": "unresolved"
      },
      "conditionIdentity": {
        "key": "alarm:green-main-slo:%5B%22papercusp-workspace%22%2C%22papercusp%22%2C%22round-cycle-time%22%2C%22green-main-slo%3Apapercusp%3Around-cycle-time%3A0a16d4a6fac24e6df84192786ab07129978ab561%3A2%22%2C%220a16d4a6fac24e6df84192786ab07129978ab561%22%5D",
        "decodedWorkspaceInstallMetricEpisodeSubject": [
          "papercusp-workspace",
          "papercusp",
          "round-cycle-time",
          "green-main-slo:papercusp:round-cycle-time:0a16d4a6fac24e6df84192786ab07129978ab561:2",
          "0a16d4a6fac24e6df84192786ab07129978ab561"
        ],
        "datedPostFreezeKeyEqual": true,
        "frozenRawExportOmitsConditionKey": true,
        "historicalFrozenKeyUnproven": true
      },
      "sourceConditionedReservation": "The saved exact metric-slot key matches the witnessed current self-select reservation. The SQL floor depends on condition_key, not current gate ownership or holder liveness. No historical loaded-source identity is asserted.",
      "clearerQualification": {
        "conditionProducer": "greenMainSloConditionKey/runGreenMainSloPass source witness; historical emission not read",
        "conditionResolver": "Existing watchdog: measuredRecovery or explicitlySupersededByNewQueue, with distinct resolution summary. Supersession is not measured recovery or a durable fix.",
        "manualParkReleaseContract": null,
        "recordedReleaseOwner": null,
        "currentAuthenticatedNamedClearer": null,
        "currentGateOwnership": "UNMEASURED; intentionally not queried",
        "triggerLimit": "Gate-item completion or release:green is a wake/recheck trigger, not exact episode recovery or park clearance proof.",
        "independentControls": "Self-select reservation, durable park, external blocker, review/readiness and lifecycle guards remain separate."
      },
      "executionQualification": "No new execution or original-scope fix demonstrated. Saved state and missing holder do not authorize claim, release or monitoring.",
      "finalR1Disposition": "UNRESOLVED: historical condition truth/source identity, legitimate exception, current named authenticated authority and original-scope execution."
    },
    {
      "id": "WI-6554700010011362",
      "frozenSource": {
        "path": "/mnt/data/papercusp-audit-inputs/c52-r1-frozen-20261106T1917Z/WI-6554700010011362.json",
        "sha256": "b159cb5460019b669ce1b7e8630d3284da7bace393a9a1d034999c018459382f",
        "raw": {
          "id": "WI-6554700010011362",
          "kind": "bug",
          "family": "issue",
          "harness": "papercusp",
          "title": "[alarm:green-main-slo:%5B%22papercusp-workspace%22%2C%22papercusp%22%2C%22red-adding-admission%22%2C%22green-main-slo%3Apapercusp%3Ared-adding-admission%3A09b03",
          "summary": "Owning work-item for condition 'alarm:green-main-slo:%5B%22papercusp-workspace%22%2C%22papercusp%22%2C%22red-adding-admission%22%2C%22green-main-slo%3Apapercusp%3Ared-adding-admission%3A09b03f6f38c5e69a5a05c4ebdbf7ac11a7b63b30%22%2C%224a0ab75652bda2698d296eee96aa340f0eb3a620%22%5D', minted by the condition bridge (P-003, gate-ownership-condition-singleton-2026-08-03). This item is the SINGLETON for this condition — the partial unique index on work_items.condition_key guarantees at most one open owner, so claim THIS rather than filing another.\n\nLatest alarm: An admission added red on papercusp\nFirst seen: 2026-10-14T00:00:52.250Z · open since: 2026-10-14T00:00:52.250Z · alarms: 1\n\nLatest alarm detail (from the emitter):\nThe round after admitting 09b03f6f38c5 recorded more failures than the round before it.\n\n— emitted by pid 265266, process started 2026-10-13T22:25:16.091Z (up 1h35m), cwd /home/marsh-office/papercupai-workspace/papercusp/apps/operator. If that start time PREDATES the fix you are checking, this process never loaded it (no hot-reload) and no deploy will reach it — restart that host instead of re-investigating the alarm.",
          "state": "open",
          "assignee": null,
          "takenAt": null,
          "lastProgressAt": "2026-10-15T00:27:44.378Z",
          "assignedBy": null,
          "createdBy": null,
          "severity": "major",
          "goalId": null,
          "tags": null,
          "sourcePlanSlug": null,
          "sourcePlanItemIds": null,
          "redundancy": null,
          "expectedCostCents": null,
          "parent": null,
          "payload": {
            "_ei": {
              "scope": "harness:papercusp",
              "source": "engineer",
              "severity": "major",
              "signal_origin": "organic"
            },
            "_bridge": {
              "mintedAt": "2026-10-14T00:03:21.353Z",
              "conditionKey": "alarm:green-main-slo:%5B%22papercusp-workspace%22%2C%22papercusp%22%2C%22red-adding-admission%22%2C%22green-main-slo%3Apapercusp%3Ared-adding-admission%3A09b03f6f38c5e69a5a05c4ebdbf7ac11a7b63b30%22%2C%224a0ab75652bda2698d296eee96aa340f0eb3a620%22%5D"
            },
            "reporter": {
              "at": "2026-10-14T00:03:21.355Z",
              "id": null,
              "kind": "watchdog",
              "basis": "no-session"
            },
            "_claimHold": true,
            "claim_hold_at": "2026-10-15T00:27:50.607Z",
            "claim_hold_by": "su-3ecaeba1-97c3-4c42-8d8b-33c0f90d2ac0",
            "reporterKinds": [
              "watchdog"
            ],
            "claim_hold_reason": "Source copy is already corrected and its focused tests pass, but the singleton alarm itself remains unresolved until measured recovery. The live gate lane is held by another live owner, so this item is parked until that work completes.",
            "freshnessEnvelope": {
              "observedAt": "2026-10-14T00:03:21.355Z",
              "linkedFixRefs": [],
              "reporterSession": null,
              "observedSourceSha": "443fb28757",
              "toolSchemaVersion": null,
              "observedRuntimeSha": "443fb28757",
              "deployBuildIdentity": "443fb28757@0.0.0",
              "reporterRuntimeVersion": "0.0.0",
              "lastSuccessfulReproductionAt": null
            },
            "claim_hold_release": {
              "owner": "su-6f6f3aa0-77b0-4ab3-a9e5-126b5853a81c",
              "trigger": "work-item:done:WI-10006055",
              "evidence": "a live resolver or producer registration can still satisfy the condition",
              "condition": "Re-evaluate this alarm only after the current red-streak owner work item WI-10006055 reaches terminal completion; the alarm's metric still needs a later measured recovery round.",
              "reachability": "reachable"
            },
            "claim_history_post_id": 9001788375295,
            "implementationReadiness": {
              "reason": "no-acceptance-evidence-at-creation",
              "source": "creation-enrollment",
              "status": "unknown",
              "updatedAt": "2026-10-14T00:03:21.355Z",
              "schemaVersion": "implementation-readiness-v1"
            }
          },
          "definition": null,
          "rank": null,
          "rankWriter": null,
          "rankUpdatedAt": null,
          "priority": null,
          "terminalOwner": null,
          "terminalCompletionRef": null,
          "terminalCompletionEvidence": null,
          "completionAuthority": null,
          "origin": "local",
          "auditVerdict": null,
          "verifiedAuthorGithubUserId": null,
          "createdAt": "2026-10-14T00:03:21.355Z",
          "updatedAt": "2026-10-15T00:27:50.607Z",
          "closedAt": null
        }
      },
      "originalLedgerRow": {
        "id": "WI-6554700010011362",
        "source": "/mnt/data/papercusp-audit-inputs/c52-r1-frozen-20261106T1917Z/WI-6554700010011362.json",
        "sourceSha256": "b159cb5460019b669ce1b7e8630d3284da7bace393a9a1d034999c018459382f",
        "manifestSha256": "75f699e3073a53df71db467214e8d3271ab3df35aca42fd3a5dcd1918f9af1ad",
        "state": "open",
        "rowAgeSecondsAtSnapshot": 2056368.273262,
        "rawRestrictionVerdict": {
          "id": "WI-6554700010011362",
          "admissible": false,
          "refusedBy": "live-gate-ops",
          "failedFloors": [
            "live-gate-ops",
            "claim-hold"
          ],
          "detail": "LIVE_GATE_OPS condition (gate-red-streak: or green-stall: singleton, or an alarm:green-main-slo: time-since-green/time-since-verdict/red-adding-admission/round-cycle-time/queue-idle alarm) — reserved to the one registered live gate fixer and excluded from opportunistic self-select. A leader/owner may still dispatch or claim it BY ID after checking gate.greenCheckpoint.ownership."
        },
        "restrictions": [
          {
            "floor": "live-gate-ops",
            "stateProducerRecorded": null,
            "enteredAtRecorded": null,
            "ageSecondsAtSnapshot": null,
            "accountableClearerRecorded": null,
            "releaseConditionRecordedOrEvaluatorRule": "Registered live gate owner progresses this lane; no competing takeover or repeated gate status read.",
            "currentEvidence": {
              "scope": "LIVE_GATE_OPS",
              "status": "excluded from this investigation lane"
            },
            "verification": "unassessed; recorded values and evaluator rules do not establish legitimacy",
            "unknownFields": [
              "stateProducer",
              "enteredAt",
              "accountableClearer"
            ]
          },
          {
            "floor": "claim-hold",
            "stateProducerRecorded": "su-3ecaeba1-97c3-4c42-8d8b-33c0f90d2ac0",
            "enteredAtRecorded": "2026-10-15T00:27:50.607Z",
            "ageSecondsAtSnapshot": 1968499.021262,
            "accountableClearerRecorded": "su-6f6f3aa0-77b0-4ab3-a9e5-126b5853a81c",
            "releaseConditionRecordedOrEvaluatorRule": "Re-evaluate this alarm only after the current red-streak owner work item WI-10006055 reaches terminal completion; the alarm's metric still needs a later measured recovery round.",
            "currentEvidence": {
              "claim_hold_at": "2026-10-15T00:27:50.607Z",
              "claim_hold_by": "su-3ecaeba1-97c3-4c42-8d8b-33c0f90d2ac0",
              "claim_hold_reason": "Source copy is already corrected and its focused tests pass, but the singleton alarm itself remains unresolved until measured recovery. The live gate lane is held by another live owner, so this item is parked until that work completes.",
              "claim_hold_release": {
                "owner": "su-6f6f3aa0-77b0-4ab3-a9e5-126b5853a81c",
                "trigger": "work-item:done:WI-10006055",
                "evidence": "a live resolver or producer registration can still satisfy the condition",
                "condition": "Re-evaluate this alarm only after the current red-streak owner work item WI-10006055 reaches terminal completion; the alarm's metric still needs a later measured recovery round.",
                "reachability": "reachable"
              }
            },
            "verification": "unassessed; recorded values and evaluator rules do not establish legitimacy",
            "unknownFields": [],
            "writerProvenanceVerification": {
              "sourceRules": "work-items.ts:setWorkItemClaimHold and work-items-admission-promoter.ts:qualifiedAgentPark; corroboration grants no release authority",
              "checks": [
                {
                  "convention": "claim_hold",
                  "recordedActor": "su-3ecaeba1-97c3-4c42-8d8b-33c0f90d2ac0",
                  "corroboratedCanonicalWriter": true,
                  "criteria": {
                    "latestIsCanonicalSet": true,
                    "auditActorMatches": true,
                    "modeMatches": true,
                    "byMatches": true,
                    "reasonMatches": true,
                    "timestampMatches": true,
                    "releaseContractMatches": true
                  },
                  "auditId": "wi-claim-hold-mv8sv2e2-rd5tin",
                  "notProven": [
                    "current actor authority",
                    "legitimacy of underlying reason",
                    "truth of arbitrary release condition",
                    "clearance",
                    "execution"
                  ]
                }
              ],
              "noConventionRecorded": false
            }
          }
        ],
        "controlEvidence": {
          "implementationReadiness": {
            "reason": "no-acceptance-evidence-at-creation",
            "source": "creation-enrollment",
            "status": "unknown",
            "updatedAt": "2026-10-14T00:03:21.355Z",
            "schemaVersion": "implementation-readiness-v1"
          },
          "_claimHold": true,
          "claim_hold_at": "2026-10-15T00:27:50.607Z",
          "claim_hold_by": "su-3ecaeba1-97c3-4c42-8d8b-33c0f90d2ac0",
          "claim_hold_reason": "Source copy is already corrected and its focused tests pass, but the singleton alarm itself remains unresolved until measured recovery. The live gate lane is held by another live owner, so this item is parked until that work completes.",
          "claim_hold_release": {
            "owner": "su-6f6f3aa0-77b0-4ab3-a9e5-126b5853a81c",
            "trigger": "work-item:done:WI-10006055",
            "evidence": "a live resolver or producer registration can still satisfy the condition",
            "condition": "Re-evaluate this alarm only after the current red-streak owner work item WI-10006055 reaches terminal completion; the alarm's metric still needs a later measured recovery round.",
            "reachability": "reachable"
          },
          "reporter": {
            "at": "2026-10-14T00:03:21.355Z",
            "id": null,
            "kind": "watchdog",
            "basis": "no-session"
          },
          "freshnessEnvelope": {
            "observedAt": "2026-10-14T00:03:21.355Z",
            "linkedFixRefs": [],
            "reporterSession": null,
            "observedSourceSha": "443fb28757",
            "toolSchemaVersion": null,
            "observedRuntimeSha": "443fb28757",
            "deployBuildIdentity": "443fb28757@0.0.0",
            "reporterRuntimeVersion": "0.0.0",
            "lastSuccessfulReproductionAt": null
          }
        },
        "accountableInvestigator": "su-c52a1707-13f5-4080-870b-f7143c271d73",
        "disposition": "unassessed",
        "legitimateException": null,
        "executionEvidence": null,
        "remainingVerification": [
          "Actual source writer and recorded producer",
          "Restriction evidence, age, accountable authorized clearer and exact release condition",
          "Legitimacy or false-restriction repair",
          "Same-ID execution or explicit Avi disposition"
        ],
        "schemaVersion": "luna-r1-causal-evidence-ledger-v4",
        "sourceQualification": {
          "status": "clearance mechanisms mapped; row-specific causal/legitimacy verification remains open",
          "registry": "/home/marsh-office/.papercusp/evidence/c52-luna-r1-20261106/restriction-authority-registry-v1.json",
          "registrySha256": "1b51f4be4a288749652dfaf9f7c7d4547aae962dd0d33a798f8e729f9e49dfbe",
          "floorMappings": [
            {
              "floor": "live-gate-ops",
              "mechanismRef": "/home/marsh-office/.papercusp/evidence/c52-luna-r1-20261106/restriction-authority-registry-v1.json#/floors/live-gate-ops",
              "rowVerification": "unassessed",
              "requiredRowEvidence": [
                "exact condition_key",
                "condition producer",
                "registered ownership evidence supplied by that lane"
              ]
            },
            {
              "floor": "claim-hold",
              "mechanismRef": "/home/marsh-office/.papercusp/evidence/c52-luna-r1-20261106/restriction-authority-registry-v1.json#/floors/claim-hold",
              "rowVerification": "unassessed",
              "requiredRowEvidence": [
                "both provenance conventions",
                "typed release contract or precise legacy condition",
                "condition-specific proof",
                "current assignment/fingerprint",
                "owner authority if required"
              ],
              "recordedReleaseContractOwner": "su-6f6f3aa0-77b0-4ab3-a9e5-126b5853a81c",
              "recordedLeaseHolder": null,
              "recordedParker": "su-3ecaeba1-97c3-4c42-8d8b-33c0f90d2ac0",
              "authorityVerified": false
            }
          ]
        },
        "postFreezeControlContext": {
          "artifact": "/home/marsh-office/.papercusp/evidence/c52-luna-r1-20261106/live-control-enrichment-20261106T1950Z-v2.json",
          "observedAt": "2026-11-06 19:48:21.753008+00",
          "record": {
            "id": "WI-6554700010011362",
            "state": "open",
            "harness": "papercusp",
            "takenAt": null,
            "takenBy": null,
            "admission": "auto",
            "createdAt": 1791936201355,
            "updatedAt": 1792024070607,
            "admittedAt": "2026-10-14T00:03:21.355+00:00",
            "admittedBy": "bypass:condition-key",
            "duplicateOf": null,
            "conditionKey": "alarm:green-main-slo:%5B%22papercusp-workspace%22%2C%22papercusp%22%2C%22red-adding-admission%22%2C%22green-main-slo%3Apapercusp%3Ared-adding-admission%3A09b03f6f38c5e69a5a05c4ebdbf7ac11a7b63b30%22%2C%224a0ab75652bda2698d296eee96aa340f0eb3a620%22%5D",
            "holderPresence": null,
            "sourcePlanSlug": null,
            "sourcePlanItemIds": null
          },
          "limitations": [
            "Presence absence does not establish holder death or authorize release",
            "Current terminal state alone does not prove execution",
            "Admission values are current post-freeze evidence; historical producer/state-transition audit still required"
          ]
        },
        "postFreezeDependencyContext": {
          "artifact": "/home/marsh-office/.papercusp/evidence/c52-luna-r1-20261106/dependency-enrichment-20261106T1930Z.json",
          "observedAt": "2026-11-06T19:26:36.952682Z",
          "edges": [],
          "coverage": "not queried by this enrichment; empty list is not absence evidence"
        },
        "historicalAuditEvidence": {
          "artifact": "/home/marsh-office/.papercusp/evidence/c52-luna-r1-20261106/historical-audit-enrichment-20261106T2010Z.json",
          "sha256": "4b396df0818120147036644a9e33893170b4d271e5a5fd1a87e0e720a9884410",
          "recordPointer": "/queryResult/rows/0/items/5835",
          "observedAt": "2026-11-06 20:03:09.124326+00",
          "eventCutoffMs": 1793992569628,
          "eventCount": 1,
          "coverage": "Available work_items:% audit only; empty is not no-transition proof; nonterminal changes and some needs-human changes are undated."
        }
      },
      "savedNovember7Qualification": {
        "schemaVersion": "luna-r1-causal-qualification-v1",
        "id": "WI-6554700010011362",
        "sourceLedger": {
          "path": "/home/marsh-office/.papercusp/evidence/c52-luna-r1-20261106/causal-ledger-v4.jsonl",
          "sha256": "7f1962fb5c22f1bc2be9625406b315f6b5f4fd190b4743d7f972a4fb2c935866",
          "rowSourceSha256": "b159cb5460019b669ce1b7e8630d3284da7bace393a9a1d034999c018459382f"
        },
        "frozenState": "open",
        "frozenFloors": [
          "claim-hold",
          "live-gate-ops"
        ],
        "currentControlObservedAt": "2026-11-07 11:32:12.960427-05",
        "currentState": "open",
        "currentHolder": null,
        "currentFloorVerdict": {
          "id": "WI-6554700010011362",
          "admissible": false,
          "refusedBy": "live-gate-ops",
          "failedFloors": [
            "live-gate-ops",
            "claim-hold"
          ],
          "detail": "LIVE_GATE_OPS condition (gate-red-streak: or green-stall: singleton, or an alarm:green-main-slo: time-since-green/time-since-verdict/red-adding-admission/round-cycle-time/queue-idle alarm) — reserved to the one registered live gate fixer and excluded from opportunistic self-select. A leader/owner may still dispatch or claim it BY ID after checking gate.greenCheckpoint.ownership."
        },
        "floorDifference": {
          "noLongerObserved": [],
          "newlyObserved": []
        },
        "adoptionQualification": null,
        "parkQualification": {
          "artifact": ".papercusp/evidence/c52-luna-r1-20261106/current-park-qualification-20261107T1715Z.json",
          "controlSnapshotAt": "2026-11-07 11:32:12.960427-05",
          "measuredAt": "2026-11-07T17:28:38.112Z",
          "qualificationAsMeasured": "reachable",
          "certification": "reachability-only; underlying release condition and clearer authority unverified"
        },
        "disposition": "unassessed",
        "executionEvidence": null,
        "nextActions": [
          "preserve park; qualify its exact condition and authorized clearer, with no automatic release from reachability"
        ],
        "limits": [
          "separately dated observations; not an immutable current-state snapshot",
          "a correct floor or release path does not prove underlying legitimacy",
          "adoption eligibility is report revision, not permission to implement"
        ]
      },
      "savedNovember8": {
        "observedAt": "2026-11-08 15:02:23.578069+00",
        "batch": 14,
        "recordPointer": "/rows/0/items/235",
        "rawProjectedRecord": {
          "id": "WI-6554700010011362",
          "state": "open",
          "holder": null,
          "control": {
            "_claimHold": true,
            "claim_hold_at": "2026-10-15T00:27:50.607Z",
            "claim_hold_by": "su-3ecaeba1-97c3-4c42-8d8b-33c0f90d2ac0",
            "claim_hold_reason": "Source copy is already corrected and its focused tests pass, but the singleton alarm itself remains unresolved until measured recovery. The live gate lane is held by another live owner, so this item is parked until that work completes.",
            "claim_hold_release": {
              "owner": "su-6f6f3aa0-77b0-4ab3-a9e5-126b5853a81c",
              "trigger": "work-item:done:WI-10006055",
              "evidence": "a live resolver or producer registration can still satisfy the condition",
              "condition": "Re-evaluate this alarm only after the current red-streak owner work item WI-10006055 reaches terminal completion; the alarm's metric still needs a later measured recovery round.",
              "reachability": "reachable"
            },
            "implementationReadiness": {
              "reason": "no-acceptance-evidence-at-creation",
              "source": "creation-enrollment",
              "status": "unknown",
              "updatedAt": "2026-10-14T00:03:21.355Z",
              "schemaVersion": "implementation-readiness-v1"
            }
          },
          "takenAt": null,
          "admission": "auto",
          "updatedAt": 1792024070607,
          "admittedAt": "2026-10-14T00:03:21.355+00:00",
          "admittedBy": "bypass:condition-key",
          "sourcePlan": null,
          "duplicateOf": null,
          "sourceItems": null,
          "conditionKey": "alarm:green-main-slo:%5B%22papercusp-workspace%22%2C%22papercusp%22%2C%22red-adding-admission%22%2C%22green-main-slo%3Apapercusp%3Ared-adding-admission%3A09b03f6f38c5e69a5a05c4ebdbf7ac11a7b63b30%22%2C%224a0ab75652bda2698d296eee96aa340f0eb3a620%22%5D",
          "stateChangedAt": "2026-10-14T00:03:21.355+00:00"
        }
      },
      "reconciliation": {
        "id": "WI-6554700010011362",
        "frozenSourceSha256": "b159cb5460019b669ce1b7e8630d3284da7bace393a9a1d034999c018459382f",
        "frozenState": "open",
        "frozenFloors": [
          "live-gate-ops",
          "claim-hold"
        ],
        "priorDisposition": "unassessed",
        "currentBatch": 14,
        "currentState": "open",
        "currentHolder": null,
        "currentAdmission": "auto",
        "currentControlKeys": [
          "_claimHold",
          "claim_hold_at",
          "claim_hold_by",
          "claim_hold_reason",
          "claim_hold_release",
          "implementationReadiness"
        ],
        "changedProjectedControlKeys": [],
        "unmeasuredFrozenControlKeys": [
          "freshnessEnvelope",
          "reporter"
        ],
        "assessment": "condition-and-clearer-legitimacy-unresolved",
        "finalR1Disposition": "unresolved"
      },
      "conditionIdentity": {
        "key": "alarm:green-main-slo:%5B%22papercusp-workspace%22%2C%22papercusp%22%2C%22red-adding-admission%22%2C%22green-main-slo%3Apapercusp%3Ared-adding-admission%3A09b03f6f38c5e69a5a05c4ebdbf7ac11a7b63b30%22%2C%224a0ab75652bda2698d296eee96aa340f0eb3a620%22%5D",
        "decodedWorkspaceInstallMetricEpisodeSubject": [
          "papercusp-workspace",
          "papercusp",
          "red-adding-admission",
          "green-main-slo:papercusp:red-adding-admission:09b03f6f38c5e69a5a05c4ebdbf7ac11a7b63b30",
          "4a0ab75652bda2698d296eee96aa340f0eb3a620"
        ],
        "datedPostFreezeKeyEqual": true,
        "frozenRawExportOmitsConditionKey": true,
        "historicalFrozenKeyUnproven": true
      },
      "sourceConditionedReservation": "The saved exact metric-slot key matches the witnessed current self-select reservation. The SQL floor depends on condition_key, not current gate ownership or holder liveness. No historical loaded-source identity is asserted.",
      "clearerQualification": {
        "conditionProducer": "greenMainSloConditionKey/runGreenMainSloPass source witness; historical emission not read",
        "conditionResolver": "Existing watchdog: measuredRecovery or explicitlySupersededByNewQueue, with distinct resolution summary. Supersession is not measured recovery or a durable fix.",
        "manualParkReleaseContract": {
          "owner": "su-6f6f3aa0-77b0-4ab3-a9e5-126b5853a81c",
          "trigger": "work-item:done:WI-10006055",
          "evidence": "a live resolver or producer registration can still satisfy the condition",
          "condition": "Re-evaluate this alarm only after the current red-streak owner work item WI-10006055 reaches terminal completion; the alarm's metric still needs a later measured recovery round.",
          "reachability": "reachable"
        },
        "recordedReleaseOwner": "su-6f6f3aa0-77b0-4ab3-a9e5-126b5853a81c",
        "currentAuthenticatedNamedClearer": null,
        "currentGateOwnership": "UNMEASURED; intentionally not queried",
        "triggerLimit": "Gate-item completion or release:green is a wake/recheck trigger, not exact episode recovery or park clearance proof.",
        "independentControls": "Self-select reservation, durable park, external blocker, review/readiness and lifecycle guards remain separate."
      },
      "executionQualification": "No new execution or original-scope fix demonstrated. Saved state and missing holder do not authorize claim, release or monitoring.",
      "finalR1Disposition": "UNRESOLVED: historical condition truth/source identity, legitimate exception, current named authenticated authority and original-scope execution."
    },
    {
      "id": "WI-6554700010011364",
      "frozenSource": {
        "path": "/mnt/data/papercusp-audit-inputs/c52-r1-frozen-20261106T1917Z/WI-6554700010011364.json",
        "sha256": "06814bb39685da6b67859410f3c9698063f93ef0e67aa9afd978f25c5f29d233",
        "raw": {
          "id": "WI-6554700010011364",
          "kind": "bug",
          "family": "issue",
          "harness": "papercusp",
          "title": "[alarm:green-main-slo:%5B%22papercusp-workspace%22%2C%22papercusp%22%2C%22round-cycle-time%22%2C%22green-main-slo%3Apapercusp%3Around-cycle-time%3A4a0ab75652bda",
          "summary": "Owning work-item for condition 'alarm:green-main-slo:%5B%22papercusp-workspace%22%2C%22papercusp%22%2C%22round-cycle-time%22%2C%22green-main-slo%3Apapercusp%3Around-cycle-time%3A4a0ab75652bda2698d296eee96aa340f0eb3a620%3A2%22%2C%224a0ab75652bda2698d296eee96aa340f0eb3a620%22%5D', minted by the condition bridge (P-003, gate-ownership-condition-singleton-2026-08-03). This item is the SINGLETON for this condition — the partial unique index on work_items.condition_key guarantees at most one open owner, so claim THIS rather than filing another.\n\nLatest alarm: Repair round 2 took 4.6h on papercusp\nFirst seen: 2026-10-14T00:00:45.531Z · open since: 2026-10-14T00:00:45.531Z · alarms: 1\n\nLatest alarm detail (from the emitter):\nFrozen candidate 4a0ab75652bd: the newest round interval exceeds the 2.0h target.\n\n— emitted by pid 265266, process started 2026-10-13T22:25:16.460Z (up 1h35m), cwd /home/marsh-office/papercupai-workspace/papercusp/apps/operator. If that start time PREDATES the fix you are checking, this process never loaded it (no hot-reload) and no deploy will reach it — restart that host instead of re-investigating the alarm.",
          "state": "open",
          "assignee": null,
          "takenAt": null,
          "lastProgressAt": "2026-10-15T00:30:28.424Z",
          "assignedBy": null,
          "createdBy": null,
          "severity": "major",
          "goalId": null,
          "tags": null,
          "sourcePlanSlug": null,
          "sourcePlanItemIds": null,
          "redundancy": null,
          "expectedCostCents": null,
          "parent": null,
          "payload": {
            "_ei": {
              "scope": "harness:papercusp",
              "source": "engineer",
              "severity": "major",
              "signal_origin": "organic"
            },
            "_bridge": {
              "mintedAt": "2026-10-14T00:03:22.317Z",
              "conditionKey": "alarm:green-main-slo:%5B%22papercusp-workspace%22%2C%22papercusp%22%2C%22round-cycle-time%22%2C%22green-main-slo%3Apapercusp%3Around-cycle-time%3A4a0ab75652bda2698d296eee96aa340f0eb3a620%3A2%22%2C%224a0ab75652bda2698d296eee96aa340f0eb3a620%22%5D"
            },
            "reporter": {
              "at": "2026-10-14T00:03:22.317Z",
              "id": null,
              "kind": "watchdog",
              "basis": "no-session"
            },
            "_claimHold": true,
            "claim_hold_at": "2026-10-15T00:30:49.856Z",
            "claim_hold_by": "su-3ecaeba1-97c3-4c42-8d8b-33c0f90d2ac0",
            "reporterKinds": [
              "watchdog"
            ],
            "claim_hold_reason": "The recorded 4.6h breach is historical; recovery would require monitoring the live gate round. That lane is owned by another live agent, so park this singleton until the owner's work completes.",
            "freshnessEnvelope": {
              "observedAt": "2026-10-14T00:03:22.317Z",
              "linkedFixRefs": [],
              "reporterSession": null,
              "observedSourceSha": "443fb28757",
              "toolSchemaVersion": null,
              "observedRuntimeSha": "443fb28757",
              "deployBuildIdentity": "443fb28757@0.0.0",
              "reporterRuntimeVersion": "0.0.0",
              "lastSuccessfulReproductionAt": null
            },
            "claim_hold_release": {
              "owner": "su-6f6f3aa0-77b0-4ab3-a9e5-126b5853a81c",
              "trigger": "work-item:done:WI-10006055",
              "evidence": "a live resolver or producer registration can still satisfy the condition",
              "condition": "Re-evaluate this historical round-cycle alarm after the current red-streak work item WI-10006055 reaches terminal completion and fresh round data is available.",
              "reachability": "reachable"
            },
            "claim_history_post_id": 9001788375295,
            "implementationReadiness": {
              "reason": "no-acceptance-evidence-at-creation",
              "source": "creation-enrollment",
              "status": "unknown",
              "updatedAt": "2026-10-14T00:03:22.317Z",
              "schemaVersion": "implementation-readiness-v1"
            }
          },
          "definition": null,
          "rank": null,
          "rankWriter": null,
          "rankUpdatedAt": null,
          "priority": null,
          "terminalOwner": null,
          "terminalCompletionRef": null,
          "terminalCompletionEvidence": null,
          "completionAuthority": null,
          "origin": "local",
          "auditVerdict": null,
          "verifiedAuthorGithubUserId": null,
          "createdAt": "2026-10-14T00:03:22.317Z",
          "updatedAt": "2026-10-15T00:30:49.856Z",
          "closedAt": null
        }
      },
      "originalLedgerRow": {
        "id": "WI-6554700010011364",
        "source": "/mnt/data/papercusp-audit-inputs/c52-r1-frozen-20261106T1917Z/WI-6554700010011364.json",
        "sourceSha256": "06814bb39685da6b67859410f3c9698063f93ef0e67aa9afd978f25c5f29d233",
        "manifestSha256": "75f699e3073a53df71db467214e8d3271ab3df35aca42fd3a5dcd1918f9af1ad",
        "state": "open",
        "rowAgeSecondsAtSnapshot": 2056367.311262,
        "rawRestrictionVerdict": {
          "id": "WI-6554700010011364",
          "admissible": false,
          "refusedBy": "live-gate-ops",
          "failedFloors": [
            "live-gate-ops",
            "claim-hold"
          ],
          "detail": "LIVE_GATE_OPS condition (gate-red-streak: or green-stall: singleton, or an alarm:green-main-slo: time-since-green/time-since-verdict/red-adding-admission/round-cycle-time/queue-idle alarm) — reserved to the one registered live gate fixer and excluded from opportunistic self-select. A leader/owner may still dispatch or claim it BY ID after checking gate.greenCheckpoint.ownership."
        },
        "restrictions": [
          {
            "floor": "live-gate-ops",
            "stateProducerRecorded": null,
            "enteredAtRecorded": null,
            "ageSecondsAtSnapshot": null,
            "accountableClearerRecorded": null,
            "releaseConditionRecordedOrEvaluatorRule": "Registered live gate owner progresses this lane; no competing takeover or repeated gate status read.",
            "currentEvidence": {
              "scope": "LIVE_GATE_OPS",
              "status": "excluded from this investigation lane"
            },
            "verification": "unassessed; recorded values and evaluator rules do not establish legitimacy",
            "unknownFields": [
              "stateProducer",
              "enteredAt",
              "accountableClearer"
            ]
          },
          {
            "floor": "claim-hold",
            "stateProducerRecorded": "su-3ecaeba1-97c3-4c42-8d8b-33c0f90d2ac0",
            "enteredAtRecorded": "2026-10-15T00:30:49.856Z",
            "ageSecondsAtSnapshot": 1968319.772262,
            "accountableClearerRecorded": "su-6f6f3aa0-77b0-4ab3-a9e5-126b5853a81c",
            "releaseConditionRecordedOrEvaluatorRule": "Re-evaluate this historical round-cycle alarm after the current red-streak work item WI-10006055 reaches terminal completion and fresh round data is available.",
            "currentEvidence": {
              "claim_hold_at": "2026-10-15T00:30:49.856Z",
              "claim_hold_by": "su-3ecaeba1-97c3-4c42-8d8b-33c0f90d2ac0",
              "claim_hold_reason": "The recorded 4.6h breach is historical; recovery would require monitoring the live gate round. That lane is owned by another live agent, so park this singleton until the owner's work completes.",
              "claim_hold_release": {
                "owner": "su-6f6f3aa0-77b0-4ab3-a9e5-126b5853a81c",
                "trigger": "work-item:done:WI-10006055",
                "evidence": "a live resolver or producer registration can still satisfy the condition",
                "condition": "Re-evaluate this historical round-cycle alarm after the current red-streak work item WI-10006055 reaches terminal completion and fresh round data is available.",
                "reachability": "reachable"
              }
            },
            "verification": "unassessed; recorded values and evaluator rules do not establish legitimacy",
            "unknownFields": [],
            "writerProvenanceVerification": {
              "sourceRules": "work-items.ts:setWorkItemClaimHold and work-items-admission-promoter.ts:qualifiedAgentPark; corroboration grants no release authority",
              "checks": [
                {
                  "convention": "claim_hold",
                  "recordedActor": "su-3ecaeba1-97c3-4c42-8d8b-33c0f90d2ac0",
                  "corroboratedCanonicalWriter": true,
                  "criteria": {
                    "latestIsCanonicalSet": true,
                    "auditActorMatches": true,
                    "modeMatches": true,
                    "byMatches": true,
                    "reasonMatches": true,
                    "timestampMatches": true,
                    "releaseContractMatches": true
                  },
                  "auditId": "wi-claim-hold-mv8sywuz-8pyeqh",
                  "notProven": [
                    "current actor authority",
                    "legitimacy of underlying reason",
                    "truth of arbitrary release condition",
                    "clearance",
                    "execution"
                  ]
                }
              ],
              "noConventionRecorded": false
            }
          }
        ],
        "controlEvidence": {
          "implementationReadiness": {
            "reason": "no-acceptance-evidence-at-creation",
            "source": "creation-enrollment",
            "status": "unknown",
            "updatedAt": "2026-10-14T00:03:22.317Z",
            "schemaVersion": "implementation-readiness-v1"
          },
          "_claimHold": true,
          "claim_hold_at": "2026-10-15T00:30:49.856Z",
          "claim_hold_by": "su-3ecaeba1-97c3-4c42-8d8b-33c0f90d2ac0",
          "claim_hold_reason": "The recorded 4.6h breach is historical; recovery would require monitoring the live gate round. That lane is owned by another live agent, so park this singleton until the owner's work completes.",
          "claim_hold_release": {
            "owner": "su-6f6f3aa0-77b0-4ab3-a9e5-126b5853a81c",
            "trigger": "work-item:done:WI-10006055",
            "evidence": "a live resolver or producer registration can still satisfy the condition",
            "condition": "Re-evaluate this historical round-cycle alarm after the current red-streak work item WI-10006055 reaches terminal completion and fresh round data is available.",
            "reachability": "reachable"
          },
          "reporter": {
            "at": "2026-10-14T00:03:22.317Z",
            "id": null,
            "kind": "watchdog",
            "basis": "no-session"
          },
          "freshnessEnvelope": {
            "observedAt": "2026-10-14T00:03:22.317Z",
            "linkedFixRefs": [],
            "reporterSession": null,
            "observedSourceSha": "443fb28757",
            "toolSchemaVersion": null,
            "observedRuntimeSha": "443fb28757",
            "deployBuildIdentity": "443fb28757@0.0.0",
            "reporterRuntimeVersion": "0.0.0",
            "lastSuccessfulReproductionAt": null
          }
        },
        "accountableInvestigator": "su-c52a1707-13f5-4080-870b-f7143c271d73",
        "disposition": "unassessed",
        "legitimateException": null,
        "executionEvidence": null,
        "remainingVerification": [
          "Actual source writer and recorded producer",
          "Restriction evidence, age, accountable authorized clearer and exact release condition",
          "Legitimacy or false-restriction repair",
          "Same-ID execution or explicit Avi disposition"
        ],
        "schemaVersion": "luna-r1-causal-evidence-ledger-v4",
        "sourceQualification": {
          "status": "clearance mechanisms mapped; row-specific causal/legitimacy verification remains open",
          "registry": "/home/marsh-office/.papercusp/evidence/c52-luna-r1-20261106/restriction-authority-registry-v1.json",
          "registrySha256": "1b51f4be4a288749652dfaf9f7c7d4547aae962dd0d33a798f8e729f9e49dfbe",
          "floorMappings": [
            {
              "floor": "live-gate-ops",
              "mechanismRef": "/home/marsh-office/.papercusp/evidence/c52-luna-r1-20261106/restriction-authority-registry-v1.json#/floors/live-gate-ops",
              "rowVerification": "unassessed",
              "requiredRowEvidence": [
                "exact condition_key",
                "condition producer",
                "registered ownership evidence supplied by that lane"
              ]
            },
            {
              "floor": "claim-hold",
              "mechanismRef": "/home/marsh-office/.papercusp/evidence/c52-luna-r1-20261106/restriction-authority-registry-v1.json#/floors/claim-hold",
              "rowVerification": "unassessed",
              "requiredRowEvidence": [
                "both provenance conventions",
                "typed release contract or precise legacy condition",
                "condition-specific proof",
                "current assignment/fingerprint",
                "owner authority if required"
              ],
              "recordedReleaseContractOwner": "su-6f6f3aa0-77b0-4ab3-a9e5-126b5853a81c",
              "recordedLeaseHolder": null,
              "recordedParker": "su-3ecaeba1-97c3-4c42-8d8b-33c0f90d2ac0",
              "authorityVerified": false
            }
          ]
        },
        "postFreezeControlContext": {
          "artifact": "/home/marsh-office/.papercusp/evidence/c52-luna-r1-20261106/live-control-enrichment-20261106T1950Z-v2.json",
          "observedAt": "2026-11-06 19:48:21.753008+00",
          "record": {
            "id": "WI-6554700010011364",
            "state": "open",
            "harness": "papercusp",
            "takenAt": null,
            "takenBy": null,
            "admission": "auto",
            "createdAt": 1791936202317,
            "updatedAt": 1792024249856,
            "admittedAt": "2026-10-14T00:03:22.317+00:00",
            "admittedBy": "bypass:condition-key",
            "duplicateOf": null,
            "conditionKey": "alarm:green-main-slo:%5B%22papercusp-workspace%22%2C%22papercusp%22%2C%22round-cycle-time%22%2C%22green-main-slo%3Apapercusp%3Around-cycle-time%3A4a0ab75652bda2698d296eee96aa340f0eb3a620%3A2%22%2C%224a0ab75652bda2698d296eee96aa340f0eb3a620%22%5D",
            "holderPresence": null,
            "sourcePlanSlug": null,
            "sourcePlanItemIds": null
          },
          "limitations": [
            "Presence absence does not establish holder death or authorize release",
            "Current terminal state alone does not prove execution",
            "Admission values are current post-freeze evidence; historical producer/state-transition audit still required"
          ]
        },
        "postFreezeDependencyContext": {
          "artifact": "/home/marsh-office/.papercusp/evidence/c52-luna-r1-20261106/dependency-enrichment-20261106T1930Z.json",
          "observedAt": "2026-11-06T19:26:36.952682Z",
          "edges": [],
          "coverage": "not queried by this enrichment; empty list is not absence evidence"
        },
        "historicalAuditEvidence": {
          "artifact": "/home/marsh-office/.papercusp/evidence/c52-luna-r1-20261106/historical-audit-enrichment-20261106T2010Z.json",
          "sha256": "4b396df0818120147036644a9e33893170b4d271e5a5fd1a87e0e720a9884410",
          "recordPointer": "/queryResult/rows/0/items/5836",
          "observedAt": "2026-11-06 20:03:09.124326+00",
          "eventCutoffMs": 1793992569628,
          "eventCount": 1,
          "coverage": "Available work_items:% audit only; empty is not no-transition proof; nonterminal changes and some needs-human changes are undated."
        }
      },
      "savedNovember7Qualification": {
        "schemaVersion": "luna-r1-causal-qualification-v1",
        "id": "WI-6554700010011364",
        "sourceLedger": {
          "path": "/home/marsh-office/.papercusp/evidence/c52-luna-r1-20261106/causal-ledger-v4.jsonl",
          "sha256": "7f1962fb5c22f1bc2be9625406b315f6b5f4fd190b4743d7f972a4fb2c935866",
          "rowSourceSha256": "06814bb39685da6b67859410f3c9698063f93ef0e67aa9afd978f25c5f29d233"
        },
        "frozenState": "open",
        "frozenFloors": [
          "claim-hold",
          "live-gate-ops"
        ],
        "currentControlObservedAt": "2026-11-07 11:32:12.960427-05",
        "currentState": "open",
        "currentHolder": null,
        "currentFloorVerdict": {
          "id": "WI-6554700010011364",
          "admissible": false,
          "refusedBy": "live-gate-ops",
          "failedFloors": [
            "live-gate-ops",
            "claim-hold"
          ],
          "detail": "LIVE_GATE_OPS condition (gate-red-streak: or green-stall: singleton, or an alarm:green-main-slo: time-since-green/time-since-verdict/red-adding-admission/round-cycle-time/queue-idle alarm) — reserved to the one registered live gate fixer and excluded from opportunistic self-select. A leader/owner may still dispatch or claim it BY ID after checking gate.greenCheckpoint.ownership."
        },
        "floorDifference": {
          "noLongerObserved": [],
          "newlyObserved": []
        },
        "adoptionQualification": null,
        "parkQualification": {
          "artifact": ".papercusp/evidence/c52-luna-r1-20261106/current-park-qualification-20261107T1715Z.json",
          "controlSnapshotAt": "2026-11-07 11:32:12.960427-05",
          "measuredAt": "2026-11-07T17:28:38.579Z",
          "qualificationAsMeasured": "reachable",
          "certification": "reachability-only; underlying release condition and clearer authority unverified"
        },
        "disposition": "unassessed",
        "executionEvidence": null,
        "nextActions": [
          "preserve park; qualify its exact condition and authorized clearer, with no automatic release from reachability"
        ],
        "limits": [
          "separately dated observations; not an immutable current-state snapshot",
          "a correct floor or release path does not prove underlying legitimacy",
          "adoption eligibility is report revision, not permission to implement"
        ]
      },
      "savedNovember8": {
        "observedAt": "2026-11-08 15:02:23.578069+00",
        "batch": 14,
        "recordPointer": "/rows/0/items/236",
        "rawProjectedRecord": {
          "id": "WI-6554700010011364",
          "state": "open",
          "holder": null,
          "control": {
            "_claimHold": true,
            "claim_hold_at": "2026-10-15T00:30:49.856Z",
            "claim_hold_by": "su-3ecaeba1-97c3-4c42-8d8b-33c0f90d2ac0",
            "claim_hold_reason": "The recorded 4.6h breach is historical; recovery would require monitoring the live gate round. That lane is owned by another live agent, so park this singleton until the owner's work completes.",
            "claim_hold_release": {
              "owner": "su-6f6f3aa0-77b0-4ab3-a9e5-126b5853a81c",
              "trigger": "work-item:done:WI-10006055",
              "evidence": "a live resolver or producer registration can still satisfy the condition",
              "condition": "Re-evaluate this historical round-cycle alarm after the current red-streak work item WI-10006055 reaches terminal completion and fresh round data is available.",
              "reachability": "reachable"
            },
            "implementationReadiness": {
              "reason": "no-acceptance-evidence-at-creation",
              "source": "creation-enrollment",
              "status": "unknown",
              "updatedAt": "2026-10-14T00:03:22.317Z",
              "schemaVersion": "implementation-readiness-v1"
            }
          },
          "takenAt": null,
          "admission": "auto",
          "updatedAt": 1792024249856,
          "admittedAt": "2026-10-14T00:03:22.317+00:00",
          "admittedBy": "bypass:condition-key",
          "sourcePlan": null,
          "duplicateOf": null,
          "sourceItems": null,
          "conditionKey": "alarm:green-main-slo:%5B%22papercusp-workspace%22%2C%22papercusp%22%2C%22round-cycle-time%22%2C%22green-main-slo%3Apapercusp%3Around-cycle-time%3A4a0ab75652bda2698d296eee96aa340f0eb3a620%3A2%22%2C%224a0ab75652bda2698d296eee96aa340f0eb3a620%22%5D",
          "stateChangedAt": "2026-10-14T00:03:22.317+00:00"
        }
      },
      "reconciliation": {
        "id": "WI-6554700010011364",
        "frozenSourceSha256": "06814bb39685da6b67859410f3c9698063f93ef0e67aa9afd978f25c5f29d233",
        "frozenState": "open",
        "frozenFloors": [
          "live-gate-ops",
          "claim-hold"
        ],
        "priorDisposition": "unassessed",
        "currentBatch": 14,
        "currentState": "open",
        "currentHolder": null,
        "currentAdmission": "auto",
        "currentControlKeys": [
          "_claimHold",
          "claim_hold_at",
          "claim_hold_by",
          "claim_hold_reason",
          "claim_hold_release",
          "implementationReadiness"
        ],
        "changedProjectedControlKeys": [],
        "unmeasuredFrozenControlKeys": [
          "freshnessEnvelope",
          "reporter"
        ],
        "assessment": "condition-and-clearer-legitimacy-unresolved",
        "finalR1Disposition": "unresolved"
      },
      "conditionIdentity": {
        "key": "alarm:green-main-slo:%5B%22papercusp-workspace%22%2C%22papercusp%22%2C%22round-cycle-time%22%2C%22green-main-slo%3Apapercusp%3Around-cycle-time%3A4a0ab75652bda2698d296eee96aa340f0eb3a620%3A2%22%2C%224a0ab75652bda2698d296eee96aa340f0eb3a620%22%5D",
        "decodedWorkspaceInstallMetricEpisodeSubject": [
          "papercusp-workspace",
          "papercusp",
          "round-cycle-time",
          "green-main-slo:papercusp:round-cycle-time:4a0ab75652bda2698d296eee96aa340f0eb3a620:2",
          "4a0ab75652bda2698d296eee96aa340f0eb3a620"
        ],
        "datedPostFreezeKeyEqual": true,
        "frozenRawExportOmitsConditionKey": true,
        "historicalFrozenKeyUnproven": true
      },
      "sourceConditionedReservation": "The saved exact metric-slot key matches the witnessed current self-select reservation. The SQL floor depends on condition_key, not current gate ownership or holder liveness. No historical loaded-source identity is asserted.",
      "clearerQualification": {
        "conditionProducer": "greenMainSloConditionKey/runGreenMainSloPass source witness; historical emission not read",
        "conditionResolver": "Existing watchdog: measuredRecovery or explicitlySupersededByNewQueue, with distinct resolution summary. Supersession is not measured recovery or a durable fix.",
        "manualParkReleaseContract": {
          "owner": "su-6f6f3aa0-77b0-4ab3-a9e5-126b5853a81c",
          "trigger": "work-item:done:WI-10006055",
          "evidence": "a live resolver or producer registration can still satisfy the condition",
          "condition": "Re-evaluate this historical round-cycle alarm after the current red-streak work item WI-10006055 reaches terminal completion and fresh round data is available.",
          "reachability": "reachable"
        },
        "recordedReleaseOwner": "su-6f6f3aa0-77b0-4ab3-a9e5-126b5853a81c",
        "currentAuthenticatedNamedClearer": null,
        "currentGateOwnership": "UNMEASURED; intentionally not queried",
        "triggerLimit": "Gate-item completion or release:green is a wake/recheck trigger, not exact episode recovery or park clearance proof.",
        "independentControls": "Self-select reservation, durable park, external blocker, review/readiness and lifecycle guards remain separate."
      },
      "executionQualification": "No new execution or original-scope fix demonstrated. Saved state and missing holder do not authorize claim, release or monitoring.",
      "finalR1Disposition": "UNRESOLVED: historical condition truth/source identity, legitimate exception, current named authenticated authority and original-scope execution."
    },
    {
      "id": "WI-6554700010011486",
      "frozenSource": {
        "path": "/mnt/data/papercusp-audit-inputs/c52-r1-frozen-20261106T1917Z/WI-6554700010011486.json",
        "sha256": "c363a25f5a0712381be67d780ff58e7fec16c74f7c6019806003ceaf979b590e",
        "raw": {
          "id": "WI-6554700010011486",
          "kind": "bug",
          "family": "issue",
          "harness": "papercusp",
          "title": "[alarm:green-main-slo:%5B%22papercusp-workspace%22%2C%22papercusp%22%2C%22time-since-verdict%22%2C%22green-main-slo%3Apapercusp%3Atime-since-verdict%3A179191894",
          "summary": "Owning work-item for condition 'alarm:green-main-slo:%5B%22papercusp-workspace%22%2C%22papercusp%22%2C%22time-since-verdict%22%2C%22green-main-slo%3Apapercusp%3Atime-since-verdict%3A1791918948539.946%22%2Cnull%5D', minted by the condition bridge (P-003, gate-ownership-condition-singleton-2026-08-03). This item is the SINGLETON for this condition — the partial unique index on work_items.condition_key guarantees at most one open owner, so claim THIS rather than filing another.\n\nLatest alarm: No gate verdict for 6.2h on papercusp\nFirst seen: 2026-10-14T01:30:42.294Z · open since: 2026-10-14T01:30:42.294Z · alarms: 1\n\nLatest alarm detail (from the emitter):\nThe gate has rendered no verdict (green or red) since 2026-10-13T19:15:48.539Z (SLO page at 6.0h).\n\n— emitted by pid 845826, process started 2026-10-14T00:27:53.193Z (up 1h02m), cwd /home/marsh-office/papercupai-workspace/papercusp/apps/operator. If that start time PREDATES the fix you are checking, this process never loaded it (no hot-reload) and no deploy will reach it — restart that host instead of re-investigating the alarm.",
          "state": "open",
          "assignee": null,
          "takenAt": null,
          "lastProgressAt": "2026-10-15T02:00:26.622Z",
          "assignedBy": null,
          "createdBy": null,
          "severity": "major",
          "goalId": null,
          "tags": null,
          "sourcePlanSlug": null,
          "sourcePlanItemIds": null,
          "redundancy": null,
          "expectedCostCents": null,
          "parent": null,
          "payload": {
            "_ei": {
              "scope": "harness:papercusp",
              "source": "engineer",
              "severity": "major",
              "signal_origin": "organic"
            },
            "_bridge": {
              "mintedAt": "2026-10-14T01:32:47.644Z",
              "conditionKey": "alarm:green-main-slo:%5B%22papercusp-workspace%22%2C%22papercusp%22%2C%22time-since-verdict%22%2C%22green-main-slo%3Apapercusp%3Atime-since-verdict%3A1791918948539.946%22%2Cnull%5D"
            },
            "reporter": {
              "at": "2026-10-14T01:32:47.646Z",
              "id": null,
              "kind": "watchdog",
              "basis": "no-session"
            },
            "_claimHold": true,
            "claim_hold_at": "2026-10-15T02:00:55.305Z",
            "claim_hold_by": "su-5715fa7a-abf5-4d99-85c3-fea725a3dac2",
            "reporterKinds": [
              "watchdog"
            ],
            "claim_hold_reason": "Source review is complete, but validating or diagnosing the current no-verdict condition is exclusive to the live owner of WI-10006055. The claim refusal confirmed that owner is live and progressing.",
            "freshnessEnvelope": {
              "observedAt": "2026-10-14T01:32:47.646Z",
              "linkedFixRefs": [],
              "reporterSession": null,
              "observedSourceSha": "fec88aa831",
              "toolSchemaVersion": null,
              "observedRuntimeSha": "fec88aa831",
              "deployBuildIdentity": "fec88aa831@0.0.0",
              "reporterRuntimeVersion": "0.0.0",
              "lastSuccessfulReproductionAt": null
            },
            "claim_hold_release": {
              "owner": "su-6f6f3aa0-77b0-4ab3-a9e5-126b5853a81c",
              "trigger": "work-item:done:WI-10006055",
              "evidence": "a live resolver or producer registration can still satisfy the condition",
              "condition": "Re-evaluate the time-since-verdict alarm after the current gate owner completes WI-10006055.",
              "reachability": "reachable"
            },
            "claim_history_post_id": 9001788375295,
            "implementationReadiness": {
              "reason": "no-acceptance-evidence-at-creation",
              "source": "creation-enrollment",
              "status": "unknown",
              "updatedAt": "2026-10-14T01:32:47.646Z",
              "schemaVersion": "implementation-readiness-v1"
            }
          },
          "definition": null,
          "rank": null,
          "rankWriter": null,
          "rankUpdatedAt": null,
          "priority": null,
          "terminalOwner": null,
          "terminalCompletionRef": null,
          "terminalCompletionEvidence": null,
          "completionAuthority": null,
          "origin": "local",
          "auditVerdict": null,
          "verifiedAuthorGithubUserId": null,
          "createdAt": "2026-10-14T01:32:47.646Z",
          "updatedAt": "2026-10-15T02:00:55.305Z",
          "closedAt": null
        }
      },
      "originalLedgerRow": {
        "id": "WI-6554700010011486",
        "source": "/mnt/data/papercusp-audit-inputs/c52-r1-frozen-20261106T1917Z/WI-6554700010011486.json",
        "sourceSha256": "c363a25f5a0712381be67d780ff58e7fec16c74f7c6019806003ceaf979b590e",
        "manifestSha256": "75f699e3073a53df71db467214e8d3271ab3df35aca42fd3a5dcd1918f9af1ad",
        "state": "open",
        "rowAgeSecondsAtSnapshot": 2051001.982262,
        "rawRestrictionVerdict": {
          "id": "WI-6554700010011486",
          "admissible": false,
          "refusedBy": "live-gate-ops",
          "failedFloors": [
            "live-gate-ops",
            "claim-hold"
          ],
          "detail": "LIVE_GATE_OPS condition (gate-red-streak: or green-stall: singleton, or an alarm:green-main-slo: time-since-green/time-since-verdict/red-adding-admission/round-cycle-time/queue-idle alarm) — reserved to the one registered live gate fixer and excluded from opportunistic self-select. A leader/owner may still dispatch or claim it BY ID after checking gate.greenCheckpoint.ownership."
        },
        "restrictions": [
          {
            "floor": "live-gate-ops",
            "stateProducerRecorded": null,
            "enteredAtRecorded": null,
            "ageSecondsAtSnapshot": null,
            "accountableClearerRecorded": null,
            "releaseConditionRecordedOrEvaluatorRule": "Registered live gate owner progresses this lane; no competing takeover or repeated gate status read.",
            "currentEvidence": {
              "scope": "LIVE_GATE_OPS",
              "status": "excluded from this investigation lane"
            },
            "verification": "unassessed; recorded values and evaluator rules do not establish legitimacy",
            "unknownFields": [
              "stateProducer",
              "enteredAt",
              "accountableClearer"
            ]
          },
          {
            "floor": "claim-hold",
            "stateProducerRecorded": "su-5715fa7a-abf5-4d99-85c3-fea725a3dac2",
            "enteredAtRecorded": "2026-10-15T02:00:55.305Z",
            "ageSecondsAtSnapshot": 1962914.323262,
            "accountableClearerRecorded": "su-6f6f3aa0-77b0-4ab3-a9e5-126b5853a81c",
            "releaseConditionRecordedOrEvaluatorRule": "Re-evaluate the time-since-verdict alarm after the current gate owner completes WI-10006055.",
            "currentEvidence": {
              "claim_hold_at": "2026-10-15T02:00:55.305Z",
              "claim_hold_by": "su-5715fa7a-abf5-4d99-85c3-fea725a3dac2",
              "claim_hold_reason": "Source review is complete, but validating or diagnosing the current no-verdict condition is exclusive to the live owner of WI-10006055. The claim refusal confirmed that owner is live and progressing.",
              "claim_hold_release": {
                "owner": "su-6f6f3aa0-77b0-4ab3-a9e5-126b5853a81c",
                "trigger": "work-item:done:WI-10006055",
                "evidence": "a live resolver or producer registration can still satisfy the condition",
                "condition": "Re-evaluate the time-since-verdict alarm after the current gate owner completes WI-10006055.",
                "reachability": "reachable"
              }
            },
            "verification": "unassessed; recorded values and evaluator rules do not establish legitimacy",
            "unknownFields": [],
            "writerProvenanceVerification": {
              "sourceRules": "work-items.ts:setWorkItemClaimHold and work-items-admission-promoter.ts:qualifiedAgentPark; corroboration grants no release authority",
              "checks": [
                {
                  "convention": "claim_hold",
                  "recordedActor": "su-5715fa7a-abf5-4d99-85c3-fea725a3dac2",
                  "corroboratedCanonicalWriter": true,
                  "criteria": {
                    "latestIsCanonicalSet": true,
                    "auditActorMatches": true,
                    "modeMatches": true,
                    "byMatches": true,
                    "reasonMatches": true,
                    "timestampMatches": true,
                    "releaseContractMatches": true
                  },
                  "auditId": "wi-claim-hold-mv8w6rl1-2wxemk",
                  "notProven": [
                    "current actor authority",
                    "legitimacy of underlying reason",
                    "truth of arbitrary release condition",
                    "clearance",
                    "execution"
                  ]
                }
              ],
              "noConventionRecorded": false
            }
          }
        ],
        "controlEvidence": {
          "implementationReadiness": {
            "reason": "no-acceptance-evidence-at-creation",
            "source": "creation-enrollment",
            "status": "unknown",
            "updatedAt": "2026-10-14T01:32:47.646Z",
            "schemaVersion": "implementation-readiness-v1"
          },
          "_claimHold": true,
          "claim_hold_at": "2026-10-15T02:00:55.305Z",
          "claim_hold_by": "su-5715fa7a-abf5-4d99-85c3-fea725a3dac2",
          "claim_hold_reason": "Source review is complete, but validating or diagnosing the current no-verdict condition is exclusive to the live owner of WI-10006055. The claim refusal confirmed that owner is live and progressing.",
          "claim_hold_release": {
            "owner": "su-6f6f3aa0-77b0-4ab3-a9e5-126b5853a81c",
            "trigger": "work-item:done:WI-10006055",
            "evidence": "a live resolver or producer registration can still satisfy the condition",
            "condition": "Re-evaluate the time-since-verdict alarm after the current gate owner completes WI-10006055.",
            "reachability": "reachable"
          },
          "reporter": {
            "at": "2026-10-14T01:32:47.646Z",
            "id": null,
            "kind": "watchdog",
            "basis": "no-session"
          },
          "freshnessEnvelope": {
            "observedAt": "2026-10-14T01:32:47.646Z",
            "linkedFixRefs": [],
            "reporterSession": null,
            "observedSourceSha": "fec88aa831",
            "toolSchemaVersion": null,
            "observedRuntimeSha": "fec88aa831",
            "deployBuildIdentity": "fec88aa831@0.0.0",
            "reporterRuntimeVersion": "0.0.0",
            "lastSuccessfulReproductionAt": null
          }
        },
        "accountableInvestigator": "su-c52a1707-13f5-4080-870b-f7143c271d73",
        "disposition": "unassessed",
        "legitimateException": null,
        "executionEvidence": null,
        "remainingVerification": [
          "Actual source writer and recorded producer",
          "Restriction evidence, age, accountable authorized clearer and exact release condition",
          "Legitimacy or false-restriction repair",
          "Same-ID execution or explicit Avi disposition"
        ],
        "schemaVersion": "luna-r1-causal-evidence-ledger-v4",
        "sourceQualification": {
          "status": "clearance mechanisms mapped; row-specific causal/legitimacy verification remains open",
          "registry": "/home/marsh-office/.papercusp/evidence/c52-luna-r1-20261106/restriction-authority-registry-v1.json",
          "registrySha256": "1b51f4be4a288749652dfaf9f7c7d4547aae962dd0d33a798f8e729f9e49dfbe",
          "floorMappings": [
            {
              "floor": "live-gate-ops",
              "mechanismRef": "/home/marsh-office/.papercusp/evidence/c52-luna-r1-20261106/restriction-authority-registry-v1.json#/floors/live-gate-ops",
              "rowVerification": "unassessed",
              "requiredRowEvidence": [
                "exact condition_key",
                "condition producer",
                "registered ownership evidence supplied by that lane"
              ]
            },
            {
              "floor": "claim-hold",
              "mechanismRef": "/home/marsh-office/.papercusp/evidence/c52-luna-r1-20261106/restriction-authority-registry-v1.json#/floors/claim-hold",
              "rowVerification": "unassessed",
              "requiredRowEvidence": [
                "both provenance conventions",
                "typed release contract or precise legacy condition",
                "condition-specific proof",
                "current assignment/fingerprint",
                "owner authority if required"
              ],
              "recordedReleaseContractOwner": "su-6f6f3aa0-77b0-4ab3-a9e5-126b5853a81c",
              "recordedLeaseHolder": null,
              "recordedParker": "su-5715fa7a-abf5-4d99-85c3-fea725a3dac2",
              "authorityVerified": false
            }
          ]
        },
        "postFreezeControlContext": {
          "artifact": "/home/marsh-office/.papercusp/evidence/c52-luna-r1-20261106/live-control-enrichment-20261106T1950Z-v2.json",
          "observedAt": "2026-11-06 19:48:21.753008+00",
          "record": {
            "id": "WI-6554700010011486",
            "state": "open",
            "harness": "papercusp",
            "takenAt": null,
            "takenBy": null,
            "admission": "auto",
            "createdAt": 1791941567646,
            "updatedAt": 1792029655305,
            "admittedAt": "2026-10-14T01:32:47.646+00:00",
            "admittedBy": "bypass:condition-key",
            "duplicateOf": null,
            "conditionKey": "alarm:green-main-slo:%5B%22papercusp-workspace%22%2C%22papercusp%22%2C%22time-since-verdict%22%2C%22green-main-slo%3Apapercusp%3Atime-since-verdict%3A1791918948539.946%22%2Cnull%5D",
            "holderPresence": null,
            "sourcePlanSlug": null,
            "sourcePlanItemIds": null
          },
          "limitations": [
            "Presence absence does not establish holder death or authorize release",
            "Current terminal state alone does not prove execution",
            "Admission values are current post-freeze evidence; historical producer/state-transition audit still required"
          ]
        },
        "postFreezeDependencyContext": {
          "artifact": "/home/marsh-office/.papercusp/evidence/c52-luna-r1-20261106/dependency-enrichment-20261106T1930Z.json",
          "observedAt": "2026-11-06T19:26:36.952682Z",
          "edges": [],
          "coverage": "not queried by this enrichment; empty list is not absence evidence"
        },
        "historicalAuditEvidence": {
          "artifact": "/home/marsh-office/.papercusp/evidence/c52-luna-r1-20261106/historical-audit-enrichment-20261106T2010Z.json",
          "sha256": "4b396df0818120147036644a9e33893170b4d271e5a5fd1a87e0e720a9884410",
          "recordPointer": "/queryResult/rows/0/items/5843",
          "observedAt": "2026-11-06 20:03:09.124326+00",
          "eventCutoffMs": 1793992569628,
          "eventCount": 1,
          "coverage": "Available work_items:% audit only; empty is not no-transition proof; nonterminal changes and some needs-human changes are undated."
        }
      },
      "savedNovember7Qualification": {
        "schemaVersion": "luna-r1-causal-qualification-v1",
        "id": "WI-6554700010011486",
        "sourceLedger": {
          "path": "/home/marsh-office/.papercusp/evidence/c52-luna-r1-20261106/causal-ledger-v4.jsonl",
          "sha256": "7f1962fb5c22f1bc2be9625406b315f6b5f4fd190b4743d7f972a4fb2c935866",
          "rowSourceSha256": "c363a25f5a0712381be67d780ff58e7fec16c74f7c6019806003ceaf979b590e"
        },
        "frozenState": "open",
        "frozenFloors": [
          "claim-hold",
          "live-gate-ops"
        ],
        "currentControlObservedAt": "2026-11-07 11:32:12.960427-05",
        "currentState": "open",
        "currentHolder": null,
        "currentFloorVerdict": {
          "id": "WI-6554700010011486",
          "admissible": false,
          "refusedBy": "live-gate-ops",
          "failedFloors": [
            "live-gate-ops",
            "claim-hold"
          ],
          "detail": "LIVE_GATE_OPS condition (gate-red-streak: or green-stall: singleton, or an alarm:green-main-slo: time-since-green/time-since-verdict/red-adding-admission/round-cycle-time/queue-idle alarm) — reserved to the one registered live gate fixer and excluded from opportunistic self-select. A leader/owner may still dispatch or claim it BY ID after checking gate.greenCheckpoint.ownership."
        },
        "floorDifference": {
          "noLongerObserved": [],
          "newlyObserved": []
        },
        "adoptionQualification": null,
        "parkQualification": {
          "artifact": ".papercusp/evidence/c52-luna-r1-20261106/current-park-qualification-20261107T1715Z.json",
          "controlSnapshotAt": "2026-11-07 11:32:12.960427-05",
          "measuredAt": "2026-11-07T17:28:39.474Z",
          "qualificationAsMeasured": "reachable",
          "certification": "reachability-only; underlying release condition and clearer authority unverified"
        },
        "disposition": "unassessed",
        "executionEvidence": null,
        "nextActions": [
          "preserve park; qualify its exact condition and authorized clearer, with no automatic release from reachability"
        ],
        "limits": [
          "separately dated observations; not an immutable current-state snapshot",
          "a correct floor or release path does not prove underlying legitimacy",
          "adoption eligibility is report revision, not permission to implement"
        ]
      },
      "savedNovember8": {
        "observedAt": "2026-11-08 15:02:23.578069+00",
        "batch": 14,
        "recordPointer": "/rows/0/items/243",
        "rawProjectedRecord": {
          "id": "WI-6554700010011486",
          "state": "open",
          "holder": null,
          "control": {
            "_claimHold": true,
            "claim_hold_at": "2026-10-15T02:00:55.305Z",
            "claim_hold_by": "su-5715fa7a-abf5-4d99-85c3-fea725a3dac2",
            "claim_hold_reason": "Source review is complete, but validating or diagnosing the current no-verdict condition is exclusive to the live owner of WI-10006055. The claim refusal confirmed that owner is live and progressing.",
            "claim_hold_release": {
              "owner": "su-6f6f3aa0-77b0-4ab3-a9e5-126b5853a81c",
              "trigger": "work-item:done:WI-10006055",
              "evidence": "a live resolver or producer registration can still satisfy the condition",
              "condition": "Re-evaluate the time-since-verdict alarm after the current gate owner completes WI-10006055.",
              "reachability": "reachable"
            },
            "implementationReadiness": {
              "reason": "no-acceptance-evidence-at-creation",
              "source": "creation-enrollment",
              "status": "unknown",
              "updatedAt": "2026-10-14T01:32:47.646Z",
              "schemaVersion": "implementation-readiness-v1"
            }
          },
          "takenAt": null,
          "admission": "auto",
          "updatedAt": 1792029655305,
          "admittedAt": "2026-10-14T01:32:47.646+00:00",
          "admittedBy": "bypass:condition-key",
          "sourcePlan": null,
          "duplicateOf": null,
          "sourceItems": null,
          "conditionKey": "alarm:green-main-slo:%5B%22papercusp-workspace%22%2C%22papercusp%22%2C%22time-since-verdict%22%2C%22green-main-slo%3Apapercusp%3Atime-since-verdict%3A1791918948539.946%22%2Cnull%5D",
          "stateChangedAt": "2026-10-14T01:32:47.646+00:00"
        }
      },
      "reconciliation": {
        "id": "WI-6554700010011486",
        "frozenSourceSha256": "c363a25f5a0712381be67d780ff58e7fec16c74f7c6019806003ceaf979b590e",
        "frozenState": "open",
        "frozenFloors": [
          "live-gate-ops",
          "claim-hold"
        ],
        "priorDisposition": "unassessed",
        "currentBatch": 14,
        "currentState": "open",
        "currentHolder": null,
        "currentAdmission": "auto",
        "currentControlKeys": [
          "_claimHold",
          "claim_hold_at",
          "claim_hold_by",
          "claim_hold_reason",
          "claim_hold_release",
          "implementationReadiness"
        ],
        "changedProjectedControlKeys": [],
        "unmeasuredFrozenControlKeys": [
          "freshnessEnvelope",
          "reporter"
        ],
        "assessment": "condition-and-clearer-legitimacy-unresolved",
        "finalR1Disposition": "unresolved"
      },
      "conditionIdentity": {
        "key": "alarm:green-main-slo:%5B%22papercusp-workspace%22%2C%22papercusp%22%2C%22time-since-verdict%22%2C%22green-main-slo%3Apapercusp%3Atime-since-verdict%3A1791918948539.946%22%2Cnull%5D",
        "decodedWorkspaceInstallMetricEpisodeSubject": [
          "papercusp-workspace",
          "papercusp",
          "time-since-verdict",
          "green-main-slo:papercusp:time-since-verdict:1791918948539.946",
          null
        ],
        "datedPostFreezeKeyEqual": true,
        "frozenRawExportOmitsConditionKey": true,
        "historicalFrozenKeyUnproven": true
      },
      "sourceConditionedReservation": "The saved exact metric-slot key matches the witnessed current self-select reservation. The SQL floor depends on condition_key, not current gate ownership or holder liveness. No historical loaded-source identity is asserted.",
      "clearerQualification": {
        "conditionProducer": "greenMainSloConditionKey/runGreenMainSloPass source witness; historical emission not read",
        "conditionResolver": "Existing watchdog: measuredRecovery or explicitlySupersededByNewQueue, with distinct resolution summary. Supersession is not measured recovery or a durable fix.",
        "manualParkReleaseContract": {
          "owner": "su-6f6f3aa0-77b0-4ab3-a9e5-126b5853a81c",
          "trigger": "work-item:done:WI-10006055",
          "evidence": "a live resolver or producer registration can still satisfy the condition",
          "condition": "Re-evaluate the time-since-verdict alarm after the current gate owner completes WI-10006055.",
          "reachability": "reachable"
        },
        "recordedReleaseOwner": "su-6f6f3aa0-77b0-4ab3-a9e5-126b5853a81c",
        "currentAuthenticatedNamedClearer": null,
        "currentGateOwnership": "UNMEASURED; intentionally not queried",
        "triggerLimit": "Gate-item completion or release:green is a wake/recheck trigger, not exact episode recovery or park clearance proof.",
        "independentControls": "Self-select reservation, durable park, external blocker, review/readiness and lifecycle guards remain separate."
      },
      "executionQualification": "No new execution or original-scope fix demonstrated. Saved state and missing holder do not authorize claim, release or monitoring.",
      "finalR1Disposition": "UNRESOLVED: historical condition truth/source identity, legitimate exception, current named authenticated authority and original-scope execution."
    },
    {
      "id": "WI-6554700010011700",
      "frozenSource": {
        "path": "/mnt/data/papercusp-audit-inputs/c52-r1-frozen-20261106T1917Z/WI-6554700010011700.json",
        "sha256": "afe73f4ecaa34a758f179e2cafc55f85d8345c830153b16b224f1420d2c7163e",
        "raw": {
          "id": "WI-6554700010011700",
          "kind": "bug",
          "family": "issue",
          "harness": "papercusp",
          "title": "[alarm:green-main-slo:%5B%22papercusp-workspace%22%2C%22papercusp%22%2C%22round-cycle-time%22%2C%22green-main-slo%3Apapercusp%3Around-cycle-time%3A4a0ab75652bda",
          "summary": "Owning work-item for condition 'alarm:green-main-slo:%5B%22papercusp-workspace%22%2C%22papercusp%22%2C%22round-cycle-time%22%2C%22green-main-slo%3Apapercusp%3Around-cycle-time%3A4a0ab75652bda2698d296eee96aa340f0eb3a620%3A3%22%2C%224a0ab75652bda2698d296eee96aa340f0eb3a620%22%5D', minted by the condition bridge (P-003, gate-ownership-condition-singleton-2026-08-03). This item is the SINGLETON for this condition — the partial unique index on work_items.condition_key guarantees at most one open owner, so claim THIS rather than filing another.\n\nLatest alarm: Repair round 3 took 3.4h on papercusp\nFirst seen: 2026-10-14T03:16:25.667Z · open since: 2026-10-14T03:16:25.667Z · alarms: 1\n\nLatest alarm detail (from the emitter):\nFrozen candidate 4a0ab75652bd: the newest round interval exceeds the 2.0h target.\n\n— emitted by pid 2872218, process started 2026-10-14T02:50:14.119Z (up 26m), cwd /home/marsh-office/papercupai-workspace/papercusp/apps/operator. If that start time PREDATES the fix you are checking, this process never loaded it (no hot-reload) and no deploy will reach it — restart that host instead of re-investigating the alarm.",
          "state": "open",
          "assignee": null,
          "takenAt": null,
          "lastProgressAt": null,
          "assignedBy": null,
          "createdBy": null,
          "severity": "major",
          "goalId": null,
          "tags": null,
          "sourcePlanSlug": null,
          "sourcePlanItemIds": null,
          "redundancy": null,
          "expectedCostCents": null,
          "parent": null,
          "payload": {
            "_ei": {
              "scope": "harness:papercusp",
              "source": "engineer",
              "severity": "major",
              "signal_origin": "organic"
            },
            "_bridge": {
              "mintedAt": "2026-10-14T03:20:09.879Z",
              "conditionKey": "alarm:green-main-slo:%5B%22papercusp-workspace%22%2C%22papercusp%22%2C%22round-cycle-time%22%2C%22green-main-slo%3Apapercusp%3Around-cycle-time%3A4a0ab75652bda2698d296eee96aa340f0eb3a620%3A3%22%2C%224a0ab75652bda2698d296eee96aa340f0eb3a620%22%5D"
            },
            "reporter": {
              "at": "2026-10-14T03:20:09.880Z",
              "id": null,
              "kind": "watchdog",
              "basis": "no-session"
            },
            "_claimHold": true,
            "claim_hold_at": "2026-10-15T08:05:25.700Z",
            "claim_hold_by": "su-e2401292-7f65-4c44-b1db-a9ac4b47fc97",
            "reporterKinds": [
              "watchdog"
            ],
            "claim_hold_reason": "Defer to the live gate owner; keep this item out of fleet self-selection until the recorded owner item completes.",
            "freshnessEnvelope": {
              "observedAt": "2026-10-14T03:20:09.880Z",
              "linkedFixRefs": [],
              "reporterSession": null,
              "observedSourceSha": "2a87073560",
              "toolSchemaVersion": null,
              "observedRuntimeSha": "2a87073560",
              "deployBuildIdentity": "2a87073560@0.0.1",
              "reporterRuntimeVersion": "0.0.1",
              "lastSuccessfulReproductionAt": null
            },
            "claim_hold_release": {
              "owner": "su-d6d37b55-374d-475a-b442-e9f4cceb94cb",
              "trigger": "work-item:done:WI-10006055",
              "evidence": "a live resolver or producer registration can still satisfy the condition",
              "condition": "The live gate-owner item WI-10006055 reaches terminal completion; then reconsider WI-6554700010011700.",
              "reachability": "reachable"
            },
            "claim_history_post_id": 9001788375295,
            "implementationReadiness": {
              "reason": "no-acceptance-evidence-at-creation",
              "source": "creation-enrollment",
              "status": "unknown",
              "updatedAt": "2026-10-14T03:20:09.880Z",
              "schemaVersion": "implementation-readiness-v1"
            }
          },
          "definition": null,
          "rank": null,
          "rankWriter": null,
          "rankUpdatedAt": null,
          "priority": null,
          "terminalOwner": null,
          "terminalCompletionRef": null,
          "terminalCompletionEvidence": null,
          "completionAuthority": null,
          "origin": "local",
          "auditVerdict": null,
          "verifiedAuthorGithubUserId": null,
          "createdAt": "2026-10-14T03:20:09.880Z",
          "updatedAt": "2026-10-15T08:05:25.700Z",
          "closedAt": null
        }
      },
      "originalLedgerRow": {
        "id": "WI-6554700010011700",
        "source": "/mnt/data/papercusp-audit-inputs/c52-r1-frozen-20261106T1917Z/WI-6554700010011700.json",
        "sourceSha256": "afe73f4ecaa34a758f179e2cafc55f85d8345c830153b16b224f1420d2c7163e",
        "manifestSha256": "75f699e3073a53df71db467214e8d3271ab3df35aca42fd3a5dcd1918f9af1ad",
        "state": "open",
        "rowAgeSecondsAtSnapshot": 2044559.748262,
        "rawRestrictionVerdict": {
          "id": "WI-6554700010011700",
          "admissible": false,
          "refusedBy": "live-gate-ops",
          "failedFloors": [
            "live-gate-ops",
            "claim-hold"
          ],
          "detail": "LIVE_GATE_OPS condition (gate-red-streak: or green-stall: singleton, or an alarm:green-main-slo: time-since-green/time-since-verdict/red-adding-admission/round-cycle-time/queue-idle alarm) — reserved to the one registered live gate fixer and excluded from opportunistic self-select. A leader/owner may still dispatch or claim it BY ID after checking gate.greenCheckpoint.ownership."
        },
        "restrictions": [
          {
            "floor": "live-gate-ops",
            "stateProducerRecorded": null,
            "enteredAtRecorded": null,
            "ageSecondsAtSnapshot": null,
            "accountableClearerRecorded": null,
            "releaseConditionRecordedOrEvaluatorRule": "Registered live gate owner progresses this lane; no competing takeover or repeated gate status read.",
            "currentEvidence": {
              "scope": "LIVE_GATE_OPS",
              "status": "excluded from this investigation lane"
            },
            "verification": "unassessed; recorded values and evaluator rules do not establish legitimacy",
            "unknownFields": [
              "stateProducer",
              "enteredAt",
              "accountableClearer"
            ]
          },
          {
            "floor": "claim-hold",
            "stateProducerRecorded": "su-e2401292-7f65-4c44-b1db-a9ac4b47fc97",
            "enteredAtRecorded": "2026-10-15T08:05:25.700Z",
            "ageSecondsAtSnapshot": 1941043.928262,
            "accountableClearerRecorded": "su-d6d37b55-374d-475a-b442-e9f4cceb94cb",
            "releaseConditionRecordedOrEvaluatorRule": "The live gate-owner item WI-10006055 reaches terminal completion; then reconsider WI-6554700010011700.",
            "currentEvidence": {
              "claim_hold_at": "2026-10-15T08:05:25.700Z",
              "claim_hold_by": "su-e2401292-7f65-4c44-b1db-a9ac4b47fc97",
              "claim_hold_reason": "Defer to the live gate owner; keep this item out of fleet self-selection until the recorded owner item completes.",
              "claim_hold_release": {
                "owner": "su-d6d37b55-374d-475a-b442-e9f4cceb94cb",
                "trigger": "work-item:done:WI-10006055",
                "evidence": "a live resolver or producer registration can still satisfy the condition",
                "condition": "The live gate-owner item WI-10006055 reaches terminal completion; then reconsider WI-6554700010011700.",
                "reachability": "reachable"
              }
            },
            "verification": "unassessed; recorded values and evaluator rules do not establish legitimacy",
            "unknownFields": [],
            "writerProvenanceVerification": {
              "sourceRules": "work-items.ts:setWorkItemClaimHold and work-items-admission-promoter.ts:qualifiedAgentPark; corroboration grants no release authority",
              "checks": [
                {
                  "convention": "claim_hold",
                  "recordedActor": "su-e2401292-7f65-4c44-b1db-a9ac4b47fc97",
                  "corroboratedCanonicalWriter": true,
                  "criteria": {
                    "latestIsCanonicalSet": true,
                    "auditActorMatches": true,
                    "modeMatches": true,
                    "byMatches": true,
                    "reasonMatches": true,
                    "timestampMatches": true,
                    "releaseContractMatches": true
                  },
                  "auditId": "wi-claim-hold-mv997ivh-mj31p8",
                  "notProven": [
                    "current actor authority",
                    "legitimacy of underlying reason",
                    "truth of arbitrary release condition",
                    "clearance",
                    "execution"
                  ]
                }
              ],
              "noConventionRecorded": false
            }
          }
        ],
        "controlEvidence": {
          "implementationReadiness": {
            "reason": "no-acceptance-evidence-at-creation",
            "source": "creation-enrollment",
            "status": "unknown",
            "updatedAt": "2026-10-14T03:20:09.880Z",
            "schemaVersion": "implementation-readiness-v1"
          },
          "_claimHold": true,
          "claim_hold_at": "2026-10-15T08:05:25.700Z",
          "claim_hold_by": "su-e2401292-7f65-4c44-b1db-a9ac4b47fc97",
          "claim_hold_reason": "Defer to the live gate owner; keep this item out of fleet self-selection until the recorded owner item completes.",
          "claim_hold_release": {
            "owner": "su-d6d37b55-374d-475a-b442-e9f4cceb94cb",
            "trigger": "work-item:done:WI-10006055",
            "evidence": "a live resolver or producer registration can still satisfy the condition",
            "condition": "The live gate-owner item WI-10006055 reaches terminal completion; then reconsider WI-6554700010011700.",
            "reachability": "reachable"
          },
          "reporter": {
            "at": "2026-10-14T03:20:09.880Z",
            "id": null,
            "kind": "watchdog",
            "basis": "no-session"
          },
          "freshnessEnvelope": {
            "observedAt": "2026-10-14T03:20:09.880Z",
            "linkedFixRefs": [],
            "reporterSession": null,
            "observedSourceSha": "2a87073560",
            "toolSchemaVersion": null,
            "observedRuntimeSha": "2a87073560",
            "deployBuildIdentity": "2a87073560@0.0.1",
            "reporterRuntimeVersion": "0.0.1",
            "lastSuccessfulReproductionAt": null
          }
        },
        "accountableInvestigator": "su-c52a1707-13f5-4080-870b-f7143c271d73",
        "disposition": "unassessed",
        "legitimateException": null,
        "executionEvidence": null,
        "remainingVerification": [
          "Actual source writer and recorded producer",
          "Restriction evidence, age, accountable authorized clearer and exact release condition",
          "Legitimacy or false-restriction repair",
          "Same-ID execution or explicit Avi disposition"
        ],
        "schemaVersion": "luna-r1-causal-evidence-ledger-v4",
        "sourceQualification": {
          "status": "clearance mechanisms mapped; row-specific causal/legitimacy verification remains open",
          "registry": "/home/marsh-office/.papercusp/evidence/c52-luna-r1-20261106/restriction-authority-registry-v1.json",
          "registrySha256": "1b51f4be4a288749652dfaf9f7c7d4547aae962dd0d33a798f8e729f9e49dfbe",
          "floorMappings": [
            {
              "floor": "live-gate-ops",
              "mechanismRef": "/home/marsh-office/.papercusp/evidence/c52-luna-r1-20261106/restriction-authority-registry-v1.json#/floors/live-gate-ops",
              "rowVerification": "unassessed",
              "requiredRowEvidence": [
                "exact condition_key",
                "condition producer",
                "registered ownership evidence supplied by that lane"
              ]
            },
            {
              "floor": "claim-hold",
              "mechanismRef": "/home/marsh-office/.papercusp/evidence/c52-luna-r1-20261106/restriction-authority-registry-v1.json#/floors/claim-hold",
              "rowVerification": "unassessed",
              "requiredRowEvidence": [
                "both provenance conventions",
                "typed release contract or precise legacy condition",
                "condition-specific proof",
                "current assignment/fingerprint",
                "owner authority if required"
              ],
              "recordedReleaseContractOwner": "su-d6d37b55-374d-475a-b442-e9f4cceb94cb",
              "recordedLeaseHolder": null,
              "recordedParker": "su-e2401292-7f65-4c44-b1db-a9ac4b47fc97",
              "authorityVerified": false
            }
          ]
        },
        "postFreezeControlContext": {
          "artifact": "/home/marsh-office/.papercusp/evidence/c52-luna-r1-20261106/live-control-enrichment-20261106T1950Z-v2.json",
          "observedAt": "2026-11-06 19:48:21.753008+00",
          "record": {
            "id": "WI-6554700010011700",
            "state": "open",
            "harness": "papercusp",
            "takenAt": null,
            "takenBy": null,
            "admission": "auto",
            "createdAt": 1791948009880,
            "updatedAt": 1792051525700,
            "admittedAt": "2026-10-14T03:20:09.88+00:00",
            "admittedBy": "bypass:condition-key",
            "duplicateOf": null,
            "conditionKey": "alarm:green-main-slo:%5B%22papercusp-workspace%22%2C%22papercusp%22%2C%22round-cycle-time%22%2C%22green-main-slo%3Apapercusp%3Around-cycle-time%3A4a0ab75652bda2698d296eee96aa340f0eb3a620%3A3%22%2C%224a0ab75652bda2698d296eee96aa340f0eb3a620%22%5D",
            "holderPresence": null,
            "sourcePlanSlug": null,
            "sourcePlanItemIds": null
          },
          "limitations": [
            "Presence absence does not establish holder death or authorize release",
            "Current terminal state alone does not prove execution",
            "Admission values are current post-freeze evidence; historical producer/state-transition audit still required"
          ]
        },
        "postFreezeDependencyContext": {
          "artifact": "/home/marsh-office/.papercusp/evidence/c52-luna-r1-20261106/dependency-enrichment-20261106T1930Z.json",
          "observedAt": "2026-11-06T19:26:36.952682Z",
          "edges": [],
          "coverage": "not queried by this enrichment; empty list is not absence evidence"
        },
        "historicalAuditEvidence": {
          "artifact": "/home/marsh-office/.papercusp/evidence/c52-luna-r1-20261106/historical-audit-enrichment-20261106T2010Z.json",
          "sha256": "4b396df0818120147036644a9e33893170b4d271e5a5fd1a87e0e720a9884410",
          "recordPointer": "/queryResult/rows/0/items/5849",
          "observedAt": "2026-11-06 20:03:09.124326+00",
          "eventCutoffMs": 1793992569628,
          "eventCount": 3,
          "coverage": "Available work_items:% audit only; empty is not no-transition proof; nonterminal changes and some needs-human changes are undated."
        }
      },
      "savedNovember7Qualification": {
        "schemaVersion": "luna-r1-causal-qualification-v1",
        "id": "WI-6554700010011700",
        "sourceLedger": {
          "path": "/home/marsh-office/.papercusp/evidence/c52-luna-r1-20261106/causal-ledger-v4.jsonl",
          "sha256": "7f1962fb5c22f1bc2be9625406b315f6b5f4fd190b4743d7f972a4fb2c935866",
          "rowSourceSha256": "afe73f4ecaa34a758f179e2cafc55f85d8345c830153b16b224f1420d2c7163e"
        },
        "frozenState": "open",
        "frozenFloors": [
          "claim-hold",
          "live-gate-ops"
        ],
        "currentControlObservedAt": "2026-11-07 11:32:12.960427-05",
        "currentState": "open",
        "currentHolder": null,
        "currentFloorVerdict": {
          "id": "WI-6554700010011700",
          "admissible": false,
          "refusedBy": "live-gate-ops",
          "failedFloors": [
            "live-gate-ops",
            "claim-hold"
          ],
          "detail": "LIVE_GATE_OPS condition (gate-red-streak: or green-stall: singleton, or an alarm:green-main-slo: time-since-green/time-since-verdict/red-adding-admission/round-cycle-time/queue-idle alarm) — reserved to the one registered live gate fixer and excluded from opportunistic self-select. A leader/owner may still dispatch or claim it BY ID after checking gate.greenCheckpoint.ownership."
        },
        "floorDifference": {
          "noLongerObserved": [],
          "newlyObserved": []
        },
        "adoptionQualification": null,
        "parkQualification": {
          "artifact": ".papercusp/evidence/c52-luna-r1-20261106/current-park-qualification-20261107T1715Z.json",
          "controlSnapshotAt": "2026-11-07 11:32:12.960427-05",
          "measuredAt": "2026-11-07T17:28:39.852Z",
          "qualificationAsMeasured": "reachable",
          "certification": "reachability-only; underlying release condition and clearer authority unverified"
        },
        "disposition": "unassessed",
        "executionEvidence": null,
        "nextActions": [
          "preserve park; qualify its exact condition and authorized clearer, with no automatic release from reachability"
        ],
        "limits": [
          "separately dated observations; not an immutable current-state snapshot",
          "a correct floor or release path does not prove underlying legitimacy",
          "adoption eligibility is report revision, not permission to implement"
        ]
      },
      "savedNovember8": {
        "observedAt": "2026-11-08 15:02:23.578069+00",
        "batch": 14,
        "recordPointer": "/rows/0/items/249",
        "rawProjectedRecord": {
          "id": "WI-6554700010011700",
          "state": "open",
          "holder": null,
          "control": {
            "_claimHold": true,
            "claim_hold_at": "2026-10-15T08:05:25.700Z",
            "claim_hold_by": "su-e2401292-7f65-4c44-b1db-a9ac4b47fc97",
            "claim_hold_reason": "Defer to the live gate owner; keep this item out of fleet self-selection until the recorded owner item completes.",
            "claim_hold_release": {
              "owner": "su-d6d37b55-374d-475a-b442-e9f4cceb94cb",
              "trigger": "work-item:done:WI-10006055",
              "evidence": "a live resolver or producer registration can still satisfy the condition",
              "condition": "The live gate-owner item WI-10006055 reaches terminal completion; then reconsider WI-6554700010011700.",
              "reachability": "reachable"
            },
            "implementationReadiness": {
              "reason": "no-acceptance-evidence-at-creation",
              "source": "creation-enrollment",
              "status": "unknown",
              "updatedAt": "2026-10-14T03:20:09.880Z",
              "schemaVersion": "implementation-readiness-v1"
            }
          },
          "takenAt": null,
          "admission": "auto",
          "updatedAt": 1792051525700,
          "admittedAt": "2026-10-14T03:20:09.88+00:00",
          "admittedBy": "bypass:condition-key",
          "sourcePlan": null,
          "duplicateOf": null,
          "sourceItems": null,
          "conditionKey": "alarm:green-main-slo:%5B%22papercusp-workspace%22%2C%22papercusp%22%2C%22round-cycle-time%22%2C%22green-main-slo%3Apapercusp%3Around-cycle-time%3A4a0ab75652bda2698d296eee96aa340f0eb3a620%3A3%22%2C%224a0ab75652bda2698d296eee96aa340f0eb3a620%22%5D",
          "stateChangedAt": "2026-10-14T03:20:09.88+00:00"
        }
      },
      "reconciliation": {
        "id": "WI-6554700010011700",
        "frozenSourceSha256": "afe73f4ecaa34a758f179e2cafc55f85d8345c830153b16b224f1420d2c7163e",
        "frozenState": "open",
        "frozenFloors": [
          "live-gate-ops",
          "claim-hold"
        ],
        "priorDisposition": "unassessed",
        "currentBatch": 14,
        "currentState": "open",
        "currentHolder": null,
        "currentAdmission": "auto",
        "currentControlKeys": [
          "_claimHold",
          "claim_hold_at",
          "claim_hold_by",
          "claim_hold_reason",
          "claim_hold_release",
          "implementationReadiness"
        ],
        "changedProjectedControlKeys": [],
        "unmeasuredFrozenControlKeys": [
          "freshnessEnvelope",
          "reporter"
        ],
        "assessment": "condition-and-clearer-legitimacy-unresolved",
        "finalR1Disposition": "unresolved"
      },
      "conditionIdentity": {
        "key": "alarm:green-main-slo:%5B%22papercusp-workspace%22%2C%22papercusp%22%2C%22round-cycle-time%22%2C%22green-main-slo%3Apapercusp%3Around-cycle-time%3A4a0ab75652bda2698d296eee96aa340f0eb3a620%3A3%22%2C%224a0ab75652bda2698d296eee96aa340f0eb3a620%22%5D",
        "decodedWorkspaceInstallMetricEpisodeSubject": [
          "papercusp-workspace",
          "papercusp",
          "round-cycle-time",
          "green-main-slo:papercusp:round-cycle-time:4a0ab75652bda2698d296eee96aa340f0eb3a620:3",
          "4a0ab75652bda2698d296eee96aa340f0eb3a620"
        ],
        "datedPostFreezeKeyEqual": true,
        "frozenRawExportOmitsConditionKey": true,
        "historicalFrozenKeyUnproven": true
      },
      "sourceConditionedReservation": "The saved exact metric-slot key matches the witnessed current self-select reservation. The SQL floor depends on condition_key, not current gate ownership or holder liveness. No historical loaded-source identity is asserted.",
      "clearerQualification": {
        "conditionProducer": "greenMainSloConditionKey/runGreenMainSloPass source witness; historical emission not read",
        "conditionResolver": "Existing watchdog: measuredRecovery or explicitlySupersededByNewQueue, with distinct resolution summary. Supersession is not measured recovery or a durable fix.",
        "manualParkReleaseContract": {
          "owner": "su-d6d37b55-374d-475a-b442-e9f4cceb94cb",
          "trigger": "work-item:done:WI-10006055",
          "evidence": "a live resolver or producer registration can still satisfy the condition",
          "condition": "The live gate-owner item WI-10006055 reaches terminal completion; then reconsider WI-6554700010011700.",
          "reachability": "reachable"
        },
        "recordedReleaseOwner": "su-d6d37b55-374d-475a-b442-e9f4cceb94cb",
        "currentAuthenticatedNamedClearer": null,
        "currentGateOwnership": "UNMEASURED; intentionally not queried",
        "triggerLimit": "Gate-item completion or release:green is a wake/recheck trigger, not exact episode recovery or park clearance proof.",
        "independentControls": "Self-select reservation, durable park, external blocker, review/readiness and lifecycle guards remain separate."
      },
      "executionQualification": "No new execution or original-scope fix demonstrated. Saved state and missing holder do not authorize claim, release or monitoring.",
      "finalR1Disposition": "UNRESOLVED: historical condition truth/source identity, legitimate exception, current named authenticated authority and original-scope execution."
    },
    {
      "id": "WI-6554700010011852",
      "frozenSource": {
        "path": "/mnt/data/papercusp-audit-inputs/c52-r1-frozen-20261106T1917Z/WI-6554700010011852.json",
        "sha256": "20e7a5276ef05ae06e09341e6cbca0c57d20f4d393fd86ac1ffad44b83391919",
        "raw": {
          "id": "WI-6554700010011852",
          "kind": "bug",
          "family": "issue",
          "harness": "papercusp",
          "title": "[alarm:green-main-slo:%5B%22papercusp-workspace%22%2C%22papercusp%22%2C%22queue-idle%22%2C%22green-main-slo%3Apapercusp%3Aqueue-idle%3A4a0ab75652bda2698d296eee9",
          "summary": "Owning work-item for condition 'alarm:green-main-slo:%5B%22papercusp-workspace%22%2C%22papercusp%22%2C%22queue-idle%22%2C%22green-main-slo%3Apapercusp%3Aqueue-idle%3A4a0ab75652bda2698d296eee96aa340f0eb3a620%3A1791947705172%22%2C%224a0ab75652bda2698d296eee96aa340f0eb3a620%22%5D', minted by the condition bridge (P-003, gate-ownership-condition-singleton-2026-08-03). This item is the SINGLETON for this condition — the partial unique index on work_items.condition_key guarantees at most one open owner, so claim THIS rather than filing another.\n\nLatest alarm: Frozen repair queue idle 1.0h on papercusp\nFirst seen: 2026-10-14T04:15:41.172Z · open since: 2026-10-14T04:15:41.172Z · alarms: 1\n\nLatest alarm detail (from the emitter):\nThe newest red has waited 1.0h for a fixer.\n\n— emitted by pid 290419, process started 2026-10-14T03:20:26.171Z (up 55m), cwd /home/marsh-office/papercupai-workspace/papercusp/apps/operator. If that start time PREDATES the fix you are checking, this process never loaded it (no hot-reload) and no deploy will reach it — restart that host instead of re-investigating the alarm.",
          "state": "blocked",
          "assignee": null,
          "takenAt": null,
          "lastProgressAt": "2026-10-15T05:16:07.955Z",
          "assignedBy": null,
          "createdBy": null,
          "severity": "major",
          "goalId": null,
          "tags": null,
          "sourcePlanSlug": null,
          "sourcePlanItemIds": null,
          "redundancy": null,
          "expectedCostCents": null,
          "parent": null,
          "payload": {
            "_ei": {
              "scope": "harness:papercusp",
              "source": "engineer",
              "severity": "major",
              "signal_origin": "organic"
            },
            "_bridge": {
              "mintedAt": "2026-10-14T04:16:02.409Z",
              "conditionKey": "alarm:green-main-slo:%5B%22papercusp-workspace%22%2C%22papercusp%22%2C%22queue-idle%22%2C%22green-main-slo%3Apapercusp%3Aqueue-idle%3A4a0ab75652bda2698d296eee96aa340f0eb3a620%3A1791947705172%22%2C%224a0ab75652bda2698d296eee96aa340f0eb3a620%22%5D"
            },
            "reporter": {
              "at": "2026-10-14T04:16:02.448Z",
              "id": null,
              "kind": "watchdog",
              "basis": "no-session"
            },
            "_claimHold": true,
            "claim_hold_at": "2026-10-15T05:18:27.037Z",
            "claim_hold_by": "su-14ff025a-1d44-47e2-89cd-5df18ab33d36",
            "reporterKinds": [
              "watchdog"
            ],
            "externalBlockers": [
              {
                "ref": "gate-red-streak:papercusp",
                "kind": "gate",
                "status": "active",
                "summary": "Validation is complete, but current recovery status belongs to the live gate owner on WI-10006055.",
                "evidence": "state:read gate.greenCheckpoint.ownership assessed held-live by su-e2401292-7f65-4c44-b1db-a9ac4b47fc97; historical alert evidence and test results are saved in this item's checkpoint.",
                "nextVerb": "Re-evaluate after the live gate owner releases gate-red-streak:papercusp.",
                "createdAt": "2026-10-15T05:17:12.139Z",
                "createdBy": "su-14ff025a-1d44-47e2-89cd-5df18ab33d36",
                "recheckAt": "2026-11-06T18:30:34.724Z",
                "updatedAt": "2026-11-06T17:30:34.724Z",
                "capability": "live-dependency",
                "recheckedAt": "2026-11-06T17:30:34.724Z",
                "reachability": {
                  "basis": "unmeasured",
                  "verdict": "unknown",
                  "evidence": "trigger \"gate-red-streak:papercusp\" may wake a consumer but cannot establish the specific release condition; subject-bound evidence is required",
                  "checkedAt": "2026-11-06T17:40:25.197Z",
                  "authoritative": false,
                  "uncertifiedReason": "uncatalogued"
                },
                "recheckSource": "system:unprovable-wait-backfill",
                "capabilitySource": "explicit",
                "recheckDisposition": "escalated"
              }
            ],
            "claim_hold_reason": "Defer this historical alert until the current live gate work item completes.",
            "freshnessEnvelope": {
              "observedAt": "2026-10-14T04:16:02.448Z",
              "linkedFixRefs": [],
              "reporterSession": null,
              "observedSourceSha": "ae615f5fa9",
              "toolSchemaVersion": null,
              "observedRuntimeSha": "ae615f5fa9",
              "deployBuildIdentity": "ae615f5fa9@0.0.0",
              "reporterRuntimeVersion": "0.0.0",
              "lastSuccessfulReproductionAt": null
            },
            "claim_hold_release": {
              "owner": "su-e2401292-7f65-4c44-b1db-a9ac4b47fc97",
              "trigger": "work-item:done:WI-10006055",
              "evidence": "a live resolver or producer registration can still satisfy the condition",
              "condition": "WI-10006055 is complete; then re-check whether the live gate ownership has ended before resuming this alert.",
              "reachability": "reachable"
            },
            "claim_history_post_id": 9001788375295,
            "implementationReadiness": {
              "reason": "no-acceptance-evidence-at-creation",
              "source": "creation-enrollment",
              "status": "unknown",
              "updatedAt": "2026-10-14T04:16:02.448Z",
              "schemaVersion": "implementation-readiness-v1"
            }
          },
          "definition": null,
          "externalBlockers": [
            {
              "ref": "gate-red-streak:papercusp",
              "kind": "gate",
              "status": "active",
              "summary": "Validation is complete, but current recovery status belongs to the live gate owner on WI-10006055.",
              "evidence": "state:read gate.greenCheckpoint.ownership assessed held-live by su-e2401292-7f65-4c44-b1db-a9ac4b47fc97; historical alert evidence and test results are saved in this item's checkpoint.",
              "nextVerb": "Re-evaluate after the live gate owner releases gate-red-streak:papercusp.",
              "createdAt": "2026-10-15T05:17:12.139Z",
              "createdBy": "su-14ff025a-1d44-47e2-89cd-5df18ab33d36",
              "recheckAt": "2026-11-06T18:30:34.724Z",
              "updatedAt": "2026-11-06T17:30:34.724Z",
              "capability": "live-dependency",
              "recheckedAt": "2026-11-06T17:30:34.724Z",
              "reachability": {
                "basis": "unmeasured",
                "verdict": "unknown",
                "evidence": "trigger \"gate-red-streak:papercusp\" may wake a consumer but cannot establish the specific release condition; subject-bound evidence is required",
                "checkedAt": "2026-11-06T17:40:25.197Z",
                "authoritative": false,
                "uncertifiedReason": "uncatalogued"
              },
              "recheckSource": "system:unprovable-wait-backfill",
              "capabilitySource": "explicit",
              "recheckDisposition": "escalated"
            }
          ],
          "rank": null,
          "rankWriter": null,
          "rankUpdatedAt": null,
          "priority": null,
          "terminalOwner": null,
          "terminalCompletionRef": null,
          "terminalCompletionEvidence": null,
          "completionAuthority": null,
          "origin": "local",
          "auditVerdict": null,
          "verifiedAuthorGithubUserId": null,
          "createdAt": "2026-10-14T04:16:02.448Z",
          "updatedAt": "2026-11-06T17:40:29.047Z",
          "closedAt": null
        }
      },
      "originalLedgerRow": {
        "id": "WI-6554700010011852",
        "source": "/mnt/data/papercusp-audit-inputs/c52-r1-frozen-20261106T1917Z/WI-6554700010011852.json",
        "sourceSha256": "20e7a5276ef05ae06e09341e6cbca0c57d20f4d393fd86ac1ffad44b83391919",
        "manifestSha256": "75f699e3073a53df71db467214e8d3271ab3df35aca42fd3a5dcd1918f9af1ad",
        "state": "blocked",
        "rowAgeSecondsAtSnapshot": 2041207.180262,
        "rawRestrictionVerdict": {
          "id": "WI-6554700010011852",
          "admissible": false,
          "refusedBy": "not-claimable-status",
          "failedFloors": [
            "not-claimable-status",
            "live-gate-ops",
            "external-blocker",
            "claim-hold"
          ],
          "detail": "status is terminal or otherwise not in the claimable set"
        },
        "restrictions": [
          {
            "floor": "not-claimable-status",
            "stateProducerRecorded": null,
            "enteredAtRecorded": null,
            "ageSecondsAtSnapshot": null,
            "accountableClearerRecorded": null,
            "releaseConditionRecordedOrEvaluatorRule": "Canonical authorized state transition after all underlying restrictions are satisfied; status alone is not causal explanation.",
            "currentEvidence": {
              "state": "blocked",
              "updatedAt": "2026-11-06T17:40:29.047Z"
            },
            "verification": "unassessed; recorded values and evaluator rules do not establish legitimacy",
            "unknownFields": [
              "stateProducer",
              "enteredAt",
              "accountableClearer"
            ]
          },
          {
            "floor": "live-gate-ops",
            "stateProducerRecorded": null,
            "enteredAtRecorded": null,
            "ageSecondsAtSnapshot": null,
            "accountableClearerRecorded": null,
            "releaseConditionRecordedOrEvaluatorRule": "Registered live gate owner progresses this lane; no competing takeover or repeated gate status read.",
            "currentEvidence": {
              "scope": "LIVE_GATE_OPS",
              "status": "excluded from this investigation lane"
            },
            "verification": "unassessed; recorded values and evaluator rules do not establish legitimacy",
            "unknownFields": [
              "stateProducer",
              "enteredAt",
              "accountableClearer"
            ]
          },
          {
            "floor": "external-blocker",
            "stateProducerRecorded": [
              "su-14ff025a-1d44-47e2-89cd-5df18ab33d36"
            ],
            "enteredAtRecorded": "2026-10-15T05:17:12.139Z",
            "ageSecondsAtSnapshot": 1951137.489262,
            "accountableClearerRecorded": [
              "gate-red-streak:papercusp"
            ],
            "releaseConditionRecordedOrEvaluatorRule": [
              "Re-evaluate after the live gate owner releases gate-red-streak:papercusp."
            ],
            "currentEvidence": [
              {
                "ref": "gate-red-streak:papercusp",
                "kind": "gate",
                "status": "active",
                "summary": "Validation is complete, but current recovery status belongs to the live gate owner on WI-10006055.",
                "evidence": "state:read gate.greenCheckpoint.ownership assessed held-live by su-e2401292-7f65-4c44-b1db-a9ac4b47fc97; historical alert evidence and test results are saved in this item's checkpoint.",
                "nextVerb": "Re-evaluate after the live gate owner releases gate-red-streak:papercusp.",
                "createdAt": "2026-10-15T05:17:12.139Z",
                "createdBy": "su-14ff025a-1d44-47e2-89cd-5df18ab33d36",
                "recheckAt": "2026-11-06T18:30:34.724Z",
                "updatedAt": "2026-11-06T17:30:34.724Z",
                "capability": "live-dependency",
                "recheckedAt": "2026-11-06T17:30:34.724Z",
                "reachability": {
                  "basis": "unmeasured",
                  "verdict": "unknown",
                  "evidence": "trigger \"gate-red-streak:papercusp\" may wake a consumer but cannot establish the specific release condition; subject-bound evidence is required",
                  "checkedAt": "2026-11-06T17:40:25.197Z",
                  "authoritative": false,
                  "uncertifiedReason": "uncatalogued"
                },
                "recheckSource": "system:unprovable-wait-backfill",
                "capabilitySource": "explicit",
                "recheckDisposition": "escalated"
              }
            ],
            "verification": "unassessed; recorded values and evaluator rules do not establish legitimacy",
            "unknownFields": []
          },
          {
            "floor": "claim-hold",
            "stateProducerRecorded": "su-14ff025a-1d44-47e2-89cd-5df18ab33d36",
            "enteredAtRecorded": "2026-10-15T05:18:27.037Z",
            "ageSecondsAtSnapshot": 1951062.591262,
            "accountableClearerRecorded": "su-e2401292-7f65-4c44-b1db-a9ac4b47fc97",
            "releaseConditionRecordedOrEvaluatorRule": "WI-10006055 is complete; then re-check whether the live gate ownership has ended before resuming this alert.",
            "currentEvidence": {
              "claim_hold_at": "2026-10-15T05:18:27.037Z",
              "claim_hold_by": "su-14ff025a-1d44-47e2-89cd-5df18ab33d36",
              "claim_hold_reason": "Defer this historical alert until the current live gate work item completes.",
              "claim_hold_release": {
                "owner": "su-e2401292-7f65-4c44-b1db-a9ac4b47fc97",
                "trigger": "work-item:done:WI-10006055",
                "evidence": "a live resolver or producer registration can still satisfy the condition",
                "condition": "WI-10006055 is complete; then re-check whether the live gate ownership has ended before resuming this alert.",
                "reachability": "reachable"
              }
            },
            "verification": "unassessed; recorded values and evaluator rules do not establish legitimacy",
            "unknownFields": [],
            "writerProvenanceVerification": {
              "sourceRules": "work-items.ts:setWorkItemClaimHold and work-items-admission-promoter.ts:qualifiedAgentPark; corroboration grants no release authority",
              "checks": [
                {
                  "convention": "claim_hold",
                  "recordedActor": "su-14ff025a-1d44-47e2-89cd-5df18ab33d36",
                  "corroboratedCanonicalWriter": false,
                  "criteria": {
                    "latestIsCanonicalSet": false,
                    "auditActorMatches": false,
                    "modeMatches": false,
                    "byMatches": false,
                    "reasonMatches": false,
                    "timestampMatches": false,
                    "releaseContractMatches": false
                  },
                  "auditId": "wi-claim-hold-reclaimStaleHoldOpens-mvmhgb2d-aqjk4k",
                  "notProven": [
                    "current actor authority",
                    "legitimacy of underlying reason",
                    "truth of arbitrary release condition",
                    "clearance",
                    "execution"
                  ]
                }
              ],
              "noConventionRecorded": false
            }
          }
        ],
        "controlEvidence": {
          "implementationReadiness": {
            "reason": "no-acceptance-evidence-at-creation",
            "source": "creation-enrollment",
            "status": "unknown",
            "updatedAt": "2026-10-14T04:16:02.448Z",
            "schemaVersion": "implementation-readiness-v1"
          },
          "_claimHold": true,
          "claim_hold_at": "2026-10-15T05:18:27.037Z",
          "claim_hold_by": "su-14ff025a-1d44-47e2-89cd-5df18ab33d36",
          "claim_hold_reason": "Defer this historical alert until the current live gate work item completes.",
          "claim_hold_release": {
            "owner": "su-e2401292-7f65-4c44-b1db-a9ac4b47fc97",
            "trigger": "work-item:done:WI-10006055",
            "evidence": "a live resolver or producer registration can still satisfy the condition",
            "condition": "WI-10006055 is complete; then re-check whether the live gate ownership has ended before resuming this alert.",
            "reachability": "reachable"
          },
          "externalBlockers": [
            {
              "ref": "gate-red-streak:papercusp",
              "kind": "gate",
              "status": "active",
              "summary": "Validation is complete, but current recovery status belongs to the live gate owner on WI-10006055.",
              "evidence": "state:read gate.greenCheckpoint.ownership assessed held-live by su-e2401292-7f65-4c44-b1db-a9ac4b47fc97; historical alert evidence and test results are saved in this item's checkpoint.",
              "nextVerb": "Re-evaluate after the live gate owner releases gate-red-streak:papercusp.",
              "createdAt": "2026-10-15T05:17:12.139Z",
              "createdBy": "su-14ff025a-1d44-47e2-89cd-5df18ab33d36",
              "recheckAt": "2026-11-06T18:30:34.724Z",
              "updatedAt": "2026-11-06T17:30:34.724Z",
              "capability": "live-dependency",
              "recheckedAt": "2026-11-06T17:30:34.724Z",
              "reachability": {
                "basis": "unmeasured",
                "verdict": "unknown",
                "evidence": "trigger \"gate-red-streak:papercusp\" may wake a consumer but cannot establish the specific release condition; subject-bound evidence is required",
                "checkedAt": "2026-11-06T17:40:25.197Z",
                "authoritative": false,
                "uncertifiedReason": "uncatalogued"
              },
              "recheckSource": "system:unprovable-wait-backfill",
              "capabilitySource": "explicit",
              "recheckDisposition": "escalated"
            }
          ],
          "reporter": {
            "at": "2026-10-14T04:16:02.448Z",
            "id": null,
            "kind": "watchdog",
            "basis": "no-session"
          },
          "freshnessEnvelope": {
            "observedAt": "2026-10-14T04:16:02.448Z",
            "linkedFixRefs": [],
            "reporterSession": null,
            "observedSourceSha": "ae615f5fa9",
            "toolSchemaVersion": null,
            "observedRuntimeSha": "ae615f5fa9",
            "deployBuildIdentity": "ae615f5fa9@0.0.0",
            "reporterRuntimeVersion": "0.0.0",
            "lastSuccessfulReproductionAt": null
          }
        },
        "accountableInvestigator": "su-c52a1707-13f5-4080-870b-f7143c271d73",
        "disposition": "unassessed",
        "legitimateException": null,
        "executionEvidence": null,
        "remainingVerification": [
          "Actual source writer and recorded producer",
          "Restriction evidence, age, accountable authorized clearer and exact release condition",
          "Legitimacy or false-restriction repair",
          "Same-ID execution or explicit Avi disposition"
        ],
        "schemaVersion": "luna-r1-causal-evidence-ledger-v4",
        "sourceQualification": {
          "status": "clearance mechanisms mapped; row-specific causal/legitimacy verification remains open",
          "registry": "/home/marsh-office/.papercusp/evidence/c52-luna-r1-20261106/restriction-authority-registry-v1.json",
          "registrySha256": "1b51f4be4a288749652dfaf9f7c7d4547aae962dd0d33a798f8e729f9e49dfbe",
          "floorMappings": [
            {
              "floor": "not-claimable-status",
              "mechanismRef": "/home/marsh-office/.papercusp/evidence/c52-luna-r1-20261106/restriction-authority-registry-v1.json#/floors/not-claimable-status",
              "rowVerification": "unassessed",
              "requiredRowEvidence": [
                "state-transition history",
                "underlying restrictions",
                "current assignment and plan controls"
              ]
            },
            {
              "floor": "live-gate-ops",
              "mechanismRef": "/home/marsh-office/.papercusp/evidence/c52-luna-r1-20261106/restriction-authority-registry-v1.json#/floors/live-gate-ops",
              "rowVerification": "unassessed",
              "requiredRowEvidence": [
                "exact condition_key",
                "condition producer",
                "registered ownership evidence supplied by that lane"
              ]
            },
            {
              "floor": "external-blocker",
              "mechanismRef": "/home/marsh-office/.papercusp/evidence/c52-luna-r1-20261106/restriction-authority-registry-v1.json#/floors/external-blocker",
              "rowVerification": "unassessed",
              "requiredRowEvidence": [
                "every active entry",
                "kind and capability",
                "actual condition evidence",
                "authenticated accountable clearer",
                "canonical settlement receipt"
              ],
              "capabilityRoutes": [
                {
                  "ref": "gate-red-streak:papercusp",
                  "kind": "gate",
                  "capability": "live-dependency",
                  "resolutionRoleFromCurrentSource": "dependency-owner",
                  "recordedCreator": "su-14ff025a-1d44-47e2-89cd-5df18ab33d36",
                  "namedAuthorizedClearer": null,
                  "authorityVerified": false
                }
              ],
              "v1AccountableClearerFieldCaution": "v1 extracted blocker ref values, which name resources/conditions and are not authenticated named clearers"
            },
            {
              "floor": "claim-hold",
              "mechanismRef": "/home/marsh-office/.papercusp/evidence/c52-luna-r1-20261106/restriction-authority-registry-v1.json#/floors/claim-hold",
              "rowVerification": "unassessed",
              "requiredRowEvidence": [
                "both provenance conventions",
                "typed release contract or precise legacy condition",
                "condition-specific proof",
                "current assignment/fingerprint",
                "owner authority if required"
              ],
              "recordedReleaseContractOwner": "su-e2401292-7f65-4c44-b1db-a9ac4b47fc97",
              "recordedLeaseHolder": null,
              "recordedParker": "su-14ff025a-1d44-47e2-89cd-5df18ab33d36",
              "authorityVerified": false
            }
          ]
        },
        "postFreezeControlContext": {
          "artifact": "/home/marsh-office/.papercusp/evidence/c52-luna-r1-20261106/live-control-enrichment-20261106T1950Z-v2.json",
          "observedAt": "2026-11-06 19:48:21.753008+00",
          "record": {
            "id": "WI-6554700010011852",
            "state": "blocked",
            "harness": "papercusp",
            "takenAt": null,
            "takenBy": null,
            "admission": "auto",
            "createdAt": 1791951362448,
            "updatedAt": 1793986829047,
            "admittedAt": "2026-10-14T04:16:02.448+00:00",
            "admittedBy": "bypass:condition-key",
            "duplicateOf": null,
            "conditionKey": "alarm:green-main-slo:%5B%22papercusp-workspace%22%2C%22papercusp%22%2C%22queue-idle%22%2C%22green-main-slo%3Apapercusp%3Aqueue-idle%3A4a0ab75652bda2698d296eee96aa340f0eb3a620%3A1791947705172%22%2C%224a0ab75652bda2698d296eee96aa340f0eb3a620%22%5D",
            "holderPresence": null,
            "sourcePlanSlug": null,
            "sourcePlanItemIds": null
          },
          "limitations": [
            "Presence absence does not establish holder death or authorize release",
            "Current terminal state alone does not prove execution",
            "Admission values are current post-freeze evidence; historical producer/state-transition audit still required"
          ]
        },
        "postFreezeDependencyContext": {
          "artifact": "/home/marsh-office/.papercusp/evidence/c52-luna-r1-20261106/dependency-enrichment-20261106T1930Z.json",
          "observedAt": "2026-11-06T19:26:36.952682Z",
          "edges": [],
          "coverage": "not queried by this enrichment; empty list is not absence evidence"
        },
        "historicalAuditEvidence": {
          "artifact": "/home/marsh-office/.papercusp/evidence/c52-luna-r1-20261106/historical-audit-enrichment-20261106T2010Z.json",
          "sha256": "4b396df0818120147036644a9e33893170b4d271e5a5fd1a87e0e720a9884410",
          "recordPointer": "/queryResult/rows/0/items/5851",
          "observedAt": "2026-11-06 20:03:09.124326+00",
          "eventCutoffMs": 1793992569628,
          "eventCount": 4,
          "coverage": "Available work_items:% audit only; empty is not no-transition proof; nonterminal changes and some needs-human changes are undated."
        }
      },
      "savedNovember7Qualification": {
        "schemaVersion": "luna-r1-causal-qualification-v1",
        "id": "WI-6554700010011852",
        "sourceLedger": {
          "path": "/home/marsh-office/.papercusp/evidence/c52-luna-r1-20261106/causal-ledger-v4.jsonl",
          "sha256": "7f1962fb5c22f1bc2be9625406b315f6b5f4fd190b4743d7f972a4fb2c935866",
          "rowSourceSha256": "20e7a5276ef05ae06e09341e6cbca0c57d20f4d393fd86ac1ffad44b83391919"
        },
        "frozenState": "blocked",
        "frozenFloors": [
          "claim-hold",
          "external-blocker",
          "live-gate-ops",
          "not-claimable-status"
        ],
        "currentControlObservedAt": "2026-11-07 11:32:12.960427-05",
        "currentState": "blocked",
        "currentHolder": null,
        "currentFloorVerdict": {
          "id": "WI-6554700010011852",
          "admissible": false,
          "refusedBy": "not-claimable-status",
          "failedFloors": [
            "not-claimable-status",
            "live-gate-ops",
            "external-blocker",
            "claim-hold"
          ],
          "detail": "status is terminal or otherwise not in the claimable set"
        },
        "floorDifference": {
          "noLongerObserved": [],
          "newlyObserved": []
        },
        "adoptionQualification": null,
        "parkQualification": {
          "artifact": ".papercusp/evidence/c52-luna-r1-20261106/current-park-qualification-20261107T1715Z.json",
          "controlSnapshotAt": "2026-11-07 11:32:12.960427-05",
          "measuredAt": "2026-11-07T17:28:40.647Z",
          "qualificationAsMeasured": "reachable",
          "certification": "reachability-only; underlying release condition and clearer authority unverified"
        },
        "disposition": "unassessed",
        "executionEvidence": null,
        "nextActions": [
          "preserve park; qualify its exact condition and authorized clearer, with no automatic release from reachability"
        ],
        "limits": [
          "separately dated observations; not an immutable current-state snapshot",
          "a correct floor or release path does not prove underlying legitimacy",
          "adoption eligibility is report revision, not permission to implement"
        ]
      },
      "savedNovember8": {
        "observedAt": "2026-11-08 15:02:23.578069+00",
        "batch": 14,
        "recordPointer": "/rows/0/items/251",
        "rawProjectedRecord": {
          "id": "WI-6554700010011852",
          "state": "blocked",
          "holder": null,
          "control": {
            "_claimHold": true,
            "claim_hold_at": "2026-10-15T05:18:27.037Z",
            "claim_hold_by": "su-14ff025a-1d44-47e2-89cd-5df18ab33d36",
            "externalBlockers": [
              {
                "ref": "gate-red-streak:papercusp",
                "kind": "gate",
                "status": "active",
                "summary": "Validation is complete, but current recovery status belongs to the live gate owner on WI-10006055.",
                "evidence": "state:read gate.greenCheckpoint.ownership assessed held-live by su-e2401292-7f65-4c44-b1db-a9ac4b47fc97; historical alert evidence and test results are saved in this item's checkpoint.",
                "nextVerb": "Re-evaluate after the live gate owner releases gate-red-streak:papercusp.",
                "createdAt": "2026-10-15T05:17:12.139Z",
                "createdBy": "su-14ff025a-1d44-47e2-89cd-5df18ab33d36",
                "recheckAt": "2026-11-08T14:28:35.618Z",
                "updatedAt": "2026-11-08T13:28:35.618Z",
                "capability": "live-dependency",
                "recheckedAt": "2026-11-08T13:28:35.618Z",
                "reachability": {
                  "basis": "unmeasured",
                  "verdict": "unknown",
                  "evidence": "trigger \"gate-red-streak:papercusp\" may wake a consumer but cannot establish the specific release condition; subject-bound evidence is required",
                  "checkedAt": "2026-11-08T13:28:49.390Z",
                  "authoritative": false,
                  "uncertifiedReason": "uncatalogued"
                },
                "recheckSource": "system:unprovable-wait-backfill",
                "capabilitySource": "explicit",
                "recheckDisposition": "escalated"
              }
            ],
            "claim_hold_reason": "Defer this historical alert until the current live gate work item completes.",
            "claim_hold_release": {
              "owner": "su-e2401292-7f65-4c44-b1db-a9ac4b47fc97",
              "trigger": "work-item:done:WI-10006055",
              "evidence": "a live resolver or producer registration can still satisfy the condition",
              "condition": "WI-10006055 is complete; then re-check whether the live gate ownership has ended before resuming this alert.",
              "reachability": "reachable"
            },
            "implementationReadiness": {
              "reason": "no-acceptance-evidence-at-creation",
              "source": "creation-enrollment",
              "status": "unknown",
              "updatedAt": "2026-10-14T04:16:02.448Z",
              "schemaVersion": "implementation-readiness-v1"
            }
          },
          "takenAt": null,
          "admission": "auto",
          "updatedAt": 1794144529680,
          "admittedAt": "2026-10-14T04:16:02.448+00:00",
          "admittedBy": "bypass:condition-key",
          "sourcePlan": null,
          "duplicateOf": null,
          "sourceItems": null,
          "conditionKey": "alarm:green-main-slo:%5B%22papercusp-workspace%22%2C%22papercusp%22%2C%22queue-idle%22%2C%22green-main-slo%3Apapercusp%3Aqueue-idle%3A4a0ab75652bda2698d296eee96aa340f0eb3a620%3A1791947705172%22%2C%224a0ab75652bda2698d296eee96aa340f0eb3a620%22%5D",
          "stateChangedAt": "2026-10-15T05:17:12.726689+00:00"
        }
      },
      "reconciliation": {
        "id": "WI-6554700010011852",
        "frozenSourceSha256": "20e7a5276ef05ae06e09341e6cbca0c57d20f4d393fd86ac1ffad44b83391919",
        "frozenState": "blocked",
        "frozenFloors": [
          "not-claimable-status",
          "live-gate-ops",
          "external-blocker",
          "claim-hold"
        ],
        "priorDisposition": "unassessed",
        "currentBatch": 14,
        "currentState": "blocked",
        "currentHolder": null,
        "currentAdmission": "auto",
        "currentControlKeys": [
          "_claimHold",
          "claim_hold_at",
          "claim_hold_by",
          "claim_hold_reason",
          "claim_hold_release",
          "externalBlockers",
          "implementationReadiness"
        ],
        "changedProjectedControlKeys": [
          "externalBlockers"
        ],
        "unmeasuredFrozenControlKeys": [
          "freshnessEnvelope",
          "reporter"
        ],
        "assessment": "condition-and-clearer-legitimacy-unresolved",
        "finalR1Disposition": "unresolved"
      },
      "conditionIdentity": {
        "key": "alarm:green-main-slo:%5B%22papercusp-workspace%22%2C%22papercusp%22%2C%22queue-idle%22%2C%22green-main-slo%3Apapercusp%3Aqueue-idle%3A4a0ab75652bda2698d296eee96aa340f0eb3a620%3A1791947705172%22%2C%224a0ab75652bda2698d296eee96aa340f0eb3a620%22%5D",
        "decodedWorkspaceInstallMetricEpisodeSubject": [
          "papercusp-workspace",
          "papercusp",
          "queue-idle",
          "green-main-slo:papercusp:queue-idle:4a0ab75652bda2698d296eee96aa340f0eb3a620:1791947705172",
          "4a0ab75652bda2698d296eee96aa340f0eb3a620"
        ],
        "datedPostFreezeKeyEqual": true,
        "frozenRawExportOmitsConditionKey": true,
        "historicalFrozenKeyUnproven": true
      },
      "sourceConditionedReservation": "The saved exact metric-slot key matches the witnessed current self-select reservation. The SQL floor depends on condition_key, not current gate ownership or holder liveness. No historical loaded-source identity is asserted.",
      "clearerQualification": {
        "conditionProducer": "greenMainSloConditionKey/runGreenMainSloPass source witness; historical emission not read",
        "conditionResolver": "Existing watchdog: measuredRecovery or explicitlySupersededByNewQueue, with distinct resolution summary. Supersession is not measured recovery or a durable fix.",
        "manualParkReleaseContract": {
          "owner": "su-e2401292-7f65-4c44-b1db-a9ac4b47fc97",
          "trigger": "work-item:done:WI-10006055",
          "evidence": "a live resolver or producer registration can still satisfy the condition",
          "condition": "WI-10006055 is complete; then re-check whether the live gate ownership has ended before resuming this alert.",
          "reachability": "reachable"
        },
        "recordedReleaseOwner": "su-e2401292-7f65-4c44-b1db-a9ac4b47fc97",
        "currentAuthenticatedNamedClearer": null,
        "currentGateOwnership": "UNMEASURED; intentionally not queried",
        "triggerLimit": "Gate-item completion or release:green is a wake/recheck trigger, not exact episode recovery or park clearance proof.",
        "independentControls": "Self-select reservation, durable park, external blocker, review/readiness and lifecycle guards remain separate."
      },
      "executionQualification": "No new execution or original-scope fix demonstrated. Saved state and missing holder do not authorize claim, release or monitoring.",
      "finalR1Disposition": "UNRESOLVED: historical condition truth/source identity, legitimate exception, current named authenticated authority and original-scope execution."
    },
    {
      "id": "WI-6554700010013731",
      "frozenSource": {
        "path": "/mnt/data/papercusp-audit-inputs/c52-r1-frozen-20261106T1917Z/WI-6554700010013731.json",
        "sha256": "14345e05743859a35672c0d0cf614619341e52cda186514ebb3d4103b38527b5",
        "raw": {
          "id": "WI-6554700010013731",
          "kind": "bug",
          "family": "issue",
          "harness": "papercusp",
          "title": "[alarm:green-main-slo:%5B%22papercusp-workspace%22%2C%22papercusp%22%2C%22red-adding-admission%22%2C%22green-main-slo%3Apapercusp%3Ared-adding-admission%3A55bbd",
          "summary": "Owning work-item for condition 'alarm:green-main-slo:%5B%22papercusp-workspace%22%2C%22papercusp%22%2C%22red-adding-admission%22%2C%22green-main-slo%3Apapercusp%3Ared-adding-admission%3A55bbd12ce1686d8e722b5a733f5a68783f40b08d%22%2C%224a0ab75652bda2698d296eee96aa340f0eb3a620%22%5D', minted by the condition bridge (P-003, gate-ownership-condition-singleton-2026-08-03). This item is the SINGLETON for this condition — the partial unique index on work_items.condition_key guarantees at most one open owner, so claim THIS rather than filing another.\n\nLatest alarm: An admission added red on papercusp\nFirst seen: 2026-10-14T00:00:47.847Z · open since: 2026-10-14T00:00:47.847Z · alarms: 1\n\nLatest alarm detail (from the emitter):\nThe round after admitting 55bbd12ce168 recorded more failures than the round before it.\n\n— emitted by pid 265266, process started 2026-10-13T22:25:16.640Z (up 1h35m), cwd /home/marsh-office/papercupai-workspace/papercusp/apps/operator. If that start time PREDATES the fix you are checking, this process never loaded it (no hot-reload) and no deploy will reach it — restart that host instead of re-investigating the alarm.",
          "state": "open",
          "assignee": null,
          "takenAt": null,
          "lastProgressAt": "2026-10-26T17:56:44.423Z",
          "assignedBy": null,
          "createdBy": null,
          "severity": "major",
          "goalId": null,
          "tags": null,
          "sourcePlanSlug": null,
          "sourcePlanItemIds": null,
          "redundancy": null,
          "expectedCostCents": null,
          "parent": null,
          "payload": {
            "_ei": {
              "scope": "harness:papercusp",
              "source": "engineer",
              "severity": "major",
              "signal_origin": "organic"
            },
            "_bridge": {
              "mintedAt": "2026-10-15T00:45:15.530Z",
              "conditionKey": "alarm:green-main-slo:%5B%22papercusp-workspace%22%2C%22papercusp%22%2C%22red-adding-admission%22%2C%22green-main-slo%3Apapercusp%3Ared-adding-admission%3A55bbd12ce1686d8e722b5a733f5a68783f40b08d%22%2C%224a0ab75652bda2698d296eee96aa340f0eb3a620%22%5D"
            },
            "reporter": {
              "at": "2026-10-15T00:45:15.532Z",
              "id": null,
              "kind": "watchdog",
              "basis": "no-session"
            },
            "_claimHold": true,
            "claim_hold_at": "2026-10-26T17:57:44.584Z",
            "claim_hold_by": "su-6d150181-7b35-4d8e-83c0-d40f015bfeae",
            "reporterKinds": [
              "watchdog"
            ],
            "claim_hold_reason": "This alarm is LIVE_GATE_OPS currently owned by a different live agent. Keep it out of scheduler self-select until the owning gate work item reaches terminal state and a leader can re-check ownership.",
            "freshnessEnvelope": {
              "observedAt": "2026-10-15T00:45:15.532Z",
              "linkedFixRefs": [],
              "reporterSession": null,
              "observedSourceSha": "64e2490304",
              "toolSchemaVersion": null,
              "observedRuntimeSha": "64e2490304",
              "deployBuildIdentity": "64e2490304@0.0.1",
              "reporterRuntimeVersion": "0.0.1",
              "lastSuccessfulReproductionAt": null
            },
            "claim_hold_release": {
              "owner": "su-a763c3ee-8f2a-4ed8-8a89-f71cc40aca07",
              "trigger": "work-item:done:WI-10006055",
              "evidence": "a live resolver or producer registration can still satisfy the condition",
              "condition": "gate.greenCheckpoint.ownership is no longer held by su-a763c3ee-8f2a-4ed8-8a89-f71cc40aca07 on WI-10006055; then re-evaluate this alarm under the current gate owner.",
              "reachability": "reachable"
            },
            "claim_history_post_id": 9001788375295,
            "implementationReadiness": {
              "reason": "no-acceptance-evidence-at-creation",
              "source": "creation-enrollment",
              "status": "unknown",
              "updatedAt": "2026-10-15T00:45:15.532Z",
              "schemaVersion": "implementation-readiness-v1"
            }
          },
          "definition": null,
          "rank": null,
          "rankWriter": null,
          "rankUpdatedAt": null,
          "priority": null,
          "terminalOwner": null,
          "terminalCompletionRef": null,
          "terminalCompletionEvidence": null,
          "completionAuthority": null,
          "origin": "local",
          "auditVerdict": null,
          "verifiedAuthorGithubUserId": null,
          "createdAt": "2026-10-15T00:45:15.532Z",
          "updatedAt": "2026-10-26T17:57:44.584Z",
          "closedAt": null
        }
      },
      "originalLedgerRow": {
        "id": "WI-6554700010013731",
        "source": "/mnt/data/papercusp-audit-inputs/c52-r1-frozen-20261106T1917Z/WI-6554700010013731.json",
        "sourceSha256": "14345e05743859a35672c0d0cf614619341e52cda186514ebb3d4103b38527b5",
        "manifestSha256": "75f699e3073a53df71db467214e8d3271ab3df35aca42fd3a5dcd1918f9af1ad",
        "state": "open",
        "rowAgeSecondsAtSnapshot": 1967454.096262,
        "rawRestrictionVerdict": {
          "id": "WI-6554700010013731",
          "admissible": false,
          "refusedBy": "live-gate-ops",
          "failedFloors": [
            "live-gate-ops",
            "claim-hold"
          ],
          "detail": "LIVE_GATE_OPS condition (gate-red-streak: or green-stall: singleton, or an alarm:green-main-slo: time-since-green/time-since-verdict/red-adding-admission/round-cycle-time/queue-idle alarm) — reserved to the one registered live gate fixer and excluded from opportunistic self-select. A leader/owner may still dispatch or claim it BY ID after checking gate.greenCheckpoint.ownership."
        },
        "restrictions": [
          {
            "floor": "live-gate-ops",
            "stateProducerRecorded": null,
            "enteredAtRecorded": null,
            "ageSecondsAtSnapshot": null,
            "accountableClearerRecorded": null,
            "releaseConditionRecordedOrEvaluatorRule": "Registered live gate owner progresses this lane; no competing takeover or repeated gate status read.",
            "currentEvidence": {
              "scope": "LIVE_GATE_OPS",
              "status": "excluded from this investigation lane"
            },
            "verification": "unassessed; recorded values and evaluator rules do not establish legitimacy",
            "unknownFields": [
              "stateProducer",
              "enteredAt",
              "accountableClearer"
            ]
          },
          {
            "floor": "claim-hold",
            "stateProducerRecorded": "su-6d150181-7b35-4d8e-83c0-d40f015bfeae",
            "enteredAtRecorded": "2026-10-26T17:57:44.584Z",
            "ageSecondsAtSnapshot": 955105.044262,
            "accountableClearerRecorded": "su-a763c3ee-8f2a-4ed8-8a89-f71cc40aca07",
            "releaseConditionRecordedOrEvaluatorRule": "gate.greenCheckpoint.ownership is no longer held by su-a763c3ee-8f2a-4ed8-8a89-f71cc40aca07 on WI-10006055; then re-evaluate this alarm under the current gate owner.",
            "currentEvidence": {
              "claim_hold_at": "2026-10-26T17:57:44.584Z",
              "claim_hold_by": "su-6d150181-7b35-4d8e-83c0-d40f015bfeae",
              "claim_hold_reason": "This alarm is LIVE_GATE_OPS currently owned by a different live agent. Keep it out of scheduler self-select until the owning gate work item reaches terminal state and a leader can re-check ownership.",
              "claim_hold_release": {
                "owner": "su-a763c3ee-8f2a-4ed8-8a89-f71cc40aca07",
                "trigger": "work-item:done:WI-10006055",
                "evidence": "a live resolver or producer registration can still satisfy the condition",
                "condition": "gate.greenCheckpoint.ownership is no longer held by su-a763c3ee-8f2a-4ed8-8a89-f71cc40aca07 on WI-10006055; then re-evaluate this alarm under the current gate owner.",
                "reachability": "reachable"
              }
            },
            "verification": "unassessed; recorded values and evaluator rules do not establish legitimacy",
            "unknownFields": [],
            "writerProvenanceVerification": {
              "sourceRules": "work-items.ts:setWorkItemClaimHold and work-items-admission-promoter.ts:qualifiedAgentPark; corroboration grants no release authority",
              "checks": [
                {
                  "convention": "claim_hold",
                  "recordedActor": "su-6d150181-7b35-4d8e-83c0-d40f015bfeae",
                  "corroboratedCanonicalWriter": true,
                  "criteria": {
                    "latestIsCanonicalSet": true,
                    "auditActorMatches": true,
                    "modeMatches": true,
                    "byMatches": true,
                    "reasonMatches": true,
                    "timestampMatches": true,
                    "releaseContractMatches": true
                  },
                  "auditId": "wi-claim-hold-mvpk7m6s-v8qr5q",
                  "notProven": [
                    "current actor authority",
                    "legitimacy of underlying reason",
                    "truth of arbitrary release condition",
                    "clearance",
                    "execution"
                  ]
                }
              ],
              "noConventionRecorded": false
            }
          }
        ],
        "controlEvidence": {
          "implementationReadiness": {
            "reason": "no-acceptance-evidence-at-creation",
            "source": "creation-enrollment",
            "status": "unknown",
            "updatedAt": "2026-10-15T00:45:15.532Z",
            "schemaVersion": "implementation-readiness-v1"
          },
          "_claimHold": true,
          "claim_hold_at": "2026-10-26T17:57:44.584Z",
          "claim_hold_by": "su-6d150181-7b35-4d8e-83c0-d40f015bfeae",
          "claim_hold_reason": "This alarm is LIVE_GATE_OPS currently owned by a different live agent. Keep it out of scheduler self-select until the owning gate work item reaches terminal state and a leader can re-check ownership.",
          "claim_hold_release": {
            "owner": "su-a763c3ee-8f2a-4ed8-8a89-f71cc40aca07",
            "trigger": "work-item:done:WI-10006055",
            "evidence": "a live resolver or producer registration can still satisfy the condition",
            "condition": "gate.greenCheckpoint.ownership is no longer held by su-a763c3ee-8f2a-4ed8-8a89-f71cc40aca07 on WI-10006055; then re-evaluate this alarm under the current gate owner.",
            "reachability": "reachable"
          },
          "reporter": {
            "at": "2026-10-15T00:45:15.532Z",
            "id": null,
            "kind": "watchdog",
            "basis": "no-session"
          },
          "freshnessEnvelope": {
            "observedAt": "2026-10-15T00:45:15.532Z",
            "linkedFixRefs": [],
            "reporterSession": null,
            "observedSourceSha": "64e2490304",
            "toolSchemaVersion": null,
            "observedRuntimeSha": "64e2490304",
            "deployBuildIdentity": "64e2490304@0.0.1",
            "reporterRuntimeVersion": "0.0.1",
            "lastSuccessfulReproductionAt": null
          }
        },
        "accountableInvestigator": "su-c52a1707-13f5-4080-870b-f7143c271d73",
        "disposition": "unassessed",
        "legitimateException": null,
        "executionEvidence": null,
        "remainingVerification": [
          "Actual source writer and recorded producer",
          "Restriction evidence, age, accountable authorized clearer and exact release condition",
          "Legitimacy or false-restriction repair",
          "Same-ID execution or explicit Avi disposition"
        ],
        "schemaVersion": "luna-r1-causal-evidence-ledger-v4",
        "sourceQualification": {
          "status": "clearance mechanisms mapped; row-specific causal/legitimacy verification remains open",
          "registry": "/home/marsh-office/.papercusp/evidence/c52-luna-r1-20261106/restriction-authority-registry-v1.json",
          "registrySha256": "1b51f4be4a288749652dfaf9f7c7d4547aae962dd0d33a798f8e729f9e49dfbe",
          "floorMappings": [
            {
              "floor": "live-gate-ops",
              "mechanismRef": "/home/marsh-office/.papercusp/evidence/c52-luna-r1-20261106/restriction-authority-registry-v1.json#/floors/live-gate-ops",
              "rowVerification": "unassessed",
              "requiredRowEvidence": [
                "exact condition_key",
                "condition producer",
                "registered ownership evidence supplied by that lane"
              ]
            },
            {
              "floor": "claim-hold",
              "mechanismRef": "/home/marsh-office/.papercusp/evidence/c52-luna-r1-20261106/restriction-authority-registry-v1.json#/floors/claim-hold",
              "rowVerification": "unassessed",
              "requiredRowEvidence": [
                "both provenance conventions",
                "typed release contract or precise legacy condition",
                "condition-specific proof",
                "current assignment/fingerprint",
                "owner authority if required"
              ],
              "recordedReleaseContractOwner": "su-a763c3ee-8f2a-4ed8-8a89-f71cc40aca07",
              "recordedLeaseHolder": null,
              "recordedParker": "su-6d150181-7b35-4d8e-83c0-d40f015bfeae",
              "authorityVerified": false
            }
          ]
        },
        "postFreezeControlContext": {
          "artifact": "/home/marsh-office/.papercusp/evidence/c52-luna-r1-20261106/live-control-enrichment-20261106T1950Z-v2.json",
          "observedAt": "2026-11-06 19:48:21.753008+00",
          "record": {
            "id": "WI-6554700010013731",
            "state": "open",
            "harness": "papercusp",
            "takenAt": null,
            "takenBy": null,
            "admission": "auto",
            "createdAt": 1792025115532,
            "updatedAt": 1793037464584,
            "admittedAt": "2026-10-15T00:45:15.532+00:00",
            "admittedBy": "bypass:condition-key",
            "duplicateOf": null,
            "conditionKey": "alarm:green-main-slo:%5B%22papercusp-workspace%22%2C%22papercusp%22%2C%22red-adding-admission%22%2C%22green-main-slo%3Apapercusp%3Ared-adding-admission%3A55bbd12ce1686d8e722b5a733f5a68783f40b08d%22%2C%224a0ab75652bda2698d296eee96aa340f0eb3a620%22%5D",
            "holderPresence": null,
            "sourcePlanSlug": null,
            "sourcePlanItemIds": null
          },
          "limitations": [
            "Presence absence does not establish holder death or authorize release",
            "Current terminal state alone does not prove execution",
            "Admission values are current post-freeze evidence; historical producer/state-transition audit still required"
          ]
        },
        "postFreezeDependencyContext": {
          "artifact": "/home/marsh-office/.papercusp/evidence/c52-luna-r1-20261106/dependency-enrichment-20261106T1930Z.json",
          "observedAt": "2026-11-06T19:26:36.952682Z",
          "edges": [],
          "coverage": "not queried by this enrichment; empty list is not absence evidence"
        },
        "historicalAuditEvidence": {
          "artifact": "/home/marsh-office/.papercusp/evidence/c52-luna-r1-20261106/historical-audit-enrichment-20261106T2010Z.json",
          "sha256": "4b396df0818120147036644a9e33893170b4d271e5a5fd1a87e0e720a9884410",
          "recordPointer": "/queryResult/rows/0/items/5877",
          "observedAt": "2026-11-06 20:03:09.124326+00",
          "eventCutoffMs": 1793992569628,
          "eventCount": 4,
          "coverage": "Available work_items:% audit only; empty is not no-transition proof; nonterminal changes and some needs-human changes are undated."
        }
      },
      "savedNovember7Qualification": {
        "schemaVersion": "luna-r1-causal-qualification-v1",
        "id": "WI-6554700010013731",
        "sourceLedger": {
          "path": "/home/marsh-office/.papercusp/evidence/c52-luna-r1-20261106/causal-ledger-v4.jsonl",
          "sha256": "7f1962fb5c22f1bc2be9625406b315f6b5f4fd190b4743d7f972a4fb2c935866",
          "rowSourceSha256": "14345e05743859a35672c0d0cf614619341e52cda186514ebb3d4103b38527b5"
        },
        "frozenState": "open",
        "frozenFloors": [
          "claim-hold",
          "live-gate-ops"
        ],
        "currentControlObservedAt": "2026-11-07 11:32:12.960427-05",
        "currentState": "open",
        "currentHolder": null,
        "currentFloorVerdict": {
          "id": "WI-6554700010013731",
          "admissible": false,
          "refusedBy": "live-gate-ops",
          "failedFloors": [
            "live-gate-ops",
            "claim-hold"
          ],
          "detail": "LIVE_GATE_OPS condition (gate-red-streak: or green-stall: singleton, or an alarm:green-main-slo: time-since-green/time-since-verdict/red-adding-admission/round-cycle-time/queue-idle alarm) — reserved to the one registered live gate fixer and excluded from opportunistic self-select. A leader/owner may still dispatch or claim it BY ID after checking gate.greenCheckpoint.ownership."
        },
        "floorDifference": {
          "noLongerObserved": [],
          "newlyObserved": []
        },
        "adoptionQualification": null,
        "parkQualification": {
          "artifact": ".papercusp/evidence/c52-luna-r1-20261106/current-park-qualification-20261107T1715Z.json",
          "controlSnapshotAt": "2026-11-07 11:32:12.960427-05",
          "measuredAt": "2026-11-07T17:28:43.120Z",
          "qualificationAsMeasured": "reachable",
          "certification": "reachability-only; underlying release condition and clearer authority unverified"
        },
        "disposition": "unassessed",
        "executionEvidence": null,
        "nextActions": [
          "preserve park; qualify its exact condition and authorized clearer, with no automatic release from reachability"
        ],
        "limits": [
          "separately dated observations; not an immutable current-state snapshot",
          "a correct floor or release path does not prove underlying legitimacy",
          "adoption eligibility is report revision, not permission to implement"
        ]
      },
      "savedNovember8": {
        "observedAt": "2026-11-08 15:02:23.578069+00",
        "batch": 14,
        "recordPointer": "/rows/0/items/277",
        "rawProjectedRecord": {
          "id": "WI-6554700010013731",
          "state": "open",
          "holder": null,
          "control": {
            "_claimHold": true,
            "claim_hold_at": "2026-10-26T17:57:44.584Z",
            "claim_hold_by": "su-6d150181-7b35-4d8e-83c0-d40f015bfeae",
            "claim_hold_reason": "This alarm is LIVE_GATE_OPS currently owned by a different live agent. Keep it out of scheduler self-select until the owning gate work item reaches terminal state and a leader can re-check ownership.",
            "claim_hold_release": {
              "owner": "su-a763c3ee-8f2a-4ed8-8a89-f71cc40aca07",
              "trigger": "work-item:done:WI-10006055",
              "evidence": "a live resolver or producer registration can still satisfy the condition",
              "condition": "gate.greenCheckpoint.ownership is no longer held by su-a763c3ee-8f2a-4ed8-8a89-f71cc40aca07 on WI-10006055; then re-evaluate this alarm under the current gate owner.",
              "reachability": "reachable"
            },
            "implementationReadiness": {
              "reason": "no-acceptance-evidence-at-creation",
              "source": "creation-enrollment",
              "status": "unknown",
              "updatedAt": "2026-10-15T00:45:15.532Z",
              "schemaVersion": "implementation-readiness-v1"
            }
          },
          "takenAt": null,
          "admission": "auto",
          "updatedAt": 1793037464584,
          "admittedAt": "2026-10-15T00:45:15.532+00:00",
          "admittedBy": "bypass:condition-key",
          "sourcePlan": null,
          "duplicateOf": null,
          "sourceItems": null,
          "conditionKey": "alarm:green-main-slo:%5B%22papercusp-workspace%22%2C%22papercusp%22%2C%22red-adding-admission%22%2C%22green-main-slo%3Apapercusp%3Ared-adding-admission%3A55bbd12ce1686d8e722b5a733f5a68783f40b08d%22%2C%224a0ab75652bda2698d296eee96aa340f0eb3a620%22%5D",
          "stateChangedAt": "2026-10-15T00:45:15.532+00:00"
        }
      },
      "reconciliation": {
        "id": "WI-6554700010013731",
        "frozenSourceSha256": "14345e05743859a35672c0d0cf614619341e52cda186514ebb3d4103b38527b5",
        "frozenState": "open",
        "frozenFloors": [
          "live-gate-ops",
          "claim-hold"
        ],
        "priorDisposition": "unassessed",
        "currentBatch": 14,
        "currentState": "open",
        "currentHolder": null,
        "currentAdmission": "auto",
        "currentControlKeys": [
          "_claimHold",
          "claim_hold_at",
          "claim_hold_by",
          "claim_hold_reason",
          "claim_hold_release",
          "implementationReadiness"
        ],
        "changedProjectedControlKeys": [],
        "unmeasuredFrozenControlKeys": [
          "freshnessEnvelope",
          "reporter"
        ],
        "assessment": "condition-and-clearer-legitimacy-unresolved",
        "finalR1Disposition": "unresolved"
      },
      "conditionIdentity": {
        "key": "alarm:green-main-slo:%5B%22papercusp-workspace%22%2C%22papercusp%22%2C%22red-adding-admission%22%2C%22green-main-slo%3Apapercusp%3Ared-adding-admission%3A55bbd12ce1686d8e722b5a733f5a68783f40b08d%22%2C%224a0ab75652bda2698d296eee96aa340f0eb3a620%22%5D",
        "decodedWorkspaceInstallMetricEpisodeSubject": [
          "papercusp-workspace",
          "papercusp",
          "red-adding-admission",
          "green-main-slo:papercusp:red-adding-admission:55bbd12ce1686d8e722b5a733f5a68783f40b08d",
          "4a0ab75652bda2698d296eee96aa340f0eb3a620"
        ],
        "datedPostFreezeKeyEqual": true,
        "frozenRawExportOmitsConditionKey": true,
        "historicalFrozenKeyUnproven": true
      },
      "sourceConditionedReservation": "The saved exact metric-slot key matches the witnessed current self-select reservation. The SQL floor depends on condition_key, not current gate ownership or holder liveness. No historical loaded-source identity is asserted.",
      "clearerQualification": {
        "conditionProducer": "greenMainSloConditionKey/runGreenMainSloPass source witness; historical emission not read",
        "conditionResolver": "Existing watchdog: measuredRecovery or explicitlySupersededByNewQueue, with distinct resolution summary. Supersession is not measured recovery or a durable fix.",
        "manualParkReleaseContract": {
          "owner": "su-a763c3ee-8f2a-4ed8-8a89-f71cc40aca07",
          "trigger": "work-item:done:WI-10006055",
          "evidence": "a live resolver or producer registration can still satisfy the condition",
          "condition": "gate.greenCheckpoint.ownership is no longer held by su-a763c3ee-8f2a-4ed8-8a89-f71cc40aca07 on WI-10006055; then re-evaluate this alarm under the current gate owner.",
          "reachability": "reachable"
        },
        "recordedReleaseOwner": "su-a763c3ee-8f2a-4ed8-8a89-f71cc40aca07",
        "currentAuthenticatedNamedClearer": null,
        "currentGateOwnership": "UNMEASURED; intentionally not queried",
        "triggerLimit": "Gate-item completion or release:green is a wake/recheck trigger, not exact episode recovery or park clearance proof.",
        "independentControls": "Self-select reservation, durable park, external blocker, review/readiness and lifecycle guards remain separate."
      },
      "executionQualification": "No new execution or original-scope fix demonstrated. Saved state and missing holder do not authorize claim, release or monitoring.",
      "finalR1Disposition": "UNRESOLVED: historical condition truth/source identity, legitimate exception, current named authenticated authority and original-scope execution."
    },
    {
      "id": "WI-6554700010014195",
      "frozenSource": {
        "path": "/mnt/data/papercusp-audit-inputs/c52-r1-frozen-20261106T1917Z/WI-6554700010014195.json",
        "sha256": "a75636329be06a26b4f948bb1bb817a9df7908a7f316c98c0f8db093565cb3c4",
        "raw": {
          "id": "WI-6554700010014195",
          "kind": "bug",
          "family": "issue",
          "harness": "papercusp",
          "title": "[alarm:green-main-slo:%5B%22papercusp-workspace%22%2C%22papercusp%22%2C%22time-since-verdict%22%2C%22green-main-slo%3Apapercusp%3Atime-since-verdict%3A179201769",
          "summary": "Owning work-item for condition 'alarm:green-main-slo:%5B%22papercusp-workspace%22%2C%22papercusp%22%2C%22time-since-verdict%22%2C%22green-main-slo%3Apapercusp%3Atime-since-verdict%3A1792017698698.211%22%2Cnull%5D', minted by the condition bridge (P-003, gate-ownership-condition-singleton-2026-08-03). This item is the SINGLETON for this condition — the partial unique index on work_items.condition_key guarantees at most one open owner, so claim THIS rather than filing another.\n\nLatest alarm: No gate verdict for 6.1h on papercusp\nFirst seen: 2026-10-15T04:45:44.898Z · open since: 2026-10-15T04:45:44.898Z · alarms: 1\n\nLatest alarm detail (from the emitter):\nThe gate has rendered no verdict (green or red) since 2026-10-14T22:41:38.698Z (SLO page at 6.0h).\n\n— emitted by pid 3054937, process started 2026-10-15T02:48:02.395Z (up 1h57m), cwd /home/marsh-office/papercupai-workspace/papercusp/apps/operator. If that start time PREDATES the fix you are checking, this process never loaded it (no hot-reload) and no deploy will reach it — restart that host instead of re-investigating the alarm.",
          "state": "open",
          "assignee": null,
          "takenAt": null,
          "lastProgressAt": null,
          "assignedBy": null,
          "createdBy": null,
          "severity": "major",
          "goalId": null,
          "tags": null,
          "sourcePlanSlug": null,
          "sourcePlanItemIds": null,
          "redundancy": null,
          "expectedCostCents": null,
          "parent": null,
          "payload": {
            "_ei": {
              "scope": "harness:papercusp",
              "source": "engineer",
              "severity": "major",
              "signal_origin": "organic"
            },
            "_bridge": {
              "mintedAt": "2026-10-15T04:50:05.841Z",
              "conditionKey": "alarm:green-main-slo:%5B%22papercusp-workspace%22%2C%22papercusp%22%2C%22time-since-verdict%22%2C%22green-main-slo%3Apapercusp%3Atime-since-verdict%3A1792017698698.211%22%2Cnull%5D"
            },
            "reporter": {
              "at": "2026-10-15T04:50:05.860Z",
              "id": null,
              "kind": "watchdog",
              "basis": "no-session"
            },
            "_claimHold": true,
            "claim_hold_at": "2026-10-16T01:44:57.919Z",
            "claim_hold_by": "su-d8505bfb-32a2-43d7-8a24-d16eb38ec994",
            "reporterKinds": [
              "watchdog"
            ],
            "claim_hold_reason": "Park this duplicate no-verdict alarm until the live gate owner finishes; prevent another member from self-selecting the same LIVE_GATE_OPS lane.",
            "freshnessEnvelope": {
              "observedAt": "2026-10-15T04:50:05.860Z",
              "linkedFixRefs": [],
              "reporterSession": null,
              "observedSourceSha": "7adab27b62",
              "toolSchemaVersion": null,
              "observedRuntimeSha": "7adab27b62",
              "deployBuildIdentity": "7adab27b62@0.0.0",
              "reporterRuntimeVersion": "0.0.0",
              "lastSuccessfulReproductionAt": null
            },
            "claim_hold_release": {
              "owner": "su-d6d37b55-374d-475a-b442-e9f4cceb94cb",
              "trigger": "work-item:done:WI-10006055",
              "evidence": "a live resolver or producer registration can still satisfy the condition",
              "condition": "WI-10006055 reaches a terminal state and the green-checkpoint ownership is released",
              "reachability": "reachable"
            },
            "claim_history_post_id": 9001788375295,
            "implementationReadiness": {
              "reason": "no-acceptance-evidence-at-creation",
              "source": "creation-enrollment",
              "status": "unknown",
              "updatedAt": "2026-10-15T04:50:05.860Z",
              "schemaVersion": "implementation-readiness-v1"
            }
          },
          "definition": null,
          "rank": null,
          "rankWriter": null,
          "rankUpdatedAt": null,
          "priority": null,
          "terminalOwner": null,
          "terminalCompletionRef": null,
          "terminalCompletionEvidence": null,
          "completionAuthority": null,
          "origin": "local",
          "auditVerdict": null,
          "verifiedAuthorGithubUserId": null,
          "createdAt": "2026-10-15T04:50:05.860Z",
          "updatedAt": "2026-10-16T01:44:57.920Z",
          "closedAt": null
        }
      },
      "originalLedgerRow": {
        "id": "WI-6554700010014195",
        "source": "/mnt/data/papercusp-audit-inputs/c52-r1-frozen-20261106T1917Z/WI-6554700010014195.json",
        "sourceSha256": "a75636329be06a26b4f948bb1bb817a9df7908a7f316c98c0f8db093565cb3c4",
        "manifestSha256": "75f699e3073a53df71db467214e8d3271ab3df35aca42fd3a5dcd1918f9af1ad",
        "state": "open",
        "rowAgeSecondsAtSnapshot": 1952763.768262,
        "rawRestrictionVerdict": {
          "id": "WI-6554700010014195",
          "admissible": false,
          "refusedBy": "live-gate-ops",
          "failedFloors": [
            "live-gate-ops",
            "claim-hold"
          ],
          "detail": "LIVE_GATE_OPS condition (gate-red-streak: or green-stall: singleton, or an alarm:green-main-slo: time-since-green/time-since-verdict/red-adding-admission/round-cycle-time/queue-idle alarm) — reserved to the one registered live gate fixer and excluded from opportunistic self-select. A leader/owner may still dispatch or claim it BY ID after checking gate.greenCheckpoint.ownership."
        },
        "restrictions": [
          {
            "floor": "live-gate-ops",
            "stateProducerRecorded": null,
            "enteredAtRecorded": null,
            "ageSecondsAtSnapshot": null,
            "accountableClearerRecorded": null,
            "releaseConditionRecordedOrEvaluatorRule": "Registered live gate owner progresses this lane; no competing takeover or repeated gate status read.",
            "currentEvidence": {
              "scope": "LIVE_GATE_OPS",
              "status": "excluded from this investigation lane"
            },
            "verification": "unassessed; recorded values and evaluator rules do not establish legitimacy",
            "unknownFields": [
              "stateProducer",
              "enteredAt",
              "accountableClearer"
            ]
          },
          {
            "floor": "claim-hold",
            "stateProducerRecorded": "su-d8505bfb-32a2-43d7-8a24-d16eb38ec994",
            "enteredAtRecorded": "2026-10-16T01:44:57.919Z",
            "ageSecondsAtSnapshot": 1877471.709262,
            "accountableClearerRecorded": "su-d6d37b55-374d-475a-b442-e9f4cceb94cb",
            "releaseConditionRecordedOrEvaluatorRule": "WI-10006055 reaches a terminal state and the green-checkpoint ownership is released",
            "currentEvidence": {
              "claim_hold_at": "2026-10-16T01:44:57.919Z",
              "claim_hold_by": "su-d8505bfb-32a2-43d7-8a24-d16eb38ec994",
              "claim_hold_reason": "Park this duplicate no-verdict alarm until the live gate owner finishes; prevent another member from self-selecting the same LIVE_GATE_OPS lane.",
              "claim_hold_release": {
                "owner": "su-d6d37b55-374d-475a-b442-e9f4cceb94cb",
                "trigger": "work-item:done:WI-10006055",
                "evidence": "a live resolver or producer registration can still satisfy the condition",
                "condition": "WI-10006055 reaches a terminal state and the green-checkpoint ownership is released",
                "reachability": "reachable"
              }
            },
            "verification": "unassessed; recorded values and evaluator rules do not establish legitimacy",
            "unknownFields": [],
            "writerProvenanceVerification": {
              "sourceRules": "work-items.ts:setWorkItemClaimHold and work-items-admission-promoter.ts:qualifiedAgentPark; corroboration grants no release authority",
              "checks": [
                {
                  "convention": "claim_hold",
                  "recordedActor": "su-d8505bfb-32a2-43d7-8a24-d16eb38ec994",
                  "corroboratedCanonicalWriter": true,
                  "criteria": {
                    "latestIsCanonicalSet": true,
                    "auditActorMatches": true,
                    "modeMatches": true,
                    "byMatches": true,
                    "reasonMatches": true,
                    "timestampMatches": true,
                    "releaseContractMatches": true
                  },
                  "auditId": "wi-claim-hold-mvab23id-26t3i8",
                  "notProven": [
                    "current actor authority",
                    "legitimacy of underlying reason",
                    "truth of arbitrary release condition",
                    "clearance",
                    "execution"
                  ]
                }
              ],
              "noConventionRecorded": false
            }
          }
        ],
        "controlEvidence": {
          "implementationReadiness": {
            "reason": "no-acceptance-evidence-at-creation",
            "source": "creation-enrollment",
            "status": "unknown",
            "updatedAt": "2026-10-15T04:50:05.860Z",
            "schemaVersion": "implementation-readiness-v1"
          },
          "_claimHold": true,
          "claim_hold_at": "2026-10-16T01:44:57.919Z",
          "claim_hold_by": "su-d8505bfb-32a2-43d7-8a24-d16eb38ec994",
          "claim_hold_reason": "Park this duplicate no-verdict alarm until the live gate owner finishes; prevent another member from self-selecting the same LIVE_GATE_OPS lane.",
          "claim_hold_release": {
            "owner": "su-d6d37b55-374d-475a-b442-e9f4cceb94cb",
            "trigger": "work-item:done:WI-10006055",
            "evidence": "a live resolver or producer registration can still satisfy the condition",
            "condition": "WI-10006055 reaches a terminal state and the green-checkpoint ownership is released",
            "reachability": "reachable"
          },
          "reporter": {
            "at": "2026-10-15T04:50:05.860Z",
            "id": null,
            "kind": "watchdog",
            "basis": "no-session"
          },
          "freshnessEnvelope": {
            "observedAt": "2026-10-15T04:50:05.860Z",
            "linkedFixRefs": [],
            "reporterSession": null,
            "observedSourceSha": "7adab27b62",
            "toolSchemaVersion": null,
            "observedRuntimeSha": "7adab27b62",
            "deployBuildIdentity": "7adab27b62@0.0.0",
            "reporterRuntimeVersion": "0.0.0",
            "lastSuccessfulReproductionAt": null
          }
        },
        "accountableInvestigator": "su-c52a1707-13f5-4080-870b-f7143c271d73",
        "disposition": "unassessed",
        "legitimateException": null,
        "executionEvidence": null,
        "remainingVerification": [
          "Actual source writer and recorded producer",
          "Restriction evidence, age, accountable authorized clearer and exact release condition",
          "Legitimacy or false-restriction repair",
          "Same-ID execution or explicit Avi disposition"
        ],
        "schemaVersion": "luna-r1-causal-evidence-ledger-v4",
        "sourceQualification": {
          "status": "clearance mechanisms mapped; row-specific causal/legitimacy verification remains open",
          "registry": "/home/marsh-office/.papercusp/evidence/c52-luna-r1-20261106/restriction-authority-registry-v1.json",
          "registrySha256": "1b51f4be4a288749652dfaf9f7c7d4547aae962dd0d33a798f8e729f9e49dfbe",
          "floorMappings": [
            {
              "floor": "live-gate-ops",
              "mechanismRef": "/home/marsh-office/.papercusp/evidence/c52-luna-r1-20261106/restriction-authority-registry-v1.json#/floors/live-gate-ops",
              "rowVerification": "unassessed",
              "requiredRowEvidence": [
                "exact condition_key",
                "condition producer",
                "registered ownership evidence supplied by that lane"
              ]
            },
            {
              "floor": "claim-hold",
              "mechanismRef": "/home/marsh-office/.papercusp/evidence/c52-luna-r1-20261106/restriction-authority-registry-v1.json#/floors/claim-hold",
              "rowVerification": "unassessed",
              "requiredRowEvidence": [
                "both provenance conventions",
                "typed release contract or precise legacy condition",
                "condition-specific proof",
                "current assignment/fingerprint",
                "owner authority if required"
              ],
              "recordedReleaseContractOwner": "su-d6d37b55-374d-475a-b442-e9f4cceb94cb",
              "recordedLeaseHolder": null,
              "recordedParker": "su-d8505bfb-32a2-43d7-8a24-d16eb38ec994",
              "authorityVerified": false
            }
          ]
        },
        "postFreezeControlContext": {
          "artifact": "/home/marsh-office/.papercusp/evidence/c52-luna-r1-20261106/live-control-enrichment-20261106T1950Z-v2.json",
          "observedAt": "2026-11-06 19:48:21.753008+00",
          "record": {
            "id": "WI-6554700010014195",
            "state": "open",
            "harness": "papercusp",
            "takenAt": null,
            "takenBy": null,
            "admission": "auto",
            "createdAt": 1792039805860,
            "updatedAt": 1792115097920,
            "admittedAt": "2026-10-15T04:50:05.86+00:00",
            "admittedBy": "bypass:condition-key",
            "duplicateOf": null,
            "conditionKey": "alarm:green-main-slo:%5B%22papercusp-workspace%22%2C%22papercusp%22%2C%22time-since-verdict%22%2C%22green-main-slo%3Apapercusp%3Atime-since-verdict%3A1792017698698.211%22%2Cnull%5D",
            "holderPresence": null,
            "sourcePlanSlug": null,
            "sourcePlanItemIds": null
          },
          "limitations": [
            "Presence absence does not establish holder death or authorize release",
            "Current terminal state alone does not prove execution",
            "Admission values are current post-freeze evidence; historical producer/state-transition audit still required"
          ]
        },
        "postFreezeDependencyContext": {
          "artifact": "/home/marsh-office/.papercusp/evidence/c52-luna-r1-20261106/dependency-enrichment-20261106T1930Z.json",
          "observedAt": "2026-11-06T19:26:36.952682Z",
          "edges": [],
          "coverage": "not queried by this enrichment; empty list is not absence evidence"
        },
        "historicalAuditEvidence": {
          "artifact": "/home/marsh-office/.papercusp/evidence/c52-luna-r1-20261106/historical-audit-enrichment-20261106T2010Z.json",
          "sha256": "4b396df0818120147036644a9e33893170b4d271e5a5fd1a87e0e720a9884410",
          "recordPointer": "/queryResult/rows/0/items/5881",
          "observedAt": "2026-11-06 20:03:09.124326+00",
          "eventCutoffMs": 1793992569628,
          "eventCount": 1,
          "coverage": "Available work_items:% audit only; empty is not no-transition proof; nonterminal changes and some needs-human changes are undated."
        }
      },
      "savedNovember7Qualification": {
        "schemaVersion": "luna-r1-causal-qualification-v1",
        "id": "WI-6554700010014195",
        "sourceLedger": {
          "path": "/home/marsh-office/.papercusp/evidence/c52-luna-r1-20261106/causal-ledger-v4.jsonl",
          "sha256": "7f1962fb5c22f1bc2be9625406b315f6b5f4fd190b4743d7f972a4fb2c935866",
          "rowSourceSha256": "a75636329be06a26b4f948bb1bb817a9df7908a7f316c98c0f8db093565cb3c4"
        },
        "frozenState": "open",
        "frozenFloors": [
          "claim-hold",
          "live-gate-ops"
        ],
        "currentControlObservedAt": "2026-11-07 11:32:12.960427-05",
        "currentState": "open",
        "currentHolder": null,
        "currentFloorVerdict": {
          "id": "WI-6554700010014195",
          "admissible": false,
          "refusedBy": "live-gate-ops",
          "failedFloors": [
            "live-gate-ops",
            "claim-hold"
          ],
          "detail": "LIVE_GATE_OPS condition (gate-red-streak: or green-stall: singleton, or an alarm:green-main-slo: time-since-green/time-since-verdict/red-adding-admission/round-cycle-time/queue-idle alarm) — reserved to the one registered live gate fixer and excluded from opportunistic self-select. A leader/owner may still dispatch or claim it BY ID after checking gate.greenCheckpoint.ownership."
        },
        "floorDifference": {
          "noLongerObserved": [],
          "newlyObserved": []
        },
        "adoptionQualification": null,
        "parkQualification": {
          "artifact": ".papercusp/evidence/c52-luna-r1-20261106/current-park-qualification-20261107T1715Z.json",
          "controlSnapshotAt": "2026-11-07 11:32:12.960427-05",
          "measuredAt": "2026-11-07T17:28:43.569Z",
          "qualificationAsMeasured": "reachable",
          "certification": "reachability-only; underlying release condition and clearer authority unverified"
        },
        "disposition": "unassessed",
        "executionEvidence": null,
        "nextActions": [
          "preserve park; qualify its exact condition and authorized clearer, with no automatic release from reachability"
        ],
        "limits": [
          "separately dated observations; not an immutable current-state snapshot",
          "a correct floor or release path does not prove underlying legitimacy",
          "adoption eligibility is report revision, not permission to implement"
        ]
      },
      "savedNovember8": {
        "observedAt": "2026-11-08 15:02:23.578069+00",
        "batch": 14,
        "recordPointer": "/rows/0/items/281",
        "rawProjectedRecord": {
          "id": "WI-6554700010014195",
          "state": "open",
          "holder": null,
          "control": {
            "_claimHold": true,
            "claim_hold_at": "2026-10-16T01:44:57.919Z",
            "claim_hold_by": "su-d8505bfb-32a2-43d7-8a24-d16eb38ec994",
            "claim_hold_reason": "Park this duplicate no-verdict alarm until the live gate owner finishes; prevent another member from self-selecting the same LIVE_GATE_OPS lane.",
            "claim_hold_release": {
              "owner": "su-d6d37b55-374d-475a-b442-e9f4cceb94cb",
              "trigger": "work-item:done:WI-10006055",
              "evidence": "a live resolver or producer registration can still satisfy the condition",
              "condition": "WI-10006055 reaches a terminal state and the green-checkpoint ownership is released",
              "reachability": "reachable"
            },
            "implementationReadiness": {
              "reason": "no-acceptance-evidence-at-creation",
              "source": "creation-enrollment",
              "status": "unknown",
              "updatedAt": "2026-10-15T04:50:05.860Z",
              "schemaVersion": "implementation-readiness-v1"
            }
          },
          "takenAt": null,
          "admission": "auto",
          "updatedAt": 1792115097920,
          "admittedAt": "2026-10-15T04:50:05.86+00:00",
          "admittedBy": "bypass:condition-key",
          "sourcePlan": null,
          "duplicateOf": null,
          "sourceItems": null,
          "conditionKey": "alarm:green-main-slo:%5B%22papercusp-workspace%22%2C%22papercusp%22%2C%22time-since-verdict%22%2C%22green-main-slo%3Apapercusp%3Atime-since-verdict%3A1792017698698.211%22%2Cnull%5D",
          "stateChangedAt": "2026-10-15T04:50:05.86+00:00"
        }
      },
      "reconciliation": {
        "id": "WI-6554700010014195",
        "frozenSourceSha256": "a75636329be06a26b4f948bb1bb817a9df7908a7f316c98c0f8db093565cb3c4",
        "frozenState": "open",
        "frozenFloors": [
          "live-gate-ops",
          "claim-hold"
        ],
        "priorDisposition": "unassessed",
        "currentBatch": 14,
        "currentState": "open",
        "currentHolder": null,
        "currentAdmission": "auto",
        "currentControlKeys": [
          "_claimHold",
          "claim_hold_at",
          "claim_hold_by",
          "claim_hold_reason",
          "claim_hold_release",
          "implementationReadiness"
        ],
        "changedProjectedControlKeys": [],
        "unmeasuredFrozenControlKeys": [
          "freshnessEnvelope",
          "reporter"
        ],
        "assessment": "condition-and-clearer-legitimacy-unresolved",
        "finalR1Disposition": "unresolved"
      },
      "conditionIdentity": {
        "key": "alarm:green-main-slo:%5B%22papercusp-workspace%22%2C%22papercusp%22%2C%22time-since-verdict%22%2C%22green-main-slo%3Apapercusp%3Atime-since-verdict%3A1792017698698.211%22%2Cnull%5D",
        "decodedWorkspaceInstallMetricEpisodeSubject": [
          "papercusp-workspace",
          "papercusp",
          "time-since-verdict",
          "green-main-slo:papercusp:time-since-verdict:1792017698698.211",
          null
        ],
        "datedPostFreezeKeyEqual": true,
        "frozenRawExportOmitsConditionKey": true,
        "historicalFrozenKeyUnproven": true
      },
      "sourceConditionedReservation": "The saved exact metric-slot key matches the witnessed current self-select reservation. The SQL floor depends on condition_key, not current gate ownership or holder liveness. No historical loaded-source identity is asserted.",
      "clearerQualification": {
        "conditionProducer": "greenMainSloConditionKey/runGreenMainSloPass source witness; historical emission not read",
        "conditionResolver": "Existing watchdog: measuredRecovery or explicitlySupersededByNewQueue, with distinct resolution summary. Supersession is not measured recovery or a durable fix.",
        "manualParkReleaseContract": {
          "owner": "su-d6d37b55-374d-475a-b442-e9f4cceb94cb",
          "trigger": "work-item:done:WI-10006055",
          "evidence": "a live resolver or producer registration can still satisfy the condition",
          "condition": "WI-10006055 reaches a terminal state and the green-checkpoint ownership is released",
          "reachability": "reachable"
        },
        "recordedReleaseOwner": "su-d6d37b55-374d-475a-b442-e9f4cceb94cb",
        "currentAuthenticatedNamedClearer": null,
        "currentGateOwnership": "UNMEASURED; intentionally not queried",
        "triggerLimit": "Gate-item completion or release:green is a wake/recheck trigger, not exact episode recovery or park clearance proof.",
        "independentControls": "Self-select reservation, durable park, external blocker, review/readiness and lifecycle guards remain separate."
      },
      "executionQualification": "No new execution or original-scope fix demonstrated. Saved state and missing holder do not authorize claim, release or monitoring.",
      "finalR1Disposition": "UNRESOLVED: historical condition truth/source identity, legitimate exception, current named authenticated authority and original-scope execution."
    },
    {
      "id": "WI-6554700010014877",
      "frozenSource": {
        "path": "/mnt/data/papercusp-audit-inputs/c52-r1-frozen-20261106T1917Z/WI-6554700010014877.json",
        "sha256": "e7e8d79c0e753270c02cdedc12ece75ef9e0ab607e9337fefc7cd9c83e4989a4",
        "raw": {
          "id": "WI-6554700010014877",
          "kind": "bug",
          "family": "issue",
          "harness": "papercusp",
          "title": "[alarm:green-main-slo:%5B%22papercusp-workspace%22%2C%22papercusp%22%2C%22round-cycle-time%22%2C%22green-main-slo%3Apapercusp%3Around-cycle-time%3A0e2f2291d5778",
          "summary": "Owning work-item for condition 'alarm:green-main-slo:%5B%22papercusp-workspace%22%2C%22papercusp%22%2C%22round-cycle-time%22%2C%22green-main-slo%3Apapercusp%3Around-cycle-time%3A0e2f2291d5778a59fd18c5f0ef29f76b2ed7ae0e%3A2%22%2C%220e2f2291d5778a59fd18c5f0ef29f76b2ed7ae0e%22%5D', minted by the condition bridge (P-003, gate-ownership-condition-singleton-2026-08-03). This item is the SINGLETON for this condition — the partial unique index on work_items.condition_key guarantees at most one open owner, so claim THIS rather than filing another.\n\nLatest alarm: Repair round 2 took 16.2h on papercusp\nFirst seen: 2026-10-15T15:00:44.768Z · open since: 2026-10-15T15:00:44.768Z · alarms: 1\n\nLatest alarm detail (from the emitter):\nFrozen candidate 0e2f2291d577: the newest round interval exceeds the 2.0h target.\n\n— emitted by pid 3854205, process started 2026-10-15T14:37:15.525Z (up 23m), cwd /home/marsh-office/papercupai-workspace/papercusp/apps/operator. If that start time PREDATES the fix you are checking, this process never loaded it (no hot-reload) and no deploy will reach it — restart that host instead of re-investigating the alarm.",
          "state": "open",
          "assignee": null,
          "takenAt": null,
          "lastProgressAt": null,
          "assignedBy": null,
          "createdBy": null,
          "severity": "major",
          "goalId": null,
          "tags": null,
          "sourcePlanSlug": null,
          "sourcePlanItemIds": null,
          "redundancy": null,
          "expectedCostCents": null,
          "parent": null,
          "payload": {
            "_ei": {
              "scope": "harness:papercusp",
              "source": "engineer",
              "severity": "major",
              "signal_origin": "organic"
            },
            "_bridge": {
              "mintedAt": "2026-10-15T15:01:16.608Z",
              "conditionKey": "alarm:green-main-slo:%5B%22papercusp-workspace%22%2C%22papercusp%22%2C%22round-cycle-time%22%2C%22green-main-slo%3Apapercusp%3Around-cycle-time%3A0e2f2291d5778a59fd18c5f0ef29f76b2ed7ae0e%3A2%22%2C%220e2f2291d5778a59fd18c5f0ef29f76b2ed7ae0e%22%5D"
            },
            "reporter": {
              "at": "2026-10-15T15:01:16.609Z",
              "id": null,
              "kind": "watchdog",
              "basis": "no-session"
            },
            "_claimHold": true,
            "claim_hold_at": "2026-10-16T13:02:54.735Z",
            "claim_hold_by": "su-386d7655-c57d-4399-8159-409603e82e7a",
            "reporterKinds": [
              "watchdog"
            ],
            "claim_hold_reason": "The recorded 16.2h round-cycle alert is a historical live-gate condition. Current SLO code and focused tests are already correct; fresh recovery requires the live gate owner to produce a later verdict and measured round for the same candidate. Park until that event.",
            "freshnessEnvelope": {
              "observedAt": "2026-10-15T15:01:16.609Z",
              "linkedFixRefs": [],
              "reporterSession": null,
              "observedSourceSha": "978ec1ba9d",
              "toolSchemaVersion": null,
              "observedRuntimeSha": "978ec1ba9d",
              "deployBuildIdentity": "978ec1ba9d@0.0.0",
              "reporterRuntimeVersion": "0.0.0",
              "lastSuccessfulReproductionAt": null
            },
            "claim_hold_release": {
              "owner": "su-e8a2c2bb-7cf2-4b35-af9a-37b13efc1a06",
              "trigger": "release:green:papercusp",
              "evidence": "a live resolver or producer registration can still satisfy the condition",
              "condition": "The green-main gate emits a fresh release:green:papercusp event and a later measured round-cycle interval for candidate 0e2f2291d577 is available.",
              "recheckAt": "2026-11-07T00:24:00.224Z",
              "recheckedAt": "2026-11-06T00:24:00.224Z",
              "reachability": "reachable",
              "recheckReason": "broad",
              "recheckSource": "system:unprovable-park-recheck",
              "recheckDisposition": "escalated",
              "recheckReachability": {
                "basis": "unmeasured",
                "verdict": "unknown",
                "evidence": "trigger \"release:green:papercusp\" may wake a consumer but cannot establish the specific release condition; subject-bound evidence is required",
                "checkedAt": "2026-11-06T00:24:31.279Z",
                "authoritative": false,
                "uncertifiedReason": "broad"
              }
            },
            "claim_history_post_id": 9001788375295,
            "implementationReadiness": {
              "reason": "no-acceptance-evidence-at-creation",
              "source": "creation-enrollment",
              "status": "unknown",
              "updatedAt": "2026-10-15T15:01:16.609Z",
              "schemaVersion": "implementation-readiness-v1"
            }
          },
          "definition": null,
          "rank": null,
          "rankWriter": null,
          "rankUpdatedAt": null,
          "priority": null,
          "terminalOwner": null,
          "terminalCompletionRef": null,
          "terminalCompletionEvidence": null,
          "completionAuthority": null,
          "origin": "local",
          "auditVerdict": null,
          "verifiedAuthorGithubUserId": null,
          "createdAt": "2026-10-15T15:01:16.609Z",
          "updatedAt": "2026-11-06T00:32:22.689Z",
          "closedAt": null
        }
      },
      "originalLedgerRow": {
        "id": "WI-6554700010014877",
        "source": "/mnt/data/papercusp-audit-inputs/c52-r1-frozen-20261106T1917Z/WI-6554700010014877.json",
        "sourceSha256": "e7e8d79c0e753270c02cdedc12ece75ef9e0ab607e9337fefc7cd9c83e4989a4",
        "manifestSha256": "75f699e3073a53df71db467214e8d3271ab3df35aca42fd3a5dcd1918f9af1ad",
        "state": "open",
        "rowAgeSecondsAtSnapshot": 1916093.019262,
        "rawRestrictionVerdict": {
          "id": "WI-6554700010014877",
          "admissible": false,
          "refusedBy": "live-gate-ops",
          "failedFloors": [
            "live-gate-ops",
            "claim-hold"
          ],
          "detail": "LIVE_GATE_OPS condition (gate-red-streak: or green-stall: singleton, or an alarm:green-main-slo: time-since-green/time-since-verdict/red-adding-admission/round-cycle-time/queue-idle alarm) — reserved to the one registered live gate fixer and excluded from opportunistic self-select. A leader/owner may still dispatch or claim it BY ID after checking gate.greenCheckpoint.ownership."
        },
        "restrictions": [
          {
            "floor": "live-gate-ops",
            "stateProducerRecorded": null,
            "enteredAtRecorded": null,
            "ageSecondsAtSnapshot": null,
            "accountableClearerRecorded": null,
            "releaseConditionRecordedOrEvaluatorRule": "Registered live gate owner progresses this lane; no competing takeover or repeated gate status read.",
            "currentEvidence": {
              "scope": "LIVE_GATE_OPS",
              "status": "excluded from this investigation lane"
            },
            "verification": "unassessed; recorded values and evaluator rules do not establish legitimacy",
            "unknownFields": [
              "stateProducer",
              "enteredAt",
              "accountableClearer"
            ]
          },
          {
            "floor": "claim-hold",
            "stateProducerRecorded": "su-386d7655-c57d-4399-8159-409603e82e7a",
            "enteredAtRecorded": "2026-10-16T13:02:54.735Z",
            "ageSecondsAtSnapshot": 1836794.893262,
            "accountableClearerRecorded": "su-e8a2c2bb-7cf2-4b35-af9a-37b13efc1a06",
            "releaseConditionRecordedOrEvaluatorRule": "The green-main gate emits a fresh release:green:papercusp event and a later measured round-cycle interval for candidate 0e2f2291d577 is available.",
            "currentEvidence": {
              "claim_hold_at": "2026-10-16T13:02:54.735Z",
              "claim_hold_by": "su-386d7655-c57d-4399-8159-409603e82e7a",
              "claim_hold_reason": "The recorded 16.2h round-cycle alert is a historical live-gate condition. Current SLO code and focused tests are already correct; fresh recovery requires the live gate owner to produce a later verdict and measured round for the same candidate. Park until that event.",
              "claim_hold_release": {
                "owner": "su-e8a2c2bb-7cf2-4b35-af9a-37b13efc1a06",
                "trigger": "release:green:papercusp",
                "evidence": "a live resolver or producer registration can still satisfy the condition",
                "condition": "The green-main gate emits a fresh release:green:papercusp event and a later measured round-cycle interval for candidate 0e2f2291d577 is available.",
                "recheckAt": "2026-11-07T00:24:00.224Z",
                "recheckedAt": "2026-11-06T00:24:00.224Z",
                "reachability": "reachable",
                "recheckReason": "broad",
                "recheckSource": "system:unprovable-park-recheck",
                "recheckDisposition": "escalated",
                "recheckReachability": {
                  "basis": "unmeasured",
                  "verdict": "unknown",
                  "evidence": "trigger \"release:green:papercusp\" may wake a consumer but cannot establish the specific release condition; subject-bound evidence is required",
                  "checkedAt": "2026-11-06T00:24:31.279Z",
                  "authoritative": false,
                  "uncertifiedReason": "broad"
                }
              }
            },
            "verification": "unassessed; recorded values and evaluator rules do not establish legitimacy",
            "unknownFields": [],
            "writerProvenanceVerification": {
              "sourceRules": "work-items.ts:setWorkItemClaimHold and work-items-admission-promoter.ts:qualifiedAgentPark; corroboration grants no release authority",
              "checks": [
                {
                  "convention": "claim_hold",
                  "recordedActor": "su-386d7655-c57d-4399-8159-409603e82e7a",
                  "corroboratedCanonicalWriter": false,
                  "criteria": {
                    "latestIsCanonicalSet": true,
                    "auditActorMatches": true,
                    "modeMatches": true,
                    "byMatches": true,
                    "reasonMatches": true,
                    "timestampMatches": true,
                    "releaseContractMatches": false
                  },
                  "auditId": "wi-claim-hold-mvaz9xyq-43069a",
                  "notProven": [
                    "current actor authority",
                    "legitimacy of underlying reason",
                    "truth of arbitrary release condition",
                    "clearance",
                    "execution"
                  ]
                }
              ],
              "noConventionRecorded": false
            }
          }
        ],
        "controlEvidence": {
          "implementationReadiness": {
            "reason": "no-acceptance-evidence-at-creation",
            "source": "creation-enrollment",
            "status": "unknown",
            "updatedAt": "2026-10-15T15:01:16.609Z",
            "schemaVersion": "implementation-readiness-v1"
          },
          "_claimHold": true,
          "claim_hold_at": "2026-10-16T13:02:54.735Z",
          "claim_hold_by": "su-386d7655-c57d-4399-8159-409603e82e7a",
          "claim_hold_reason": "The recorded 16.2h round-cycle alert is a historical live-gate condition. Current SLO code and focused tests are already correct; fresh recovery requires the live gate owner to produce a later verdict and measured round for the same candidate. Park until that event.",
          "claim_hold_release": {
            "owner": "su-e8a2c2bb-7cf2-4b35-af9a-37b13efc1a06",
            "trigger": "release:green:papercusp",
            "evidence": "a live resolver or producer registration can still satisfy the condition",
            "condition": "The green-main gate emits a fresh release:green:papercusp event and a later measured round-cycle interval for candidate 0e2f2291d577 is available.",
            "recheckAt": "2026-11-07T00:24:00.224Z",
            "recheckedAt": "2026-11-06T00:24:00.224Z",
            "reachability": "reachable",
            "recheckReason": "broad",
            "recheckSource": "system:unprovable-park-recheck",
            "recheckDisposition": "escalated",
            "recheckReachability": {
              "basis": "unmeasured",
              "verdict": "unknown",
              "evidence": "trigger \"release:green:papercusp\" may wake a consumer but cannot establish the specific release condition; subject-bound evidence is required",
              "checkedAt": "2026-11-06T00:24:31.279Z",
              "authoritative": false,
              "uncertifiedReason": "broad"
            }
          },
          "reporter": {
            "at": "2026-10-15T15:01:16.609Z",
            "id": null,
            "kind": "watchdog",
            "basis": "no-session"
          },
          "freshnessEnvelope": {
            "observedAt": "2026-10-15T15:01:16.609Z",
            "linkedFixRefs": [],
            "reporterSession": null,
            "observedSourceSha": "978ec1ba9d",
            "toolSchemaVersion": null,
            "observedRuntimeSha": "978ec1ba9d",
            "deployBuildIdentity": "978ec1ba9d@0.0.0",
            "reporterRuntimeVersion": "0.0.0",
            "lastSuccessfulReproductionAt": null
          }
        },
        "accountableInvestigator": "su-c52a1707-13f5-4080-870b-f7143c271d73",
        "disposition": "unassessed",
        "legitimateException": null,
        "executionEvidence": null,
        "remainingVerification": [
          "Actual source writer and recorded producer",
          "Restriction evidence, age, accountable authorized clearer and exact release condition",
          "Legitimacy or false-restriction repair",
          "Same-ID execution or explicit Avi disposition"
        ],
        "schemaVersion": "luna-r1-causal-evidence-ledger-v4",
        "sourceQualification": {
          "status": "clearance mechanisms mapped; row-specific causal/legitimacy verification remains open",
          "registry": "/home/marsh-office/.papercusp/evidence/c52-luna-r1-20261106/restriction-authority-registry-v1.json",
          "registrySha256": "1b51f4be4a288749652dfaf9f7c7d4547aae962dd0d33a798f8e729f9e49dfbe",
          "floorMappings": [
            {
              "floor": "live-gate-ops",
              "mechanismRef": "/home/marsh-office/.papercusp/evidence/c52-luna-r1-20261106/restriction-authority-registry-v1.json#/floors/live-gate-ops",
              "rowVerification": "unassessed",
              "requiredRowEvidence": [
                "exact condition_key",
                "condition producer",
                "registered ownership evidence supplied by that lane"
              ]
            },
            {
              "floor": "claim-hold",
              "mechanismRef": "/home/marsh-office/.papercusp/evidence/c52-luna-r1-20261106/restriction-authority-registry-v1.json#/floors/claim-hold",
              "rowVerification": "unassessed",
              "requiredRowEvidence": [
                "both provenance conventions",
                "typed release contract or precise legacy condition",
                "condition-specific proof",
                "current assignment/fingerprint",
                "owner authority if required"
              ],
              "recordedReleaseContractOwner": "su-e8a2c2bb-7cf2-4b35-af9a-37b13efc1a06",
              "recordedLeaseHolder": null,
              "recordedParker": "su-386d7655-c57d-4399-8159-409603e82e7a",
              "authorityVerified": false
            }
          ]
        },
        "postFreezeControlContext": {
          "artifact": "/home/marsh-office/.papercusp/evidence/c52-luna-r1-20261106/live-control-enrichment-20261106T1950Z-v2.json",
          "observedAt": "2026-11-06 19:48:21.753008+00",
          "record": {
            "id": "WI-6554700010014877",
            "state": "open",
            "harness": "papercusp",
            "takenAt": null,
            "takenBy": null,
            "admission": "auto",
            "createdAt": 1792076476609,
            "updatedAt": 1793925142689,
            "admittedAt": "2026-10-15T15:01:16.609+00:00",
            "admittedBy": "bypass:condition-key",
            "duplicateOf": null,
            "conditionKey": "alarm:green-main-slo:%5B%22papercusp-workspace%22%2C%22papercusp%22%2C%22round-cycle-time%22%2C%22green-main-slo%3Apapercusp%3Around-cycle-time%3A0e2f2291d5778a59fd18c5f0ef29f76b2ed7ae0e%3A2%22%2C%220e2f2291d5778a59fd18c5f0ef29f76b2ed7ae0e%22%5D",
            "holderPresence": null,
            "sourcePlanSlug": null,
            "sourcePlanItemIds": null
          },
          "limitations": [
            "Presence absence does not establish holder death or authorize release",
            "Current terminal state alone does not prove execution",
            "Admission values are current post-freeze evidence; historical producer/state-transition audit still required"
          ]
        },
        "postFreezeDependencyContext": {
          "artifact": "/home/marsh-office/.papercusp/evidence/c52-luna-r1-20261106/dependency-enrichment-20261106T1930Z.json",
          "observedAt": "2026-11-06T19:26:36.952682Z",
          "edges": [],
          "coverage": "not queried by this enrichment; empty list is not absence evidence"
        },
        "historicalAuditEvidence": {
          "artifact": "/home/marsh-office/.papercusp/evidence/c52-luna-r1-20261106/historical-audit-enrichment-20261106T2010Z.json",
          "sha256": "4b396df0818120147036644a9e33893170b4d271e5a5fd1a87e0e720a9884410",
          "recordPointer": "/queryResult/rows/0/items/5891",
          "observedAt": "2026-11-06 20:03:09.124326+00",
          "eventCutoffMs": 1793992569628,
          "eventCount": 1,
          "coverage": "Available work_items:% audit only; empty is not no-transition proof; nonterminal changes and some needs-human changes are undated."
        }
      },
      "savedNovember7Qualification": {
        "schemaVersion": "luna-r1-causal-qualification-v1",
        "id": "WI-6554700010014877",
        "sourceLedger": {
          "path": "/home/marsh-office/.papercusp/evidence/c52-luna-r1-20261106/causal-ledger-v4.jsonl",
          "sha256": "7f1962fb5c22f1bc2be9625406b315f6b5f4fd190b4743d7f972a4fb2c935866",
          "rowSourceSha256": "e7e8d79c0e753270c02cdedc12ece75ef9e0ab607e9337fefc7cd9c83e4989a4"
        },
        "frozenState": "open",
        "frozenFloors": [
          "claim-hold",
          "live-gate-ops"
        ],
        "currentControlObservedAt": "2026-11-07 11:32:12.960427-05",
        "currentState": "open",
        "currentHolder": null,
        "currentFloorVerdict": {
          "id": "WI-6554700010014877",
          "admissible": false,
          "refusedBy": "live-gate-ops",
          "failedFloors": [
            "live-gate-ops",
            "claim-hold"
          ],
          "detail": "LIVE_GATE_OPS condition (gate-red-streak: or green-stall: singleton, or an alarm:green-main-slo: time-since-green/time-since-verdict/red-adding-admission/round-cycle-time/queue-idle alarm) — reserved to the one registered live gate fixer and excluded from opportunistic self-select. A leader/owner may still dispatch or claim it BY ID after checking gate.greenCheckpoint.ownership."
        },
        "floorDifference": {
          "noLongerObserved": [],
          "newlyObserved": []
        },
        "adoptionQualification": null,
        "parkQualification": {
          "artifact": ".papercusp/evidence/c52-luna-r1-20261106/current-park-qualification-20261107T1715Z.json",
          "controlSnapshotAt": "2026-11-07 11:32:12.960427-05",
          "measuredAt": "2026-11-07T17:28:44.010Z",
          "qualificationAsMeasured": "blocked",
          "certification": "reachability-only; underlying release condition and clearer authority unverified"
        },
        "disposition": "unassessed",
        "executionEvidence": null,
        "nextActions": [
          "preserve park; qualify its exact condition and authorized clearer, with no automatic release from reachability"
        ],
        "limits": [
          "separately dated observations; not an immutable current-state snapshot",
          "a correct floor or release path does not prove underlying legitimacy",
          "adoption eligibility is report revision, not permission to implement"
        ]
      },
      "savedNovember8": {
        "observedAt": "2026-11-08 15:02:23.578069+00",
        "batch": 14,
        "recordPointer": "/rows/0/items/291",
        "rawProjectedRecord": {
          "id": "WI-6554700010014877",
          "state": "open",
          "holder": null,
          "control": {
            "_claimHold": true,
            "claim_hold_at": "2026-10-16T13:02:54.735Z",
            "claim_hold_by": "su-386d7655-c57d-4399-8159-409603e82e7a",
            "claim_hold_reason": "The recorded 16.2h round-cycle alert is a historical live-gate condition. Current SLO code and focused tests are already correct; fresh recovery requires the live gate owner to produce a later verdict and measured round for the same candidate. Park until that event.",
            "claim_hold_release": {
              "owner": "su-e8a2c2bb-7cf2-4b35-af9a-37b13efc1a06",
              "trigger": "release:green:papercusp",
              "evidence": "a live resolver or producer registration can still satisfy the condition",
              "condition": "The green-main gate emits a fresh release:green:papercusp event and a later measured round-cycle interval for candidate 0e2f2291d577 is available.",
              "recheckAt": "2026-11-09T01:22:52.148Z",
              "recheckedAt": "2026-11-08T01:22:52.148Z",
              "reachability": "reachable",
              "recheckReason": "broad",
              "recheckSource": "system:unprovable-park-recheck",
              "recheckDisposition": "escalated",
              "recheckReachability": {
                "basis": "unmeasured",
                "verdict": "unknown",
                "evidence": "trigger \"release:green:papercusp\" may wake a consumer but cannot establish the specific release condition; subject-bound evidence is required",
                "checkedAt": "2026-11-08T01:23:07.443Z",
                "authoritative": false,
                "uncertifiedReason": "broad"
              }
            },
            "implementationReadiness": {
              "reason": "no-acceptance-evidence-at-creation",
              "source": "creation-enrollment",
              "status": "unknown",
              "updatedAt": "2026-10-15T15:01:16.609Z",
              "schemaVersion": "implementation-readiness-v1"
            }
          },
          "takenAt": null,
          "admission": "auto",
          "updatedAt": 1794101346244,
          "admittedAt": "2026-10-15T15:01:16.609+00:00",
          "admittedBy": "bypass:condition-key",
          "sourcePlan": null,
          "duplicateOf": null,
          "sourceItems": null,
          "conditionKey": "alarm:green-main-slo:%5B%22papercusp-workspace%22%2C%22papercusp%22%2C%22round-cycle-time%22%2C%22green-main-slo%3Apapercusp%3Around-cycle-time%3A0e2f2291d5778a59fd18c5f0ef29f76b2ed7ae0e%3A2%22%2C%220e2f2291d5778a59fd18c5f0ef29f76b2ed7ae0e%22%5D",
          "stateChangedAt": "2026-10-15T15:01:16.609+00:00"
        }
      },
      "reconciliation": {
        "id": "WI-6554700010014877",
        "frozenSourceSha256": "e7e8d79c0e753270c02cdedc12ece75ef9e0ab607e9337fefc7cd9c83e4989a4",
        "frozenState": "open",
        "frozenFloors": [
          "live-gate-ops",
          "claim-hold"
        ],
        "priorDisposition": "unassessed",
        "currentBatch": 14,
        "currentState": "open",
        "currentHolder": null,
        "currentAdmission": "auto",
        "currentControlKeys": [
          "_claimHold",
          "claim_hold_at",
          "claim_hold_by",
          "claim_hold_reason",
          "claim_hold_release",
          "implementationReadiness"
        ],
        "changedProjectedControlKeys": [
          "claim_hold_release"
        ],
        "unmeasuredFrozenControlKeys": [
          "freshnessEnvelope",
          "reporter"
        ],
        "assessment": "condition-and-clearer-legitimacy-unresolved",
        "finalR1Disposition": "unresolved"
      },
      "conditionIdentity": {
        "key": "alarm:green-main-slo:%5B%22papercusp-workspace%22%2C%22papercusp%22%2C%22round-cycle-time%22%2C%22green-main-slo%3Apapercusp%3Around-cycle-time%3A0e2f2291d5778a59fd18c5f0ef29f76b2ed7ae0e%3A2%22%2C%220e2f2291d5778a59fd18c5f0ef29f76b2ed7ae0e%22%5D",
        "decodedWorkspaceInstallMetricEpisodeSubject": [
          "papercusp-workspace",
          "papercusp",
          "round-cycle-time",
          "green-main-slo:papercusp:round-cycle-time:0e2f2291d5778a59fd18c5f0ef29f76b2ed7ae0e:2",
          "0e2f2291d5778a59fd18c5f0ef29f76b2ed7ae0e"
        ],
        "datedPostFreezeKeyEqual": true,
        "frozenRawExportOmitsConditionKey": true,
        "historicalFrozenKeyUnproven": true
      },
      "sourceConditionedReservation": "The saved exact metric-slot key matches the witnessed current self-select reservation. The SQL floor depends on condition_key, not current gate ownership or holder liveness. No historical loaded-source identity is asserted.",
      "clearerQualification": {
        "conditionProducer": "greenMainSloConditionKey/runGreenMainSloPass source witness; historical emission not read",
        "conditionResolver": "Existing watchdog: measuredRecovery or explicitlySupersededByNewQueue, with distinct resolution summary. Supersession is not measured recovery or a durable fix.",
        "manualParkReleaseContract": {
          "owner": "su-e8a2c2bb-7cf2-4b35-af9a-37b13efc1a06",
          "trigger": "release:green:papercusp",
          "evidence": "a live resolver or producer registration can still satisfy the condition",
          "condition": "The green-main gate emits a fresh release:green:papercusp event and a later measured round-cycle interval for candidate 0e2f2291d577 is available.",
          "recheckAt": "2026-11-09T01:22:52.148Z",
          "recheckedAt": "2026-11-08T01:22:52.148Z",
          "reachability": "reachable",
          "recheckReason": "broad",
          "recheckSource": "system:unprovable-park-recheck",
          "recheckDisposition": "escalated",
          "recheckReachability": {
            "basis": "unmeasured",
            "verdict": "unknown",
            "evidence": "trigger \"release:green:papercusp\" may wake a consumer but cannot establish the specific release condition; subject-bound evidence is required",
            "checkedAt": "2026-11-08T01:23:07.443Z",
            "authoritative": false,
            "uncertifiedReason": "broad"
          }
        },
        "recordedReleaseOwner": "su-e8a2c2bb-7cf2-4b35-af9a-37b13efc1a06",
        "currentAuthenticatedNamedClearer": null,
        "currentGateOwnership": "UNMEASURED; intentionally not queried",
        "triggerLimit": "Gate-item completion or release:green is a wake/recheck trigger, not exact episode recovery or park clearance proof.",
        "independentControls": "Self-select reservation, durable park, external blocker, review/readiness and lifecycle guards remain separate."
      },
      "executionQualification": "No new execution or original-scope fix demonstrated. Saved state and missing holder do not authorize claim, release or monitoring.",
      "finalR1Disposition": "UNRESOLVED: historical condition truth/source identity, legitimate exception, current named authenticated authority and original-scope execution."
    },
    {
      "id": "WI-6554700010014933",
      "frozenSource": {
        "path": "/mnt/data/papercusp-audit-inputs/c52-r1-frozen-20261106T1917Z/WI-6554700010014933.json",
        "sha256": "5cb9d99bca32756b1fcbcb1e281273922d3b586327fd5c432e0ae09588a1882f",
        "raw": {
          "id": "WI-6554700010014933",
          "kind": "bug",
          "family": "issue",
          "harness": "papercusp",
          "title": "[alarm:green-main-slo:%5B%22papercusp-workspace%22%2C%22papercusp%22%2C%22queue-idle%22%2C%22green-main-slo%3Apapercusp%3Aqueue-idle%3A0e2f2291d5778a59fd18c5f0e",
          "summary": "Owning work-item for condition 'alarm:green-main-slo:%5B%22papercusp-workspace%22%2C%22papercusp%22%2C%22queue-idle%22%2C%22green-main-slo%3Apapercusp%3Aqueue-idle%3A0e2f2291d5778a59fd18c5f0ef29f76b2ed7ae0e%3A1792076057282%22%2C%220e2f2291d5778a59fd18c5f0ef29f76b2ed7ae0e%22%5D', minted by the condition bridge (P-003, gate-ownership-condition-singleton-2026-08-03). This item is the SINGLETON for this condition — the partial unique index on work_items.condition_key guarantees at most one open owner, so claim THIS rather than filing another.\n\nLatest alarm: Frozen repair queue idle 1.1h on papercusp\nFirst seen: 2026-10-15T16:00:54.682Z · open since: 2026-10-15T16:00:54.682Z · alarms: 1\n\nLatest alarm detail (from the emitter):\nThe newest red has waited 1.1h for a fixer.\n\n— emitted by pid 3854205, process started 2026-10-15T14:37:15.357Z (up 1h23m), cwd /home/marsh-office/papercupai-workspace/papercusp/apps/operator. If that start time PREDATES the fix you are checking, this process never loaded it (no hot-reload) and no deploy will reach it — restart that host instead of re-investigating the alarm.",
          "state": "open",
          "assignee": null,
          "takenAt": null,
          "lastProgressAt": null,
          "assignedBy": null,
          "createdBy": null,
          "severity": "major",
          "goalId": null,
          "tags": null,
          "sourcePlanSlug": null,
          "sourcePlanItemIds": null,
          "redundancy": null,
          "expectedCostCents": null,
          "parent": null,
          "payload": {
            "_ei": {
              "scope": "harness:papercusp",
              "source": "engineer",
              "severity": "major",
              "signal_origin": "organic"
            },
            "_bridge": {
              "mintedAt": "2026-10-15T16:02:16.726Z",
              "conditionKey": "alarm:green-main-slo:%5B%22papercusp-workspace%22%2C%22papercusp%22%2C%22queue-idle%22%2C%22green-main-slo%3Apapercusp%3Aqueue-idle%3A0e2f2291d5778a59fd18c5f0ef29f76b2ed7ae0e%3A1792076057282%22%2C%220e2f2291d5778a59fd18c5f0ef29f76b2ed7ae0e%22%5D"
            },
            "reporter": {
              "at": "2026-10-15T16:02:16.743Z",
              "id": null,
              "kind": "watchdog",
              "basis": "no-session"
            },
            "_claimHold": true,
            "claim_hold_at": "2026-10-16T13:23:07.697Z",
            "claim_hold_by": "su-0e654fb7-b513-4131-ab03-49fcc1c0ae29",
            "reporterKinds": [
              "watchdog"
            ],
            "claim_hold_reason": "Duplicate LIVE_GATE_OPS alarm while gate ownership is held-live by su-e8a2c2bb on WI-10006055; released and parked pending gate-owner completion.",
            "freshnessEnvelope": {
              "observedAt": "2026-10-15T16:02:16.743Z",
              "linkedFixRefs": [],
              "reporterSession": null,
              "observedSourceSha": "978ec1ba9d",
              "toolSchemaVersion": null,
              "observedRuntimeSha": "978ec1ba9d",
              "deployBuildIdentity": "978ec1ba9d@0.0.0",
              "reporterRuntimeVersion": "0.0.0",
              "lastSuccessfulReproductionAt": null
            },
            "claim_hold_release": {
              "owner": "su-e8a2c2bb-7cf2-4b35-af9a-37b13efc1a06",
              "trigger": "work-item:done:WI-10006055",
              "evidence": "a live resolver or producer registration can still satisfy the condition",
              "condition": "Re-evaluate this duplicate queue-idle gate alarm after the current gate owner completes WI-10006055.",
              "reachability": "reachable"
            },
            "claim_history_post_id": 9001788375295,
            "implementationReadiness": {
              "reason": "no-acceptance-evidence-at-creation",
              "source": "creation-enrollment",
              "status": "unknown",
              "updatedAt": "2026-10-15T16:02:16.743Z",
              "schemaVersion": "implementation-readiness-v1"
            }
          },
          "definition": null,
          "rank": null,
          "rankWriter": null,
          "rankUpdatedAt": null,
          "priority": null,
          "terminalOwner": null,
          "terminalCompletionRef": null,
          "terminalCompletionEvidence": null,
          "completionAuthority": null,
          "origin": "local",
          "auditVerdict": null,
          "verifiedAuthorGithubUserId": null,
          "createdAt": "2026-10-15T16:02:16.743Z",
          "updatedAt": "2026-10-16T13:23:07.697Z",
          "closedAt": null
        }
      },
      "originalLedgerRow": {
        "id": "WI-6554700010014933",
        "source": "/mnt/data/papercusp-audit-inputs/c52-r1-frozen-20261106T1917Z/WI-6554700010014933.json",
        "sourceSha256": "5cb9d99bca32756b1fcbcb1e281273922d3b586327fd5c432e0ae09588a1882f",
        "manifestSha256": "75f699e3073a53df71db467214e8d3271ab3df35aca42fd3a5dcd1918f9af1ad",
        "state": "open",
        "rowAgeSecondsAtSnapshot": 1912432.885262,
        "rawRestrictionVerdict": {
          "id": "WI-6554700010014933",
          "admissible": false,
          "refusedBy": "live-gate-ops",
          "failedFloors": [
            "live-gate-ops",
            "claim-hold"
          ],
          "detail": "LIVE_GATE_OPS condition (gate-red-streak: or green-stall: singleton, or an alarm:green-main-slo: time-since-green/time-since-verdict/red-adding-admission/round-cycle-time/queue-idle alarm) — reserved to the one registered live gate fixer and excluded from opportunistic self-select. A leader/owner may still dispatch or claim it BY ID after checking gate.greenCheckpoint.ownership."
        },
        "restrictions": [
          {
            "floor": "live-gate-ops",
            "stateProducerRecorded": null,
            "enteredAtRecorded": null,
            "ageSecondsAtSnapshot": null,
            "accountableClearerRecorded": null,
            "releaseConditionRecordedOrEvaluatorRule": "Registered live gate owner progresses this lane; no competing takeover or repeated gate status read.",
            "currentEvidence": {
              "scope": "LIVE_GATE_OPS",
              "status": "excluded from this investigation lane"
            },
            "verification": "unassessed; recorded values and evaluator rules do not establish legitimacy",
            "unknownFields": [
              "stateProducer",
              "enteredAt",
              "accountableClearer"
            ]
          },
          {
            "floor": "claim-hold",
            "stateProducerRecorded": "su-0e654fb7-b513-4131-ab03-49fcc1c0ae29",
            "enteredAtRecorded": "2026-10-16T13:23:07.697Z",
            "ageSecondsAtSnapshot": 1835581.931262,
            "accountableClearerRecorded": "su-e8a2c2bb-7cf2-4b35-af9a-37b13efc1a06",
            "releaseConditionRecordedOrEvaluatorRule": "Re-evaluate this duplicate queue-idle gate alarm after the current gate owner completes WI-10006055.",
            "currentEvidence": {
              "claim_hold_at": "2026-10-16T13:23:07.697Z",
              "claim_hold_by": "su-0e654fb7-b513-4131-ab03-49fcc1c0ae29",
              "claim_hold_reason": "Duplicate LIVE_GATE_OPS alarm while gate ownership is held-live by su-e8a2c2bb on WI-10006055; released and parked pending gate-owner completion.",
              "claim_hold_release": {
                "owner": "su-e8a2c2bb-7cf2-4b35-af9a-37b13efc1a06",
                "trigger": "work-item:done:WI-10006055",
                "evidence": "a live resolver or producer registration can still satisfy the condition",
                "condition": "Re-evaluate this duplicate queue-idle gate alarm after the current gate owner completes WI-10006055.",
                "reachability": "reachable"
              }
            },
            "verification": "unassessed; recorded values and evaluator rules do not establish legitimacy",
            "unknownFields": [],
            "writerProvenanceVerification": {
              "sourceRules": "work-items.ts:setWorkItemClaimHold and work-items-admission-promoter.ts:qualifiedAgentPark; corroboration grants no release authority",
              "checks": [
                {
                  "convention": "claim_hold",
                  "recordedActor": "su-0e654fb7-b513-4131-ab03-49fcc1c0ae29",
                  "corroboratedCanonicalWriter": true,
                  "criteria": {
                    "latestIsCanonicalSet": true,
                    "auditActorMatches": true,
                    "modeMatches": true,
                    "byMatches": true,
                    "reasonMatches": true,
                    "timestampMatches": true,
                    "releaseContractMatches": true
                  },
                  "auditId": "wi-claim-hold-mvazzxvb-lneedl",
                  "notProven": [
                    "current actor authority",
                    "legitimacy of underlying reason",
                    "truth of arbitrary release condition",
                    "clearance",
                    "execution"
                  ]
                }
              ],
              "noConventionRecorded": false
            }
          }
        ],
        "controlEvidence": {
          "implementationReadiness": {
            "reason": "no-acceptance-evidence-at-creation",
            "source": "creation-enrollment",
            "status": "unknown",
            "updatedAt": "2026-10-15T16:02:16.743Z",
            "schemaVersion": "implementation-readiness-v1"
          },
          "_claimHold": true,
          "claim_hold_at": "2026-10-16T13:23:07.697Z",
          "claim_hold_by": "su-0e654fb7-b513-4131-ab03-49fcc1c0ae29",
          "claim_hold_reason": "Duplicate LIVE_GATE_OPS alarm while gate ownership is held-live by su-e8a2c2bb on WI-10006055; released and parked pending gate-owner completion.",
          "claim_hold_release": {
            "owner": "su-e8a2c2bb-7cf2-4b35-af9a-37b13efc1a06",
            "trigger": "work-item:done:WI-10006055",
            "evidence": "a live resolver or producer registration can still satisfy the condition",
            "condition": "Re-evaluate this duplicate queue-idle gate alarm after the current gate owner completes WI-10006055.",
            "reachability": "reachable"
          },
          "reporter": {
            "at": "2026-10-15T16:02:16.743Z",
            "id": null,
            "kind": "watchdog",
            "basis": "no-session"
          },
          "freshnessEnvelope": {
            "observedAt": "2026-10-15T16:02:16.743Z",
            "linkedFixRefs": [],
            "reporterSession": null,
            "observedSourceSha": "978ec1ba9d",
            "toolSchemaVersion": null,
            "observedRuntimeSha": "978ec1ba9d",
            "deployBuildIdentity": "978ec1ba9d@0.0.0",
            "reporterRuntimeVersion": "0.0.0",
            "lastSuccessfulReproductionAt": null
          }
        },
        "accountableInvestigator": "su-c52a1707-13f5-4080-870b-f7143c271d73",
        "disposition": "unassessed",
        "legitimateException": null,
        "executionEvidence": null,
        "remainingVerification": [
          "Actual source writer and recorded producer",
          "Restriction evidence, age, accountable authorized clearer and exact release condition",
          "Legitimacy or false-restriction repair",
          "Same-ID execution or explicit Avi disposition"
        ],
        "schemaVersion": "luna-r1-causal-evidence-ledger-v4",
        "sourceQualification": {
          "status": "clearance mechanisms mapped; row-specific causal/legitimacy verification remains open",
          "registry": "/home/marsh-office/.papercusp/evidence/c52-luna-r1-20261106/restriction-authority-registry-v1.json",
          "registrySha256": "1b51f4be4a288749652dfaf9f7c7d4547aae962dd0d33a798f8e729f9e49dfbe",
          "floorMappings": [
            {
              "floor": "live-gate-ops",
              "mechanismRef": "/home/marsh-office/.papercusp/evidence/c52-luna-r1-20261106/restriction-authority-registry-v1.json#/floors/live-gate-ops",
              "rowVerification": "unassessed",
              "requiredRowEvidence": [
                "exact condition_key",
                "condition producer",
                "registered ownership evidence supplied by that lane"
              ]
            },
            {
              "floor": "claim-hold",
              "mechanismRef": "/home/marsh-office/.papercusp/evidence/c52-luna-r1-20261106/restriction-authority-registry-v1.json#/floors/claim-hold",
              "rowVerification": "unassessed",
              "requiredRowEvidence": [
                "both provenance conventions",
                "typed release contract or precise legacy condition",
                "condition-specific proof",
                "current assignment/fingerprint",
                "owner authority if required"
              ],
              "recordedReleaseContractOwner": "su-e8a2c2bb-7cf2-4b35-af9a-37b13efc1a06",
              "recordedLeaseHolder": null,
              "recordedParker": "su-0e654fb7-b513-4131-ab03-49fcc1c0ae29",
              "authorityVerified": false
            }
          ]
        },
        "postFreezeControlContext": {
          "artifact": "/home/marsh-office/.papercusp/evidence/c52-luna-r1-20261106/live-control-enrichment-20261106T1950Z-v2.json",
          "observedAt": "2026-11-06 19:48:21.753008+00",
          "record": {
            "id": "WI-6554700010014933",
            "state": "open",
            "harness": "papercusp",
            "takenAt": null,
            "takenBy": null,
            "admission": "auto",
            "createdAt": 1792080136743,
            "updatedAt": 1792156987697,
            "admittedAt": "2026-10-15T16:02:16.743+00:00",
            "admittedBy": "bypass:condition-key",
            "duplicateOf": null,
            "conditionKey": "alarm:green-main-slo:%5B%22papercusp-workspace%22%2C%22papercusp%22%2C%22queue-idle%22%2C%22green-main-slo%3Apapercusp%3Aqueue-idle%3A0e2f2291d5778a59fd18c5f0ef29f76b2ed7ae0e%3A1792076057282%22%2C%220e2f2291d5778a59fd18c5f0ef29f76b2ed7ae0e%22%5D",
            "holderPresence": null,
            "sourcePlanSlug": null,
            "sourcePlanItemIds": null
          },
          "limitations": [
            "Presence absence does not establish holder death or authorize release",
            "Current terminal state alone does not prove execution",
            "Admission values are current post-freeze evidence; historical producer/state-transition audit still required"
          ]
        },
        "postFreezeDependencyContext": {
          "artifact": "/home/marsh-office/.papercusp/evidence/c52-luna-r1-20261106/dependency-enrichment-20261106T1930Z.json",
          "observedAt": "2026-11-06T19:26:36.952682Z",
          "edges": [],
          "coverage": "not queried by this enrichment; empty list is not absence evidence"
        },
        "historicalAuditEvidence": {
          "artifact": "/home/marsh-office/.papercusp/evidence/c52-luna-r1-20261106/historical-audit-enrichment-20261106T2010Z.json",
          "sha256": "4b396df0818120147036644a9e33893170b4d271e5a5fd1a87e0e720a9884410",
          "recordPointer": "/queryResult/rows/0/items/5892",
          "observedAt": "2026-11-06 20:03:09.124326+00",
          "eventCutoffMs": 1793992569628,
          "eventCount": 1,
          "coverage": "Available work_items:% audit only; empty is not no-transition proof; nonterminal changes and some needs-human changes are undated."
        }
      },
      "savedNovember7Qualification": {
        "schemaVersion": "luna-r1-causal-qualification-v1",
        "id": "WI-6554700010014933",
        "sourceLedger": {
          "path": "/home/marsh-office/.papercusp/evidence/c52-luna-r1-20261106/causal-ledger-v4.jsonl",
          "sha256": "7f1962fb5c22f1bc2be9625406b315f6b5f4fd190b4743d7f972a4fb2c935866",
          "rowSourceSha256": "5cb9d99bca32756b1fcbcb1e281273922d3b586327fd5c432e0ae09588a1882f"
        },
        "frozenState": "open",
        "frozenFloors": [
          "claim-hold",
          "live-gate-ops"
        ],
        "currentControlObservedAt": "2026-11-07 11:32:12.960427-05",
        "currentState": "open",
        "currentHolder": null,
        "currentFloorVerdict": {
          "id": "WI-6554700010014933",
          "admissible": false,
          "refusedBy": "live-gate-ops",
          "failedFloors": [
            "live-gate-ops",
            "claim-hold"
          ],
          "detail": "LIVE_GATE_OPS condition (gate-red-streak: or green-stall: singleton, or an alarm:green-main-slo: time-since-green/time-since-verdict/red-adding-admission/round-cycle-time/queue-idle alarm) — reserved to the one registered live gate fixer and excluded from opportunistic self-select. A leader/owner may still dispatch or claim it BY ID after checking gate.greenCheckpoint.ownership."
        },
        "floorDifference": {
          "noLongerObserved": [],
          "newlyObserved": []
        },
        "adoptionQualification": null,
        "parkQualification": {
          "artifact": ".papercusp/evidence/c52-luna-r1-20261106/current-park-qualification-20261107T1715Z.json",
          "controlSnapshotAt": "2026-11-07 11:32:12.960427-05",
          "measuredAt": "2026-11-07T17:28:44.011Z",
          "qualificationAsMeasured": "reachable",
          "certification": "reachability-only; underlying release condition and clearer authority unverified"
        },
        "disposition": "unassessed",
        "executionEvidence": null,
        "nextActions": [
          "preserve park; qualify its exact condition and authorized clearer, with no automatic release from reachability"
        ],
        "limits": [
          "separately dated observations; not an immutable current-state snapshot",
          "a correct floor or release path does not prove underlying legitimacy",
          "adoption eligibility is report revision, not permission to implement"
        ]
      },
      "savedNovember8": {
        "observedAt": "2026-11-08 15:02:23.578069+00",
        "batch": 14,
        "recordPointer": "/rows/0/items/292",
        "rawProjectedRecord": {
          "id": "WI-6554700010014933",
          "state": "open",
          "holder": null,
          "control": {
            "_claimHold": true,
            "claim_hold_at": "2026-10-16T13:23:07.697Z",
            "claim_hold_by": "su-0e654fb7-b513-4131-ab03-49fcc1c0ae29",
            "claim_hold_reason": "Duplicate LIVE_GATE_OPS alarm while gate ownership is held-live by su-e8a2c2bb on WI-10006055; released and parked pending gate-owner completion.",
            "claim_hold_release": {
              "owner": "su-e8a2c2bb-7cf2-4b35-af9a-37b13efc1a06",
              "trigger": "work-item:done:WI-10006055",
              "evidence": "a live resolver or producer registration can still satisfy the condition",
              "condition": "Re-evaluate this duplicate queue-idle gate alarm after the current gate owner completes WI-10006055.",
              "reachability": "reachable"
            },
            "implementationReadiness": {
              "reason": "no-acceptance-evidence-at-creation",
              "source": "creation-enrollment",
              "status": "unknown",
              "updatedAt": "2026-10-15T16:02:16.743Z",
              "schemaVersion": "implementation-readiness-v1"
            }
          },
          "takenAt": null,
          "admission": "auto",
          "updatedAt": 1792156987697,
          "admittedAt": "2026-10-15T16:02:16.743+00:00",
          "admittedBy": "bypass:condition-key",
          "sourcePlan": null,
          "duplicateOf": null,
          "sourceItems": null,
          "conditionKey": "alarm:green-main-slo:%5B%22papercusp-workspace%22%2C%22papercusp%22%2C%22queue-idle%22%2C%22green-main-slo%3Apapercusp%3Aqueue-idle%3A0e2f2291d5778a59fd18c5f0ef29f76b2ed7ae0e%3A1792076057282%22%2C%220e2f2291d5778a59fd18c5f0ef29f76b2ed7ae0e%22%5D",
          "stateChangedAt": "2026-10-15T16:02:16.743+00:00"
        }
      },
      "reconciliation": {
        "id": "WI-6554700010014933",
        "frozenSourceSha256": "5cb9d99bca32756b1fcbcb1e281273922d3b586327fd5c432e0ae09588a1882f",
        "frozenState": "open",
        "frozenFloors": [
          "live-gate-ops",
          "claim-hold"
        ],
        "priorDisposition": "unassessed",
        "currentBatch": 14,
        "currentState": "open",
        "currentHolder": null,
        "currentAdmission": "auto",
        "currentControlKeys": [
          "_claimHold",
          "claim_hold_at",
          "claim_hold_by",
          "claim_hold_reason",
          "claim_hold_release",
          "implementationReadiness"
        ],
        "changedProjectedControlKeys": [],
        "unmeasuredFrozenControlKeys": [
          "freshnessEnvelope",
          "reporter"
        ],
        "assessment": "condition-and-clearer-legitimacy-unresolved",
        "finalR1Disposition": "unresolved"
      },
      "conditionIdentity": {
        "key": "alarm:green-main-slo:%5B%22papercusp-workspace%22%2C%22papercusp%22%2C%22queue-idle%22%2C%22green-main-slo%3Apapercusp%3Aqueue-idle%3A0e2f2291d5778a59fd18c5f0ef29f76b2ed7ae0e%3A1792076057282%22%2C%220e2f2291d5778a59fd18c5f0ef29f76b2ed7ae0e%22%5D",
        "decodedWorkspaceInstallMetricEpisodeSubject": [
          "papercusp-workspace",
          "papercusp",
          "queue-idle",
          "green-main-slo:papercusp:queue-idle:0e2f2291d5778a59fd18c5f0ef29f76b2ed7ae0e:1792076057282",
          "0e2f2291d5778a59fd18c5f0ef29f76b2ed7ae0e"
        ],
        "datedPostFreezeKeyEqual": true,
        "frozenRawExportOmitsConditionKey": true,
        "historicalFrozenKeyUnproven": true
      },
      "sourceConditionedReservation": "The saved exact metric-slot key matches the witnessed current self-select reservation. The SQL floor depends on condition_key, not current gate ownership or holder liveness. No historical loaded-source identity is asserted.",
      "clearerQualification": {
        "conditionProducer": "greenMainSloConditionKey/runGreenMainSloPass source witness; historical emission not read",
        "conditionResolver": "Existing watchdog: measuredRecovery or explicitlySupersededByNewQueue, with distinct resolution summary. Supersession is not measured recovery or a durable fix.",
        "manualParkReleaseContract": {
          "owner": "su-e8a2c2bb-7cf2-4b35-af9a-37b13efc1a06",
          "trigger": "work-item:done:WI-10006055",
          "evidence": "a live resolver or producer registration can still satisfy the condition",
          "condition": "Re-evaluate this duplicate queue-idle gate alarm after the current gate owner completes WI-10006055.",
          "reachability": "reachable"
        },
        "recordedReleaseOwner": "su-e8a2c2bb-7cf2-4b35-af9a-37b13efc1a06",
        "currentAuthenticatedNamedClearer": null,
        "currentGateOwnership": "UNMEASURED; intentionally not queried",
        "triggerLimit": "Gate-item completion or release:green is a wake/recheck trigger, not exact episode recovery or park clearance proof.",
        "independentControls": "Self-select reservation, durable park, external blocker, review/readiness and lifecycle guards remain separate."
      },
      "executionQualification": "No new execution or original-scope fix demonstrated. Saved state and missing holder do not authorize claim, release or monitoring.",
      "finalR1Disposition": "UNRESOLVED: historical condition truth/source identity, legitimate exception, current named authenticated authority and original-scope execution."
    }
  ],
  "verification": {
    "exactOriginalIdEquality": true,
    "rawFrozenHashesVerified": true,
    "usedBatchHashesVerified": true,
    "sourceHashesStable": true,
    "testsRun": [],
    "newLedgerQueries": false,
    "sourceOrControlMutations": false,
    "liveGateOperations": false
  },
  "limits": [
    "Frozen export omits condition_key; later equal saved keys do not prove its original value or historical loaded evaluator.",
    "Source/test witnesses are not executed tests or loaded runtime proof.",
    "Supersession, measured recovery, park clearance and durable implementation are distinct.",
    "No current gate owner/liveness or current condition state inferred from dated evidence.",
    "Full original R1 and full8R26/WI5744/D025OFF remain OPEN; latter are not R1 prerequisites."
  ]
}

