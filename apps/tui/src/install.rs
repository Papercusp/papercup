//! Installed-artifact identity and freshness checks for `pui doctor`.
//!
//! The canonical installer builds the native binary and companion WASM from one
//! source generation, embeds that generation into both artifacts, and writes a
//! small manifest beside the WASM. Doctor verifies the manifest and hashes; it
//! never kills a process. On Linux it also detects long-lived zellij panes that
//! still map an older installed `pui` inode and prints pane/session-scoped
//! relaunch guidance.

use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

pub const INSTALL_COMMAND: &str = "./apps/tui/scripts/install-update.sh";
pub const BUILD_VERSION: &str = env!("CARGO_PKG_VERSION");
pub const BUILD_SHA: &str = env!("PUI_BUILD_SHA");
pub const BUILD_DIRTY: &str = env!("PUI_BUILD_DIRTY");
pub const BUILD_EPOCH: &str = env!("PUI_BUILD_EPOCH");
pub const EXPECTED_COMPANION_SHA256: &str = env!("PUI_COMPANION_SHA256");

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InstallManifest {
    pub schema_version: u32,
    pub source_sha: String,
    pub source_dirty: bool,
    pub built_at_epoch: u64,
    pub binary_path: String,
    pub binary_sha256: String,
    pub companion_path: String,
    pub companion_sha256: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BuildStamp {
    pub version: String,
    pub source_sha: String,
    pub source_dirty: Option<bool>,
    pub built_at_epoch: Option<u64>,
    pub companion_sha256: Option<String>,
}

impl BuildStamp {
    pub fn embedded() -> Self {
        Self {
            version: BUILD_VERSION.to_string(),
            source_sha: BUILD_SHA.to_string(),
            source_dirty: match BUILD_DIRTY {
                "0" => Some(false),
                "1" => Some(true),
                _ => None,
            },
            built_at_epoch: BUILD_EPOCH.parse().ok(),
            companion_sha256: (EXPECTED_COMPANION_SHA256 != "unknown")
                .then(|| EXPECTED_COMPANION_SHA256.to_string()),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LocalInstallCheck {
    pub manifest_path: PathBuf,
    pub manifest: InstallManifest,
    pub binary_sha256: String,
    pub companion_sha256: String,
    pub binary_modified_epoch: Option<u64>,
    pub companion_modified_epoch: Option<u64>,
    pub warnings: Vec<String>,
    pub problems: Vec<String>,
}

impl LocalInstallCheck {
    pub fn is_ok(&self) -> bool {
        self.problems.is_empty()
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StalePane {
    pub pid: u32,
    pub session: Option<String>,
    pub command: String,
}

impl StalePane {
    pub fn relaunch_guidance(&self) -> String {
        match self.session.as_deref() {
            Some("pui-wb") => format!(
                "pid {} is the stale pui-wb pane; close that workbench terminal, then run `pui workbench`. If the exact app-managed session survives, run `zellij kill-session pui-wb` before reopening (no other session is touched).",
                self.pid
            ),
            Some("pui-dock") => format!(
                "pid {} is the stale pui-dock pane; close that dock terminal, then run `pui chat`. If the exact app-managed session survives, run `zellij kill-session pui-dock` before reopening (no other session is touched).",
                self.pid
            ),
            Some(session) => format!(
                "pid {} is stale inside zellij session {session:?}; exit and reopen only this pui pane (`{}`), and do not kill the enclosing session.",
                self.pid, self.command
            ),
            None => format!(
                "pid {} is a stale in-zellij pui process (`{}`); exit and reopen only that pane. The session name was unavailable, so do not run a session-wide kill command.",
                self.pid, self.command
            ),
        }
    }
}

fn default_manifest_path() -> Result<PathBuf> {
    if let Some(path) = std::env::var_os("PUI_INSTALL_MANIFEST") {
        return Ok(PathBuf::from(path));
    }
    Ok(dirs::home_dir()
        .context("resolve home directory for pui install manifest")?
        .join(".papercusp")
        .join("pui-install.json"))
}

fn sha256_file(path: &Path) -> Result<String> {
    let mut file = fs::File::open(path).with_context(|| format!("open {}", path.display()))?;
    let mut hasher = Sha256::new();
    let mut buf = [0_u8; 64 * 1024];
    loop {
        let read = file
            .read(&mut buf)
            .with_context(|| format!("read {}", path.display()))?;
        if read == 0 {
            break;
        }
        hasher.update(&buf[..read]);
    }
    Ok(format!("{:x}", hasher.finalize()))
}

fn modified_epoch(path: &Path) -> Option<u64> {
    fs::metadata(path)
        .ok()?
        .modified()
        .ok()?
        .duration_since(UNIX_EPOCH)
        .ok()
        .map(|duration| duration.as_secs())
}

fn same_path(a: &Path, b: &Path) -> bool {
    let normalize = |path: &Path| fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
    normalize(a) == normalize(b)
}

pub fn inspect_local_install() -> Result<LocalInstallCheck> {
    let manifest_path = default_manifest_path()?;
    let current_exe = std::env::current_exe().context("resolve running pui executable")?;
    inspect_paths(&manifest_path, &current_exe, &BuildStamp::embedded())
}

pub fn inspect_paths(
    manifest_path: &Path,
    current_exe: &Path,
    build: &BuildStamp,
) -> Result<LocalInstallCheck> {
    let bytes = fs::read(manifest_path)
        .with_context(|| format!("read install manifest {}", manifest_path.display()))?;
    let manifest: InstallManifest = serde_json::from_slice(&bytes)
        .with_context(|| format!("decode install manifest {}", manifest_path.display()))?;
    if manifest.schema_version != 1 {
        bail!(
            "unsupported pui install manifest schema {}",
            manifest.schema_version
        );
    }

    let binary_path = PathBuf::from(&manifest.binary_path);
    let companion_path = PathBuf::from(&manifest.companion_path);
    let binary_sha256 = sha256_file(current_exe)?;
    let companion_sha256 = sha256_file(&companion_path)?;
    let mut warnings = Vec::new();
    let mut problems = Vec::new();

    if !same_path(current_exe, &binary_path) {
        problems.push(format!(
            "running binary {} is not the installed artifact {}",
            current_exe.display(),
            binary_path.display()
        ));
    }
    if binary_sha256 != manifest.binary_sha256 {
        problems.push("running binary hash does not match pui-install.json".to_string());
    }
    if companion_sha256 != manifest.companion_sha256 {
        problems.push("installed companion WASM hash does not match pui-install.json".to_string());
    }
    if build.source_sha != manifest.source_sha {
        problems.push(format!(
            "binary embeds source {} but the install generation records {}",
            build.source_sha, manifest.source_sha
        ));
    }
    if let Some(expected) = build.companion_sha256.as_deref() {
        if expected != companion_sha256 {
            problems.push("binary embeds a different companion WASM hash".to_string());
        }
    } else {
        warnings.push(format!(
            "binary was not built by the canonical installer; companion identity is unknown (run {INSTALL_COMMAND})"
        ));
    }
    if let Some(epoch) = build.built_at_epoch {
        if epoch != manifest.built_at_epoch {
            problems.push(format!(
                "binary build epoch {epoch} differs from install generation {}",
                manifest.built_at_epoch
            ));
        }
    }
    if let Some(dirty) = build.source_dirty {
        if dirty != manifest.source_dirty {
            problems.push("binary dirty-source stamp differs from install manifest".to_string());
        }
    }
    if manifest.source_dirty {
        warnings.push(
            "install generation includes uncommitted pui/companion source; final shipment must reinstall from the exact committed staging SHA"
                .to_string(),
        );
    }

    let binary_modified_epoch = modified_epoch(&binary_path);
    let companion_modified_epoch = modified_epoch(&companion_path);
    if let (Some(binary), Some(companion)) = (binary_modified_epoch, companion_modified_epoch) {
        if binary.abs_diff(companion) > 3600 {
            problems.push(format!(
                "binary and companion mtimes differ by {}s; they are not a plausible single install generation",
                binary.abs_diff(companion)
            ));
        }
    }

    Ok(LocalInstallCheck {
        manifest_path: manifest_path.to_path_buf(),
        manifest,
        binary_sha256,
        companion_sha256,
        binary_modified_epoch,
        companion_modified_epoch,
        warnings,
        problems,
    })
}

pub fn operator_source_relation(operator_sha: Option<&str>) -> String {
    match operator_sha {
        Some(sha) if sha == BUILD_SHA => "same source generation as the selected operator".into(),
        Some(sha) => format!(
            "different source generation (pui {}, selected operator {sha}); valid only when intentionally comparing staging/release planes",
            BUILD_SHA
        ),
        None => "selected operator did not expose a source SHA".into(),
    }
}

pub fn age_label(epoch: Option<u64>) -> String {
    let Some(epoch) = epoch else {
        return "mtime unavailable".to_string();
    };
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    let age = now.saturating_sub(epoch);
    if age < 60 {
        format!("{age}s old")
    } else if age < 3600 {
        format!("{}m old", age / 60)
    } else if age < 86_400 {
        format!("{}h old", age / 3600)
    } else {
        format!("{}d old", age / 86_400)
    }
}

#[cfg(target_os = "linux")]
fn read_nul_fields(path: &Path) -> Option<Vec<String>> {
    let bytes = fs::read(path).ok()?;
    Some(
        bytes
            .split(|byte| *byte == 0)
            .filter(|field| !field.is_empty())
            .map(|field| String::from_utf8_lossy(field).into_owned())
            .collect(),
    )
}

#[cfg(target_os = "linux")]
fn env_value(fields: &[String], key: &str) -> Option<String> {
    fields
        .iter()
        .find_map(|field| field.strip_prefix(&format!("{key}=")).map(str::to_string))
}

#[cfg(target_os = "linux")]
fn trim_deleted_suffix(path: &Path) -> PathBuf {
    let value = path.to_string_lossy();
    PathBuf::from(value.strip_suffix(" (deleted)").unwrap_or(&value))
}

/// Find in-zellij pui processes still mapping a replaced installed binary.
/// Failures to inspect individual processes are ignored (they may exit while
/// `/proc` is being walked, or belong to another user).
#[cfg(target_os = "linux")]
pub fn stale_zellij_panes(installed_binary: &Path) -> Vec<StalePane> {
    use std::os::unix::fs::MetadataExt;

    let Ok(installed_meta) = fs::metadata(installed_binary) else {
        return Vec::new();
    };
    let mut panes = Vec::new();
    let Ok(entries) = fs::read_dir("/proc") else {
        return panes;
    };
    for entry in entries.flatten() {
        let Some(pid) = entry
            .file_name()
            .to_str()
            .and_then(|value| value.parse::<u32>().ok())
        else {
            continue;
        };
        if pid == std::process::id() {
            continue;
        }
        let process = entry.path();
        let Ok(exe_target) = fs::read_link(process.join("exe")) else {
            continue;
        };
        if trim_deleted_suffix(&exe_target) != installed_binary {
            continue;
        }
        let Ok(process_meta) = fs::metadata(process.join("exe")) else {
            continue;
        };
        if process_meta.dev() == installed_meta.dev() && process_meta.ino() == installed_meta.ino()
        {
            continue;
        }
        let Some(environment) = read_nul_fields(&process.join("environ")) else {
            continue;
        };
        if env_value(&environment, "ZELLIJ").is_none() {
            continue;
        }
        let command = read_nul_fields(&process.join("cmdline"))
            .map(|parts| parts.join(" "))
            .filter(|value| !value.is_empty())
            .unwrap_or_else(|| "pui".to_string());
        panes.push(StalePane {
            pid,
            session: env_value(&environment, "ZELLIJ_SESSION_NAME"),
            command,
        });
    }
    panes.sort_by_key(|pane| pane.pid);
    panes
}

#[cfg(not(target_os = "linux"))]
pub fn stale_zellij_panes(_installed_binary: &Path) -> Vec<StalePane> {
    Vec::new()
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    fn stamp(source_sha: &str, epoch: u64, companion_sha256: &str) -> BuildStamp {
        BuildStamp {
            version: "0.1.0".into(),
            source_sha: source_sha.into(),
            source_dirty: Some(false),
            built_at_epoch: Some(epoch),
            companion_sha256: Some(companion_sha256.into()),
        }
    }

    #[test]
    fn manifest_binds_binary_and_companion_to_one_generation() {
        let dir = tempdir().unwrap();
        let binary = dir.path().join("pui");
        let companion = dir.path().join("pui-companion.wasm");
        let manifest_path = dir.path().join("pui-install.json");
        fs::write(&binary, b"binary-v1").unwrap();
        fs::write(&companion, b"wasm-v1").unwrap();
        let binary_sha = sha256_file(&binary).unwrap();
        let companion_sha = sha256_file(&companion).unwrap();
        let manifest = InstallManifest {
            schema_version: 1,
            source_sha: "abc123".into(),
            source_dirty: false,
            built_at_epoch: 123,
            binary_path: binary.display().to_string(),
            binary_sha256: binary_sha,
            companion_path: companion.display().to_string(),
            companion_sha256: companion_sha.clone(),
        };
        fs::write(&manifest_path, serde_json::to_vec(&manifest).unwrap()).unwrap();

        let check = inspect_paths(
            &manifest_path,
            &binary,
            &stamp("abc123", 123, &companion_sha),
        )
        .unwrap();
        assert!(check.is_ok(), "{:?}", check.problems);
        assert!(check.warnings.is_empty());

        fs::write(&companion, b"wasm-v2").unwrap();
        let stale = inspect_paths(
            &manifest_path,
            &binary,
            &stamp("abc123", 123, &companion_sha),
        )
        .unwrap();
        assert!(stale
            .problems
            .iter()
            .any(|problem| problem.contains("companion WASM hash")));
    }

    #[test]
    fn relaunch_guidance_is_scoped_and_never_blanket_kills() {
        let workbench = StalePane {
            pid: 7,
            session: Some("pui-wb".into()),
            command: "pui hud".into(),
        }
        .relaunch_guidance();
        assert!(workbench.contains("kill-session pui-wb"));
        assert!(workbench.contains("no other session is touched"));

        let foreign = StalePane {
            pid: 8,
            session: Some("my-important-shells".into()),
            command: "pui hud".into(),
        }
        .relaunch_guidance();
        assert!(foreign.contains("do not kill the enclosing session"));
        assert!(!foreign.contains("kill-session"));
    }

    #[test]
    fn operator_relation_is_explicit_about_plane_drift() {
        assert!(operator_source_relation(Some(BUILD_SHA)).starts_with("same source"));
        assert!(operator_source_relation(Some("other")).contains("different source generation"));
        assert!(operator_source_relation(None).contains("did not expose"));
    }
}
