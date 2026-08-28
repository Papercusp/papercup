import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  KOKORO_SERVICE_CONFIG_EXIT,
  inspectKokoroServiceContract,
} from './kokoro-service-contract';

const GOOD_UNIT = `[Service]
ExecStart=%h/.voicemode/services/kokoro/start-gpu.sh
ConditionPathExists=%h/.voicemode/services/kokoro/api/src/models/v1_0/kokoro-v1_0.pth
Restart=always
RestartPreventExitStatus=127 ${KOKORO_SERVICE_CONFIG_EXIT}
TimeoutStartSec=180
`;
const GOOD_START = `#!/usr/bin/env bash
set -Eeuo pipefail
MODEL=api/src/models/v1_0/kokoro-v1_0.pth
CONFIG=api/src/models/v1_0/config.json
VOICES=api/src/voices/v1_0
[[ -s "$MODEL" ]] || { echo missing >&2; exit ${KOKORO_SERVICE_CONFIG_EXIT}; }
[[ -s "$CONFIG" ]] || { echo missing >&2; exit ${KOKORO_SERVICE_CONFIG_EXIT}; }
compgen -G "$VOICES/*.pt" >/dev/null || { echo missing >&2; exit ${KOKORO_SERVICE_CONFIG_EXIT}; }
exec .venv/bin/python -m uvicorn api.src.main:app --port 8880
`;
const GOOD_PROVISION = `#!/usr/bin/env bash
set -Eeuo pipefail
uv pip install -e ".[gpu]"
uv run --no-sync python docker/scripts/download_model.py --output api/src/models/v1_0
`;

describe('Kokoro service contract', () => {
  it('accepts an offline start with explicit provisioning and exit-code guard', () => {
    expect(inspectKokoroServiceContract({
      unitText: GOOD_UNIT,
      startScriptText: GOOD_START,
      provisionScriptText: GOOD_PROVISION,
    })).toEqual({ ok: true, violations: [] });
  });

  it('rejects dependency/model installation in the hot start script', () => {
    const result = inspectKokoroServiceContract({
      unitText: GOOD_UNIT,
      startScriptText: `${GOOD_START}\nuv pip install -e .\npython docker/scripts/download_model.py\n`,
      provisionScriptText: GOOD_PROVISION,
    });
    expect(result.ok).toBe(false);
    expect(result.violations.join('\n')).toMatch(/offline.*uv pip install|offline.*download_model/i);
  });

  it('rejects the old 25-request single-worker recycle contract', () => {
    const result = inspectKokoroServiceContract({
      unitText: `${GOOD_UNIT}\nEnvironment="UVICORN_LIMIT_MAX_REQUESTS=25"\n`,
      startScriptText: GOOD_START,
      provisionScriptText: GOOD_PROVISION,
    });
    expect(result.ok).toBe(false);
    expect(result.violations).toContain(
      'unit must not set UVICORN_LIMIT_MAX_REQUESTS: one uvicorn process is not a worker pool',
    );
  });

  it('checks the installed developer-host contract when the optional files are present', () => {
    const root = join(homedir(), '.voicemode', 'services', 'kokoro');
    const paths = {
      unit: join(homedir(), '.config', 'systemd', 'user', 'voicemode-kokoro.service'),
      start: join(root, 'start-gpu.sh'),
      runtimeStart: join(root, 'start-common.sh'),
      provision: join(root, 'provision-gpu.sh'),
      runtimeProvision: join(root, 'provision-common.sh'),
    };
    if (!(existsSync(paths.unit) && existsSync(paths.start) && existsSync(paths.runtimeStart) && existsSync(paths.provision) && existsSync(paths.runtimeProvision))) return;
    const result = inspectKokoroServiceContract({
      unitText: readFileSync(paths.unit, 'utf8'),
      startScriptText: readFileSync(paths.start, 'utf8'),
      runtimeStartScriptText: readFileSync(paths.runtimeStart, 'utf8'),
      provisionScriptText: readFileSync(paths.provision, 'utf8'),
      runtimeProvisionScriptText: readFileSync(paths.runtimeProvision, 'utf8'),
    });
    expect(result, result.violations.join('; ')).toEqual({ ok: true, violations: [] });
  });
});
