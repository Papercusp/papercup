# Mac build VM — QMP recovery from a wedged boot, and the launcher split-brain
URL: /internal/docs/agent-insights/mac-vm-qmp-recovery

When SSH :2222 is dead and papercup-vm-mac.service crash-loops on SPICE :5930, an orphaned durable qemu is usually parked at the OpenCore boot picker. Recover with QMP screendump + send-key — never pkill. Plus the boot-sonoma.sh vs boot-sonoma-durable.sh split-brain that caused 5,708 restart failures.

## Symptom

* `ssh -i ~/.ssh/papercup-vm-mac -p 2222 aviweiss@127.0.0.1` times out during banner exchange.
* `systemctl --user status papercup-vm-mac.service` shows a restart loop with
  `Spice: …reds_init_socket: binding socket to 127.0.0.1:5930 failed` →
  `failed to initialize spice server` (the 2026-06-11 incident had racked up
  **5,708** scheduled restarts).
* `ss -ltnp | grep 5930` shows a *different, older* `qemu-system-x86_64` pid
  holding SPICE :5930 and SSH-forward :2222.

## What actually happened

Two launchers exist in `~/macos-vm/OSX-KVM/` and they are NOT the same:

|                 | `boot-sonoma.sh` (old service ExecStart)                                   | `boot-sonoma-durable.sh`                          |
| --------------- | -------------------------------------------------------------------------- | ------------------------------------------------- |
| RAM             | 16 GB                                                                      | 32 GB                                             |
| Installer media | **attaches `BaseSystem.img`** (since 2026-06-09 a macOS *Tahoe* installer) | none                                              |
| Process model   | foreground (`Type=simple`)                                                 | `setsid nohup` fork + `qemu.pid` (`Type=forking`) |
| Control socket  | SPICE only                                                                 | **QMP at `./qmp.sock`** + `logs/qemu-current.log` |

The live VM had been started by hand via the **durable** script; the systemd
unit kept trying to start the **old** script against it and could never bind
SPICE. Meanwhile the durable guest had rebooted into the **OpenCore boot
picker** and sat there for 33 hours — picker wedge signature: **\~100% of one
core, tiny RSS (\~140 MB despite -m 32768), zero writes to `mac_hdd_ng.img`**.

## Recovery (no data loss — do NOT pkill)

QMP on the durable launcher's socket. Each command is one JSON line; read the
greeting, send `qmp_capabilities`, then drive:

```python
import json, socket
s = socket.socket(socket.AF_UNIX); s.connect('/home/marsh-office/macos-vm/OSX-KVM/qmp.sock')
f = s.makefile('rw'); f.readline()
def cmd(c): f.write(json.dumps(c)+'\n'); f.flush(); return f.readline()
cmd({"execute":"qmp_capabilities"})
cmd({"execute":"screendump","arguments":{"filename":"/tmp/macvm-screen.ppm"}})  # see the console
# OpenCore picker showing EFI + Macintosh HD, EFI focused → move right, enter:
cmd({"execute":"send-key","arguments":{"keys":[{"type":"qcode","data":"right"}]}})
cmd({"execute":"send-key","arguments":{"keys":[{"type":"qcode","data":"ret"}]}})
```

`convert /tmp/macvm-screen.ppm x.png` to view. SSH came up \~2 min after the
send-key. A graceful shutdown is `{"execute":"system_powerdown"}` on the same
socket.

**Never** `pkill -f qemu` / `pkill -f papercusp` patterns here — the box runs
several qemu VMs and desktop instances (see the 2026-06-11 broadcast about a
pkill killing every peer's Tauri instance). Kill by exact pid from
`qemu.pid` only, and only as a last resort.

## The durable fixes (so this doesn't recur)

1. `papercup-vm-mac.service` now runs `boot-sonoma-durable.sh`
   (`Type=forking` + `PIDFile=qemu.pid` + QMP `ExecStop`). The old
   `boot-sonoma.sh` is manual-installer-use only.
2. **The wedge's real mechanism (P-001, FIXED 2026-06-11):** `ScanPolicy=0`
   listed OpenCore's own ESP as a boot entry named "EFI" — and as the FIRST
   entry it was the *default*, so `Timeout=2` auto-booted OpenCore into
   itself in an infinite EFI loop (\~100% CPU, black/parked picker, zero
   disk writes). Fixed by `Misc.Security.ScanPolicy = 0x10303`
   (FS\_LOCK|DEVICE\_LOCK + APFS|HFS + SATA) in `EFI/OC/config.plist` on
   `OpenCore.qcow2` — the ESP is never scanned, `Macintosh HD` is the only
   entry, and a cold boot reaches sshd unattended. Edit the plist via
   `qemu-nbd --connect=/dev/nbd0 OpenCore/OpenCore.qcow2` + mount `p1`
   (qemu must be DOWN). A picker-era NVRAM default (ctrl+enter) does NOT
   stick reliably here — fix ScanPolicy instead.

## GUI-session auth (loginwindow) on this VM — passwords DIVERGE by layer

CORRECTED 2026-06-11: the original "secure-token wedge" diagnosis was
wrong. The GUI credential path (loginwindow / lock screen) simply has a
**different password** (`avraham`) from the PAM path that ssh/sudo accept
(`aviweiss`). A day of "loginwindow rejects the correct password" was a
wrong password; the owner supplied the GUI one and the locked session
unlocked first try. To unlock for agent verification: wake the display
with a QMP `send-key` (`shift`), type the GUI password char-by-char via
`send-key`, send `ret`, then `screendump` for pixels. If you hit auth
errors from `sysadminctl` / kcpassword anyway, suspect a wrong-password
loop before any secure-token theory — verify which password each auth
layer actually holds.

## Related

* VM inventory, ports, disk discipline: [build-system/vms](/internal/docs/build-system/vms)
* `diskutil apfs resizeContainer disk1s2 0` fails with "must be different
  size" after a host-side qcow2 grow until you first run
  `sudo diskutil repairDisk disk1` (the GPT still carries the old size).
  That sequence took the VM from 7 GiB free to 60 GiB on 2026-06-11.
