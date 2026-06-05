use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::time::{Duration, Instant};

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HttpHeaderInput {
    key: String,
    value: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HttpSendRequest {
    method: String,
    url: String,
    headers: Vec<HttpHeaderInput>,
    body: Option<String>,
    timeout_ms: Option<u64>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HttpSendResponse {
    body: String,
    body_kind: HttpResponseBodyKind,
    duration_ms: u128,
    headers: BTreeMap<String, String>,
    size_bytes: usize,
    status: u16,
    status_text: String,
    url: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum HttpResponseBodyKind {
    Binary,
    Empty,
    Json,
    Text,
}

#[tauri::command]
pub async fn http_send(request: HttpSendRequest) -> Result<HttpSendResponse, String> {
    let method = request.method.trim().to_uppercase();
    let method = reqwest::Method::from_bytes(method.as_bytes())
        .map_err(|_| "HTTP 方法无效。".to_string())?;

    let url = reqwest::Url::parse(request.url.trim())
        .map_err(|error| format!("请求地址无效：{error}"))?;

    match url.scheme() {
        "http" | "https" => {}
        _ => return Err("仅支持 http 和 https 请求地址。".to_string()),
    }

    let timeout_ms = request.timeout_ms.unwrap_or(30_000).clamp(1_000, 300_000);
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::limited(10))
        .timeout(Duration::from_millis(timeout_ms))
        .build()
        .map_err(|error| format!("HTTP 客户端初始化失败：{error}"))?;

    let mut builder = client.request(method, url);

    for header in request.headers {
        let key = header.key.trim();
        if key.is_empty() {
            continue;
        }

        let name = reqwest::header::HeaderName::from_bytes(key.as_bytes())
            .map_err(|_| format!("请求头名称无效：{key}"))?;
        let value = reqwest::header::HeaderValue::from_str(&header.value)
            .map_err(|_| format!("请求头值无效：{key}"))?;
        builder = builder.header(name, value);
    }

    if let Some(body) = request.body {
        builder = builder.body(body);
    }

    let started_at = Instant::now();
    let response = builder
        .send()
        .await
        .map_err(|error| format!("请求发送失败：{error}"))?;
    let duration_ms = started_at.elapsed().as_millis();
    let status = response.status();
    let final_url = response.url().to_string();
    let mut headers = BTreeMap::new();

    for (name, value) in response.headers() {
        let key = name.as_str().to_string();
        let value = value
            .to_str()
            .map(|item| item.to_string())
            .unwrap_or_else(|_| "<binary header>".to_string());

        headers
            .entry(key)
            .and_modify(|existing: &mut String| {
                existing.push_str(", ");
                existing.push_str(&value);
            })
            .or_insert(value);
    }

    let content_type = headers.get("content-type").map(String::as_str);
    let bytes = response
        .bytes()
        .await
        .map_err(|error| format!("响应读取失败：{error}"))?;
    let size_bytes = bytes.len();
    let (body, body_kind) = decode_response_body(&bytes, content_type);

    Ok(HttpSendResponse {
        body,
        body_kind,
        duration_ms,
        headers,
        size_bytes,
        status: status.as_u16(),
        status_text: status.canonical_reason().unwrap_or("").to_string(),
        url: final_url,
    })
}

fn decode_response_body(
    bytes: &[u8],
    content_type: Option<&str>,
) -> (String, HttpResponseBodyKind) {
    if bytes.is_empty() {
        return (String::new(), HttpResponseBodyKind::Empty);
    }

    let content_type = content_type.unwrap_or_default().to_ascii_lowercase();
    let looks_textual = content_type.is_empty()
        || content_type.starts_with("text/")
        || content_type.contains("json")
        || content_type.contains("xml")
        || content_type.contains("html")
        || content_type.contains("javascript")
        || content_type.contains("x-www-form-urlencoded");

    if looks_textual {
        if content_type.contains("json") {
            if let Ok(value) = serde_json::from_slice::<serde_json::Value>(bytes) {
                if let Ok(pretty) = serde_json::to_string_pretty(&value) {
                    return (pretty, HttpResponseBodyKind::Json);
                }
            }
        }

        if let Ok(text) = std::str::from_utf8(bytes) {
            return (text.to_string(), HttpResponseBodyKind::Text);
        }
    }

    (
        format!("Binary response ({} bytes).", bytes.len()),
        HttpResponseBodyKind::Binary,
    )
}
