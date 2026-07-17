use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;

use rusqlite::{params, Connection, OptionalExtension};

use crate::domain::http_workspace::{HttpProjectDraft, HttpRequestDraft, HttpWorkspaceDraft};
use crate::utils::{app_paths, clock};

const SCHEMA_VERSION: i32 = 2;

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
        .execute_batch("PRAGMA foreign_keys = ON;")
        .map_err(|error| format!("failed to enable http database foreign keys: {error}"))?;

    if version < 1 {
        connection
            .execute_batch(
                r#"
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
            "#,
            )
            .map_err(|error| format!("failed to migrate http database to version 1: {error}"))?;
    }

    if version < 2 {
        connection
            .execute_batch(
                r#"
                ALTER TABLE http_workspaces ADD COLUMN active_environment_id TEXT;
                ALTER TABLE http_workspaces ADD COLUMN environments_json TEXT NOT NULL DEFAULT '[]';
                ALTER TABLE http_workspaces ADD COLUMN variables_json TEXT NOT NULL DEFAULT '[]';
                ALTER TABLE http_projects ADD COLUMN variables_json TEXT NOT NULL DEFAULT '[]';
                "#,
            )
            .map_err(|error| format!("failed to migrate http database to version 2: {error}"))?;
    }

    connection
        .pragma_update(None, "user_version", SCHEMA_VERSION)
        .map_err(|error| format!("failed to update http database version: {error}"))?;

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
        let environments_json = serde_json::to_string(&workspace.environments)
            .map_err(|error| format!("failed to encode http environments: {error}"))?;
        let workspace_variables_json = serde_json::to_string(&workspace.variables)
            .map_err(|error| format!("failed to encode http workspace variables: {error}"))?;
        transaction
            .execute(
                "INSERT INTO http_workspaces (
                   id, name, sort_order, created_at, updated_at,
                   active_environment_id, environments_json, variables_json
                 ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                params![
                    workspace.id,
                    workspace.name,
                    workspace_index as i64,
                    now,
                    now,
                    workspace.active_environment_id,
                    environments_json,
                    workspace_variables_json
                ],
            )
            .map_err(|error| format!("failed to save http workspace: {error}"))?;

        insert_requests(&transaction, &workspace.id, None, &workspace.requests, &now)?;

        for (project_index, project) in workspace.projects.iter().enumerate() {
            let project_variables_json = serde_json::to_string(&project.variables)
                .map_err(|error| format!("failed to encode http project variables: {error}"))?;
            transaction
                .execute(
                    "INSERT INTO http_projects (
                       id, workspace_id, name, sort_order, created_at, updated_at, variables_json
                     ) VALUES (?, ?, ?, ?, ?, ?, ?)",
                    params![
                        project.id,
                        workspace.id,
                        project.name,
                        project_index as i64,
                        now,
                        now,
                        project_variables_json
                    ],
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
        .prepare(
            "SELECT id, name, active_environment_id, environments_json, variables_json
             FROM http_workspaces ORDER BY sort_order, name",
        )
        .map_err(|error| format!("failed to prepare http workspace query: {error}"))?;
    let workspace_rows = statement
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, Option<String>>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, String>(4)?,
            ))
        })
        .map_err(|error| format!("failed to load http workspaces: {error}"))?;

    let mut workspaces = Vec::new();
    for row in workspace_rows {
        let (workspace_id, name, active_environment_id, environments_json, variables_json) =
            row.map_err(|error| format!("failed to read http workspace: {error}"))?;
        let environments = serde_json::from_str(&environments_json)
            .map_err(|error| format!("failed to decode http environments: {error}"))?;
        let variables = serde_json::from_str(&variables_json)
            .map_err(|error| format!("failed to decode http workspace variables: {error}"))?;
        let projects = load_projects(connection, &workspace_id)?;
        let requests = load_requests(connection, &workspace_id, None)?;
        workspaces.push(HttpWorkspaceDraft {
            active_environment_id,
            environments,
            id: workspace_id,
            name,
            projects,
            requests,
            variables,
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
            "SELECT id, name, variables_json FROM http_projects
             WHERE workspace_id = ? ORDER BY sort_order, name",
        )
        .map_err(|error| format!("failed to prepare http project query: {error}"))?;
    let project_rows = statement
        .query_map(params![workspace_id], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
            ))
        })
        .map_err(|error| format!("failed to load http projects: {error}"))?;

    let mut projects = Vec::new();
    for row in project_rows {
        let (project_id, name, variables_json) =
            row.map_err(|error| format!("failed to read http project: {error}"))?;
        let variables = serde_json::from_str(&variables_json)
            .map_err(|error| format!("failed to decode http project variables: {error}"))?;
        let requests = load_requests(connection, workspace_id, Some(&project_id))?;
        projects.push(HttpProjectDraft {
            id: project_id,
            name,
            requests,
            variables,
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
        active_environment_id: None,
        environments: Vec::new(),
        id: "ws-default".to_string(),
        name: "默认工作区".to_string(),
        projects: Vec::new(),
        requests: Vec::new(),
        variables: Vec::new(),
    }]
}

#[cfg(test)]
mod tests {
    use super::HttpWorkspaceStore;
    use crate::domain::http_workspace::{
        HttpAuthDraft, HttpEnvironmentDraft, HttpKeyValueEntry, HttpProjectDraft, HttpRequestDraft,
        HttpWorkspaceDraft,
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
                active_environment_id: None,
                environments: Vec::new(),
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
                    variables: Vec::new(),
                }],
                requests: vec![seeded_request(
                    "req-workspace-status",
                    "工作区状态",
                    "https://api.example.local/status",
                )],
                variables: Vec::new(),
            }])
            .unwrap();

        let workspaces = store.list().unwrap();

        assert_eq!(workspaces[0].id, "ws-default");
        assert!(workspaces[0].projects.is_empty());
        assert!(workspaces[0].requests.is_empty());

        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn preserves_workspace_variable_scopes_and_sensitive_flags() {
        let path = test_path("http-workspace-variable-roundtrip.sqlite");
        let _ = std::fs::remove_file(&path);
        let store = HttpWorkspaceStore::with_path(path.clone());
        let variable = HttpKeyValueEntry {
            description: Some("令牌".to_string()),
            enabled: true,
            file_name: None,
            file_size: None,
            file_type: None,
            form_value_type: None,
            key: "token".to_string(),
            sensitive: Some(true),
            value: "plaintext-by-user-choice".to_string(),
        };
        let request = HttpRequestDraft {
            temp_variables: vec![variable.clone()],
            ..seeded_request("request", "请求", "https://example.com")
        };
        let expected = HttpWorkspaceDraft {
            active_environment_id: Some("environment".to_string()),
            environments: vec![HttpEnvironmentDraft {
                id: "environment".to_string(),
                name: "开发环境".to_string(),
                variables: vec![variable.clone()],
            }],
            id: "workspace".to_string(),
            name: "工作区".to_string(),
            projects: vec![HttpProjectDraft {
                id: "project".to_string(),
                name: "项目".to_string(),
                requests: vec![request],
                variables: vec![variable.clone()],
            }],
            requests: Vec::new(),
            variables: vec![variable],
        };

        let saved = store.save_all(vec![expected]).unwrap();
        let serialized = serde_json::to_value(&saved[0]).unwrap();

        assert_eq!(serialized["activeEnvironmentId"], "environment");
        assert_eq!(serialized["variables"][0]["sensitive"], true);
        assert_eq!(
            serialized["environments"][0]["variables"][0]["key"],
            "token"
        );
        assert_eq!(serialized["projects"][0]["variables"][0]["key"], "token");
        assert_eq!(
            serialized["projects"][0]["requests"][0]["tempVariables"][0]["key"],
            "token"
        );

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
            temp_variables: Vec::new(),
            url: url.to_string(),
        }
    }

    fn test_path(name: &str) -> std::path::PathBuf {
        std::env::temp_dir().join(format!("portiva-{name}-{}", std::process::id()))
    }
}
