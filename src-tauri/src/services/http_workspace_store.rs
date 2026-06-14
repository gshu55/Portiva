use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;

use rusqlite::{params, Connection, OptionalExtension};

use crate::domain::http_workspace::{
    HttpProjectDraft, HttpRequestDraft, HttpWorkspaceDraft,
};
use crate::utils::{app_paths, clock};

const SCHEMA_VERSION: i32 = 1;

pub struct HttpWorkspaceStore {
    lock: Mutex<()>,
    path: Option<PathBuf>,
}

impl Default for HttpWorkspaceStore {
    fn default() -> Self {
        Self::with_path(app_paths::http_console_database_path())
    }
}

impl HttpWorkspaceStore {
    #[cfg(test)]
    pub fn in_memory() -> Self {
        Self {
            lock: Mutex::new(()),
            path: None,
        }
    }

    pub fn with_path(path: PathBuf) -> Self {
        Self {
            lock: Mutex::new(()),
            path: Some(path),
        }
    }

    pub fn list(&self) -> Result<Vec<HttpWorkspaceDraft>, String> {
        let _guard = self
            .lock
            .lock()
            .map_err(|_| "http workspace store lock poisoned".to_string())?;
        let mut connection = self.open_connection()?;
        migrate(&connection)?;

        if count_rows(&connection, "http_workspaces")? == 0 {
            seed_default_workspace(&mut connection)?;
        }

        remove_seeded_default_content(&connection)?;
        load_workspaces(&connection)
    }

    pub fn save_all(
        &self,
        workspaces: Vec<HttpWorkspaceDraft>,
    ) -> Result<Vec<HttpWorkspaceDraft>, String> {
        let _guard = self
            .lock
            .lock()
            .map_err(|_| "http workspace store lock poisoned".to_string())?;
        let mut connection = self.open_connection()?;
        migrate(&connection)?;
        replace_workspaces(&mut connection, &workspaces)?;
        load_workspaces(&connection)
    }

    fn open_connection(&self) -> Result<Connection, String> {
        let Some(path) = &self.path else {
            let connection = Connection::open_in_memory()
                .map_err(|error| format!("failed to open in-memory http database: {error}"))?;
            migrate(&connection)?;
            return Ok(connection);
        };

        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)
                .map_err(|error| format!("failed to create http database directory: {error}"))?;
        }

        Connection::open(path).map_err(|error| format!("failed to open http database: {error}"))
    }
}

fn migrate(connection: &Connection) -> Result<(), String> {
    let version: i32 = connection
        .query_row("PRAGMA user_version", [], |row| row.get(0))
        .map_err(|error| format!("failed to read http database version: {error}"))?;

    if version > SCHEMA_VERSION {
        return Err(format!(
            "http database version {version} is newer than supported version {SCHEMA_VERSION}"
        ));
    }

    connection
        .execute_batch(
            r#"
            PRAGMA foreign_keys = ON;
            CREATE TABLE IF NOT EXISTS http_workspaces (
              id TEXT PRIMARY KEY,
              name TEXT NOT NULL,
              sort_order INTEGER NOT NULL,
              created_at TEXT NOT NULL,
              updated_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS http_projects (
              id TEXT PRIMARY KEY,
              workspace_id TEXT NOT NULL,
              name TEXT NOT NULL,
              sort_order INTEGER NOT NULL,
              created_at TEXT NOT NULL,
              updated_at TEXT NOT NULL,
              FOREIGN KEY(workspace_id) REFERENCES http_workspaces(id) ON DELETE CASCADE
            );
            CREATE TABLE IF NOT EXISTS http_requests (
              id TEXT PRIMARY KEY,
              workspace_id TEXT NOT NULL,
              project_id TEXT,
              name TEXT NOT NULL,
              method TEXT NOT NULL,
              url TEXT NOT NULL DEFAULT '',
              sort_order INTEGER NOT NULL,
              draft_json TEXT NOT NULL,
              created_at TEXT NOT NULL,
              updated_at TEXT NOT NULL,
              FOREIGN KEY(workspace_id) REFERENCES http_workspaces(id) ON DELETE CASCADE,
              FOREIGN KEY(project_id) REFERENCES http_projects(id) ON DELETE CASCADE
            );
            CREATE INDEX IF NOT EXISTS idx_http_projects_workspace_sort
              ON http_projects(workspace_id, sort_order, name);
            CREATE INDEX IF NOT EXISTS idx_http_requests_workspace_project_sort
              ON http_requests(workspace_id, project_id, sort_order, name);
            PRAGMA user_version = 1;
            "#,
        )
        .map_err(|error| format!("failed to migrate http database: {error}"))?;

    Ok(())
}

fn replace_workspaces(
    connection: &mut Connection,
    workspaces: &[HttpWorkspaceDraft],
) -> Result<(), String> {
    let transaction = connection
        .transaction()
        .map_err(|error| format!("failed to start http database transaction: {error}"))?;
    transaction
        .execute("DELETE FROM http_requests", [])
        .map_err(|error| format!("failed to clear http requests: {error}"))?;
    transaction
        .execute("DELETE FROM http_projects", [])
        .map_err(|error| format!("failed to clear http projects: {error}"))?;
    transaction
        .execute("DELETE FROM http_workspaces", [])
        .map_err(|error| format!("failed to clear http workspaces: {error}"))?;

    let now = clock::now_stamp();
    for (workspace_index, workspace) in workspaces.iter().enumerate() {
        transaction
            .execute(
                "INSERT INTO http_workspaces (id, name, sort_order, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
                params![workspace.id, workspace.name, workspace_index as i64, now, now],
            )
            .map_err(|error| format!("failed to save http workspace: {error}"))?;

        insert_requests(&transaction, &workspace.id, None, &workspace.requests, &now)?;

        for (project_index, project) in workspace.projects.iter().enumerate() {
            transaction
                .execute(
                    "INSERT INTO http_projects (id, workspace_id, name, sort_order, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
                    params![project.id, workspace.id, project.name, project_index as i64, now, now],
                )
                .map_err(|error| format!("failed to save http project: {error}"))?;
            insert_requests(
                &transaction,
                &workspace.id,
                Some(project.id.as_str()),
                &project.requests,
                &now,
            )?;
        }
    }

    transaction
        .commit()
        .map_err(|error| format!("failed to commit http workspace data: {error}"))
}

fn insert_requests(
    connection: &Connection,
    workspace_id: &str,
    project_id: Option<&str>,
    requests: &[HttpRequestDraft],
    now: &str,
) -> Result<(), String> {
    for (request_index, request) in requests.iter().enumerate() {
        let draft_json = serde_json::to_string(request)
            .map_err(|error| format!("failed to encode http request draft: {error}"))?;
        connection
            .execute(
                "INSERT INTO http_requests (id, workspace_id, project_id, name, method, url, sort_order, draft_json, created_at, updated_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                params![
                    request.id,
                    workspace_id,
                    project_id,
                    request.name,
                    request.method,
                    request.url,
                    request_index as i64,
                    draft_json,
                    now,
                    now
                ],
            )
            .map_err(|error| format!("failed to save http request: {error}"))?;
    }

    Ok(())
}

fn load_workspaces(connection: &Connection) -> Result<Vec<HttpWorkspaceDraft>, String> {
    let mut statement = connection
        .prepare("SELECT id, name FROM http_workspaces ORDER BY sort_order, name")
        .map_err(|error| format!("failed to prepare http workspace query: {error}"))?;
    let workspace_rows = statement
        .query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })
        .map_err(|error| format!("failed to load http workspaces: {error}"))?;

    let mut workspaces = Vec::new();
    for row in workspace_rows {
        let (workspace_id, name) =
            row.map_err(|error| format!("failed to read http workspace: {error}"))?;
        let projects = load_projects(connection, &workspace_id)?;
        let requests = load_requests(connection, &workspace_id, None)?;
        workspaces.push(HttpWorkspaceDraft {
            id: workspace_id,
            name,
            projects,
            requests,
        });
    }

    Ok(workspaces)
}

fn load_projects(
    connection: &Connection,
    workspace_id: &str,
) -> Result<Vec<HttpProjectDraft>, String> {
    let mut statement = connection
        .prepare(
            "SELECT id, name FROM http_projects WHERE workspace_id = ? ORDER BY sort_order, name",
        )
        .map_err(|error| format!("failed to prepare http project query: {error}"))?;
    let project_rows = statement
        .query_map(params![workspace_id], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })
        .map_err(|error| format!("failed to load http projects: {error}"))?;

    let mut projects = Vec::new();
    for row in project_rows {
        let (project_id, name) =
            row.map_err(|error| format!("failed to read http project: {error}"))?;
        let requests = load_requests(connection, workspace_id, Some(&project_id))?;
        projects.push(HttpProjectDraft {
            id: project_id,
            name,
            requests,
        });
    }

    Ok(projects)
}

fn load_requests(
    connection: &Connection,
    workspace_id: &str,
    project_id: Option<&str>,
) -> Result<Vec<HttpRequestDraft>, String> {
    let mut statement = if project_id.is_some() {
        connection.prepare(
            "SELECT draft_json FROM http_requests WHERE workspace_id = ? AND project_id = ? ORDER BY sort_order, name",
        )
    } else {
        connection.prepare(
            "SELECT draft_json FROM http_requests WHERE workspace_id = ? AND project_id IS NULL ORDER BY sort_order, name",
        )
    }
    .map_err(|error| format!("failed to prepare http request query: {error}"))?;

    let raw_requests = if let Some(project_id) = project_id {
        statement
            .query_map(params![workspace_id, project_id], |row| {
                row.get::<_, String>(0)
            })
            .and_then(|rows| rows.collect::<Result<Vec<_>, _>>())
    } else {
        statement
            .query_map(params![workspace_id], |row| row.get::<_, String>(0))
            .and_then(|rows| rows.collect::<Result<Vec<_>, _>>())
    }
    .map_err(|error| format!("failed to load http requests: {error}"))?;

    let mut requests = Vec::new();
    for raw in raw_requests {
        let request = serde_json::from_str::<HttpRequestDraft>(&raw)
            .map_err(|error| format!("failed to decode http request draft: {error}"))?;
        requests.push(request);
    }

    Ok(requests)
}

fn seed_default_workspace(connection: &mut Connection) -> Result<(), String> {
    replace_workspaces(connection, &default_http_workspaces())
}

fn remove_seeded_default_content(connection: &Connection) -> Result<(), String> {
    let seeded_requests = [
        (
            "req-workspace-status",
            "工作区状态",
            "https://api.example.local/status",
        ),
        (
            "req-health",
            "服务健康检查",
            "https://api.example.local/health",
        ),
        (
            "req-login",
            "登录接口",
            "https://api.example.local/auth/login",
        ),
    ];

    for (request_id, name, url) in seeded_requests {
        connection
            .execute(
                "DELETE FROM http_requests WHERE workspace_id = ? AND id = ? AND name = ? AND url = ?",
                params!["ws-default", request_id, name, url],
            )
            .map_err(|error| format!("failed to remove seeded http request: {error}"))?;
    }

    connection
        .execute(
            "DELETE FROM http_projects
             WHERE workspace_id = ? AND id = ? AND name = ?
             AND NOT EXISTS (
               SELECT 1 FROM http_requests WHERE http_requests.project_id = http_projects.id
             )",
            params!["ws-default", "project-default", "默认项目"],
        )
        .map_err(|error| format!("failed to remove seeded http project: {error}"))?;

    Ok(())
}

fn count_rows(connection: &Connection, table: &str) -> Result<i64, String> {
    connection
        .query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |row| {
            row.get(0)
        })
        .optional()
        .map_err(|error| format!("failed to count {table}: {error}"))?
        .ok_or_else(|| format!("failed to count {table}"))
}

fn default_http_workspaces() -> Vec<HttpWorkspaceDraft> {
    vec![HttpWorkspaceDraft {
        id: "ws-default".to_string(),
        name: "默认工作区".to_string(),
        projects: Vec::new(),
        requests: Vec::new(),
    }]
}

#[cfg(test)]
mod tests {
    use super::HttpWorkspaceStore;
    use crate::domain::http_workspace::{
        HttpAuthDraft, HttpProjectDraft, HttpRequestDraft, HttpWorkspaceDraft,
    };

    #[test]
    fn seeds_default_workspace() {
        let store = HttpWorkspaceStore::in_memory();
        let workspaces = store.list().unwrap();

        assert_eq!(workspaces[0].id, "ws-default");
        assert!(workspaces[0].projects.is_empty());
        assert!(workspaces[0].requests.is_empty());
    }

    #[test]
    fn removes_legacy_seeded_requests_from_default_workspace() {
        let path = test_path("http-workspace-legacy-seed.sqlite");
        let _ = std::fs::remove_file(&path);
        let store = HttpWorkspaceStore::with_path(path.clone());

        store
            .save_all(vec![HttpWorkspaceDraft {
                id: "ws-default".to_string(),
                name: "默认工作区".to_string(),
                projects: vec![HttpProjectDraft {
                    id: "project-default".to_string(),
                    name: "默认项目".to_string(),
                    requests: vec![seeded_request(
                        "req-health",
                        "服务健康检查",
                        "https://api.example.local/health",
                    )],
                }],
                requests: vec![seeded_request(
                    "req-workspace-status",
                    "工作区状态",
                    "https://api.example.local/status",
                )],
            }])
            .unwrap();

        let workspaces = store.list().unwrap();

        assert_eq!(workspaces[0].id, "ws-default");
        assert!(workspaces[0].projects.is_empty());
        assert!(workspaces[0].requests.is_empty());

        let _ = std::fs::remove_file(path);
    }

    fn seeded_request(id: &str, name: &str, url: &str) -> HttpRequestDraft {
        HttpRequestDraft {
            auth: HttpAuthDraft {
                api_key_location: "header".to_string(),
                api_key_name: String::new(),
                api_key_value: String::new(),
                bearer_token: String::new(),
                password: String::new(),
                r#type: "none".to_string(),
                username: String::new(),
            },
            body: String::new(),
            body_mode: "none".to_string(),
            form_body: Vec::new(),
            headers: Vec::new(),
            id: id.to_string(),
            method: "GET".to_string(),
            name: name.to_string(),
            params: Vec::new(),
            url: url.to_string(),
        }
    }

    fn test_path(name: &str) -> std::path::PathBuf {
        std::env::temp_dir().join(format!("portiva-{name}-{}", std::process::id()))
    }
}
