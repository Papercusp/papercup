/**
 * fleet-recolor-demo — live, end-to-end proof of the wire-the-bee-terminal feature
 * using the REAL shipped code paths:
 *
 *   Part 1 (launch color): opens a gnome-terminal hosting bash under the real
 *     psu-pty-host with PAPERCUSP_FLEET_* set → hostThroughPty's fleetOscFromEnv
 *     write recolors the window AT STARTUP to fleet A's scheme.
 *   Part 2 (live recolor):  3s later, calls the real recolorViaPty(ownerId, …) —
 *     the exact function fleet:join/create now call — to recolor the SAME open
 *     window to fleet B's scheme, with no relaunch and no second call by the agent.
 *
 * Throwaway (scratch/). Run from the repo root:
 *   DISPLAY=:0 npx tsx scratch/fleet-recolor-demo.mts
 */
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import {
  allocateNextSchemeName,
  schemeByName,
  oscRecolorSequence,
} from '../packages/operator-core/lib/console-color-schemes';
import {
  findLiveHost,
  recolorViaPty,
} from '../packages/operator-core/lib/events/await/psu-pty-discovery';

const spawnEnv = {
  ...process.env,
  DISPLAY: process.env.DISPLAY || ':0',
  XAUTHORITY: process.env.XAUTHORITY || '/run/user/1000/gdm/Xauthority',
};

const ownerId = `demo-recolor-${process.pid}`;
// Two distinct, hue-spread schemes — exactly how the allocator hands them out.
const fleetA = schemeByName(allocateNextSchemeName([]))!;
const fleetB = schemeByName(allocateNextSchemeName([fleetA.name]))!;

// Open a window hosting bash under the REAL pty host. Export PAPERCUSP_* in the
// oneliner (gnome-terminal's client/server split makes spawn-env propagation
// unreliable; an explicit export always reaches the window's shell).
const oneliner = [
  `export PAPERCUSP_SID=${ownerId}`,
  `export PAPERCUSP_FLEET_BG='${fleetA.bg}'`,
  `export PAPERCUSP_FLEET_FG='${fleetA.fg}'`,
  `export PAPERCUSP_FLEET_CURSOR='${fleetA.cursor}'`,
  `cd '${process.cwd()}'`,
  `exec npx tsx scratch/fleet-recolor-host.mjs ${ownerId}`,
].join('; ');

spawn('gnome-terminal', ['--window', '--', 'bash', '-lc', oneliner], {
  detached: true,
  stdio: 'ignore',
  env: spawnEnv,
}).unref();
console.log(`opened window ${ownerId}`);
console.log(`  Part 1 — launch color: ${fleetA.name}  bg=${fleetA.bg} cursor=${fleetA.cursor}`);

// Wait for the host's discovery file (npx tsx cold-start can take a few seconds).
let host = null;
for (let i = 0; i < 80 && !(host = findLiveHost(ownerId)); i++) await sleep(250);
if (!host) {
  console.error('host never registered a discovery file — is :0 reachable / node-pty built?');
  process.exit(1);
}
console.log(`  host live (pid ${host.pid}) — recoloring via recolorViaPty in 3s…`);
await sleep(3000);

const ok = await recolorViaPty(ownerId, oscRecolorSequence(fleetB));
console.log(`  Part 2 — recolorViaPty → ${ok}: window is now ${fleetB.name}  bg=${fleetB.bg} cursor=${fleetB.cursor}`);
console.log('  (the window opened in fleetA, then flipped to fleetB live — close it when done)');
