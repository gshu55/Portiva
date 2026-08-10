use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::future::Future;
use std::sync::atomic::Ordering;
use std::sync::Arc;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter, State};

use crate::services::http_request_service::HttpRequestService;
use crate::services::network_proxy_service::{configure_http_client, load_proxy_password};
use crate::services::secret_store::SecretStore;
use crate::services::settings_store::SettingsStore;

const MAX_HTTP_MULTIPART_FILE_BYTES: usize = 128 * 1024 * 1024;
const MAX_HTTP_MULTIPART_BODY_BYTES: usize = 160 * 1024 * 1024;
const MAX_HTTP_REQUEST_BODY_BYTES: usize = 16 * 1024 * 1024;
const MAX_HTTP_RESPONSE_BYTES: usize = 32 * 1024 * 1024;

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
    multipart: Option<Vec<HttpMultipartPartInput>>,
    timeout_ms: Option<u64>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HttpMultipartPartInput {
    kind: HttpMultipartPartKind,
    name: String,
    value: Option<String>,
    file_name: Option<String>,
    content_type: Option<String>,
    bytes: Option<Vec<u8>>,
    bytes_base64: Option<String>,
}

#[derive(Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum HttpMultipartPartKind {
    Text,
    File,
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
pub async fn http_send(
    request: HttpSendRequest,
    settings: State<'_, SettingsStore>,
    secrets: State<'_, SecretStore>,
) -> Result<HttpSendResponse, String> {
    let proxy = settings.get()?.network.proxy;
    let password = load_proxy_password(&proxy, secrets.inner().clone()).await?;
    send_http_request(None, None, request, proxy, password).await
}

#[tauri::command]
pub async fn http_send_stream(
    app_handle: AppHandle,
    request_service: State<'_, HttpRequestService>,
    settings: State<'_, SettingsStore>,
    secrets: State<'_, SecretStore>,
    request_id: String,
    request: HttpSendRequest,
) -> Result<HttpSendResponse, String> {
    let proxy = settings.get()?.network.proxy;
    let password = load_proxy_password(&proxy, secrets.inner().clone()).await?;
    let cancel_token = request_service.begin(&request_id)?;
    let result = send_http_request(
        Some((&app_handle, &request_id)),
        Some(cancel_token),
        request,
        proxy,
        password,
    )
    .await;
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
    proxy: crate::domain::settings::NetworkProxySettings,
    proxy_password: Option<String>,
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
    let client_builder = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::limited(10))
        .timeout(Duration::from_millis(timeout_ms));
    let client = configure_http_client(
        client_builder,
        &proxy,
        url.scheme(),
        proxy_password.as_deref(),
    )?
    .build()
    .map_err(|error| format!("HTTP 客户端初始化失败：{error}"))?;

    let multipart_parts = request.multipart.unwrap_or_default();
    let has_multipart_body = !multipart_parts.is_empty();
    let mut builder = client.request(method, url);

    for header in request.headers {
        let key = header.key.trim();
        if key.is_empty() {
            continue;
        }

        if has_multipart_body && key.eq_ignore_ascii_case("content-type") {
            continue;
        }

        let name = reqwest::header::HeaderName::from_bytes(key.as_bytes())
            .map_err(|_| format!("请求头名称无效：{key}"))?;
        let value = reqwest::header::HeaderValue::from_str(&header.value)
            .map_err(|_| format!("请求头值无效：{key}"))?;
        builder = builder.header(name, value);
    }

    if has_multipart_body {
        let boundary = make_multipart_boundary();
        let body = build_multipart_body(&multipart_parts, &boundary)?;
        builder = builder
            .header(
                reqwest::header::CONTENT_TYPE,
                format!("multipart/form-data; boundary={boundary}"),
            )
            .body(body);
    } else if let Some(body) = request.body {
        ensure_size_limit(body.len(), MAX_HTTP_REQUEST_BODY_BYTES, "请求体")?;
        builder = builder.body(body);
    }

    let started_at = Instant::now();
    let response = await_cancelable(builder.send(), cancel_token.clone(), "请求已取消。")
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
    if let Some(content_length) = response.content_length() {
        let content_length = usize::try_from(content_length).unwrap_or(usize::MAX);
        ensure_size_limit(content_length, MAX_HTTP_RESPONSE_BYTES, "响应内容")?;
    }

    let mut bytes = Vec::with_capacity(
        response
            .content_length()
            .and_then(|length| usize::try_from(length).ok())
            .unwrap_or_default()
            .min(MAX_HTTP_RESPONSE_BYTES),
    );
    let stream_text = content_type.map(is_textual_content_type).unwrap_or(false);

    loop {
        if is_cancelled(cancel_token.as_ref()) {
            return Err("请求已取消。".to_string());
        }

        let chunk = await_cancelable(response.chunk(), cancel_token.clone(), "请求已取消。")
            .await
            .map_err(|error| format!("响应读取失败：{error}"))?;

        let Some(chunk) = chunk else {
            break;
        };

        ensure_size_limit(
            bytes.len().saturating_add(chunk.len()),
            MAX_HTTP_RESPONSE_BYTES,
            "响应内容",
        )?;

        if stream_text {
            if let Some((app_handle, request_id)) = stream_target {
                let body_kind = if content_type
                    .unwrap_or_default()
                    .to_ascii_lowercase()
                    .contains("json")
                {
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

fn make_multipart_boundary() -> String {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or_default();
    format!("portiva-boundary-{nanos}")
}

fn build_multipart_body(
    parts: &[HttpMultipartPartInput],
    boundary: &str,
) -> Result<Vec<u8>, String> {
    let payload_size = parts.iter().try_fold(0_usize, |total, part| {
        Ok::<_, String>(total.saturating_add(multipart_part_payload_size(part)?))
    })?;
    ensure_size_limit(
        payload_size,
        MAX_HTTP_MULTIPART_BODY_BYTES,
        "multipart 请求体",
    )?;
    let mut body = Vec::new();

    for part in parts {
        let name = part.name.trim();
        if name.is_empty() {
            continue;
        }

        body.extend_from_slice(format!("--{boundary}\r\n").as_bytes());
        body.extend_from_slice(
            format!(
                "Content-Disposition: form-data; name=\"{}\"",
                escape_multipart_header_parameter(name)
            )
            .as_bytes(),
        );

        match part.kind {
            HttpMultipartPartKind::Text => {
                body.extend_from_slice(b"\r\n\r\n");
                body.extend_from_slice(part.value.as_deref().unwrap_or_default().as_bytes());
                body.extend_from_slice(b"\r\n");
            }
            HttpMultipartPartKind::File => {
                let bytes = multipart_file_bytes(part, name)?;
                let file_name = part
                    .file_name
                    .as_deref()
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                    .unwrap_or("upload");
                let content_type = multipart_content_type(part.content_type.as_deref());

                body.extend_from_slice(
                    format!(
                        "; filename=\"{}\"\r\nContent-Type: {content_type}\r\n\r\n",
                        escape_multipart_header_parameter(file_name)
                    )
                    .as_bytes(),
                );
                body.extend_from_slice(&bytes);
                body.extend_from_slice(b"\r\n");
            }
        }
    }

    body.extend_from_slice(format!("--{boundary}--\r\n").as_bytes());
    ensure_size_limit(
        body.len(),
        MAX_HTTP_MULTIPART_BODY_BYTES,
        "multipart 请求体",
    )?;
    Ok(body)
}

fn multipart_file_bytes(part: &HttpMultipartPartInput, name: &str) -> Result<Vec<u8>, String> {
    if let Some(bytes) = part.bytes.as_ref() {
        ensure_size_limit(bytes.len(), MAX_HTTP_MULTIPART_FILE_BYTES, "单个上传文件")?;
        return Ok(bytes.clone());
    }

    if let Some(bytes_base64) = part
        .bytes_base64
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        let compact_length = bytes_base64
            .bytes()
            .filter(|byte| !byte.is_ascii_whitespace())
            .count();
        let estimated_length = compact_length.saturating_div(4).saturating_mul(3);
        ensure_size_limit(
            estimated_length,
            MAX_HTTP_MULTIPART_FILE_BYTES,
            "单个上传文件",
        )?;
        let bytes = decode_base64(bytes_base64)
            .map_err(|error| format!("文件字段 {name} 内容解码失败：{error}"))?;
        ensure_size_limit(bytes.len(), MAX_HTTP_MULTIPART_FILE_BYTES, "单个上传文件")?;
        return Ok(bytes);
    }

    Err(format!("文件字段 {name} 尚未选择文件。"))
}

fn multipart_part_payload_size(part: &HttpMultipartPartInput) -> Result<usize, String> {
    match part.kind {
        HttpMultipartPartKind::Text => Ok(part.value.as_deref().unwrap_or_default().len()),
        HttpMultipartPartKind::File => {
            if let Some(bytes) = &part.bytes {
                return Ok(bytes.len());
            }

            if let Some(base64) = &part.bytes_base64 {
                let compact_length = base64
                    .bytes()
                    .filter(|byte| !byte.is_ascii_whitespace())
                    .count();
                return Ok(compact_length.saturating_div(4).saturating_mul(3));
            }

            Ok(0)
        }
    }
}

fn ensure_size_limit(size: usize, maximum: usize, label: &str) -> Result<(), String> {
    if size <= maximum {
        return Ok(());
    }

    Err(format!("{label}超过 {} MB 上限。", maximum / (1024 * 1024)))
}

fn escape_multipart_header_parameter(value: &str) -> String {
    let mut escaped = String::with_capacity(value.len());

    for char in value.chars() {
        match char {
            '"' => escaped.push_str("\\\""),
            '\\' => escaped.push_str("\\\\"),
            '\r' | '\n' => escaped.push(' '),
            char if char.is_control() => escaped.push(' '),
            char => escaped.push(char),
        }
    }

    escaped
}

fn multipart_content_type(value: Option<&str>) -> &str {
    let Some(value) = value.map(str::trim).filter(|value| !value.is_empty()) else {
        return "application/octet-stream";
    };

    if value.bytes().any(|byte| byte <= 31 || byte == 127) {
        "application/octet-stream"
    } else {
        value
    }
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
            format!("data:{};base64,{}", content_type, encode_base64(bytes)),
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
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut output = String::with_capacity(bytes.len().div_ceil(3) * 4);

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

fn decode_base64(input: &str) -> Result<Vec<u8>, String> {
    let bytes: Vec<u8> = input
        .bytes()
        .filter(|byte| !byte.is_ascii_whitespace())
        .collect();

    if bytes.is_empty() {
        return Ok(Vec::new());
    }

    if !bytes.len().is_multiple_of(4) {
        return Err("base64 长度无效".to_string());
    }

    let mut output = Vec::with_capacity((bytes.len() / 4) * 3);
    let last_group_index = bytes.len() / 4 - 1;

    for (group_index, chunk) in bytes.chunks(4).enumerate() {
        let padding = chunk.iter().filter(|byte| **byte == b'=').count();
        if padding > 2 {
            return Err("base64 填充无效".to_string());
        }
        if padding > 0 && group_index != last_group_index {
            return Err("base64 填充位置无效".to_string());
        }
        if padding == 1 && chunk[3] != b'=' {
            return Err("base64 填充位置无效".to_string());
        }
        if padding == 2 && !(chunk[2] == b'=' && chunk[3] == b'=') {
            return Err("base64 填充位置无效".to_string());
        }

        let n0 = base64_value(chunk[0])?;
        let n1 = base64_value(chunk[1])?;
        let n2 = if chunk[2] == b'=' {
            0
        } else {
            base64_value(chunk[2])?
        };
        let n3 = if chunk[3] == b'=' {
            0
        } else {
            base64_value(chunk[3])?
        };
        let value = ((n0 as u32) << 18) | ((n1 as u32) << 12) | ((n2 as u32) << 6) | n3 as u32;

        output.push(((value >> 16) & 0xff) as u8);
        if padding < 2 {
            output.push(((value >> 8) & 0xff) as u8);
        }
        if padding < 1 {
            output.push((value & 0xff) as u8);
        }
    }

    Ok(output)
}

fn base64_value(byte: u8) -> Result<u8, String> {
    match byte {
        b'A'..=b'Z' => Ok(byte - b'A'),
        b'a'..=b'z' => Ok(byte - b'a' + 26),
        b'0'..=b'9' => Ok(byte - b'0' + 52),
        b'+' => Ok(62),
        b'/' => Ok(63),
        b'=' => Err("base64 填充位置无效".to_string()),
        _ => Err("base64 字符无效".to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn build_multipart_body_includes_text_and_file_parts() {
        let parts = vec![
            HttpMultipartPartInput {
                kind: HttpMultipartPartKind::Text,
                name: "title".to_string(),
                value: Some("hello".to_string()),
                file_name: None,
                content_type: None,
                bytes: None,
                bytes_base64: None,
            },
            HttpMultipartPartInput {
                kind: HttpMultipartPartKind::File,
                name: "upload".to_string(),
                value: None,
                file_name: Some("hello.txt".to_string()),
                content_type: Some("text/plain".to_string()),
                bytes: Some(b"abc".to_vec()),
                bytes_base64: None,
            },
        ];

        let body = build_multipart_body(&parts, "portiva-test-boundary")
            .expect("multipart body should build");
        let body = String::from_utf8(body).expect("test body should be valid utf-8");

        assert!(body.contains("--portiva-test-boundary\r\n"));
        assert!(body.contains("Content-Disposition: form-data; name=\"title\"\r\n\r\nhello\r\n"));
        assert!(body.contains(
            "Content-Disposition: form-data; name=\"upload\"; filename=\"hello.txt\"\r\nContent-Type: text/plain\r\n\r\nabc\r\n"
        ));
        assert!(body.ends_with("--portiva-test-boundary--\r\n"));
    }

    #[test]
    fn build_multipart_body_rejects_file_part_without_selected_bytes() {
        let parts = vec![HttpMultipartPartInput {
            kind: HttpMultipartPartKind::File,
            name: "upload".to_string(),
            value: None,
            file_name: Some("missing.txt".to_string()),
            content_type: Some("text/plain".to_string()),
            bytes: None,
            bytes_base64: None,
        }];

        assert_eq!(
            build_multipart_body(&parts, "portiva-test-boundary"),
            Err("文件字段 upload 尚未选择文件。".to_string())
        );
    }

    #[test]
    fn build_multipart_body_accepts_base64_file_part() {
        let parts = vec![HttpMultipartPartInput {
            kind: HttpMultipartPartKind::File,
            name: "upload".to_string(),
            value: None,
            file_name: Some("hello.txt".to_string()),
            content_type: Some("text/plain".to_string()),
            bytes: None,
            bytes_base64: Some("YWJj".to_string()),
        }];

        let body = build_multipart_body(&parts, "portiva-test-boundary")
            .expect("multipart body should build from base64 bytes");
        let body = String::from_utf8(body).expect("test body should be valid utf-8");

        assert!(body.contains(
            "Content-Disposition: form-data; name=\"upload\"; filename=\"hello.txt\"\r\nContent-Type: text/plain\r\n\r\nabc\r\n"
        ));
    }

    #[test]
    fn size_limit_rejects_values_above_the_boundary() {
        assert!(ensure_size_limit(8, 8, "test").is_ok());
        assert_eq!(
            ensure_size_limit(9, 8, "test"),
            Err("test超过 0 MB 上限。".to_string())
        );
    }
}
