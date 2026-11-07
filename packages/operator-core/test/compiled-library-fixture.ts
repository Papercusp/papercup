/** Compile a private library fixture with the maintained host dependency boundary. */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

export async function compileLibraryFixture(root: string, source: string, output: string,
  options: { sourceSha?: string } = {}) {
  if (options.sourceSha && !/^[a-f0-9]{40,64}$/.test(options.sourceSha)) throw Error('invalid fixture source SHA');
  const metafile = `${output}.meta.json`;
  const script = [
    'set -euo pipefail',
    'source "$1/apps/operator/bin/bundle-host-common.sh"',
    'root="$1"; metafile="$2"; shift 2',
    'externals=("${HOST_COMMON_EXTERNALS[@]}" --external:@embedded-postgres/* --external:@papercusp/embedded-postgres-server)',
    'for package in "${NATIVE_PKGS[@]}"; do externals+=("--external:$package"); done',
    'bundle_host_esbuild "$root" "$@" --bundle --platform=node --format=esm --target=node22 ' +
      '--define:__PAPERCUSP_BUNDLED_SIDECAR__=true "--metafile=$metafile" ' +
      '"--banner:js=$HOST_BANNER" "${HOST_BANNER_DEFINES[@]}" "${HOST_RELEASE_COMPACTION_ARGS[@]}" "${externals[@]}"',
    // Run the checker FROM the selected source root: its own import.meta.url
    // determines the repo-owned population, including for an immutable export.
    'node "$root/scripts/check-bundled-cli-entry-guards.mjs" --metafile "$metafile" --base-dir "$root"',
  ].join('\n');
  await promisify(execFile)('bash', ['-c', script, 'compile-library-fixture', root, metafile, source,
    `--outfile=${output}`, ...(options.sourceSha
      ? [`--define:__PAPERCUSP_BUNDLED_SOURCE_SHA__=${JSON.stringify(options.sourceSha)}`] : [])],
  { cwd: root, timeout: 180_000, maxBuffer: 16_000_000 });
}
