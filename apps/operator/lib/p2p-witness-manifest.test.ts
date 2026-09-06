import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildManifest } from "../../../scripts/p2p-witness-manifest.mjs";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "p2p-witness-manifest-"));
  await mkdir(join(root, "libs/papercusp/libs/db/sql"), { recursive: true });
  await mkdir(
    join(root, "libs/papercusp/packages/embedded-postgres-server/bin"),
    { recursive: true },
  );
  await writeFile(join(root, "package-lock.json"), '{"lockfileVersion":3}\n');
  await writeFile(
    join(root, "libs/papercusp/libs/db/sql/001.sql"),
    "create table witness;\n",
  );
  await writeFile(
    join(
      root,
      "libs/papercusp/packages/embedded-postgres-server/bin/build-seed.mjs",
    ),
    "export {};\n",
  );
  const output = join(root, "out");
  await mkdir(output, { recursive: true });
  await writeFile(join(output, "serve.mjs"), 'console.log("witness");\n');
  return { root, output };
}

describe("P2P witness manifest", () => {
  it("is deterministic and carries the source, runtime, migration, and seed identities", async () => {
    const f = await fixture();
    const args = {
      repoRoot: f.root,
      outputDir: f.output,
      sourceSha: "source-a",
      submoduleSha: "submodule-a",
    };
    const first = await buildManifest(args);
    const second = await buildManifest(args);
    expect(second).toEqual(first);
    expect(first.inputs.source).toEqual({
      superprojectSha: "source-a",
      papercuspSha: "submodule-a",
    });
    expect(first.inputs.runtime.bundleSha256).toHaveLength(64);
    expect(first.inputs.migrations[0].sha256).toHaveLength(64);
    expect(first.inputs.seeds[0].sha256).toHaveLength(64);
  });

  it("changes the artifact identity when an optional pack changes", async () => {
    const f = await fixture();
    const model = join(f.root, "model-pack");
    await mkdir(model);
    await writeFile(join(model, "weights.bin"), "v1");
    const first = await buildManifest({
      repoRoot: f.root,
      outputDir: f.output,
      sourceSha: "source-a",
      submoduleSha: "submodule-a",
      modelPackPath: model,
    });
    await writeFile(join(model, "weights.bin"), "v2");
    const second = await buildManifest({
      repoRoot: f.root,
      outputDir: f.output,
      sourceSha: "source-a",
      submoduleSha: "submodule-a",
      modelPackPath: model,
    });
    expect(first.inputs.optionalPacks.model?.sha256).not.toBe(
      second.inputs.optionalPacks.model?.sha256,
    );
    expect(first.artifactId).not.toBe(second.artifactId);
  });

  it("keeps identity across checkout, output, and external pack locations", async () => {
    const first = await fixture();
    const second = await fixture();
    const manifests = [];
    for (const [index, f] of [first, second].entries()) {
      const packs = await mkdtemp(join(tmpdir(), "p2p-witness-packs-"));
      const model = join(packs, `model-${index}`);
      const capability = join(packs, `capability-${index}`);
      await mkdir(model);
      await mkdir(capability);
      await writeFile(join(model, "weights.bin"), "identical weights");
      await writeFile(join(capability, "capabilities.json"), '{"shell":true}');
      manifests.push(
        await buildManifest({
          repoRoot: f.root,
          outputDir: f.output,
          sourceSha: "source-a",
          submoduleSha: "submodule-a",
          ...(index === 1
            ? {
                dependencyInputs: [join(f.root, "package-lock.json")],
                migrationInputs: [join(f.root, "libs/papercusp/libs/db/sql")],
                seedInputs: [
                  join(
                    f.root,
                    "libs/papercusp/packages/embedded-postgres-server/bin/build-seed.mjs",
                  ),
                ],
              }
            : {}),
          modelPackPath: model,
          capabilityPackPath: capability,
        }),
      );
    }
    expect(manifests[0].inputs.dependencies[0].path).not.toBe(
      manifests[1].inputs.dependencies[0].path,
    );
    expect(manifests[0].inputs.optionalPacks.model?.path).not.toBe(
      manifests[1].inputs.optionalPacks.model?.path,
    );
    expect(manifests[1].artifactId).toBe(manifests[0].artifactId);
  });

  it.each([
    "dependency",
    "migration",
    "seed",
    "runtime",
    "model",
    "capability",
    "source",
    "submodule",
  ])("changes identity when the %s input changes", async (input) => {
    const f = await fixture();
    const model = join(f.root, "model");
    const capability = join(f.root, "capability");
    await mkdir(model);
    await mkdir(capability);
    await writeFile(join(model, "weights.bin"), "v1");
    await writeFile(join(capability, "capabilities.json"), "{}");
    const args = {
      repoRoot: f.root,
      outputDir: f.output,
      sourceSha: "source-a",
      submoduleSha: "submodule-a",
      modelPackPath: model,
      capabilityPackPath: capability,
    };
    const before = await buildManifest(args);
    const paths: Record<string, string> = {
      dependency: join(f.root, "package-lock.json"),
      migration: join(f.root, "libs/papercusp/libs/db/sql/001.sql"),
      seed: join(
        f.root,
        "libs/papercusp/packages/embedded-postgres-server/bin/build-seed.mjs",
      ),
      runtime: join(f.output, "serve.mjs"),
      model: join(model, "weights.bin"),
      capability: join(capability, "capabilities.json"),
    };
    if (input === "source") args.sourceSha = "source-b";
    else if (input === "submodule") args.submoduleSha = "submodule-b";
    else await writeFile(paths[input], "changed bytes");
    const after = await buildManifest(args);
    expect(after.artifactId).not.toBe(before.artifactId);
  });

  it("uses canonical JSON for a stable manifest payload", async () => {
    const f = await fixture();
    const manifest = await buildManifest({
      repoRoot: f.root,
      outputDir: f.output,
      sourceSha: "source-a",
      submoduleSha: "submodule-a",
    });
    expect(manifest.schemaVersion).toBe(2);
    expect(manifest.artifactId).toMatch(/^[0-9a-f]{64}$/);
    expect(await readFile(join(f.output, "serve.mjs"), "utf8")).toContain(
      "witness",
    );
  });

  it("rejects named repository inputs outside the checkout", async () => {
    const f = await fixture();
    const outside = await fixture();
    await expect(
      buildManifest({
        repoRoot: f.root,
        outputDir: f.output,
        sourceSha: "source-a",
        submoduleSha: "submodule-a",
        dependencyInputs: [join(outside.root, "package-lock.json")],
      }),
    ).rejects.toThrow("witness input must be inside the repository");
  });
});
