---
rel_path: "evidence/cupboard-themes-2026-09-05/acceptance-evidence-index.json"
updated_at: 1788707791739
_body: "content"
---

{
  "schemaVersion": "cupboard-themes-acceptance-evidence-v1",
  "plan": "cupboard-themes-2026-09-05",
  "auditHeadSha": "3fcedffa782151487614b85686dd8823b12618ee",
  "sourceWorkItems": ["WI-2147347", "WI-2147348", "WI-2147349", "WI-2147350", "WI-2147351", "WI-2147352"],
  "decisionTrace": {
    "governed-package-publication": ["D-001", "D-004"],
    "explicit-safe-lifecycle": ["D-002", "D-003", "D-004"],
    "single-live-catalog-runtime": ["D-003", "D-004"],
    "cupboard-user-journey": ["D-001", "D-002", "D-004"],
    "native-reload-and-recovery-proof": ["D-005"]
  },
  "artifacts": {
    "nativeArchive": {
      "ref": "artifact:papercusp/evidence/cupboard-themes-2026-09-05/native-tauri-20260906T041031Z.tar.gz.b64",
      "encoding": "tar.gz+base64",
      "contentChars": 296624,
      "sha256": "3e7ed3f25fca8b037907a614fb7900ecb2eb24b42abecc82fbefd0572d9b25a4",
      "loadVerified": true
    },
    "nativeManifest": {
      "ref": "artifact:papercusp/evidence/cupboard-themes-2026-09-05/native-tauri-20260906T041031Z.manifest.json",
      "sha256": "867eb805d9f6827f8bb840bc505c514d3beb4a0e003a387f546aec952c109bc4",
      "fileCount": 9,
      "loadVerified": true
    },
    "verifierTranscript": {
      "ref": "artifact:papercusp/evidence/cupboard-themes-2026-09-05/native-tauri-20260906T041031Z.transcript.json",
      "sha256": "c274e8a8a3102023f7fefbb8c66f0e04fd3a92e23c5d4ca988fc0960f7023884",
      "recordCount": 13,
      "sourceSession": "codex:01a074ab-7ae2-74a1-ab02-656fe674d28b",
      "partRange": [344, 356],
      "loadVerified": true,
      "contains": ["verbatim isolated-db verifier command", "exit_code=0", "[PASS] no-errors", "frozen SPA and assertion-script provenance"]
    },
    "verifierSource": {
      "path": "scripts/verify-cupboard-theme-journey.sh",
      "sha256": "26f200e94b6120b0166cf0b8560ce011fff0ce1bfcf60eae8e32a1c450b3b2fb"
    },
    "screenshot": {
      "member": "fallback.png",
      "sha256": "6f4ac546acbbcd16231b7875a0f5ce92d723f2ff3b10a79ebd62aef2a23a2ebb"
    }
  },
  "nativeRun": {
    "command": "VERIFY_TAURI_DISPLAY_NUM=136 VERIFY_TAURI_ASSERT_SNAPSHOT_CONTAINS='staleTime:0,persist:!1' VERIFY_TAURI_ISOLATED_DB=1 VERIFY_TAURI_ISOLATED_SEED=ready scripts/verify-tauri-headless.sh -- bash scripts/verify-cupboard-theme-journey.sh",
    "result": "exit 0",
    "bundleBinding": {
      "treeStamp": "3fcedffa782151487614b85686dd8823b12618ee",
      "requiredSnapshotMarkers": ["staleTime:0", "persist:false"],
      "wrapperEvidence": "transcript records the pre-boot file-backed assertion snapshot and frozen SPA snapshot"
    },
    "negativeControl": {
      "kind": "fail-if-present DOM sentinel",
      "selector": ".pc-theme-acceptance-negative-control",
      "source": "scripts/verify-cupboard-theme-journey.sh:233",
      "failureMode": "the verifier exits 1 if the impossible selector unexpectedly resolves; this is not a separately built binary"
    },
    "assertedLayers": ["fresh migrated isolated PG", "HTTP API", "themes.catalog", "profile theme_id", "workspace cache", "mounted custom-theme CSS", "computed CSS", "real reload", "console cleanliness", "screenshot"]
  },
  "tests": {
    "aggregate": {
      "result": "16 files passed; 232 tests passed",
      "sourceSessionPart": "codex:01a074ab-7ae2-74a1-ab02-656fe674d28b#362-368",
      "files": [
        "packages/operator-core/lib/theme-tokens.test.ts",
        "packages/operator-core/lib/custom-themes.test.ts",
        "packages/operator-core/lib/cupboard/types.test.ts",
        "packages/operator-core/lib/cupboard/theme-store.test.ts",
        "packages/operator-core/lib/cupboard/install-theme-io.test.ts",
        "packages/operator-core/lib/cupboard/publish-theme-core.test.ts",
        "packages/operator-core/lib/cupboard/theme-catalog-sync.test.ts",
        "packages/operator-core/lib/agent-tools/cupboard/theme-registration.test.ts",
        "apps/operator/lib/theme.test.ts",
        "apps/operator/lib/theme-catalog.test.tsx",
        "apps/operator/app/_components/ThemeSelector.test.tsx",
        "apps/operator/app/settings/personalization/ThemeEditor.test.tsx",
        "apps/operator/app/cupboard/[id]/ThemeInstall.test.tsx",
        "apps/operator/app/cupboard/__tests__/CupboardClient.test.tsx",
        "apps/operator-public/src/__tests__/listings.test.ts",
        "apps/operator-public/src/__tests__/migration-024-rebuild.test.ts"
      ]
    },
    "focusedRuntime": {
      "result": "5 files passed; 55 tests passed",
      "files": [
        "packages/operator-core/lib/theme-tokens.test.ts",
        "apps/operator/lib/theme-catalog.test.tsx",
        "apps/operator/lib/theme.test.ts",
        "packages/operator-core/lib/cupboard/theme-catalog-sync.test.ts",
        "libs/generic/sync/src/server/invalidation-bus.test.ts"
      ]
    },
    "migration": {
      "source": "apps/operator-public/migrations/024_theme_kind.sql",
      "replayTest": "apps/operator-public/src/__tests__/migration-024-rebuild.test.ts"
    }
  },
  "limitations": [
    "The original throwaway verifier work directory and tauri.log were garbage-collected before closeout.",
    "The durable substitute is the indexed command/result transcript plus nine native JSON/PNG outputs and their hashes; no product test or Tauri rerun was performed during closeout."
  ]
}

