use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::future::Future;
use std::sync::atomic::Ordering;
use std::sync::Arc;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, State};

use crate::services::http_request_service::HttpRequestService;

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

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct HttpStreamChunk {
    body_kind: HttpResponseBodyKind,
    chunk: String,
    request_id: String,
    size_bytes: usize,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub enum HttpResponseBodyKind {
    Binary,
    Empty,
    Image,
    Json,
    Text,
}

#[tauri::command]
pub async fn http_send(request: HttpSendRequest) -> Result<HttpSendResponse, String> {
    send_http_request(None, None, request).await
}

#[tauri::command]
pub async fn http_send_stream(
    app_handle: AppHandle,
    request_service: State<'_, HttpRequestService>,
    request_id: String,
    request: HttpSendRequest,
) -> Result<HttpSendResponse, String> {
    let cancel_token = request_service.begin(&request_id)?;
    let result = send_http_request(Some((&app_handle, &request_id)), Some(cancel_token), request).await;
    request_service.finish(&request_id);
    result
}

#[tauri::command]
pub fn http_cancel(
    request_service: State<'_, HttpRequestService>,
    request_id: String,
) -> Result<(), String> {
    request_service.cancel(&request_id)
}

async fn send_http_request(
    stream_target: Option<(&AppHandle, &str)>,
    cancel_token: Option<Arc<std::sync::atomic::AtomicBool>>,
    request: HttpSendRequest,
) -> Result<HttpSendResponse, String> {
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
    let response = await_cancelable(
        builder.send(),
        cancel_token.clone(),
        "请求已取消。",
    )
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
    let bytes = read_response_bytes(response, stream_target, cancel_token, content_type).await?;
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

async fn read_response_bytes(
    mut response: reqwest::Response,
    stream_target: Option<(&AppHandle, &str)>,
    cancel_token: Option<Arc<std::sync::atomic::AtomicBool>>,
    content_type: Option<&str>,
) -> Result<Vec<u8>, String> {
    let mut bytes = Vec::new();
    let stream_text = content_type
        .map(is_textual_content_type)
        .unwrap_or(false);

    loop {
        if is_cancelled(cancel_token.as_ref()) {
            return Err("请求已取消。".to_string());
        }

        let chunk = await_cancelable(
            response.chunk(),
            cancel_token.clone(),
            "请求已取消。",
        )
        .await
        .map_err(|error| format!("响应读取失败：{error}"))?;

        let Some(chunk) = chunk else {
            break;
        };

        if stream_text {
            if let Some((app_handle, request_id)) = stream_target {
                let body_kind = if content_type.unwrap_or_default().to_ascii_lowercase().contains("json") {
                    HttpResponseBodyKind::Json
                } else {
                    HttpResponseBodyKind::Text
                };
                let _ = app_handle.emit(
                    "http-stream-chunk",
                    HttpStreamChunk {
                        body_kind,
                        chunk: String::from_utf8_lossy(&chunk).to_string(),
                        request_id: request_id.to_string(),
                        size_bytes: bytes.len() + chunk.len(),
                    },
                );
            }
        }

        bytes.extend_from_slice(&chunk);
    }

    Ok(bytes)
}

async fn await_cancelable<F, T, E>(
    future: F,
    cancel_token: Option<Arc<std::sync::atomic::AtomicBool>>,
    cancel_message: &str,
) -> Result<T, String>
where
    F: Future<Output = Result<T, E>>,
    E: std::fmt::Display,
{
    let mut future = Box::pin(future);

    loop {
        if is_cancelled(cancel_token.as_ref()) {
            return Err(cancel_message.to_string());
        }

        match tokio::time::timeout(Duration::from_millis(80), &mut future).await {
            Ok(result) => return result.map_err(|error| error.to_string()),
            Err(_) => continue,
        }
    }
}

fn is_cancelled(cancel_token: Option<&Arc<std::sync::atomic::AtomicBool>>) -> bool {
    cancel_token
        .map(|token| token.load(Ordering::Relaxed))
        .unwrap_or(false)
}

fn is_textual_content_type(content_type: &str) -> bool {
    let content_type = content_type.to_ascii_lowercase();
    content_type.is_empty()
        || content_type.starts_with("text/")
        || content_type.contains("json")
        || content_type.contains("xml")
        || content_type.contains("html")
        || content_type.contains("javascript")
        || content_type.contains("x-www-form-urlencoded")
}

fn decode_response_body(
    bytes: &[u8],
    content_type: Option<&str>,
) -> (String, HttpResponseBodyKind) {
    if bytes.is_empty() {
        return (String::new(), HttpResponseBodyKind::Empty);
    }

    let content_type = content_type.unwrap_or_default().to_ascii_lowercase();
    let looks_textual = is_textual_content_type(&content_type);

    if content_type.starts_with("image/") {
        return (
            format!(
                "data:{};base64,{}",
                content_type,
                encode_base64(bytes)
            ),
            HttpResponseBodyKind::Image,
        );
    }

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

fn encode_base64(bytes: &[u8]) -> String {
    const TABLE: &[u8; 64] =
        b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut output = String::with_capacity(((bytes.len() + 2) / 3) * 4);

    for chunk in bytes.chunks(3) {
        let b0 = chunk[0];
        let b1 = *chunk.get(1).unwrap_or(&0);
        let b2 = *chunk.get(2).unwrap_or(&0);
        let n = ((b0 as u32) << 16) | ((b1 as u32) << 8) | b2 as u32;

        output.push(TABLE[((n >> 18) & 0x3f) as usize] as char);
        output.push(TABLE[((n >> 12) & 0x3f) as usize] as char);
        output.push(if chunk.len() > 1 {
            TABLE[((n >> 6) & 0x3f) as usize] as char
        } else {
            '='
        });
        output.push(if chunk.len() > 2 {
            TABLE[(n & 0x3f) as usize] as char
        } else {
            '='
        });
    }

    output
}
