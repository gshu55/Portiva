use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HttpKeyValueEntry {
    pub description: Option<String>,
    pub enabled: bool,
    pub key: String,
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
    pub url: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HttpProjectDraft {
    pub id: String,
    pub name: String,
    pub requests: Vec<HttpRequestDraft>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HttpWorkspaceDraft {
    pub id: String,
    pub name: String,
    pub projects: Vec<HttpProjectDraft>,
    pub requests: Vec<HttpRequestDraft>,
}
