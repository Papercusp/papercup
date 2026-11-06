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
    #[serde(rename = "operator.identity")]
    Environment,
    #[serde(rename = "accounts.pool")]
    Accounts,
    #[serde(rename = "accounts.sessionOverride")]
    AccountOverride,
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
            Self::Environment => "operator.identity",
            Self::Accounts => "accounts.pool",
            Self::AccountOverride => "accounts.sessionOverride",
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ReadRequest {
    pub name: ReadModel,
    #[serde(default)]
    pub args: Map<String, Value>,
    #[serde(default)]
    pub environment: Option<crate::client::BackendIdentity>,
}

fn bounded_request<T: serde::de::DeserializeOwned>(input: impl Read) -> Result<T> {
    let mut bytes = Vec::new();
    input.take(MAX_REQUEST_BYTES + 1).read_to_end(&mut bytes)?;
    anyhow::ensure!(
        bytes.len() as u64 <= MAX_REQUEST_BYTES,
        "native panel request exceeds 64 KiB"
    );
    serde_json::from_slice(&bytes).context("native panel expects one typed JSON request")
}

pub fn read_request(input: impl Read) -> Result<ReadRequest> {
    bounded_request(input)
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AccountAction { Default, Force, Exclude, Auto }

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct AccountRequest {
    pub environment: crate::client::BackendIdentity,
    pub action: AccountAction,
    pub account_id: Option<String>,
}

impl AccountRequest {
    // Patch only the selected axis. The existing server owns validation,
    // persistence and Auto's preservation of the independent default.
    pub fn patch(&self, current: &Value, pool: &[Value]) -> Result<Value> {
        if matches!(self.action, AccountAction::Auto) {
            anyhow::ensure!(self.account_id.is_none(), "Auto does not select an account");
            return Ok(json!({"clear":true}));
        }
        let id = self.account_id.as_deref().filter(|id| !id.is_empty())
            .context("select an exact account")?;
        anyhow::ensure!(pool.iter().filter(|row| row["id"].as_str() == Some(id)).count() == 1,
            "selected account is unavailable or ambiguous");
        if matches!(self.action, AccountAction::Default) {
            return Ok(json!({"defaultAccountId": if current["defaultAccountId"].as_str() == Some(id) { Value::Null } else { json!(id) }}));
        }
        let field = if matches!(self.action, AccountAction::Force) { "forcedAccounts" } else { "excludeAccounts" };
        let values = current[field].as_array().context("account steering is unavailable")?;
        anyhow::ensure!(values.iter().all(Value::is_string), "invalid account steering");
        let contains = values.iter().any(|value| value.as_str() == Some(id));
        let mut next: Vec<Value> = values.iter().filter(|value| value.as_str() != Some(id)).cloned().collect();
        if !contains { next.push(json!(id)); }
        Ok(json!({field:next}))
    }
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

pub async fn run_account() -> Result<()> {
    let result = tokio::time::timeout(Duration::from_secs(20), async {
        let request: AccountRequest = bounded_request(std::io::stdin().lock())?;
        let client = crate::client::OperatorClient::from_discovery().await?;
        client.native_account_action(&request).await
    }).await.context("native account action timed out; refresh to verify server state")?;
    match result {
        Ok(payload) => { println!("{}", payload); Ok(()) }
        Err(error) => { println!("{}", json!({"ok":false,"error":format!("{error:#}")})); Err(error) }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn native_account_controls_patch_only_one_axis_and_preserve_exact_identity() {
        let environment = json!({"schemaVersion":1,"endpoint":"http://selected:3170","selectionSource":"test","transport":"http",
            "workspaceId":"selected","store":{"id":"store","target":"test","source":"test"},
            "build":{"version":"test","sha":null},"agentChat":{"scope":"workspace:selected","route":"test"},"capabilities":{}});
        let prior = json!({"forcedAccounts":["one"],"excludeAccounts":["other"],"defaultAccountId":"default"});
        let pool = vec![json!({"id":"one"}), json!({"id":"other"}), json!({"id":"literal +/=& λ"})];
        for (action, id, expected) in [
            ("default", Some("one"), json!({"defaultAccountId":"one"})),
            ("force", Some("one"), json!({"forcedAccounts":[]})),
            ("exclude", Some("literal +/=& λ"), json!({"excludeAccounts":["other","literal +/=& λ"]})),
            ("auto", None, json!({"clear":true})),
        ] {
            let request: AccountRequest = serde_json::from_value(json!({"environment":environment,"action":action,"accountId":id})).unwrap();
            assert_eq!(request.patch(&prior, &pool).unwrap(), expected);
        }
        let request: AccountRequest = serde_json::from_value(json!({"environment":environment,"action":"default","accountId":"default"})).unwrap();
        assert_eq!(request.patch(&prior, &[json!({"id":"default"})]).unwrap(), json!({"defaultAccountId":null}));
        assert!(request.patch(&prior, &pool).is_err());
        assert!(request.patch(&prior, &[json!({"id":"default"}),json!({"id":"default"})]).is_err());
        for value in [json!({"action":"force","accountId":"one"}),
            json!({"environment":environment,"action":"shell","accountId":"one"}),
            json!({"environment":environment,"action":"force","accountId":"one","path":"/arbitrary"})] {
            assert!(serde_json::from_value::<AccountRequest>(value).is_err());
        }
    }

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
