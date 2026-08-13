#[cfg(target_os = "windows")]
fn windows_system_font_families() -> Result<Vec<String>, String> {
    use windows::Win32::Graphics::DirectWrite::{
        DWriteCreateFactory, IDWriteFactory, DWRITE_FACTORY_TYPE_SHARED,
    };

    unsafe {
        let factory: IDWriteFactory = DWriteCreateFactory(DWRITE_FACTORY_TYPE_SHARED)
            .map_err(|error| format!("failed to create DirectWrite factory: {error}"))?;
        let mut collection = None;
        factory
            .GetSystemFontCollection(&mut collection, true)
            .map_err(|error| format!("failed to read DirectWrite system fonts: {error}"))?;
        let collection =
            collection.ok_or_else(|| "DirectWrite returned no font collection".to_string())?;
        let mut families = Vec::with_capacity(collection.GetFontFamilyCount() as usize);

        for family_index in 0..collection.GetFontFamilyCount() {
            let family = collection
                .GetFontFamily(family_index)
                .map_err(|error| format!("failed to read DirectWrite font family: {error}"))?;
            let names = family.GetFamilyNames().map_err(|error| {
                format!("failed to read DirectWrite font family names: {error}")
            })?;
            if names.GetCount() == 0 {
                continue;
            }

            for name_index in 0..names.GetCount() {
                let name_length = names.GetStringLength(name_index).map_err(|error| {
                    format!("failed to read DirectWrite font name length: {error}")
                })?;
                let mut name_buffer = vec![0_u16; name_length as usize + 1];
                names
                    .GetString(name_index, &mut name_buffer)
                    .map_err(|error| format!("failed to read DirectWrite font name: {error}"))?;
                let name = String::from_utf16_lossy(&name_buffer[..name_length as usize]);
                let name = name.trim();
                if !name.is_empty() {
                    families.push(name.to_string());
                }
            }
        }

        families.sort_by_cached_key(|name| name.to_lowercase());
        families.dedup_by(|left, right| left.eq_ignore_ascii_case(right));
        Ok(families)
    }
}

fn filesystem_system_font_families() -> Vec<String> {
    let mut database = fontdb::Database::new();
    database.load_system_fonts();

    database
        .faces()
        .flat_map(|face| face.families.iter())
        .map(|(family, _language)| family.trim().to_string())
        .filter(|family| !family.is_empty())
        .collect()
}

#[tauri::command]
pub async fn system_fonts_list() -> Result<Vec<String>, String> {
    tauri::async_runtime::spawn_blocking(|| {
        let mut families = filesystem_system_font_families();

        #[cfg(target_os = "windows")]
        {
            if let Ok(direct_write_families) = windows_system_font_families() {
                families.extend(direct_write_families);
            }
        }

        families.sort_by_cached_key(|name| name.to_lowercase());
        families.dedup_by(|left, right| left.eq_ignore_ascii_case(right));
        Ok(families)
    })
    .await
    .map_err(|error| format!("failed to scan system fonts: {error}"))?
}

#[cfg(all(test, target_os = "windows"))]
mod tests {
    use super::windows_system_font_families;

    #[test]
    fn direct_write_discovers_installed_fonts() {
        let families =
            windows_system_font_families().expect("DirectWrite font scan should succeed");

        assert!(!families.is_empty());
    }
}
