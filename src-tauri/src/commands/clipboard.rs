#[tauri::command]
pub fn clipboard_read_text() -> Result<String, String> {
    let mut clipboard =
        arboard::Clipboard::new().map_err(|error| format!("failed to open clipboard: {error}"))?;

    match clipboard.get_text() {
        Ok(text) => Ok(text),
        Err(arboard::Error::ContentNotAvailable) => Ok(String::new()),
        Err(error) => Err(format!("failed to read clipboard text: {error}")),
    }
}

#[tauri::command]
pub fn clipboard_write_text(text: String) -> Result<(), String> {
    let mut clipboard =
        arboard::Clipboard::new().map_err(|error| format!("failed to open clipboard: {error}"))?;

    clipboard
        .set_text(text)
        .map_err(|error| format!("failed to write clipboard text: {error}"))
}

#[tauri::command]
pub fn clipboard_write_html(html: String, text: String) -> Result<(), String> {
    let mut clipboard =
        arboard::Clipboard::new().map_err(|error| format!("failed to open clipboard: {error}"))?;

    clipboard
        .set_html(html, Some(text))
        .map_err(|error| format!("failed to write clipboard html: {error}"))
}
