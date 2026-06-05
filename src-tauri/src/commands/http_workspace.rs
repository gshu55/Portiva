use tauri::State;

use crate::domain::http_workspace::HttpWorkspaceDraft;
use crate::services::http_workspace_store::HttpWorkspaceStore;

#[tauri::command]
pub fn http_workspaces_get(
    store: State<'_, HttpWorkspaceStore>,
) -> Result<Vec<HttpWorkspaceDraft>, String> {
    store.list()
}

#[tauri::command]
pub fn http_workspaces_save(
    workspaces: Vec<HttpWorkspaceDraft>,
    store: State<'_, HttpWorkspaceStore>,
) -> Result<Vec<HttpWorkspaceDraft>, String> {
    store.save_all(workspaces)
}
