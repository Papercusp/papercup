---
rel_path: "evidence/cupboard-themes-2026-09-05/rubric-v3-amendment-text.json"
updated_at: 1788708647593
_body: "content"
---

{
  "schemaVersion": "acceptance-bar-amendment-text-v1",
  "rubricRef": "acceptance-cupboard-themes-2026-09-05",
  "subjectPlan": "cupboard-themes-2026-09-05",
  "expectedRubricRevision": 2,
  "expectedSubjectPlanRevision": 25,
  "nextBarSetHash": "a48aee7d11004b9bfbf3ed7be28e7612a4009fd614dd990330d8c6e0514952d6",
  "howNextBarHashDerived": {
    "rule": "The server discards caller-supplied barHash, normalizes canonical BAR meaning, and computes SHA-256 over key + model/condition + falsifier + required scope/test layers + evidence plane + role/mandatory/pass semantics.",
    "source": "packages/operator-core/lib/rubrics.ts:1253-1297",
    "previewSource": "rubrics:amend dryRun invocation 25711255"
  },
  "bars": [
    {
      "barKey": "R-1",
      "nextBarHash": "3c7a4b12fb86662aeebf9cd3732fccd84285b0d5027b847f8ac3cdf6eb6ad9ca",
      "title": "Themes are governed, inert Cupboard packages rather than executable or parallel artifacts",
      "model": "Per D-001 and D-004, a versioned semantic-token theme.json plus ordinary listing/release metadata travels through the existing Cupboard review, visibility, release, search, facet, migration, and install-action contracts. The reader materializes only the declared semantic-token/base/metadata fields; arbitrary stylesheet, code, and remote-asset fields are never consumed or executed.",
      "method": "Trace D-001/D-004 through packages/operator-core/lib/cupboard/theme-store.ts, types.ts, publish-theme-core.ts, packages/operator-core/lib/agent-tools/cupboard/theme-registration.test.ts, apps/operator-public/migrations/024_theme_kind.sql, and the publication/listing/migration tests named in artifact:papercusp/evidence/cupboard-themes-2026-09-05/acceptance-evidence-index.json. Confirm readThemeDir only extracts semantic tokens/base/metadata; theme-store.test.ts rejects wrong-kind, unsupported-schema, unsafe-CSS, primitive-reference, and non-semantic-token packages; types.test.ts pins theme to the install action; listings.test.ts pins theme filtering through ordinary approved catalog policy.",
      "falsifier": "Degraded if any desktop/public kind surface omits theme, approved-theme filtering/facets diverge, or the install action mapping differs. Broken if wrong-kind or unsafe/non-semantic package bytes materialize, any publisher-authored stylesheet/code/remote-asset field influences CSS or executes, migration 024 loses existing rows/indexes/triggers, publish/list/search bypasses ordinary governance, or the production agent doors are absent.",
      "driftMarkers": "Degraded if any desktop/public kind surface omits theme, approved-theme filtering/facets diverge, or the install action mapping differs. Broken if wrong-kind or unsafe/non-semantic package bytes materialize, any publisher-authored stylesheet/code/remote-asset field influences CSS or executes, migration 024 loses existing rows/indexes/triggers, publish/list/search bypasses ordinary governance, or the production agent doors are absent.",
      "replication": "Current closeout evidence: inspect the load-verified acceptance-evidence-index (aggregate result exactly 16 files/232 tests) and the cited source/test paths; do not rerun for this owner-directed closeout. A future independent reproduction runs packages/operator-core/lib/cupboard/theme-store.test.ts, publish-theme-core.test.ts, types.test.ts, packages/operator-core/lib/agent-tools/cupboard/theme-registration.test.ts, apps/operator-public/src/__tests__/listings.test.ts, and migration-024-rebuild.test.ts, expecting every file to pass and migration replay to retain prior objects.",
      "requiredTestLayers": [
        "integration"
      ],
      "check": {
        "kind": "instrument",
        "instrumentKey": "none"
      }
    },
    {
      "barKey": "R-2",
      "nextBarHash": "0b80dfda2538c04b1bde1f216e1972a29a52f25b8bdf54ed1f9d67117098c8ea",
      "title": "Install, explicit update, rollback, concurrency, and removal preserve user state and package integrity",
      "model": "Per D-002, D-003, and D-004, install adds availability without selecting; identical reinstall is a no-op; update is explicit, atomic, and preserves the stable source-qualified selection id; failure/concurrency leaves a valid prior-or-new package; package bytes remain authoritative instead of being copied into themes/custom.json; local and built-in identities remain protected; removal deletes only the installed package and explicitly falls back if it was active.",
      "method": "Inspect packages/operator-core/lib/cupboard/install-theme-io.ts and install-theme-io.test.ts plus apps/operator/app/cupboard/[id]/ThemeInstall.test.tsx. The IO suite names first install, implicit-overwrite refusal, same-release no-op, serialized concurrent explicit updates, rollback/failure, collision, and package-only removal; the component suite explicitly asserts update leaves activeThemeId unchanged and active removal uses writeActiveTheme fallback. Confirm the installer writes only themes/installed and the independent local theme survives removal.",
      "falsifier": "Degraded if identical reinstall rewrites state, source/version provenance is lost, or install changes the active preference. Broken if explicit update changes the selection id or deselects the active theme; a failed/concurrent update corrupts the package; remote identity clobbers local/built-in themes; install/update copies package data into themes/custom.json or a second catalog; rollback loses the prior version; or removal deletes local definitions/fails active fallback.",
      "driftMarkers": "Degraded if identical reinstall rewrites state, source/version provenance is lost, or install changes the active preference. Broken if explicit update changes the selection id or deselects the active theme; a failed/concurrent update corrupts the package; remote identity clobbers local/built-in themes; install/update copies package data into themes/custom.json or a second catalog; rollback loses the prior version; or removal deletes local definitions/fails active fallback.",
      "replication": "Current closeout evidence: acceptance-evidence-index records the 16-file/232-test aggregate and maps this criterion to WI-2147349/WI-2147351. A future reproduction runs packages/operator-core/lib/cupboard/install-theme-io.test.ts and apps/operator/app/cupboard/[id]/ThemeInstall.test.tsx, expecting the named no-op/update/concurrency/removal cases to pass; inspect themes/installed versus themes/custom.json before and after the temporary-workspace cases.",
      "requiredTestLayers": [
        "integration"
      ],
      "check": {
        "kind": "instrument",
        "instrumentKey": "none"
      }
    },
    {
      "barKey": "R-3",
      "nextBarHash": "dbb03f08754ccf0d55816f0d6a3ea12e93756ef1f0de34070ce1d8adb323dfb1",
      "title": "Runtime, Personalization, and navbar picker observe one current workspace-isolated catalog",
      "model": "Per D-003 and D-004, runtime and both existing controls consume the same @papercusp/sync themes.catalog. A committed write calls notifySyncInvalidate with a zero dedupe window; SSE is the primary convergence transport and POLLING is only degraded fallback. Transient/loading reads retain workspace-scoped last-known-good data, a stale hydrated result cannot become authority, and active custom semantic tokens deterministically outrank base aliases.",
      "method": "At the unit/integration seam only, inspect packages/operator-core/lib/cupboard/theme-catalog-sync.ts (THEME_CATALOG_QUERY and notifySyncInvalidate), apps/operator/lib/theme.ts (sync-backed catalog, staleTime:0, persist:false), and their tests. Use the load-verified evidence index's focused runtime record: packages/operator-core/lib/theme-tokens.test.ts, apps/operator/lib/theme-catalog.test.tsx, apps/operator/lib/theme.test.ts, packages/operator-core/lib/cupboard/theme-catalog-sync.test.ts, and libs/generic/sync/src/server/invalidation-bus.test.ts all passed as a 5-file/55-test set.",
      "falsifier": "Degraded if a transient/loading read hides last-known-good entries or a fallback poll is needed after an SSE invalidation. Broken if catalog convergence occurs only under POLLING; notifySyncInvalidate does not target themes.catalog at zero dedupe; controls/runtime disagree; workspace themes leak; stale hydrated data is accepted as settled authority; or base-theme CSS wins over active custom semantic tokens. Native hard-reload truth is intentionally owned only by R-5.",
      "driftMarkers": "Degraded if a transient/loading read hides last-known-good entries or a fallback poll is needed after an SSE invalidation. Broken if catalog convergence occurs only under POLLING; notifySyncInvalidate does not target themes.catalog at zero dedupe; controls/runtime disagree; workspace themes leak; stale hydrated data is accepted as settled authority; or base-theme CSS wins over active custom semantic tokens. Native hard-reload truth is intentionally owned only by R-5.",
      "replication": "Current closeout: verify the five exact focused files and 55-test pass record in acceptance-evidence-index without rerunning. A future independent reproduction runs those five files, expects 5/5 files and 55/55 tests, and inspects theme-catalog-sync.ts:16 plus theme.ts:235-246 to confirm SSE invalidation and stale-hydration policy.",
      "requiredTestLayers": [
        "integration"
      ],
      "check": {
        "kind": "instrument",
        "instrumentKey": "none"
      }
    },
    {
      "barKey": "R-4",
      "nextBarHash": "fd9b02acaed66298ae96af630fa4b0639ad94a1ffbb26b0dcdf6a265b7aecc46",
      "title": "The existing Cupboard and theme controls expose a coherent install/use/update/remove journey",
      "model": "Per D-001, D-002, and D-004, existing Cupboard components browse and safely preview Themes; Install leaves active theme_id unchanged; Use theme and both canonical controls select through the shared writer; Update and Remove remain explicit; provenance and Edit as copy remain visible; keyboard/radio semantics remain intact. This criterion owns component/action semantics, not native reload internals.",
      "method": "Grade component/action behavior from apps/operator/app/cupboard/[id]/ThemeInstall.test.tsx, apps/operator/app/_components/ThemeSelector.test.tsx, apps/operator/app/settings/personalization/ThemeEditor.test.tsx, and apps/operator/app/cupboard/__tests__/CupboardClient.test.tsx. ThemeInstall.test.tsx is the structured D-002 check that install/update leaves activeThemeId unchanged. Use the native transcript only to confirm the rendered Themes category and both controls were reachable; R-5 exclusively owns update/reload/storage/CSS recovery claims.",
      "falsifier": "Degraded if palette/provenance/action labels are missing, keyboard/radio selection regresses, or Edit as copy remains coupled to installed bytes. Broken if Install forces selection; Use theme or either existing control cannot select through the canonical writer; explicit Update/Remove actions fail; active removal leaves an invalid selection; or component tests no longer pin unchanged activeThemeId after install/update.",
      "driftMarkers": "Degraded if palette/provenance/action labels are missing, keyboard/radio selection regresses, or Edit as copy remains coupled to installed bytes. Broken if Install forces selection; Use theme or either existing control cannot select through the canonical writer; explicit Update/Remove actions fail; active removal leaves an invalid selection; or component tests no longer pin unchanged activeThemeId after install/update.",
      "replication": "Current closeout: inspect the four named component files within the load-verified 16-file/232-test record and transcript stages 2-4; no rerun. A future reproduction runs those four files and then one isolated native pass only if live evidence is absent/contradictory, requiring Themes browse, Personalization, navbar switch-away/back, and no console errors.",
      "requiredTestLayers": [
        "integration",
        "e2e"
      ],
      "check": {
        "kind": "instrument",
        "instrumentKey": "none"
      }
    },
    {
      "barKey": "R-5",
      "nextBarHash": "7c5d7fd27a026af8244ac07130ded317ff56ca05cd93a36165d2018d73b02fc9",
      "title": "A fresh migrated native desktop preserves live theme state across update, reload, invalid input, and removal",
      "model": "Per D-005, a frozen production SPA and assertion-script snapshot running against an isolated fresh migrated database proves the installed theme reaches exact colors, committed update repaints #ff8c42 to #7c3aed, real reload agrees across profile/API/catalog/cache/mounted CSS/computed style, invalid CSS input is rejected without mutation, active removal returns to Frost, the console stays clean, a fail-if-present negative-control sentinel remains absent, and a screenshot is produced.",
      "method": "MUST open artifact:papercusp/evidence/cupboard-themes-2026-09-05/acceptance-evidence-index.json, then its load-verified native archive, nine-file manifest, and verifier transcript. Confirm audited tree stamp 3fcedffa782151487614b85686dd8823b12618ee; command markers staleTime:0,persist:false; isolated DB/ready seed; transcript exit_code 0 and [PASS] no-errors; JSON values #7c3aed across catalog/profile/cache/mounted/computed layers; invalid status 400 with Frost unchanged; removal status 204; screenshot SHA 6f4ac546…; verifier source SHA 26f200e9…. The negative control is accurately defined by scripts/verify-cupboard-theme-journey.sh:233 as a fail-if-present .pc-theme-acceptance-negative-control DOM sentinel, not a separately built binary.",
      "falsifier": "Degraded if any cited artifact/hash is missing, mismatched, stale, non-isolated, or cannot bind to the audited tree/snapshot markers. Broken if transcript is not exit 0; live update/reload fails; any authoritative layer differs from #7c3aed; cached/mounted CSS is absent; invalid input mutates state; removal fails to return Frost; console errors appear; screenshot is empty; or the negative-control sentinel unexpectedly resolves. Per D-005, class criterion gate-green-shipped remains unknown until the audited path blobs are promoted and deployed; current product evidence alone is not shipment proof.",
      "driftMarkers": "Degraded if any cited artifact/hash is missing, mismatched, stale, non-isolated, or cannot bind to the audited tree/snapshot markers. Broken if transcript is not exit 0; live update/reload fails; any authoritative layer differs from #7c3aed; cached/mounted CSS is absent; invalid input mutates state; removal fails to return Frost; console errors appear; screenshot is empty; or the negative-control sentinel unexpectedly resolves. Per D-005, class criterion gate-green-shipped remains unknown until the audited path blobs are promoted and deployed; current product evidence alone is not shipment proof.",
      "replication": "For this owner-directed closeout, inspect the durable artifacts and hashes; do not rerun Tauri. If a future grader finds evidence missing or contradictory, rerun exactly: VERIFY_TAURI_ASSERT_SNAPSHOT_CONTAINS='staleTime:0,persist:!1' VERIFY_TAURI_ISOLATED_DB=1 VERIFY_TAURI_ISOLATED_SEED=ready scripts/verify-tauri-headless.sh -- bash scripts/verify-cupboard-theme-journey.sh. Require output dir JSON/PNG, THEME_TAURI_OK, exit 0, [PASS] no-errors, and the sentinel check to fail as designed; then compare verifier/source and bundle/tree fingerprints before accepting replacement evidence.",
      "requiredTestLayers": [
        "e2e"
      ],
      "check": {
        "kind": "instrument",
        "instrumentKey": "none"
      }
    }
  ]
}

