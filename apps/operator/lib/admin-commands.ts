import 'server-only';

/**
 * Server-side allowlist for /admin ops dashboard.
 *
 * Client only sends a `cmd` id. Server resolves to the actual shell
 * command. Adding a new entry here is the only way to expose a
 * command — there's no path that lets the client pass raw shell.
 */

export interface AdminCommand {
  id: string;
  label: string;
  section: 'building' | 'running';
  description?: string;
  command: string;
  cwd?: string;
}

const SSH_MAC = 'ssh -i /home/marsh-office/.ssh/papercup-vm-mac -p 2222 -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null aviweiss@127.0.0.1';
const SSH_WIN = 'ssh -i /home/marsh-office/.ssh/papercup-vm-win -p 2223 -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null User@127.0.0.1';

const PAPERCUSP_DESKTOP = '/home/marsh-office/papercupai-workspace/papercusp-desktop';
const PAPERCUP_REPO = '/home/marsh-office/papercupai-workspace/papercup';

export const ADMIN_COMMANDS: AdminCommand[] = [
  // ── Building ─────────────────────────────────────────────
  {
    id: 'build-linux-prod',
    label: 'Linux Prod Build',
    section: 'building',
    description: 'Builds the Linux .deb / .rpm desktop bundles on this host.',
    command: 'npm run tauri:build 2>&1',
    cwd: PAPERCUSP_DESKTOP,
  },
  {
    id: 'build-mac-prod',
    label: 'Mac Prod Build',
    section: 'building',
    description: 'Builds the macOS .dmg inside the Mac VM. ~30–45 min.',
    command: `${SSH_MAC} 'bash -lc "export NVM_DIR=\\"\\$HOME/.nvm\\" && [ -s \\"\\$NVM_DIR/nvm.sh\\" ] && . \\"\\$NVM_DIR/nvm.sh\\" && nvm use 22 >/dev/null && cd ~/papercusp-desktop && npm install --legacy-peer-deps && npm run tauri:build"' 2>&1`,
  },
  {
    id: 'build-windows-prod',
    label: 'Windows Prod Build',
    section: 'building',
    description: 'Builds the Windows .msi / .exe inside the Windows VM. ~30–45 min.',
    command: `${SSH_WIN} "powershell -NoProfile -Command \\"& { . \\$HOME\\\\AppData\\\\Roaming\\\\nvm\\\\v22.21.1\\\\nvm.exe use 22.21.1 ; cd \\$HOME\\\\papercusp-desktop ; npm install --legacy-peer-deps ; npm run tauri:build }\\"" 2>&1`,
  },
  {
    id: 'rebuild-3070',
    label: 'Rebuild 3070 webapp',
    section: 'building',
    description: 'Runs bin/prod: builds @papercusp/web (prod target) + restarts the standalone server on :3070. Survives this stream — server keeps running after you Stop.',
    command: 'bin/prod 2>&1',
    cwd: PAPERCUP_REPO,
  },

  // ── Running ──────────────────────────────────────────────
  {
    id: 'install-linux-deb',
    label: 'Install + launch Linux .deb',
    section: 'running',
    description: 'Installs the latest local .deb (requires NOPASSWD sudo for dpkg) and launches the installed binary.',
    command: `set -e; DEB="${PAPERCUSP_DESKTOP}/src-tauri/target/release/bundle/deb/Papercusp_0.0.1_amd64.deb"; echo "==> installing $DEB"; sudo -n dpkg -i "$DEB" 2>&1; echo "==> launching Papercusp"; setsid /usr/bin/papercusp >/dev/null 2>&1 < /dev/null & echo "launched pid $!"`,
  },
  {
    id: 'install-mac-dmg',
    label: 'Install + launch Mac .dmg',
    section: 'running',
    description: 'Mounts the DMG, copies Papercusp.app to /Applications, strips quarantine, and launches it in the Mac VM.',
    command: `${SSH_MAC} 'bash -lc "set -e; DMG=~/Papercusp_0.0.1_x86_64.dmg; echo \\"==> mounting $DMG\\"; hdiutil attach \\"$DMG\\" -nobrowse; echo \\"==> copying to /Applications\\"; rm -rf /Applications/Papercusp.app; cp -R /Volumes/Papercusp/Papercusp.app /Applications/; hdiutil detach /Volumes/Papercusp; xattr -dr com.apple.quarantine /Applications/Papercusp.app; echo \\"==> launching\\"; open /Applications/Papercusp.app; echo done"' 2>&1`,
  },
  {
    id: 'install-windows-msi',
    label: 'Install + launch Windows .msi',
    section: 'running',
    description: 'Runs msiexec /i silent + launches Papercusp.exe in the Windows VM.',
    command: `${SSH_WIN} "powershell -NoProfile -Command \\"& { \\$msi = 'C:\\\\Users\\\\User\\\\papercusp-desktop\\\\src-tauri\\\\target\\\\release\\\\bundle\\\\msi\\\\Papercusp_0.0.1_x64_en-US.msi' ; Write-Host '==> installing' \\$msi ; Start-Process -Wait msiexec -ArgumentList '/i', \\$msi, '/quiet' ; Write-Host '==> launching' ; Start-Process 'C:\\\\Program Files\\\\Papercusp\\\\Papercusp.exe' ; Write-Host 'done' }\\"" 2>&1`,
  },
  {
    id: 'launch-linux-dev',
    label: 'Launch Linux Desktop DEV',
    section: 'running',
    description: 'Starts `npm run dev` in papercusp-desktop (Tauri dev mode against :3055). Server keeps running after you Stop the stream.',
    command: `setsid bash -c 'cd ${PAPERCUSP_DESKTOP} && npm run dev' </dev/null >/tmp/papercusp-desktop-dev.log 2>&1 & disown; echo "==> launched pid $!"; echo "==> tailing /tmp/papercusp-desktop-dev.log"; sleep 1; tail -n+1 -F /tmp/papercusp-desktop-dev.log`,
  },
  {
    id: 'restart-3055',
    label: 'Restart 3055 dev server',
    section: 'running',
    description: 'Restarts the operator dev server (papercup-dev systemd user unit) on :3055. The /admin page itself will go offline for ~30s while Next rebuilds.',
    command: 'bin/dev 2>&1',
    cwd: PAPERCUP_REPO,
  },
];

export function getCommand(id: string): AdminCommand | null {
  return ADMIN_COMMANDS.find((c) => c.id === id) ?? null;
}

export function listCommands(): AdminCommand[] {
  return ADMIN_COMMANDS;
}
