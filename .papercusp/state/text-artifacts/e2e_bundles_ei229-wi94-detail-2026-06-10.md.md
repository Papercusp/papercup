---
rel_path: "e2e/bundles/ei229-wi94-detail-2026-06-10.md"
updated_at: 1781066799721
_body: "content"
---

# Capture bundle — EI-229 (Detail can't resolve WI-* ids)
Session su-24719 · 2026-06-10 ~04:38Z · staging :3170 · sidecar SHA 424517b5 · dedicated Tauri pid 3951158 (DISPLAY :92) · zero console errors at capture.

## URL at failure
http://127.0.0.1:3170/adv?tab=harnesses&slug=e2e-imp-sync1&ws=papercusp-workspace&focusSlug=e2e-imp-sync1&sel=WI-94

## DOM capture (verbatim)
FeaturesPanel group:
"Features · e2e-imp-sync1 (1) | All 1 | Running 0 | Stuck 0 | Blocked 0 | Todo 1 | Passed 0 | Deprecated 0 | ID STATUS | WI-94 Todo | 1/1 shown | J/K move · ↵ open · R reset · / search"

DetailPanel group:
"Detail | No item found for WI-94."

## Backend corroboration
work_items:get {id: WI-94, harness: e2e-imp-sync1} → ok:true, kind=feature, state=todo (item exists and is healthy; only the UI Detail lookup fails).
Counter-case: papercup F-DOGFOOD-001 click → ?sel=F-DOGFOOD-001 → Detail renders full feature (title/status/description).

## Screenshot
/tmp/e2e-su24719/ei229-wi94-detail.png (root :92 capture; /tmp-only — DOM evidence above is the canonical record).
