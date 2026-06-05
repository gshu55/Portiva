use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SecretMetadata {
    pub id: String,
    pub profile_id: String,
    pub purpose: SecretPurpose,
    pub created_at: String,
    #[serde(default)]
    pub has_value: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum SecretPurpose {
    Password,
    PrivateKeyPassphrase,
    Token,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KnownHostEntry {
    pub host: String,
    pub fingerprint: String,
}
