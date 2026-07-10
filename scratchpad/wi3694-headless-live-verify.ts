// WI-3694 (headless-fleet-launch-and-carry-knob-2026-07-10 P-007) live verify.
// Spawns ONE headless psu session directly (bypassing fleet:launch-on-plan's
// server-side MCP tool, which runs on :3070 green-main and may not yet carry
// this code) via buildConsoleEnvelope{runCommand} + spawnHeadless — the same
// backend fleet:launch-on-plan{headless:true} uses internally. Cheap model,
// no --plan (avoid auto-kickoff churn). Prints the discovery-file path + pid
// so the caller can poll/verify/kill it. Throwaway scratch script.
import { buildConsoleEnvelope } from '../packages/operator-core/lib/console-launcher';
import { spawnHeadless } from '../packages/operator-core/lib/console-spawn';

async function main() {
  const workspaceId = 'papercusp-workspace';
  const operatorBaseUrl = 'http://localhost:3070';
  const cmd = 'psu --headless --no-picker --harness=papercusp --account=default --model=haiku';

  const envelope = await buildConsoleEnvelope({
    workspaceId,
    slug: 'papercusp',
    operatorBaseUrl,
    runCommand: cmd,
    skipMcpJson: false,
  });

  const result = await spawnHeadless({
    envelope,
    label: 'wi3694-live-verify',
    logDir: '/tmp/wi3694-headless-verify',
  });

  console.log(JSON.stringify({ result, sessionId: envelope.sessionId }, null, 2));
}

main().catch((e) => {
  console.error('FATAL', e);
  process.exit(1);
});
