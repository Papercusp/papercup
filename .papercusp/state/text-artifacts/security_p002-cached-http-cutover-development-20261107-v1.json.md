---
rel_path: "security/p002-cached-http-cutover-development-20261107-v1.json"
updated_at: 1794027737682
_body: "content"
---

{
  "schema": "p002-component-development-v1",
  "plan": "app-security-runtime-boundaries-and-defense-in-depth-2026-10-31",
  "workItem": "WI-6554700010044290",
  "status": "LOCAL_TESTS_AND_SCOPED_TYPES_PASS",
  "scope": "Existing cached plugin HTTP dispatcher and maintained suite. Working-source component verification only.",
  "rootCause": "mountPluginApiRoutes read the registered cutover only during discovery. dispatchPluginApiRoute reused cached raw fetch handles after enforcement became enabled or its flag read failed.",
  "fix": "Immediately before cached fetch, permit legacy execution only when the current flag read explicitly returns false; true, errors and other values refuse with 403 plugin_invocation_authority_required. Registry misses still fall through.",
  "verification": {
    "before": {
      "session": 99851,
      "exit": 1,
      "result": "12 executed; exactly 2 new marker-presence failures and 10 controls passed",
      "ledgerRow": 23535661
    },
    "after": {
      "session": 36715,
      "exit": 0,
      "result": "12 passed,0 failed,0 skipped; requested1/executed1/matched1",
      "ledgerRow": 23535670
    },
    "typecheck": {
      "session": 26123,
      "exit": 0,
      "result": "LINT_TSC_RESULT label=operator-core scope=files exit=0 status=clean",
      "stamp": "2026-11-07T04:57:36.818Z",
      "scope": "Two named changed files only; full-compiler fallback does not establish a whole-project pass."
    },
    "provenance": {
      "head": "df01a886c5",
      "source": "local",
      "worktreeDirty": true,
      "testedPaths": "1/1 dirty",
      "childSubstituted": 0
    },
    "distinguishingTest": "Mount a plugin whose fetch writes a real marker. Dispatch with flagfalse and observe marker; remove it. Change read to true or rejection and dispatch the SAME cached route. Require no marker plus403. Restorefalse and require successful marker. Also require registry-miss null fallback.",
    "predictions": {
      "defect": "Cached fetch writes the marker after cutover despite successful setup control.",
      "alternative": "A setup/authorization failure prevents the positive-control marker, or an already-safe dispatcher prevents the post-cutover marker."
    },
    "actualObservation": "BEFORE both post-cutover marker checks failed; positive controls and ten existing tests passed. AFTER both transition guards and restored legacy controls passed."
  },
  "sources": [
    {
      "path": "packages/operator-core/lib/plugin-api-mount.ts",
      "sha256": "7a4dfe1bdc8e1fb2e7d1a50ecb9a15de1104ce4b7f9d079efa3730cbd7a0f85f"
    },
    {
      "path": "packages/operator-core/lib/plugin-api-mount.test.ts",
      "sha256": "ed410f3b7396fb9a22a05b997af841918f939f83e7995dbdda5b9cffcd868e28"
    }
  ],
  "logs": [
    {
      "path": "/tmp/security-p002-http-cutover-before-20261107.log",
      "sha256": "b56e9613e4b08c04f7d61c7c67836e6d5224f9e4db8cb3202f8f4c1ca149896c"
    },
    {
      "path": "/tmp/security-p002-http-cutover-final-20261107.log",
      "sha256": "7d4e3beefdd75dfd0a21c42b8db2a7d5a47f3606052ae88972d36bcb2842d557"
    },
    {
      "path": "/tmp/security-p002-http-cutover-types-20261107.log",
      "sha256": "cf59ede109d6a5ddbb3b33e1747beb5df71e4f4448fbfe14365fb7d62593f008"
    }
  ],
  "lockRelease": "eac8f58d-acaf-40eb-9d7f-19bb934358d9 and 1f798d06-9ec4-4060-9d4f-890db948081f explicitly released with native edit proof.",
  "reuse": "Extended the existing dispatcher, flag and maintained test suite. No new store, route or flag.",
  "limits": [
    "All seven population closures remain UNKNOWN; independent applicability and exact runtime/package occurrence binding remain OPEN.",
    "No confinement, SEC, rollout or shipment acceptance. P020 signed installed artifact proof remains mandatory.",
    "All16BAR20items,D008-D010,singleimplementer,noLIVE_GATE_OPS preserved."
  ]
}
