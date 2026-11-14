---
rel_path: "portability/census/v55/02-source-preview.mjs.part-006"
updated_at: 1794250602744
_body: "content"
---

e
    // native child. A stable census alone cannot detect an incomplete donor.
    const failures = findUnusableRuntimeDeps({ repoRoot: opts.repo });
    if (failures.length) throw new PreviewError(formatRuntimeFailures(failures), 2);
    console.log(JSON.stringify(result));
    return 0;
  }
  if (cmd === 'verifier-measure') {
    if (!opts.repo || !opts.ref) throw new PreviewError('verifier measurement requires explicit --repo and --ref', 2);
    console.log(measureVerifierSourceBytes({ repo: opts.repo, ref: opts.ref, receiptSha256: opts['receipt-sha256'] }));
    return 0;
  }
  if (cmd === 'verifier-prepare' || cmd === 'verifier-verify') {
    if (!opts.out || !opts.receipt) throw new PreviewError('verifier source requires --out and --receipt', 2);
    if (cmd === 'verifier-prepare') {
      if (!opts.repo || !opts.ref || !(opts.inputs || opts['inputs-file'])) {
        throw new PreviewError('verifier preparation requires explicit --repo, --ref and --inputs or --inputs-file', 2);
      }
      const receipt = await prepareVerifierSource({ repo: opts.repo, ref: opts.ref, dest: opts.out,
        inputs: opts.inputs?.split(',').filter(Boolean) ?? [], inputsFile: opts['inputs-file'], gitCheckout: opts.gitCheckout === true,
        tauriInputs: opts.tauriInputs === true,
        ...(Object.keys(opts).some(key => key.startsWith('operator-api-')) ? { operatorApi: {
          root: opts['operator-api-root'], sourceReceiptPath: opts['operator-api-source-receipt'],
          sourceReceiptSha256: opts['operator-api-source-sha'], inputReceiptPath: opts['operator-api-inputs'],
          inputReceiptSha256: opts['operator-api-inputs-sha'], outputPath: join(dirname(opts.receipt), 'operator-api-preflight.json'),
        } } : {}) });
      await fs.writeFile(opts.receipt, `${JSON.stringify(receipt)}\n`, { flag: 'wx', mode: 0o600 });
    }
    if (cmd === 'verifier-verify') {
      // Use the same retained journal as verifier-run. A synchronous census
      // cannot service timers, so retain its existing bounded progress too.
      const phasePath = `${resolve(opts.receipt)}.verify.${randomUUID()}.phases.jsonl`;
      assertOutsideArchive(opts.out, phasePath);
      const runPhase = verifierPhaseRunner(phasePath, process.env, `${phasePath}.child.json`);
      process.stderr.write(`VERIFIER_SOURCE_PHASES ${phasePath}\n`);
      await runPhase('source.verify', async () => verifyVerifierSource(opts.out,
        JSON.parse(await fs.readFile(opts.receipt, 'utf8')), {
          runtimeArtifacts: opts.runtimeArtifacts === true,
          progress: record => process.stderr.write(`VERIFIER_SOURCE_PROGRESS ${JSON.stringify(record)}\n`),
        }));
    } else {
      await verifyVerifierSource(opts.out, JSON.parse(await fs.readFile(opts.receipt, 'utf8')),
        { runtimeArtifacts: opts.runtimeArtifacts === true });
    }
    return 0;
  }
  if (cmd === 'licenses') {
    const census = await auditPublicRepositoryLicenses({ log });
    if (opts.json) await fs.writeFile(opts.json, `${JSON.stringify(census, null, 2)}\n`);
    console.log(census.summary);
    return census.exitCode;
  }
  loadReleaseHost();
  const target = resolveTarget(opts.target ?? 'preview');
  const remote = opts.remote ?? defaultRemote(target);
  const REPO = target.repo;
  if (cmd === 'export') {
    const out = opts.out ?? join(ROOT, '.papercusp', 'scratch', 'source-preview', `export-${target.key}-${Date.now()}`);
    const { manifest } = await exportSnapshot({ ref: opts.ref ?? DEFAULT_REF, out, target: target.key, log });
    console.log(`exported ${manifest.fileCount} files of ${SOURCE_REPO}@${manifest.source.commit} (+${manifest.submodules.length} submodules) → ${out}`);
    return 0;
  }
  if (cmd === 'gate') {
    const dir = opts._[0];
    if (!dir) throw new PreviewError('usage: gate <dir>', 2);
    const verdict = await defaultGateFor(target)(dir, {});
    printGate(verdict);
    // --json writes every finding (rule, path, line, sha256 — never the secret) for
    // reviewing new false positives into scripts/source-preview-allowlist.json.
    if (opts.json) await fs.writeFile(opts.json, `${JSON.stringify(verdict.findings ?? [], null, 2)}\n`);
    console.log(verdict.ok ? 'GATE: clean' : `GATE: refused (exit ${verdict.exitCode})`);
    return verdict.exitCode;
  }
  if (cmd === 'check') {
    const r = await checkDrift({ ref: opts.ref ?? DEFAULT_REF, remote, target: target.key, log });
    console.log(r.inSync
      ? `in sync: ${REPO} (snapshot of ${r.previewCommit}) ships the same content as a fresh export of ${SOURCE_REPO}@${r.commit}`
      : `DRIFT: ${REPO} ${r.actual ? `(snapshot of ${r.previewCommit ?? 'unknown'})` : '(no main branch)'} differs from a fresh export of ${SOURCE_REPO}@${r.commit} — run npm run preview:push${target.key === 'public' ? ' -- --target public' : ''}`);
    return r.inSync ? 0 : 1;
  }
  if (cmd === 'push') {
    const r = await pushSnapshot({ ref: opts.ref ?? DEFAULT_REF, remote, target: target.key, confirm: Boolean(opts.confirm), log, coAuthors: opts.coAuthors });
    printGate(r.verdict);
    if (r.reason === 'gate') { console.log('REFUSED: the gate found problems — nothing was pushed'); return r.verdict.exitCode; }
    if (r.reason === 'in-sync') { console.log(`already in sync: ${REPO} (snapshot of ${r.previewCommit}) ships the same content as ${SOURCE_REPO}@${r.commit} — nothing to push`); return 0; }
    if (r.reason === 'dry-run') { console.log(`dry run: would ${target.history === 'append' ? 'append a commit to' : 'replace'} ${REPO} main with tree ${r.tree} (${SOURCE_REPO}@${r.commit}). Re-run with --confirm.`); return 0; }
    console.log(`pushed ${r.pushedCommit}${r.parent ? ` (parent ${r.parent})` : ''} (tree ${r.tree}) = ${SOURCE_REPO}@${r.commit} → ${REPO}`);
    return 0;
  }
  console.error('usage: source-preview.mjs export|gate|check|push|licenses [--target preview|public] [--ref <ref>] [--out <dir>] [--remote <url>] [--json <file>] [--confirm] [--co-author "Name <email>"]...');
  return 2;
}

if (isCliEntry(import.meta.url)) {
  // Let pending stdout/stderr writes drain, including large piped receipts.
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; }, (err) => {
    console.error(`ERROR: ${err.message}`);
    process.exitCode = err instanceof PreviewError ? err.exitCode : 2;
  });
}

export { main as runCli };

