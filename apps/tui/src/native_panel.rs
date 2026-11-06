//! Read bridge for OS-native Workbench widgets. Reuse PUI's selected-operator
//! discovery, IPC/HTTP transports and canonical GUI queries rather than adding
//! another bearer store, local HTTP service or private search implementation.

use anyhow::{Context, Result};
use serde::Deserialize;
use serde_json::{json, Map, Value};
use std::io::Read;
use std::time::Duration;

const MAX_REQUEST_BYTES: u64 = 64 * 1024;

#[derive(Debug, Deserialize)]
pub enum ReadModel {
    #[serde(rename = "plans.list")]
    Plans,
    #[serde(rename = "plans.get")]
    Plan,
    #[serde(rename = "advRoster.list")]
    Agents,
    #[serde(rename = "reports.list")]
    Reports,
    #[serde(rename = "reports.get")]
    Report,
    #[serde(rename = "goals.list")]
    Goals,
    #[serde(rename = "goals.detail")]
    Goal,
    #[serde(rename = "planSessions.list")]
    PlanSessions,
}

impl ReadModel {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Plans => "plans.list",
            Self::Plan => "plans.get",
            Self::Agents => "advRoster.list",
            Self::Reports => "reports.list",
            Self::Report => "reports.get",
            Self::Goals => "goals.list",
            Self::Goal => "goals.detail",
            Self::PlanSessions => "planSessions.list",
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ReadRequest {
    pub name: ReadModel,
    #[serde(default)]
    pub args: Map<String, Value>,
}

pub fn read_request(input: impl Read) -> Result<ReadRequest> {
    let mut bytes = Vec::new();
    input.take(MAX_REQUEST_BYTES + 1).read_to_end(&mut bytes)?;
    anyhow::ensure!(
        bytes.len() as u64 <= MAX_REQUEST_BYTES,
        "native-read request exceeds 64 KiB"
    );
    serde_json::from_slice(&bytes).context("native-read expects one JSON object with name and args")
}

pub async fn run() -> Result<()> {
    let result = async {
        let request = read_request(std::io::stdin().lock())?;
        let client = crate::client::OperatorClient::from_discovery().await?;
        client.native_panel_read(&request).await
    };
    let result = match tokio::time::timeout(Duration::from_secs(20), result).await {
        Ok(result) => result,
        Err(_) => Err(anyhow::anyhow!("native-read operator request timed out")),
    };
    match result {
        Ok(payload) => {
            println!("{}", serde_json::to_string(&payload)?);
            Ok(())
        }
        Err(error) => {
            println!("{}", json!({"ok":false,"error":format!("{error:#}")}));
            Err(error)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn native_panel_read_rejects_tools_mutations_and_unstructured_input() {
        for input in [
            r#"{"name":"goals.pause","args":{}}"#,
            r#"{"name":"sys:http","args":{}}"#,
            r#"{"name":"plans.list","args":[],"method":"POST"}"#,
            r#"{"name":"plans.list","args":{}} {"name":"reports.list"}"#,
            r#"{"name":"plans.list","args":null}"#,
            "",
        ] {
            assert!(read_request(input.as_bytes()).is_err(), "accepted {input}");
        }
    }

    #[test]
    fn native_panel_read_bounds_input_without_losing_exact_scope() {
        let query = br#"{"name":"reports.get","args":{"reportId":"r+/=& exact","harness":"same","workspaceId":"private"}}"#;
        let request = read_request(query.as_slice()).unwrap();
        assert_eq!(request.name.as_str(), "reports.get");
        assert_eq!(request.args["reportId"], "r+/=& exact");
        assert_eq!(request.args["workspaceId"], "private");
        assert!(
            read_request(vec![b' '; MAX_REQUEST_BYTES as usize + 1].as_slice())
                .unwrap_err()
                .to_string()
                .contains("64 KiB")
        );
    }
}
