# iPhone sanitized reviewer capture runbook
URL: /internal/docs/agent-insights/iphone-sanitized-reviewer-capture-runbook

Run the maintained disposable operator, validate public pairing controls and seeded device feeds, then capture exact-candidate paired iOS screenshots.

## Purpose and current evidence

Use the maintained disposable Tauri operator for sanitized paired screenshots. It has its own PostgreSQL database and temporary Cloudflare HTTPS tunnel. The fixture seeds only synthetic content through tools pinned to that operator; it copies no private workspace data.

WI-10007029 tracks acceptance. The local fixture suite passed 36 tests with zero skips on 2026-10-07. Corrected public controls, paired device-feed readback and native CI capture have not yet executed. This procedure remains draft until live receipts exist. GitHub check 112575432899 currently reports that billing/spending eligibility prevented its job from starting. Unsigned simulator capture and Apple signing are separate requirements.

## Controls and seed readback

From the canonical Papercusp staging tree:

```sh
bash scripts/reviewer-operator.sh --controls-only
```

The dependencies are node, python3, cloudflared and socat. Evidence goes to a private directory under XDG\_STATE\_HOME, defaulting to \~/.local/state. The runner starts one tunnel and calls scripts/verify-tauri-headless.sh exactly once with the maintained isolated ready seed.

The verifier checks its complete source-lock census before and after source copying. A held input prevents the run: await its holder's completion/release and preserve previous receipts. Do not bypass the guard or launch a retry loop.

The assertion requires local health=200, a schema-valid local mint=200 for the real isolated workspace, and local admin=200. The minted QR must advertise the expected HTTPS origin and workspace with an unexpired token. It then requires tunnel health=200, unauthenticated device access=401, and tunnel mint/admin=403. A 400, 404 or 5xx cannot satisfy a security control.

A separate token pairs the readback device through the public tunnel and checks the seeded Plans, Inbox and shared conversation records. This preserves the QR token reserved for native CI. Logs contain labels and statuses only; pair/device tokens and response bodies remain private.

Read the printed evidence directory's verifier.log and retained verifier phase receipts. A passing unit suite is not live public-control evidence. Preserve any failed prepare, boot or assert attempt and fix/audit its defect class before another expensive run.

## Exact-candidate native capture

Read current GitHub annotations and resolve the intended mobile ref to its full SHA first. Resolve a current billing refusal before dispatching.

```sh
export REVIEWER_MOBILE_REF='<candidate-ref>'
export REVIEWER_MOBILE_SHA='<full-40-character-candidate-sha>'
bash scripts/reviewer-operator.sh --capture-native
```

This path also requires gh. It refuses an existing PAPERCUP\_PAIR\_PAYLOAD Actions secret and checks that the remote ref still names the supplied SHA. It installs only this attempt's bare QR JSON through stdin, then dispatches Papercusp/papercup-rust-mobile ci.yml with paired\_ui=true. The disposable fixture stays alive until capture finishes.

The runner identifies a unique workflow\_dispatch run with that SHA created after dispatch. It downloads `iphone-native-candidate-<sha>` from that exact run and requires exactly one ci-paired-ui-summary.json with passedTests=1, failedTests=0 and skippedTests=0. It writes native-capture-receipt.json beside the private artifact. Keep screenshots and xcresult private.

On an incomplete attempt it cancels only the observed run, removes its own Actions secret and QR file, and stops its tunnel/isolated verifier. If a GitHub cleanup command fails, inspect the failure and reconcile the exact run/secret before another attempt. Never overwrite another attempt's existing secret.

## Review-window and cloud requirements

The screenshot fixture ends with the command. App Review separately requires sanitized internet access that remains usable for the entire review window and has been exercised from a clean install. Do not paste a short-lived one-use token into advance review notes.

The Apple-only packet is papercup-rust-mobile/store/APP-STORE-REVIEW\.md. Cloud/BYOC copy stays pending until live relay proof satisfies iphone-public-release-2026-08-11#D-014 and #D-016. This fixture establishes no TestFlight, durable reviewer-access, cloud-compatibility or public-availability claim.

## Recurrence checks

```sh
PAPERCUSP_TEST_RUN_HARNESS=papercusp npm run test:file -- apps/operator/lib/reviewer-operator-fixture.test.ts
```

These registered tests cover ambient-workspace refusal, schema-valid local-before-remote controls, exact HTTP statuses, malformed/expired QR refusal, secret-safe logging, paired seeded-feed readback, SHA/secret-ownership preflight, native summary acceptance and secret cleanup after dispatch failure. Actual public controls and native artifacts remain separate acceptance receipts.
