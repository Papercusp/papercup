/** Inherited tooling is separate from the private product environment built by with-test-pg. */
const TOOLING_KEYS = new Set([
  'PATH', 'PATHEXT', 'SystemRoot', 'SYSTEMROOT', 'COMSPEC', 'WINDIR',
  'LANG', 'LANGUAGE', 'TZ', 'TERM', 'COLORTERM', 'NO_COLOR', 'FORCE_COLOR', 'CI',
  'LC_ALL', 'LC_CTYPE', 'LC_COLLATE', 'LC_MESSAGES', 'LC_MONETARY', 'LC_NUMERIC',
  'LC_TIME', 'LC_PAPER', 'LC_NAME', 'LC_ADDRESS', 'LC_TELEPHONE', 'LC_MEASUREMENT', 'LC_IDENTIFICATION',
  'NODE_OPTIONS', 'NODE_NO_WARNINGS', 'NODE_DISABLE_COLORS', 'NODE_EXTRA_CA_CERTS',
  'UV_THREADPOOL_SIZE', 'MALLOC_ARENA_MAX',
]);

const PRIVATE_PG_SEED_KEYS = Object.freeze([
  'PAPERCUSP_PG_SEED_PATH', 'PAPERCUSP_PG_RESTORE_BIN', 'PAPERCUSP_PG_DISABLE_SEED',
]);

/** The launcher's fixed evidence exceptions; runtime-owned paths are admitted separately. */
export function isolatedRuntimeEvidenceKeys(ownedTestDbDirectoryKey) {
  return new Set([
    // Verifier ownership identifies the enclosing managed task, not the private
    // product identity. Its receipt must survive runtime isolation for cleanup.
    'PAPERCUSP_CAPABILITY_BASH_BACKGROUND_TASK_ID',
    // Admission and committed-loader receipts are provenance, not product endpoints.
    'PAPERCUSP_RESTRICTED_HOLD_PREFLIGHT',
    'PAPERCUSP_COMMITTED_SOURCE_AUDIT', 'PAPERCUSP_COMMITTED_SOURCE_NOTICES',
    'PAPERCUSP_TEST_FILE_TIMEOUT_MS',
    'PAPERCUSP_ISOLATED_PROGRESS_FILE',
    'PAPERCUSP_TEST_RUNS_DB_URL', 'PAPERCUSP_TEST_RUN_RECEIPT_FILE',
    'PAPERCUSP_TEST_ARTIFACT_DIR',
    'PAPERCUSP_TEST_RUN_WORKSPACE', 'PAPERCUSP_TEST_RUN_HARNESS',
    'PAPERCUSP_TEST_RUN_WORK_ITEM', 'PAPERCUSP_TEST_RUN_OWNER_ID',
    'PAPERCUSP_TEST_RUN_GROUP', 'PAPERCUSP_TEST_RUN_SOURCE',
    ownedTestDbDirectoryKey,
    // The source-map reporter arms from its workspace and writes to these
    // explicit durable destinations. Dropping them can leave a passing worker
    // without the immutable source proof required by its enclosing verifier.
    'PC_EXECUTED_SOURCE_MAP_WORKSPACE', 'PC_EXECUTED_SOURCE_MAP_OUT',
    'PC_EXECUTED_SOURCE_MAP_RESULT',
    'PAPERCUSP_TEST_RUN_COMMIT', 'PAPERCUSP_TEST_RUN_CASE_TITLE_PATTERN',
    'PAPERCUSP_TEST_RUN_LOOP_LAG_P95_MS',
    // Mutation evidence retains the original checkout and selected descriptor reader.
    'PAPERCUSP_MUTATION_PROBE', 'PAPERCUSP_MUTATION_PHASE',
    'PAPERCUSP_MUTATION_PROBE_ORIGIN_ROOT', 'PAPERCUSP_MUTATION_PROBE_SUBJECT',
    'PAPERCUSP_MUTATION_DESCRIPTOR',
    'PAPERCUSP_MUTATION_DESCRIPTOR_READER_HEALTH_URL',
    'PAPERCUSP_MUTATION_DESCRIPTOR_READER_REPO',
    'PAPERCUSP_MUTATION_DESCRIPTOR_READER_REQUIRED',
    // Isolated fixtures write receipts under test-owned artifact directories.
    'ADMISSION_HTTP_EVIDENCE_DIR', 'BLOG_POST_EVIDENCE_DIR',
    'CONSULT_CASCADE_HTTP_EVIDENCE_DIR', 'CONTEXT_INJECTION_HTTP_EVIDENCE_DIR',
    'CUPBOARD_LISTING_INSTALL_EVIDENCE_DIR', 'CUSTOMER_DATA_HTTP_EVIDENCE_DIR',
    'GOVERNANCE_HTTP_EVIDENCE_DIR', 'GRADING_KERNEL_EVIDENCE_DIR',
    'GRADING_RUNTIME_EVIDENCE_DIR', 'HOSTED_SERVING_TEST_EVIDENCE_DIR',
    'INTEGRATIONS_SETUP_EVIDENCE_DIR', 'KNOWLEDGE_NATIVE_EVIDENCE_DIR',
    'LIVENESS_ALARM_HTTP_EVIDENCE_DIR', 'PC_GRADING_PROOF_EVIDENCE_DIR',
    'PLAN_ABSORPTION_HTTP_EVIDENCE_DIR', 'PLAN_CLEANUP_HTTP_EVIDENCE_DIR',
    'ROSTER_STOP_HTTP_EVIDENCE_DIR', 'STAGING_FIRST_HTTP_EVIDENCE_DIR',
    'SYNC_LINT_EVIDENCE_DIR', 'TASK_ARTIFACT_BASELINE_EVIDENCE_DIR',
    'TEST_EVIDENCE_DIR', 'VAULT_CENSUS_EVIDENCE_DIR',
  ]);
}

/** Preserve only the existing seed controls across testing:run's exact detached environment. */
export function privatePgSeedEnvironment(source = process.env) {
  return Object.fromEntries(PRIVATE_PG_SEED_KEYS.flatMap(key => {
    const value = source[key];
    return typeof value === 'string' && value.length > 0 ? [[key, value]] : [];
  }));
}

/**
 * Unknown keys are not tooling. A provider-name denylist misses both new providers
 * and application-specific queue/file destinations. Product roots and endpoints
 * are composed separately from owned runtime state, after this filter.
 *
 * evidenceKeys comes from the launcher's fixed, validated reporter/tool exceptions;
 * no caller-supplied list or new environment switch widens this boundary.
 */
export function isolatedRuntimeInheritedEnvironment(source, evidenceKeys) {
  const environment = {};
  const discardedKeys = [];
  for (const [key, value] of Object.entries(source)) {
    if (value === undefined) continue;
    if (evidenceKeys.has(key) || TOOLING_KEYS.has(key)) {
      environment[key] = value;
    } else {
      discardedKeys.push(key);
    }
  }
  return { environment, discardedKeys: discardedKeys.sort() };
}
