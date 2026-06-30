/**
 * fleet-recolor-host — throwaway. Hosts an interactive `bash` under the REAL
 * psu-pty-host (hostThroughPty) so fleet-recolor-demo can (a) prove the launch-time
 * fleet color (fleetOscFromEnv writes the OSC to stdout at startup) and (b) recolor
 * the live window through the real discovery socket. Run inside a gnome-terminal by
 * fleet-recolor-demo.mts; reads PAPERCUSP_SID + PAPERCUSP_FLEET_* from its env.
 */
import { hostThroughPty } from '../apps/operator/scripts/psu-pty-host.mjs';

const ownerId = process.argv[2] || process.env.PAPERCUSP_SID || 'demo-fleet-owner';
await hostThroughPty({
  command: 'bash',
  args: ['-i'],
  cwd: process.env.HOME || '/tmp',
  env: process.env, // carries PAPERCUSP_SID + PAPERCUSP_FLEET_BG/FG/CURSOR
  ownerId,
});
