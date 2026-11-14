---
rel_path: "portability/census/v55/02-source-preview.mjs.part-005"
updated_at: 1794250602744
_body: "content"
---

in `papercusp-desktop/README.md`).',
        'You also need **pgvector for PostgreSQL 18**: the app runs its own embedded Postgres, and the',
        'schema uses the `vector` extension, which that Postgres does not ship with. On Debian or',
        'Ubuntu, install `postgresql-18-pgvector` from the PostgreSQL apt repository',
        '(https://wiki.postgresql.org/wiki/Apt); on macOS, `brew install pgvector`.',
        '',
        '```sh',
        'npm ci                                               # also copies pgvector into the embedded Postgres',
        'npm --workspace @papercusp/operator-vite run build   # the UI bundle the desktop window loads',
        'cd papercusp-desktop && npm ci && npm run dev        # builds the Rust shell and opens the window',
        '```',
        '',
        'The first `npm run dev` compiles the Rust shell, which takes several minutes. The app then',
        'creates its embedded database, applies the migrations and serves the operator from this',
        'tree. If pgvector was missing during `npm ci`, install it and run',
        '`node scripts/install-embedded-pgvector.mjs`. Release installers are built by',
        '`papercusp-desktop/bin/build-linux-local.sh` and its siblings, which also need signing and',
        'release-identity inputs that development does not.',
        '',
      ]
      : []),
    '## How this source ships inside every release',
    '',
    'The Papercusp Server installer carries this same source tree as one compressed resource,',
    '`sidecar/source.tar.zst`:',
    '',
    '- **What is in it.** The code you are reading plus its already-installed `node_modules`. The',
    '  release build selects it with the same allowlist, and checks it with the same audit, that',
    '  produced this snapshot. Both refuse git history, internal plans, agent transcripts and',
    '  state, and credentials, and both redact personal identity. The only difference here is that',
    '  `node_modules` is left out.',
    '- **Where it goes.** On first launch the app extracts the archive into a writable folder in',
    '  its own data directory (on Windows, inside the `papercup-runtime` WSL distro). Later',
    '  launches skip the extract.',
    '- **What runs from it.** Two of the environments in the app\'s environment switcher run',
    '  Papercusp from that extracted source instead of from the prebuilt server: **dev**',
    '  (port 3270) runs the API host straight from TypeScript (`tsx apps/operator/bin/hono-host.ts`),',
    '  and **local** (port 3055) runs the Vite dev server over the UI in `apps/operator-vite`.',
    '  Both run on the Node.js bundled in the app with the tree\'s own `tsx` and `vite`, because',
    '  an installed machine has no npm.',
    '',
    '## Why the release carries its own source',
    '',
    'So that the Papercusp you installed can run a Papercusp you changed. Papercusp is developed',
    'with Papercusp, and shipping the runnable source means any install can do what the',
    'development machine does: open the tree, edit it (by hand or with agents), and run the edited',
    'build side by side with the installed one, without cloning a repository or installing a',
    'toolchain. Two design choices follow from that:',
    '',
    '- **Extracted to a writable folder, not run in place.** The install directory is read-only,',
    '  and a source tree you cannot edit defeats the purpose.',
    '- **One archive, not loose files.** The tree with its `node_modules` runs to several',
    '  gigabytes of small files. Copying them one by one through the app bundler\'s resource',
    '  pipeline is slow, and the `node_modules/.bin` symlinks survive `tar` but not that copy.',
    '',
    'This repository is the same source without `node_modules`, so you can read it before you install.',
    '',
    ...(isPublic
      ? [
        '## Contributing, security and telemetry',
        '',
        '- **Contributing:** see CONTRIBUTING.md. Code contributions need a signed Contributor',
        '  License Agreement; a bot links it on your first pull request.',
        '- **Security:** report vulnerabilities privately, as described in SECURITY.md.',
        '- **Conduct:** everyone taking part follows CODE_OF_CONDUCT.md.',
        '- **Telemetry is off unless you opt in** during setup, and development builds never send',
        '  any. If you distribute your own build, point opted-in telemetry at your own PostHog',
        '  with `PAPERCUSP_POSTHOG_HOST` and `PAPERCUSP_POSTHOG_KEY` (or `~/.papercusp/posthog.json`);',
        '  otherwise it goes to Papercusp\'s. The in-app support chat loads only on the `/support` page.',
        '',
      ]
      : []),
    '## Where to read first',
    '',
    '- `CLAUDE.md` / `AGENTS.md` — the conventions every agent in this codebase works under.',
    '- `docs/` — design and architecture notes.',
    '- `apps/operator/` — the operator: API host, agent tools, coordination.',
    '- `libs/papercusp/` — the core platform libraries (database schema and migrations live in `libs/papercusp/libs/db/`).',
    '',
    '## Top-level layout',
    '',
    ...tops.map((t) => `- \`${t}\``),
    '',
    '## Workspaces',
    '',
    '| path | package | description |',
    '|---|---|---|',
    ...ws.map((w) => `| \`${w.rel}\` | \`${w.name}\` | ${w.description.replace(/\|/g, '\\|').replace(/\s+/g, ' ').trim()} |`),
    '',
  ];
  return lines.join('\n');
}

/**
 * The copyright year of `commit`: the newest commit date in its recent first-parent history.
 * The commit's own date is unusable — repair-queue admission commits carry a fixed 2000-01-01.
 * @param {string} repo
 * @param {string} commit
 */
export function sourceYear(repo, commit) {
  const stamps = git(repo, ['log', '-n', '200', '--first-parent', '--format=%ct', commit]).trim().split('\n').map(Number);
  return new Date(Math.max(...stamps) * 1000).getUTCFullYear();
}

/**
 * Export one pinned commit as the public-safe cut into `out` (must not exist).
 * Deterministic for a given commit — no timestamps — so a drift check compares
 * content, not clock.
 * `thirdPartyNotices(dir)` renders THIRD-PARTY-NOTICES.md for the public target; tests
 * inject a stub so they need no cargo resolve.
 * @param {{ repoRoot?: string, ref?: string, out: string, target?: string, licensePath?: string, selectScript?: string, selectionLib?: string, env?: NodeJS.ProcessEnv, log?: Log, thirdPartyNotices?: (dir: string) => { text: string, undetermined: string[] } }} opts
 */
export async function exportSnapshot({
  repoRoot = ROOT,
  ref = DEFAULT_REF,
  out,
  target: targetName = 'preview',
  licensePath = PUBLIC_LICENSE_PATH,
  selectScript = SELECT_SCRIPT,
  selectionLib = SELECTION_LIB,
  env = process.env,
  log = () => {},
  thirdPartyNotices = (dir) => collectThirdPartyNotices(dir),
}) {
  if (!out) throw new PreviewError('exportSnapshot: out is required', 2);
  if (existsSync(out)) throw new PreviewError(`refusing to overwrite existing ${out}`, 2);
  const target = resolveTarget(targetName);
  const license = target.key === 'public' ? readLicense(licensePath) : null;
  const community = target.key === 'public' ? readCommunityFiles(dirname(licensePath)) : [];
  const releasesUrl = releasesPageUrl(env);
  const commit = resolveCommit(repoRoot, ref);
  const allow = allowlistTops(selectionLib);
  // The public repository also carries the Tauri desktop shell (P-004), which the shared
  // selection leaves out because the installer never ships it. Materialize it too (a
  // gitlink resolves at its pinned commit) and add it after the selection.
  if (target.key === 'public') allow.add(DESKTOP_DIR);
  const work = await mkdtemp(join(tmpdir(), 'source-preview-'));
  const partial = `${out}.partial-${process.pid}`;
  try {
    const mono = join(work, 'mono');
    await fs.mkdir(mono);
    log(`materializing ${commit} (+ submodules at their gitlinks)`);
    const submodules = materializeCommit({ repo: repoRoot, sha: commit, dest: mono, allow });
    await fs.mkdir(dirname(partial), { recursive: true });
    log('selecting the public-safe cut (shared with the installer)');
    const sel = spawnSync('bash', [selectScript, '--mono', mono, '--into', partial, '--mode', 'preview'], {
      encoding: 'utf8', env, maxBuffer: 64 * 1024 * 1024,
    });
    if (sel.status !== 0) {
      throw new PreviewError(`source-tree-select refused (exit ${sel.status}): ${(sel.stderr || sel.stdout).trim().slice(-2000)}`, sel.status === 2 ? 2 : 1);
    }
    if (target.key === 'public') log(`desktop shell: identity scrub redacted ${copyDesktopShell(mono, partial, { env })} file(s)`);
    const files = await listFiles(partial);
    const vcs = files.filter((f) => f === '.git' || f.startsWith('.git/') || f.includes('/.git/') || f.endsWith('/.git'));
    if (vcs.length) throw new PreviewError(`export contains git metadata: ${vcs.slice(0, 5).join(', ')}`);
    const collisions = files.filter((f) => PUBLIC_ADDED_FILES.includes(f));
    if (collisions.length) throw new PreviewError(`the selection already ships ${collisions.join(', ')} — refusing to overwrite`);
    const shipped = submodules.filter((s) => existsSync(join(partial, s.path)));
    const manifest = {
      schema: 1,
      target: target.key,
      purpose: target.purpose,
      year: sourceYear(repoRoot, commit),
      source: { repo: SOURCE_REPO, ref, commit },
      submodules: shipped,
      notShipped: submodules.filter((s) => !shipped.includes(s)).map((s) => s.path),
      fileCount: files.length,
      generatedBy: 'scripts/source-preview.mjs',
    };
    if (license !== null) await fs.writeFile(join(partial, 'LICENSE'), license);
    for (const { name, text } of community) {
      await fs.mkdir(dirname(join(partial, name)), { recursive: true });
      await fs.writeFile(join(partial, name), text);
    }
    if (target.key === 'public') {
      // Generated from the EXPORTED lockfiles, so it lists exactly what ships. A partial
      // measurement must not publish as a complete notices file.
      const notices = thirdPartyNotices(partial);
      if (notices.undetermined.length) {
        throw new Error(`${NOTICES_FILE}: part of the dependency graph was not measured — ${notices.undetermined.join('; ')}`);
      }
      await fs.writeFile(join(partial, NOTICES_FILE), notices.text);
    }
    await fs.writeFile(join(partial, 'NOTICE'), noticeText(manifest));
    await fs.writeFile(join(partial, 'README.md'), await readmeText(partial, manifest, releasesUrl));
    await fs.writeFile(join(partial, 'MANIFEST.json'), `${JSON.stringify(manifest, null, 2)}\n`);
    await fs.rename(partial, out);
    return { out, manifest };
  } catch (err) {
    await rm(partial, { recursive: true, force: true });
    throw err;
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

/**
 * The public target's LICENSE text. Refuses when missing or when it is not the canonical
 * Sustainable Use License 1.0: publishing the wrong terms is not recoverable
 * once cloned.
 * @param {string} path
 */
export function readLicense(path) {
  if (!existsSync(path)) throw new PreviewError(`public target needs its LICENSE at ${path}`, 2);
  const text = readFileSync(path, 'utf8');
  if (!/^## Sustainable Use License\n\nVersion 1\.0\n/.test(text) || text !== readFileSync(PUBLIC_LICENSE_PATH, 'utf8')) {
    throw new PreviewError(`${path} is not the canonical Sustainable Use License 1.0 text`, 2);
  }
  return text;
}

/**
 * Copy the desktop shell from the materialized tree into the public export, minus
 * generated and internal paths. Refuses when the commit has no desktop shell: a public
 * source release without its shell is not the product (P-004). Everything copied is
 * still checked by the same bundle audit as the rest of the export.
 * @param {string} mono the materialized commit
 * @param {string} into the export being assembled
 */
export function copyDesktopShell(mono, into, { env = process.env, auditScript = AUDIT_SCRIPT } = {}) {
  const from = join(mono, DESKTOP_DIR);
  if (!existsSync(from) || readdirSync(from).length === 0) {
    throw new PreviewError(`public target needs the desktop shell at ${DESKTOP_DIR}/ in the source commit`, 2);
  }
  const dest = join(into, DESKTOP_DIR);
  run('mkdir', ['-p', dest]);
  // The gate's own forbidden-path globs (test files, secrets, VCS, …), exactly as the
  // shared selection derives them (source-tree-selection.sh step 1). Without them the
  // shell's test/ tree shipped and the bundle audit refused the cut (P-020 re-export).
  const gateExcludes = gateTarExcludes({ env, auditScript });
  const excludes = [...DESKTOP_PUBLIC_EXCLUDES, ...gateExcludes].map((p) => `--exclude=${p}`);
  run('bash', ['-c', 'set -euo pipefail; src="$1"; dst="$2"; shift 2; tar -C "$src" -cf - "$@" . | tar -C "$dst" -xf -', '_', from, dest, ...excludes]);
  // Rooted at the shell itself: --source-leakers skips `papercusp-desktop/*` paths (the
  // installer's self-reference), so scanning from `into` would silently find nothing.
  return scrubIdentity(dest, readdirSync(dest), { env, auditScript });
}

/**
 * The bundle audit's forbidden-path tar globs (`--tar-excludes`). Refuses on failure or
 * an empty list: copying an unfiltered tree is the failure this exists to prevent (WI-4419).
 * @param {{ env?: NodeJS.ProcessEnv, auditScript?: string }} [opts]
 * @returns {string[]}
 */
export function gateTarExcludes({ env = process.env, auditScript = AUDIT_SCRIPT } = {}) {
  const r = spawnSync('python3', [auditScript, '--tar-excludes'], { encoding: 'utf8', env, maxBuffer: 16 * 1024 * 1024 });
  if (r.status !== 0) throw new PreviewError(`audit --tar-excludes failed (exit ${r.status}): ${(r.stderr || r.stdout).trim().slice(-1000)}`, 2);
  const globs = r.stdout.split('\n').map((l) => l.trim()).filter(Boolean);
  if (!globs.length) throw new PreviewError('audit --tar-excludes returned nothing — refusing to copy an unfiltered desktop shell', 2);
  return globs;
}

/**
 * The SAME audit-owned identity scrub source-tree-select.sh applies to the shared
 * selection (--source-leakers finds the files, --scrub-text redacts each on the COPY).
 * Anything added to the export after the selection must pass through it too: the desktop
 * shell's own dev scripts and tests name the maintainers, and a bare copy shipped them
 * verbatim until the gate refused (open-source-release P-004/P-013).
 * @param {string} dir the export being assembled
 * @param {string[]} entries top-level entries of `dir` to scan
 * @param {{ env?: NodeJS.ProcessEnv, auditScript?: string }} [opts]
 * @returns {number} how many files were redacted
 */
export function scrubIdentity(dir, entries, { env = process.env, auditScript = AUDIT_SCRIPT } = {}) {
  const leak = spawnSync('python3', [auditScript, '--source-leakers', dir, ...entries], { encoding: 'utf8', env, maxBuffer: 64 * 1024 * 1024 });
  if (leak.status !== 0) throw new PreviewError(`identity scrub: --source-leakers failed (exit ${leak.status}): ${(leak.stderr || leak.stdout).trim().slice(-1000)}`, 2);
  const files = leak.stdout.split('\n').map((l) => l.trim()).filter((rel) => rel && existsSync(join(dir, rel)));
  for (const rel of files) {
    const s = spawnSync('python3', [auditScript, '--scrub-text', join(dir, rel)], { encoding: 'utf8', env });
    if (s.status !== 0) throw new PreviewError(`identity scrub: --scrub-text ${rel} failed (exit ${s.status}): ${(s.stderr || s.stdout).trim().slice(-500)}`, 2);
  }
  return files.length;
}

/**
 * The public target's community files, read from `dir` (scripts/public-release/ by
 * default — beside the LICENSE). Refuses when any is missing or empty.
 * @param {string} dir
 * @returns {{ name: string, text: string }[]}
 */
export function readCommunityFiles(dir) {
  return PUBLIC_COMMUNITY_FILES.map((name) => {
    const path = join(dir, name);
    if (!existsSync(path)) throw new PreviewError(`public target needs ${name} at ${path}`, 2);
    const text = readFileSync(path, 'utf8');
    if (!text.trim()) throw new PreviewError(`${path} is empty`, 2);
    return { name, text };
  });
}

function which(bin, env) {
  const r = spawnSync('bash', ['-c', 'command -v "$1"', '_', bin], { encoding: 'utf8', env });
  return r.status === 0 ? r.stdout.trim() : null;
}

/**
 * The fail-closed gate. Every detector must RUN and come back clean; a finding
 * refuses (exit 1) and a detector that cannot run refuses too (exit 2).
 * @param {string} dir
 * @param {{ env?: NodeJS.ProcessEnv, auditScript?: string, allowlistPath?: string }} [opts]
 * @returns {Promise<GateVerdict>}
 */
export async function runGate(dir, { env = process.env, auditScript = AUDIT_SCRIPT, allowlistPath = ALLOWLIST_PATH } = {}) {
  const results = [];
  const allFindings = [];
  const allowlist = await loadAllowlist(allowlistPath);
  const record = (name, status, detail) => results.push({ name, ok: status === 'clean', status, detail: detail.trim().slice(-3000) });
  if (!existsSync(dir)) throw new PreviewError(`gate: ${dir} does not exist`, 2);
  const tools = { python3: which('python3', env), tar: which('tar', env), zstd: which('zstd', env), gitleaks: which('gitleaks', env), trufflehog: which('trufflehog', env) };
  const missing = Object.entries(tools).filter(([, p]) => !p).map(([n]) => n);
  if (missing.length) {
    for (const m of missing) record(m, 'cannot-check', `${m} not found on PATH — the gate refuses rather than skip a detector`);
    return { ok: false, exitCode: 2, results };
  }
  const work = await mkdtemp(join(tmpdir(), 'source-preview-gate-'));
  try {
    // 1. The installer's own audit over a packed copy: forbidden paths, identity, credentials.
    const bundle = join(work, 'preview.tar.zst');
    run('bash', ['-c', 'set -euo pipefail; tar --sort=name --numeric-owner --owner=0 --group=0 -C "$1" -cf - . | zstd -q -3 -f -o "$2"', '_', dir, bundle], { env });
    const a = spawnSync(tools.python3, [auditScript, bundle], { encoding: 'utf8', env, maxBuffer: 64 * 1024 * 1024 });
    record('audit-release-bundle', a.status === 0 ? 'clean' : a.status === 1 ? 'finding' : 'cannot-check', `${a.stdout}\n${a.stderr}`);
    // 2. Its directory backstop (honors no path-exclude).
    const s = spawnSync(tools.python3, [auditScript, '--scan-dir', dir], { encoding: 'utf8', env, maxBuffer: 64 * 1024 * 1024 });
    record('audit-release-bundle --scan-dir', s.status === 0 ? 'clean' : s.status === 1 ? 'finding' : 'cannot-check', `${s.stdout}\n${s.stderr}`);
    // 3. gitleaks, default rules. The report holds raw secrets, so it stays in the
    //    temp dir (removed below) and only SHA-256 fingerprints leave this function.
    const report = join(work, 'gitleaks.json');
    const g = spawnSync(tools.gitleaks, ['dir', dir, '--no-banner', '--exit-code', '1', '--report-format', 'json', '--report-path', report], { encoding: 'utf8', env, maxBuffer: 64 * 1024 * 1024 });
    if (g.status === 0 || g.status === 1) {
      let raw = [];
      if (g.status === 1) {
        try { raw = JSON.parse(await fs.readFile(report, 'utf8')); } catch (e) { record('gitleaks', 'cannot-check', `unreadable report: ${e.message}`); raw = null; }
      }
      if (raw) {
        const found = raw.map((f) => fingerprint('gitleaks', f.RuleID, relPath(dir, f.File), f.StartLine, f.Secret ?? f.Match ?? ''));
        if (g.status === 1 && found.length === 0) record('gitleaks', 'cannot-check', 'gitleaks exited 1 but its report lists no findings');
        else recordFindings('gitleaks', found);
      }
    } else {
      record('gitleaks', 'cannot-check', `${g.stdout}\n${g.stderr}`);
    }
    // 4. trufflehog, detection only: --no-verification, because verifying would send
    //    each candidate secret to its provider's API.
    const t = spawnSync(tools.trufflehog, ['filesystem', dir, '--no-update', '--no-verification', '--json', '--fail'], { encoding: 'utf8', env, maxBuffer: 256 * 1024 * 1024 });
    if (t.status === 0 || t.status === 183) {
      const found = [];
      let unparsable = 0;
      for (const l of t.stdout.split('\n').filter(Boolean)) {
        try {
          const j = JSON.parse(l);
          const fsMeta = j.SourceMetadata?.Data?.Filesystem ?? {};
          found.push(fingerprint('trufflehog', j.DetectorName, relPath(dir, fsMeta.file ?? '?'), fsMeta.line ?? 0, j.Raw ?? j.RawV2 ?? ''));
        } catch { unparsable += 1; }
      }
      if (unparsable || (t.status === 183 && found.length === 0)) record('trufflehog', 'cannot-check', `${unparsable} unparsable output line(s); exit ${t.status}`);
      else recordFindings('trufflehog', found);
    } else {
      record('trufflehog', 'cannot-check', `exit ${t.status}: ${t.stderr}`);
    }
  } finally {
    await rm(work, { recursive: true, force: true });
  }
  const ok = results.every((r) => r.ok);
  const exitCode = ok ? 0 : results.some((r) => r.status === 'finding') ? 1 : 2;
  return { ok, exitCode, results, findings: allFindings };

  function recordFindings(name, found) {
    const open = found.filter((f) => !isAllowlisted(allowlist, f));
    allFindings.push(...found.map((f) => ({ ...f, allowlisted: !open.includes(f) })));
    const accepted = found.length - open.length;
    const detail = open.slice(0, 60).map((f) => `${f.rule}  ${f.path}:${f.line}  sha256:${f.sha256.slice(0, 12)}`).join('\n')
      + (open.length > 60 ? `\n… ${open.length - 60} more` : '')
      + (accepted ? `\n(${accepted} reviewed false positive(s) accepted by ${relative(ROOT, allowlistPath)})` : '');
    record(name, open.length ? 'finding' : 'clean', detail);
  }
}

/** True when `p` is `root` itself or lies beneath it. @param {string} root @param {string} p */
function isInside(root, p) {
  const rel = relative(root, p);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

/**
 * Mirror one node_modules directory of the INTERNAL tree into the same relative place in a
 * copy of the cut, the way `npm ci` in public CI would leave it. A workspace link (its target
 * lies outside the node_modules directory) is re-pointed to the same repository-relative path
 * INSIDE the copy, so it resolves to the CUT's package — never to the internal tree's, which
 * holds files the cut drops and peers' uncommitted edits. Every installed package is linked
 * to the internal tree's copy. Scope directories (`@scope/`) are mirrored one level down.
 * @param {{ modulesRoot: string, copy: string, src: string, nmRoot?: string }} a
 */
async function mirrorNodeModules({ modulesRoot, copy, src, nmRoot = src }) {
  const dst = join(copy, relative(modulesRoot, src));
  await fs.mkdir(dst, { recursive: true });
  for (const ent of await fs.readdir(src, { withFileTypes: true })) {
    const from = join(src, ent.name);
    const to = join(dst, ent.name);
    if (ent.name.startsWith('@') && ent.isDirectory()) {
      await mirrorNodeModules({ modulesRoot, copy, src: from, nmRoot });
      continue;
    }
    if (ent.isSymbolicLink()) {
      const target = resolve(dirname(from), await fs.readlink(from));
      if (!isInside(nmRoot, target)) {
        // A workspace link. Inside the repository it maps into the copy (dangling when the
        // cut drops that workspace, exactly as npm ci would have no such package).
        await fs.symlink(isInside(modulesRoot, target) ? join(copy, relative(modulesRoot, target)) : target, to);
        continue;
      }
    }
    await fs.symlink(from, to);
  }
}

/**
 * Every node_modules directory of the internal tree whose parent directory exists in the
 * copy, up to `maxDepth` levels below the root. Directories the cut does not contain are
 * not descended into.
 * @param {string} modulesRoot @param {string} copy @param {number} [maxDepth]
 * @returns {Promise<string[]>}
 */
async function nodeModulesFor(modulesRoot, copy, maxDepth = 6) {
  const found = [];
  const walk = async (dir, depth) => {
    let ents;
    try { ents = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const ent of ents) {
      if (!ent.isDirectory() || ent.name === '.git' || ent.name === '.papercusp') continue;
      const p = join(dir, ent.name);
      if (ent.name === 'node_modules') { found.push(p); continue; }
      if (depth < maxDepth && existsSync(join(copy, relative(modulesRoot, p)))) await walk(p, depth + 1);
    }
  };
  await walk(modulesRoot, 1);
  return found;
}

/**
 * The public cut's own typecheck — WI-10006584. Public CI on Papercusp/papercusp-app runs
 * `npm ci` then `npm run lint:tsc` on every pushed commit, and the cut can fail it while the
 * internal tree passes: the cut drops files (tests, closed-layer packages) whose ambient type
 * augmentations other files relied on (5eb41d7e went red that way). Nothing before the push
 * saw it, and an append-only push cannot be taken back. This leg runs the CUT's own lint
 * script over a COPY of the export (the export itself is what gets committed, so nothing may
 * be added to it), with the internal tree's installed dependencies standing in for `npm ci`.
 * Fail-closed like the gate: a type regression is a finding (exit 1); a run that cannot
 * complete or reports no verdict is cannot-check (exit 2).
 * @param {string} dir
 * @param {{ env?: NodeJS.ProcessEnv, modulesRoot?: string, script?: string, timeoutMs?: number }} [opts]
 * @returns {Promise<GateResult>}
 */
export async function runCutTypecheck(dir, { env = process.env, modulesRoot = ROOT, script = 'lint:tsc', timeoutMs = 45 * 60 * 1000 } = {}) {
  const name = `cut typecheck (npm run ${script})`;
  const result = (status, detail) => ({ name, ok: status === 'clean', status, detail: detail.trim().slice(-3000) });
  if (!existsSync(dir)) throw new PreviewError(`typecheck: ${dir} does not exist`, 2);
  let scripts = {};
  try { scripts = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).scripts ?? {}; } catch (e) {
    return result('cannot-check', `the cut has no readable package.json: ${e.message}`);
  }
  if (!scripts[script]) return result('cannot-check', `the cut's package.json has no "${script}" script — public CI would have nothing to run either`);
  const copy = await mkdtemp(join(tmpdir(), 'source-preview-typecheck-'));
  try {
    run('cp', ['-a', `${dir}/.`, copy], { env });
    for (const nm of await nodeModulesFor(modulesRoot, copy)) await mirrorNodeModules({ modulesRoot, copy, src: nm });
    const r = spawnSync('npm', ['run', '--silent', script], { cwd: copy, encoding: 'utf8', env: { ...env, CI: 'true' }, maxBuffer: 256 * 1024 * 1024, timeout: timeoutMs });
    const out = `${r.stdout ?? ''}\n${r.stderr ?? ''}`;
    if (r.error || r.signal) return result('cannot-check', `npm run ${script} did not complete (${r.error?.message ?? `signal ${r.signal}`})\n${out}`);
    const marker = [...out.matchAll(/LINT_TSC_RESULT\b[^\n]*\bstatus=(\S+)/g)].at(-1);
    if (!marker) return result('cannot-check', `npm run ${script} exited ${r.status} without a LINT_TSC_RESULT verdict line\n${out}`);
    if (r.status === 0) return result('clean', marker[0]);
    if (r.status === 1 && marker[1] === 'regressed') return result('finding', out);
    return result('cannot-check', `npm run ${script} exited ${r.status} (status=${marker[1]})\n${out}`);
  } finally {
    await rm(copy, { recursive: true, force: true });
  }
}

/**
 * The public target's gate: the detector gate, then the cut typecheck. The typecheck takes
 * minutes, so it runs only when the detectors are clean (a refusal is a refusal either way).
 * @param {string} dir
 * @param {{ env?: NodeJS.ProcessEnv, gate?: Gate, typecheck?: (dir: string, opts: { env?: NodeJS.ProcessEnv }) => Promise<GateResult> }} [opts]
 * @returns {Promise<GateVerdict>}
 */
export async function runPublicGate(dir, { env = process.env, gate = runGate, typecheck = runCutTypecheck } = {}) {
  const verdict = await gate(dir, { env });
  if (!verdict.ok) return verdict;
  const tc = await typecheck(dir, { env });
  const results = [...verdict.results, tc];
  const ok = results.every((r) => r.ok);
  const exitCode = ok ? 0 : results.some((r) => r.status === 'finding') ? 1 : 2;
  return { ...verdict, ok, exitCode, results };
}

/** The gate a target's push uses unless the caller injects one. @param {Target} target @returns {Gate} */
export function defaultGateFor(target) {
  return target.key === 'public' ? runPublicGate : runGate;
}

function relPath(dir, file) {
  const rel = relative(dir, file);
  return (rel.startsWith('..') ? file : rel).split(sep).join('/');
}

/** A finding without its secret: rule, path, line, and the SHA-256 of the matched value. */
function fingerprint(detector, rule, path, line, secret) {
  return { detector, rule: String(rule), path, line: Number(line) || 0, sha256: createHash('sha256').update(String(secret)).digest('hex') };
}

export const ALLOWLIST_PATH = join(ROOT, 'scripts', 'source-preview-allowlist.json');

/**
 * Reviewed false positives of the ADDITIONAL detectors (gitleaks, trufflehog) —
 * never of the release audit, whose BENIGN_ERE stays the one vendor-key rule.
 * An entry matches one exact (detector, rule, path, secret-hash): a changed or new
 * value in the same file is a new finding. Every entry must carry a reason.
 * @returns {Promise<{ detector: string, rule: string, path: string, sha256: string, reason: string }[]>}
 */
export async function loadAllowlist(path = ALLOWLIST_PATH) {
  if (!existsSync(path)) return [];
  const parsed = JSON.parse(await fs.readFile(path, 'utf8'));
  const entries = Array.isArray(parsed) ? parsed : parsed.entries;
  if (!Array.isArray(entries)) throw new PreviewError(`${path}: expected { entries: [...] }`, 2);
  for (const e of entries) {
    for (const k of ['detector', 'rule', 'path', 'sha256', 'reason']) {
      if (typeof e[k] !== 'string' || !e[k].trim()) throw new PreviewError(`${path}: every entry needs a non-empty ${k} (${JSON.stringify(e).slice(0, 200)})`, 2);
    }
    if (!/^[0-9a-f]{64}$/.test(e.sha256)) throw new PreviewError(`${path}: sha256 must be 64 hex chars (${e.path})`, 2);
  }
  return entries;
}

export function isAllowlisted(entries, f) {
  return entries.some((e) => e.detector === f.detector && e.rule === f.rule && e.path === f.path && e.sha256 === f.sha256);
}

/**
 * The tree a drift check compares, written into `gitDir` from `tree`: the snapshot with
 * its identity neutralized — MANIFEST.json dropped, and the source commit that NOTICE
 * and README.md name replaced by a placeholder. So a superproject commit that
 * changes nothing the preview ships is not drift (git-sync commits every few minutes),
 * while a changed shipped file, NOTICE or README text, or a hand edit on the
 * preview still is. A tree without a readable MANIFEST.json compares as-is. All three
 * files sit at the root, so only the root tree is rewritten.
 * @returns {{ comparable: string, sourceCommit: string | null }}
 */
function comparableTree(gitDir, tree) {
  const g = (args, opts) => run('git', ['--git-dir', gitDir, ...args], opts);
  const entries = g(['ls-tree', '-z', tree]).split('\0').filter(Boolean).map((line) => {
    const tab = line.indexOf('\t');
    const [mode, type, sha] = line.slice(0, tab).split(' ');
    return { mode, type, sha, name: line.slice(tab + 1) };
  });
  const manifest = entries.find((e) => e.name === 'MANIFEST.json' && e.type === 'blob');
  let sourceCommit = null;
  try { sourceCommit = manifest ? JSON.parse(g(['cat-file', 'blob', manifest.sha]))?.source?.commit ?? null : null; } catch { sourceCommit = null; }
  if (typeof sourceCommit !== 'string' || !/^[0-9a-f]{40}$/.test(sourceCommit)) return { comparable: tree, sourceCommit: null };
  const kept = entries.filter((e) => e !== manifest).map((e) => {
    if (e.type !== 'blob' || !['NOTICE', 'README.md'].includes(e.name)) return e;
    const text = g(['cat-file', 'blob', e.sha]);
    return { ...e, sha: g(['hash-object', '-w', '--stdin'], { input: text.split(sourceCommit).join('<source-commit>') }).trim() };
  });
  const comparable = g(['mktree', '-z'], { input: kept.map((e) => `${e.mode} ${e.type} ${e.sha}\t${e.name}\0`).join('') }).trim();
  return { comparable, sourceCommit };
}

/** The git tree a directory would commit as (every file, ignore rules overridden), and its comparable tree. */
export function exportTrees(dir) {
  const gitDir = join(tmpdir(), `source-preview-tree-${process.pid}-${Date.now()}`);
  try {
    run('git', ['init', '-q', '--bare', gitDir]);
    const base = ['--git-dir', gitDir, '--work-tree', dir, '-c', 'core.autocrlf=false', '-c', 'core.fileMode=true'];
    run('git', [...base, 'add', '-A', '-f', '.']);
    const tree = run('git', [...base, 'write-tree']).trim();
    return { tree, ...comparableTree(gitDir, tree) };
  } finally {
    spawnSync('rm', ['-rf', gitDir]);
  }
}

/** The tree at `branch` of `remote` and its comparable tree, or null when the branch does not exist. */
export function remoteTrees(remote, branch = 'main') {
  const gitDir = join(tmpdir(), `source-preview-remote-${process.pid}-${Date.now()}`);
  try {
    run('git', ['init', '-q', '--bare', gitDir]);
    const heads = run('git', ['--git-dir', gitDir, 'ls-remote', remote, `refs/heads/${branch}`]).trim();
    if (!heads) return null;
    run('git', ['--git-dir', gitDir, 'fetch', '-q', '--depth', '1', remote, `refs/heads/${branch}`]);
    const tree = run('git', ['--git-dir', gitDir, 'rev-parse', 'FETCH_HEAD^{tree}']).trim();
    const head = run('git', ['--git-dir', gitDir, 'rev-parse', 'FETCH_HEAD^{commit}']).trim();
    return { tree, head, ...comparableTree(gitDir, tree) };
  } finally {
    spawnSync('rm', ['-rf', gitDir]);
  }
}

/**
 * Compare the remote preview with a fresh export of `ref`.
 * @param {{ repoRoot?: string, ref?: string, remote?: string, target?: string, licensePath?: string, env?: NodeJS.ProcessEnv, selectScript?: string, log?: Log, thirdPartyNotices?: (dir: string) => { text: string, undetermined: string[] } }} [opts]
 */
export async function checkDrift({ repoRoot = ROOT, ref = DEFAULT_REF, remote, target = 'preview', licensePath, env = process.env, selectScript, log = () => {}, thirdPartyNotices } = {}) {
  const t = resolveTarget(target);
  remote = remote ?? defaultRemote(t);
  assertRemoteMatchesTarget(t, remote);
  const work = await mkdtemp(join(tmpdir(), 'source-preview-check-'));
  try {
    const { out, manifest } = await exportSnapshot({ repoRoot, ref, out: join(work, 'export'), target, licensePath, env, selectScript, log, thirdPartyNotices });
    const expected = exportTrees(out).comparable;
    const current = remoteTrees(remote);
    const actual = current?.comparable ?? null;
    return { inSync: expected === actual, expected, actual, commit: manifest.source.commit, previewCommit: current?.sourceCommit ?? null };
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

/**
 * Render `Co-authored-by:` trailers for the public sync commit (open-source-release P-011).
 * Accepted outside pull requests are ported into the private development tree, whose
 * commits are swept under one automation identity, so the contributor's credit has to
 * ride on the public commit that first ships their change. Each entry must be exactly
 * `Name <email>`: one line, no control characters, one angle-bracketed address — anything
 * else is refused rather than written into a commit message verbatim.
 * @param {string[]} [coAuthors]
 * @returns {string} '' when there are none, else a blank line plus one trailer per author
 */
export function coAuthorTrailers(coAuthors = []) {
  const seen = new Set();
  const lines = [];
  for (const raw of coAuthors) {
    const value = String(raw ?? '').trim();
    // eslint-disable-next-line no-control-regex
    if (/[\u0000-\u001f\u007f]/.test(value) || !/^[^<>@]+ <[^<>\s@]+@[^<>\s@]+\.[^<>\s@]+>$/.test(value)) {
      throw new PreviewError(`--co-author must be "Name <email>" on one line (got ${JSON.stringify(value)})`, 2);
    }
    const key = value.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    lines.push(`Co-authored-by: ${value}`);
  }
  return lines.length ? `\n\n${lines.join('\n')}` : '';
}

/**
 * Re-export, re-gate, and (with confirm) publish. The preview target is REPLACED by one
 * parentless commit (force push); the public target gets a new commit on top of its current
 * main, pushed without --force, so a concurrent push is refused rather than overwritten.
 * The gate runs before anything is committed; a failing gate pushes nothing.
 * @param {{ repoRoot?: string, ref?: string, remote?: string, target?: string, licensePath?: string, confirm?: boolean, env?: NodeJS.ProcessEnv, selectScript?: string, gate?: Gate, log?: Log, thirdPartyNotices?: (dir: string) => { text: string, undetermined: string[] }, coAuthors?: string[] }} [opts]
 */
export async function pushSnapshot({
  repoRoot = ROOT, ref = DEFAULT_REF, remote, target = 'preview', licensePath, confirm = false,
  env = process.env, selectScript, gate, log = () => {}, thirdPartyNotices, coAuthors = [],
} = {}) {
  const t = resolveTarget(target);
  remote = remote ?? defaultRemote(t);
  assertRemoteMatchesTarget(t, remote);
  // The public target also typechecks the cut the way its CI will (WI-10006584).
  gate = gate ?? defaultGateFor(t);
  // Validate credit BEFORE any export work, so a malformed --co-author costs nothing.
  const trailers = coAuthorTrailers(coAuthors);
  const work = await mkdtemp(join(tmpdir(), 'source-preview-push-'));
  try {
    const { out, manifest } = await exportSnapshot({ repoRoot, ref, out: join(work, 'export'), target, licensePath, env, selectScript, log, thirdPartyNotices });
    log('gating the export');
    const verdict = await gate(out, { env });
    if (!verdict.ok) return { pushed: false, reason: 'gate', verdict, commit: manifest.source.commit };
    const { tree, comparable } = exportTrees(out);
    const current = remoteTrees(remote);
    // An append target's main must be export lineage: its head carries MANIFEST.json with a
    // source commit. Anything else is the wrong repository, and appending would publish the
    // export on top of someone else's history (D-016). Checked before the dry-run return so a
    // dry run reports it too.
    if (t.history === 'append' && current && current.sourceCommit === null) {
      throw new PreviewError(`refusing to append to ${remote}: its main (${current.head}) is not an export commit (no MANIFEST.json source.commit) — wrong repository?`, 2);
    }
    if (current?.comparable === comparable) {
      return { pushed: false, reason: 'in-sync', verdict, tree, commit: manifest.source.commit, previewCommit: current.sourceCommit };
    }
    if (!confirm) return { pushed: false, reason: 'dry-run', verdict, tree, commit: manifest.source.commit };
    const gitDir = join(work, 'repo.git');
    run('git', ['init', '-q', '--bare', gitDir]);
    const base = ['--git-dir', gitDir, '--work-tree', out, '-c', 'core.autocrlf=false', '-c', 'core.fileMode=true'];
    run('git', [...base, 'add', '-A', '-f', '.']);
    const written = run('git', [...base, 'write-tree']).trim();
    const identity = { GIT_AUTHOR_NAME: 'Papercusp', GIT_AUTHOR_EMAIL: t.email, GIT_COMMITTER_NAME: 'Papercusp', GIT_COMMITTER_EMAIL: t.email };
    const append = t.history === 'append';
    const parentArgs = [];
    if (append && current) {
      // The parent must exist in this object store for commit-tree; a depth-1 fetch is
      // enough, and the push then sends only the new commit and its new objects.
      run('git', ['--git-dir', gitDir, 'fetch', '-q', '--depth', '1', remote, 'refs/heads/main']);
      const parent = run('git', ['--git-dir', gitDir, 'rev-parse', 'FETCH_HEAD^{commit}']).trim();
      if (parent !== current.head) throw new PreviewError(`public main moved during the push (${current.head} → ${parent}); re-run`);
      parentArgs.push('-p', parent);
    }
    const message = (append
      ? `Sync from ${SOURCE_REPO}@${manifest.source.commit.slice(0, 12)}\n\nPublic-safe source cut, gated. See MANIFEST.json, LICENSE and NOTICE.`
      : `Source preview of ${SOURCE_REPO}@${manifest.source.commit.slice(0, 12)}\n\nPublic-safe source cut, gated. See MANIFEST.json and NOTICE.`)
      + trailers;
    const commit = run('git', ['--git-dir', gitDir, 'commit-tree', written, ...parentArgs, '-m', message], { env: { ...process.env, ...identity } }).trim();
    run('git', ['--git-dir', gitDir, 'push', '-q', ...(append ? [] : ['--force']), remote, `${commit}:refs/heads/main`]);
    const after = remoteTrees(remote);
    if (after?.tree !== written || after?.head !== commit) throw new PreviewError(`push verification failed: remote main ${after?.head ?? 'missing'} (tree ${after?.tree ?? '-'}) ≠ ${commit} (tree ${written})`);
    return { pushed: true, verdict, tree: written, pushedCommit: commit, parent: parentArgs[1] ?? null, commit: manifest.source.commit };
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

function parseArgs(argv) {
  const [cmd, ...rest] = argv;
  const opts = { _: [], coAuthors: [] };
  for (let i = 0; i < rest.length; i += 1) {
    const a = rest[i];
    if (a === '--' && cmd === 'verifier-run') { opts.command = rest.slice(i + 1); break; }
    else if (a === '--confirm') opts.confirm = true;
    else if (a === '--runtime-artifacts') opts.runtimeArtifacts = true;
    else if (a === '--git-checkout') opts.gitCheckout = true;
    else if (a === '--tauri-inputs') opts.tauriInputs = true;
    else if (a === '--co-author') opts.coAuthors.push(rest[++i]);
    else if (['--inputs-file', '--budget-from', '--child-estimate-ms', '--preparation-max-ms', '--runtime-asset-donor', '--source-archive', '--operator-api-root', '--operator-api-source-receipt',
      '--operator-api-source-sha', '--operator-api-inputs', '--operator-api-inputs-sha'].includes(a)) {
      const path = rest[++i];
      if (!path || path.startsWith('--')) throw new PreviewError(`missing value for ${a}`, 2);
      opts[a.slice(2)] = path;
    }
    else if (['--ref', '--out', '--remote', '--json', '--target', '--repo', '--inputs', '--receipt', '--receipt-sha256'].includes(a)) opts[a.slice(2)] = rest[++i];
    else if (a.startsWith('--')) throw new PreviewError(`unknown flag ${a}`, 2);
    else opts._.push(a);
  }
  return { cmd, opts };
}

function printGate(verdict) {
  for (const r of verdict.results) {
    console.log(`  ${r.ok ? '✓' : '✗'} ${r.name}: ${r.status}`);
    if (!r.ok && r.detail) console.log(r.detail.split('\n').map((l) => `      ${l}`).join('\n'));
  }
}

async function main(argv) {
  if (argv[0] === 'bg-publication-check') {
    assert.ok(argv.length === 5 && argv[1] === '--context' && argv[3] === '--sha256',
      'BG publication check requires --context <retained expectation> --sha256 <independent digest>');
    const contextPath = argv[2], expectedHash = argv[4];
    assert.match(expectedHash ?? '', /^[a-f0-9]{64}$/, 'BG publication expectation digest is invalid');
    const original = readBgIndependentOutputIdentity(contextPath);
    assert.equal(original.sha256, expectedHash, 'BG publication expectation digest changed');
    const bytes = readFileSync(contextPath);
    assert.equal(createHash('sha256').update(bytes).digest('hex'), expectedHash,
      'BG publication expectation changed while reading');
    const publication = JSON.parse(bytes.toString('utf8'));
    // The retained original expectation is external to both the candidate and
    // its output stage. A published receipt cannot nominate its own authority.
    assertOutsideArchive(publication.binding.transaction.contexts.record.prepared.root, contextPath);
    assertOutsideArchive(publication.binding.transaction.stage, contextPath);
    verifyBgVerifierPublication(publication, publication);
    assert.deepEqual(readBgIndependentOutputIdentity(contextPath), original,
      'BG publication expectation changed during verification');
    // This verifies retained build evidence only. Full parent/runtime cohort,
    // guarded service activation and rollback remain separate obligations.
    console.log(JSON.stringify({ schemaVersion: 'bg-publication-check-v1', scope: 'publication-only',
      publication: publication.identity, entry: publication.logical.artifact.entry.path }));
    return 0;
  }
  if (argv[0] === 'bg-build-begin' || argv[0] === 'bg-build-run') {
    const flags = ['--context', '--sha256', '--pid', '--entry', '--outfile', '--profile', '--builder', '--repo'];
    const budgetPath = argv[0] === 'bg-build-run' && argv[17] === '--budget-from' ? argv[18] : undefined;
    assert.ok(argv.length === 1 + flags.length * 2 + (budgetPath ? 2 : 0) &&
      flags.every((flag, index) => argv[index * 2 + 1] === flag),
      'BG recipe requires its exact original transaction, digest, PID, command, builder and repository');
    const [contextPath, expectedHash, pidText, entry, outfile, profile, builder, repo] = flags.map((_, index) => argv[index * 2 + 2]);
    assert.ok(isAbsolute(contextPath) && /^[a-f0-9]{64}$/.test(expectedHash) && /^[1-9][0-9]*$/.test(pidText),
      'BG recipe transaction path, digest or PID is invalid');
    const bytes = readFileSync(contextPath);
    assert.equal(createHash('sha256').update(bytes).digest('hex'), expectedHash, 'BG transaction original digest changed');
    const transaction = JSON.parse(bytes.toString('utf8'));
    assert.deepEqual(transaction.recipe, { entry, outfile, profile }, 'BG recipe command differs from original transaction');
    const record = transaction.contexts.record;
    assert.equal(repo, record.prepared.root, 'BG recipe repository differs from selected generation');
    assert.equal(readBgFileIdentity(builder).sha256, record.invocation.builder.sha256,
      'BG recipe executing builder differs from original transaction');
    const actualNode = readBgFileIdentity(process.execPath);
    assert.ok(actualNode.realpath === record.invocation.node.realpath && actualNode.sha256 === record.invocation.node.sha256,
      'BG recipe actual Node differs from original transaction');
    if (argv[0] === 'bg-build-run') {
      const phasePath = `${contextPath}.phases.${pidText}.jsonl`;
      assertOutsideArchive(record.prepared.root, resolve(phasePath));
      const runPhase = verifierPhaseRunner(phasePath, process.env, `${phasePath}.child.json`);
      const publication = await runBgVerifierBuildRecipe({ transaction, ownerPid: Number(pidText), runPhase,
        ...(budgetPath ? { budget: { measurements: readVerifierPhaseMeasurements(budgetPath) } } : {}) });
      console.log(JSON.stringify(publication));
      return 0;
    }
    const binding = beginBgVerifierBuildTransaction({ transaction, ownerPid: Number(pidText) });
    const boundContext = join(transaction.stage, '.bg-build-context.json');
    // No caller may compile until BOTH exclusive records are complete. A failed
    // preflight retains its private stage for diagnosis and is never replayed.
    writeBgVerifierBinding(binding);
    console.log(boundContext);
    return 0;
  }
  if (argv[0] === 'bg-compiler') {
    assert.ok(argv[1] === '--context' && isAbsolute(argv[2] ?? '') && (argv[3] === '--' || argv[3] === '--check'),
      'bg-compiler requires --context <absolute original context> -- <recorded compiler argv>');
    const context = JSON.parse(await fs.readFile(argv[2], 'utf8'));
    if (argv[3] === '--check') {
      assert.equal(argv.length, 4, 'BG context check has unexpected arguments');
      const entries = context.schemaVersion === 'bg-build-contexts-v1'
        ? (validateBgVerifierBuildContexts(context), context.invocations.map(entry =>
          ({ record: { ...context.record, invocation: entry.original }, invocation: entry.invocation })))
        : [context];
      for (const entry of entries) verifyBgVerifierBuildRecord(entry.record, entry.invocation, 'before-build');
      return 0;
    }
    const selected = context.schemaVersion === 'bg-build-contexts-v1'
      ? selectBgVerifierBuildContext(context, argv.slice(4)) : context;
    const receipt = await compileBgVerifierInvocation({ ...selected, argv: argv.slice(4), expectedVersion: '0.25.0' });
    console.log(JSON.stringify(receipt));
    return 0;
  }
  const { cmd, opts } = parseArgs(argv);
  const log = (m) => console.error(`==> ${m}`);
  if (cmd === 'verifier-run') {
    if (!opts.repo || !opts.ref || !opts.receipt || !(opts.inputs || opts['inputs-file']) || !opts.command?.length)
      throw new PreviewError('verifier-run requires --repo, --ref, --receipt, --inputs or --inputs-file and -- <command>', 2);
    if (Boolean(opts['source-archive']) !== Boolean(opts['receipt-sha256']))
      throw new PreviewError('verifier-run source archive requires --source-archive and --receipt-sha256 together', 2);
    return runVerifierCommand({ repo: opts.repo, ref: opts.ref, receiptPath: opts.receipt,
      runtimeAssetDonor: opts['runtime-asset-donor'],
      sourceArchive: opts['source-archive']
        ? { root: opts['source-archive'], receiptSha256: opts['receipt-sha256'] } : undefined,
      inputs: opts.inputs?.split(',').filter(Boolean) ?? [], inputsFile: opts['inputs-file'],
      tauriInputs: opts.tauriInputs === true, command: opts.command,
      budgetFrom: opts['budget-from'], childEstimateMs: opts['child-estimate-ms'] === undefined ? 0 : Number(opts['child-estimate-ms']),
      preparationMaxMs: opts['preparation-max-ms'] === undefined ? undefined : Number(opts['preparation-max-ms']) });
  }
  if (cmd === 'verifier-inputs-check') {
    if (!opts.repo || !opts.ref || !(opts.inputs || opts['inputs-file'])) {
      throw new PreviewError('verifier input check requires --repo, --ref and --inputs or --inputs-file', 2);
    }
    const result = await validateVerifierInputs({ repo: opts.repo, ref: opts.ref,
      inputs: opts.inputs?.split(',').filter(Boolean) ?? [], inputsFile: opts['inputs-file'],
      tauriInputs: opts.tauriInputs === true, receiptSha256: opts['receipt-sha256'] });
    // This command runs inside the private dependency snapshot before th
