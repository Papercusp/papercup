# Verifying a build
URL: /internal/docs/build-system/verification

How to smoke-test each platform end-to-end before declaring the artifact good to ship.

## Naming note: the bundle is now `Papercusp GUI`, and there's a GUI/Server split

`src-tauri/tauri.conf.json`'s `productName` is now **`Papercusp GUI`**
(`identifier: com.papercusp.gui`, currently `version: 0.0.3`) — was plain
`Papercusp`. Tauri derives every bundle filename and the installed `.app`/install
directory from `productName`, so **every artifact below now carries a
`Papercusp GUI_<version>_…` filename**, the macOS app is `Papercusp GUI.app`
(mounted at `/Volumes/Papercusp GUI/`), and the Windows install dir/process is
`Papercusp GUI`. The in-window title bar (`app.windows[0].title`) is untouched —
it still reads plain **"Papercusp"**.

There is now also a **two-bundle GUI/Server split** — one Rust binary, two
Tauri roles baked via a distinct `identifier` (`src-tauri/src/app_role.rs` +
`tauri.server.conf.json`): **`Papercusp GUI`** (`com.papercusp.gui`, the desktop
app covered by this page) and **`Papercusp Server`** (`com.papercusp.server`, a
headless-hosting variant — see `bin/mac-vm-build.sh`). This page verifies the
**GUI** role only; don't confuse a `Papercusp Server_*` artifact for the one
these steps exercise. The Windows target list also grew an `nsis` bundle
(`.exe`) alongside `msi` — a Windows release now ships both.

The `0.0.3` in the examples below is illustrative and WILL be stale by the time
you read this — confirm the real value with
`node -p "require('./papercusp-desktop/src-tauri/tauri.conf.json').version"`
and substitute it (or just glob `Papercusp\ GUI_*_amd64.deb` etc.).

## Pre-flight check (any platform)

Re-run the auditor on every artifact:

```sh
papercusp-desktop/bin/audit-bundle.sh \
  "papercupai-workspace/papercup/papercusp-desktop/src-tauri/target/release/bundle/deb/Papercusp GUI_0.0.3_amd64.deb" \
  "/home/marsh-office/Papercusp GUI_0.0.3_x64.dmg" \
  "/home/marsh-office/Papercusp GUI_0.0.3_x64_en-US.msi" \
  "/home/marsh-office/Papercusp GUI_0.0.3_x64-setup.exe"
```

Or click **Audit prod bundles for PostHog leaks** in `/admin`. Should print
`OK: 4/4`. If any FAIL, **stop** — the artifact must not ship. (The `.dmg` name
now carries the build's arch, e.g. `_x64`/`_aarch64` — `mac-vm-build.sh` packs
per-arch DMGs itself via a direct `hdiutil create` rather than relying on
Tauri's `universal-apple-darwin` dmg bundler; if you build a genuine universal
binary through Tauri directly instead, the artifact is still
`Papercusp GUI_<version>_universal.dmg`.)

***

## Linux .deb verification

### 1. Install + launch

```sh
sudo dpkg -i "papercupai-workspace/papercup/papercusp-desktop/src-tauri/target/release/bundle/deb/Papercusp GUI_0.0.3_amd64.deb"
papercusp-desktop
```

⚠ **`papercusp` (bare) no longer launches the app** (WI-2902, 2026-07-05): the
postinstall script now writes `/usr/bin/papercusp` as a **setup/tutorial CLI
dispatcher** (`papercusp setup` / `papercusp tutorial` / `papercusp onboard` —
else it prints usage and exits 2). The actual GUI binary the .deb installs is
`papercusp-desktop` (the Cargo `[[bin]]` name) — launch that, or use the
installed desktop-menu icon.

Or click **Install + launch Linux .deb** in `/admin`.

Expected: a brief bootstrap page, then the window navigates to the operator UI within \~5–15s (a first boot pays `initdb` + migrations inside `serve.mjs`, so allow longer). Title bar "Papercusp". If it stays stuck on the bootstrap page, the sidecar never reached the preflight-ready state → check the serve logs.

### 2. Verify no discovery files leaked

```sh
sudo useradd -m papercusp-verify
sudo -u papercusp-verify ls -la ~papercusp-verify/.papercusp/ 2>&1
```

Expected: `No such file or directory`. The bundle never created the file.

### 3. Flag bootstrap silent

```sh
curl -s http://127.0.0.1:3055/api/flags/bootstrap | jq
```

Wait — the prod binary doesn't serve on `:3055`. The sidecar (`node serve.mjs`) picks a free port, which it records in `~/.papercusp/operator.json` (the authoritative source). Read it from there, or grep the listener.

```sh
PROD_PORT=$(jq -r .port ~/.papercusp/operator.json)
# Fallback if operator.json isn't present:
# PROD_PORT=$(ss -tnlp | awk '/serve\.mjs|node/{split($4,a,":"); print a[2]}' | sort -u | grep -v 3055 | head -1)
curl -s http://127.0.0.1:${PROD_PORT}/api/flags/bootstrap | jq
```

Expected — a `source: "defaults"` payload whose `flags` object carries the **full** flag map. `getAllFlags` builds it via `resolveWithDefaults`, which spreads every key in `FLAG_DEFAULTS` (libs/flags/src/types.ts), so on a clean install you get **all \~101 flag keys**, not a handful. Many of them legitimately default `true` (51 of the keys default on, 50 off), so a clean install showing lots of `true` flags is correct, not a leak. A representative excerpt:

```json
{
  "flags": {
    "papercusp-cloudflare-publish": false,
    "papercusp-harness-phases": false,
    "papercusp-design": false,
    "papercusp-testing": false,
    "papercusp-the-hive": true,
    "papercusp-video-channels": true,
    "papercusp-voice-channels": true
    // …all remaining flag keys, each at its FLAG_DEFAULTS value
  },
  "evaluatedAt": 1234567890,
  "source": "defaults"
}
```

`source` must be `"defaults"` (the only other values are `"posthog"` and `"override"`). A `"posthog"` source on a clean install means PostHog config leaked in. Don't diff against a fixed key list — verify each value against `FLAG_DEFAULTS` in `libs/flags/src/types.ts` (the authoritative full map). Two things to know when comparing: (1) the payload contains **every** flag key, so a verifier expecting a short fixed list will falsely flag a correct install; (2) `getAllFlags` runs the stored PG override row through `resolveWithDefaults`, which **drops retired/unknown keys** — e.g. `papercusp-oracle` (folded into `papercusp-testing` by owner ask 2026-06-10) and the long-gone `SNAPSHOTS` key (retired in `retire-snapshots-instance-spec-2026-06-09`; the reproducible clone is now the ungated InstanceSpec) will never appear even if the stored row still carries them. (`papercusp-templates` / `papercusp-marketplace` were likewise retired — distribution lives in the ungated Cupboard.)

### 4. No outbound PostHog traffic

```sh
sudo ss -tnp | grep -E "flags.papercuspai|posthog"
```

Expected: empty.

### 5. Embedded PG discovery

```sh
cat ~/.papercusp/embedded-pg.json
cat ~/.papercusp/operator.json
```

Expected: JSON with a non-5432 port (both files written by `serve.mjs`). **Confirms the desktop spawned its own embedded PG, didn't talk to native `:5432`.**

### 6. Feature data loads

In the app, navigate to **Harness → sheets**. The Feature Queue panel should populate with features (not empty). No errors in the DevTools console.

### 7. Closed-flag routes really 404

```sh
curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:${PROD_PORT}/design
```

Expected: `404`. The V1 contract requires `notFound()` to return real HTTP 404, not a 200-page-with-404-content.

### 8. Cleanup

```sh
sudo dpkg -r papercusp-gui
sudo userdel -r papercusp-verify
```

(Tauri kebab-cases `productName` for the deb package name — `Papercusp GUI` →
`papercusp-gui`. The deb's `conflicts`/`replaces` also name `papercusp-server`,
the Server-role package, so the two can't be installed side by side.)

***

## macOS .dmg verification

### 1. Install

```sh
ssh -i ~/.ssh/papercup-vm-mac -p 2222 aviweiss@127.0.0.1
```

In the Mac VM:

```sh
scp -i ~/.ssh/papercup-vm-mac -P 2222 \
  "/home/marsh-office/Papercusp GUI_0.0.3_x64.dmg" \
  aviweiss@127.0.0.1:~

hdiutil attach "~/Papercusp GUI_0.0.3_x64.dmg"
cp -R "/Volumes/Papercusp GUI/Papercusp GUI.app" /Applications/
hdiutil detach "/Volumes/Papercusp GUI"
xattr -dr com.apple.quarantine "/Applications/Papercusp GUI.app"
```

`bin/mac-vm-build.sh` builds the GUI and Server roles (`PAPERCUSP_BUILD_ROLES`,
default `gui server`) and packs each role's DMG itself via a direct `hdiutil
create -srcfolder` — **not** Tauri's own dmg bundler — because that fork's
mount/detach step was hitting DiskArbitration timeouts under post-reboot
Spotlight indexing. The GUI role's DMG is named
`Papercusp GUI_<version>_<arch>.dmg` (arch = `x64`/`aarch64`, from
`MAC_BUILD_TARGET`), volume-named `Papercusp GUI`, containing `Papercusp
GUI.app` (+ a bundled tutorial app + an `/Applications` symlink). If you instead
build a genuine universal binary straight through Tauri (`--target
universal-apple-darwin`), the artifact is `Papercusp GUI_<version>_universal.dmg`
— check which build path produced the artifact you're verifying before assuming
the arch suffix.

Or click **Install + launch Mac .dmg** in `/admin`. (If the admin command still
names an old `Papercusp_*` / `x86_64`-suffixed file, that name is now stale —
substitute the current `Papercusp GUI_<version>_<arch>.dmg` artifact.)

### 2. Verify no discovery files leaked

```sh
find "/Applications/Papercusp GUI.app" -name "posthog*.json" 2>&1
```

Expected: empty.

### 3. Launch (view via SPICE)

On the Linux host:

```sh
remote-viewer spice://127.0.0.1:5930 &
```

In the Mac VM:

```sh
open "/Applications/Papercusp GUI.app"
```

Same window-loads check as Linux.

### 4. Flag bootstrap test

Inside the Mac VM, find the operator port (`ss -tnp` doesn't exist; use `lsof -iTCP -sTCP:LISTEN -P`) and curl `/api/flags/bootstrap`. Same expected JSON.

### 5. Verify no `.papercusp/` was created

```sh
ls -la ~/.papercusp/ 2>&1
```

Expected: file should NOT exist (running the app under the test user should not have created posthog.json).

### 6. Cleanup

```sh
rm -rf "/Applications/Papercusp GUI.app"
```

***

## Windows .msi / .exe (nsis) verification

`tauri.conf.json`'s Windows bundle targets are now **both `msi` and `nsis`** —
a release ships an `.msi` (WiX) AND a `Papercusp GUI_<version>_x64-setup.exe`
(NSIS) side by side. The steps below use the `.msi`; substitute the NSIS
`.exe` and run it non-interactively (`/S`) if you're verifying that target
instead.

### 1. Install

```sh
scp -i ~/.ssh/papercup-vm-win -P 2223 \
  "/home/marsh-office/Papercusp GUI_0.0.3_x64_en-US.msi" \
  User@127.0.0.1:.

ssh -i ~/.ssh/papercup-vm-win -p 2223 User@127.0.0.1 \
  "msiexec /i 'C:\\Users\\User\\Papercusp GUI_0.0.3_x64_en-US.msi' /quiet"
```

Or click **Install + launch Windows .msi** in `/admin`. Wait \~30s. Installs to
`C:\Program Files\Papercusp GUI\`.

### 2. Verify no discovery files leaked

```sh
ssh -i ~/.ssh/papercup-vm-win -p 2223 User@127.0.0.1 \
  'powershell "Get-ChildItem -Recurse -Path \"C:\\Program Files\\Papercusp GUI\" -Filter posthog*.json"'
```

Expected: empty.

### 3. Launch

```sh
ssh -i ~/.ssh/papercup-vm-win -p 2223 User@127.0.0.1 \
  'powershell "Start-Process \"C:\\Program Files\\Papercusp GUI\\Papercusp GUI.exe\""'
```

(No SPICE configured on the Windows VM by default; verify via `tasklist |
findstr Papercusp` to confirm running.)

### 4. Flag bootstrap test

In Windows PowerShell, curl `http://127.0.0.1:<port>/api/flags/bootstrap`. Same expected JSON.

### 5. Verify no `.papercusp/` directory

```sh
ssh -i ~/.ssh/papercup-vm-win -p 2223 User@127.0.0.1 \
  'powershell "Test-Path C:\\Users\\User\\.papercusp\\posthog.json"'
```

Expected: `False`.

### 6. Uninstall

```sh
ssh -i ~/.ssh/papercup-vm-win -p 2223 User@127.0.0.1 \
  "wmic product where name='Papercusp GUI' call uninstall /nointeractive"
```

Or via Settings → Apps → Papercusp GUI → Uninstall.

***

## FAIL criteria (any platform)

| Symptom                                                                                     | Means                                                                                                                                                                                |
| ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| A real PostHog key (`phx_…` / `phc_…`) found by `audit-bundle.sh` inside the install        | Secret leaked into bundle — **must** rebuild                                                                                                                                         |
| `/api/flags/bootstrap` returns `source: "posthog"` on a clean install                       | PostHog config (env var or discovery file) made it through — leak                                                                                                                    |
| A flag value disagrees with `FLAG_DEFAULTS` in `libs/flags/src/types.ts` on a clean install | Default ship-state violated — leak. (Note: 51 flags default `true`, so a clean install with many `true` flags is **correct** — only a *mismatch* against `FLAG_DEFAULTS` is a leak.) |
| A retired key (e.g. `papercusp-oracle`, `papercusp-snapshots`) appears in the payload       | `resolveWithDefaults` should have dropped it — stored override row leaking retired keys                                                                                              |
| `ss -tnp` shows connection to `flags.papercuspai.com`                                       | App phoning home in clean-install state — leak                                                                                                                                       |
| Window stuck on the bootstrap page (never navigates off `web/index.html`)                   | The sidecar never became ready — check the preflight handshake / serve logs                                                                                                          |
| `embedded-pg.json` / `operator.json` missing, or app connects to `:5432`                    | Embedded PG didn't bootstrap (`serve.mjs` owns this)                                                                                                                                 |
| Sheets harness shows 0 features when the API returns features                               | Feature loading broken                                                                                                                                                               |
| Window shows the **dev** server's app (URL has `:3055`)                                     | The webview pointed at the dev server instead of the bundled sidecar — rebuild                                                                                                       |

***

## A self-contained checklist

Copy this and run top to bottom:

```sh
# 1. Auditor pass
papercusp-desktop/bin/audit-bundle.sh \
  "papercupai-workspace/papercup/papercusp-desktop/src-tauri/target/release/bundle/deb/Papercusp GUI_0.0.3_amd64.deb" \
  "/home/marsh-office/Papercusp GUI_0.0.3_x64.dmg" \
  "/home/marsh-office/Papercusp GUI_0.0.3_x64_en-US.msi" \
  "/home/marsh-office/Papercusp GUI_0.0.3_x64-setup.exe"

# 2. Linux install + launch + smoke
sudo dpkg -i "papercupai-workspace/papercup/papercusp-desktop/src-tauri/target/release/bundle/deb/Papercusp GUI_0.0.3_amd64.deb"
setsid /usr/bin/papercusp-desktop >/dev/null 2>&1 < /dev/null &
sleep 15
PORT=$(jq -r .port ~/.papercusp/operator.json)
echo "operator port: $PORT"
curl -s "http://127.0.0.1:${PORT}/api/flags/bootstrap" | jq .source       # → "defaults"
curl -s -o /dev/null -w "%{http_code}\n" "http://127.0.0.1:${PORT}/design"  # → 404
sudo ss -tnp | grep -E "flags.papercuspai|posthog" || echo "no posthog traffic ✓"

# 3. Cleanup
pkill -KILL papercusp-desktop
sudo dpkg -r papercusp-gui
```

(`/usr/bin/papercusp` is now a setup/tutorial CLI dispatcher, not the app
launcher — see the callout above. The GUI binary + package name changed to
`papercusp-desktop` / `papercusp-gui`; only the bundle/app-directory display
name changed to `Papercusp GUI`.)

When every line is green, the artifact is ship-ready for that platform.
