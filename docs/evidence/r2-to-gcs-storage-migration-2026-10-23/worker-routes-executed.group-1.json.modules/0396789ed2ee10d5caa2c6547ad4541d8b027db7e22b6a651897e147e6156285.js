'use strict';async (__vite_ssr_exports__,__vite_ssr_import_meta__,__vite_ssr_import__,__vite_ssr_dynamic_import__,__vite_ssr_exportAll__,__vite_ssr_exportName__,__filename,__dirname,module,exports,require)=>{{__vite_ssr_exportName__("WORKSPACE_HOST_DESKTOP_PACK_CONTRACT_VERSION", () => { try { return WORKSPACE_HOST_DESKTOP_PACK_CONTRACT_VERSION } catch {} });
__vite_ssr_exportName__("WORKSPACE_HOST_DESKTOP_PACK_ATTESTATION_PREFIX", () => { try { return WORKSPACE_HOST_DESKTOP_PACK_ATTESTATION_PREFIX } catch {} });
__vite_ssr_exportName__("DEFAULT_WORKSPACE_HOST_DESKTOP_USER", () => { try { return DEFAULT_WORKSPACE_HOST_DESKTOP_USER } catch {} });
__vite_ssr_exportName__("DEFAULT_WORKSPACE_HOST_DESKTOP_GROUP", () => { try { return DEFAULT_WORKSPACE_HOST_DESKTOP_GROUP } catch {} });
__vite_ssr_exportName__("WORKSPACE_HOST_DESKTOP_ROOT", () => { try { return WORKSPACE_HOST_DESKTOP_ROOT } catch {} });
__vite_ssr_exportName__("PINNED_KASMVNC_ARTIFACT", () => { try { return PINNED_KASMVNC_ARTIFACT } catch {} });
__vite_ssr_exportName__("WORKSPACE_HOST_DESKTOP_PACK_APT", () => { try { return WORKSPACE_HOST_DESKTOP_PACK_APT } catch {} });
__vite_ssr_exportName__("WORKSPACE_HOST_DESKTOP_BROWSER_REPO", () => { try { return WORKSPACE_HOST_DESKTOP_BROWSER_REPO } catch {} });
__vite_ssr_exportName__("WORKSPACE_HOST_DESKTOP_PACK_PHASES", () => { try { return WORKSPACE_HOST_DESKTOP_PACK_PHASES } catch {} });
__vite_ssr_exportName__("WORKSPACE_HOST_DESKTOP_PACK_CHECKS", () => { try { return WORKSPACE_HOST_DESKTOP_PACK_CHECKS } catch {} });
__vite_ssr_exportName__("buildWorkspaceDesktopEgressRules", () => { try { return buildWorkspaceDesktopEgressRules } catch {} });
__vite_ssr_exportName__("buildWorkspaceHostDesktopPackScript", () => { try { return buildWorkspaceHostDesktopPackScript } catch {} });
__vite_ssr_exportName__("parseWorkspaceHostDesktopPackAttestation", () => { try { return parseWorkspaceHostDesktopPackAttestation } catch {} });
const __vite_ssr_import_0__ = await __vite_ssr_import__("/@fs/home/marsh-office/papercupai-workspace/papercusp/libs/generic/deployment-driver/src/workspace-host-test-harness.ts", {"importedNames":["assertWorkspaceHostSecretIsolation"]});
const __vite_ssr_import_1__ = await __vite_ssr_import__("/@fs/home/marsh-office/papercupai-workspace/papercusp/libs/generic/deployment-driver/src/workspace-host-build-manifest.ts", {"importedNames":["WORKSPACE_HOST_DESKTOP_SESSION_ENTRYPOINT"]});
const __vite_ssr_import_2__ = await __vite_ssr_import__("/@fs/home/marsh-office/papercupai-workspace/papercusp/libs/generic/deployment-driver/src/workspace-host-bootstrap.ts", {"importedNames":["APT_BOUNDED_HELPER_LINES","WORKSPACE_HOST_CURL_STALL_GUARD","DEFAULT_WORKSPACE_HOST_AGENT_USER","DEFAULT_WORKSPACE_HOST_SERVICE_USER","DEFAULT_WORKSPACE_HOST_WORKSPACE_USER","WORKSPACE_HOST_BOOTSTRAP_UBUNTU_VERSION","WORKSPACE_HOST_DATA_ROOT","WORKSPACE_HOST_RUNTIME_ROOT","WORKSPACE_HOST_STATE_ROOT"]});



const WORKSPACE_HOST_DESKTOP_PACK_CONTRACT_VERSION = "papercusp-workspace-host-desktop-pack-v1";
const WORKSPACE_HOST_DESKTOP_PACK_ATTESTATION_PREFIX = "PAPERCUSP_WORKSPACE_HOST_DESKTOP_PACK_ATTESTATION=";
const DEFAULT_WORKSPACE_HOST_DESKTOP_USER = "papercusp-desktop";
const DEFAULT_WORKSPACE_HOST_DESKTOP_GROUP = "papercusp-desktop";
const WORKSPACE_HOST_DESKTOP_ROOT = "/var/lib/papercusp-desktop";
const PINNED_KASMVNC_ARTIFACT = {
  version: "1.5.0",
  debUrl: "https://github.com/kasmtech/KasmVNC/releases/download/v1.5.0/kasmvncserver_noble_1.5.0_amd64.deb",
  debSha256: "f599fe02e2175b9817b6165f74a5d2bebdc73118dde9181ba3410963bed7ae1e",
  debBytes: 2653112
};
const WORKSPACE_HOST_DESKTOP_PACK_APT = {
  /** KasmVNC's own declared Depends that are not in the base image. */
  kasmvncRuntime: [
    "libgl1",
    "libgbm1",
    "libxfont2",
    "libxtst6",
    "libunwind8",
    "xauth",
    "x11-xkb-utils",
    "xkb-data",
    "ssl-cert",
    "libswitch-perl",
    "libyaml-tiny-perl",
    "libhash-merge-simple-perl",
    "liblist-moreutils-perl",
    "libtry-tiny-perl",
    "libdatetime-perl",
    "libdatetime-timezone-perl"
  ],
  /** The window manager. openbox draws chrome through plain X11 and needs no GL. */
  windowManager: ["openbox"],
  /**
   * gl-strategy's measured ladder. `libgl1-mesa-dri` is what makes the mesa-software
   * rung real on a GPU-less VM; without it the honest measurement is `tier: 'none'`
   * and every capture from the desktop is untrustworthy by construction.
   */
  gl: ["libgl1-mesa-dri", "libegl1", "mesa-utils"],
  /** D-010's a11y bus: a dbus-daemon plus AT-SPI. Ordering is enforced in a11y-bus.ts. */
  accessibility: ["dbus-daemon", "at-spi2-core"],
  /** The driver layer D-021 keeps X-bound: xdotool input, `import` capture. */
  driver: ["xdotool", "imagemagick", "x11-utils"],
  /** D-015/D-016 per-app confinement. */
  sandbox: ["bubblewrap", "nftables"],
  /**
   * The floor of a USABLE desktop (WI-10002863). Without these a started desktop is a
   * black X root with openbox alone: Watch cannot tell it from a dead stream, and
   * openbox's right-click menu points at `x-terminal-emulator`, which nothing provides.
   * `xterm` registers that alternative; `x11-xserver-utils` ships `xsetroot`, which the
   * session worker uses to paint the root a non-black colour.
   */
  desktopFloor: ["xterm", "x11-xserver-utils"],
  /**
   * The customer-facing desktop (WI-10002863, owner: XFCE). Named components, never the
   * `xfce4`/`xubuntu-desktop` metapackages: those pull a display manager. xfwm4 is the WM
   * of this session; openbox stays above for the bare agent desktops. `dbus-bin` ships
   * `dbus-run-session`, which gives the session the full bus xfconf needs; the a11y bus's
   * minimal bus cannot activate it. The icon theme is named because --no-install-recommends
   * otherwise leaves the panel with blank launchers.
   */
  desktopEnvironment: [
    "xfce4-session",
    "xfwm4",
    "xfce4-panel",
    "xfdesktop4",
    "xfce4-settings",
    "xfce4-terminal",
    "thunar",
    "dbus-bin",
    "adwaita-icon-theme"
  ],
  /** Verifies the pinned Mozilla signing key before its repo is trusted (see install-browser). */
  browserKeyring: ["gpg"]
};
const WORKSPACE_HOST_DESKTOP_BROWSER_REPO = {
  keyUrl: "https://packages.mozilla.org/apt/repo-signing-key.gpg",
  keyFingerprint: "35BAA0B33E9EB396F59CA838C0BA5CE6DC6315A3",
  source: "https://packages.mozilla.org/apt mozilla main",
  origin: "packages.mozilla.org",
  package: "firefox"
};
const WORKSPACE_HOST_DESKTOP_PACK_PHASES = [
  "validate-host",
  "install-x-stack",
  "install-kasmvnc",
  "harden-listener",
  "create-desktop-identity",
  "install-desktop-runtime",
  "attest-pack"
];
const WORKSPACE_HOST_DESKTOP_PACK_CHECKS = [
  "ubuntu-24.04",
  "host-bootstrapped",
  "kasmvnc-digest",
  "kasmvnc-binary",
  "loopback-only-listener",
  "desktop-identity",
  // The mirror of `workspace-credential-isolation`. That one proves the desktop user
  // CANNOT reach what isn't its own; this proves it CAN reach what is. Attesting only
  // the negative let the pack report `status: healthy` on a host whose desktop root was
  // unusable, which is the precise failure this pack's install-time checks exist to
  // turn into "one legible failure" rather than "desktops silently do not work".
  "desktop-root-writable",
  "workspace-credential-isolation",
  "x-stack",
  "a11y-stack",
  "gl-stack",
  "desktop-environment",
  "browser",
  "desktop-runtime",
  "desktop-socket",
  "desktop-egress-isolation",
  // personal-cloud-desktop-2026-10-06 (D-001): the second worker instance, which runs as
  // the customer workspace account for the person's own desktop.
  "personal-desktop-runtime",
  // The negative pair: each worker mode refuses the other's account, so neither class
  // of desktop can be served under the wrong Unix identity.
  "personal-desktop-identity",
  "personal-desktop-socket"
];
function shellQuote(value) {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
function buildWorkspaceDesktopEgressRules(uid) {
  if (uid !== "$DESKTOP_UID" && (!Number.isSafeInteger(uid) || uid <= 0)) throw new Error("desktop egress requires a non-root uid");
  return `add table inet papercusp_desktop
add chain inet papercusp_desktop output { type filter hook output priority -10; policy accept; }
flush chain inet papercusp_desktop output
add rule inet papercusp_desktop output meta skuid ${uid} ct direction reply accept
add rule inet papercusp_desktop output meta skuid ${uid} ip daddr 127.0.0.53 meta l4proto { tcp, udp } th dport 53 accept
add rule inet papercusp_desktop output meta skuid ${uid} ip daddr 169.254.169.254 meta l4proto { tcp, udp } th dport 53 accept
add rule inet papercusp_desktop output meta skuid ${uid} fib daddr type local reject
add rule inet papercusp_desktop output meta skuid ${uid} ip daddr 169.254.0.0/16 reject
add rule inet papercusp_desktop output meta skuid ${uid} ip6 daddr { fe80::/10, fc00::/7 } reject
`;
};
function assertPublicHttps(url, label) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`Desktop pack ${label} must be an absolute URL`);
  };
  if (parsed.protocol !== "https:") {
    throw new Error(`Desktop pack ${label} must be https`);
  };
  if (parsed.username || parsed.password || parsed.search) {
    throw new Error(`Desktop pack ${label} must not carry credentials or a query string`);
  }
}
function buildWorkspaceHostDesktopPackScript(input) {
  if (input.contractVersion !== WORKSPACE_HOST_DESKTOP_PACK_CONTRACT_VERSION) {
    throw new Error(
      `Desktop pack contract mismatch: expected ${WORKSPACE_HOST_DESKTOP_PACK_CONTRACT_VERSION}`
    );
  };
  if (input.action !== "install") {
    throw new Error(`Desktop pack action ${String(input.action)} is not implemented; only install is supported`);
  };
  if (!input.hostId.trim()) throw new Error("Desktop pack requires a hostId");
  if (input.publicMetadata) {
    (0,__vite_ssr_import_0__.assertWorkspaceHostSecretIsolation)(input.publicMetadata, "desktopPack.publicMetadata");
  };
  const artifact = input.artifact ?? PINNED_KASMVNC_ARTIFACT;
  assertPublicHttps(artifact.debUrl, "artifact.debUrl");
  if (!/^[0-9a-f]{64}$/.test(artifact.debSha256)) {
    throw new Error("Desktop pack artifact.debSha256 must be a lowercase 64-char sha256");
  };
  const desktopUser = input.isolation?.desktopUser ?? DEFAULT_WORKSPACE_HOST_DESKTOP_USER;
  const desktopGroup = input.isolation?.desktopGroup ?? DEFAULT_WORKSPACE_HOST_DESKTOP_GROUP;
  const workspaceUser = input.isolation?.workspaceUser ?? __vite_ssr_import_2__.DEFAULT_WORKSPACE_HOST_WORKSPACE_USER;
  const serviceUser = input.isolation?.serviceUser ?? __vite_ssr_import_2__.DEFAULT_WORKSPACE_HOST_SERVICE_USER;
  const agentUser = input.isolation?.agentUser ?? __vite_ssr_import_2__.DEFAULT_WORKSPACE_HOST_AGENT_USER;
  if (desktopUser === workspaceUser || desktopUser === serviceUser || desktopUser === agentUser) {
    throw new Error(
      `Desktop pack refuses desktopUser=${desktopUser}: sandbox desktops must not run as the workspace, service, or agent account. Between them those accounts hold the customer checkout, its git credentials, and the delivered agent credentials, so reusing one would make a sandbox escape a credential compromise — which is the exact bleed this pack exists to prevent.`
    );
  };
  for (const user of [desktopUser, desktopGroup, workspaceUser, serviceUser, agentUser]) {
    if (!/^[a-z_][a-z0-9_-]{0,31}$/.test(user)) throw new Error("Desktop pack requires valid Unix account names");
  };
  if (desktopUser !== DEFAULT_WORKSPACE_HOST_DESKTOP_USER || desktopGroup !== DEFAULT_WORKSPACE_HOST_DESKTOP_GROUP) {
    throw new Error("Desktop runtime requires the fixed papercusp-desktop identity");
  };
  if (workspaceUser !== __vite_ssr_import_2__.DEFAULT_WORKSPACE_HOST_WORKSPACE_USER) {
    throw new Error("Personal desktop runtime requires the fixed papercusp-workspace identity");
  };
  const apt = [
    ...WORKSPACE_HOST_DESKTOP_PACK_APT.kasmvncRuntime,
    ...WORKSPACE_HOST_DESKTOP_PACK_APT.windowManager,
    ...WORKSPACE_HOST_DESKTOP_PACK_APT.gl,
    ...WORKSPACE_HOST_DESKTOP_PACK_APT.accessibility,
    ...WORKSPACE_HOST_DESKTOP_PACK_APT.driver,
    ...WORKSPACE_HOST_DESKTOP_PACK_APT.sandbox,
    ...WORKSPACE_HOST_DESKTOP_PACK_APT.desktopFloor,
    ...WORKSPACE_HOST_DESKTOP_PACK_APT.desktopEnvironment,
    ...WORKSPACE_HOST_DESKTOP_PACK_APT.browserKeyring
  ];
  const browser = WORKSPACE_HOST_DESKTOP_BROWSER_REPO;
  const script = `#!/usr/bin/env bash
# Papercusp workspace-host DESKTOP PACK (${WORKSPACE_HOST_DESKTOP_PACK_CONTRACT_VERSION})
# Opt-in, layered, post-provision. Never part of the base image (D-018 / D-022).
set -euo pipefail

HOST_ID=${shellQuote(input.hostId)}
DESKTOP_USER=${shellQuote(desktopUser)}
DESKTOP_GROUP=${shellQuote(desktopGroup)}
WORKSPACE_USER=${shellQuote(workspaceUser)}
SERVICE_USER=${shellQuote(serviceUser)}
AGENT_USER=${shellQuote(agentUser)}
DESKTOP_ROOT=${shellQuote(WORKSPACE_HOST_DESKTOP_ROOT)}
KASM_URL=${shellQuote(artifact.debUrl)}
KASM_SHA=${shellQuote(artifact.debSha256)}
KASM_VERSION=${shellQuote(artifact.version)}
KASM_YAML=/etc/kasmvnc/kasmvnc.yaml

phase() { echo "PAPERCUSP_DESKTOP_PACK_PHASE=$1"; }
fail()  { echo "PAPERCUSP_DESKTOP_PACK_FAIL=$1" >&2; exit 1; }
# Bounded retry for archive access: one missed fetch must not fail the pack (WI-10002837).
# Exhaustion returns non-zero, so set -e still stops the script exactly as a single try did.
# Every networked apt call is wall-clock bounded: one apt-get update ran ~30 min on a first
# boot without apt's own timeouts ending it (WI-10002863). Fetches are bounded, dpkg is not.
${__vite_ssr_import_2__.APT_BOUNDED_HELPER_LINES.join("\n")}
retry() { local max="$1" attempt=1; shift; until "$@"; do (( attempt >= max )) && return 1; echo "attempt $attempt/$max failed, retrying in $(( attempt * 5 ))s: $*" >&2; sleep $(( attempt * 5 )); attempt=$(( attempt + 1 )); done; }

# ── validate-host ───────────────────────────────────────────────────────────────────
. /etc/os-release
[ "\${ID:-}" = ubuntu ] || fail ubuntu-24.04
[ "\${VERSION_ID:-}" = ${shellQuote((0,__vite_ssr_import_2__.WORKSPACE_HOST_BOOTSTRAP_UBUNTU_VERSION))} ] || fail ubuntu-24.04
# The pack LAYERS onto a bootstrapped host; it does not bootstrap one. Refusing here
# turns "desktops silently do not work" into one legible failure at install time.
[ -d ${shellQuote((0,__vite_ssr_import_2__.WORKSPACE_HOST_RUNTIME_ROOT))} ] || fail host-bootstrapped
phase validate-host

# ── install-x-stack ─────────────────────────────────────────────────────────────────
export DEBIAN_FRONTEND=noninteractive
# --error-on=any: an unreachable archive is otherwise only a warning with exit 0.
retry 10 apt_update -qq --error-on=any
# --no-install-recommends is what keeps this a PACK and not a desktop environment:
# several of these recommend a display manager, and a workspace host must never
# acquire a login screen as a side effect of opting into agent desktops.
retry 5 apt_install -y --no-install-recommends ${apt.join(" ")}

# The browser: Mozilla's real deb (see WORKSPACE_HOST_DESKTOP_BROWSER_REPO). The fingerprint
# is checked BEFORE the key is installed, for the same reason as the KasmVNC digest below.
# The pin outranks Ubuntu's snap stub, whose epoch makes its version compare higher.
install -d -m 0755 /etc/apt/keyrings
MOZ_KEY=/etc/apt/keyrings/packages.mozilla.org.asc
curl -fsSL --retry 3 ${__vite_ssr_import_2__.WORKSPACE_HOST_CURL_STALL_GUARD} --proto '=https' --tlsv1.2 -o "$MOZ_KEY.tmp" ${shellQuote(browser.keyUrl)}
[ "$(gpg --show-keys --with-colons "$MOZ_KEY.tmp" | awk -F: '$1=="fpr"{print $10; exit}')" = ${shellQuote(browser.keyFingerprint)} ] \\
  || { rm -f "$MOZ_KEY.tmp"; fail browser; }
mv "$MOZ_KEY.tmp" "$MOZ_KEY"
chmod 0644 "$MOZ_KEY"
echo "deb [signed-by=$MOZ_KEY] ${browser.source}" > /etc/apt/sources.list.d/mozilla.list
printf 'Package: *\\nPin: origin ${browser.origin}\\nPin-Priority: 1000\\n' > /etc/apt/preferences.d/mozilla
retry 10 apt_update -qq --error-on=any
retry 5 apt_install -y --no-install-recommends ${browser.package}
phase install-x-stack

# ── install-kasmvnc ─────────────────────────────────────────────────────────────────
# Not in the Ubuntu archive, so fetch + verify by digest. The digest is checked BEFORE
# dpkg is allowed near the file: verifying afterwards would mean a substituted package
# had already run its maintainer scripts as root.
KASM_DEB="$(mktemp -t kasmvnc-XXXXXX.deb)"
trap 'rm -f "$KASM_DEB"' EXIT
curl -fsSL --retry 3 ${__vite_ssr_import_2__.WORKSPACE_HOST_CURL_STALL_GUARD} --proto '=https' --tlsv1.2 -o "$KASM_DEB" "$KASM_URL"
echo "$KASM_SHA  $KASM_DEB" | sha256sum -c - >/dev/null 2>&1 || fail kasmvnc-digest
retry 5 apt_install -y --no-install-recommends "$KASM_DEB"
command -v Xkasmvnc >/dev/null 2>&1 || fail kasmvnc-binary
command -v kasmvncpasswd >/dev/null 2>&1 || fail kasmvnc-binary
phase install-kasmvnc

# ── harden-listener ─────────────────────────────────────────────────────────────────
# D-020. The package ships network.interface: 0.0.0.0; this is the override, and the
# check below re-reads the file rather than trusting that the write happened.
mkdir -p /etc/kasmvnc
cat > "$KASM_YAML" <<'KASMYAML'
# Papercusp desktop pack — MANAGED FILE, regenerated by the pack on every install.
# The listener is loopback-only by policy (D-020): sandbox desktops are reachable
# exclusively through the workspace-host operator's ticket-gated proxy, never
# directly. Widening the interface value here silently exposes every agent desktop on
# the VM's external interface, so the pack asserts this value as a named check.
network:
  interface: 127.0.0.1
  protocol: http
  ssl:
    require_ssl: false
desktop:
  allow_resize: true
  pixel_depth: 24
KASMYAML
chmod 0644 "$KASM_YAML"
grep -qE '^[[:space:]]+interface:[[:space:]]*127\\.0\\.0\\.1[[:space:]]*$' "$KASM_YAML" \\
  || fail loopback-only-listener
grep -qE '^[[:space:]]+interface:[[:space:]]*0\\.0\\.0\\.0' "$KASM_YAML" \\
  && fail loopback-only-listener
phase harden-listener

# ── create-desktop-identity ─────────────────────────────────────────────────────────
# A third identity, owning nothing but desktops. --no-create-home because the home is
# created explicitly below at 0700; letting adduser create it applies the skel and the
# default mode, which on this image is world-readable.
getent group "$DESKTOP_GROUP" >/dev/null || groupadd --system "$DESKTOP_GROUP"
getent passwd "$DESKTOP_USER" >/dev/null || useradd --system \\
  --gid "$DESKTOP_GROUP" --home-dir "$DESKTOP_ROOT" --no-create-home \\
  --shell /usr/sbin/nologin "$DESKTOP_USER"
install -d -o "$DESKTOP_USER" -g "$DESKTOP_GROUP" -m 0700 "$DESKTOP_ROOT"

# Ownership is NOT evidence of usability: \`install -d\` runs as root and succeeds even
# when every ancestor denies the owner traversal, which is exactly how a desktop root
# nested under the service user's 0750 state root passed every other check while being
# unwritable by the only account that ever needs it. Ask the desktop user directly.
runuser -u "$DESKTOP_USER" -- test -w "$DESKTOP_ROOT" || fail desktop-root-writable

# THE ISOLATION ASSERTIONS. Each is the negative form on purpose: "is not a member",
# "cannot read". A positive check ("the desktop user exists") passes just as happily
# on a host where someone added it to the workspace group for convenience.
[ "$(id -gn "$DESKTOP_USER")" = "$DESKTOP_GROUP" ] || fail desktop-identity
[ "$(getent passwd "$DESKTOP_USER" | cut -d: -f7)" = /usr/sbin/nologin ] || fail desktop-identity
id -nG "$DESKTOP_USER" | tr ' ' '\\n' | grep -qx "$WORKSPACE_USER" && fail workspace-credential-isolation
id -nG "$DESKTOP_USER" | tr ' ' '\\n' | grep -qx "$SERVICE_USER" && fail workspace-credential-isolation
id -nG "$DESKTOP_USER" | tr ' ' '\\n' | grep -qx "$AGENT_USER" && fail workspace-credential-isolation
# The decisive test is not group membership but reachability: prove the desktop user
# cannot actually read either protected home, whatever the groups happen to say.
#
# BOTH homes, since D-248. The workspace home holds the customer checkout and its git
# credentials; the AGENT home holds the delivered Claude/Codex/OMP material. They were one
# directory when this check was written, so checking only the workspace home would now pass
# while leaving the credentials this pack names in its own error message unguarded.
for protected_user in "$WORKSPACE_USER" "$AGENT_USER"; do
  protected_home="$(getent passwd "$protected_user" | cut -d: -f6 || true)"
  [ -n "\${protected_home:-}" ] || continue
  [ -d "$protected_home" ] || continue
  if runuser -u "$DESKTOP_USER" -- test -r "$protected_home" 2>/dev/null; then
    fail workspace-credential-isolation
  fi
done
phase create-desktop-identity

# ── install-desktop-runtime ────────────────────────────────────────────────────────
# Copy ONLY the self-contained worker and interpreter. Never grant desktop access to
# the service/agent homes, their groups, or the rest of the immutable runtime tree.
DESKTOP_LIB=/usr/local/lib/papercusp-desktop
install -d -o root -g root -m 0755 "$DESKTOP_LIB"
install -o root -g root -m 0755 ${shellQuote(`${__vite_ssr_import_2__.WORKSPACE_HOST_RUNTIME_ROOT}/current/bin/node`)} "$DESKTOP_LIB/node"
install -o root -g root -m 0755 ${shellQuote(`${__vite_ssr_import_2__.WORKSPACE_HOST_RUNTIME_ROOT}/current/${__vite_ssr_import_1__.WORKSPACE_HOST_DESKTOP_SESSION_ENTRYPOINT}`)} "$DESKTOP_LIB/session.cjs"
runuser -u "$DESKTOP_USER" -- env -i HOME="$DESKTOP_ROOT" PATH=/usr/bin:/bin \\
  "$DESKTOP_LIB/node" "$DESKTOP_LIB/session.cjs" --check || fail desktop-runtime

# Loopback HTTP is privileged operator authority. UID/home isolation alone is
# insufficient when desktop apps can call it. Keep DNS and viewer REPLIES, while
# refusing desktop-origin connections to local services and metadata endpoints.
DESKTOP_UID="$(id -u "$DESKTOP_USER")"
install -d -o root -g root -m 0755 /etc/papercusp
cat > /etc/papercusp/desktop-egress.nft <<NFT
${buildWorkspaceDesktopEgressRules("$DESKTOP_UID")}NFT
chmod 0644 /etc/papercusp/desktop-egress.nft
nft -f /etc/papercusp/desktop-egress.nft || fail desktop-egress-isolation
nft list chain inet papercusp_desktop output >/dev/null || fail desktop-egress-isolation

# The socket carries NO ordering or requirement on papercusp-workspace.service (D-439).
# A default-dependency socket is Before=sockets.target, and every ordinary service is
# After=basic.target, which is After=sockets.target — so After= that service closes a
# cycle. systemd breaks it at boot by deleting the socket's start job: the socket was
# live after install (started by hand below) and silently gone after the first reboot.
# The coupling to the workspace service lives on the per-connection @.service instead.
cat > /etc/systemd/system/papercusp-desktop.socket <<UNIT
[Unit]
Description=Papercusp isolated desktop session admission
[Socket]
ListenStream=/run/papercusp-desktop/session.sock
SocketUser=root
SocketGroup=$SERVICE_USER
SocketMode=0660
DirectoryMode=0755
Accept=yes
MaxConnections=64
RemoveOnStop=yes
[Install]
WantedBy=multi-user.target
UNIT
cat > /etc/systemd/system/papercusp-desktop@.service <<UNIT
[Unit]
Description=Papercusp isolated desktop session
After=papercusp-workspace.service
BindsTo=papercusp-workspace.service
JoinsNamespaceOf=papercusp-workspace.service
[Service]
Type=exec
User=$DESKTOP_USER
Group=$DESKTOP_GROUP
WorkingDirectory=$DESKTOP_ROOT
Environment=HOME=$DESKTOP_ROOT
Environment=PATH=/usr/local/bin:/usr/bin:/bin
Environment=LANG=C.UTF-8
# XFCE Terminal uses SHELL, then the passwd shell. Keep the account nologin for
# authentication while giving terminal windows an interactive shell.
Environment=SHELL=/bin/bash
# Reapply the fixed root-owned rules before ANY worker, including after a reboot.
ExecStartPre=+/usr/sbin/nft -f /etc/papercusp/desktop-egress.nft
ExecStart=$DESKTOP_LIB/node $DESKTOP_LIB/session.cjs --stdio
StandardInput=socket
StandardOutput=inherit
StandardError=journal
NoNewPrivileges=true
PrivateTmp=true
ProtectHome=true
ProtectSystem=strict
ReadWritePaths=$DESKTOP_ROOT
InaccessiblePaths=${__vite_ssr_import_2__.WORKSPACE_HOST_STATE_ROOT} /srv/papercusp/workspaces
RestrictSUIDSGID=true
LockPersonality=true
UMask=0077
KillMode=control-group
TimeoutStopSec=5s
UNIT
chmod 0644 /etc/systemd/system/papercusp-desktop.socket /etc/systemd/system/papercusp-desktop@.service
systemd-analyze verify /etc/systemd/system/papercusp-desktop.socket /etc/systemd/system/papercusp-desktop@.service
systemctl daemon-reload
systemctl enable --now papercusp-desktop.socket
systemctl is-active --quiet papercusp-desktop.socket || fail desktop-socket
[ -S /run/papercusp-desktop/session.sock ] || fail desktop-socket
[ "$(stat -c %a /run/papercusp-desktop/session.sock)" = 660 ] || fail desktop-socket

# ── personal desktop worker (personal-cloud-desktop-2026-10-06, D-001) ─────────────
# A SECOND instance of the same worker, running as the customer workspace account: a
# person's own desktop must see their checkout, files and credentials, exactly as their
# hosted terminal does. It is a separate socket and unit — never a mode switch inside the
# sandbox unit — so a sandbox lease cannot land in the customer account, and a personal
# lease cannot land in the isolated desktop user. The sandbox isolation above is untouched.
# No egress rules: the person's desktop has the same network as the person's terminal.
WORKSPACE_HOME="/home/$WORKSPACE_USER"
[ -d "$WORKSPACE_HOME" ] || fail personal-desktop-runtime
runuser -u "$WORKSPACE_USER" -- env -i HOME="$WORKSPACE_HOME" PATH=/usr/bin:/bin \\
  "$DESKTOP_LIB/node" "$DESKTOP_LIB/session.cjs" --personal --check || fail personal-desktop-runtime
# Negative form on purpose: each mode must REFUSE the other's account. A worker that
# accepted either identity would pass every positive check above.
if runuser -u "$DESKTOP_USER" -- env -i HOME="$DESKTOP_ROOT" PATH=/usr/bin:/bin \\
  "$DESKTOP_LIB/node" "$DESKTOP_LIB/session.cjs" --personal --check >/dev/null 2>&1; then
  fail personal-desktop-identity
fi
if runuser -u "$WORKSPACE_USER" -- env -i HOME="$WORKSPACE_HOME" PATH=/usr/bin:/bin \\
  "$DESKTOP_LIB/node" "$DESKTOP_LIB/session.cjs" --check >/dev/null 2>&1; then
  fail personal-desktop-identity
fi
cat > /etc/systemd/system/papercusp-personal-desktop.socket <<UNIT
[Unit]
Description=Papercusp personal desktop session admission
[Socket]
ListenStream=/run/papercusp-personal-desktop/session.sock
SocketUser=root
SocketGroup=$SERVICE_USER
SocketMode=0660
DirectoryMode=0755
Accept=yes
MaxConnections=16
RemoveOnStop=yes
[Install]
WantedBy=multi-user.target
UNIT
cat > /etc/systemd/system/papercusp-personal-desktop@.service <<UNIT
[Unit]
Description=Papercusp personal desktop session (customer workspace account)
After=papercusp-workspace.service
BindsTo=papercusp-workspace.service
JoinsNamespaceOf=papercusp-workspace.service
[Service]
Type=exec
User=$WORKSPACE_USER
WorkingDirectory=$WORKSPACE_HOME
Environment=HOME=$WORKSPACE_HOME
Environment=PATH=/usr/local/bin:/usr/bin:/bin
Environment=LANG=C.UTF-8
Environment=SHELL=/bin/bash
ExecStart=$DESKTOP_LIB/node $DESKTOP_LIB/session.cjs --personal --stdio
StandardInput=socket
StandardOutput=inherit
StandardError=journal
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ReadWritePaths=$WORKSPACE_HOME -${__vite_ssr_import_2__.WORKSPACE_HOST_DATA_ROOT}
InaccessiblePaths=-${__vite_ssr_import_2__.WORKSPACE_HOST_STATE_ROOT}
RestrictSUIDSGID=true
LockPersonality=true
UMask=0077
KillMode=control-group
TimeoutStopSec=5s
UNIT
chmod 0644 /etc/systemd/system/papercusp-personal-desktop.socket /etc/systemd/system/papercusp-personal-desktop@.service
systemd-analyze verify /etc/systemd/system/papercusp-personal-desktop.socket /etc/systemd/system/papercusp-personal-desktop@.service
systemctl daemon-reload
systemctl enable --now papercusp-personal-desktop.socket
systemctl is-active --quiet papercusp-personal-desktop.socket || fail personal-desktop-socket
[ -S /run/papercusp-personal-desktop/session.sock ] || fail personal-desktop-socket
[ "$(stat -c %a /run/papercusp-personal-desktop/session.sock)" = 660 ] || fail personal-desktop-socket
phase install-desktop-runtime

# ── attest-pack ─────────────────────────────────────────────────────────────────────
command -v openbox   >/dev/null 2>&1 || fail x-stack
command -v xdotool   >/dev/null 2>&1 || fail x-stack
command -v import    >/dev/null 2>&1 || fail x-stack
command -v bwrap     >/dev/null 2>&1 || fail x-stack
command -v xsetroot  >/dev/null 2>&1 || fail x-stack
# The name openbox's stock menu executes, not merely the package that should provide it.
command -v x-terminal-emulator >/dev/null 2>&1 || fail x-stack
command -v dbus-daemon >/dev/null 2>&1 || fail a11y-stack
[ -f /usr/lib/at-spi2-core/at-spi-bus-launcher ] || [ -f /usr/libexec/at-spi-bus-launcher ] || fail a11y-stack
command -v glxinfo >/dev/null 2>&1 || fail gl-stack
# The binaries the hosted worker's XFCE session execs, not the package names.
for bin in xfce4-session xfwm4 xfce4-panel xfdesktop xfsettingsd xfce4-terminal thunar dbus-run-session; do
  command -v "$bin" >/dev/null 2>&1 || fail desktop-environment
done
# Mozilla's build, not the stub: the stub's /usr/bin/firefox only execs snap.
command -v firefox >/dev/null 2>&1 || fail browser
case "$(dpkg-query -W -f='\${Version}' firefox)" in *snap*) fail browser ;; esac

printf '${WORKSPACE_HOST_DESKTOP_PACK_ATTESTATION_PREFIX}%s\\n' "$(cat <<JSON | tr -d '\\n'
{"contractVersion":"${WORKSPACE_HOST_DESKTOP_PACK_CONTRACT_VERSION}",
"hostId":"$HOST_ID","action":"${input.action}",
"ubuntuVersion":"${__vite_ssr_import_2__.WORKSPACE_HOST_BOOTSTRAP_UBUNTU_VERSION}",
"observedAt":"$(date -u +%Y-%m-%dT%H:%M:%SZ)","status":"healthy",
"kasmvnc":{"version":"$KASM_VERSION","sha256":"$KASM_SHA"},
"checks":[${WORKSPACE_HOST_DESKTOP_PACK_CHECKS.map((c) => `{"name":"${c}","ok":true}`).join(",")}]}
JSON
)"
phase attest-pack
`;
  return { script, phases: WORKSPACE_HOST_DESKTOP_PACK_PHASES };
};
function parseWorkspaceHostDesktopPackAttestation(output) {
  const line = output.split("\n").map((l) => l.trim()).find((l) => l.startsWith(WORKSPACE_HOST_DESKTOP_PACK_ATTESTATION_PREFIX));
  if (!line) {
    throw new Error("Desktop pack produced no attestation line");
  };
  let parsed;
  try {
    parsed = JSON.parse(
      line.slice(WORKSPACE_HOST_DESKTOP_PACK_ATTESTATION_PREFIX.length)
    );
  } catch {
    throw new Error("Desktop pack attestation is not valid JSON");
  };
  if (parsed.contractVersion !== WORKSPACE_HOST_DESKTOP_PACK_CONTRACT_VERSION) {
    throw new Error("Desktop pack attestation reports a different contract version");
  };
  if (parsed.status !== "healthy") {
    throw new Error(`Desktop pack attestation status is ${String(parsed.status)}`);
  };
  (0,__vite_ssr_import_0__.assertWorkspaceHostSecretIsolation)(parsed, "desktopPack.attestation");
  const observed = new Set((parsed.checks ?? []).filter((c) => c?.ok === true).map((c) => c.name));
  const missing = WORKSPACE_HOST_DESKTOP_PACK_CHECKS.filter((c) => !observed.has(c));
  if (missing.length > 0) {
    throw new Error(`Desktop pack attestation is missing checks: ${missing.join(", ")}`);
  };
  return parsed;
}
//# sourceMappingSource=vite-generated
//# sourceMappingURL=data:application/json;base64,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QUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBLEVBVWpJLGlDQUFpQyxjQUFjLENBQUM7QUFBQTtBQUFBO0FBQUE7O0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQSxvQkFzRDlCLCtDQUF5QjtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBOztBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBLGtDQXdFWCw4Q0FBd0I7QUFBQSxxQkFDckMsK0NBQXlCO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTs7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7O0FBQUEsVUFtQ3BDLDhDQUE4QztBQUFBLHNCQUNsQyw0Q0FBNEM7QUFBQSxnQ0FDbEMsTUFBTSxNQUFNO0FBQUEsbUJBQ3pCLDZEQUF1QztBQUFBO0FBQUE7QUFBQSxZQUc5QyxtQ0FBbUMsSUFBSSxDQUFDLE1BQU0sWUFBWSxDQUFDLGNBQWMsRUFBRSxLQUFLLEdBQUcsQ0FBQztBQUFBO0FBQUE7QUFBQTtBQUFBO0FBTTlGLFNBQU8sRUFBRSxRQUFRLFFBQVEsbUNBQW1DO0FBQzlEO0FBV08sU0FBUyx5Q0FDZCxRQUNxQztBQUNyQyxRQUFNLE9BQU8sT0FDVixNQUFNLElBQUksRUFDVixJQUFJLENBQUMsTUFBTSxFQUFFLEtBQUssQ0FBQyxFQUNuQixLQUFLLENBQUMsTUFBTSxFQUFFLFdBQVcsOENBQThDLENBQUM7QUFDM0UsTUFBSSxDQUFDLE1BQU07QUFDVCxVQUFNLElBQUksTUFBTSwyQ0FBMkM7QUFBQSxFQUM3RDtBQUNBLE1BQUk7QUFDSixNQUFJO0FBQ0YsYUFBUyxLQUFLO0FBQUEsTUFDWixLQUFLLE1BQU0sK0NBQStDLE1BQU07QUFBQSxJQUNsRTtBQUFBLEVBQ0YsUUFBUTtBQUNOLFVBQU0sSUFBSSxNQUFNLDRDQUE0QztBQUFBLEVBQzlEO0FBQ0EsTUFBSSxPQUFPLG9CQUFvQiw4Q0FBOEM7QUFDM0UsVUFBTSxJQUFJLE1BQU0sK0RBQStEO0FBQUEsRUFDakY7QUFDQSxNQUFJLE9BQU8sV0FBVyxXQUFXO0FBQy9CLFVBQU0sSUFBSSxNQUFNLHNDQUFzQyxPQUFPLE9BQU8sTUFBTSxDQUFDLEVBQUU7QUFBQSxFQUMvRTtBQUNBLCtEQUFtQyxRQUFRLHlCQUF5QjtBQUVwRSxRQUFNLFdBQVcsSUFBSSxLQUFLLE9BQU8sVUFBVSxDQUFDLEdBQUcsT0FBTyxDQUFDLE1BQU0sR0FBRyxPQUFPLElBQUksRUFBRSxJQUFJLENBQUMsTUFBTSxFQUFFLElBQUksQ0FBQztBQUMvRixRQUFNLFVBQVUsbUNBQW1DLE9BQU8sQ0FBQyxNQUFNLENBQUMsU0FBUyxJQUFJLENBQUMsQ0FBQztBQUNqRixNQUFJLFFBQVEsU0FBUyxHQUFHO0FBQ3RCLFVBQU0sSUFBSSxNQUFNLCtDQUErQyxRQUFRLEtBQUssSUFBSSxDQUFDLEVBQUU7QUFBQSxFQUNyRjtBQUNBLFNBQU87QUFDVCIsIm5hbWVzIjpbXSwiaWdub3JlTGlzdCI6W10sInNvdXJjZXMiOlsid29ya3NwYWNlLWhvc3QtZGVza3RvcC1wYWNrLnRzIl0sInNvdXJjZXNDb250ZW50IjpbIi8qKlxuICogd29ya3NwYWNlLWhvc3QtZGVza3RvcC1wYWNrLnRzIOKAlCB0aGUgT1BULUlOIGFnZW50LXNhbmRib3ggZGVza3RvcCBwYWNrIChQLTAxMikuXG4gKlxuICog4pSA4pSAIFdoYXQgdGhpcyBpcywgYW5kIHdoYXQgaXQgZGVsaWJlcmF0ZWx5IGlzIG5vdCDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIBcbiAqIEQtMDE4IChvd25lciBydWxpbmcpIHNjb3BlZCB0aGUgQllPQyBjbG91ZCBkZXNrdG9wIHRvIEFHRU5UIFNBTkRCT1ggREVTS1RPUFMgT05MWSxcbiAqIGFuZCBydWxlZCB0aGF0IGl0IGlzIG5ldmVyIGEgYmFzZS1pbWFnZSByZXF1aXJlbWVudDogdGhlIHNoaXBwZWQgd29ya3NwYWNlLWhvc3RcbiAqIGltYWdlIHN0YXlzIGhlYWRsZXNzIGJ5IGNvbnN0cnVjdGlvbi4gRC0wMjIgdGhlbiBzZXR0bGVkIHRoZSBtZWNoYW5pc20g4oCUIHRoaXMgaXMgYVxuICogUE9TVC1QUk9WSVNJT04gTEFZRVJFRCBJTlNUQUxMIGFwcGxpZWQgdG8gYW4gYWxyZWFkeS1ib290c3RyYXBwZWQgaG9zdCwgbm90IGFuXG4gKiBpbWFnZSB2YXJpYW50LiBUaGUgcmVhc29uaW5nIGlzIG9uIEQtMDIyOyB0aGUgc2hvcnQgdmVyc2lvbiBpcyB0aGF0IGFuIGltYWdlIGlzXG4gKiBjaG9zZW4gb25jZSwgZm9yIHRoZSB3aG9sZSBob3N0LCBhdCBwcm92aXNpb24gdGltZSwgc28gXCJvcHQtaW5cIiBkZWxpdmVyZWQgYXMgYVxuICogZGlmZmVyZW50IGltYWdlIGlzIG9wdC1pbiBwZXIgZmxlZXQgcmF0aGVyIHRoYW4gcGVyIHdvcmtzcGFjZS5cbiAqXG4gKiBJdCBkb2VzIE5PVCBzdGFuZCB1cCBhIFBhcGVyY3VzcCBhcHAgc2Vzc2lvbiBvbiB0aGUgVk0gKGJ5b2MgUC0wNDggc2hpcHMgdGhlIHRoaW5cbiAqIEdVSS9icm93c2VyIGZvciB0aGF0KSBhbmQgaXQgZG9lcyBOT1QgcHJvdmlkZSB2aXNpYmxlIGNsb3VkIGZsZWV0IHRlcm1pbmFscyAoY2xvdWRcbiAqIGZsZWV0cyBydW4gaGVhZGxlc3M7IHRoZWlyIG9ic2VydmFiaWxpdHkgaXMgdHJhbnNjcmlwdHMsIGNvb3JkIGFuZCBwbGFucykuXG4gKlxuICog4pSA4pSAIFRoZSB0d28gdGhpbmdzIG1vc3QgbGlrZWx5IHRvIGJlIGdvdCB3cm9uZywgc3RhdGVkIHVwIGZyb250IOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgFxuICogMS4gVEhFIExJU1RFTkVSLiBLYXNtVk5DIHNoaXBzIGBuZXR3b3JrLmludGVyZmFjZTogMC4wLjAuMGAgYW5kIGBYa2FzbXZuYyAtaGVscGBcbiAqICAgIGRvY3VtZW50cyBgaW50ZXJmYWNlIC4uLiAoZGVmYXVsdD1hbGwpYC4gQW4gaW5zdGFsbCB0aGF0IG1lcmVseSBzdWNjZWVkZWQgd291bGRcbiAqICAgIHRoZXJlZm9yZSBwdWJsaXNoIGV2ZXJ5IGFnZW50J3Mgc2FuZGJveCBkZXNrdG9wIG9uIHRoZSBWTSdzIGV4dGVybmFsIGludGVyZmFjZS5cbiAqICAgIEQtMDIwIHJlcXVpcmVzIGxvb3BiYWNrLW9ubHksIHJlYWNoYWJsZSBzb2xlbHkgdGhyb3VnaCBQLTAxMydzIHRpY2tldC1nYXRlZFxuICogICAgcHJveHksIHNvIHRoaXMgcGFjayBPVkVSUklERVMgdGhhdCBkZWZhdWx0IGluIHRoZSBzeXN0ZW0gY29uZmlnIEFORCB0aGUgcnVudGltZVxuICogICAgYXJndiwgYW5kIGBsb29wYmFjay1vbmx5LWxpc3RlbmVyYCBpcyBhIG5hbWVkIGNoZWNrIHJhdGhlciB0aGFuIGEgY29tbWVudC5cbiAqIDIuIFRIRSBJREVOVElUWS4gVGhlIHBhY2sgaW50cm9kdWNlcyBhIFRISVJEIHVuaXggaWRlbnRpdHkuIEl0IHdvdWxkIGhhdmUgYmVlblxuICogICAgbGVzcyBjb2RlIHRvIHJ1biBzYW5kYm94IGRlc2t0b3BzIGFzIHRoZSBleGlzdGluZyB3b3Jrc3BhY2UgdXNlciDigJQgYW5kIHRoYXQgaXNcbiAqICAgIGV4YWN0bHkgdGhlIGNyZWRlbnRpYWwgYmxlZWQgdGhlIGl0ZW0gZm9yYmlkczogdGhhdCBhY2NvdW50IG93bnMgdGhlIGN1c3RvbWVyJ3NcbiAqICAgIHdvcmtzcGFjZSBhbmQgaXRzIGdpdCBjcmVkZW50aWFscywgc28gYW4gYWdlbnQtb3BlcmF0ZWQgYXBwIGVzY2FwaW5nIGl0cyBid3JhcFxuICogICAgd291bGQgaW5oZXJpdCB0aGVtLiBUaGUgZGVza3RvcCB1c2VyIG93bnMgbm90aGluZyBidXQgZGVza3RvcHMuXG4gKi9cbmltcG9ydCB7IGFzc2VydFdvcmtzcGFjZUhvc3RTZWNyZXRJc29sYXRpb24gfSBmcm9tICcuL3dvcmtzcGFjZS1ob3N0LXRlc3QtaGFybmVzcyc7XG5pbXBvcnQgeyBXT1JLU1BBQ0VfSE9TVF9ERVNLVE9QX1NFU1NJT05fRU5UUllQT0lOVCB9IGZyb20gJy4vd29ya3NwYWNlLWhvc3QtYnVpbGQtbWFuaWZlc3QnO1xuaW1wb3J0IHtcbiAgQVBUX0JPVU5ERURfSEVMUEVSX0xJTkVTLFxuICBXT1JLU1BBQ0VfSE9TVF9DVVJMX1NUQUxMX0dVQVJELFxuICBERUZBVUxUX1dPUktTUEFDRV9IT1NUX0FHRU5UX1VTRVIsXG4gIERFRkFVTFRfV09SS1NQQUNFX0hPU1RfU0VSVklDRV9VU0VSLFxuICBERUZBVUxUX1dPUktTUEFDRV9IT1NUX1dPUktTUEFDRV9VU0VSLFxuICBXT1JLU1BBQ0VfSE9TVF9CT09UU1RSQVBfVUJVTlRVX1ZFUlNJT04sXG4gIFdPUktTUEFDRV9IT1NUX0RBVEFfUk9PVCxcbiAgV09SS1NQQUNFX0hPU1RfUlVOVElNRV9ST09ULFxuICBXT1JLU1BBQ0VfSE9TVF9TVEFURV9ST09ULFxufSBmcm9tICcuL3dvcmtzcGFjZS1ob3N0LWJvb3RzdHJhcCc7XG5cbmV4cG9ydCBjb25zdCBXT1JLU1BBQ0VfSE9TVF9ERVNLVE9QX1BBQ0tfQ09OVFJBQ1RfVkVSU0lPTiA9XG4gICdwYXBlcmN1c3Atd29ya3NwYWNlLWhvc3QtZGVza3RvcC1wYWNrLXYxJztcbmV4cG9ydCBjb25zdCBXT1JLU1BBQ0VfSE9TVF9ERVNLVE9QX1BBQ0tfQVRURVNUQVRJT05fUFJFRklYID1cbiAgJ1BBUEVSQ1VTUF9XT1JLU1BBQ0VfSE9TVF9ERVNLVE9QX1BBQ0tfQVRURVNUQVRJT049JztcblxuLyoqXG4gKiBUaGUgcGFjaydzIG93biB1bml4IGlkZW50aXR5IOKAlCBOT1QgdGhlIHNlcnZpY2UgdXNlciBhbmQgTk9UIHRoZSB3b3Jrc3BhY2UgdXNlci5cbiAqXG4gKiBUaGUgd2hvbGUgcG9pbnQgaXMgd2hhdCBpdCBpcyAqbm90KiBhIG1lbWJlciBvZi4gYHBhcGVyY3VzcGAgKHNlcnZpY2UpIGhvbGRzIHRoZVxuICogb3BlcmF0b3IncyBydW50aW1lIGFuZCBpdHMgY3JlZGVudGlhbHM7IGBwYXBlcmN1c3Atd29ya3NwYWNlYCBob2xkcyB0aGUgY3VzdG9tZXInc1xuICogY2hlY2tvdXQsIHRoZWlyIGdpdCBjcmVkZW50aWFscywgYW5kIHRoZWlyIGFnZW50IGNyZWRlbnRpYWxzLCBpbiBhIDA3MDAgaG9tZS4gQVxuICogc2FuZGJveCBkZXNrdG9wIG5lZWRzIG5laXRoZXIsIHNvIGl0IGdldHMgbmVpdGhlciwgYW5kIGB3b3Jrc3BhY2UtY3JlZGVudGlhbC1pc29sYXRpb25gXG4gKiBhc3NlcnRzIHRoZSBuZWdhdGl2ZSByYXRoZXIgdGhhbiB0cnVzdGluZyB0aGF0IG5vYm9keSBhZGRzIGEgY29udmVuaWVudCBncm91cCBsYXRlci5cbiAqL1xuZXhwb3J0IGNvbnN0IERFRkFVTFRfV09SS1NQQUNFX0hPU1RfREVTS1RPUF9VU0VSID0gJ3BhcGVyY3VzcC1kZXNrdG9wJztcbmV4cG9ydCBjb25zdCBERUZBVUxUX1dPUktTUEFDRV9IT1NUX0RFU0tUT1BfR1JPVVAgPSAncGFwZXJjdXNwLWRlc2t0b3AnO1xuLyoqXG4gKiBIb21lICsgcGVyLXNlc3Npb24gY3JlZGVudGlhbCByb290IGZvciB0aGUgZGVza3RvcCBwb29sLiBNb2RlIDA3MDAsIGRlc2t0b3AtdXNlciBvd25lZC5cbiAqXG4gKiDimqAgQSBUT1AtTEVWRUwgUEFUSCwgREVMSUJFUkFURUxZICpOT1QqIE5FU1RFRCBVTkRFUiBgV09SS1NQQUNFX0hPU1RfU1RBVEVfUk9PVGAuXG4gKlxuICogSXQgd2FzIGAke1dPUktTUEFDRV9IT1NUX1NUQVRFX1JPT1R9L2Rlc2t0b3BgIHVudGlsIHRoaXMgd2FzIG1lYXN1cmVkIG9uIGEgcmVhbFxuICogd29ya3NwYWNlIFZNOiBgL3Zhci9saWIvcGFwZXJjdXNwYCBpcyBgZHJ3eHIteC0tLSBwYXBlcmN1c3A6cGFwZXJjdXNwYCwgYW5kIHRoZVxuICogZGVza3RvcCB1c2VyIGlzIGRlbGliZXJhdGVseSBOT1QgaW4gZ3JvdXAgYHBhcGVyY3VzcGAgKHRoYXQgbm9uLW1lbWJlcnNoaXAgaXMgd2hhdFxuICogYHdvcmtzcGFjZS1jcmVkZW50aWFsLWlzb2xhdGlvbmAgYXNzZXJ0cykuIFdpdGggbm8gYHhgIG9uIHRoZSBwYXJlbnQsIHRoZSBkZXNrdG9wXG4gKiB1c2VyIGNvdWxkIG5vdCBUUkFWRVJTRSBpbnRvIHRoZSByb290IGNyZWF0ZWQgZm9yIGl0IOKAlFxuICogYG5hbWVpYCByZXBvcnRlZCBgZGVza3RvcCAtIFBlcm1pc3Npb24gZGVuaWVkYCDigJQgc28gYGthc212bmNwYXNzd2RgIGNvdWxkIG5vdCB3cml0ZVxuICogdGhlIHBlci1zZXNzaW9uIHZpZXcvY29udHJvbCBjcmVkZW50aWFsIGZpbGUgdGhhdCBgYnVpbGRYU2VydmVyQ29tbWFuZGAgcmVxdWlyZXMsXG4gKiBhbmQgdGhlIHRpY2tldGVkIHZpZXdlciBjb3VsZCBub3QgYmUgcHJvdmlzaW9uZWQgYXQgYWxsLlxuICpcbiAqIFRoZSB0d28gcmVxdWlyZW1lbnRzIGFyZSBpcnJlY29uY2lsYWJsZSB3aGlsZSBuZXN0ZWQ6IGdyYW50aW5nIHRyYXZlcnNhbCBtZWFuc1xuICogcHV0dGluZyB0aGUgZGVza3RvcCB1c2VyIGluIHRoZSBzZXJ2aWNlIGdyb3VwLCB3aGljaCBpcyBleGFjdGx5IHRoZSBjcmVkZW50aWFsIGJsZWVkXG4gKiB0aGUgcGFjayBleGlzdHMgdG8gcHJldmVudC4gU28gdGhlIHJvb3QgbW92ZXMgT1VUIHJhdGhlciB0aGFuIHRoZSBpc29sYXRpb24gYmVpbmdcbiAqIHdlYWtlbmVkLiBBbnl0aGluZyB0aGF0IG5lZWRzIGJvdGggbXVzdCBjcm9zcyBhIGRlbGliZXJhdGUgc2VhbSwgbm90IGEgZGlyZWN0b3J5IG1vZGUuXG4gKi9cbmV4cG9ydCBjb25zdCBXT1JLU1BBQ0VfSE9TVF9ERVNLVE9QX1JPT1QgPSAnL3Zhci9saWIvcGFwZXJjdXNwLWRlc2t0b3AnO1xuXG4vKipcbiAqIFRoZSBwaW5uZWQgS2FzbVZOQyBhcnRpZmFjdC5cbiAqXG4gKiBNZWFzdXJlZCAyMDI2LTA4LTMwIGFnYWluc3QgdGhlIEdpdEh1YiByZWxlYXNlIEFQSSBhbmQgYSBsb2NhbCBgZHBrZy1kZWJgIG9mIHRoZVxuICogZG93bmxvYWRlZCBmaWxlLiBJdCBpcyBOT1QgaW4gdGhlIFVidW50dSBhcmNoaXZlIOKAlCBgYXB0IGluc3RhbGwga2FzbXZuY3NlcnZlcmBcbiAqIGNhbm5vdCB3b3JrIOKAlCBzbyB0aGUgcGFjayBmZXRjaGVzIGFuZCB2ZXJpZmllcyBieSBkaWdlc3QsIHRoZSBzYW1lIHBvc3R1cmUgdGhlXG4gKiBib290c3RyYXAgY29udHJhY3QgYWxyZWFkeSB0YWtlcyB0byB0aGUgU2VydmVyIGJ1bmRsZS5cbiAqL1xuZXhwb3J0IGludGVyZmFjZSBXb3Jrc3BhY2VIb3N0RGVza3RvcFBhY2tBcnRpZmFjdCB7XG4gIHZlcnNpb246IHN0cmluZztcbiAgLyoqIFB1YmxpYyBIVFRQUyAuZGViIFVSTC4gUXVlcnkgY3JlZGVudGlhbHMgYXJlIGZvcmJpZGRlbiwgYXMgaW4gdGhlIGJvb3RzdHJhcCByZWxlYXNlLiAqL1xuICBkZWJVcmw6IHN0cmluZztcbiAgZGViU2hhMjU2OiBzdHJpbmc7XG4gIGRlYkJ5dGVzOiBudW1iZXI7XG59XG5cbmV4cG9ydCBjb25zdCBQSU5ORURfS0FTTVZOQ19BUlRJRkFDVDogUmVhZG9ubHk8V29ya3NwYWNlSG9zdERlc2t0b3BQYWNrQXJ0aWZhY3Q+ID0ge1xuICB2ZXJzaW9uOiAnMS41LjAnLFxuICBkZWJVcmw6XG4gICAgJ2h0dHBzOi8vZ2l0aHViLmNvbS9rYXNtdGVjaC9LYXNtVk5DL3JlbGVhc2VzL2Rvd25sb2FkL3YxLjUuMC9rYXNtdm5jc2VydmVyX25vYmxlXzEuNS4wX2FtZDY0LmRlYicsXG4gIGRlYlNoYTI1NjogJ2Y1OTlmZTAyZTIxNzViOTgxN2I2MTY1Zjc0YTVkMmJlYmRjNzMxMThkZGU5MTgxYmEzNDEwOTYzYmVkN2FlMWUnLFxuICBkZWJCeXRlczogMl82NTNfMTEyLFxufTtcblxuLyoqXG4gKiBBUFQgcGFja2FnZXMgdGhlIHBhY2sgbGF5ZXJzIG9uLiBTcGxpdCBieSBXSFksIGJlY2F1c2UgdGhlIHRlbXB0YXRpb24gd2hlbiBvbmUgb2ZcbiAqIHRoZXNlIGlzIG1pc3NpbmcgaXMgdG8gaW5zdGFsbCBhIG1ldGFwYWNrYWdlLCBhbmQgYSBtZXRhcGFja2FnZSBpcyBob3cgYSBoZWFkbGVzc1xuICogaG9zdCBhY3F1aXJlcyBhIGxvZ2luIG1hbmFnZXIuXG4gKi9cbmV4cG9ydCBjb25zdCBXT1JLU1BBQ0VfSE9TVF9ERVNLVE9QX1BBQ0tfQVBUID0ge1xuICAvKiogS2FzbVZOQydzIG93biBkZWNsYXJlZCBEZXBlbmRzIHRoYXQgYXJlIG5vdCBpbiB0aGUgYmFzZSBpbWFnZS4gKi9cbiAga2FzbXZuY1J1bnRpbWU6IFtcbiAgICAnbGliZ2wxJyxcbiAgICAnbGliZ2JtMScsXG4gICAgJ2xpYnhmb250MicsXG4gICAgJ2xpYnh0c3Q2JyxcbiAgICAnbGlidW53aW5kOCcsXG4gICAgJ3hhdXRoJyxcbiAgICAneDExLXhrYi11dGlscycsXG4gICAgJ3hrYi1kYXRhJyxcbiAgICAnc3NsLWNlcnQnLFxuICAgICdsaWJzd2l0Y2gtcGVybCcsXG4gICAgJ2xpYnlhbWwtdGlueS1wZXJsJyxcbiAgICAnbGliaGFzaC1tZXJnZS1zaW1wbGUtcGVybCcsXG4gICAgJ2xpYmxpc3QtbW9yZXV0aWxzLXBlcmwnLFxuICAgICdsaWJ0cnktdGlueS1wZXJsJyxcbiAgICAnbGliZGF0ZXRpbWUtcGVybCcsXG4gICAgJ2xpYmRhdGV0aW1lLXRpbWV6b25lLXBlcmwnLFxuICBdLFxuICAvKiogVGhlIHdpbmRvdyBtYW5hZ2VyLiBvcGVuYm94IGRyYXdzIGNocm9tZSB0aHJvdWdoIHBsYWluIFgxMSBhbmQgbmVlZHMgbm8gR0wuICovXG4gIHdpbmRvd01hbmFnZXI6IFsnb3BlbmJveCddLFxuICAvKipcbiAgICogZ2wtc3RyYXRlZ3kncyBtZWFzdXJlZCBsYWRkZXIuIGBsaWJnbDEtbWVzYS1kcmlgIGlzIHdoYXQgbWFrZXMgdGhlIG1lc2Etc29mdHdhcmVcbiAgICogcnVuZyByZWFsIG9uIGEgR1BVLWxlc3MgVk07IHdpdGhvdXQgaXQgdGhlIGhvbmVzdCBtZWFzdXJlbWVudCBpcyBgdGllcjogJ25vbmUnYFxuICAgKiBhbmQgZXZlcnkgY2FwdHVyZSBmcm9tIHRoZSBkZXNrdG9wIGlzIHVudHJ1c3R3b3J0aHkgYnkgY29uc3RydWN0aW9uLlxuICAgKi9cbiAgZ2w6IFsnbGliZ2wxLW1lc2EtZHJpJywgJ2xpYmVnbDEnLCAnbWVzYS11dGlscyddLFxuICAvKiogRC0wMTAncyBhMTF5IGJ1czogYSBkYnVzLWRhZW1vbiBwbHVzIEFULVNQSS4gT3JkZXJpbmcgaXMgZW5mb3JjZWQgaW4gYTExeS1idXMudHMuICovXG4gIGFjY2Vzc2liaWxpdHk6IFsnZGJ1cy1kYWVtb24nLCAnYXQtc3BpMi1jb3JlJ10sXG4gIC8qKiBUaGUgZHJpdmVyIGxheWVyIEQtMDIxIGtlZXBzIFgtYm91bmQ6IHhkb3Rvb2wgaW5wdXQsIGBpbXBvcnRgIGNhcHR1cmUuICovXG4gIGRyaXZlcjogWyd4ZG90b29sJywgJ2ltYWdlbWFnaWNrJywgJ3gxMS11dGlscyddLFxuICAvKiogRC0wMTUvRC0wMTYgcGVyLWFwcCBjb25maW5lbWVudC4gKi9cbiAgc2FuZGJveDogWydidWJibGV3cmFwJywgJ25mdGFibGVzJ10sXG4gIC8qKlxuICAgKiBUaGUgZmxvb3Igb2YgYSBVU0FCTEUgZGVza3RvcCAoV0ktMTAwMDI4NjMpLiBXaXRob3V0IHRoZXNlIGEgc3RhcnRlZCBkZXNrdG9wIGlzIGFcbiAgICogYmxhY2sgWCByb290IHdpdGggb3BlbmJveCBhbG9uZTogV2F0Y2ggY2Fubm90IHRlbGwgaXQgZnJvbSBhIGRlYWQgc3RyZWFtLCBhbmRcbiAgICogb3BlbmJveCdzIHJpZ2h0LWNsaWNrIG1lbnUgcG9pbnRzIGF0IGB4LXRlcm1pbmFsLWVtdWxhdG9yYCwgd2hpY2ggbm90aGluZyBwcm92aWRlcy5cbiAgICogYHh0ZXJtYCByZWdpc3RlcnMgdGhhdCBhbHRlcm5hdGl2ZTsgYHgxMS14c2VydmVyLXV0aWxzYCBzaGlwcyBgeHNldHJvb3RgLCB3aGljaCB0aGVcbiAgICogc2Vzc2lvbiB3b3JrZXIgdXNlcyB0byBwYWludCB0aGUgcm9vdCBhIG5vbi1ibGFjayBjb2xvdXIuXG4gICAqL1xuICBkZXNrdG9wRmxvb3I6IFsneHRlcm0nLCAneDExLXhzZXJ2ZXItdXRpbHMnXSxcbiAgLyoqXG4gICAqIFRoZSBjdXN0b21lci1mYWNpbmcgZGVza3RvcCAoV0ktMTAwMDI4NjMsIG93bmVyOiBYRkNFKS4gTmFtZWQgY29tcG9uZW50cywgbmV2ZXIgdGhlXG4gICAqIGB4ZmNlNGAvYHh1YnVudHUtZGVza3RvcGAgbWV0YXBhY2thZ2VzOiB0aG9zZSBwdWxsIGEgZGlzcGxheSBtYW5hZ2VyLiB4ZndtNCBpcyB0aGUgV01cbiAgICogb2YgdGhpcyBzZXNzaW9uOyBvcGVuYm94IHN0YXlzIGFib3ZlIGZvciB0aGUgYmFyZSBhZ2VudCBkZXNrdG9wcy4gYGRidXMtYmluYCBzaGlwc1xuICAgKiBgZGJ1cy1ydW4tc2Vzc2lvbmAsIHdoaWNoIGdpdmVzIHRoZSBzZXNzaW9uIHRoZSBmdWxsIGJ1cyB4ZmNvbmYgbmVlZHM7IHRoZSBhMTF5IGJ1cydzXG4gICAqIG1pbmltYWwgYnVzIGNhbm5vdCBhY3RpdmF0ZSBpdC4gVGhlIGljb24gdGhlbWUgaXMgbmFtZWQgYmVjYXVzZSAtLW5vLWluc3RhbGwtcmVjb21tZW5kc1xuICAgKiBvdGhlcndpc2UgbGVhdmVzIHRoZSBwYW5lbCB3aXRoIGJsYW5rIGxhdW5jaGVycy5cbiAgICovXG4gIGRlc2t0b3BFbnZpcm9ubWVudDogW1xuICAgICd4ZmNlNC1zZXNzaW9uJyxcbiAgICAneGZ3bTQnLFxuICAgICd4ZmNlNC1wYW5lbCcsXG4gICAgJ3hmZGVza3RvcDQnLFxuICAgICd4ZmNlNC1zZXR0aW5ncycsXG4gICAgJ3hmY2U0LXRlcm1pbmFsJyxcbiAgICAndGh1bmFyJyxcbiAgICAnZGJ1cy1iaW4nLFxuICAgICdhZHdhaXRhLWljb24tdGhlbWUnLFxuICBdLFxuICAvKiogVmVyaWZpZXMgdGhlIHBpbm5lZCBNb3ppbGxhIHNpZ25pbmcga2V5IGJlZm9yZSBpdHMgcmVwbyBpcyB0cnVzdGVkIChzZWUgaW5zdGFsbC1icm93c2VyKS4gKi9cbiAgYnJvd3NlcktleXJpbmc6IFsnZ3BnJ10sXG59IGFzIGNvbnN0O1xuXG4vKipcbiAqIFRoZSBicm93c2VyIGNvbWVzIGZyb20gTW96aWxsYSdzIG93biBBUFQgcmVwby4gVWJ1bnR1IDI0LjA0J3MgYGZpcmVmb3hgIGFuZCBgY2hyb21pdW1gXG4gKiBkZWJzIGFyZSB0cmFuc2l0aW9uYWwgc3R1YnMgdGhhdCBpbnN0YWxsIHRoZSBzbmFwLCBhbmQgc25hcGQgY2Fubm90IHJ1biBpbnNpZGUgdGhlXG4gKiBkZXNrdG9wJ3Mgc3lzdGVtZCB1bml0LiBUaGUga2V5IGlzIHBpbm5lZCBieSBmaW5nZXJwcmludCwgc28gYSBzdWJzdGl0dXRlZCBrZXkgZmFpbHMgdGhlXG4gKiBwYWNrIGluc3RlYWQgb2YgYmVjb21pbmcgYSB0cnVzdGVkIHJvb3QuXG4gKi9cbmV4cG9ydCBjb25zdCBXT1JLU1BBQ0VfSE9TVF9ERVNLVE9QX0JST1dTRVJfUkVQTyA9IHtcbiAga2V5VXJsOiAnaHR0cHM6Ly9wYWNrYWdlcy5tb3ppbGxhLm9yZy9hcHQvcmVwby1zaWduaW5nLWtleS5ncGcnLFxuICBrZXlGaW5nZXJwcmludDogJzM1QkFBMEIzM0U5RUIzOTZGNTlDQTgzOEMwQkE1Q0U2REM2MzE1QTMnLFxuICBzb3VyY2U6ICdodHRwczovL3BhY2thZ2VzLm1vemlsbGEub3JnL2FwdCBtb3ppbGxhIG1haW4nLFxuICBvcmlnaW46ICdwYWNrYWdlcy5tb3ppbGxhLm9yZycsXG4gIHBhY2thZ2U6ICdmaXJlZm94Jyxcbn0gYXMgY29uc3Q7XG5cbmV4cG9ydCBjb25zdCBXT1JLU1BBQ0VfSE9TVF9ERVNLVE9QX1BBQ0tfUEhBU0VTID0gW1xuICAndmFsaWRhdGUtaG9zdCcsXG4gICdpbnN0YWxsLXgtc3RhY2snLFxuICAnaW5zdGFsbC1rYXNtdm5jJyxcbiAgJ2hhcmRlbi1saXN0ZW5lcicsXG4gICdjcmVhdGUtZGVza3RvcC1pZGVudGl0eScsXG4gICdpbnN0YWxsLWRlc2t0b3AtcnVudGltZScsXG4gICdhdHRlc3QtcGFjaycsXG5dIGFzIGNvbnN0O1xuZXhwb3J0IHR5cGUgV29ya3NwYWNlSG9zdERlc2t0b3BQYWNrUGhhc2UgPVxuICAodHlwZW9mIFdPUktTUEFDRV9IT1NUX0RFU0tUT1BfUEFDS19QSEFTRVMpW251bWJlcl07XG5cbmV4cG9ydCBjb25zdCBXT1JLU1BBQ0VfSE9TVF9ERVNLVE9QX1BBQ0tfQ0hFQ0tTID0gW1xuICAndWJ1bnR1LTI0LjA0JyxcbiAgJ2hvc3QtYm9vdHN0cmFwcGVkJyxcbiAgJ2thc212bmMtZGlnZXN0JyxcbiAgJ2thc212bmMtYmluYXJ5JyxcbiAgJ2xvb3BiYWNrLW9ubHktbGlzdGVuZXInLFxuICAnZGVza3RvcC1pZGVudGl0eScsXG4gIC8vIFRoZSBtaXJyb3Igb2YgYHdvcmtzcGFjZS1jcmVkZW50aWFsLWlzb2xhdGlvbmAuIFRoYXQgb25lIHByb3ZlcyB0aGUgZGVza3RvcCB1c2VyXG4gIC8vIENBTk5PVCByZWFjaCB3aGF0IGlzbid0IGl0cyBvd247IHRoaXMgcHJvdmVzIGl0IENBTiByZWFjaCB3aGF0IGlzLiBBdHRlc3Rpbmcgb25seVxuICAvLyB0aGUgbmVnYXRpdmUgbGV0IHRoZSBwYWNrIHJlcG9ydCBgc3RhdHVzOiBoZWFsdGh5YCBvbiBhIGhvc3Qgd2hvc2UgZGVza3RvcCByb290IHdhc1xuICAvLyB1bnVzYWJsZSwgd2hpY2ggaXMgdGhlIHByZWNpc2UgZmFpbHVyZSB0aGlzIHBhY2sncyBpbnN0YWxsLXRpbWUgY2hlY2tzIGV4aXN0IHRvXG4gIC8vIHR1cm4gaW50byBcIm9uZSBsZWdpYmxlIGZhaWx1cmVcIiByYXRoZXIgdGhhbiBcImRlc2t0b3BzIHNpbGVudGx5IGRvIG5vdCB3b3JrXCIuXG4gICdkZXNrdG9wLXJvb3Qtd3JpdGFibGUnLFxuICAnd29ya3NwYWNlLWNyZWRlbnRpYWwtaXNvbGF0aW9uJyxcbiAgJ3gtc3RhY2snLFxuICAnYTExeS1zdGFjaycsXG4gICdnbC1zdGFjaycsXG4gICdkZXNrdG9wLWVudmlyb25tZW50JyxcbiAgJ2Jyb3dzZXInLFxuICAnZGVza3RvcC1ydW50aW1lJyxcbiAgJ2Rlc2t0b3Atc29ja2V0JyxcbiAgJ2Rlc2t0b3AtZWdyZXNzLWlzb2xhdGlvbicsXG4gIC8vIHBlcnNvbmFsLWNsb3VkLWRlc2t0b3AtMjAyNi0xMC0wNiAoRC0wMDEpOiB0aGUgc2Vjb25kIHdvcmtlciBpbnN0YW5jZSwgd2hpY2ggcnVucyBhc1xuICAvLyB0aGUgY3VzdG9tZXIgd29ya3NwYWNlIGFjY291bnQgZm9yIHRoZSBwZXJzb24ncyBvd24gZGVza3RvcC5cbiAgJ3BlcnNvbmFsLWRlc2t0b3AtcnVudGltZScsXG4gIC8vIFRoZSBuZWdhdGl2ZSBwYWlyOiBlYWNoIHdvcmtlciBtb2RlIHJlZnVzZXMgdGhlIG90aGVyJ3MgYWNjb3VudCwgc28gbmVpdGhlciBjbGFzc1xuICAvLyBvZiBkZXNrdG9wIGNhbiBiZSBzZXJ2ZWQgdW5kZXIgdGhlIHdyb25nIFVuaXggaWRlbnRpdHkuXG4gICdwZXJzb25hbC1kZXNrdG9wLWlkZW50aXR5JyxcbiAgJ3BlcnNvbmFsLWRlc2t0b3Atc29ja2V0Jyxcbl0gYXMgY29uc3Q7XG5leHBvcnQgdHlwZSBXb3Jrc3BhY2VIb3N0RGVza3RvcFBhY2tDaGVja05hbWUgPVxuICAodHlwZW9mIFdPUktTUEFDRV9IT1NUX0RFU0tUT1BfUEFDS19DSEVDS1MpW251bWJlcl07XG5cbmV4cG9ydCBpbnRlcmZhY2UgV29ya3NwYWNlSG9zdERlc2t0b3BQYWNrSXNvbGF0aW9uIHtcbiAgZGVza3RvcFVzZXI/OiBzdHJpbmc7XG4gIGRlc2t0b3BHcm91cD86IHN0cmluZztcbiAgLyoqIFRoZSBib290c3RyYXAncyB3b3Jrc3BhY2UgYWNjb3VudCwgd2hpY2ggdGhlIGRlc2t0b3AgdXNlciBtdXN0IE5PVCBiZSBhYmxlIHRvIHJlYWQuICovXG4gIHdvcmtzcGFjZVVzZXI/OiBzdHJpbmc7XG4gIC8qKiBUaGUgYm9vdHN0cmFwJ3Mgc2VydmljZSBhY2NvdW50LCB3aGljaCB0aGUgZGVza3RvcCB1c2VyIG11c3QgTk9UIHNoYXJlIGEgZ3JvdXAgd2l0aC4gKi9cbiAgc2VydmljZVVzZXI/OiBzdHJpbmc7XG4gIC8qKlxuICAgKiBUaGUgYm9vdHN0cmFwJ3MgQUdFTlQgYWNjb3VudCAoRC0yNDgpLCB3aG9zZSAwNzAwIGhvbWUgaG9sZHMgdGhlIGRlbGl2ZXJlZCBDbGF1ZGUvQ29kZXgvT01QXG4gICAqIG1hdGVyaWFsLiBUaGUgZGVza3RvcCB1c2VyIG11c3Qgbm90IGJlIGFibGUgdG8gcmVhZCBpdC4gTmFtZWQgc2VwYXJhdGVseSBmcm9tIGB3b3Jrc3BhY2VVc2VyYFxuICAgKiBiZWNhdXNlIHRob3NlIHR3byBob21lcyB3ZXJlIHRoZSBTQU1FIGRpcmVjdG9yeSBiZWZvcmUgRC0yNDggc3BsaXQgdGhlbSDigJQgc28gYSBjaGVjayB3cml0dGVuXG4gICAqIGFnYWluc3QgdGhlIHdvcmtzcGFjZSBob21lIGFsb25lIHNpbGVudGx5IHN0b3BwZWQgY292ZXJpbmcgdGhlIGNyZWRlbnRpYWxzIG9uIHRoZSBkYXkgb2YgdGhlXG4gICAqIHNwbGl0LCB3aXRob3V0IGNoYW5naW5nIGJlaGF2aW91ciBvciBmYWlsaW5nIGFueXRoaW5nLlxuICAgKi9cbiAgYWdlbnRVc2VyPzogc3RyaW5nO1xufVxuXG5leHBvcnQgaW50ZXJmYWNlIFdvcmtzcGFjZUhvc3REZXNrdG9wUGFja0lucHV0IHtcbiAgY29udHJhY3RWZXJzaW9uOiB0eXBlb2YgV09SS1NQQUNFX0hPU1RfREVTS1RPUF9QQUNLX0NPTlRSQUNUX1ZFUlNJT047XG4gIC8qKiBVbmluc3RhbGwgaXMgcmVzZXJ2ZWQgYnkgdGhlIGNvbnRyYWN0IGJ1dCBub3QgaW1wbGVtZW50ZWQ7IHRoZSBidWlsZGVyIHJlamVjdHMgaXQuICovXG4gIGFjdGlvbjogJ2luc3RhbGwnIHwgJ3VuaW5zdGFsbCc7XG4gIGhvc3RJZDogc3RyaW5nO1xuICBhcnRpZmFjdD86IFdvcmtzcGFjZUhvc3REZXNrdG9wUGFja0FydGlmYWN0O1xuICBpc29sYXRpb24/OiBXb3Jrc3BhY2VIb3N0RGVza3RvcFBhY2tJc29sYXRpb247XG4gIC8qKiBQZXJzaXN0YWJsZSBsYWJlbHMgb25seTsgc2VjcmV0LXNoYXBlZCB2YWx1ZXMgYXJlIHJlamVjdGVkLCBhcyBpbiB0aGUgYm9vdHN0cmFwLiAqL1xuICBwdWJsaWNNZXRhZGF0YT86IFJlYWRvbmx5PFJlY29yZDxzdHJpbmcsIHVua25vd24+Pjtcbn1cblxuZXhwb3J0IGludGVyZmFjZSBXb3Jrc3BhY2VIb3N0RGVza3RvcFBhY2tBdHRlc3RhdGlvbiB7XG4gIGNvbnRyYWN0VmVyc2lvbjogdHlwZW9mIFdPUktTUEFDRV9IT1NUX0RFU0tUT1BfUEFDS19DT05UUkFDVF9WRVJTSU9OO1xuICBob3N0SWQ6IHN0cmluZztcbiAgYWN0aW9uOiBXb3Jrc3BhY2VIb3N0RGVza3RvcFBhY2tJbnB1dFsnYWN0aW9uJ107XG4gIHVidW50dVZlcnNpb246IHR5cGVvZiBXT1JLU1BBQ0VfSE9TVF9CT09UU1RSQVBfVUJVTlRVX1ZFUlNJT047XG4gIG9ic2VydmVkQXQ6IHN0cmluZztcbiAgc3RhdHVzOiAnaGVhbHRoeSc7XG4gIGthc212bmM6IHsgdmVyc2lvbjogc3RyaW5nOyBzaGEyNTY6IHN0cmluZyB9O1xuICBjaGVja3M6IEFycmF5PHsgbmFtZTogV29ya3NwYWNlSG9zdERlc2t0b3BQYWNrQ2hlY2tOYW1lOyBvazogdHJ1ZSB9Pjtcbn1cblxuZnVuY3Rpb24gc2hlbGxRdW90ZSh2YWx1ZTogc3RyaW5nKTogc3RyaW5nIHtcbiAgcmV0dXJuIGAnJHt2YWx1ZS5yZXBsYWNlKC8nL2csIGAnXFxcXCcnYCl9J2A7XG59XG5cbi8qKiBVSUQtc2NvcGVkIE9VVFBVVCBydWxlczsgZG8gbm90IHRvdWNoIHRoZSBob3N0J3MgZXhpc3RpbmcgaW5ncmVzcyBmaXJld2FsbC4gKi9cbmV4cG9ydCBmdW5jdGlvbiBidWlsZFdvcmtzcGFjZURlc2t0b3BFZ3Jlc3NSdWxlcyh1aWQ6IG51bWJlciB8ICckREVTS1RPUF9VSUQnKTogc3RyaW5nIHtcbiAgaWYgKHVpZCAhPT0gJyRERVNLVE9QX1VJRCcgJiYgKCFOdW1iZXIuaXNTYWZlSW50ZWdlcih1aWQpIHx8IHVpZCA8PSAwKSkgdGhyb3cgbmV3IEVycm9yKCdkZXNrdG9wIGVncmVzcyByZXF1aXJlcyBhIG5vbi1yb290IHVpZCcpO1xuICByZXR1cm4gYGFkZCB0YWJsZSBpbmV0IHBhcGVyY3VzcF9kZXNrdG9wXG5hZGQgY2hhaW4gaW5ldCBwYXBlcmN1c3BfZGVza3RvcCBvdXRwdXQgeyB0eXBlIGZpbHRlciBob29rIG91dHB1dCBwcmlvcml0eSAtMTA7IHBvbGljeSBhY2NlcHQ7IH1cbmZsdXNoIGNoYWluIGluZXQgcGFwZXJjdXNwX2Rlc2t0b3Agb3V0cHV0XG5hZGQgcnVsZSBpbmV0IHBhcGVyY3VzcF9kZXNrdG9wIG91dHB1dCBtZXRhIHNrdWlkICR7dWlkfSBjdCBkaXJlY3Rpb24gcmVwbHkgYWNjZXB0XG5hZGQgcnVsZSBpbmV0IHBhcGVyY3VzcF9kZXNrdG9wIG91dHB1dCBtZXRhIHNrdWlkICR7dWlkfSBpcCBkYWRkciAxMjcuMC4wLjUzIG1ldGEgbDRwcm90byB7IHRjcCwgdWRwIH0gdGggZHBvcnQgNTMgYWNjZXB0XG5hZGQgcnVsZSBpbmV0IHBhcGVyY3VzcF9kZXNrdG9wIG91dHB1dCBtZXRhIHNrdWlkICR7dWlkfSBpcCBkYWRkciAxNjkuMjU0LjE2OS4yNTQgbWV0YSBsNHByb3RvIHsgdGNwLCB1ZHAgfSB0aCBkcG9ydCA1MyBhY2NlcHRcbmFkZCBydWxlIGluZXQgcGFwZXJjdXNwX2Rlc2t0b3Agb3V0cHV0IG1ldGEgc2t1aWQgJHt1aWR9IGZpYiBkYWRkciB0eXBlIGxvY2FsIHJlamVjdFxuYWRkIHJ1bGUgaW5ldCBwYXBlcmN1c3BfZGVza3RvcCBvdXRwdXQgbWV0YSBza3VpZCAke3VpZH0gaXAgZGFkZHIgMTY5LjI1NC4wLjAvMTYgcmVqZWN0XG5hZGQgcnVsZSBpbmV0IHBhcGVyY3VzcF9kZXNrdG9wIG91dHB1dCBtZXRhIHNrdWlkICR7dWlkfSBpcDYgZGFkZHIgeyBmZTgwOjovMTAsIGZjMDA6Oi83IH0gcmVqZWN0XG5gO1xufVxuXG5mdW5jdGlvbiBhc3NlcnRQdWJsaWNIdHRwcyh1cmw6IHN0cmluZywgbGFiZWw6IHN0cmluZyk6IHZvaWQge1xuICBsZXQgcGFyc2VkOiBVUkw7XG4gIHRyeSB7XG4gICAgcGFyc2VkID0gbmV3IFVSTCh1cmwpO1xuICB9IGNhdGNoIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoYERlc2t0b3AgcGFjayAke2xhYmVsfSBtdXN0IGJlIGFuIGFic29sdXRlIFVSTGApO1xuICB9XG4gIGlmIChwYXJzZWQucHJvdG9jb2wgIT09ICdodHRwczonKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKGBEZXNrdG9wIHBhY2sgJHtsYWJlbH0gbXVzdCBiZSBodHRwc2ApO1xuICB9XG4gIC8vIFNhbWUgcnVsZSB0aGUgYm9vdHN0cmFwIHJlbGVhc2UgYXBwbGllczogYSBjcmVkZW50aWFsIGluIGEgVVJMIGVuZHMgdXAgaW4gcHJvY2Vzc1xuICAvLyBsaXN0aW5ncywgc2hlbGwgaGlzdG9yeSBhbmQgYW55IGxvZyB0aGF0IGVjaG9lcyB0aGUgZmV0Y2guXG4gIGlmIChwYXJzZWQudXNlcm5hbWUgfHwgcGFyc2VkLnBhc3N3b3JkIHx8IHBhcnNlZC5zZWFyY2gpIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoYERlc2t0b3AgcGFjayAke2xhYmVsfSBtdXN0IG5vdCBjYXJyeSBjcmVkZW50aWFscyBvciBhIHF1ZXJ5IHN0cmluZ2ApO1xuICB9XG59XG5cbi8qKlxuICogUmVuZGVyIHRoZSBwYWNrJ3Mgcm9vdCBzaGVsbCBzY3JpcHQuXG4gKlxuICogRXZlcnkgcGhhc2UgZW5kcyBieSBwcmludGluZyBpdHMgbmFtZSwgc28gYSBwYXJ0aWFsIHJ1biBzYXlzIGV4YWN0bHkgaG93IGZhciBpdCBnb3RcbiAqIHJhdGhlciB0aGFuIGxlYXZpbmcgdGhlIGNhbGxlciB0byBpbmZlciBpdCBmcm9tIHdoaWNoIGNoZWNrIGZhaWxlZC4gYHNldCAtZXVvXG4gKiBwaXBlZmFpbGAgaXMgbG9hZC1iZWFyaW5nIGhlcmUgZm9yIHRoZSBzYW1lIHJlYXNvbiBpdCBpcyBpbiB0aGUgYm9vdHN0cmFwOiBzZXZlcmFsXG4gKiBzdGVwcyBhcmUgYGNtZCB8IGNtZGAgcGlwZWxpbmVzIHdob3NlIGZpcnN0IGhhbGYgaXMgdGhlIG9uZSB0aGF0IGNhbiBmYWlsLlxuICovXG5leHBvcnQgZnVuY3Rpb24gYnVpbGRXb3Jrc3BhY2VIb3N0RGVza3RvcFBhY2tTY3JpcHQoXG4gIGlucHV0OiBXb3Jrc3BhY2VIb3N0RGVza3RvcFBhY2tJbnB1dCxcbik6IHsgc2NyaXB0OiBzdHJpbmc7IHBoYXNlczogcmVhZG9ubHkgV29ya3NwYWNlSG9zdERlc2t0b3BQYWNrUGhhc2VbXSB9IHtcbiAgaWYgKGlucHV0LmNvbnRyYWN0VmVyc2lvbiAhPT0gV09SS1NQQUNFX0hPU1RfREVTS1RPUF9QQUNLX0NPTlRSQUNUX1ZFUlNJT04pIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICBgRGVza3RvcCBwYWNrIGNvbnRyYWN0IG1pc21hdGNoOiBleHBlY3RlZCAke1dPUktTUEFDRV9IT1NUX0RFU0tUT1BfUEFDS19DT05UUkFDVF9WRVJTSU9OfWAsXG4gICAgKTtcbiAgfVxuICAvLyBUaGUgcHJpdmlsZWdlZCBzY3JpcHQgb25seSBpbnN0YWxscy4gTmV2ZXIgcmVuZGVyIGFuIGluc3RhbGwgc2NyaXB0IGxhYmVsbGVkXG4gIC8vIFwidW5pbnN0YWxsXCI6IHRoYXQgd291bGQgbWFrZSBhIGRlc3RydWN0aXZlIGNhbGxlciBydW4gYXB0IGluc3RhbGxzIGFuZCB0aGVuXG4gIC8vIGZhbHNlbHkgYXR0ZXN0IHN1Y2Nlc3MuIFJlamVjdCBiZWZvcmUgY29uc3RydWN0aW5nIGFueSBzaGVsbCBjb21tYW5kcy5cbiAgaWYgKGlucHV0LmFjdGlvbiAhPT0gJ2luc3RhbGwnKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKGBEZXNrdG9wIHBhY2sgYWN0aW9uICR7U3RyaW5nKGlucHV0LmFjdGlvbil9IGlzIG5vdCBpbXBsZW1lbnRlZDsgb25seSBpbnN0YWxsIGlzIHN1cHBvcnRlZGApO1xuICB9XG4gIGlmICghaW5wdXQuaG9zdElkLnRyaW0oKSkgdGhyb3cgbmV3IEVycm9yKCdEZXNrdG9wIHBhY2sgcmVxdWlyZXMgYSBob3N0SWQnKTtcbiAgaWYgKGlucHV0LnB1YmxpY01ldGFkYXRhKSB7XG4gICAgYXNzZXJ0V29ya3NwYWNlSG9zdFNlY3JldElzb2xhdGlvbihpbnB1dC5wdWJsaWNNZXRhZGF0YSwgJ2Rlc2t0b3BQYWNrLnB1YmxpY01ldGFkYXRhJyk7XG4gIH1cblxuICBjb25zdCBhcnRpZmFjdCA9IGlucHV0LmFydGlmYWN0ID8/IFBJTk5FRF9LQVNNVk5DX0FSVElGQUNUO1xuICBhc3NlcnRQdWJsaWNIdHRwcyhhcnRpZmFjdC5kZWJVcmwsICdhcnRpZmFjdC5kZWJVcmwnKTtcbiAgaWYgKCEvXlswLTlhLWZdezY0fSQvLnRlc3QoYXJ0aWZhY3QuZGViU2hhMjU2KSkge1xuICAgIHRocm93IG5ldyBFcnJvcignRGVza3RvcCBwYWNrIGFydGlmYWN0LmRlYlNoYTI1NiBtdXN0IGJlIGEgbG93ZXJjYXNlIDY0LWNoYXIgc2hhMjU2Jyk7XG4gIH1cblxuICBjb25zdCBkZXNrdG9wVXNlciA9IGlucHV0Lmlzb2xhdGlvbj8uZGVza3RvcFVzZXIgPz8gREVGQVVMVF9XT1JLU1BBQ0VfSE9TVF9ERVNLVE9QX1VTRVI7XG4gIGNvbnN0IGRlc2t0b3BHcm91cCA9IGlucHV0Lmlzb2xhdGlvbj8uZGVza3RvcEdyb3VwID8/IERFRkFVTFRfV09SS1NQQUNFX0hPU1RfREVTS1RPUF9HUk9VUDtcbiAgY29uc3Qgd29ya3NwYWNlVXNlciA9IGlucHV0Lmlzb2xhdGlvbj8ud29ya3NwYWNlVXNlciA/PyBERUZBVUxUX1dPUktTUEFDRV9IT1NUX1dPUktTUEFDRV9VU0VSO1xuICBjb25zdCBzZXJ2aWNlVXNlciA9IGlucHV0Lmlzb2xhdGlvbj8uc2VydmljZVVzZXIgPz8gREVGQVVMVF9XT1JLU1BBQ0VfSE9TVF9TRVJWSUNFX1VTRVI7XG4gIC8vIEQtMjQ4IG1vdmVkIHRoZSBhZ2VudCBjcmVkZW50aWFscyBPVVQgb2YgdGhlIHdvcmtzcGFjZSBhY2NvdW50J3MgaG9tZSBhbmQgaW50byB0aGVpciBvd25cbiAgLy8gaWRlbnRpdHkuIFRoaXMgcGFjaydzIHdob2xlIGlzb2xhdGlvbiBjbGFpbSB3YXMgd3JpdHRlbiB3aGVuIHRob3NlIHdlcmUgdGhlIHNhbWUgZGlyZWN0b3J5LFxuICAvLyBzbyB3aXRob3V0IG5hbWluZyB0aGUgYWdlbnQgYWNjb3VudCBoZXJlIHRoZSByZWFjaGFiaWxpdHkgY2hlY2sgYmVsb3cgd291bGQga2VlcCBwcm92aW5nIHRoZVxuICAvLyBkZXNrdG9wIHVzZXIgY2Fubm90IHJlYWQgYSBob21lIHRoZSBjcmVkZW50aWFscyBubyBsb25nZXIgbGl2ZSBpbiDigJQgYSBndWFyZCBzdGlsbCBwYXNzaW5nXG4gIC8vIG92ZXIgYW4gZW1wdHkgYmFybiwgd2hpY2ggaXMgd29yc2UgdGhhbiBubyBndWFyZCBiZWNhdXNlIGl0IHJlYWRzIGFzIGNvdmVyYWdlLlxuICBjb25zdCBhZ2VudFVzZXIgPSBpbnB1dC5pc29sYXRpb24/LmFnZW50VXNlciA/PyBERUZBVUxUX1dPUktTUEFDRV9IT1NUX0FHRU5UX1VTRVI7XG5cbiAgaWYgKFxuICAgIGRlc2t0b3BVc2VyID09PSB3b3Jrc3BhY2VVc2VyIHx8XG4gICAgZGVza3RvcFVzZXIgPT09IHNlcnZpY2VVc2VyIHx8XG4gICAgZGVza3RvcFVzZXIgPT09IGFnZW50VXNlclxuICApIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICBgRGVza3RvcCBwYWNrIHJlZnVzZXMgZGVza3RvcFVzZXI9JHtkZXNrdG9wVXNlcn06IHNhbmRib3ggZGVza3RvcHMgbXVzdCBub3QgcnVuIGFzIHRoZSBgICtcbiAgICAgICAgJ3dvcmtzcGFjZSwgc2VydmljZSwgb3IgYWdlbnQgYWNjb3VudC4gQmV0d2VlbiB0aGVtIHRob3NlIGFjY291bnRzIGhvbGQgdGhlIGN1c3RvbWVyICcgK1xuICAgICAgICAnY2hlY2tvdXQsIGl0cyBnaXQgY3JlZGVudGlhbHMsIGFuZCB0aGUgZGVsaXZlcmVkIGFnZW50IGNyZWRlbnRpYWxzLCBzbyByZXVzaW5nIG9uZSAnICtcbiAgICAgICAgJ3dvdWxkIG1ha2UgYSBzYW5kYm94IGVzY2FwZSBhIGNyZWRlbnRpYWwgY29tcHJvbWlzZSDigJQgd2hpY2ggaXMgdGhlIGV4YWN0IGJsZWVkIHRoaXMgJyArXG4gICAgICAgICdwYWNrIGV4aXN0cyB0byBwcmV2ZW50LicsXG4gICAgKTtcbiAgfVxuXG4gIGZvciAoY29uc3QgdXNlciBvZiBbZGVza3RvcFVzZXIsIGRlc2t0b3BHcm91cCwgd29ya3NwYWNlVXNlciwgc2VydmljZVVzZXIsIGFnZW50VXNlcl0pIHtcbiAgICBpZiAoIS9eW2Etel9dW2EtejAtOV8tXXswLDMxfSQvLnRlc3QodXNlcikpIHRocm93IG5ldyBFcnJvcignRGVza3RvcCBwYWNrIHJlcXVpcmVzIHZhbGlkIFVuaXggYWNjb3VudCBuYW1lcycpO1xuICB9XG4gIGlmIChkZXNrdG9wVXNlciAhPT0gREVGQVVMVF9XT1JLU1BBQ0VfSE9TVF9ERVNLVE9QX1VTRVIgfHwgZGVza3RvcEdyb3VwICE9PSBERUZBVUxUX1dPUktTUEFDRV9IT1NUX0RFU0tUT1BfR1JPVVApIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoJ0Rlc2t0b3AgcnVudGltZSByZXF1aXJlcyB0aGUgZml4ZWQgcGFwZXJjdXNwLWRlc2t0b3AgaWRlbnRpdHknKTtcbiAgfVxuICAvLyBUaGUgcGVyc29uYWwgd29ya2VyIGFzc2VydHMgdGhpcyBleGFjdCBhY2NvdW50IGFuZCAvaG9tZS88YWNjb3VudD4gKEQtMDAxKSwgc28gYVxuICAvLyBkaWZmZXJlbnQgd29ya3NwYWNlIGFjY291bnQgd291bGQgZmFpbCBhdCBpbnN0YWxsIHJhdGhlciB0aGFuIHNlcnZlIGEgZGVza3RvcC5cbiAgaWYgKHdvcmtzcGFjZVVzZXIgIT09IERFRkFVTFRfV09SS1NQQUNFX0hPU1RfV09SS1NQQUNFX1VTRVIpIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoJ1BlcnNvbmFsIGRlc2t0b3AgcnVudGltZSByZXF1aXJlcyB0aGUgZml4ZWQgcGFwZXJjdXNwLXdvcmtzcGFjZSBpZGVudGl0eScpO1xuICB9XG5cbiAgY29uc3QgYXB0ID0gW1xuICAgIC4uLldPUktTUEFDRV9IT1NUX0RFU0tUT1BfUEFDS19BUFQua2FzbXZuY1J1bnRpbWUsXG4gICAgLi4uV09SS1NQQUNFX0hPU1RfREVTS1RPUF9QQUNLX0FQVC53aW5kb3dNYW5hZ2VyLFxuICAgIC4uLldPUktTUEFDRV9IT1NUX0RFU0tUT1BfUEFDS19BUFQuZ2wsXG4gICAgLi4uV09SS1NQQUNFX0hPU1RfREVTS1RPUF9QQUNLX0FQVC5hY2Nlc3NpYmlsaXR5LFxuICAgIC4uLldPUktTUEFDRV9IT1NUX0RFU0tUT1BfUEFDS19BUFQuZHJpdmVyLFxuICAgIC4uLldPUktTUEFDRV9IT1NUX0RFU0tUT1BfUEFDS19BUFQuc2FuZGJveCxcbiAgICAuLi5XT1JLU1BBQ0VfSE9TVF9ERVNLVE9QX1BBQ0tfQVBULmRlc2t0b3BGbG9vcixcbiAgICAuLi5XT1JLU1BBQ0VfSE9TVF9ERVNLVE9QX1BBQ0tfQVBULmRlc2t0b3BFbnZpcm9ubWVudCxcbiAgICAuLi5XT1JLU1BBQ0VfSE9TVF9ERVNLVE9QX1BBQ0tfQVBULmJyb3dzZXJLZXlyaW5nLFxuICBdO1xuICBjb25zdCBicm93c2VyID0gV09SS1NQQUNFX0hPU1RfREVTS1RPUF9CUk9XU0VSX1JFUE87XG5cbiAgY29uc3Qgc2NyaXB0ID0gYCMhL3Vzci9iaW4vZW52IGJhc2hcbiMgUGFwZXJjdXNwIHdvcmtzcGFjZS1ob3N0IERFU0tUT1AgUEFDSyAoJHtXT1JLU1BBQ0VfSE9TVF9ERVNLVE9QX1BBQ0tfQ09OVFJBQ1RfVkVSU0lPTn0pXG4jIE9wdC1pbiwgbGF5ZXJlZCwgcG9zdC1wcm92aXNpb24uIE5ldmVyIHBhcnQgb2YgdGhlIGJhc2UgaW1hZ2UgKEQtMDE4IC8gRC0wMjIpLlxuc2V0IC1ldW8gcGlwZWZhaWxcblxuSE9TVF9JRD0ke3NoZWxsUXVvdGUoaW5wdXQuaG9zdElkKX1cbkRFU0tUT1BfVVNFUj0ke3NoZWxsUXVvdGUoZGVza3RvcFVzZXIpfVxuREVTS1RPUF9HUk9VUD0ke3NoZWxsUXVvdGUoZGVza3RvcEdyb3VwKX1cbldPUktTUEFDRV9VU0VSPSR7c2hlbGxRdW90ZSh3b3Jrc3BhY2VVc2VyKX1cblNFUlZJQ0VfVVNFUj0ke3NoZWxsUXVvdGUoc2VydmljZVVzZXIpfVxuQUdFTlRfVVNFUj0ke3NoZWxsUXVvdGUoYWdlbnRVc2VyKX1cbkRFU0tUT1BfUk9PVD0ke3NoZWxsUXVvdGUoV09SS1NQQUNFX0hPU1RfREVTS1RPUF9ST09UKX1cbktBU01fVVJMPSR7c2hlbGxRdW90ZShhcnRpZmFjdC5kZWJVcmwpfVxuS0FTTV9TSEE9JHtzaGVsbFF1b3RlKGFydGlmYWN0LmRlYlNoYTI1Nil9XG5LQVNNX1ZFUlNJT049JHtzaGVsbFF1b3RlKGFydGlmYWN0LnZlcnNpb24pfVxuS0FTTV9ZQU1MPS9ldGMva2FzbXZuYy9rYXNtdm5jLnlhbWxcblxucGhhc2UoKSB7IGVjaG8gXCJQQVBFUkNVU1BfREVTS1RPUF9QQUNLX1BIQVNFPSQxXCI7IH1cbmZhaWwoKSAgeyBlY2hvIFwiUEFQRVJDVVNQX0RFU0tUT1BfUEFDS19GQUlMPSQxXCIgPiYyOyBleGl0IDE7IH1cbiMgQm91bmRlZCByZXRyeSBmb3IgYXJjaGl2ZSBhY2Nlc3M6IG9uZSBtaXNzZWQgZmV0Y2ggbXVzdCBub3QgZmFpbCB0aGUgcGFjayAoV0ktMTAwMDI4MzcpLlxuIyBFeGhhdXN0aW9uIHJldHVybnMgbm9uLXplcm8sIHNvIHNldCAtZSBzdGlsbCBzdG9wcyB0aGUgc2NyaXB0IGV4YWN0bHkgYXMgYSBzaW5nbGUgdHJ5IGRpZC5cbiMgRXZlcnkgbmV0d29ya2VkIGFwdCBjYWxsIGlzIHdhbGwtY2xvY2sgYm91bmRlZDogb25lIGFwdC1nZXQgdXBkYXRlIHJhbiB+MzAgbWluIG9uIGEgZmlyc3RcbiMgYm9vdCB3aXRob3V0IGFwdCdzIG93biB0aW1lb3V0cyBlbmRpbmcgaXQgKFdJLTEwMDAyODYzKS4gRmV0Y2hlcyBhcmUgYm91bmRlZCwgZHBrZyBpcyBub3QuXG4ke0FQVF9CT1VOREVEX0hFTFBFUl9MSU5FUy5qb2luKCdcXG4nKX1cbnJldHJ5KCkgeyBsb2NhbCBtYXg9XCIkMVwiIGF0dGVtcHQ9MTsgc2hpZnQ7IHVudGlsIFwiJEBcIjsgZG8gKCggYXR0ZW1wdCA+PSBtYXggKSkgJiYgcmV0dXJuIDE7IGVjaG8gXCJhdHRlbXB0ICRhdHRlbXB0LyRtYXggZmFpbGVkLCByZXRyeWluZyBpbiAkKCggYXR0ZW1wdCAqIDUgKSlzOiAkKlwiID4mMjsgc2xlZXAgJCgoIGF0dGVtcHQgKiA1ICkpOyBhdHRlbXB0PSQoKCBhdHRlbXB0ICsgMSApKTsgZG9uZTsgfVxuXG4jIOKUgOKUgCB2YWxpZGF0ZS1ob3N0IOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgFxuLiAvZXRjL29zLXJlbGVhc2VcblsgXCJcXCR7SUQ6LX1cIiA9IHVidW50dSBdIHx8IGZhaWwgdWJ1bnR1LTI0LjA0XG5bIFwiXFwke1ZFUlNJT05fSUQ6LX1cIiA9ICR7c2hlbGxRdW90ZShXT1JLU1BBQ0VfSE9TVF9CT09UU1RSQVBfVUJVTlRVX1ZFUlNJT04pfSBdIHx8IGZhaWwgdWJ1bnR1LTI0LjA0XG4jIFRoZSBwYWNrIExBWUVSUyBvbnRvIGEgYm9vdHN0cmFwcGVkIGhvc3Q7IGl0IGRvZXMgbm90IGJvb3RzdHJhcCBvbmUuIFJlZnVzaW5nIGhlcmVcbiMgdHVybnMgXCJkZXNrdG9wcyBzaWxlbnRseSBkbyBub3Qgd29ya1wiIGludG8gb25lIGxlZ2libGUgZmFpbHVyZSBhdCBpbnN0YWxsIHRpbWUuXG5bIC1kICR7c2hlbGxRdW90ZShXT1JLU1BBQ0VfSE9TVF9SVU5USU1FX1JPT1QpfSBdIHx8IGZhaWwgaG9zdC1ib290c3RyYXBwZWRcbnBoYXNlIHZhbGlkYXRlLWhvc3RcblxuIyDilIDilIAgaW5zdGFsbC14LXN0YWNrIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgFxuZXhwb3J0IERFQklBTl9GUk9OVEVORD1ub25pbnRlcmFjdGl2ZVxuIyAtLWVycm9yLW9uPWFueTogYW4gdW5yZWFjaGFibGUgYXJjaGl2ZSBpcyBvdGhlcndpc2Ugb25seSBhIHdhcm5pbmcgd2l0aCBleGl0IDAuXG5yZXRyeSAxMCBhcHRfdXBkYXRlIC1xcSAtLWVycm9yLW9uPWFueVxuIyAtLW5vLWluc3RhbGwtcmVjb21tZW5kcyBpcyB3aGF0IGtlZXBzIHRoaXMgYSBQQUNLIGFuZCBub3QgYSBkZXNrdG9wIGVudmlyb25tZW50OlxuIyBzZXZlcmFsIG9mIHRoZXNlIHJlY29tbWVuZCBhIGRpc3BsYXkgbWFuYWdlciwgYW5kIGEgd29ya3NwYWNlIGhvc3QgbXVzdCBuZXZlclxuIyBhY3F1aXJlIGEgbG9naW4gc2NyZWVuIGFzIGEgc2lkZSBlZmZlY3Qgb2Ygb3B0aW5nIGludG8gYWdlbnQgZGVza3RvcHMuXG5yZXRyeSA1IGFwdF9pbnN0YWxsIC15IC0tbm8taW5zdGFsbC1yZWNvbW1lbmRzICR7YXB0LmpvaW4oJyAnKX1cblxuIyBUaGUgYnJvd3NlcjogTW96aWxsYSdzIHJlYWwgZGViIChzZWUgV09SS1NQQUNFX0hPU1RfREVTS1RPUF9CUk9XU0VSX1JFUE8pLiBUaGUgZmluZ2VycHJpbnRcbiMgaXMgY2hlY2tlZCBCRUZPUkUgdGhlIGtleSBpcyBpbnN0YWxsZWQsIGZvciB0aGUgc2FtZSByZWFzb24gYXMgdGhlIEthc21WTkMgZGlnZXN0IGJlbG93LlxuIyBUaGUgcGluIG91dHJhbmtzIFVidW50dSdzIHNuYXAgc3R1Yiwgd2hvc2UgZXBvY2ggbWFrZXMgaXRzIHZlcnNpb24gY29tcGFyZSBoaWdoZXIuXG5pbnN0YWxsIC1kIC1tIDA3NTUgL2V0Yy9hcHQva2V5cmluZ3Ncbk1PWl9LRVk9L2V0Yy9hcHQva2V5cmluZ3MvcGFja2FnZXMubW96aWxsYS5vcmcuYXNjXG5jdXJsIC1mc1NMIC0tcmV0cnkgMyAke1dPUktTUEFDRV9IT1NUX0NVUkxfU1RBTExfR1VBUkR9IC0tcHJvdG8gJz1odHRwcycgLS10bHN2MS4yIC1vIFwiJE1PWl9LRVkudG1wXCIgJHtzaGVsbFF1b3RlKGJyb3dzZXIua2V5VXJsKX1cblsgXCIkKGdwZyAtLXNob3cta2V5cyAtLXdpdGgtY29sb25zIFwiJE1PWl9LRVkudG1wXCIgfCBhd2sgLUY6ICckMT09XCJmcHJcIntwcmludCAkMTA7IGV4aXR9JylcIiA9ICR7c2hlbGxRdW90ZShicm93c2VyLmtleUZpbmdlcnByaW50KX0gXSBcXFxcXG4gIHx8IHsgcm0gLWYgXCIkTU9aX0tFWS50bXBcIjsgZmFpbCBicm93c2VyOyB9XG5tdiBcIiRNT1pfS0VZLnRtcFwiIFwiJE1PWl9LRVlcIlxuY2htb2QgMDY0NCBcIiRNT1pfS0VZXCJcbmVjaG8gXCJkZWIgW3NpZ25lZC1ieT0kTU9aX0tFWV0gJHticm93c2VyLnNvdXJjZX1cIiA+IC9ldGMvYXB0L3NvdXJjZXMubGlzdC5kL21vemlsbGEubGlzdFxucHJpbnRmICdQYWNrYWdlOiAqXFxcXG5QaW46IG9yaWdpbiAke2Jyb3dzZXIub3JpZ2lufVxcXFxuUGluLVByaW9yaXR5OiAxMDAwXFxcXG4nID4gL2V0Yy9hcHQvcHJlZmVyZW5jZXMuZC9tb3ppbGxhXG5yZXRyeSAxMCBhcHRfdXBkYXRlIC1xcSAtLWVycm9yLW9uPWFueVxucmV0cnkgNSBhcHRfaW5zdGFsbCAteSAtLW5vLWluc3RhbGwtcmVjb21tZW5kcyAke2Jyb3dzZXIucGFja2FnZX1cbnBoYXNlIGluc3RhbGwteC1zdGFja1xuXG4jIOKUgOKUgCBpbnN0YWxsLWthc212bmMg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAXG4jIE5vdCBpbiB0aGUgVWJ1bnR1IGFyY2hpdmUsIHNvIGZldGNoICsgdmVyaWZ5IGJ5IGRpZ2VzdC4gVGhlIGRpZ2VzdCBpcyBjaGVja2VkIEJFRk9SRVxuIyBkcGtnIGlzIGFsbG93ZWQgbmVhciB0aGUgZmlsZTogdmVyaWZ5aW5nIGFmdGVyd2FyZHMgd291bGQgbWVhbiBhIHN1YnN0aXR1dGVkIHBhY2thZ2VcbiMgaGFkIGFscmVhZHkgcnVuIGl0cyBtYWludGFpbmVyIHNjcmlwdHMgYXMgcm9vdC5cbktBU01fREVCPVwiJChta3RlbXAgLXQga2FzbXZuYy1YWFhYWFguZGViKVwiXG50cmFwICdybSAtZiBcIiRLQVNNX0RFQlwiJyBFWElUXG5jdXJsIC1mc1NMIC0tcmV0cnkgMyAke1dPUktTUEFDRV9IT1NUX0NVUkxfU1RBTExfR1VBUkR9IC0tcHJvdG8gJz1odHRwcycgLS10bHN2MS4yIC1vIFwiJEtBU01fREVCXCIgXCIkS0FTTV9VUkxcIlxuZWNobyBcIiRLQVNNX1NIQSAgJEtBU01fREVCXCIgfCBzaGEyNTZzdW0gLWMgLSA+L2Rldi9udWxsIDI+JjEgfHwgZmFpbCBrYXNtdm5jLWRpZ2VzdFxucmV0cnkgNSBhcHRfaW5zdGFsbCAteSAtLW5vLWluc3RhbGwtcmVjb21tZW5kcyBcIiRLQVNNX0RFQlwiXG5jb21tYW5kIC12IFhrYXNtdm5jID4vZGV2L251bGwgMj4mMSB8fCBmYWlsIGthc212bmMtYmluYXJ5XG5jb21tYW5kIC12IGthc212bmNwYXNzd2QgPi9kZXYvbnVsbCAyPiYxIHx8IGZhaWwga2FzbXZuYy1iaW5hcnlcbnBoYXNlIGluc3RhbGwta2FzbXZuY1xuXG4jIOKUgOKUgCBoYXJkZW4tbGlzdGVuZXIg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAXG4jIEQtMDIwLiBUaGUgcGFja2FnZSBzaGlwcyBuZXR3b3JrLmludGVyZmFjZTogMC4wLjAuMDsgdGhpcyBpcyB0aGUgb3ZlcnJpZGUsIGFuZCB0aGVcbiMgY2hlY2sgYmVsb3cgcmUtcmVhZHMgdGhlIGZpbGUgcmF0aGVyIHRoYW4gdHJ1c3RpbmcgdGhhdCB0aGUgd3JpdGUgaGFwcGVuZWQuXG5ta2RpciAtcCAvZXRjL2thc212bmNcbmNhdCA+IFwiJEtBU01fWUFNTFwiIDw8J0tBU01ZQU1MJ1xuIyBQYXBlcmN1c3AgZGVza3RvcCBwYWNrIOKAlCBNQU5BR0VEIEZJTEUsIHJlZ2VuZXJhdGVkIGJ5IHRoZSBwYWNrIG9uIGV2ZXJ5IGluc3RhbGwuXG4jIFRoZSBsaXN0ZW5lciBpcyBsb29wYmFjay1vbmx5IGJ5IHBvbGljeSAoRC0wMjApOiBzYW5kYm94IGRlc2t0b3BzIGFyZSByZWFjaGFibGVcbiMgZXhjbHVzaXZlbHkgdGhyb3VnaCB0aGUgd29ya3NwYWNlLWhvc3Qgb3BlcmF0b3IncyB0aWNrZXQtZ2F0ZWQgcHJveHksIG5ldmVyXG4jIGRpcmVjdGx5LiBXaWRlbmluZyB0aGUgaW50ZXJmYWNlIHZhbHVlIGhlcmUgc2lsZW50bHkgZXhwb3NlcyBldmVyeSBhZ2VudCBkZXNrdG9wIG9uXG4jIHRoZSBWTSdzIGV4dGVybmFsIGludGVyZmFjZSwgc28gdGhlIHBhY2sgYXNzZXJ0cyB0aGlzIHZhbHVlIGFzIGEgbmFtZWQgY2hlY2suXG5uZXR3b3JrOlxuICBpbnRlcmZhY2U6IDEyNy4wLjAuMVxuICBwcm90b2NvbDogaHR0cFxuICBzc2w6XG4gICAgcmVxdWlyZV9zc2w6IGZhbHNlXG5kZXNrdG9wOlxuICBhbGxvd19yZXNpemU6IHRydWVcbiAgcGl4ZWxfZGVwdGg6IDI0XG5LQVNNWUFNTFxuY2htb2QgMDY0NCBcIiRLQVNNX1lBTUxcIlxuZ3JlcCAtcUUgJ15bWzpzcGFjZTpdXStpbnRlcmZhY2U6W1s6c3BhY2U6XV0qMTI3XFxcXC4wXFxcXC4wXFxcXC4xW1s6c3BhY2U6XV0qJCcgXCIkS0FTTV9ZQU1MXCIgXFxcXFxuICB8fCBmYWlsIGxvb3BiYWNrLW9ubHktbGlzdGVuZXJcbmdyZXAgLXFFICdeW1s6c3BhY2U6XV0raW50ZXJmYWNlOltbOnNwYWNlOl1dKjBcXFxcLjBcXFxcLjBcXFxcLjAnIFwiJEtBU01fWUFNTFwiIFxcXFxcbiAgJiYgZmFpbCBsb29wYmFjay1vbmx5LWxpc3RlbmVyXG5waGFzZSBoYXJkZW4tbGlzdGVuZXJcblxuIyDilIDilIAgY3JlYXRlLWRlc2t0b3AtaWRlbnRpdHkg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAXG4jIEEgdGhpcmQgaWRlbnRpdHksIG93bmluZyBub3RoaW5nIGJ1dCBkZXNrdG9wcy4gLS1uby1jcmVhdGUtaG9tZSBiZWNhdXNlIHRoZSBob21lIGlzXG4jIGNyZWF0ZWQgZXhwbGljaXRseSBiZWxvdyBhdCAwNzAwOyBsZXR0aW5nIGFkZHVzZXIgY3JlYXRlIGl0IGFwcGxpZXMgdGhlIHNrZWwgYW5kIHRoZVxuIyBkZWZhdWx0IG1vZGUsIHdoaWNoIG9uIHRoaXMgaW1hZ2UgaXMgd29ybGQtcmVhZGFibGUuXG5nZXRlbnQgZ3JvdXAgXCIkREVTS1RPUF9HUk9VUFwiID4vZGV2L251bGwgfHwgZ3JvdXBhZGQgLS1zeXN0ZW0gXCIkREVTS1RPUF9HUk9VUFwiXG5nZXRlbnQgcGFzc3dkIFwiJERFU0tUT1BfVVNFUlwiID4vZGV2L251bGwgfHwgdXNlcmFkZCAtLXN5c3RlbSBcXFxcXG4gIC0tZ2lkIFwiJERFU0tUT1BfR1JPVVBcIiAtLWhvbWUtZGlyIFwiJERFU0tUT1BfUk9PVFwiIC0tbm8tY3JlYXRlLWhvbWUgXFxcXFxuICAtLXNoZWxsIC91c3Ivc2Jpbi9ub2xvZ2luIFwiJERFU0tUT1BfVVNFUlwiXG5pbnN0YWxsIC1kIC1vIFwiJERFU0tUT1BfVVNFUlwiIC1nIFwiJERFU0tUT1BfR1JPVVBcIiAtbSAwNzAwIFwiJERFU0tUT1BfUk9PVFwiXG5cbiMgT3duZXJzaGlwIGlzIE5PVCBldmlkZW5jZSBvZiB1c2FiaWxpdHk6IFxcYGluc3RhbGwgLWRcXGAgcnVucyBhcyByb290IGFuZCBzdWNjZWVkcyBldmVuXG4jIHdoZW4gZXZlcnkgYW5jZXN0b3IgZGVuaWVzIHRoZSBvd25lciB0cmF2ZXJzYWwsIHdoaWNoIGlzIGV4YWN0bHkgaG93IGEgZGVza3RvcCByb290XG4jIG5lc3RlZCB1bmRlciB0aGUgc2VydmljZSB1c2VyJ3MgMDc1MCBzdGF0ZSByb290IHBhc3NlZCBldmVyeSBvdGhlciBjaGVjayB3aGlsZSBiZWluZ1xuIyB1bndyaXRhYmxlIGJ5IHRoZSBvbmx5IGFjY291bnQgdGhhdCBldmVyIG5lZWRzIGl0LiBBc2sgdGhlIGRlc2t0b3AgdXNlciBkaXJlY3RseS5cbnJ1bnVzZXIgLXUgXCIkREVTS1RPUF9VU0VSXCIgLS0gdGVzdCAtdyBcIiRERVNLVE9QX1JPT1RcIiB8fCBmYWlsIGRlc2t0b3Atcm9vdC13cml0YWJsZVxuXG4jIFRIRSBJU09MQVRJT04gQVNTRVJUSU9OUy4gRWFjaCBpcyB0aGUgbmVnYXRpdmUgZm9ybSBvbiBwdXJwb3NlOiBcImlzIG5vdCBhIG1lbWJlclwiLFxuIyBcImNhbm5vdCByZWFkXCIuIEEgcG9zaXRpdmUgY2hlY2sgKFwidGhlIGRlc2t0b3AgdXNlciBleGlzdHNcIikgcGFzc2VzIGp1c3QgYXMgaGFwcGlseVxuIyBvbiBhIGhvc3Qgd2hlcmUgc29tZW9uZSBhZGRlZCBpdCB0byB0aGUgd29ya3NwYWNlIGdyb3VwIGZvciBjb252ZW5pZW5jZS5cblsgXCIkKGlkIC1nbiBcIiRERVNLVE9QX1VTRVJcIilcIiA9IFwiJERFU0tUT1BfR1JPVVBcIiBdIHx8IGZhaWwgZGVza3RvcC1pZGVudGl0eVxuWyBcIiQoZ2V0ZW50IHBhc3N3ZCBcIiRERVNLVE9QX1VTRVJcIiB8IGN1dCAtZDogLWY3KVwiID0gL3Vzci9zYmluL25vbG9naW4gXSB8fCBmYWlsIGRlc2t0b3AtaWRlbnRpdHlcbmlkIC1uRyBcIiRERVNLVE9QX1VTRVJcIiB8IHRyICcgJyAnXFxcXG4nIHwgZ3JlcCAtcXggXCIkV09SS1NQQUNFX1VTRVJcIiAmJiBmYWlsIHdvcmtzcGFjZS1jcmVkZW50aWFsLWlzb2xhdGlvblxuaWQgLW5HIFwiJERFU0tUT1BfVVNFUlwiIHwgdHIgJyAnICdcXFxcbicgfCBncmVwIC1xeCBcIiRTRVJWSUNFX1VTRVJcIiAmJiBmYWlsIHdvcmtzcGFjZS1jcmVkZW50aWFsLWlzb2xhdGlvblxuaWQgLW5HIFwiJERFU0tUT1BfVVNFUlwiIHwgdHIgJyAnICdcXFxcbicgfCBncmVwIC1xeCBcIiRBR0VOVF9VU0VSXCIgJiYgZmFpbCB3b3Jrc3BhY2UtY3JlZGVudGlhbC1pc29sYXRpb25cbiMgVGhlIGRlY2lzaXZlIHRlc3QgaXMgbm90IGdyb3VwIG1lbWJlcnNoaXAgYnV0IHJlYWNoYWJpbGl0eTogcHJvdmUgdGhlIGRlc2t0b3AgdXNlclxuIyBjYW5ub3QgYWN0dWFsbHkgcmVhZCBlaXRoZXIgcHJvdGVjdGVkIGhvbWUsIHdoYXRldmVyIHRoZSBncm91cHMgaGFwcGVuIHRvIHNheS5cbiNcbiMgQk9USCBob21lcywgc2luY2UgRC0yNDguIFRoZSB3b3Jrc3BhY2UgaG9tZSBob2xkcyB0aGUgY3VzdG9tZXIgY2hlY2tvdXQgYW5kIGl0cyBnaXRcbiMgY3JlZGVudGlhbHM7IHRoZSBBR0VOVCBob21lIGhvbGRzIHRoZSBkZWxpdmVyZWQgQ2xhdWRlL0NvZGV4L09NUCBtYXRlcmlhbC4gVGhleSB3ZXJlIG9uZVxuIyBkaXJlY3Rvcnkgd2hlbiB0aGlzIGNoZWNrIHdhcyB3cml0dGVuLCBzbyBjaGVja2luZyBvbmx5IHRoZSB3b3Jrc3BhY2UgaG9tZSB3b3VsZCBub3cgcGFzc1xuIyB3aGlsZSBsZWF2aW5nIHRoZSBjcmVkZW50aWFscyB0aGlzIHBhY2sgbmFtZXMgaW4gaXRzIG93biBlcnJvciBtZXNzYWdlIHVuZ3VhcmRlZC5cbmZvciBwcm90ZWN0ZWRfdXNlciBpbiBcIiRXT1JLU1BBQ0VfVVNFUlwiIFwiJEFHRU5UX1VTRVJcIjsgZG9cbiAgcHJvdGVjdGVkX2hvbWU9XCIkKGdldGVudCBwYXNzd2QgXCIkcHJvdGVjdGVkX3VzZXJcIiB8IGN1dCAtZDogLWY2IHx8IHRydWUpXCJcbiAgWyAtbiBcIlxcJHtwcm90ZWN0ZWRfaG9tZTotfVwiIF0gfHwgY29udGludWVcbiAgWyAtZCBcIiRwcm90ZWN0ZWRfaG9tZVwiIF0gfHwgY29udGludWVcbiAgaWYgcnVudXNlciAtdSBcIiRERVNLVE9QX1VTRVJcIiAtLSB0ZXN0IC1yIFwiJHByb3RlY3RlZF9ob21lXCIgMj4vZGV2L251bGw7IHRoZW5cbiAgICBmYWlsIHdvcmtzcGFjZS1jcmVkZW50aWFsLWlzb2xhdGlvblxuICBmaVxuZG9uZVxucGhhc2UgY3JlYXRlLWRlc2t0b3AtaWRlbnRpdHlcblxuIyDilIDilIAgaW5zdGFsbC1kZXNrdG9wLXJ1bnRpbWUg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAXG4jIENvcHkgT05MWSB0aGUgc2VsZi1jb250YWluZWQgd29ya2VyIGFuZCBpbnRlcnByZXRlci4gTmV2ZXIgZ3JhbnQgZGVza3RvcCBhY2Nlc3MgdG9cbiMgdGhlIHNlcnZpY2UvYWdlbnQgaG9tZXMsIHRoZWlyIGdyb3Vwcywgb3IgdGhlIHJlc3Qgb2YgdGhlIGltbXV0YWJsZSBydW50aW1lIHRyZWUuXG5ERVNLVE9QX0xJQj0vdXNyL2xvY2FsL2xpYi9wYXBlcmN1c3AtZGVza3RvcFxuaW5zdGFsbCAtZCAtbyByb290IC1nIHJvb3QgLW0gMDc1NSBcIiRERVNLVE9QX0xJQlwiXG5pbnN0YWxsIC1vIHJvb3QgLWcgcm9vdCAtbSAwNzU1ICR7c2hlbGxRdW90ZShgJHtXT1JLU1BBQ0VfSE9TVF9SVU5USU1FX1JPT1R9L2N1cnJlbnQvYmluL25vZGVgKX0gXCIkREVTS1RPUF9MSUIvbm9kZVwiXG5pbnN0YWxsIC1vIHJvb3QgLWcgcm9vdCAtbSAwNzU1ICR7c2hlbGxRdW90ZShgJHtXT1JLU1BBQ0VfSE9TVF9SVU5USU1FX1JPT1R9L2N1cnJlbnQvJHtXT1JLU1BBQ0VfSE9TVF9ERVNLVE9QX1NFU1NJT05fRU5UUllQT0lOVH1gKX0gXCIkREVTS1RPUF9MSUIvc2Vzc2lvbi5janNcIlxucnVudXNlciAtdSBcIiRERVNLVE9QX1VTRVJcIiAtLSBlbnYgLWkgSE9NRT1cIiRERVNLVE9QX1JPT1RcIiBQQVRIPS91c3IvYmluOi9iaW4gXFxcXFxuICBcIiRERVNLVE9QX0xJQi9ub2RlXCIgXCIkREVTS1RPUF9MSUIvc2Vzc2lvbi5janNcIiAtLWNoZWNrIHx8IGZhaWwgZGVza3RvcC1ydW50aW1lXG5cbiMgTG9vcGJhY2sgSFRUUCBpcyBwcml2aWxlZ2VkIG9wZXJhdG9yIGF1dGhvcml0eS4gVUlEL2hvbWUgaXNvbGF0aW9uIGFsb25lIGlzXG4jIGluc3VmZmljaWVudCB3aGVuIGRlc2t0b3AgYXBwcyBjYW4gY2FsbCBpdC4gS2VlcCBETlMgYW5kIHZpZXdlciBSRVBMSUVTLCB3aGlsZVxuIyByZWZ1c2luZyBkZXNrdG9wLW9yaWdpbiBjb25uZWN0aW9ucyB0byBsb2NhbCBzZXJ2aWNlcyBhbmQgbWV0YWRhdGEgZW5kcG9pbnRzLlxuREVTS1RPUF9VSUQ9XCIkKGlkIC11IFwiJERFU0tUT1BfVVNFUlwiKVwiXG5pbnN0YWxsIC1kIC1vIHJvb3QgLWcgcm9vdCAtbSAwNzU1IC9ldGMvcGFwZXJjdXNwXG5jYXQgPiAvZXRjL3BhcGVyY3VzcC9kZXNrdG9wLWVncmVzcy5uZnQgPDxORlRcbiR7YnVpbGRXb3Jrc3BhY2VEZXNrdG9wRWdyZXNzUnVsZXMoJyRERVNLVE9QX1VJRCcpfU5GVFxuY2htb2QgMDY0NCAvZXRjL3BhcGVyY3VzcC9kZXNrdG9wLWVncmVzcy5uZnRcbm5mdCAtZiAvZXRjL3BhcGVyY3VzcC9kZXNrdG9wLWVncmVzcy5uZnQgfHwgZmFpbCBkZXNrdG9wLWVncmVzcy1pc29sYXRpb25cbm5mdCBsaXN0IGNoYWluIGluZXQgcGFwZXJjdXNwX2Rlc2t0b3Agb3V0cHV0ID4vZGV2L251bGwgfHwgZmFpbCBkZXNrdG9wLWVncmVzcy1pc29sYXRpb25cblxuIyBUaGUgc29ja2V0IGNhcnJpZXMgTk8gb3JkZXJpbmcgb3IgcmVxdWlyZW1lbnQgb24gcGFwZXJjdXNwLXdvcmtzcGFjZS5zZXJ2aWNlIChELTQzOSkuXG4jIEEgZGVmYXVsdC1kZXBlbmRlbmN5IHNvY2tldCBpcyBCZWZvcmU9c29ja2V0cy50YXJnZXQsIGFuZCBldmVyeSBvcmRpbmFyeSBzZXJ2aWNlIGlzXG4jIEFmdGVyPWJhc2ljLnRhcmdldCwgd2hpY2ggaXMgQWZ0ZXI9c29ja2V0cy50YXJnZXQg4oCUIHNvIEFmdGVyPSB0aGF0IHNlcnZpY2UgY2xvc2VzIGFcbiMgY3ljbGUuIHN5c3RlbWQgYnJlYWtzIGl0IGF0IGJvb3QgYnkgZGVsZXRpbmcgdGhlIHNvY2tldCdzIHN0YXJ0IGpvYjogdGhlIHNvY2tldCB3YXNcbiMgbGl2ZSBhZnRlciBpbnN0YWxsIChzdGFydGVkIGJ5IGhhbmQgYmVsb3cpIGFuZCBzaWxlbnRseSBnb25lIGFmdGVyIHRoZSBmaXJzdCByZWJvb3QuXG4jIFRoZSBjb3VwbGluZyB0byB0aGUgd29ya3NwYWNlIHNlcnZpY2UgbGl2ZXMgb24gdGhlIHBlci1jb25uZWN0aW9uIEAuc2VydmljZSBpbnN0ZWFkLlxuY2F0ID4gL2V0Yy9zeXN0ZW1kL3N5c3RlbS9wYXBlcmN1c3AtZGVza3RvcC5zb2NrZXQgPDxVTklUXG5bVW5pdF1cbkRlc2NyaXB0aW9uPVBhcGVyY3VzcCBpc29sYXRlZCBkZXNrdG9wIHNlc3Npb24gYWRtaXNzaW9uXG5bU29ja2V0XVxuTGlzdGVuU3RyZWFtPS9ydW4vcGFwZXJjdXNwLWRlc2t0b3Avc2Vzc2lvbi5zb2NrXG5Tb2NrZXRVc2VyPXJvb3RcblNvY2tldEdyb3VwPSRTRVJWSUNFX1VTRVJcblNvY2tldE1vZGU9MDY2MFxuRGlyZWN0b3J5TW9kZT0wNzU1XG5BY2NlcHQ9eWVzXG5NYXhDb25uZWN0aW9ucz02NFxuUmVtb3ZlT25TdG9wPXllc1xuW0luc3RhbGxdXG5XYW50ZWRCeT1tdWx0aS11c2VyLnRhcmdldFxuVU5JVFxuY2F0ID4gL2V0Yy9zeXN0ZW1kL3N5c3RlbS9wYXBlcmN1c3AtZGVza3RvcEAuc2VydmljZSA8PFVOSVRcbltVbml0XVxuRGVzY3JpcHRpb249UGFwZXJjdXNwIGlzb2xhdGVkIGRlc2t0b3Agc2Vzc2lvblxuQWZ0ZXI9cGFwZXJjdXNwLXdvcmtzcGFjZS5zZXJ2aWNlXG5CaW5kc1RvPXBhcGVyY3VzcC13b3Jrc3BhY2Uuc2VydmljZVxuSm9pbnNOYW1lc3BhY2VPZj1wYXBlcmN1c3Atd29ya3NwYWNlLnNlcnZpY2VcbltTZXJ2aWNlXVxuVHlwZT1leGVjXG5Vc2VyPSRERVNLVE9QX1VTRVJcbkdyb3VwPSRERVNLVE9QX0dST1VQXG5Xb3JraW5nRGlyZWN0b3J5PSRERVNLVE9QX1JPT1RcbkVudmlyb25tZW50PUhPTUU9JERFU0tUT1BfUk9PVFxuRW52aXJvbm1lbnQ9UEFUSD0vdXNyL2xvY2FsL2JpbjovdXNyL2JpbjovYmluXG5FbnZpcm9ubWVudD1MQU5HPUMuVVRGLThcbiMgWEZDRSBUZXJtaW5hbCB1c2VzIFNIRUxMLCB0aGVuIHRoZSBwYXNzd2Qgc2hlbGwuIEtlZXAgdGhlIGFjY291bnQgbm9sb2dpbiBmb3JcbiMgYXV0aGVudGljYXRpb24gd2hpbGUgZ2l2aW5nIHRlcm1pbmFsIHdpbmRvd3MgYW4gaW50ZXJhY3RpdmUgc2hlbGwuXG5FbnZpcm9ubWVudD1TSEVMTD0vYmluL2Jhc2hcbiMgUmVhcHBseSB0aGUgZml4ZWQgcm9vdC1vd25lZCBydWxlcyBiZWZvcmUgQU5ZIHdvcmtlciwgaW5jbHVkaW5nIGFmdGVyIGEgcmVib290LlxuRXhlY1N0YXJ0UHJlPSsvdXNyL3NiaW4vbmZ0IC1mIC9ldGMvcGFwZXJjdXNwL2Rlc2t0b3AtZWdyZXNzLm5mdFxuRXhlY1N0YXJ0PSRERVNLVE9QX0xJQi9ub2RlICRERVNLVE9QX0xJQi9zZXNzaW9uLmNqcyAtLXN0ZGlvXG5TdGFuZGFyZElucHV0PXNvY2tldFxuU3RhbmRhcmRPdXRwdXQ9aW5oZXJpdFxuU3RhbmRhcmRFcnJvcj1qb3VybmFsXG5Ob05ld1ByaXZpbGVnZXM9dHJ1ZVxuUHJpdmF0ZVRtcD10cnVlXG5Qcm90ZWN0SG9tZT10cnVlXG5Qcm90ZWN0U3lzdGVtPXN0cmljdFxuUmVhZFdyaXRlUGF0aHM9JERFU0tUT1BfUk9PVFxuSW5hY2Nlc3NpYmxlUGF0aHM9JHtXT1JLU1BBQ0VfSE9TVF9TVEFURV9ST09UfSAvc3J2L3BhcGVyY3VzcC93b3Jrc3BhY2VzXG5SZXN0cmljdFNVSURTR0lEPXRydWVcbkxvY2tQZXJzb25hbGl0eT10cnVlXG5VTWFzaz0wMDc3XG5LaWxsTW9kZT1jb250cm9sLWdyb3VwXG5UaW1lb3V0U3RvcFNlYz01c1xuVU5JVFxuY2htb2QgMDY0NCAvZXRjL3N5c3RlbWQvc3lzdGVtL3BhcGVyY3VzcC1kZXNrdG9wLnNvY2tldCAvZXRjL3N5c3RlbWQvc3lzdGVtL3BhcGVyY3VzcC1kZXNrdG9wQC5zZXJ2aWNlXG5zeXN0ZW1kLWFuYWx5emUgdmVyaWZ5IC9ldGMvc3lzdGVtZC9zeXN0ZW0vcGFwZXJjdXNwLWRlc2t0b3Auc29ja2V0IC9ldGMvc3lzdGVtZC9zeXN0ZW0vcGFwZXJjdXNwLWRlc2t0b3BALnNlcnZpY2VcbnN5c3RlbWN0bCBkYWVtb24tcmVsb2FkXG5zeXN0ZW1jdGwgZW5hYmxlIC0tbm93IHBhcGVyY3VzcC1kZXNrdG9wLnNvY2tldFxuc3lzdGVtY3RsIGlzLWFjdGl2ZSAtLXF1aWV0IHBhcGVyY3VzcC1kZXNrdG9wLnNvY2tldCB8fCBmYWlsIGRlc2t0b3Atc29ja2V0XG5bIC1TIC9ydW4vcGFwZXJjdXNwLWRlc2t0b3Avc2Vzc2lvbi5zb2NrIF0gfHwgZmFpbCBkZXNrdG9wLXNvY2tldFxuWyBcIiQoc3RhdCAtYyAlYSAvcnVuL3BhcGVyY3VzcC1kZXNrdG9wL3Nlc3Npb24uc29jaylcIiA9IDY2MCBdIHx8IGZhaWwgZGVza3RvcC1zb2NrZXRcblxuIyDilIDilIAgcGVyc29uYWwgZGVza3RvcCB3b3JrZXIgKHBlcnNvbmFsLWNsb3VkLWRlc2t0b3AtMjAyNi0xMC0wNiwgRC0wMDEpIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgFxuIyBBIFNFQ09ORCBpbnN0YW5jZSBvZiB0aGUgc2FtZSB3b3JrZXIsIHJ1bm5pbmcgYXMgdGhlIGN1c3RvbWVyIHdvcmtzcGFjZSBhY2NvdW50OiBhXG4jIHBlcnNvbidzIG93biBkZXNrdG9wIG11c3Qgc2VlIHRoZWlyIGNoZWNrb3V0LCBmaWxlcyBhbmQgY3JlZGVudGlhbHMsIGV4YWN0bHkgYXMgdGhlaXJcbiMgaG9zdGVkIHRlcm1pbmFsIGRvZXMuIEl0IGlzIGEgc2VwYXJhdGUgc29ja2V0IGFuZCB1bml0IOKAlCBuZXZlciBhIG1vZGUgc3dpdGNoIGluc2lkZSB0aGVcbiMgc2FuZGJveCB1bml0IOKAlCBzbyBhIHNhbmRib3ggbGVhc2UgY2Fubm90IGxhbmQgaW4gdGhlIGN1c3RvbWVyIGFjY291bnQsIGFuZCBhIHBlcnNvbmFsXG4jIGxlYXNlIGNhbm5vdCBsYW5kIGluIHRoZSBpc29sYXRlZCBkZXNrdG9wIHVzZXIuIFRoZSBzYW5kYm94IGlzb2xhdGlvbiBhYm92ZSBpcyB1bnRvdWNoZWQuXG4jIE5vIGVncmVzcyBydWxlczogdGhlIHBlcnNvbidzIGRlc2t0b3AgaGFzIHRoZSBzYW1lIG5ldHdvcmsgYXMgdGhlIHBlcnNvbidzIHRlcm1pbmFsLlxuV09SS1NQQUNFX0hPTUU9XCIvaG9tZS8kV09SS1NQQUNFX1VTRVJcIlxuWyAtZCBcIiRXT1JLU1BBQ0VfSE9NRVwiIF0gfHwgZmFpbCBwZXJzb25hbC1kZXNrdG9wLXJ1bnRpbWVcbnJ1bnVzZXIgLXUgXCIkV09SS1NQQUNFX1VTRVJcIiAtLSBlbnYgLWkgSE9NRT1cIiRXT1JLU1BBQ0VfSE9NRVwiIFBBVEg9L3Vzci9iaW46L2JpbiBcXFxcXG4gIFwiJERFU0tUT1BfTElCL25vZGVcIiBcIiRERVNLVE9QX0xJQi9zZXNzaW9uLmNqc1wiIC0tcGVyc29uYWwgLS1jaGVjayB8fCBmYWlsIHBlcnNvbmFsLWRlc2t0b3AtcnVudGltZVxuIyBOZWdhdGl2ZSBmb3JtIG9uIHB1cnBvc2U6IGVhY2ggbW9kZSBtdXN0IFJFRlVTRSB0aGUgb3RoZXIncyBhY2NvdW50LiBBIHdvcmtlciB0aGF0XG4jIGFjY2VwdGVkIGVpdGhlciBpZGVudGl0eSB3b3VsZCBwYXNzIGV2ZXJ5IHBvc2l0aXZlIGNoZWNrIGFib3ZlLlxuaWYgcnVudXNlciAtdSBcIiRERVNLVE9QX1VTRVJcIiAtLSBlbnYgLWkgSE9NRT1cIiRERVNLVE9QX1JPT1RcIiBQQVRIPS91c3IvYmluOi9iaW4gXFxcXFxuICBcIiRERVNLVE9QX0xJQi9ub2RlXCIgXCIkREVTS1RPUF9MSUIvc2Vzc2lvbi5janNcIiAtLXBlcnNvbmFsIC0tY2hlY2sgPi9kZXYvbnVsbCAyPiYxOyB0aGVuXG4gIGZhaWwgcGVyc29uYWwtZGVza3RvcC1pZGVudGl0eVxuZmlcbmlmIHJ1bnVzZXIgLXUgXCIkV09SS1NQQUNFX1VTRVJcIiAtLSBlbnYgLWkgSE9NRT1cIiRXT1JLU1BBQ0VfSE9NRVwiIFBBVEg9L3Vzci9iaW46L2JpbiBcXFxcXG4gIFwiJERFU0tUT1BfTElCL25vZGVcIiBcIiRERVNLVE9QX0xJQi9zZXNzaW9uLmNqc1wiIC0tY2hlY2sgPi9kZXYvbnVsbCAyPiYxOyB0aGVuXG4gIGZhaWwgcGVyc29uYWwtZGVza3RvcC1pZGVudGl0eVxuZmlcbmNhdCA+IC9ldGMvc3lzdGVtZC9zeXN0ZW0vcGFwZXJjdXNwLXBlcnNvbmFsLWRlc2t0b3Auc29ja2V0IDw8VU5JVFxuW1VuaXRdXG5EZXNjcmlwdGlvbj1QYXBlcmN1c3AgcGVyc29uYWwgZGVza3RvcCBzZXNzaW9uIGFkbWlzc2lvblxuW1NvY2tldF1cbkxpc3RlblN0cmVhbT0vcnVuL3BhcGVyY3VzcC1wZXJzb25hbC1kZXNrdG9wL3Nlc3Npb24uc29ja1xuU29ja2V0VXNlcj1yb290XG5Tb2NrZXRHcm91cD0kU0VSVklDRV9VU0VSXG5Tb2NrZXRNb2RlPTA2NjBcbkRpcmVjdG9yeU1vZGU9MDc1NVxuQWNjZXB0PXllc1xuTWF4Q29ubmVjdGlvbnM9MTZcblJlbW92ZU9uU3RvcD15ZXNcbltJbnN0YWxsXVxuV2FudGVkQnk9bXVsdGktdXNlci50YXJnZXRcblVOSVRcbmNhdCA+IC9ldGMvc3lzdGVtZC9zeXN0ZW0vcGFwZXJjdXNwLXBlcnNvbmFsLWRlc2t0b3BALnNlcnZpY2UgPDxVTklUXG5bVW5pdF1cbkRlc2NyaXB0aW9uPVBhcGVyY3VzcCBwZXJzb25hbCBkZXNrdG9wIHNlc3Npb24gKGN1c3RvbWVyIHdvcmtzcGFjZSBhY2NvdW50KVxuQWZ0ZXI9cGFwZXJjdXNwLXdvcmtzcGFjZS5zZXJ2aWNlXG5CaW5kc1RvPXBhcGVyY3VzcC13b3Jrc3BhY2Uuc2VydmljZVxuSm9pbnNOYW1lc3BhY2VPZj1wYXBlcmN1c3Atd29ya3NwYWNlLnNlcnZpY2VcbltTZXJ2aWNlXVxuVHlwZT1leGVjXG5Vc2VyPSRXT1JLU1BBQ0VfVVNFUlxuV29ya2luZ0RpcmVjdG9yeT0kV09SS1NQQUNFX0hPTUVcbkVudmlyb25tZW50PUhPTUU9JFdPUktTUEFDRV9IT01FXG5FbnZpcm9ubWVudD1QQVRIPS91c3IvbG9jYWwvYmluOi91c3IvYmluOi9iaW5cbkVudmlyb25tZW50PUxBTkc9Qy5VVEYtOFxuRW52aXJvbm1lbnQ9U0hFTEw9L2Jpbi9iYXNoXG5FeGVjU3RhcnQ9JERFU0tUT1BfTElCL25vZGUgJERFU0tUT1BfTElCL3Nlc3Npb24uY2pzIC0tcGVyc29uYWwgLS1zdGRpb1xuU3RhbmRhcmRJbnB1dD1zb2NrZXRcblN0YW5kYXJkT3V0cHV0PWluaGVyaXRcblN0YW5kYXJkRXJyb3I9am91cm5hbFxuTm9OZXdQcml2aWxlZ2VzPXRydWVcblByaXZhdGVUbXA9dHJ1ZVxuUHJvdGVjdFN5c3RlbT1zdHJpY3RcblJlYWRXcml0ZVBhdGhzPSRXT1JLU1BBQ0VfSE9NRSAtJHtXT1JLU1BBQ0VfSE9TVF9EQVRBX1JPT1R9XG5JbmFjY2Vzc2libGVQYXRocz0tJHtXT1JLU1BBQ0VfSE9TVF9TVEFURV9ST09UfVxuUmVzdHJpY3RTVUlEU0dJRD10cnVlXG5Mb2NrUGVyc29uYWxpdHk9dHJ1ZVxuVU1hc2s9MDA3N1xuS2lsbE1vZGU9Y29udHJvbC1ncm91cFxuVGltZW91dFN0b3BTZWM9NXNcblVOSVRcbmNobW9kIDA2NDQgL2V0Yy9zeXN0ZW1kL3N5c3RlbS9wYXBlcmN1c3AtcGVyc29uYWwtZGVza3RvcC5zb2NrZXQgL2V0Yy9zeXN0ZW1kL3N5c3RlbS9wYXBlcmN1c3AtcGVyc29uYWwtZGVza3RvcEAuc2VydmljZVxuc3lzdGVtZC1hbmFseXplIHZlcmlmeSAvZXRjL3N5c3RlbWQvc3lzdGVtL3BhcGVyY3VzcC1wZXJzb25hbC1kZXNrdG9wLnNvY2tldCAvZXRjL3N5c3RlbWQvc3lzdGVtL3BhcGVyY3VzcC1wZXJzb25hbC1kZXNrdG9wQC5zZXJ2aWNlXG5zeXN0ZW1jdGwgZGFlbW9uLXJlbG9hZFxuc3lzdGVtY3RsIGVuYWJsZSAtLW5vdyBwYXBlcmN1c3AtcGVyc29uYWwtZGVza3RvcC5zb2NrZXRcbnN5c3RlbWN0bCBpcy1hY3RpdmUgLS1xdWlldCBwYXBlcmN1c3AtcGVyc29uYWwtZGVza3RvcC5zb2NrZXQgfHwgZmFpbCBwZXJzb25hbC1kZXNrdG9wLXNvY2tldFxuWyAtUyAvcnVuL3BhcGVyY3VzcC1wZXJzb25hbC1kZXNrdG9wL3Nlc3Npb24uc29jayBdIHx8IGZhaWwgcGVyc29uYWwtZGVza3RvcC1zb2NrZXRcblsgXCIkKHN0YXQgLWMgJWEgL3J1bi9wYXBlcmN1c3AtcGVyc29uYWwtZGVza3RvcC9zZXNzaW9uLnNvY2spXCIgPSA2NjAgXSB8fCBmYWlsIHBlcnNvbmFsLWRlc2t0b3Atc29ja2V0XG5waGFzZSBpbnN0YWxsLWRlc2t0b3AtcnVudGltZVxuXG4jIOKUgOKUgCBhdHRlc3QtcGFjayDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIBcbmNvbW1hbmQgLXYgb3BlbmJveCAgID4vZGV2L251bGwgMj4mMSB8fCBmYWlsIHgtc3RhY2tcbmNvbW1hbmQgLXYgeGRvdG9vbCAgID4vZGV2L251bGwgMj4mMSB8fCBmYWlsIHgtc3RhY2tcbmNvbW1hbmQgLXYgaW1wb3J0ICAgID4vZGV2L251bGwgMj4mMSB8fCBmYWlsIHgtc3RhY2tcbmNvbW1hbmQgLXYgYndyYXAgICAgID4vZGV2L251bGwgMj4mMSB8fCBmYWlsIHgtc3RhY2tcbmNvbW1hbmQgLXYgeHNldHJvb3QgID4vZGV2L251bGwgMj4mMSB8fCBmYWlsIHgtc3RhY2tcbiMgVGhlIG5hbWUgb3BlbmJveCdzIHN0b2NrIG1lbnUgZXhlY3V0ZXMsIG5vdCBtZXJlbHkgdGhlIHBhY2thZ2UgdGhhdCBzaG91bGQgcHJvdmlkZSBpdC5cbmNvbW1hbmQgLXYgeC10ZXJtaW5hbC1lbXVsYXRvciA+L2Rldi9udWxsIDI+JjEgfHwgZmFpbCB4LXN0YWNrXG5jb21tYW5kIC12IGRidXMtZGFlbW9uID4vZGV2L251bGwgMj4mMSB8fCBmYWlsIGExMXktc3RhY2tcblsgLWYgL3Vzci9saWIvYXQtc3BpMi1jb3JlL2F0LXNwaS1idXMtbGF1bmNoZXIgXSB8fCBbIC1mIC91c3IvbGliZXhlYy9hdC1zcGktYnVzLWxhdW5jaGVyIF0gfHwgZmFpbCBhMTF5LXN0YWNrXG5jb21tYW5kIC12IGdseGluZm8gPi9kZXYvbnVsbCAyPiYxIHx8IGZhaWwgZ2wtc3RhY2tcbiMgVGhlIGJpbmFyaWVzIHRoZSBob3N0ZWQgd29ya2VyJ3MgWEZDRSBzZXNzaW9uIGV4ZWNzLCBub3QgdGhlIHBhY2thZ2UgbmFtZXMuXG5mb3IgYmluIGluIHhmY2U0LXNlc3Npb24geGZ3bTQgeGZjZTQtcGFuZWwgeGZkZXNrdG9wIHhmc2V0dGluZ3NkIHhmY2U0LXRlcm1pbmFsIHRodW5hciBkYnVzLXJ1bi1zZXNzaW9uOyBkb1xuICBjb21tYW5kIC12IFwiJGJpblwiID4vZGV2L251bGwgMj4mMSB8fCBmYWlsIGRlc2t0b3AtZW52aXJvbm1lbnRcbmRvbmVcbiMgTW96aWxsYSdzIGJ1aWxkLCBub3QgdGhlIHN0dWI6IHRoZSBzdHViJ3MgL3Vzci9iaW4vZmlyZWZveCBvbmx5IGV4ZWNzIHNuYXAuXG5jb21tYW5kIC12IGZpcmVmb3ggPi9kZXYvbnVsbCAyPiYxIHx8IGZhaWwgYnJvd3NlclxuY2FzZSBcIiQoZHBrZy1xdWVyeSAtVyAtZj0nXFwke1ZlcnNpb259JyBmaXJlZm94KVwiIGluICpzbmFwKikgZmFpbCBicm93c2VyIDs7IGVzYWNcblxucHJpbnRmICcke1dPUktTUEFDRV9IT1NUX0RFU0tUT1BfUEFDS19BVFRFU1RBVElPTl9QUkVGSVh9JXNcXFxcbicgXCIkKGNhdCA8PEpTT04gfCB0ciAtZCAnXFxcXG4nXG57XCJjb250cmFjdFZlcnNpb25cIjpcIiR7V09SS1NQQUNFX0hPU1RfREVTS1RPUF9QQUNLX0NPTlRSQUNUX1ZFUlNJT059XCIsXG5cImhvc3RJZFwiOlwiJEhPU1RfSURcIixcImFjdGlvblwiOlwiJHtpbnB1dC5hY3Rpb259XCIsXG5cInVidW50dVZlcnNpb25cIjpcIiR7V09SS1NQQUNFX0hPU1RfQk9PVFNUUkFQX1VCVU5UVV9WRVJTSU9OfVwiLFxuXCJvYnNlcnZlZEF0XCI6XCIkKGRhdGUgLXUgKyVZLSVtLSVkVCVIOiVNOiVTWilcIixcInN0YXR1c1wiOlwiaGVhbHRoeVwiLFxuXCJrYXNtdm5jXCI6e1widmVyc2lvblwiOlwiJEtBU01fVkVSU0lPTlwiLFwic2hhMjU2XCI6XCIkS0FTTV9TSEFcIn0sXG5cImNoZWNrc1wiOlske1dPUktTUEFDRV9IT1NUX0RFU0tUT1BfUEFDS19DSEVDS1MubWFwKChjKSA9PiBge1wibmFtZVwiOlwiJHtjfVwiLFwib2tcIjp0cnVlfWApLmpvaW4oJywnKX1dfVxuSlNPTlxuKVwiXG5waGFzZSBhdHRlc3QtcGFja1xuYDtcblxuICByZXR1cm4geyBzY3JpcHQsIHBoYXNlczogV09SS1NQQUNFX0hPU1RfREVTS1RPUF9QQUNLX1BIQVNFUyB9O1xufVxuXG4vKipcbiAqIFBhcnNlIHRoZSBhdHRlc3RhdGlvbiBsaW5lIHRoZSBzY3JpcHQgcHJpbnRzLlxuICpcbiAqIFJlZnVzZXMgYW55dGhpbmcgdGhhdCBpcyBub3QgYSBDT01QTEVURSwgaGVhbHRoeSBhdHRlc3RhdGlvbiBuYW1pbmcgZXZlcnkgZGVjbGFyZWRcbiAqIGNoZWNrOiBhIHBhcnRpYWwgcnVuIHRoYXQgcHJpbnRlZCBhIHRydW5jYXRlZCBsaW5lIG11c3QgcmVhZCBhcyBhIGZhaWx1cmUsIG5vdCBhcyBhXG4gKiBwYWNrIHRoYXQgaW5zdGFsbGVkIHNsaWdodGx5IGxlc3MuIFRoZSBjaGVjayBsaXN0IGlzIGNvbXBhcmVkIGFzIGEgU0VUIGFnYWluc3RcbiAqIGBXT1JLU1BBQ0VfSE9TVF9ERVNLVE9QX1BBQ0tfQ0hFQ0tTYCwgc28gYWRkaW5nIGEgY2hlY2sgdG8gdGhlIGNvbnRyYWN0IHdpdGhvdXRcbiAqIHRlYWNoaW5nIHRoZSBzY3JpcHQgdG8gZW1pdCBpdCBmYWlscyBoZXJlIHJhdGhlciB0aGFuIHNpbGVudGx5IHdlYWtlbmluZyB0aGUgYmFyLlxuICovXG5leHBvcnQgZnVuY3Rpb24gcGFyc2VXb3Jrc3BhY2VIb3N0RGVza3RvcFBhY2tBdHRlc3RhdGlvbihcbiAgb3V0cHV0OiBzdHJpbmcsXG4pOiBXb3Jrc3BhY2VIb3N0RGVza3RvcFBhY2tBdHRlc3RhdGlvbiB7XG4gIGNvbnN0IGxpbmUgPSBvdXRwdXRcbiAgICAuc3BsaXQoJ1xcbicpXG4gICAgLm1hcCgobCkgPT4gbC50cmltKCkpXG4gICAgLmZpbmQoKGwpID0+IGwuc3RhcnRzV2l0aChXT1JLU1BBQ0VfSE9TVF9ERVNLVE9QX1BBQ0tfQVRURVNUQVRJT05fUFJFRklYKSk7XG4gIGlmICghbGluZSkge1xuICAgIHRocm93IG5ldyBFcnJvcignRGVza3RvcCBwYWNrIHByb2R1Y2VkIG5vIGF0dGVzdGF0aW9uIGxpbmUnKTtcbiAgfVxuICBsZXQgcGFyc2VkOiBXb3Jrc3BhY2VIb3N0RGVza3RvcFBhY2tBdHRlc3RhdGlvbjtcbiAgdHJ5IHtcbiAgICBwYXJzZWQgPSBKU09OLnBhcnNlKFxuICAgICAgbGluZS5zbGljZShXT1JLU1BBQ0VfSE9TVF9ERVNLVE9QX1BBQ0tfQVRURVNUQVRJT05fUFJFRklYLmxlbmd0aCksXG4gICAgKSBhcyBXb3Jrc3BhY2VIb3N0RGVza3RvcFBhY2tBdHRlc3RhdGlvbjtcbiAgfSBjYXRjaCB7XG4gICAgdGhyb3cgbmV3IEVycm9yKCdEZXNrdG9wIHBhY2sgYXR0ZXN0YXRpb24gaXMgbm90IHZhbGlkIEpTT04nKTtcbiAgfVxuICBpZiAocGFyc2VkLmNvbnRyYWN0VmVyc2lvbiAhPT0gV09SS1NQQUNFX0hPU1RfREVTS1RPUF9QQUNLX0NPTlRSQUNUX1ZFUlNJT04pIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoJ0Rlc2t0b3AgcGFjayBhdHRlc3RhdGlvbiByZXBvcnRzIGEgZGlmZmVyZW50IGNvbnRyYWN0IHZlcnNpb24nKTtcbiAgfVxuICBpZiAocGFyc2VkLnN0YXR1cyAhPT0gJ2hlYWx0aHknKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKGBEZXNrdG9wIHBhY2sgYXR0ZXN0YXRpb24gc3RhdHVzIGlzICR7U3RyaW5nKHBhcnNlZC5zdGF0dXMpfWApO1xuICB9XG4gIGFzc2VydFdvcmtzcGFjZUhvc3RTZWNyZXRJc29sYXRpb24ocGFyc2VkLCAnZGVza3RvcFBhY2suYXR0ZXN0YXRpb24nKTtcblxuICBjb25zdCBvYnNlcnZlZCA9IG5ldyBTZXQoKHBhcnNlZC5jaGVja3MgPz8gW10pLmZpbHRlcigoYykgPT4gYz8ub2sgPT09IHRydWUpLm1hcCgoYykgPT4gYy5uYW1lKSk7XG4gIGNvbnN0IG1pc3NpbmcgPSBXT1JLU1BBQ0VfSE9TVF9ERVNLVE9QX1BBQ0tfQ0hFQ0tTLmZpbHRlcigoYykgPT4gIW9ic2VydmVkLmhhcyhjKSk7XG4gIGlmIChtaXNzaW5nLmxlbmd0aCA+IDApIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoYERlc2t0b3AgcGFjayBhdHRlc3RhdGlvbiBpcyBtaXNzaW5nIGNoZWNrczogJHttaXNzaW5nLmpvaW4oJywgJyl9YCk7XG4gIH1cbiAgcmV0dXJuIHBhcnNlZDtcbn1cbiJdLCJmaWxlIjoiL0Bmcy9ob21lL21hcnNoLW9mZmljZS9wYXBlcmN1cGFpLXdvcmtzcGFjZS9wYXBlcmN1c3AvbGlicy9nZW5lcmljL2RlcGxveW1lbnQtZHJpdmVyL3NyYy93b3Jrc3BhY2UtaG9zdC1kZXNrdG9wLXBhY2sudHMifQ==

//# vitestCache=W3siZmlsZSI6IjEiLCJpZCI6IjEiLCJ1cmwiOiIyIiwiaW1wb3J0ZWRVcmxzIjoiMyIsIm1hcHBpbmdzIjpmYWxzZX0sIi9ob21lL21hcnNoLW9mZmljZS9wYXBlcmN1cGFpLXdvcmtzcGFjZS9wYXBlcmN1c3AvbGlicy9nZW5lcmljL2RlcGxveW1lbnQtZHJpdmVyL3NyYy93b3Jrc3BhY2UtaG9zdC1kZXNrdG9wLXBhY2sudHMiLCIvQGZzL2hvbWUvbWFyc2gtb2ZmaWNlL3BhcGVyY3VwYWktd29ya3NwYWNlL3BhcGVyY3VzcC9saWJzL2dlbmVyaWMvZGVwbG95bWVudC1kcml2ZXIvc3JjL3dvcmtzcGFjZS1ob3N0LWRlc2t0b3AtcGFjay50cyIsW11d
}}