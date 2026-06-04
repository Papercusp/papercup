//! First-run tutorial "seen" marker (P9). Whether the welcome overlay has been
//! dismissed is **per-device first-run state** — it should NOT sync across
//! machines (each device's first run is its own), and the TUI is IPC-only with
//! no direct PG, so a small local marker file is the right home (PG-backed
//! cross-device *view-state* is the separate, deferred P10/D-002). Best-effort:
//! a missing/unwritable marker just means the tutorial shows again.

use std::path::{Path, PathBuf};

fn base_dir() -> Option<PathBuf> {
    dirs::home_dir().map(|h| h.join(".papercusp"))
}

fn marker(base: &Path) -> PathBuf {
    base.join("pui-tutorial-seen")
}

/// Has the tutorial been dismissed on this device?
pub fn seen() -> bool {
    base_dir().map(|d| seen_at(&d)).unwrap_or(false)
}

/// Record that the tutorial has been dismissed (best-effort).
pub fn mark_seen() {
    if let Some(d) = base_dir() {
        mark_seen_at(&d);
    }
}

fn seen_at(base: &Path) -> bool {
    marker(base).exists()
}

fn mark_seen_at(base: &Path) {
    let _ = std::fs::create_dir_all(base);
    let _ = std::fs::write(marker(base), b"1");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn marker_roundtrip() {
        let d = tempfile::tempdir().unwrap();
        assert!(!seen_at(d.path()));
        mark_seen_at(d.path());
        assert!(seen_at(d.path()));
    }
}
