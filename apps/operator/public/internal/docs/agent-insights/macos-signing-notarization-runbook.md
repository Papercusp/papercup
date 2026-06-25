# macOS code signing + notarization — the turnkey public-release runbook
URL: /internal/docs/agent-insights/macos-signing-notarization-runbook

For a PUBLIC macOS release the .app MUST be Apple-signed (Developer ID Application) + notarized + stapled, or Gatekeeper refuses it on every fresh Mac ('Apple cannot check it for malicious software'). The build pipeline (mac-vm-build.sh → tauri build) already signs+notarizes automatically WHEN the Apple credentials are present in env — so this is gated only on the OWNER supplying: an Apple Developer Program membership, a Developer ID Application cert imported on build VM :2222, and notarytool creds (APPLE_ID + app-specific password + APPLE_TEAM_ID, or an App Store Connect API key). Entitlements (entitlements.plist) are already wired for the embedded-Node JIT under the hardened runtime.

import { Aside } from '@astrojs/starlight/components';

The one **owner-action** blocker between the current build and a confident
**public** macOS release. Everything else (the never-trap setup gate, the
`.gitmodules` fix, the build pipeline) is done in code; this needs Apple
credentials an agent cannot obtain.

The alpha bundle is unsigned/un-notarized (plan
`mac-desktop-release-readiness-2026-06-11` D-002 — first launch needed
right-click → Open or `xattr -dr com.apple.quarantine`). That is fine for a
handful of insiders but **not** for the public: Gatekeeper blocks an unsigned,
un-notarized app downloaded from the internet with *"Papercusp can't be opened
because Apple cannot check it for malicious software,"* and most users delete it
rather than dig through System Settings → Privacy & Security to override.

## The good news: the pipeline already does it — when creds are present

`tauri build` (invoked by `bin/mac-vm-build.sh`) **automatically** code-signs
every bundled executable and notarizes + staples the `.app`/`.dmg` **iff** the
Apple env vars below are set. Tauri v2 signs sidecars and frameworks too, so the
embedded `node` / `gh` / `pg_*` / `zellij` binaries are covered. No script change
is required — the gate is purely the credentials.

`entitlements.plist` is already created and referenced from
`tauri.conf.json > bundle > macOS > entitlements`. It is **required**: under the
hardened runtime (which notarization forces on) the embedded Node V8 JIT is
killed without `com.apple.security.cs.allow-jit` +
`allow-unsigned-executable-memory`, and the mixed sidecar binaries need
`disable-library-validation`. (The entitlements file is inert for an unsigned
build, so it is safe in the tree today.)

## What the OWNER must provide (one-time)

1. **Apple Developer Program membership** (\~$99/yr) for the Papercusp Apple
   account — required to issue a *Developer ID Application* certificate (the
   cert type for apps distributed **outside** the App Store).
2. A **`Developer ID Application: <Name> (<TEAMID>)` certificate**, created at
   developer.apple.com → Certificates, exported from Keychain Access as a
   password-protected `.p12`.
3. A **notarytool credential**, either:
   * an **app-specific password** for the Apple ID
     (appleid.apple.com → Sign-In & Security → App-Specific Passwords), **or**
   * an **App Store Connect API key** (`.p8` + Key ID + Issuer ID) — preferred
     for automation (doesn't expire with the Apple ID password).

## One-time install on build VM :2222

```sh
# On the Mac build VM (ssh -p 2222 aviweiss@127.0.0.1):
security import DeveloperID.p12 -k ~/Library/Keychains/login.keychain-db \
  -P '<p12-password>' -T /usr/bin/codesign
security find-identity -v -p codesigning   # copy the "Developer ID Application: …" line
```

## Per-build env (set before bin/mac-vm-build.sh)

`mac-vm-build.sh` already inherits the SSH env, so export these in the remote
shell (or add them to the `release-local.sh` WITH\_MAC leg):

```sh
export APPLE_SIGNING_IDENTITY="Developer ID Application: <Name> (<TEAMID>)"
# Notarytool — Apple ID path:
export APPLE_ID="<apple-account-email>"
export APPLE_PASSWORD="<app-specific-password>"   # NOT the account password
export APPLE_TEAM_ID="<TEAMID>"
# …or App Store Connect API-key path instead of the three above:
#   export APPLE_API_KEY="<KEYID>"; export APPLE_API_ISSUER="<ISSUERID>"
#   export APPLE_API_KEY_PATH="$HOME/AuthKey_<KEYID>.p8"
```

(If the cert is provided only as a base64 `.p12`, set `APPLE_CERTIFICATE` +
`APPLE_CERTIFICATE_PASSWORD` instead of pre-importing — Tauri infers the
identity. `APPLE_SIGNING_IDENTITY` overrides `tauri.conf > bundle > macOS >
signingIdentity`.)

## Verify the result

```sh
APP=src-tauri/target/universal-apple-darwin/release/bundle/macos/Papercusp.app
codesign --verify --deep --strict --verbose=2 "$APP"
codesign -dvv "$APP" 2>&1 | grep -E 'Authority|TeamIdentifier'   # Developer ID, your TEAMID
spctl --assess --type execute --verbose "$APP"                   # → "accepted, source=Notarized Developer ID"
xcrun stapler validate "$APP"                                    # → "The validate action worked!"
```

A truly fresh Mac (no quarantine override, never seen the cert) should then open
the downloaded `.dmg` → app with **no** Gatekeeper warning.

## Caveats specific to this app

* **Sidecar arch / Rosetta (D-006).** The sidecar is x86\_64-only; on Apple
  Silicon it runs under Rosetta 2 (one-time `softwareupdate --install-rosetta`).
  Signing/notarization still succeed, but say so in the public release notes, or
  ship a universal sidecar to drop the requirement (plan
  `mac-public-release-readiness-2026-06-25` P-007).
* **Notarization is slow** (Apple-side, minutes) and runs in the same
  `tauri build`. Budget for it in the release window.
* **Updater payloads** stay minisign-signed (separate from Apple signing) — that
  already works.
