# Project History — generate a portable history page for any Papercusp project
URL: /internal/docs/build-system/project-history

The installed papercusp project-history command, versioned artifact contract, scope controls, commit provenance, consumer adapter pattern, and stale-output verification.

Papercusp Project History is a generated, versioned read model for product-facing History pages. It is reusable across projects: the installed CLI reads the selected Papercusp harness and Git repository, the pure @papercusp/plan-parser assembler produces schema v1, and each app supplies only a thin transport/view adapter.

## Generate an artifact

Run from the consumer repository:

```bash
papercusp project-history generate \
  --harness my-project \
  --prefix= \
  --project-id my-project \
  --project-name "My Project" \
  --repo . \
  --output .papercusp/project-history.v1.json
```

The default plan filter is `<harness>-`; `--prefix=` deliberately disables it and exports the complete harness. Use `--workspace` when the process does not already carry PAPERCUSP\_WORKSPACE. Repository origin, GitHub web URL, and default branch are detected from Git and may be overridden explicitly.

JSON is the portable default. For a server package that wants a build-time import, add `--format typescript --export-name PROJECT_HISTORY`; this changes transport only, not schema. Add the identical command with `--check` to a focused build/test gate. Check mode compares deterministic output and fails without rewriting when the committed artifact is stale.

## Authority and provenance

The artifact is disposable derived output. Plan/work-item ledgers, git\_sync\_commit\_attribution, and Git remain authoritative. Completion tree stamps describe what was verified before git-sync and are never treated as landed commits. Commit links retain attribution (`authoritative`, `body-reference`, or `inferred`) and remote status (`confirmed`, `local-only`, or `unknown`). A browser URL is emitted only when repository web identity is known.

## Consumer contract

A consumer may serve JSON statically or import generated TypeScript through an API. Project-specific code chooses harness/prefix/project identity, exposes the artifact, and composes presentation. It must not fork parsing or assembly logic. Extend @papercusp/plan-parser when the shared schema needs a field. Reject unknown schemaVersion values rather than guessing compatibility.

## Installed packaging

Desktop builds ship `sidecar/scripts/project-history.mjs` as a narrow self-contained bundle and route it through `~/.papercusp/bin/papercusp` and the Debian `/usr/bin/papercusp` twin. Consumers invoke the bare installed command; they never require PAPERCUSP\_REPO\_ROOT or a Papercusp source checkout. The bundle uses the shared ESM HOST\_BANNER because yaml's CommonJS dynamic require otherwise fails only after packaging.

## Template onboarding

Compose `papercusp-project-history`. Its GUIDE carries the decision points and its portable `project-history-artifact` check validates JSON or generated TypeScript for schema version, project id, harness, generator, and plan-count integrity.

## Verification checklist

1. `papercusp project-history help` works from the installed dispatcher.
2. Generate once, then rerun the same command with `--check`.
3. Run the portable aspect check with TEMPLATE\_CHECKS\_CONFIG.
4. Run the consumer's focused API/UI tests.
5. Verify any rendered page against the committed artifact; no live operator/database connection should be required.
