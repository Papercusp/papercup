import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import { buildIndex, selectRelatedTests } from "./related-tests.mjs";

test("runtime-loaded shell scripts select their dependent tests", () => {
  const rootDir = path.resolve("/fixture");
  const testFile = path.join(
    rootDir,
    "apps/operator/scripts/__tests__/kopia-healthcheck-source-age.test.ts",
  );
  const unrelatedTest = path.join(rootDir, "apps/operator/scripts/__tests__/other.test.ts");
  const healthcheckScript = path.join(
    rootDir,
    "apps/operator/scripts/systemd/kopia-healthcheck.sh",
  );
  const cacheBootstrap = path.join(
    rootDir,
    "apps/operator/scripts/systemd/kopia-cache-bootstrap.sh",
  );
  const files = new Map([
    [
      testFile,
      [
        "import { resolve } from 'node:path';",
        "import { readFileSync } from 'node:fs';",
        "const SOURCE_SCRIPT = resolve(__dirname, '../systemd/kopia-healthcheck.sh');",
        "const CACHE_BOOTSTRAP = resolve(__dirname, '../systemd/kopia-cache-bootstrap.sh');",
        "readFileSync(SOURCE_SCRIPT, 'utf8');",
        "readFileSync(CACHE_BOOTSTRAP, 'utf8');",
      ].join("\n"),
    ],
    [unrelatedTest, "import test from 'node:test'; test('unrelated', () => {});"],
    [healthcheckScript, "#!/usr/bin/env bash\nprintf 'healthcheck'\n"],
    [cacheBootstrap, "#!/usr/bin/env bash\nprintf 'cache bootstrap'\n"],
  ]);
  const fs = {
    list: () => [testFile, unrelatedTest],
    read: (file) => files.get(path.resolve(file)) ?? null,
    exists: (file) => files.has(path.resolve(file)),
  };

  const index = buildIndex({ rootDir, fs });

  assert.deepEqual(index.unresolved, new Set());
  assert.ok(index.deps.get(testFile)?.has(healthcheckScript));
  assert.ok(index.deps.get(testFile)?.has(cacheBootstrap));

  for (const changedPath of [healthcheckScript, cacheBootstrap]) {
    const result = selectRelatedTests({
      rootDir,
      changedPaths: [changedPath],
      fs,
      index,
      threshold: 0.95,
    });

    assert.equal(result.mode, "related");
    assert.deepEqual(result.selected, [testFile]);
  }
});
