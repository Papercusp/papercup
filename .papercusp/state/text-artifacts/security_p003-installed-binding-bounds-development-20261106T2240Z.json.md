---
rel_path: "security/p003-installed-binding-bounds-development-20261106T2240Z.json"
updated_at: 1794004661004
_body: "content"
---

{
  "scope": "Development-only installed invoker allocation admission. Mock installed runtime admission/supervisor; no SEC, production routing, platform qualification or signed shipment claim.",
  "workItem": "WI-6554700010045702",
  "changes": "Preflight nonempty guest population <=1023 files, per-file <=256 MiB and cumulative <=512 MiB before any guest Buffer.from. Five maintained refusal cases cover empty/population/size/type failures before copying/admission/spawn; prior installation mutation and service binding tests retained.",
  "sourceSha256": {
    "packages/operator-core/lib/plugin-handler-execution.ts": "6345a6977589a49fe6427fa5fe639ca93d782f7e8c9b5572003fb72ca821ed6d",
    "packages/operator-core/lib/plugin-handler-execution.test.ts": "b9312f6c96978af947589ff9cb855d7c36fb365a087e0719f7e23f56f139fcbf"
  },
  "test": {
    "command": "PAPERCUSP_TEST_RUN_HARNESS=papercusp npm run test:file -- packages/operator-core/lib/plugin-handler-execution.test.ts",
    "log": "/tmp/security-p003-installed-binding-bounds-final-20261106.log",
    "logSha256": "b34854d959b27e19aa8f94f9f11af00e6b8a822eafda4f863eead6dacc28cdfa",
    "exitCode": 0,
    "passed": 15,
    "skipped": 0,
    "requested": 1,
    "executed": 1,
    "matched": 1,
    "childSubstituted": 0,
    "scopeStamp": "head=014b03f045, named test path DIRTY +25/-1; LOCAL source proof. Product/test source hashes independently recorded above; dependency graph not re-censused."
  },
  "types": {
    "command": "npm run lint:tsc -- --files=packages/operator-core/lib/plugin-handler-execution.ts,packages/operator-core/lib/plugin-handler-execution.test.ts",
    "log": "/tmp/security-p003-installed-binding-bounds-types-final-20261106.log",
    "logSha256": "887e3b3f8eb0ef46660d58e7f64c0239aa6c88b1ef11bd4e92a93fc91bb29065",
    "exitCode": 0,
    "files": 2,
    "errors": 0,
    "requestId": "343fa9bb-e6a5-41b2-a0c9-3ab84a49ef55",
    "scope": "Two named files only, not whole project. Initial fixture Buffer generic type error corrected; final checks above terminal."
  },
  "next": {
    "productionCaller": "packages/operator-core/lib/projected-tool-deps.ts aroundInvoke currently calls pluginInvocationChokepoint without executeHandler. plugin-invocation-policy.ts requires explicit executor and strictly refuses otherwise.",
    "guestContract": "handler-bootstrap.ts loads /handler/entry.cjs and expects invokeTool(name,input,{effect}) or requests. Ordinary SDK plugin exports Plugin.tools (ToolHandler(input,ToolContext)); production needs exact host tool exposure -> local tool mapping and an SDK guest adapter, not just a call to the generic factory.",
    "sources": [
      "packages/plugin-loader/src/index.ts metadata loader/createCorePluginLoader, locateEntry and registerPluginTools",
      "packages/plugin-sdk/src/index.ts ToolContext/ToolHandler",
      "packages/plugin-loader/src/daemon/handler-bootstrap.ts",
      "packages/operator-core/lib/plugin-host-runtime.ts getPluginHost and loaded installation metadata",
      "papercusp-desktop/bin/lib/handler-runtime-package.mjs",
      "packages/operator-core/lib/cupboard/install-plugin-core.ts installation provenance"
    ],
    "constraints": "Snapshot exact installed guest bundle/dependency bytes before async admission; don't evaluate plugin modules in host. Reuse existing runtime inventory, signed build producer, descriptor custody and checked capability services. Current source/vendor authority enrollment absent. All16 BAR/20 items, independent outside-lineage SEC applicability/preflight and P020 exact signed installed proof remain. Preserve supported normal journeys; no unreviewed fallback to tool.fn or request.invoke."
  }
}
