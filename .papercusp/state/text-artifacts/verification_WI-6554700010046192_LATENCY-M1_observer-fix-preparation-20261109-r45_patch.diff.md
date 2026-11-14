---
rel_path: "verification/WI-6554700010046192/LATENCY-M1/observer-fix-preparation-20261109-r45/patch.diff"
updated_at: 1794203412077
_body: "content"
---

diff --git a/packages/operator-core/lib/__tests__/vitest-startup-trace.test.ts b/packages/operator-core/lib/__tests__/vitest-startup-trace.test.ts
index c514bd5971..0161de95d8 100644
--- a/packages/operator-core/lib/__tests__/vitest-startup-trace.test.ts
+++ b/packages/operator-core/lib/__tests__/vitest-startup-trace.test.ts
@@ -382,6 +382,29 @@ describe('focused runner startup tracing', () => {
       const custody = readPartialNativeChannelCustody(producer, snapshot.nativeRun);
       expect(custody, JSON.stringify(custody)).toMatchObject({ status: 'bound',
         custody: { terminal: true, reporterPid: snapshot.nativeRun.pid } });
+      // This real reporter exceeds the module-event budget. Only that scoped
+      // gap is compatible with complete physical channel custody.
+      const traceRoot = `${out}.native-processes`;
+      const moduleLimit = readdirSync(traceRoot).filter(name => name.endsWith('.json'))
+        .map(name => ({ name, row: JSON.parse(readFileSync(join(traceRoot, name), 'utf8')) }))
+        .find(({ row }) => row.event === 'trace-limit' && row.observationScope === 'module' &&
+          row.pid === snapshot.nativeRun.pid && row.threadId === 0)!;
+      expect(moduleLimit).toBeDefined();
+      const originalLimit = readFileSync(join(traceRoot, moduleLimit.name));
+      for (const observationScope of [undefined, 'general']) {
+        const altered = { ...moduleLimit.row, observationScope };
+        const bytes = Buffer.from(JSON.stringify(altered));
+        const name = `${createHash('sha256').update(bytes).digest('hex')}.json`;
+        rmSync(join(traceRoot, moduleLimit.name));
+        writeFileSync(join(traceRoot, name), bytes);
+        try {
+          expect(readPartialNativeChannelCustody(producer, snapshot.nativeRun))
+            .toMatchObject({ status: 'refused', reason: 'native-channel-trace-gap' });
+        } finally {
+          rmSync(join(traceRoot, name));
+          writeFileSync(join(traceRoot, moduleLimit.name), originalLimit);
+        }
+      }
       const expected = { attemptId: producer.attemptId, root, taskKey: producer.taskKey,
         workspaceName: producer.workspaceName, producerPath: path,
         selectedSpecifications: selected.selectedSpecifications, manifest: { schemaVersion: 1,
@@ -803,6 +826,9 @@ describe('focused runner startup tracing', () => {
         await import(${JSON.stringify(preload)});
         let sum = 0;
         for (const url of ${JSON.stringify(modules)}) sum += (await import(url)).value;
+        const { channel } = await import('node:diagnostics_channel');
+        for (let index = 0; index < 200; index++)
+          channel('papercusp:api-worker-schema').publish({ unavailable: true });
         process.stdout.write(String(sum));`;
       const { stdout, stderr } = await promisify(execFile)(process.execPath,
         ['--input-type=module', '-e', source], { env, timeout: 10_000 });
@@ -814,6 +840,11 @@ describe('focused runner startup tracing', () => {
       expect(starts.length).toBeGreaterThan(0);
       expect(starts.length).toBeLessThanOrEqual(128);
       expect(rows.filter(row => row.event === 'module-load-limit')).toHaveLength(1);
+      expect(rows.filter(row => row.event === 'trace-limit').map(row => row.observationScope).sort())
+        .toEqual(['general', 'module']);
+      expect(rows.filter(row => row.event.startsWith('module-') &&
+        !['module-load-limit', 'module-resolve-limit'].includes(row.event)).length).toBeLessThanOrEqual(384);
+      expect(rows.filter(row => row.event === 'api-worker-schema-unavailable').length).toBeLessThanOrEqual(128);
       expect(rows.find(row => row.event === 'node-exit')).toMatchObject({ code: 0 });
     } finally { rmSync(dir, { recursive: true, force: true }); }
   });
diff --git a/scripts/lib/partial-task-resume.mjs b/scripts/lib/partial-task-resume.mjs
index 82590101bb..3e01a4ad61 100644
--- a/scripts/lib/partial-task-resume.mjs
+++ b/scripts/lib/partial-task-resume.mjs
@@ -421,7 +421,12 @@ export function readPartialNativeChannelCustody(producer, native, { allowInterru
     const { rows, sourceRoot, population } = readNativeProcessTraceArtifacts(channel.traceOut);
     if (!population.complete) return refused("native-channel-trace-incomplete");
     const observations = rows.map(value => value.row);
-    if (observations.some(row => ["trace-limit", "trace-event-too-large", "native-channel-unavailable"].includes(row.event)))
+    // Module observations have a separate bounded portion of the writer's
+    // allowance. Their gap still forbids complete-import proof, but cannot
+    // consume the process events used below. Legacy/unscoped and general
+    // gaps remain fatal to channel custody.
+    if (observations.some(row => row.event === "trace-limit" && row.observationScope !== "module" ||
+        ["trace-event-too-large", "native-channel-unavailable"].includes(row.event)))
       return refused("native-channel-trace-gap");
     // Worker preloads share a PID with the reporter. Keep their source evidence,
     // but use only the main thread to establish OS-process ancestry and custody.
diff --git a/scripts/lib/vitest-startup-trace.mjs b/scripts/lib/vitest-startup-trace.mjs
index ede6eeb8dd..7ca1d38ded 100644
--- a/scripts/lib/vitest-startup-trace.mjs
+++ b/scripts/lib/vitest-startup-trace.mjs
@@ -59,14 +59,19 @@ function installNativeProcessTrace(out) {
       try { unlinkSync(temporary); } catch { /* A killed writer may leave only staging evidence. */ }
     }
   };
-  let remaining = 512;
+  // Keep the 512 ordinary-event allowance, reserving process evidence so
+  // loader traffic cannot hide a later spawn/close. Each exhausted portion
+  // has its own marker; module gaps cannot establish complete imports.
+  const remaining = { module: 384, general: 128 };
   const emit = (event, fields = {}, terminal = false) => {
-    if (!terminal && remaining-- < 0) return;
+    const observationScope = event.startsWith('module-') ? 'module' : 'general';
+    if (!terminal && remaining[observationScope]-- < 0) return;
     try {
       let row = { schemaVersion: 1, kind: 'native-node-process-event', event,
         processIdentity: identity, kernelProcessIdentity,
         pid: process.pid, ppid: process.ppid, atMs: Date.now(), ...fields, threadId };
-      if (!terminal && remaining === -1) row = { ...row, event: 'trace-limit' };
+      if (!terminal && remaining[observationScope] === -1)
+        row = { ...row, event: 'trace-limit', observationScope };
       let bytes = Buffer.from(JSON.stringify(row));
       if (bytes.length > 128 * 1024) {
         bytes = Buffer.from(JSON.stringify({ schemaVersion: 1, kind: row.kind,

