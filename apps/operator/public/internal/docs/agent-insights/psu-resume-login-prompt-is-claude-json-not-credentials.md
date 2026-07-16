# `psu --resume` asks you to log in? It's `.claude.json`, not your credentials

URL: /internal/docs/agent-insights/psu-resume-login-prompt-is-claude-json-not-credentials

A `psu --resume` (or desktop Resume) that boots claude into the first-run `/login` wizard despite a healthy system login is almost never a credentials problem — `.credentials.json` is fine. The session's isolated `CLAUDE_CONFIG_DIR` is missing `.claude.json`, which is where claude keeps `oauthAccount` / `hasCompletedOnboarding` / trust (i.e. "am I signed in") AND the user-level `papercusp-su` MCP server. The dir comes up config-less when it was built by `rematerializeSession` (archive holds the transcript only) or `writeSpawnClaudeConfig` (a bee/plan-run dir: creds symlink only). The "re-run it and it works the second time" symptom is a TELL, not luck: attempt 1's claude mints its own stub `.claude.json` (an account but no `mcpServers`), which attempt 2 reads — so the second session stops prompting while silently running TOOL-LESS and lock-hook-less on the shared tree. Fix = re-ensure the interactive dir at every resume leg (`ensureInteractiveClaudeConfig`), not the credential reheal. (EI-12938, owner-hit 2026-07-16.)

## The three-file mental model

A psu claude session runs under a per-session `CLAUDE_CONFIG_DIR`
(`~/.papercusp/session-claude/<owner>`). Three things in it decide whether an
interactive launch is healthy, and they are easy to conflate:

| file | carries | what breaks if it's wrong/missing |
|---|---|---|
| `.credentials.json` | the OAuth token | claude can't authenticate at all |
| `.claude.json` | `oauthAccount`, `hasCompletedOnboarding`, per-project trust, **the user-level `papercusp-su` mcpServer** | claude boots the first-run **/login wizard**, and/or the session is **MCP-dark from birth** |
| `settings.json` | the file-lock + coord **hooks**, bypass permission mode | the shared-tree lock discipline is silently OFF |

The trap: a resume already re-heals `.credentials.json` (`rehealResumeCredentials`
in `psu-launcher.mjs`). Credentials being valid is what makes you look elsewhere
— but **credentials are not account state.** A dir can have a perfectly valid
credential symlink and still send you to `/login`, because that decision is read
from `.claude.json`, which isn't there.

## Why the dir comes up config-less

A FRESH launch is always fine: bootstrap-su calls `writeInteractiveClaudeConfig`,
which builds the full symlink mirror of `~/.claude` + `~/.claude.json`. A RESUME
does no bootstrap POST, and two writers produce a dir that is NOT launch-ready:

- **`rematerializeSession`** (an ended session whose transcript the
  archive-at-death lifecycle deleted ~15s after end): the archive holds the
  **transcript only**, so the restored dir has `projects/**` and nothing else.
- **`writeSpawnClaudeConfig(persistentDir)`** (a headless bee / plan-run):
  a **deliberately minimal** dir — the creds symlink only, no plugins/settings
  (correct for a `-p` worker that must resolve zero plugins).

Hand either of those to a human and claude treats it as a first-run user.

## The "second attempt works" tell

This is the diagnostic signature. On the failing attempt, claude — finding no
`.claude.json` — runs first-run onboarding (the /login screen) and then **mints
its own stub** `.claude.json` (~1 KB, ~10 keys): an `oauthAccount` derived from
the creds symlink, but **no `mcpServers`**, `hasCompletedOnboarding` unset. The
NEXT launch in the same dir reads that stub, sees a signed-in account, and stops
prompting. So "it worked the second time" = attempt 1 repaired the file it should
have been handed — and left a session with an account but **no papercusp-su
tools and no lock hooks**. That silently-degraded "success" is worse than the
loud login prompt; it is exactly what shows up later as an interactive
**MCP-dark** session (see the mcp-dark-watchdog) that even a manual `/mcp` can't
heal, because there's no papercusp-su server in the config to reconnect to.

## Root cause was a MISSING CALL, not a broken repair

`writeInteractiveClaudeConfig` was correct and well-tested the whole time. The
2026-07-12 fix that re-ensures the dir after a rematerialize was bolted onto
**one** of `rematerializeSession`'s callers — the HTTP route
`POST /adv/sessions/rematerialize`. The other interactive caller,
`console-launcher.ts` (the desktop **Resume** button), calls `rematerializeSession`
directly and kept handing out transcript-only dirs for four more days. Every unit
test was green while the owner stared at a login screen. **When a repair exists
but the symptom persists, look for the caller that skips it before you suspect the
repair.**

## Two traps that will bite a fixer here

1. **A dangling `.claude.json` symlink lstats as a symlink.** A readiness check
   that stops at `lstatSync(p).isSymbolicLink()` calls a dir with a *dangling*
   link "ready" — the link's target was deleted/relocated, so claude gets
   nothing (the same wizard by a different door). Read THROUGH the link
   (`readFileSync` + `JSON.parse`) so a dangling/corrupt link fails the check.
2. **`linkInto` is `present()`-skipped, so the stub blocks its own repair.**
   The mirror's `linkInto` is idempotent — it no-ops when the dest already
   exists (a resume re-materialize must not double-link). So claude's first-run
   stub `.claude.json` would **block the mirror from replacing it**, and the dir
   would stay tool-less forever. The repair must **`rm` a not-launch-ready
   `.claude.json` first**, then materialize. (A healthy/pruned dir returns before
   this — untouched.)

## The fix + how readiness is judged

`ensureInteractiveClaudeConfig({ sid })` (in `interactive-claude-config.ts`) is
the one repair, behind a ready-check, called at every interactive resume leg:
`console-launcher.ts`, psu's own leg (via `POST /adv/sessions/ensure-claude-config`,
because `psu-launcher.mjs` is plain node and can't import the TS mirror), and the
rematerialize route. Readiness keys on `.claude.json`:

- a symlink **that resolves** ⇒ the mirror linked the real config in — **ready**;
- a real file **with `mcpServers`** ⇒ a P-020 pruned fleet copy — **ready**
  (never un-pruned);
- a real file **without `mcpServers`** ⇒ claude's first-run stub — **NOT ready**
  (an account, but no MCP/hooks — repair it);
- absent / dangling / corrupt ⇒ **NOT ready**.

Deliberately NOT called from inside `rematerializeSession`: the wake-executor
restores into a headless bee's dir, whose plugin-free isolation is the point.
"Interactive" is the caller's claim to make.

## How to verify a resume is genuinely healthy (not stub-healthy)

Don't trust "it stopped prompting." Check the dir the session runs under:

```bash
D=~/.papercusp/session-claude/<owner-id>
ls -A "$D" | wc -l                 # a real mirror is ~77+ entries, not ~2-6
readlink "$D/.claude.json"         # should resolve to ~/.claude.json
python3 -c "import json;print(list(json.load(open('$D/.claude.json'))['mcpServers']))"  # must include papercusp-su
python3 -c "import json;print('hooks' in json.load(open('$D/settings.json')))"          # lock hooks present
```

If `.claude.json` is a ~1 KB real file with no `mcpServers`, that's the stub —
the session is MCP-dark and lock-hook-less regardless of whether it prompted.
