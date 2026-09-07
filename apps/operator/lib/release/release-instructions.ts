/**
 * The "Instructions" section of the beta release-history page — the owner's own
 * words to beta testers, kept as SOURCE so the page can be regenerated from it.
 *
 * [owner 2026-07-27] wrote this text and asked for it as a section headed
 * "Instructions" on the releases page, placed ABOVE the download tables. The
 * placement is the owner's decision and it is load-bearing: the first thing the
 * text says is that the GUI is *not* the ready part — `psu` is. A tester who
 * reads that after downloading has already formed the wrong expectation.
 *
 * ── Why this lives in its own module ────────────────────────────────────────
 * It is CONTENT, not layout. release-history-page.ts renders the release
 * registry; this is prose a human rewrites between releases. Keeping it here
 * means editing it is a one-file diff with no risk of disturbing the renderer,
 * and the renderer stays a pure function of (registry, content).
 *
 * It stays a TypeScript constant rather than a `.md` file on disk because the
 * renderer is a pure, dependency-free function used by tests and by the CLI —
 * a filesystem read at generation time would make "what does the page say"
 * depend on cwd, on packaging, and on which checkout generated it.
 *
 * ── Editing it ──────────────────────────────────────────────────────────────
 * It is GitHub-flavoured markdown, rendered to HTML at GENERATION time (never
 * in the browser — the page must read with JavaScript disabled). Raw HTML is
 * passed through, which is how the warning callout gets `class="warn"`. After
 * editing, regenerate and re-publish:
 *
 *   npx tsx apps/operator/lib/release/record-release-cli.ts --regenerate
 *   papercusp-desktop/bin/publish-release-history.sh
 *
 * ⚠ Do NOT edit the generated HTML in the bundle directory — the next
 * `--regenerate` overwrites it and the edit vanishes silently.
 *
 * ⚠ Every link here is rendered with `target="_blank"`, and the page ships
 * `<meta name="referrer" content="no-referrer">`, so clicking out never hands
 * the secret release path to Discord or anyone else. Keep it that way.
 */

/** The section heading, as the owner asked for it. */
export const INSTRUCTIONS_HEADING = 'Instructions';

/**
 * The beta Discord invite — ONE definition, because two pages now show it.
 *
 * The holding page (renderHoldingHtml) keeps this link when everything else on
 * the page is stripped, so a copy pasted into both places would eventually
 * diverge and the held page would send testers to a dead invite at exactly the
 * moment it is their only way to reach a human.
 */
export const DISCORD_URL = 'https://discord.gg/HjRQ8g4Nju';

/**
 * The owner's text, lightly copy-edited at the owner's direction [owner
 * 2026-07-27]: typos fixed, every sentence and the voice kept. The one approved
 * structural change is that the all-caps "THE GUI NOT READY YET" line became a
 * styled warning callout carrying the same words — louder, without shouting.
 *
 * ⛔ "chat with Papercup" is CORRECT and deliberate — do NOT change it to
 * "Papercusp". Papercup is the assistant in the quickpanel; Papercusp is the
 * product. A copy-edit pass "fixed" this once and the owner had to send it back
 * [owner 2026-07-27]. The two names differ by one letter on purpose; when in
 * doubt, leave the owner's spelling alone.
 */
export const INSTRUCTIONS_MD = `
<p>I'm making myself available on <a href="${DISCORD_URL}">this Discord</a> if you have any questions.</p>

<p class="warn">⚠ The GUI is not ready yet. What <em>is</em> ready already is the <strong>psu</strong> utility — not the GUI. After install, run <code>psu</code> from the command line. That is where the magic happens.</p>

1. Install it, and then launch the **Papercusp Server** and **Papercusp GUI**. There should be a button in the GUI that takes you to the tutorial and setup in the command line. I haven't read through the tutorial much yet, so it could be inaccurate. If it doesn't come up, just run \`papercusp tutorial\` in the command line to launch it. The only things you need to complete the setup are:
   - **A.** Install an agent backend if you don't have one yet (it supports Claude, Codex, and OMP (Oh My Pie)).
   - **B.** Choose an embeddings provider so that mem0 works well for agent memory — with OpenAI, active use would be <$20 a month, or you can use Harrier-OSS-0.6b for local and comparable performance. ([platform.openai.com/api-keys](https://platform.openai.com/api-keys))
2. From the terminal, run the command \`psu\`, select your agent backend, and follow the prompts.
3. Ask the agent to create something for you, and choose to launch a fleet.
4. Get floored.

The agents should be smart enough now to sniff out when you are trying to do something that Papercusp has native support for, and ask you questions to get you to use the full power of the system — but in case they don't, you can ask them more specifically to *"Create a Pot for an app that does such and such using a fleet of 4 Sonnet 5 high-effort agents using the default system login."* You should see them create a plan, launch terminals on your desktop, the plan items get turned into work items and get claimed by the agents, and you should just see them communicate in a way that is obviously useful (*another agent just told me my fix had a bug, let me go fix it now*). You can launch the fleets headless or headed, but when they are on your desktop you can easily see the messages they are sending back and forth. In the Papercusp icon in your taskbar there is also a place you set the shortcut for launching the quickpanel, which lets you search docs, save prompts, or chat with Papercup. They should put themselves on Papercusp loops and end their own sessions and pick up again where they left off (this is instead of compaction), and they should just build things for you without being annoying. The system works best with Opus 4.8 xhigh.

### Auto Loop

The Mug/Kettle/Blender auto-loop system for 100% autonomy is not working reliably yet. When implementing a plan, they should ask you if you want them to either 1. implement it themselves, 2. launch a fleet, or 3. hand it to the Mug. Don't expect #3, handing to the Mug, to be reliable yet. The intent of the auto-loop system is to run when you want 100% autonomy including the prioritization, and the SU agents launched with the psu utility when you want more direction — but only the psu utility is ready.

### SU Agents (\`psu\` command)

Working with the SU agents provides the perfect blend of autonomy and direction for actually building things. You can ask them to go into these modes, but direct them what to focus on while in the mode.

#### Modes

- **AUTO** — They'll put themselves on a Papercusp loop, and run continuously without asking you any questions. They will end their session once they get close to their soft limit (by default, for fleet leaders it's 400k, 250k for fleet members).
- **COLD AUTO** — Same as above, but instead of restarting their session at a token limit, each turn is an entirely fresh session (with carried information, so they should continue where they left off — but regular AUTO mode has gotten way more testing than COLD AUTO).
- **IDEATE** — Tell them to ideate on something and they will try to think of novel improvements. Powerful when combined with AUTO mode.
- **DRAIN** — Tell them to drain all bugs with a fleet of 10 ChatGPTs and they'll pull bugs off of the work queue in AUTO mode until there are none left.
- **GRADE** — Tell them to grade something and they should automatically use an existing rubric or create a new one. This tracks their grading, so they can easily look back and track the performance history of whatever system you are trying to improve. A rubric stores the testing procedure, and a graded rubric becomes a scorecard which is persisted so that they can track the history.

#### Other things good to know

You can ask them to set their own token limit to adjust their soft token limit. Pretty much everything is configurable, and you can ask them and they should figure it out.

### Still needs to be tested

#### Self-improvement

Don't like something about Papercusp? Ask it to improve something about itself — it has access to its own code and knows how to get it to deploy so you see the live changes. That's what the "local / prod / staging / dev / release" buttons up top are. Mess something up? Click the "release" button to go back to the release version. This has not been tested thoroughly on the release builds yet, but has been working super on my machine, and making this work is a priority for the next release. This is literally how I built all of Papercusp. In case you actually mess up the switcher, <kbd>Ctrl</kbd>+<kbd>Alt</kbd>+<kbd>1</kbd>/<kbd>2</kbd>/<kbd>3</kbd>/<kbd>4</kbd>/<kbd>5</kbd> will switch between the different versions.

- **Dev (:3270)** — your own working-tree build: the cloned checkout exactly as it sits on disk, uncommitted edits included.
- **Staging (:3170)** — the shared integration tree: a worktree pinned to the latest staging branch, where everyone's merged-but-not-yet-released work lands. No tests need to pass for the code to land here. Agents are instructed not to commit anything to git, and the commits to staging happen on a schedule in the background by a git-sync routine. If a merge fails, a merge agent is spun up to resolve it.
- **Prod (:3070)** — the green main/release tree, the deployed build of what's been promoted to main. To get here automatically, code has to pass a test suite. Agents are alerted when the test suite fails so that they can resolve it. You can also ask them to force-deploy to main to skip the test suite, and you can ask them to create tests.
- **Local (:3055)** — the hot-reloading Vite SPA frontend for UI development; it has no operator of its own — its /api calls proxy to prod (:3070).
- **Release** — the immutable bundled sidecar that shipped inside the installed package. It's never rebuilt from source and is deliberately un-disableable. It's the always-good escape hatch if every source-built env is broken.

### GUI settings

There are additional settings in the GUI (you can also just ask the agents to configure these). The important ones are:

#### Inference

You can auth multiple Claude Max / Codex accounts and then use the "inference gateway" to route to these accounts. When launching an agent with the psu utility, or launching a fleet, you can choose to pin their account to "auto", which will automatically pick the best account available based on current usage and rate limits — or you can ask the agent to pin them to a specific account. By default, if you don't specify either, they will just use the default system account you are logged in as. You can also mark one account as the DEFAULT here, which takes over that fallback role — for Claude and for Codex/OpenAI alike, each steering its own provider's traffic. This has not been tested thoroughly on the release builds yet, but has been working super on my machine, and making this work is a priority for the next release.

### Not ready

A lot of work went into these features, but they are not ready yet.

- **Voice integration**, so you can build things with your voice.
- **P2P features**, so agents can coordinate on the same project across machines. Includes a p2p git implementation as well.
- **Backups** — works on my machine, but I haven't tested it on the release version. Automated Kopia backups.
`.trim();
