//! Canonical PUI ↔ operator/store rendezvous and stable-session stamps.
//!
//! A stable zellij name is safe only when attach means "resume the same data
//! plane". Each create stamps the selected endpoint + server workspace/store
//! identity; each attach compares before zellij is invoked and refuses drift.

use crate::client::BackendIdentity;
use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SessionStamp {
    schema_version: u32,
    session: String,
    identity: BackendIdentity,
}

fn stamp_path(session: &str) -> Result<PathBuf> {
    let home = dirs::home_dir().context("no home dir")?;
    Ok(home
        .join(".papercusp")
        .join(format!("{session}.identity.json")))
}

/// Make every zellij/layout child inherit the already-normalized endpoint.
/// Setting BOTH variables prevents a helper that understands only the shared
/// seam from rediscovering a different operator than the PUI-specific seam.
pub fn inherited_operator_env(identity: &BackendIdentity) -> [(&'static str, String); 2] {
    [
        ("PUI_OPERATOR", identity.endpoint.clone()),
        ("PAPERCUSP_OPERATOR_URL", identity.endpoint.clone()),
    ]
}

pub fn inherit(identity: &BackendIdentity) {
    for (name, value) in inherited_operator_env(identity) {
        std::env::set_var(name, value);
    }
}

/// Validate a live stable session, or stamp a newly-created one.
pub fn bind(session: &str, identity: &BackendIdentity, live: bool) -> Result<()> {
    bind_at(&stamp_path(session)?, session, identity, live)
}

pub fn clear(session: &str) {
    if let Ok(path) = stamp_path(session) {
        let _ = std::fs::remove_file(path);
    }
}

fn bind_at(path: &Path, session: &str, identity: &BackendIdentity, live: bool) -> Result<()> {
    if live {
        let bytes = std::fs::read(path).with_context(|| {
            format!(
                "refusing to attach to {session}: its operator identity stamp is missing ({}); close the session with `zellij kill-session {session}` or relaunch with the original PUI_OPERATOR",
                path.display()
            )
        })?;
        let prior: SessionStamp = serde_json::from_slice(&bytes).with_context(|| {
            format!(
                "refusing to attach to {session}: its operator identity stamp is unreadable ({}); close the session with `zellij kill-session {session}`",
                path.display()
            )
        })?;
        if prior.session != session || !prior.identity.same_rendezvous(identity) {
            anyhow::bail!(
                "refusing to attach to {session}: running session is bound to [{}], but this launch selected [{}]. Close it with `zellij kill-session {session}` or relaunch with matching PUI_OPERATOR/PAPERCUSP_OPERATOR_URL",
                prior.identity.compact(),
                identity.compact()
            );
        }
        return Ok(());
    }

    let parent = path.parent().context("identity stamp has no parent")?;
    std::fs::create_dir_all(parent)
        .with_context(|| format!("create identity stamp dir {}", parent.display()))?;
    let stamp = SessionStamp {
        schema_version: 1,
        session: session.to_string(),
        identity: identity.clone(),
    };
    let bytes = serde_json::to_vec_pretty(&stamp).context("encode PUI session identity")?;
    let tmp = path.with_extension(format!("json.tmp-{}", std::process::id()));
    std::fs::write(&tmp, bytes)
        .with_context(|| format!("write identity stamp {}", tmp.display()))?;
    std::fs::rename(&tmp, path)
        .with_context(|| format!("publish identity stamp {}", path.display()))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::client::{AgentChatIdentity, BuildIdentity, StoreIdentity};

    fn ident(endpoint: &str, workspace: &str, store: &str) -> BackendIdentity {
        BackendIdentity {
            schema_version: 1,
            endpoint: endpoint.into(),
            selection_source: "test".into(),
            transport: "http".into(),
            workspace_id: workspace.into(),
            store: StoreIdentity {
                id: store.into(),
                target: "postgresql://127.0.0.1:5432/papercusp".into(),
                source: "test".into(),
            },
            build: BuildIdentity {
                version: "1.0.0".into(),
                sha: Some("abc".into()),
            },
            agent_chat: AgentChatIdentity {
                scope: format!("workspace:{workspace}"),
                route: "/api/agent-chats".into(),
            },
        }
    }

    #[test]
    fn fresh_session_stamps_and_matching_attach_passes() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("pui-wb.identity.json");
        let current = ident("http://127.0.0.1:3070", "ws", "pg-a");
        bind_at(&path, "pui-wb", &current, false).unwrap();
        bind_at(&path, "pui-wb", &current, true).unwrap();
        let text = std::fs::read_to_string(path).unwrap();
        assert!(text.contains("http://127.0.0.1:3070"));
        assert!(text.contains("pg-a"));
    }

    #[test]
    fn every_zellij_child_receives_both_canonical_endpoint_seams() {
        let current = ident("http://127.0.0.1:3170", "ws", "pg-a");
        assert_eq!(
            inherited_operator_env(&current),
            [
                ("PUI_OPERATOR", "http://127.0.0.1:3170".to_string()),
                (
                    "PAPERCUSP_OPERATOR_URL",
                    "http://127.0.0.1:3170".to_string()
                ),
            ]
        );
    }

    #[test]
    fn stable_attach_refuses_cross_operator_or_store_mismatch() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("pui-wb.identity.json");
        bind_at(
            &path,
            "pui-wb",
            &ident("http://127.0.0.1:3070", "ws", "pg-a"),
            false,
        )
        .unwrap();
        let err = bind_at(
            &path,
            "pui-wb",
            &ident("http://127.0.0.1:3170", "ws", "pg-b"),
            true,
        )
        .unwrap_err()
        .to_string();
        assert!(err.contains("refusing to attach to pui-wb"), "{err}");
        assert!(err.contains("zellij kill-session pui-wb"), "{err}");
        assert!(err.contains("3070") && err.contains("3170"), "{err}");
    }

    #[test]
    fn live_session_without_a_valid_stamp_fails_closed() {
        let dir = tempfile::tempdir().unwrap();
        let missing = dir.path().join("missing.json");
        assert!(bind_at(
            &missing,
            "pui-wb",
            &ident("http://127.0.0.1:3070", "ws", "pg-a"),
            true
        )
        .unwrap_err()
        .to_string()
        .contains("stamp is missing"));
        std::fs::write(&missing, "not json").unwrap();
        assert!(bind_at(
            &missing,
            "pui-wb",
            &ident("http://127.0.0.1:3070", "ws", "pg-a"),
            true
        )
        .unwrap_err()
        .to_string()
        .contains("stamp is unreadable"));
    }
}
