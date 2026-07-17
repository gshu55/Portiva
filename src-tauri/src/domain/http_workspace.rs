use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HttpKeyValueEntry {
    pub description: Option<String>,
    pub enabled: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub file_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub file_size: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub file_type: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub form_value_type: Option<String>,
    pub key: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sensitive: Option<bool>,
    pub value: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HttpAuthDraft {
    pub api_key_location: String,
    pub api_key_name: String,
    pub api_key_value: String,
    pub bearer_token: String,
    pub password: String,
    pub r#type: String,
    pub username: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HttpRequestDraft {
    pub auth: HttpAuthDraft,
    pub body: String,
    pub body_mode: String,
    pub form_body: Vec<HttpKeyValueEntry>,
    pub headers: Vec<HttpKeyValueEntry>,
    pub id: String,
    pub method: String,
    pub name: String,
    pub params: Vec<HttpKeyValueEntry>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub temp_variables: Vec<HttpKeyValueEntry>,
    pub url: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HttpProjectDraft {
    pub id: String,
    pub name: String,
    pub requests: Vec<HttpRequestDraft>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub variables: Vec<HttpKeyValueEntry>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HttpEnvironmentDraft {
    pub id: String,
    pub name: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub variables: Vec<HttpKeyValueEntry>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HttpWorkspaceDraft {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub active_environment_id: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub environments: Vec<HttpEnvironmentDraft>,
    pub id: String,
    pub name: String,
    pub projects: Vec<HttpProjectDraft>,
    pub requests: Vec<HttpRequestDraft>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub variables: Vec<HttpKeyValueEntry>,
}
