import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { constants as fsConstants } from 'node:fs';
import {
  parseLlamaServerUnit,
  diffUnitParams,
  diffCatalogAgainstDeployedUnit,
  describeUnitDrift,
  parseUnitExecStartBinary,
  checkUnitExecStartBinary,
  parseUnitEnvironment,
  checkRequiredEnvironment,
  describeEnvIssues,
} from './unit-drift';
import { CERTIFIED_CATALOG } from './catalog';

const ORNITH = CERTIFIED_CATALOG.find((e) => e.id === 'ornith-35b-iq3m-llama-server')!;

/**
 * The unit as it was ACTUALLY DEPLOYED on 2026-08-17, before P-009 restored it. Not a synthetic
 * mutant — it is the real drift, kept as the guard's control so the guard is proven against the
 * incident it was written for, on every run, on every machine, with no tree mutation and no
 * dependence on this box's filesystem.
 *
 * The binary and log paths are the ONLY things genericized from the original, because they are
 * per-box and are deliberately not compared (see unit-drift.ts's header). Every operative
 * parameter — and the self-contradictory Description that let the drift hide — is as deployed.
 */
const DRIFTED_UNIT = `[Unit]
Description=llama-server serving ornith-35b IQ3_M (local-concurrent-inference-2026-07-02 P-001) — 2 parallel slots x 64k ctx (real OMP su sessions send 52-64k-token requests), q8_0 KV
After=network.target

[Service]
Type=simple
ExecStart=/opt/llama.cpp/build/bin/llama-server \\
  -m /usr/share/ollama/.ollama/models/blobs/sha256-18f775956e1ee05608de578ad9e02b10f5b9c04d6eee59c48a0f38c897857298 \\
  --host 127.0.0.1 --port 11436 \\
  --flash-attn on \\
  -np 3 -c 614400 \\
  --cache-type-k q4_0 --cache-type-v q4_0 \\
  --alias maxwell1500/ornith-35b:IQ3_M
Restart=on-failure
RestartSec=5
Nice=5
StandardOutput=append:/var/tmp/llama-server-ornith.log
StandardError=append:/var/tmp/llama-server-ornith.log

[Install]
WantedBy=default.target
`;

/**
 * The unit as deployed AFTER the 2026-08-17 engine repoint (D-011/D-012) — the shape the catalog
 * now describes. Carries the two things WI-39735 added to the guard's range: an explicit `-ngl` and
 * the two load-bearing `Environment=` lines that are the difference between using the GPU and
 * silently serving from the CPU.
 *
 * Binary and log paths are genericized, as in DRIFTED_UNIT, because they are per-box and are
 * deliberately not compared.
 */
const CURRENT_UNIT = `[Unit]
Description=llama-server serving ornith-35b IQ3_M
After=network.target

[Service]
Type=simple
Environment=LD_LIBRARY_PATH=/usr/local/lib/ollama/cuda_v13:/usr/local/lib/ollama
Environment=GGML_BACKEND_PATH=/usr/local/lib/ollama/cuda_v13/libggml-cuda.so
ExecStart=/usr/local/lib/ollama/llama-server \\
  -m /usr/share/ollama/.ollama/models/blobs/sha256-18f775956e1ee05608de578ad9e02b10f5b9c04d6eee59c48a0f38c897857298 \\
  --host 127.0.0.1 --port 11436 \\
  --flash-attn on \\
  -ngl 999 \\
  -np 2 -c 180224 \\
  --cache-type-k q8_0 --cache-type-v q8_0 \\
  --alias maxwell1500/ornith-35b:IQ3_M
Restart=on-failure
RestartSec=5
Nice=5
StandardOutput=append:/var/tmp/llama-server-ornith.log
StandardError=append:/var/tmp/llama-server-ornith.log

[Install]
WantedBy=default.target
`;

/** Access stubs — the check takes `access` injected so none of this touches the real filesystem. */
const accessOk = async () => {};
const accessDenied = async () => {
  throw Object.assign(new Error('ENOENT: no such file or directory'), { code: 'ENOENT' });
};
/** Present, but without +x — F_OK succeeds while X_OK fails. */
const accessPresentNotExecutable = async (_path: string, mode: number) => {
  if (mode === fsConstants.X_OK) throw Object.assign(new Error('EACCES'), { code: 'EACCES' });
};

describe('checkUnitExecStartBinary (EI-20721621940954812)', () => {
  it('CONTROL: the parameter guard returns an IDENTICAL verdict for a startable and an unstartable unit', async () => {
    // This is the incident, reduced to one assertion. llama-ornith.service was 100% unstartable
    // (its hand-built ExecStart binary had been deleted; status=203/EXEC, NRestarts=182) and every
    // check in this module stayed GREEN, because the unit text still declared the right flags.
    //
    // Rather than assert that blindness in prose, MEASURE it: swapping the ExecStart binary for a
    // path that does not exist must not move the parameter diff by even one element. That is what
    // makes the separate existence check load-bearing rather than belt-and-braces — and if someone
    // later folds binaryPath into LlamaServerUnitParams, this test fails and tells them why.
    const startable = DRIFTED_UNIT;
    const unstartable = DRIFTED_UNIT.replace('/opt/llama.cpp/build/bin/llama-server', '/gone/llama.cpp/build/bin/llama-server');

    expect(diffCatalogAgainstDeployedUnit(ORNITH, unstartable)).toEqual(diffCatalogAgainstDeployedUnit(ORNITH, startable));

    // ...and the new check is what tells the two apart.
    expect((await checkUnitExecStartBinary(unstartable, accessDenied)).ok).toBe(false);
    expect((await checkUnitExecStartBinary(startable, accessOk)).ok).toBe(true);
  });

  it('reports a MISSING binary with the systemd failure it will actually produce', async () => {
    const check = await checkUnitExecStartBinary(DRIFTED_UNIT, accessDenied);
    expect(check.ok).toBe(false);
    expect(check.reason).toBe('missing');
    expect(check.binaryPath).toBe('/opt/llama.cpp/build/bin/llama-server');
    // Naming 203/EXEC is the point: the observed symptom was a 15-minute silent timeout that read
    // exactly like a slow 15.5GB model load, so the message has to carry the real diagnosis.
    expect(check.detail).toContain('203/EXEC');
  });

  it('distinguishes PRESENT-BUT-NOT-EXECUTABLE from missing — different operator fixes, same 203/EXEC', async () => {
    const check = await checkUnitExecStartBinary(DRIFTED_UNIT, accessPresentNotExecutable);
    expect(check.ok).toBe(false);
    expect(check.reason).toBe('not-executable');
    expect(check.detail).toContain('NOT executable');
  });

  it('passes a binary that exists and is executable', async () => {
    const check = await checkUnitExecStartBinary(DRIFTED_UNIT, accessOk);
    expect(check).toMatchObject({ ok: true, reason: 'ok', binaryPath: '/opt/llama.cpp/build/bin/llama-server' });
  });

  it('a unit with no ExecStart is NOT reported as ok', async () => {
    // The failure mode to avoid: "nothing to check" collapsing into a pass.
    const check = await checkUnitExecStartBinary('[Unit]\nDescription=nothing here\n', accessOk);
    expect(check.ok).toBe(false);
    expect(check.reason).toBe('no-execstart');
    expect(check.binaryPath).toBeNull();
  });
});

describe('parseUnitExecStartBinary', () => {
  it('reads the binary through systemd backslash continuations', () => {
    expect(parseUnitExecStartBinary(DRIFTED_UNIT)).toBe('/opt/llama.cpp/build/bin/llama-server');
  });

  it('strips ExecStart prefix modifiers, including combined ones', () => {
    // systemd allows `-` (ignore failure), `@` (set argv0), `+` (full privileges), `!`/`!!`, and
    // permits them combined. Leaving one attached yields a path that can never exist, i.e. a
    // guard that reports `missing` for a perfectly healthy unit — a false alarm is a bug in the
    // alarm, and a noisy guard gets silenced.
    expect(parseUnitExecStartBinary('ExecStart=-/usr/bin/llama-server --host 127.0.0.1')).toBe('/usr/bin/llama-server');
    expect(parseUnitExecStartBinary('ExecStart=@/usr/bin/llama-server argv0')).toBe('/usr/bin/llama-server');
    expect(parseUnitExecStartBinary('ExecStart=+/usr/bin/llama-server')).toBe('/usr/bin/llama-server');
    expect(parseUnitExecStartBinary('ExecStart=!!-@/usr/bin/llama-server')).toBe('/usr/bin/llama-server');
  });

  it('returns null when the unit declares no ExecStart', () => {
    expect(parseUnitExecStartBinary('[Unit]\nDescription=nothing here\n')).toBeNull();
  });
});

describe('parseLlamaServerUnit', () => {
  it('reads flags across systemd backslash continuations', () => {
    // The whole reason this is a parser: every real unit here spreads ExecStart over seven
    // lines, so a per-line regex sees unrelated fragments.
    expect(parseLlamaServerUnit(DRIFTED_UNIT)).toEqual({
      host: '127.0.0.1',
      port: 11436,
      parallelSlots: 3,
      ctxTotal: 614400,
      kvCacheTypeK: 'q4_0',
      kvCacheTypeV: 'q4_0',
      flashAttn: true,
      alias: 'maxwell1500/ornith-35b:IQ3_M',
      // Absent from this unit — and reported as absent, not as some assumed default. That
      // distinction is the entire bug in WI-39735: a guard that defaults a missing `-ngl` to
      // "all layers" reports agreement between a GPU unit and a CPU-only one.
      gpuLayers: null,
    });
  });

  it('reports an absent flag as null rather than substituting a default', () => {
    const p = parseLlamaServerUnit('[Service]\nExecStart=llama-server --host 127.0.0.1\n');
    expect(p.host).toBe('127.0.0.1');
    expect(p.parallelSlots).toBeNull();
    expect(p.ctxTotal).toBeNull();
    expect(p.kvCacheTypeK).toBeNull();
  });

  it('returns all-null for a unit with no ExecStart instead of throwing', () => {
    expect(parseLlamaServerUnit('[Unit]\nDescription=nothing here\n').port).toBeNull();
  });

  it('reads --flash-attn off as disabled', () => {
    expect(parseLlamaServerUnit('ExecStart=llama-server --flash-attn off').flashAttn).toBe(false);
  });
});

describe('diffCatalogAgainstDeployedUnit', () => {
  /** The control: the guard must name exactly the parameters that really drifted. */
  it('catches the REAL 2026-08-17 drift, and names every drifted parameter', () => {
    const drift = diffCatalogAgainstDeployedUnit(ORNITH, DRIFTED_UNIT);
    const byParam = Object.fromEntries(drift.map((d) => [d.param, d]));

    // `gpuLayers` joined this list in WI-39735. It is not a historical claim about what that unit
    // did on the GPU — it is the guard reporting that the catalog declares an offload setting the
    // deployed unit does not, which is precisely the silence that hid a CPU-only fallback.
    expect(Object.keys(byParam).sort()).toEqual([
      'ctxTotal',
      'gpuLayers',
      'kvCacheTypeK',
      'kvCacheTypeV',
      'parallelSlots',
    ]);
    expect(byParam.gpuLayers).toMatchObject({ generated: '999', deployed: 'null' });
    expect(byParam.parallelSlots).toMatchObject({ generated: '2', deployed: '3' });
    expect(byParam.ctxTotal).toMatchObject({ generated: '180224', deployed: '614400' });
    expect(byParam.kvCacheTypeK).toMatchObject({ generated: 'q8_0', deployed: 'q4_0' });
  });

  /**
   * The point of the whole module, stated as a test: the OLD guard shape could not have caught
   * this. `backend-config.test.ts` asserts host and port — and host and port AGREED right
   * through the drift. So a green host/port assertion was never evidence about the unit.
   */
  it('explains the old blind spot: host and port agreed throughout the drift', () => {
    const drift = diffCatalogAgainstDeployedUnit(ORNITH, DRIFTED_UNIT);
    expect(drift.map((d) => d.param)).not.toContain('host');
    expect(drift.map((d) => d.param)).not.toContain('port');
    expect(drift.length).toBeGreaterThan(0);
  });

  it('reports no drift for a unit rendered from the catalog itself', () => {
    // Generated-vs-generated must be clean, or every comparison below is noise. This is the
    // calibration case: without it, a diff that reported everything as drifted would still
    // pass the control above.
    const selfRendered = diffCatalogAgainstDeployedUnit(ORNITH, DRIFTED_UNIT);
    expect(selfRendered.length).toBe(5); // sanity: the control really does differ
    const clean = diffUnitParams(
      parseLlamaServerUnit(DRIFTED_UNIT),
      parseLlamaServerUnit(DRIFTED_UNIT),
    );
    expect(clean).toEqual([]);
  });

  it('describeUnitDrift renders an actionable one-liner', () => {
    expect(describeUnitDrift([])).toBe('no drift');
    expect(describeUnitDrift(diffCatalogAgainstDeployedUnit(ORNITH, DRIFTED_UNIT))).toContain(
      'parallelSlots: catalog=2 deployed=3',
    );
  });
});

describe('GPU offload (-ngl) — WI-39735', () => {
  it('reads every spelling llama-server accepts', () => {
    expect(parseLlamaServerUnit('ExecStart=llama-server -ngl 999').gpuLayers).toBe(999);
    expect(parseLlamaServerUnit('ExecStart=llama-server --n-gpu-layers 32').gpuLayers).toBe(32);
    expect(parseLlamaServerUnit('ExecStart=llama-server --gpu-layers 0').gpuLayers).toBe(0);
  });

  it('distinguishes `-ngl 0` from an absent flag', () => {
    // Both mean "no GPU" in effect, but they are different FACTS about the unit: one declares the
    // intent, the other leaves it to whatever the engine defaults to on this build. Collapsing
    // them is the same substitution error the module header forbids.
    expect(parseLlamaServerUnit('ExecStart=llama-server -ngl 0').gpuLayers).toBe(0);
    expect(parseLlamaServerUnit('ExecStart=llama-server').gpuLayers).toBeNull();
  });

  it('reports drift when a deployed unit silently drops the GPU offload flag', () => {
    // The failure this exists for: strip `-ngl` and the unit still starts, still reports active,
    // still answers /health 200, and still matches every OTHER compared parameter.
    const noNgl = CURRENT_UNIT.replace('  -ngl 999 \\\n', '');
    const drift = diffCatalogAgainstDeployedUnit(ORNITH, noNgl);
    expect(drift.map((d) => d.param)).toEqual(['gpuLayers']);
    expect(describeUnitDrift(drift)).toContain('gpuLayers: catalog=999 deployed=null');
  });

  it('reports NO drift for the current deployed shape', () => {
    // Calibration: without this, a guard that flagged everything would still pass the case above.
    expect(diffCatalogAgainstDeployedUnit(ORNITH, CURRENT_UNIT)).toEqual([]);
  });
});

describe('required Environment= vars (WI-39735 / D-012)', () => {
  it('parses single, repeated and quoted multi-assignment forms', () => {
    const env = parseUnitEnvironment(CURRENT_UNIT);
    expect(env.GGML_BACKEND_PATH).toBe('/usr/local/lib/ollama/cuda_v13/libggml-cuda.so');
    expect(env.LD_LIBRARY_PATH).toBe('/usr/local/lib/ollama/cuda_v13:/usr/local/lib/ollama');
    expect(parseUnitEnvironment('Environment="A=1" "B=2"')).toEqual({ A: '1', B: '2' });
    // Last assignment of a key wins, as systemd itself resolves it.
    expect(parseUnitEnvironment('Environment=A=1\nEnvironment=A=2').A).toBe('2');
  });

  it('does NOT mistake EnvironmentFile= for an assignment', () => {
    // It names a file we cannot read from here; matching it would invent a variable called
    // `EnvironmentFile` and, worse, report a required var as present when nothing set it.
    expect(parseUnitEnvironment('EnvironmentFile=/etc/default/llama')).toEqual({});
  });

  it('CONTROL: the parameter diff is BLIND to a deleted CUDA var — this check is what sees it', () => {
    // The same measurement `checkUnitExecStartBinary`'s control makes, for the other half of the
    // 2026-08-17 incident. Deleting the line that decides whether the model touches the GPU must
    // not move the parameter diff by one element — that blindness is the bug, so measure it here
    // rather than assert it in prose. If someone later folds environment into
    // LlamaServerUnitParams, this test fails and tells them why it was kept separate.
    const noCuda = CURRENT_UNIT.replace(
      'Environment=GGML_BACKEND_PATH=/usr/local/lib/ollama/cuda_v13/libggml-cuda.so\n',
      '',
    );
    expect(diffCatalogAgainstDeployedUnit(ORNITH, noCuda)).toEqual(
      diffCatalogAgainstDeployedUnit(ORNITH, CURRENT_UNIT),
    );

    // ...and the new check is what tells the two apart.
    expect(checkRequiredEnvironment(ORNITH, CURRENT_UNIT)).toEqual([]);
    const issues = checkRequiredEnvironment(ORNITH, noCuda);
    expect(issues.map((i) => i.key)).toEqual(['GGML_BACKEND_PATH']);
    expect(issues[0].reason).toBe('missing');
    expect(describeEnvIssues(issues)).toBe('GGML_BACKEND_PATH: missing');
  });

  it('treats a declared-but-empty value as missing in effect', () => {
    const emptied = CURRENT_UNIT.replace(
      '/usr/local/lib/ollama/cuda_v13/libggml-cuda.so\nExecStart=',
      '\nExecStart=',
    );
    const issues = checkRequiredEnvironment(ORNITH, emptied);
    expect(issues.map((i) => [i.key, i.reason])).toEqual([['GGML_BACKEND_PATH', 'empty']]);
  });

  it('is silent for an entry that declares no requiredEnv', () => {
    // Every other catalog entry must stay unaffected, or this becomes the cry-wolf the header warns
    // about: an opt-in guard that fires on boxes whose catalog never opted in.
    const qwen = CERTIFIED_CATALOG.find((e) => e.id === 'qwen3-8b-q4km-llama-server')!;
    expect(qwen.serve.requiredEnv).toBeUndefined();
    expect(checkRequiredEnvironment(qwen, CURRENT_UNIT)).toEqual([]);
    expect(describeEnvIssues([])).toBe('no missing required environment');
  });
});

/**
 * The live half: compare the catalog against the unit ACTUALLY deployed on this machine.
 *
 * Subject path is env-overridable — that one line is what makes a tier-2 mutation probe possible
 * (mutate a COPY outside the tree and point the test at it), instead of the tier-3 shape that
 * mutates the shared checkout and races git-sync's sweep.
 *
 * Absent file ⇒ this machine does not deploy this backend, which is a legitimate skip. The skip
 * is announced rather than silent: a guard that quietly always skips is the same "armed and does
 * nothing" failure this plan keeps running into.
 */
describe('deployed unit on this machine', () => {
  const unitPath =
    process.env.PAPERCUSP_ORNITH_UNIT_PATH ?? join(homedir(), '.config/systemd/user/llama-ornith.service');
  const present = existsSync(unitPath);

  it.runIf(present)('matches the certified catalog entry', () => {
    const drift = diffCatalogAgainstDeployedUnit(ORNITH, readFileSync(unitPath, 'utf8'));
    expect(
      drift,
      `DEPLOYED UNIT HAS DRIFTED from catalog '${ORNITH.id}' (${unitPath}): ${describeUnitDrift(drift)}. ` +
        `This entry is status:'${ORNITH.status}' — its certification was earned on the CATALOG's numbers, ` +
        `so a deployed unit that differs is running an UNCERTIFIED config (D-007). Restore the unit, or ` +
        `change the catalog and re-run the cert battery; do not relabel one to match the other.`,
    ).toEqual([]);
  });

  it.runIf(present)('carries every environment variable the catalog declares it cannot serve without', () => {
    const issues = checkRequiredEnvironment(ORNITH, readFileSync(unitPath, 'utf8'));
    expect(
      issues,
      `DEPLOYED UNIT IS MISSING REQUIRED ENVIRONMENT (${unitPath}): ${describeEnvIssues(issues)}. ` +
        `This is the WI-39735 / D-012 failure: the unit will still start, still report active and ` +
        `still answer /health 200 — while serving from the CPU, at roughly half the load speed and ` +
        `far worse throughput. Restore the Environment= line(s); do not drop them from the catalog.`,
    ).toEqual([]);
  });

  it.skipIf(present)('is absent on this machine — nothing deployed to compare', () => {
    expect(present).toBe(false);
  });
});
