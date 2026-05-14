# LLM testing nightly cron — installation

Plan §12 Phase 5.

## Install (one-time, ~3 minutes)

```bash
# 1. Symlink the unit + timer into the user systemd dir.
ln -sf "$(pwd)/llm-test-nightly.service" ~/.config/systemd/user/
ln -sf "$(pwd)/llm-test-nightly.timer"   ~/.config/systemd/user/

# 2. Expose ANTHROPIC_API_KEY to systemd-user. Either:
#    a. Edit the .service file's `# Environment=...` line, or
#    b. Drop a file at ~/.config/environment.d/anthropic.conf:
#       ANTHROPIC_API_KEY=sk-ant-...

# 3. Reload systemd-user and enable.
systemctl --user daemon-reload
systemctl --user enable --now llm-test-nightly.timer
```

## Verify

```bash
systemctl --user list-timers llm-test-nightly.timer
systemctl --user status   llm-test-nightly.service
```

## Manual run

```bash
systemctl --user start llm-test-nightly.service
journalctl --user -u llm-test-nightly.service -f
```

Or run the script directly:

```bash
./llm-test-nightly.sh
```

Logs land in `~/.papercusp/llm-test-logs/llm-test-<TS>.log`.

## What it does

Hits `papercusp-desktop`'s operator at `$PAPERCUSP_OPERATOR_URL`
(default `http://127.0.0.1:3055`). If the operator isn't reachable
the script exits 0 and you'll see "operator not reachable — skipping"
in the journal — better than firing a noisy failure when the laptop
is closed.

Otherwise it runs `pnpm llm-test --target operator --target oracle`
which exercises every registered scenario (15 today). Findings land
in `harness_shared.llm_test_findings` with `acknowledged=false`. New
errors surface in `/admin/testing?tab=llm&subtab=findings` — that's
the alert surface; no separate notification system needed.

The script also runs a small SQL summary at the end (passed / failed
/ errored counts per target, total cost) into the log.

## Cost envelope

Per the plan §9 cost math:
- 12 operator scenarios + 3 oracle scenarios = 15 scenarios
- Average matrix N=3 for judge-heavy scenarios (most are)
- Sonnet SUT + Sonnet judge: ~$1.50–2.50 per matrix
- Nightly total: ~$25–40 / run = ~$750–$1200 / month

Tighten by:
- Editing `LLM_TEST_TARGETS` in the .service to drop oracle
- Setting `LLM_TEST_SUT_MODEL=claude-haiku-4-5` to use Haiku for SUT
  (judges still Sonnet for cross-model bias mitigation)
- Switching the timer to `OnCalendar=Mon` (weekly instead of nightly)

## Tighten the cron cadence

Edit the `.timer` file's `OnCalendar=` line:
- `OnCalendar=*-*-* 03:30:00` — nightly at 03:30 (default)
- `OnCalendar=Mon *-*-* 03:30:00` — weekly Mondays
- `OnCalendar=*-*-* 09,21:00:00` — twice a day at 09:00 + 21:00

After editing: `systemctl --user daemon-reload && systemctl --user restart llm-test-nightly.timer`.
