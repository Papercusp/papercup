---
rel_path: "evidence/cupboard-themes-2026-09-05/rubric-v3-amendment-request.json"
updated_at: 1788708528794
_body: "content"
---

{
  "dryRun": true,
  "reason": "Incorporate outside-lineage meta-acceptance critique: durable evidence, explicit D-001..D-005 trace, named falsifiers, non-overlapping component/native seams, reconstructible paths, and structural proof depth without rerunning product tests or Tauri.",
  "criteria": [
    {
      "key": "governed-package-publication",
      "role": "outcome",
      "check": {
        "kind": "instrument",
        "instrumentKey": "none"
      },
      "model": "Per D-001 and D-004, a versioned semantic-token theme.json plus ordinary listing/release metadata travels through the existing Cupboard review, visibility, release, search, facet, migration, and install-action contracts. The reader materializes only the declared semantic-token/base/metadata fields; arbitrary stylesheet, code, and remote-asset fields are never consumed or executed.",
      "title": "Themes are governed, inert Cupboard packages rather than executable or parallel artifacts",
      "barKey": "R-1",
      "method": "Trace D-001/D-004 through packages/operator-core/lib/cupboard/theme-store.ts, types.ts, publish-theme-core.ts, packages/operator-core/lib/agent-tools/cupboard/theme-registration.test.ts, apps/operator-public/migrations/024_theme_kind.sql, and the publication/listing/migration tests named in artifact:papercusp/evidence/cupboard-themes-2026-09-05/acceptance-evidence-index.json. Confirm readThemeDir only extracts semantic tokens/base/metadata; theme-store.test.ts rejects wrong-kind, unsupported-schema, unsafe-CSS, primitive-reference, and non-semantic-token packages; types.test.ts pins theme to the install action; listings.test.ts pins theme filtering through ordinary approved catalog policy.",
      "barHash": "e62c04efcfabc573dc225b18759ee5b568125678f751c4cdbf6c58ac8ac71d2a",
      "mandatory": true,
      "passRatings": [
        "pass"
      ],
      "replication": "Current closeout evidence: inspect the load-verified acceptance-evidence-index (aggregate result exactly 16 files/232 tests) and the cited source/test paths; do not rerun for this owner-directed closeout. A future independent reproduction runs packages/operator-core/lib/cupboard/theme-store.test.ts, publish-theme-core.test.ts, types.test.ts, packages/operator-core/lib/agent-tools/cupboard/theme-registration.test.ts, apps/operator-public/src/__tests__/listings.test.ts, and migration-024-rebuild.test.ts, expecting every file to pass and migration replay to retain prior objects.",
      "driftMarkers": "Degraded if any desktop/public kind surface omits theme, approved-theme filtering/facets diverge, or the install action mapping differs. Broken if wrong-kind or unsafe/non-semantic package bytes materialize, any publisher-authored stylesheet/code/remote-asset field influences CSS or executes, migration 024 loses existing rows/indexes/triggers, publish/list/search bypasses ordinary governance, or the production agent doors are absent.",
      "barProvenance": {
        "lifecycle": "legacy-backfilled",
        "declaredAt": "2026-09-06T05:28:20.770Z",
        "declaredBy": "su-f8444662-6d00-44af-9e03-0df4eaf0369f"
      },
      "evidencePlane": "tree",
      "requiredScope": [
        "tree"
      ],
      "requiredTestLayers": [
        "integration"
      ]
    },
    {
      "key": "explicit-safe-lifecycle",
      "role": "outcome",
      "check": {
        "kind": "instrument",
        "instrumentKey": "none"
      },
      "model": "Per D-002, D-003, and D-004, install adds availability without selecting; identical reinstall is a no-op; update is explicit, atomic, and preserves the stable source-qualified selection id; failure/concurrency leaves a valid prior-or-new package; package bytes remain authoritative instead of being copied into themes/custom.json; local and built-in identities remain protected; removal deletes only the installed package and explicitly falls back if it was active.",
      "title": "Install, explicit update, rollback, concurrency, and removal preserve user state and package integrity",
      "barKey": "R-2",
      "method": "Inspect packages/operator-core/lib/cupboard/install-theme-io.ts and install-theme-io.test.ts plus apps/operator/app/cupboard/[id]/ThemeInstall.test.tsx. The IO suite names first install, implicit-overwrite refusal, same-release no-op, serialized concurrent explicit updates, rollback/failure, collision, and package-only removal; the component suite explicitly asserts update leaves activeThemeId unchanged and active removal uses writeActiveTheme fallback. Confirm the installer writes only themes/installed and the independent local theme survives removal.",
      "barHash": "cc6c9c42c754d0f8a8be7bbd408a0f5eff0605dbda1e624ac60c29e09c44e630",
      "mandatory": true,
      "passRatings": [
        "pass"
      ],
      "replication": "Current closeout evidence: acceptance-evidence-index records the 16-file/232-test aggregate and maps this criterion to WI-2147349/WI-2147351. A future reproduction runs packages/operator-core/lib/cupboard/install-theme-io.test.ts and apps/operator/app/cupboard/[id]/ThemeInstall.test.tsx, expecting the named no-op/update/concurrency/removal cases to pass; inspect themes/installed versus themes/custom.json before and after the temporary-workspace cases.",
      "driftMarkers": "Degraded if identical reinstall rewrites state, source/version provenance is lost, or install changes the active preference. Broken if explicit update changes the selection id or deselects the active theme; a failed/concurrent update corrupts the package; remote identity clobbers local/built-in themes; install/update copies package data into themes/custom.json or a second catalog; rollback loses the prior version; or removal deletes local definitions/fails active fallback.",
      "barProvenance": {
        "lifecycle": "legacy-backfilled",
        "declaredAt": "2026-09-06T05:28:20.770Z",
        "declaredBy": "su-f8444662-6d00-44af-9e03-0df4eaf0369f"
      },
      "evidencePlane": "tree",
      "requiredScope": [
        "tree"
      ],
      "requiredTestLayers": [
        "integration"
      ]
    },
    {
      "key": "single-live-catalog-runtime",
      "role": "outcome",
      "check": {
        "kind": "instrument",
        "instrumentKey": "none"
      },
      "model": "Per D-003 and D-004, runtime and both existing controls consume the same @papercusp/sync themes.catalog. A committed write calls notifySyncInvalidate with a zero dedupe window; SSE is the primary convergence transport and POLLING is only degraded fallback. Transient/loading reads retain workspace-scoped last-known-good data, a stale hydrated result cannot become authority, and active custom semantic tokens deterministically outrank base aliases.",
      "title": "Runtime, Personalization, and navbar picker observe one current workspace-isolated catalog",
      "barKey": "R-3",
      "method": "At the unit/integration seam only, inspect packages/operator-core/lib/cupboard/theme-catalog-sync.ts (THEME_CATALOG_QUERY and notifySyncInvalidate), apps/operator/lib/theme.ts (sync-backed catalog, staleTime:0, persist:false), and their tests. Use the load-verified evidence index's focused runtime record: packages/operator-core/lib/theme-tokens.test.ts, apps/operator/lib/theme-catalog.test.tsx, apps/operator/lib/theme.test.ts, packages/operator-core/lib/cupboard/theme-catalog-sync.test.ts, and libs/generic/sync/src/server/invalidation-bus.test.ts all passed as a 5-file/55-test set.",
      "barHash": "71f643f113df601946e877d8a901e7f16dfcd1b31658cd356d7b5b4cce8386a7",
      "mandatory": true,
      "passRatings": [
        "pass"
      ],
      "replication": "Current closeout: verify the five exact focused files and 55-test pass record in acceptance-evidence-index without rerunning. A future independent reproduction runs those five files, expects 5/5 files and 55/55 tests, and inspects theme-catalog-sync.ts:16 plus theme.ts:235-246 to confirm SSE invalidation and stale-hydration policy.",
      "driftMarkers": "Degraded if a transient/loading read hides last-known-good entries or a fallback poll is needed after an SSE invalidation. Broken if catalog convergence occurs only under POLLING; notifySyncInvalidate does not target themes.catalog at zero dedupe; controls/runtime disagree; workspace themes leak; stale hydrated data is accepted as settled authority; or base-theme CSS wins over active custom semantic tokens. Native hard-reload truth is intentionally owned only by R-5.",
      "barProvenance": {
        "lifecycle": "legacy-backfilled",
        "declaredAt": "2026-09-06T05:28:20.770Z",
        "declaredBy": "su-f8444662-6d00-44af-9e03-0df4eaf0369f"
      },
      "evidencePlane": "tree",
      "requiredScope": [
        "tree"
      ],
      "requiredTestLayers": [
        "integration"
      ]
    },
    {
      "key": "cupboard-user-journey",
      "role": "outcome",
      "check": {
        "kind": "instrument",
        "instrumentKey": "none"
      },
      "model": "Per D-001, D-002, and D-004, existing Cupboard components browse and safely preview Themes; Install leaves active theme_id unchanged; Use theme and both canonical controls select through the shared writer; Update and Remove remain explicit; provenance and Edit as copy remain visible; keyboard/radio semantics remain intact. This criterion owns component/action semantics, not native reload internals.",
      "title": "The existing Cupboard and theme controls expose a coherent install/use/update/remove journey",
      "barKey": "R-4",
      "method": "Grade component/action behavior from apps/operator/app/cupboard/[id]/ThemeInstall.test.tsx, apps/operator/app/_components/ThemeSelector.test.tsx, apps/operator/app/settings/personalization/ThemeEditor.test.tsx, and apps/operator/app/cupboard/__tests__/CupboardClient.test.tsx. ThemeInstall.test.tsx is the structured D-002 check that install/update leaves activeThemeId unchanged. Use the native transcript only to confirm the rendered Themes category and both controls were reachable; R-5 exclusively owns update/reload/storage/CSS recovery claims.",
      "barHash": "72a7c582a6a6d827b36e1529b84a7269d99d582237911b7cd67feef74e3e2d4a",
      "mandatory": true,
      "passRatings": [
        "pass"
      ],
      "replication": "Current closeout: inspect the four named component files within the load-verified 16-file/232-test record and transcript stages 2-4; no rerun. A future reproduction runs those four files and then one isolated native pass only if live evidence is absent/contradictory, requiring Themes browse, Personalization, navbar switch-away/back, and no console errors.",
      "driftMarkers": "Degraded if palette/provenance/action labels are missing, keyboard/radio selection regresses, or Edit as copy remains coupled to installed bytes. Broken if Install forces selection; Use theme or either existing control cannot select through the canonical writer; explicit Update/Remove actions fail; active removal leaves an invalid selection; or component tests no longer pin unchanged activeThemeId after install/update.",
      "barProvenance": {
        "lifecycle": "legacy-backfilled",
        "declaredAt": "2026-09-06T05:28:20.770Z",
        "declaredBy": "su-f8444662-6d00-44af-9e03-0df4eaf0369f"
      },
      "evidencePlane": "live",
      "requiredScope": [
        "live"
      ],
      "requiredTestLayers": [
        "integration",
        "e2e"
      ]
    },
    {
      "key": "native-reload-and-recovery-proof",
      "role": "outcome",
      "check": {
        "kind": "instrument",
        "instrumentKey": "none"
      },
      "model": "Per D-005, a frozen production SPA and assertion-script snapshot running against an isolated fresh migrated database proves the installed theme reaches exact colors, committed update repaints #ff8c42 to #7c3aed, real reload agrees across profile/API/catalog/cache/mounted CSS/computed style, invalid CSS input is rejected without mutation, active removal returns to Frost, the console stays clean, a fail-if-present negative-control sentinel remains absent, and a screenshot is produced.",
      "title": "A fresh migrated native desktop preserves live theme state across update, reload, invalid input, and removal",
      "barKey": "R-5",
      "method": "MUST open artifact:papercusp/evidence/cupboard-themes-2026-09-05/acceptance-evidence-index.json, then its load-verified native archive, nine-file manifest, and verifier transcript. Confirm audited tree stamp 3fcedffa782151487614b85686dd8823b12618ee; command markers staleTime:0,persist:false; isolated DB/ready seed; transcript exit_code 0 and [PASS] no-errors; JSON values #7c3aed across catalog/profile/cache/mounted/computed layers; invalid status 400 with Frost unchanged; removal status 204; screenshot SHA 6f4ac546…; verifier source SHA 26f200e9…. The negative control is accurately defined by scripts/verify-cupboard-theme-journey.sh:233 as a fail-if-present .pc-theme-acceptance-negative-control DOM sentinel, not a separately built binary.",
      "barHash": "a6345906164137b79fa4154d8a6f748de3fd5684ce097577ac08eb5c336fca0e",
      "mandatory": true,
      "passRatings": [
        "pass"
      ],
      "replication": "For this owner-directed closeout, inspect the durable artifacts and hashes; do not rerun Tauri. If a future grader finds evidence missing or contradictory, rerun exactly: VERIFY_TAURI_ASSERT_SNAPSHOT_CONTAINS='staleTime:0,persist:!1' VERIFY_TAURI_ISOLATED_DB=1 VERIFY_TAURI_ISOLATED_SEED=ready scripts/verify-tauri-headless.sh -- bash scripts/verify-cupboard-theme-journey.sh. Require output dir JSON/PNG, THEME_TAURI_OK, exit 0, [PASS] no-errors, and the sentinel check to fail as designed; then compare verifier/source and bundle/tree fingerprints before accepting replacement evidence.",
      "driftMarkers": "Degraded if any cited artifact/hash is missing, mismatched, stale, non-isolated, or cannot bind to the audited tree/snapshot markers. Broken if transcript is not exit 0; live update/reload fails; any authoritative layer differs from #7c3aed; cached/mounted CSS is absent; invalid input mutates state; removal fails to return Frost; console errors appear; screenshot is empty; or the negative-control sentinel unexpectedly resolves. Per D-005, class criterion gate-green-shipped remains unknown until the audited path blobs are promoted and deployed; current product evidence alone is not shipment proof.",
      "barProvenance": {
        "lifecycle": "legacy-backfilled",
        "declaredAt": "2026-09-06T05:28:20.770Z",
        "declaredBy": "su-f8444662-6d00-44af-9e03-0df4eaf0369f"
      },
      "evidencePlane": "live",
      "requiredScope": [
        "live"
      ],
      "requiredTestLayers": [
        "e2e"
      ]
    }
  ],
  "rubricRef": "acceptance-cupboard-themes-2026-09-05",
  "idempotencyKey": "cupboard-themes-v3-structured-proof-20260906",
  "expectedRubricRevision": 2,
  "expectedSubjectPlanRevision": 25
}

