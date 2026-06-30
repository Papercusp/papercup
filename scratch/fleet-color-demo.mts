/**
 * fleet-color-demo — live visual proof of the per-fleet color-scheme feature
 * using the REAL code path (catalog + allocation + buildConsoleOneliner). Opens
 * one gnome-terminal per simulated fleet on DISPLAY :0, each in its allocated
 * scheme. Throwaway (scratch/). Run: tsx scratch/fleet-color-demo.mts
 */
import { spawn } from 'node:child_process';
import {
  allocateNextSchemeName,
  schemeByName,
} from '../packages/operator-core/lib/console-color-schemes';
import { buildConsoleOneliner } from '../packages/operator-core/lib/console-spawn';

const FLEETS = ['atlas-fleet', 'nimbus-fleet', 'vertex-fleet'];
const env = { ...process.env, DISPLAY: ':0', XAUTHORITY: '/run/user/1000/gdm/Xauthority' };
const used: string[] = [];

for (const fleet of FLEETS) {
  // Exactly what createFleetIfAbsent does: allocate the next UNUSED scheme.
  const schemeName = allocateNextSchemeName(used);
  used.push(schemeName);
  const scheme = schemeByName(schemeName)!;

  const greeting =
    `echo "Fleet: ${fleet}"; echo "Bound color scheme: ${schemeName}  (bg ${scheme.bg} / cursor ${scheme.cursor})"; ` +
    `echo "Every window this fleet opens looks like this — forever."`;
  const oneliner = buildConsoleOneliner(env.HOME ?? '/tmp', {}, greeting, {
    mode: 'console',
    planSlug: null,
    label: fleet,
    scheme,
  });

  const child = spawn('gnome-terminal', ['--wait', '--window', '--', 'bash', '-lc', oneliner], {
    detached: true,
    stdio: 'ignore',
    env,
  });
  child.unref();
  console.log(`opened ${fleet.padEnd(13)} -> ${schemeName.padEnd(15)} bg=${scheme.bg} cursor=${scheme.cursor}`);
}
