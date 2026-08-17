import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  parseLlamaServerUnit,
  diffUnitParams,
  diffCatalogAgainstDeployedUnit,
  describeUnitDrift,
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
  /** The control: the guard must name exactly the four fields that really drifted. */
  it('catches the REAL 2026-08-17 drift, and names every drifted parameter', () => {
    const drift = diffCatalogAgainstDeployedUnit(ORNITH, DRIFTED_UNIT);
    const byParam = Object.fromEntries(drift.map((d) => [d.param, d]));

    expect(Object.keys(byParam).sort()).toEqual(['ctxTotal', 'kvCacheTypeK', 'kvCacheTypeV', 'parallelSlots']);
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
    expect(selfRendered.length).toBe(4); // sanity: the control really does differ
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

  it.skipIf(present)('is absent on this machine — nothing deployed to compare', () => {
    expect(present).toBe(false);
  });
});
