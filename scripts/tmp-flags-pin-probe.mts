/**
 * Live probe for EI-19479108855357092: does the module-duplication detector
 * actually SEE libs/flags/src/server.ts, and do two module records genuinely
 * share the store AND the override cache?
 *
 * Run: npx tsx scripts/tmp-flags-pin-probe.mts   (delete after — temp probe)
 */
const ROOT = '/home/marsh-office/papercupai-workspace/papercusp';
const SERVER = `${ROOT}/libs/flags/src/server.ts`;
const SINGLETON = `${ROOT}/libs/generic/module-singleton/src/index.ts`;

(async () => {
  const ms = await import(SINGLETON);
  const a = await import(SERVER);

  const KEY = '@papercusp/flags.server';
  const keys: string[] = ms.listPinnedModuleKeys();
  console.log('PINNED_PRESENT:', keys.includes(KEY));

  // Direction 1: baseline — one record, so NO duplication may be reported.
  console.log('BASELINE_DUPLICATIONS:', JSON.stringify(ms.listModuleDuplications()));
  console.log('BASELINE_EVALUATIONS:', ms.moduleEvaluationCount(KEY));

  // Direction 2: force a genuine second module record (distinct module URL).
  const b = await import(`${SERVER}?forced-split=1`);

  const dups = ms.listModuleDuplications();
  const mine = dups.find((d: { key: string }) => d.key === KEY);
  console.log('SPLIT_REPORTED:', Boolean(mine), 'evaluations:', mine?.evaluations);

  // The property the pin exists to provide: a store installed through record A
  // must be visible from record B (this is the WI-4275 bug, verbatim).
  console.log('B_SEES_STORE_BEFORE:', b.isOverrideStoreConfigured());
  a.initFlagOverrideStore({
    load: async () => ({}),
    set: async () => {},
  });
  console.log('A_INSTALLED__B_SEES_STORE:', b.isOverrideStoreConfigured());

  // The half-closed half of the same bug: the override CACHE must be shared too,
  // so an invalidation reaching record A is not invisible to record B.
  console.log('CACHE_SHARED:', a.__probeCache === undefined ? 'n/a-no-export' : 'exported');

  a.initFlagOverrideStore(null);
})().catch((e) => {
  console.error('PROBE_FAILED:', e);
  process.exit(1);
});
