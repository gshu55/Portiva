import { useEffect, useMemo, useRef, useState } from "react";
import type { DragEvent, MouseEvent } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
import { httpCancel, httpSendStream, httpWorkspacesGet, httpWorkspacesSave } from "../../shared/ipc/commands";
import type { HttpSendMultipartPart, HttpSendRequest, HttpSendResponse } from "../../shared/ipc/commands";
import { Icon } from "../../shared/Icon";
import { Button, ConfirmDialog, IconButton, Select, Tag, TextArea, TextInput } from "../../shared/ui";
import { HttpTreeCreateAction, HttpTreeItem } from "./HttpTreeItem";
import {
  formatHttpByteLimit,
  HTTP_FILE_UPLOAD_MAX_BYTES,
  HTTP_RESPONSE_MAX_BYTES,
  HTTP_STREAM_PREVIEW_MAX_CHARS,
} from "./httpLimits";
import type {
  HttpTreeDndHandlers,
  HttpTreeDragPayload,
  HttpTreeDropPosition,
  HttpTreeDropType,
  HttpTreeDropTarget,
  HttpTreeDropTargetBase,
  HttpTreePointerDragState,
} from "./HttpTreeItem";

type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "HEAD" | "OPTIONS";
type RequestSection = "params" | "headers" | "body" | "auth" | "preview";
type MainView = "blank" | "request" | "environment" | "share";
type ResponseView = "body" | "headers" | "history";
type ShareView = "export" | "import";
type ImportTarget = "current" | "new";
type ImportConflictMode = "overwrite" | "ignore";
type VariableScope = "workspace" | "project" | "environment" | "request-temp";
type TreeNodeType = "workspace" | "project" | "request";
type RequestRowField = "formBody" | "headers" | "params";
type FormValueType = "text" | "file";
type KeyValueEntry = {
  description?: string;
  enabled: boolean;
  fileName?: string;
  fileSize?: number;
  fileType?: string;
  formValueType?: FormValueType;
  key: string;
  localFileId?: string;
  sensitive?: boolean;
  value: string;
};
type BodyMode = "none" | "json" | "text" | "form";
type AuthType = "none" | "bearer" | "basic" | "api-key";
type ApiKeyLocation = "header" | "query";

interface HttpAuthDraft {
  apiKeyLocation: ApiKeyLocation;
  apiKeyName: string;
  apiKeyValue: string;
  bearerToken: string;
  password: string;
  type: AuthType;
  username: string;
}

interface HttpRequestDraft {
  auth: HttpAuthDraft;
  body: string;
  bodyMode: BodyMode;
  formBody: KeyValueEntry[];
  headers: KeyValueEntry[];
  id: string;
  method: HttpMethod;
  name: string;
  params: KeyValueEntry[];
  tempVariables?: KeyValueEntry[];
  url: string;
}

interface HttpProjectDraft {
  id: string;
  name: string;
  requests: HttpRequestDraft[];
  variables?: KeyValueEntry[];
}

interface HttpEnvironmentDraft {
  id: string;
  name: string;
  variables: KeyValueEntry[];
}

interface HttpWorkspaceDraft {
  activeEnvironmentId?: string | null;
  environments?: HttpEnvironmentDraft[];
  id: string;
  name: string;
  projects: HttpProjectDraft[];
  requests: HttpRequestDraft[];
  variables?: KeyValueEntry[];
}

interface HttpWorkspaceShareDocument {
  exportedAt: string;
  kind: "portiva.http.workspace";
  version: 1;
  workspace: HttpWorkspaceDraft;
}

interface HttpShareRequestOption {
  id: string;
  projectId: string | null;
  projectName: string;
  request: HttpRequestDraft;
}

interface HttpImportMergeResult {
  added: number;
  ignored: number;
  importedRequestIds: string[];
  overwritten: number;
  workspace: HttpWorkspaceDraft;
}

interface HttpResponsePreview {
  body: string;
  bodyKind: HttpSendResponse["bodyKind"];
  durationMs: number;
  headers: Record<string, string>;
  sizeBytes: number;
  status: number;
  statusText: string;
  url: string;
}

interface HttpResponseHistoryEntry {
  error?: string;
  id: string;
  method: HttpMethod;
  name: string;
  response?: HttpResponsePreview;
  timestamp: number;
  url: string;
}

interface HttpStreamChunkPayload {
  bodyKind: HttpResponsePreview["bodyKind"];
  chunk: string;
  requestId: string;
  sizeBytes: number;
}

interface ActiveHttpSendState {
  abortController: AbortController;
  requestId: string;
}

interface HttpContextMenuState {
  projectId?: string;
  requestId?: string;
  type: TreeNodeType | "tree";
  workspaceId?: string;
  x: number;
  y: number;
}

interface EditingNodeState {
  id: string;
  type: TreeNodeType;
  value: string;
}

interface HttpTreeDragPreviewState {
  drag: HttpTreeDragPayload;
  x: number;
  y: number;
}

type HttpDeleteConfirmState =
  | { name: string; type: "workspace"; workspaceId: string }
  | { name: string; projectId: string; type: "project"; workspaceId: string }
  | { name: string; projectId: string | null; requestId: string; type: "request"; workspaceId: string }
  | { environmentId: string; name: string; type: "environment" }
  | null;

function getDeleteConfirmContent(target: Exclude<HttpDeleteConfirmState, null>) {
  if (target.type === "workspace") {
    return {
      description: `确定删除工作区「${target.name}」？该操作不可撤销。`,
      title: "删除工作区",
    };
  }

  if (target.type === "project") {
    return {
      description: `确定删除项目「${target.name}」？项目下的请求也会删除。`,
      title: "删除项目",
    };
  }

  if (target.type === "request") {
    return {
      description: `确定删除请求「${target.name}」？该操作不可撤销。`,
      title: "删除请求",
    };
  }

  return {
    description: `确定删除环境「${target.name}」？环境变量也会删除。`,
    title: "删除环境",
  };
}

const httpTreeDragMimeType = "application/x-portiva-http-tree-node";
const httpWorkspaceShareKind = "portiva.http.workspace";
const httpWorkspaceShareVersion = 1;

const defaultWorkspaces: HttpWorkspaceDraft[] = [
  {
    activeEnvironmentId: "env-default",
    environments: [
      {
        id: "env-default",
        name: "默认环境",
        variables: [
          { enabled: true, key: "baseUrl", value: "https://api.example.local", description: "API 根地址" },
          { enabled: true, key: "token", value: "", description: "Bearer Token" },
          { enabled: true, key: "password", value: "", description: "示例密码" },
        ],
      },
    ],
    id: "ws-default",
    name: "默认工作区",
    projects: [],
    requests: [],
  },
];
const initialWorkspace = defaultWorkspaces[0];
const initialProject = initialWorkspace.projects[0] ?? null;
const initialRequest = initialWorkspace.requests[0] ?? initialProject?.requests[0] ?? null;
const httpMethods: HttpMethod[] = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"];
const httpMethodOptions: Array<{ label: HttpMethod; value: HttpMethod }> = httpMethods.map((method) => ({
  label: method,
  value: method,
}));
const bodyModeOptions: Array<{ label: string; value: BodyMode }> = [
  { label: "无", value: "none" },
  { label: "JSON", value: "json" },
  { label: "文本", value: "text" },
  { label: "表单", value: "form" },
];
const authTypeOptions: Array<{ label: string; value: AuthType }> = [
  { label: "无认证", value: "none" },
  { label: "Bearer Token", value: "bearer" },
  { label: "Basic Auth", value: "basic" },
  { label: "API Key", value: "api-key" },
];
const apiKeyLocationOptions: Array<{ label: string; value: ApiKeyLocation }> = [
  { label: "请求头", value: "header" },
  { label: "Query 参数", value: "query" },
];
const variableScopeOptions: Array<{ label: string; value: VariableScope }> = [
  { label: "工作区", value: "workspace" },
  { label: "项目", value: "project" },
  { label: "环境", value: "environment" },
  { label: "请求", value: "request-temp" },
];
const variableScopePriority: VariableScope[] = ["workspace", "project", "environment", "request-temp"];
const emptyVariableDrafts: Record<VariableScope, KeyValueEntry> = {
  environment: { ...createBlankRow(), enabled: false },
  project: { ...createBlankRow(), enabled: false },
  "request-temp": { ...createBlankRow(), enabled: false },
  workspace: { ...createBlankRow(), enabled: false },
};
const emptyRequestDraftRows: Record<RequestRowField, KeyValueEntry> = {
  formBody: { ...createBlankRow(), enabled: false, formValueType: "text" },
  headers: { ...createBlankRow(), enabled: false },
  params: { ...createBlankRow(), enabled: false },
};

function createDefaultAuth(): HttpAuthDraft {
  return {
    apiKeyLocation: "header",
    apiKeyName: "",
    apiKeyValue: "",
    bearerToken: "",
    password: "",
    type: "none",
    username: "",
  };
}

function createBlankRow(): KeyValueEntry {
  return {
    description: "",
    enabled: true,
    key: "",
    sensitive: false,
    value: "",
  };
}

function hasKeyValueContent(row: KeyValueEntry) {
  return Boolean(row.key.trim() || row.value.trim() || row.fileName?.trim() || (row.description ?? "").trim());
}

function trimTrailingBlankRows(rows: KeyValueEntry[]) {
  const nextRows = [...rows];

  while (nextRows.length > 0 && !hasKeyValueContent(nextRows[nextRows.length - 1])) {
    nextRows.pop();
  }

  return nextRows;
}

function createDefaultEnvironment(): HttpEnvironmentDraft {
  return {
    id: makeId("env"),
    name: "默认环境",
    variables: [],
  };
}

function normalizeWorkspace(workspace: HttpWorkspaceDraft): HttpWorkspaceDraft {
  const environments = workspace.environments?.length ? workspace.environments : [createDefaultEnvironment()];
  const activeEnvironmentId =
    workspace.activeEnvironmentId && environments.some((environment) => environment.id === workspace.activeEnvironmentId)
      ? workspace.activeEnvironmentId
      : environments[0]?.id ?? null;

  return {
    ...workspace,
    activeEnvironmentId,
    environments,
  };
}

function normalizeWorkspaces(workspaces: HttpWorkspaceDraft[]) {
  return workspaces.map(normalizeWorkspace);
}

function scopedVariableRows(
  workspace: HttpWorkspaceDraft,
  project: HttpProjectDraft | null,
  environment: HttpEnvironmentDraft | null,
  request: HttpRequestDraft | null,
) {
  return {
    environment: environment?.variables ?? [],
    project: project?.variables ?? [],
    "request-temp": request?.tempVariables ?? [],
    workspace: workspace.variables ?? [],
  } satisfies Record<VariableScope, KeyValueEntry[]>;
}

function variableMapByScope(rowsByScope: Record<VariableScope, KeyValueEntry[]>) {
  const variables = new Map<string, string>();

  for (const scope of variableScopePriority) {
    for (const entry of rowsByScope[scope]) {
      if (entry.enabled && entry.key.trim()) {
        variables.set(entry.key.trim(), entry.value);
      }
    }
  }

  return variables;
}

function resolveVariables(value: string, variables: Map<string, string>) {
  return value.replace(/\{\{\s*([\w.-]+)\s*\}\}/g, (match, key: string) =>
    variables.has(key) ? variables.get(key) ?? "" : match,
  );
}

function missingVariables(value: string, variables: Map<string, string>) {
  const missing = new Set<string>();
  value.replace(/\{\{\s*([\w.-]+)\s*\}\}/g, (_match, key: string) => {
    if (!variables.has(key)) {
      missing.add(key);
    }

    return "";
  });

  return Array.from(missing);
}

function missingRequestVariables(request: HttpRequestDraft, variables: Map<string, string>) {
  const values = [
    request.url,
    request.body,
    request.auth.apiKeyName,
    request.auth.apiKeyValue,
    request.auth.bearerToken,
    request.auth.password,
    request.auth.username,
    ...request.params.flatMap((entry) => [entry.key, entry.value]),
    ...request.headers.flatMap((entry) => [entry.key, entry.value]),
    ...request.formBody.flatMap((entry) => (formValueTypeFor(entry) === "file" ? [entry.key] : [entry.key, entry.value])),
  ];

  return Array.from(new Set(values.flatMap((value) => missingVariables(value, variables))));
}

function resolveRowVariables(row: KeyValueEntry, variables: Map<string, string>): KeyValueEntry {
  return {
    ...row,
    key: resolveVariables(row.key, variables),
    value: resolveVariables(row.value, variables),
  };
}

function makeId(prefix: string) {
  return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
}

function methodClass(method: HttpMethod) {
  return `http-method http-method-${method.toLowerCase()}`;
}

function uniqueName(existingNames: string[], baseName: string) {
  const usedNames = new Set(existingNames.map((name) => name.trim()).filter(Boolean));

  if (!usedNames.has(baseName)) {
    return baseName;
  }

  for (let index = 2; index < 1000; index += 1) {
    const nextName = `${baseName} ${index}`;
    if (!usedNames.has(nextName)) {
      return nextName;
    }
  }

  return `${baseName} ${Date.now()}`;
}

function treeDropPositionFromEvent(event: DragEvent<HTMLElement>): HttpTreeDropPosition {
  const bounds = event.currentTarget.getBoundingClientRect();
  return event.clientY < bounds.top + bounds.height / 2 ? "before" : "after";
}

function createBlankRequest(name = "新建请求"): HttpRequestDraft {
  return {
    auth: createDefaultAuth(),
    body: "",
    bodyMode: "none",
    formBody: [],
    headers: [{ enabled: true, key: "Accept", value: "application/json" }],
    id: makeId("req"),
    method: "GET",
    name,
    params: [],
    tempVariables: [],
    url: "",
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function textValue(value: unknown, fallback = "") {
  return typeof value === "string" ? value : fallback;
}

function booleanValue(value: unknown, fallback: boolean) {
  return typeof value === "boolean" ? value : fallback;
}

function numberValue(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function formValueTypeFor(row: KeyValueEntry): FormValueType {
  return row.formValueType === "file" ? "file" : "text";
}

function normalizeImportedRows(value: unknown): KeyValueEntry[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.flatMap((entry) => {
    if (!isRecord(entry)) {
      return [];
    }

    return [
      {
        description: textValue(entry.description),
        enabled: booleanValue(entry.enabled, true),
        fileName: textValue(entry.fileName) || undefined,
        fileSize: numberValue(entry.fileSize),
        fileType: textValue(entry.fileType) || undefined,
        formValueType: textValue(entry.formValueType) === "file" ? "file" : undefined,
        key: textValue(entry.key),
        sensitive: booleanValue(entry.sensitive, false),
        value: textValue(entry.value),
      },
    ];
  });
}

function normalizeImportedAuth(value: unknown): HttpAuthDraft {
  const auth = isRecord(value) ? value : {};
  const authType = textValue(auth.type);
  const apiKeyLocation = textValue(auth.apiKeyLocation);

  return {
    apiKeyLocation: apiKeyLocation === "query" ? "query" : "header",
    apiKeyName: textValue(auth.apiKeyName),
    apiKeyValue: textValue(auth.apiKeyValue),
    bearerToken: textValue(auth.bearerToken),
    password: textValue(auth.password),
    type: authTypeOptions.some((option) => option.value === authType) ? (authType as AuthType) : "none",
    username: textValue(auth.username),
  };
}

function normalizeImportedRequest(value: unknown): HttpRequestDraft | null {
  if (!isRecord(value)) {
    return null;
  }

  const method = textValue(value.method);
  const bodyMode = textValue(value.bodyMode);

  return {
    auth: normalizeImportedAuth(value.auth),
    body: textValue(value.body),
    bodyMode: bodyModeOptions.some((option) => option.value === bodyMode) ? (bodyMode as BodyMode) : "none",
    formBody: normalizeImportedRows(value.formBody),
    headers: normalizeImportedRows(value.headers),
    id: makeId("req"),
    method: httpMethods.includes(method as HttpMethod) ? (method as HttpMethod) : "GET",
    name: textValue(value.name, "导入请求"),
    params: normalizeImportedRows(value.params),
    tempVariables: normalizeImportedRows(value.tempVariables),
    url: textValue(value.url),
  };
}

function normalizeImportedProject(value: unknown): HttpProjectDraft | null {
  if (!isRecord(value)) {
    return null;
  }

  return {
    id: makeId("project"),
    name: textValue(value.name, "导入项目"),
    requests: Array.isArray(value.requests) ? value.requests.flatMap((request) => normalizeImportedRequest(request) ?? []) : [],
    variables: normalizeImportedRows(value.variables),
  };
}

function normalizeImportedEnvironment(value: unknown, idMap: Map<string, string>): HttpEnvironmentDraft | null {
  if (!isRecord(value)) {
    return null;
  }

  const importedId = makeId("env");
  const sourceId = textValue(value.id);
  if (sourceId) {
    idMap.set(sourceId, importedId);
  }

  return {
    id: importedId,
    name: textValue(value.name, "导入环境"),
    variables: normalizeImportedRows(value.variables),
  };
}

function normalizeImportedWorkspace(value: unknown, existingNames: string[]): HttpWorkspaceDraft {
  if (!isRecord(value)) {
    throw new Error("JSON 中缺少 workspace 对象。");
  }

  const environmentIdMap = new Map<string, string>();
  const environments = Array.isArray(value.environments)
    ? value.environments.flatMap((environment) => normalizeImportedEnvironment(environment, environmentIdMap) ?? [])
    : [];
  const activeEnvironmentId = environmentIdMap.get(textValue(value.activeEnvironmentId)) ?? environments[0]?.id ?? null;
  const baseName = textValue(value.name, "导入工作区");

  return normalizeWorkspace({
    activeEnvironmentId,
    environments,
    id: makeId("ws"),
    name: uniqueName(existingNames, `${baseName} 导入`),
    projects: Array.isArray(value.projects) ? value.projects.flatMap((project) => normalizeImportedProject(project) ?? []) : [],
    requests: Array.isArray(value.requests) ? value.requests.flatMap((request) => normalizeImportedRequest(request) ?? []) : [],
    variables: normalizeImportedRows(value.variables),
  });
}

function parseWorkspaceShareJson(json: string, existingNames: string[]) {
  let parsed: unknown;

  try {
    parsed = JSON.parse(json);
  } catch {
    throw new Error("JSON 格式无效。");
  }

  if (!isRecord(parsed)) {
    throw new Error("JSON 根节点必须是对象。");
  }

  if (parsed.kind !== httpWorkspaceShareKind) {
    throw new Error("不是 Portiva HTTP 工作区分享文件。");
  }

  if (parsed.version !== httpWorkspaceShareVersion) {
    throw new Error(`不支持的分享版本：${String(parsed.version)}`);
  }

  return normalizeImportedWorkspace(parsed.workspace, existingNames);
}

function requestUrlKey(request: HttpRequestDraft) {
  return request.url.trim();
}

function requestLocationById(workspace: HttpWorkspaceDraft, requestId: string) {
  if (workspace.requests.some((request) => request.id === requestId)) {
    return { projectId: null, requestId };
  }

  for (const project of workspace.projects) {
    if (project.requests.some((request) => request.id === requestId)) {
      return { projectId: project.id, requestId };
    }
  }

  return null;
}

function mergeImportedWorkspaceIntoCurrent(
  currentWorkspace: HttpWorkspaceDraft,
  importedWorkspace: HttpWorkspaceDraft,
  conflictMode: ImportConflictMode,
): HttpImportMergeResult {
  const existingRequestIdByUrl = new Map<string, string>();

  currentWorkspace.requests.forEach((request) => {
    const key = requestUrlKey(request);
    if (key && !existingRequestIdByUrl.has(key)) {
      existingRequestIdByUrl.set(key, request.id);
    }
  });
  currentWorkspace.projects.forEach((project) => {
    project.requests.forEach((request) => {
      const key = requestUrlKey(request);
      if (key && !existingRequestIdByUrl.has(key)) {
        existingRequestIdByUrl.set(key, request.id);
      }
    });
  });

  const overwrittenRequests = new Map<string, HttpRequestDraft>();
  const importedRequestIds: string[] = [];
  let added = 0;
  let ignored = 0;
  let overwritten = 0;

  const resolveImportedRequest = (request: HttpRequestDraft) => {
    const key = requestUrlKey(request);
    const existingRequestId = key ? existingRequestIdByUrl.get(key) : undefined;

    if (existingRequestId) {
      if (conflictMode === "overwrite") {
        overwrittenRequests.set(existingRequestId, { ...request, id: existingRequestId });
        importedRequestIds.push(existingRequestId);
        overwritten += 1;
      } else {
        ignored += 1;
      }

      return null;
    }

    importedRequestIds.push(request.id);
    added += 1;
    return request;
  };

  const importedWorkspaceRequests = importedWorkspace.requests.flatMap((request) => resolveImportedRequest(request) ?? []);
  const currentProjectNames = currentWorkspace.projects.map((project) => project.name);
  const importedProjects = importedWorkspace.projects.flatMap((project) => {
    const requests = project.requests.flatMap((request) => resolveImportedRequest(request) ?? []);
    const variables = project.variables ?? [];

    if (requests.length === 0 && variables.length === 0) {
      return [];
    }

    const projectName = uniqueName(currentProjectNames, project.name);
    currentProjectNames.push(projectName);
    return [
      {
        ...project,
        name: projectName,
        requests,
      },
    ];
  });

  const replaceRequest = (request: HttpRequestDraft) => overwrittenRequests.get(request.id) ?? request;
  const workspace = normalizeWorkspace({
    ...currentWorkspace,
    environments: [...(currentWorkspace.environments ?? []), ...(importedWorkspace.environments ?? [])],
    projects: [
      ...currentWorkspace.projects.map((project) => ({
        ...project,
        requests: project.requests.map(replaceRequest),
      })),
      ...importedProjects,
    ],
    requests: [...currentWorkspace.requests.map(replaceRequest), ...importedWorkspaceRequests],
    variables: [...(currentWorkspace.variables ?? []), ...(importedWorkspace.variables ?? [])],
  });

  return {
    added,
    ignored,
    importedRequestIds,
    overwritten,
    workspace,
  };
}

function collectShareRequestOptions(workspace: HttpWorkspaceDraft): HttpShareRequestOption[] {
  return [
    ...workspace.requests.map((request) => ({
      id: request.id,
      projectId: null,
      projectName: "工作区",
      request,
    })),
    ...workspace.projects.flatMap((project) =>
      project.requests.map((request) => ({
        id: request.id,
        projectId: project.id,
        projectName: project.name,
        request,
      })),
    ),
  ];
}

function stripLocalFormFileStateFromRows(rows: KeyValueEntry[] | undefined): KeyValueEntry[] {
  return (rows ?? []).map((row) => {
    const persistedRow = { ...row };
    delete persistedRow.localFileId;
    return persistedRow;
  });
}

function stripLocalFormFileStateFromRequest(request: HttpRequestDraft): HttpRequestDraft {
  return {
    ...request,
    formBody: stripLocalFormFileStateFromRows(request.formBody),
    headers: stripLocalFormFileStateFromRows(request.headers),
    params: stripLocalFormFileStateFromRows(request.params),
    tempVariables: stripLocalFormFileStateFromRows(request.tempVariables),
  };
}

function stripLocalFormFileStateFromWorkspace(workspace: HttpWorkspaceDraft): HttpWorkspaceDraft {
  return {
    ...workspace,
    environments: workspace.environments?.map((environment) => ({
      ...environment,
      variables: stripLocalFormFileStateFromRows(environment.variables),
    })),
    projects: workspace.projects.map((project) => ({
      ...project,
      requests: project.requests.map(stripLocalFormFileStateFromRequest),
      variables: stripLocalFormFileStateFromRows(project.variables),
    })),
    requests: workspace.requests.map(stripLocalFormFileStateFromRequest),
    variables: stripLocalFormFileStateFromRows(workspace.variables),
  };
}

function stripLocalFormFileStateFromWorkspaces(workspaces: HttpWorkspaceDraft[]) {
  return workspaces.map(stripLocalFormFileStateFromWorkspace);
}

function buildShareWorkspace(workspace: HttpWorkspaceDraft, selectedRequestIds: Set<string>): HttpWorkspaceDraft {
  return stripLocalFormFileStateFromWorkspace({
    ...workspace,
    projects: workspace.projects
      .map((project) => ({
        ...project,
        requests: project.requests.filter((request) => selectedRequestIds.has(request.id)),
      }))
      .filter((project) => project.requests.length > 0),
    requests: workspace.requests.filter((request) => selectedRequestIds.has(request.id)),
  });
}

function buildWorkspaceShareJson(workspace: HttpWorkspaceDraft, selectedRequestIds: Set<string>) {
  const document: HttpWorkspaceShareDocument = {
    exportedAt: new Date().toISOString(),
    kind: httpWorkspaceShareKind,
    version: httpWorkspaceShareVersion,
    workspace: buildShareWorkspace(workspace, selectedRequestIds),
  };

  return JSON.stringify(document, null, 2);
}

function appendEnabledQueryParams(url: string, params: KeyValueEntry[]) {
  const enabledParams = enabledRows(params);

  if (!url || enabledParams.length === 0) {
    return url;
  }

  try {
    const parsedUrl = new URL(url);
    enabledParams.forEach((entry) => parsedUrl.searchParams.append(entry.key.trim(), entry.value));
    return parsedUrl.toString();
  } catch {
    const query = new URLSearchParams();
    enabledParams.forEach((entry) => query.append(entry.key.trim(), entry.value));
    return `${url}${url.includes("?") ? "&" : "?"}${query.toString()}`;
  }
}

function enabledRows(rows: KeyValueEntry[]) {
  return rows.filter((entry) => entry.enabled && entry.key.trim());
}

function appendHttpStreamPreview(current: string, chunk: string) {
  const remaining = HTTP_STREAM_PREVIEW_MAX_CHARS - current.length;
  return remaining > 0 ? `${current}${chunk.slice(0, remaining)}` : current;
}

function hasHeader(headers: KeyValueEntry[], key: string) {
  const normalizedKey = key.toLowerCase();
  return enabledRows(headers).some((entry) => entry.key.trim().toLowerCase() === normalizedKey);
}

function encodeBasicCredentials(username: string, password: string) {
  try {
    return btoa(`${username}:${password}`);
  } catch {
    return "";
  }
}

function authHeaderRows(auth: HttpAuthDraft, variables: Map<string, string>): KeyValueEntry[] {
  if (auth.type === "bearer" && auth.bearerToken.trim()) {
    return [{ enabled: true, key: "Authorization", value: `Bearer ${resolveVariables(auth.bearerToken.trim(), variables)}` }];
  }

  if (auth.type === "basic" && (auth.username || auth.password)) {
    const encodedCredentials = encodeBasicCredentials(resolveVariables(auth.username, variables), resolveVariables(auth.password, variables));
    return encodedCredentials ? [{ enabled: true, key: "Authorization", value: `Basic ${encodedCredentials}` }] : [];
  }

  if (auth.type === "api-key" && auth.apiKeyLocation === "header" && auth.apiKeyName.trim()) {
    return [{
      enabled: true,
      key: resolveVariables(auth.apiKeyName.trim(), variables),
      value: resolveVariables(auth.apiKeyValue, variables),
    }];
  }

  return [];
}

function requestUsesMultipart(request: HttpRequestDraft) {
  return request.bodyMode === "form" && enabledRows(request.formBody).some((entry) => formValueTypeFor(entry) === "file");
}

function bodyContentType(request: HttpRequestDraft) {
  if (request.method === "GET" || request.method === "HEAD" || request.bodyMode === "none") {
    return null;
  }

  if (request.bodyMode === "json") {
    return "application/json";
  }

  if (request.bodyMode === "text") {
    return "text/plain; charset=utf-8";
  }

  if (requestUsesMultipart(request)) {
    return null;
  }

  return "application/x-www-form-urlencoded";
}

function requestHeaderRows(request: HttpRequestDraft, variables: Map<string, string>) {
  const headers = [
    ...enabledRows(request.headers).map((entry) => resolveRowVariables(entry, variables)),
    ...authHeaderRows(request.auth, variables),
  ];
  const contentType = bodyContentType(request);

  if (contentType && !hasHeader(headers, "Content-Type")) {
    headers.push({ enabled: true, key: "Content-Type", value: contentType });
  }

  return headers
    .filter((entry) => !(requestUsesMultipart(request) && entry.key.trim().toLowerCase() === "content-type"))
    .map((entry) => ({ key: entry.key.trim(), value: entry.value }));
}

function requestBodyFor(request: HttpRequestDraft, variables: Map<string, string>) {
  if (request.method === "GET" || request.method === "HEAD" || request.bodyMode === "none") {
    return undefined;
  }

  if (request.bodyMode === "form") {
    if (requestUsesMultipart(request)) {
      return undefined;
    }

    const body = new URLSearchParams();
    enabledRows(request.formBody)
      .filter((entry) => formValueTypeFor(entry) === "text")
      .map((entry) => resolveRowVariables(entry, variables))
      .forEach((entry) => body.append(entry.key.trim(), entry.value));
    const bodyText = body.toString();
    return bodyText || undefined;
  }

  return request.body.length > 0 ? resolveVariables(request.body, variables) : undefined;
}

type HttpFileWorkerResponse =
  | {
      base64: string;
      id: string;
      ok: true;
    }
  | {
      error: string;
      id: string;
      ok: false;
    };

function arrayBufferToBase64(buffer: ArrayBuffer) {
  const bytes = new Uint8Array(buffer);
  const chunkSize = 0x8000;
  let binary = "";

  for (let index = 0; index < bytes.length; index += chunkSize) {
    const chunk = bytes.subarray(index, index + chunkSize);
    binary += String.fromCharCode(...chunk);
  }

  return btoa(binary);
}

function base64ToUint8Array(base64: string) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);

  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }

  return bytes;
}

async function fileToBase64OnMainThread(file: File, signal?: AbortSignal) {
  if (file.size > HTTP_FILE_UPLOAD_MAX_BYTES) {
    throw new Error(`单个上传文件不能超过 ${formatHttpByteLimit(HTTP_FILE_UPLOAD_MAX_BYTES)}。`);
  }

  if (signal?.aborted) {
    throw new Error("请求已取消。");
  }

  const base64 = arrayBufferToBase64(await file.arrayBuffer());
  if (signal?.aborted) {
    throw new Error("请求已取消。");
  }

  return base64;
}

function fileToBase64(file: File, signal?: AbortSignal) {
  if (typeof Worker === "undefined") {
    return fileToBase64OnMainThread(file, signal);
  }

  try {
    const worker = new Worker(new URL("./httpFileWorker.ts", import.meta.url), { type: "module" });
    const id = makeId("http-file-read");

    return new Promise<string>((resolve, reject) => {
      const abort = () => {
        cleanup();
        reject(new Error("请求已取消。"));
      };
      const cleanup = () => {
        signal?.removeEventListener("abort", abort);
        worker.onmessage = null;
        worker.onerror = null;
        worker.onmessageerror = null;
        worker.terminate();
      };

      if (signal?.aborted) {
        abort();
        return;
      }

      signal?.addEventListener("abort", abort, { once: true });

      worker.onmessage = (event: MessageEvent<HttpFileWorkerResponse>) => {
        const payload = event.data;
        if (payload.id !== id) {
          return;
        }

        cleanup();
        if (payload.ok) {
          resolve(payload.base64);
          return;
        }

        reject(new Error(payload.error));
      };

      worker.onerror = (event) => {
        cleanup();
        reject(new Error(event.message || "文件读取失败。"));
      };

      worker.onmessageerror = () => {
        cleanup();
        reject(new Error("文件读取结果无法解析。"));
      };

      try {
        worker.postMessage({ file, id });
      } catch (error) {
        cleanup();
        reject(error instanceof Error ? error : new Error("文件读取失败。"));
      }
    });
  } catch {
    return fileToBase64OnMainThread(file, signal);
  }
}

async function requestMultipartFor(
  request: HttpRequestDraft,
  variables: Map<string, string>,
  formFiles: Map<string, File>,
  signal?: AbortSignal,
): Promise<HttpSendMultipartPart[] | undefined> {
  if (request.method === "GET" || request.method === "HEAD" || request.bodyMode !== "form" || !requestUsesMultipart(request)) {
    return undefined;
  }

  const parts: HttpSendMultipartPart[] = [];

  for (const entry of enabledRows(request.formBody)) {
    const name = resolveVariables(entry.key.trim(), variables).trim();
    if (!name) {
      continue;
    }

    if (formValueTypeFor(entry) === "file") {
      const file = entry.localFileId ? formFiles.get(entry.localFileId) : undefined;
      if (!file) {
        throw new Error(`文件字段「${entry.key.trim()}」需要重新选择文件。`);
      }

      if (file.size > HTTP_FILE_UPLOAD_MAX_BYTES) {
        throw new Error(
          `文件「${file.name}」超过 ${formatHttpByteLimit(HTTP_FILE_UPLOAD_MAX_BYTES)} 上限。`,
        );
      }

      parts.push({
        bytesBase64: await fileToBase64(file, signal),
        contentType: file.type || entry.fileType || "application/octet-stream",
        fileName: entry.fileName || file.name,
        kind: "file",
        name,
      });
      continue;
    }

    parts.push({
      kind: "text",
      name,
      value: resolveVariables(entry.value, variables),
    });
  }

  return parts.length > 0 ? parts : undefined;
}

function requestUrlFor(request: HttpRequestDraft, variables: Map<string, string>) {
  const params = [...request.params].map((entry) => resolveRowVariables(entry, variables));

  if (request.auth.type === "api-key" && request.auth.apiKeyLocation === "query" && request.auth.apiKeyName.trim()) {
    params.push({
      enabled: true,
      key: resolveVariables(request.auth.apiKeyName.trim(), variables),
      value: resolveVariables(request.auth.apiKeyValue, variables),
    });
  }

  return appendEnabledQueryParams(resolveVariables(request.url.trim(), variables), params);
}

function buildHttpPayload(
  request: HttpRequestDraft,
  variables = new Map<string, string>(),
  multipart?: HttpSendMultipartPart[],
): HttpSendRequest {
  return {
    body: multipart ? undefined : requestBodyFor(request, variables),
    headers: requestHeaderRows(request, variables),
    method: request.method,
    multipart,
    timeoutMs: 30_000,
    url: requestUrlFor(request, variables),
  };
}

async function buildHttpPayloadForSend(
  request: HttpRequestDraft,
  variables: Map<string, string>,
  formFiles: Map<string, File>,
  signal?: AbortSignal,
): Promise<HttpSendRequest> {
  return buildHttpPayload(request, variables, await requestMultipartFor(request, variables, formFiles, signal));
}

function requestMultipartPreviewFor(request: HttpRequestDraft, variables: Map<string, string>) {
  if (!requestUsesMultipart(request)) {
    return null;
  }

  const rows = enabledRows(request.formBody);
  if (rows.length === 0) {
    return null;
  }

  return rows
    .map((entry) => {
      const name = resolveVariables(entry.key.trim(), variables).trim() || "<未填写名称>";
      if (formValueTypeFor(entry) === "file") {
        const fileName = entry.fileName || entry.value || "<未选择文件>";
        const size = typeof entry.fileSize === "number" ? `, ${formatBytes(entry.fileSize)}` : "";
        return `[file] ${name}: ${fileName}${size}`;
      }

      return `[text] ${name}: ${resolveVariables(entry.value, variables)}`;
    })
    .join("\n");
}

function buildRequestPreview(request: HttpRequestDraft, variables = new Map<string, string>()) {
  const payload = buildHttpPayload(request, variables);
  const headers = payload.headers.length
    ? payload.headers.map((header) => `${header.key}: ${header.value}`).join("\n")
    : "无";
  const multipartPreview = requestMultipartPreviewFor(request, variables);
  const body = multipartPreview ? `multipart/form-data\n${multipartPreview}` : payload.body || "无";

  return `${payload.method} ${payload.url || "<未填写 URL>"}

Headers
${headers}

Body
${body}`;
}

function formatBytes(bytes: number) {
  if (bytes < 1024) {
    return `${bytes} B`;
  }

  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(2)} KB`;
  }

  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

function formatErrorMessage(error: unknown) {
  if (typeof error === "string") {
    return error;
  }

  if (error instanceof Error) {
    return error.message;
  }

  return "请求失败。";
}

function isValidRequestUrl(url: string) {
  const trimmedUrl = url.trim();

  if (!trimmedUrl) {
    return true;
  }

  try {
    const parsedUrl = new URL(trimmedUrl);
    return parsedUrl.protocol === "http:" || parsedUrl.protocol === "https:";
  } catch {
    return /\{\{\s*[\w.-]+\s*\}\}/.test(trimmedUrl);
  }
}

function hasInvalidRequestUrl(workspaces: HttpWorkspaceDraft[]) {
  return workspaces.some(
    (workspace) =>
      workspace.requests.some((request) => !isValidRequestUrl(request.url)) ||
      workspace.projects.some((project) => project.requests.some((request) => !isValidRequestUrl(request.url))),
  );
}

function isTauriRuntime() {
  return "__TAURI_INTERNALS__" in window;
}

function isTextualResponse(contentType: string) {
  const normalized = contentType.toLowerCase();
  return (
    normalized.startsWith("text/") ||
    normalized.includes("json") ||
    normalized.includes("xml") ||
    normalized.includes("html") ||
    normalized.includes("javascript") ||
    normalized.includes("x-www-form-urlencoded")
  );
}

function isImageResponse(contentType: string) {
  return contentType.toLowerCase().startsWith("image/");
}

function encodeBase64(bytes: Uint8Array) {
  let binary = "";
  const chunkSize = 0x8000;

  for (let index = 0; index < bytes.length; index += chunkSize) {
    binary += String.fromCharCode(...bytes.slice(index, index + chunkSize));
  }

  return btoa(binary);
}

function decodeBufferedResponseBody(bytes: Uint8Array, contentType: string) {
  const sizeBytes = bytes.byteLength;

  if (sizeBytes === 0) {
    return { body: "", bodyKind: "empty" as const, sizeBytes };
  }

  if (isImageResponse(contentType)) {
    return {
      body: `data:${contentType};base64,${encodeBase64(bytes)}`,
      bodyKind: "image" as const,
      sizeBytes,
    };
  }

  if (isTextualResponse(contentType) || !contentType) {
    const text = new TextDecoder().decode(bytes);

    if (contentType.toLowerCase().includes("json")) {
      try {
        return {
          body: JSON.stringify(JSON.parse(text), null, 2),
          bodyKind: "json" as const,
          sizeBytes,
        };
      } catch {
        return { body: text, bodyKind: "text" as const, sizeBytes };
      }
    }

    return { body: text, bodyKind: "text" as const, sizeBytes };
  }

  return {
    body: `Binary response (${sizeBytes} bytes).`,
    bodyKind: "binary" as const,
    sizeBytes,
  };
}

async function decodeBrowserResponseBody(response: Response) {
  const contentType = response.headers.get("content-type") ?? "";
  const buffer = await response.arrayBuffer();
  if (buffer.byteLength > HTTP_RESPONSE_MAX_BYTES) {
    throw new Error(`响应内容超过 ${formatHttpByteLimit(HTTP_RESPONSE_MAX_BYTES)} 上限。`);
  }
  return decodeBufferedResponseBody(new Uint8Array(buffer), contentType);
}

async function sendWithBrowserFetch(
  request: HttpSendRequest,
  options: {
    signal?: AbortSignal;
    onChunk?: (chunk: string, bodyKind: HttpResponsePreview["bodyKind"], sizeBytes: number) => void;
  } = {},
): Promise<HttpResponsePreview> {
  const headers = new Headers();
  request.headers
    .filter((header) => !(request.multipart && header.key.trim().toLowerCase() === "content-type"))
    .forEach((header) => headers.append(header.key, header.value));
  const body = request.multipart ? buildBrowserMultipartBody(request.multipart) : request.body;

  const startedAt = performance.now();
  const response = await fetch(request.url, {
    body,
    headers,
    method: request.method,
    redirect: "follow",
    signal: options.signal,
  });
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > HTTP_RESPONSE_MAX_BYTES) {
    throw new Error(`响应内容超过 ${formatHttpByteLimit(HTTP_RESPONSE_MAX_BYTES)} 上限。`);
  }
  const contentType = response.headers.get("content-type") ?? "";
  const chunks: Uint8Array[] = [];
  let sizeBytes = 0;

  if (response.body) {
    const reader = response.body.getReader();
    const streamText = isTextualResponse(contentType) || !contentType;
    const decoder = streamText ? new TextDecoder() : null;

    while (true) {
      const { done, value } = await reader.read();

      if (done) {
        break;
      }

      if (!value) {
        continue;
      }

      chunks.push(value);
      sizeBytes += value.byteLength;

      if (sizeBytes > HTTP_RESPONSE_MAX_BYTES) {
        await reader.cancel();
        throw new Error(`响应内容超过 ${formatHttpByteLimit(HTTP_RESPONSE_MAX_BYTES)} 上限。`);
      }

      if (decoder) {
        options.onChunk?.(
          decoder.decode(value, { stream: true }),
          contentType.toLowerCase().includes("json") ? "json" : "text",
          sizeBytes,
        );
      }
    }
  }

  const bodyBytes = new Uint8Array(sizeBytes);
  let offset = 0;
  chunks.forEach((chunk) => {
    bodyBytes.set(chunk, offset);
    offset += chunk.byteLength;
  });
  const decodedBody = response.body ? decodeBufferedResponseBody(bodyBytes, contentType) : await decodeBrowserResponseBody(response);

  return {
    ...decodedBody,
    durationMs: Math.max(1, Math.round(performance.now() - startedAt)),
    headers: Object.fromEntries(response.headers.entries()),
    status: response.status,
    statusText: response.statusText,
    url: response.url,
  };
}

function buildBrowserMultipartBody(parts: HttpSendMultipartPart[]) {
  const formData = new FormData();

  parts.forEach((part) => {
    if (part.kind === "file") {
      const bytes = part.bytesBase64 ? base64ToUint8Array(part.bytesBase64) : new Uint8Array(part.bytes ?? []);
      const blob = new Blob([bytes], { type: part.contentType || "application/octet-stream" });
      formData.append(part.name, blob, part.fileName || "upload");
      return;
    }

    formData.append(part.name, part.value ?? "");
  });

  return formData;
}

async function sendHttpDraftRequest(
  payload: HttpSendRequest,
  options: {
    requestId: string;
    signal?: AbortSignal;
    onChunk?: (chunk: string, bodyKind: HttpResponsePreview["bodyKind"], sizeBytes: number) => void;
  },
): Promise<HttpResponsePreview> {
  if (isTauriRuntime()) {
    return httpSendStream(options.requestId, payload);
  }

  return sendWithBrowserFetch(payload, options);
}

export function HttpConsolePanel() {
  const [workspaces, setWorkspaces] = useState<HttpWorkspaceDraft[]>(() => normalizeWorkspaces(defaultWorkspaces));
  const [activeWorkspaceId, setActiveWorkspaceId] = useState(initialWorkspace.id);
  const [activeProjectId, setActiveProjectId] = useState<string | null>(
    initialWorkspace.requests[0] ? null : initialProject?.id ?? null,
  );
  const [activeRequestId, setActiveRequestId] = useState(initialRequest?.id ?? "");
  const [activeMainView, setActiveMainView] = useState<MainView>(initialRequest ? "request" : "blank");
  const [activeSection, setActiveSection] = useState<RequestSection>("params");
  const [activeShareView, setActiveShareView] = useState<ShareView>("export");
  const [selectedVariableScope, setSelectedVariableScope] = useState<VariableScope>("environment");
  const [environmentTabOpen, setEnvironmentTabOpen] = useState(false);
  const [shareTabOpen, setShareTabOpen] = useState(false);
  const [selectedShareRequestIds, setSelectedShareRequestIds] = useState<Set<string>>(() => new Set());
  const [importTarget, setImportTarget] = useState<ImportTarget>("new");
  const [importConflictMode, setImportConflictMode] = useState<ImportConflictMode>("overwrite");
  const [importJson, setImportJson] = useState("");
  const [shareMessage, setShareMessage] = useState("");
  const [shareError, setShareError] = useState("");
  const [variableDraftRows, setVariableDraftRows] = useState<Record<VariableScope, KeyValueEntry>>(() => emptyVariableDrafts);
  const [requestDraftRows, setRequestDraftRows] = useState<Record<RequestRowField, KeyValueEntry>>(() => emptyRequestDraftRows);
  const [treeSearchQuery, setTreeSearchQuery] = useState("");
  const [closedRequestTabIds, setClosedRequestTabIds] = useState<Set<string>>(() => new Set());
  const [responseView, setResponseView] = useState<ResponseView>("body");
  const [response, setResponse] = useState<HttpResponsePreview | null>(null);
  const [responseError, setResponseError] = useState("");
  const [isSending, setIsSending] = useState(false);
  const [responseHistory, setResponseHistory] = useState<HttpResponseHistoryEntry[]>([]);
  const [contextMenu, setContextMenu] = useState<HttpContextMenuState | null>(null);
  const [deleteConfirm, setDeleteConfirm] = useState<HttpDeleteConfirmState>(null);
  const [editingNode, setEditingNode] = useState<EditingNodeState | null>(null);
  const [draggedTreeNode, setDraggedTreeNode] = useState<HttpTreeDragPayload | null>(null);
  const [treeDragPreview, setTreeDragPreview] = useState<HttpTreeDragPreviewState | null>(null);
  const [treeDropTarget, setTreeDropTarget] = useState<HttpTreeDropTarget | null>(null);
  const [requestConfigCollapsed, setRequestConfigCollapsed] = useState(false);
  const [responsePanelRatio, setResponsePanelRatio] = useState(0.38);
  const [storageReady, setStorageReady] = useState(false);
  const [dirtyRequestIds, setDirtyRequestIds] = useState<Set<string>>(() => new Set());
  const workbenchRef = useRef<HTMLDivElement | null>(null);
  const treeSearchInputRef = useRef<HTMLInputElement | null>(null);
  const draggedTreeNodeRef = useRef<HttpTreeDragPayload | null>(null);
  const treeDropTargetRef = useRef<HttpTreeDropTarget | null>(null);
  const pointerTreeDragRef = useRef<HttpTreePointerDragState | null>(null);
  const suppressTreeClickRef = useRef(false);
  const saveWorkspacesTimerRef = useRef<number | null>(null);
  const activeHttpSendRef = useRef<ActiveHttpSendState | null>(null);
  const formFilesRef = useRef<Map<string, File>>(new Map());

  const activeWorkspace = workspaces.find((workspace) => workspace.id === activeWorkspaceId) ?? workspaces[0];
  const workspaceEnvironments = activeWorkspace.environments ?? [];
  const activeEnvironment =
    workspaceEnvironments.find((environment) => environment.id === activeWorkspace.activeEnvironmentId) ??
    workspaceEnvironments[0] ??
    null;
  const activeProject = activeProjectId
    ? activeWorkspace.projects.find((project) => project.id === activeProjectId) ?? null
    : null;
  const activeRequestList = activeProject?.requests ?? activeWorkspace.requests;
  const openRequestTabs = activeRequestList.filter((request) => !closedRequestTabIds.has(request.id));
  const activeRequest = activeRequestList.find((request) => request.id === activeRequestId) ?? null;
  const shareRequestOptions = useMemo(() => collectShareRequestOptions(activeWorkspace), [activeWorkspace]);
  const selectedShareRequestIdsForWorkspace = useMemo(() => {
    const availableIds = new Set(shareRequestOptions.map((option) => option.id));
    return new Set([...selectedShareRequestIds].filter((requestId) => availableIds.has(requestId)));
  }, [selectedShareRequestIds, shareRequestOptions]);
  const shareJson = useMemo(
    () => buildWorkspaceShareJson(activeWorkspace, selectedShareRequestIdsForWorkspace),
    [activeWorkspace, selectedShareRequestIdsForWorkspace],
  );
  const activeVariableRows = useMemo(
    () => scopedVariableRows(activeWorkspace, activeProject, activeEnvironment, activeRequest),
    [activeEnvironment, activeProject, activeRequest, activeWorkspace],
  );
  const activeVariables = useMemo(() => variableMapByScope(activeVariableRows), [activeVariableRows]);
  const enabledParams = useMemo(
    () => activeRequest?.params.filter((entry) => entry.enabled && entry.key.trim()) ?? [],
    [activeRequest?.params],
  );
  const enabledHeaders = useMemo(
    () => activeRequest?.headers.filter((entry) => entry.enabled && entry.key.trim()) ?? [],
    [activeRequest?.headers],
  );
  const showTreeSelection = activeMainView === "request";
  const editorPanelRatio = 1 - responsePanelRatio;
  const workbenchStyle = {
    gridTemplateRows: requestConfigCollapsed
      ? "auto 6px minmax(150px, 1fr)"
      : `minmax(220px, calc(${Math.round(editorPanelRatio * 100)}% - 3px)) 6px minmax(150px, calc(${Math.round(
          responsePanelRatio * 100,
        )}% - 3px))`,
  };

  useEffect(() => {
    if (!contextMenu) {
      return;
    }

    const closeMenu = () => setContextMenu(null);
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        closeMenu();
      }
    };

    window.addEventListener("pointerdown", closeMenu);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("pointerdown", closeMenu);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [contextMenu]);

  useEffect(() => {
    let cancelled = false;

    if (!isTauriRuntime()) {
      setStorageReady(true);
      return () => {
        cancelled = true;
      };
    }

    void httpWorkspacesGet<HttpWorkspaceDraft>()
      .then((storedWorkspaces) => {
        if (cancelled || storedWorkspaces.length === 0) {
          return;
        }

        const normalizedWorkspaces = normalizeWorkspaces(storedWorkspaces);
        const nextWorkspace = normalizedWorkspaces[0];
        const nextProject = nextWorkspace.projects[0] ?? null;
        const nextRequest = nextWorkspace.requests[0] ?? nextProject?.requests[0] ?? null;
        setWorkspaces(normalizedWorkspaces);
        setActiveWorkspaceId(nextWorkspace.id);
        setActiveProjectId(nextWorkspace.requests[0] ? null : nextProject?.id ?? null);
        setActiveRequestId(nextRequest?.id ?? "");
        setActiveMainView(nextRequest ? "request" : "blank");
        setDirtyRequestIds(new Set());
      })
      .catch((error) => {
        console.warn("Failed to load HTTP workspaces", error);
      })
      .finally(() => {
        if (!cancelled) {
          setStorageReady(true);
        }
      });

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!storageReady || !isTauriRuntime()) {
      return;
    }

    if (hasInvalidRequestUrl(workspaces)) {
      return;
    }

    if (saveWorkspacesTimerRef.current) {
      window.clearTimeout(saveWorkspacesTimerRef.current);
    }

    saveWorkspacesTimerRef.current = window.setTimeout(() => {
      void httpWorkspacesSave<HttpWorkspaceDraft>(stripLocalFormFileStateFromWorkspaces(workspaces))
        .then(() => {
          setDirtyRequestIds((current) => (current.size === 0 ? current : new Set()));
        })
        .catch((error) => {
          console.warn("Failed to save HTTP workspaces", error);
        });
    }, 350);

    return () => {
      if (saveWorkspacesTimerRef.current) {
        window.clearTimeout(saveWorkspacesTimerRef.current);
      }
    };
  }, [storageReady, workspaces]);

  useEffect(
    () => () => {
      const activeSend = activeHttpSendRef.current;

      if (activeSend) {
        activeSend.abortController.abort();
        if (isTauriRuntime()) {
          void httpCancel(activeSend.requestId);
        }
      }
    },
    [],
  );

  const markRequestDirty = (requestId: string | null | undefined) => {
    if (!requestId || !storageReady || !isTauriRuntime()) {
      return;
    }

    setDirtyRequestIds((current) => {
      if (current.has(requestId)) {
        return current;
      }

      const next = new Set(current);
      next.add(requestId);
      return next;
    });
  };

  const resetResponse = () => {
    setResponse(null);
    setResponseError("");
  };

  const setCurrentTreeDropTarget = (target: HttpTreeDropTarget | null) => {
    treeDropTargetRef.current = target;
    setTreeDropTarget(target);
  };

  const ignoreTreeClickAfterDrag = (event: MouseEvent<HTMLElement>) => {
    if (!suppressTreeClickRef.current) {
      return false;
    }

    event.preventDefault();
    event.stopPropagation();
    return true;
  };

  const saveWorkspacesNow = async () => {
    if (saveWorkspacesTimerRef.current) {
      window.clearTimeout(saveWorkspacesTimerRef.current);
      saveWorkspacesTimerRef.current = null;
    }

    if (!isTauriRuntime()) {
      setDirtyRequestIds(new Set());
      return;
    }

    if (hasInvalidRequestUrl(workspaces)) {
      return;
    }

    try {
      await httpWorkspacesSave<HttpWorkspaceDraft>(stripLocalFormFileStateFromWorkspaces(workspaces));
      setDirtyRequestIds((current) => (current.size === 0 ? current : new Set()));
    } catch (error) {
      console.warn("Failed to save HTTP workspaces", error);
    }
  };

  const readTreeDragPayload = (event: DragEvent<HTMLElement>) => {
    const rawPayload = event.dataTransfer.getData(httpTreeDragMimeType);

    if (!rawPayload) {
      return draggedTreeNodeRef.current ?? draggedTreeNode;
    }

    try {
      return JSON.parse(rawPayload) as HttpTreeDragPayload;
    } catch {
      return draggedTreeNodeRef.current ?? draggedTreeNode;
    }
  };

  const canDropTreeNode = (drag: HttpTreeDragPayload | null, target: HttpTreeDropTarget) => {
    if (!drag || drag.workspaceId !== target.workspaceId) {
      return false;
    }

    if (drag.type === "project") {
      return target.type === "workspace" || (target.type === "project" && target.projectId !== drag.nodeId);
    }

    if (target.type === "request" && target.requestId === drag.nodeId) {
      return false;
    }

    return target.type === "workspace" || target.type === "project" || target.type === "request";
  };

  const resolveTreeDropTarget = (event: DragEvent<HTMLElement>, target: HttpTreeDropTargetBase) => {
    const drag = readTreeDragPayload(event);
    let position: HttpTreeDropPosition = "inside";

    if (target.type === "request") {
      position = treeDropPositionFromEvent(event);
    } else if (target.type === "project" && drag?.type === "project") {
      position = treeDropPositionFromEvent(event);
    }

    const resolvedTarget: HttpTreeDropTarget = {
      ...target,
      position,
    };

    return canDropTreeNode(drag, resolvedTarget) ? resolvedTarget : null;
  };

  const treeDropClassName = (target: HttpTreeDropTargetBase) => {
    if (
      !treeDropTarget ||
      treeDropTarget.type !== target.type ||
      treeDropTarget.workspaceId !== target.workspaceId ||
      treeDropTarget.projectId !== target.projectId ||
      treeDropTarget.requestId !== target.requestId
    ) {
      return "";
    }

    return `drop-${treeDropTarget.position}`;
  };

  const treeDragClassName = (drag: HttpTreeDragPayload) =>
    draggedTreeNode?.type === drag.type &&
    draggedTreeNode.workspaceId === drag.workspaceId &&
    draggedTreeNode.projectId === drag.projectId &&
    draggedTreeNode.nodeId === drag.nodeId
      ? "dragging"
      : "";

  const startTreeDrag = (event: DragEvent<HTMLElement>, drag: HttpTreeDragPayload) => {
    draggedTreeNodeRef.current = drag;
    setDraggedTreeNode(drag);
    setCurrentTreeDropTarget(null);
    setContextMenu(null);
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData(httpTreeDragMimeType, JSON.stringify(drag));
    event.dataTransfer.setData("text/plain", drag.nodeId);
  };

  const updateTreeDropTarget = (event: DragEvent<HTMLElement>, target: HttpTreeDropTargetBase) => {
    const resolvedTarget = resolveTreeDropTarget(event, target);

    if (!resolvedTarget) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    event.dataTransfer.dropEffect = "move";
    setCurrentTreeDropTarget(resolvedTarget);
  };

  const clearTreeDrag = () => {
    draggedTreeNodeRef.current = null;
    pointerTreeDragRef.current = null;
    setDraggedTreeNode(null);
    setTreeDragPreview(null);
    setCurrentTreeDropTarget(null);
  };

  const selectWorkspace = (workspace: HttpWorkspaceDraft) => {
    const firstRequestId = workspace.requests[0]?.id ?? "";
    setActiveWorkspaceId(workspace.id);
    setActiveProjectId(null);
    setActiveRequestId(firstRequestId);
    if (firstRequestId) {
      setClosedRequestTabIds((current) => {
        const next = new Set(current);
        next.delete(firstRequestId);
        return next;
      });
    }
    setActiveMainView(workspace.requests.length > 0 ? "request" : "blank");
    resetResponse();
  };

  const selectProject = (project: HttpProjectDraft) => {
    const firstRequestId = project.requests[0]?.id ?? "";
    setActiveProjectId(project.id);
    setActiveRequestId(firstRequestId);
    if (firstRequestId) {
      setClosedRequestTabIds((current) => {
        const next = new Set(current);
        next.delete(firstRequestId);
        return next;
      });
    }
    setActiveMainView(project.requests.length > 0 ? "request" : "blank");
    resetResponse();
  };

  const selectRequest = (projectId: string | null, requestId: string) => {
    setActiveProjectId(projectId);
    setActiveRequestId(requestId);
    setClosedRequestTabIds((current) => {
      const next = new Set(current);
      next.delete(requestId);
      return next;
    });
    setActiveMainView("request");
    resetResponse();
  };

  const openEnvironmentTab = () => {
    setEnvironmentTabOpen(true);
    setActiveMainView("environment");
  };

  const selectAllShareRequests = () => {
    setSelectedShareRequestIds(new Set(shareRequestOptions.map((option) => option.id)));
  };

  const clearShareRequestSelection = () => {
    setSelectedShareRequestIds(new Set());
  };

  const toggleShareRequestSelection = (requestId: string) => {
    setSelectedShareRequestIds((current) => {
      const next = new Set(current);

      if (next.has(requestId)) {
        next.delete(requestId);
      } else {
        next.add(requestId);
      }

      return next;
    });
  };

  const openShareTab = () => {
    setShareTabOpen(true);
    setActiveShareView("export");
    setActiveMainView("share");
    setShareError("");
    setShareMessage("");
    setSelectedShareRequestIds((current) => {
      const availableIds = new Set(shareRequestOptions.map((option) => option.id));
      const currentVisibleIds = [...current].filter((requestId) => availableIds.has(requestId));

      return currentVisibleIds.length > 0 ? new Set(currentVisibleIds) : availableIds;
    });
  };

  const closeEnvironmentTab = () => {
    const nextRequest =
      openRequestTabs.find((request) => request.id === activeRequestId) ?? openRequestTabs[0] ?? null;

    setEnvironmentTabOpen(false);
    if (nextRequest) {
      setActiveRequestId(nextRequest.id);
      setActiveMainView("request");
    } else if (shareTabOpen) {
      setActiveRequestId("");
      setActiveMainView("share");
    } else {
      setActiveRequestId("");
      setActiveMainView("blank");
    }
  };

  const closeShareTab = () => {
    const nextRequest =
      openRequestTabs.find((request) => request.id === activeRequestId) ?? openRequestTabs[0] ?? null;

    setShareTabOpen(false);
    if (nextRequest) {
      setActiveRequestId(nextRequest.id);
      setActiveMainView("request");
    } else if (environmentTabOpen) {
      setActiveRequestId("");
      setActiveMainView("environment");
    } else {
      setActiveRequestId("");
      setActiveMainView("blank");
    }
  };

  const closeRequestTab = (requestId: string) => {
    const currentOpenTabs = activeRequestList.filter((request) => !closedRequestTabIds.has(request.id));
    const closedIndex = currentOpenTabs.findIndex((request) => request.id === requestId);
    const remainingTabs = currentOpenTabs.filter((request) => request.id !== requestId);
    const nextRequest = remainingTabs[closedIndex] ?? remainingTabs[closedIndex - 1] ?? null;

    setClosedRequestTabIds((current) => new Set(current).add(requestId));

    if (activeMainView === "request" && activeRequestId === requestId) {
      if (nextRequest) {
        setActiveRequestId(nextRequest.id);
        setActiveMainView("request");
      } else if (environmentTabOpen) {
        setActiveRequestId("");
        setActiveMainView("environment");
      } else {
        setActiveRequestId("");
        setActiveMainView("blank");
      }
      resetResponse();
    }
  };

  const updateActiveRequest = (patch: Partial<HttpRequestDraft>) => {
    if (!activeRequest) {
      return;
    }

    markRequestDirty(activeRequest.id);
    setWorkspaces((current) =>
      current.map((workspace) =>
        workspace.id === activeWorkspace.id
          ? {
              ...workspace,
              requests: activeProject
                ? workspace.requests
                : workspace.requests.map((request) =>
                    request.id === activeRequest.id
                      ? {
                          ...request,
                          ...patch,
                        }
                      : request,
                  ),
              projects: workspace.projects.map((project) =>
                activeProject && project.id === activeProject.id
                  ? {
                      ...project,
                      requests: project.requests.map((request) =>
                        request.id === activeRequest.id
                          ? {
                              ...request,
                              ...patch,
                            }
                          : request,
                      ),
                    }
                  : project,
              ),
            }
          : workspace,
      ),
    );
  };

  const createWorkspace = () => {
    const workspace: HttpWorkspaceDraft = {
      id: makeId("ws"),
      name: uniqueName(
        workspaces.map((item) => item.name),
        "新建工作区",
      ),
      requests: [],
      projects: [],
    };

    setWorkspaces((current) => [...current, workspace]);
    setActiveWorkspaceId(workspace.id);
    setActiveProjectId(null);
    setActiveRequestId("");
    setActiveMainView("blank");
    setEditingNode({ id: workspace.id, type: "workspace", value: workspace.name });
    setContextMenu(null);
    resetResponse();
  };

  const createProject = (workspaceId = activeWorkspace.id) => {
    const workspace = workspaces.find((item) => item.id === workspaceId) ?? activeWorkspace;
    const projectId = makeId("project");
    const project: HttpProjectDraft = {
      id: projectId,
      name: uniqueName(
        workspace.projects.map((item) => item.name),
        "新建项目",
      ),
      requests: [],
    };

    setWorkspaces((current) =>
      current.map((item) =>
        item.id === workspaceId
          ? {
              ...item,
              projects: [...item.projects, project],
            }
          : item,
      ),
    );
    setActiveWorkspaceId(workspaceId);
    setActiveProjectId(projectId);
    setActiveRequestId("");
    setActiveMainView("blank");
    setEditingNode({ id: projectId, type: "project", value: project.name });
    setContextMenu(null);
    resetResponse();
  };

  const createRequest = (workspaceId = activeWorkspace.id, projectId: string | null = activeProject?.id ?? null) => {
    const workspace = workspaces.find((item) => item.id === workspaceId) ?? activeWorkspace;
    const project = projectId ? workspace.projects.find((item) => item.id === projectId) ?? workspace.projects[0] : null;
    const siblingRequests = project?.requests ?? workspace.requests;
    const request = createBlankRequest(
      uniqueName(
        siblingRequests.map((item) => item.name),
        "新建请求",
      ),
    );

    setWorkspaces((current) =>
      current.map((item) =>
        item.id === workspaceId
          ? {
              ...item,
              requests: projectId ? item.requests : [...item.requests, request],
              projects: projectId
                ? item.projects.map((projectItem) =>
                    projectItem.id === projectId
                      ? {
                          ...projectItem,
                          requests: [...projectItem.requests, request],
                        }
                      : projectItem,
                  )
                : item.projects,
            }
          : item,
      ),
    );
    setActiveWorkspaceId(workspaceId);
    setActiveProjectId(projectId);
    setActiveRequestId(request.id);
    setClosedRequestTabIds((current) => {
      const next = new Set(current);
      next.delete(request.id);
      return next;
    });
    setActiveMainView("request");
    markRequestDirty(request.id);
    setEditingNode({ id: request.id, type: "request", value: request.name });
    setContextMenu(null);
    resetResponse();
  };

  const moveProject = (drag: HttpTreeDragPayload, target: HttpTreeDropTarget) => {
    if (drag.type !== "project") {
      return;
    }

    setWorkspaces((current) =>
      current.map((workspace) => {
        if (workspace.id !== drag.workspaceId) {
          return workspace;
        }

        const sourceProject = workspace.projects.find((project) => project.id === drag.nodeId);

        if (!sourceProject) {
          return workspace;
        }

        const nextProjects = workspace.projects.filter((project) => project.id !== drag.nodeId);

        if (target.type === "project" && target.projectId) {
          const targetIndex = nextProjects.findIndex((project) => project.id === target.projectId);

          if (targetIndex === -1) {
            return workspace;
          }

          nextProjects.splice(target.position === "after" ? targetIndex + 1 : targetIndex, 0, sourceProject);
        } else {
          nextProjects.push(sourceProject);
        }

        return {
          ...workspace,
          projects: nextProjects,
        };
      }),
    );
    setContextMenu(null);
  };

  const moveRequest = (drag: HttpTreeDragPayload, target: HttpTreeDropTarget) => {
    if (drag.type !== "request") {
      return;
    }

    const targetProjectId = target.type === "workspace" ? null : target.projectId;

    setWorkspaces((current) =>
      current.map((workspace) => {
        if (workspace.id !== drag.workspaceId) {
          return workspace;
        }

        const nextRequests = [...workspace.requests];
        const nextProjects = workspace.projects.map((project) => ({
          ...project,
          requests: [...project.requests],
        }));
        const sourceList = drag.projectId
          ? nextProjects.find((project) => project.id === drag.projectId)?.requests
          : nextRequests;
        const targetList = targetProjectId
          ? nextProjects.find((project) => project.id === targetProjectId)?.requests
          : nextRequests;

        if (!sourceList || !targetList) {
          return workspace;
        }

        const sourceIndex = sourceList.findIndex((request) => request.id === drag.nodeId);

        if (sourceIndex === -1) {
          return workspace;
        }

        const [sourceRequest] = sourceList.splice(sourceIndex, 1);

        if (!sourceRequest) {
          return workspace;
        }

        let targetIndex = targetList.length;

        if (target.type === "request" && target.requestId) {
          const matchedIndex = targetList.findIndex((request) => request.id === target.requestId);
          targetIndex = matchedIndex === -1 ? targetList.length : matchedIndex + (target.position === "after" ? 1 : 0);
        }

        targetList.splice(targetIndex, 0, sourceRequest);

        return {
          ...workspace,
          requests: nextRequests,
          projects: nextProjects,
        };
      }),
    );
    setActiveWorkspaceId(drag.workspaceId);
    setActiveProjectId(targetProjectId);
    setActiveRequestId(drag.nodeId);
    setActiveMainView("request");
    setContextMenu(null);
    resetResponse();
  };

  const dropTreeNode = (event: DragEvent<HTMLElement>, target: HttpTreeDropTargetBase) => {
    const drag = readTreeDragPayload(event);
    const resolvedTarget = resolveTreeDropTarget(event, target);

    if (!drag || !resolvedTarget) {
      clearTreeDrag();
      return;
    }

    event.preventDefault();
    event.stopPropagation();

    if (drag.type === "project") {
      moveProject(drag, resolvedTarget);
    } else {
      moveRequest(drag, resolvedTarget);
    }

    clearTreeDrag();
  };

  const resolvePointerTreeDropTarget = (element: Element | null, clientY: number, drag: HttpTreeDragPayload) => {
    const targetElement = element?.closest<HTMLElement>("[data-http-drop-type]");

    if (!targetElement) {
      return null;
    }

    const type = targetElement.dataset.httpDropType as HttpTreeDropType | undefined;
    const workspaceId = targetElement.dataset.workspaceId;

    if (!type || !workspaceId) {
      return null;
    }

    let position: HttpTreeDropPosition = "inside";

    if (type === "request" || (type === "project" && drag.type === "project")) {
      const bounds = targetElement.getBoundingClientRect();
      position = clientY < bounds.top + bounds.height / 2 ? "before" : "after";
    }

    const target: HttpTreeDropTarget = {
      position,
      projectId: targetElement.dataset.projectId || null,
      requestId: targetElement.dataset.requestId,
      type,
      workspaceId,
    };

    return canDropTreeNode(drag, target) ? target : null;
  };

  const finishTreePointerDrag = (event: PointerEvent) => {
    const pointerDrag = pointerTreeDragRef.current;

    window.removeEventListener("pointermove", moveTreePointerDrag);
    window.removeEventListener("pointerup", finishTreePointerDrag);
    window.removeEventListener("pointercancel", cancelTreePointerDrag);

    if (!pointerDrag) {
      clearTreeDrag();
      return;
    }

    const target =
      pointerDrag.active && typeof document !== "undefined"
        ? resolvePointerTreeDropTarget(document.elementFromPoint(event.clientX, event.clientY), event.clientY, pointerDrag.drag) ??
          treeDropTargetRef.current
        : null;

    if (target && canDropTreeNode(pointerDrag.drag, target)) {
      suppressTreeClickRef.current = true;

      if (pointerDrag.drag.type === "project") {
        moveProject(pointerDrag.drag, target);
      } else {
        moveRequest(pointerDrag.drag, target);
      }

      window.setTimeout(() => {
        suppressTreeClickRef.current = false;
      }, 0);
    }

    clearTreeDrag();
  };

  const cancelTreePointerDrag = () => {
    window.removeEventListener("pointermove", moveTreePointerDrag);
    window.removeEventListener("pointerup", finishTreePointerDrag);
    window.removeEventListener("pointercancel", cancelTreePointerDrag);
    clearTreeDrag();
  };

  function moveTreePointerDrag(event: PointerEvent) {
    const pointerDrag = pointerTreeDragRef.current;

    if (!pointerDrag || pointerDrag.pointerId !== event.pointerId) {
      return;
    }

    const distance = Math.hypot(event.clientX - pointerDrag.startX, event.clientY - pointerDrag.startY);

    if (!pointerDrag.active && distance < 4) {
      return;
    }

    event.preventDefault();

    if (!pointerDrag.active) {
      pointerDrag.active = true;
      draggedTreeNodeRef.current = pointerDrag.drag;
      setDraggedTreeNode(pointerDrag.drag);
    }

    setTreeDragPreview({
      drag: pointerDrag.drag,
      x: event.clientX,
      y: event.clientY,
    });

    const target =
      typeof document !== "undefined"
        ? resolvePointerTreeDropTarget(document.elementFromPoint(event.clientX, event.clientY), event.clientY, pointerDrag.drag)
        : null;
    setCurrentTreeDropTarget(target);
  }

  const startTreePointerDrag = (event: ReactPointerEvent<HTMLElement>, drag: HttpTreeDragPayload) => {
    if (event.button !== 0 || editingNode?.id === drag.nodeId) {
      return;
    }

    pointerTreeDragRef.current = {
      active: false,
      drag,
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
    };
    draggedTreeNodeRef.current = drag;
    setCurrentTreeDropTarget(null);
    setContextMenu(null);
    window.addEventListener("pointermove", moveTreePointerDrag, { passive: false });
    window.addEventListener("pointerup", finishTreePointerDrag);
    window.addEventListener("pointercancel", cancelTreePointerDrag);
  };

  const duplicateRequest = (workspaceId: string, projectId: string | null, requestId: string) => {
    const workspace = workspaces.find((item) => item.id === workspaceId);
    const project = projectId ? workspace?.projects.find((item) => item.id === projectId) : null;
    const siblingRequests = project?.requests ?? workspace?.requests ?? [];
    const request = siblingRequests.find((item) => item.id === requestId);

    if (!workspace || !request) {
      return;
    }

    const copy: HttpRequestDraft = {
      ...request,
      id: makeId("req"),
      name: uniqueName(
        siblingRequests.map((item) => item.name),
        `${request.name} 副本`,
      ),
    };

    setWorkspaces((current) =>
      current.map((item) =>
        item.id === workspaceId
          ? {
              ...item,
              requests: projectId
                ? item.requests
                : item.requests.flatMap((requestItem) => (requestItem.id === requestId ? [requestItem, copy] : [requestItem])),
              projects: projectId
                ? item.projects.map((projectItem) =>
                    projectItem.id === projectId
                      ? {
                          ...projectItem,
                          requests: projectItem.requests.flatMap((requestItem) =>
                            requestItem.id === requestId ? [requestItem, copy] : [requestItem],
                          ),
                        }
                      : projectItem,
                  )
                : item.projects,
            }
          : item,
      ),
    );
    setActiveWorkspaceId(workspaceId);
    setActiveProjectId(projectId);
    setActiveRequestId(copy.id);
    setClosedRequestTabIds((current) => {
      const next = new Set(current);
      next.delete(copy.id);
      return next;
    });
    setActiveMainView("request");
    markRequestDirty(copy.id);
    setContextMenu(null);
    resetResponse();
  };

  const beginRename = (type: TreeNodeType, id: string, value: string) => {
    setEditingNode({ id, type, value });
    setContextMenu(null);
  };

  const commitRename = () => {
    if (!editingNode) {
      return;
    }

    const nextName = editingNode.value.trim();
    if (!nextName) {
      setEditingNode(null);
      return;
    }

    setWorkspaces((current) =>
      current.map((workspace) => {
        if (editingNode.type === "workspace" && workspace.id === editingNode.id) {
          return { ...workspace, name: nextName };
        }

        return {
          ...workspace,
          requests: workspace.requests.map((request) =>
            editingNode.type === "request" && request.id === editingNode.id ? { ...request, name: nextName } : request,
          ),
          projects: workspace.projects.map((project) => {
            if (editingNode.type === "project" && project.id === editingNode.id) {
              return { ...project, name: nextName };
            }

            return {
              ...project,
              requests: project.requests.map((request) =>
                editingNode.type === "request" && request.id === editingNode.id ? { ...request, name: nextName } : request,
              ),
            };
          }),
        };
      }),
    );
    markRequestDirty(editingNode.type === "request" ? editingNode.id : null);
    setEditingNode(null);
  };

  const requestDeleteWorkspace = (workspaceId: string) => {
    if (workspaces.length <= 1) {
      return;
    }

    const workspace = workspaces.find((item) => item.id === workspaceId);
    if (!workspace) {
      return;
    }

    setContextMenu(null);
    setDeleteConfirm({ name: workspace.name, type: "workspace", workspaceId });
  };

  const deleteWorkspace = (workspaceId: string) => {
    if (workspaces.length <= 1) {
      return;
    }

    const workspace = workspaces.find((item) => item.id === workspaceId);
    if (!workspace) {
      return;
    }

    const workspaceIndex = workspaces.findIndex((workspace) => workspace.id === workspaceId);
    const nextWorkspace = workspaces[workspaceIndex === 0 ? 1 : workspaceIndex - 1] ?? workspaces[0];
    setWorkspaces((current) => current.filter((workspace) => workspace.id !== workspaceId));
    setContextMenu(null);

    if (activeWorkspace.id === workspaceId) {
      selectWorkspace(nextWorkspace);
    }
  };

  const requestDeleteProject = (workspaceId: string, projectId: string) => {
    const workspace = workspaces.find((item) => item.id === workspaceId);
    const project = workspace?.projects.find((item) => item.id === projectId);

    if (!workspace || !project) {
      return;
    }

    setContextMenu(null);
    setDeleteConfirm({ name: project.name, projectId, type: "project", workspaceId });
  };

  const deleteProject = (workspaceId: string, projectId: string) => {
    const workspace = workspaces.find((item) => item.id === workspaceId);
    const project = workspace?.projects.find((item) => item.id === projectId);

    if (!workspace || !project) {
      return;
    }

    setWorkspaces((current) =>
      current.map((item) =>
        item.id === workspaceId
          ? {
              ...item,
              projects: item.projects.filter((project) => project.id !== projectId),
            }
          : item,
      ),
    );
    setContextMenu(null);

    if (activeWorkspace.id === workspaceId && activeProject?.id === projectId) {
      setActiveProjectId(null);
      setActiveRequestId(workspace.requests[0]?.id ?? "");
      resetResponse();
    }
  };

  const requestDeleteRequest = (workspaceId: string, projectId: string | null, requestId: string) => {
    const workspace = workspaces.find((item) => item.id === workspaceId);
    const project = projectId ? workspace?.projects.find((item) => item.id === projectId) : null;
    const siblingRequests = project?.requests ?? workspace?.requests ?? [];

    if (!workspace || siblingRequests.length === 0) {
      return;
    }

    const requestToDelete = siblingRequests.find((request) => request.id === requestId);
    if (!requestToDelete) {
      return;
    }

    setContextMenu(null);
    setDeleteConfirm({ name: requestToDelete.name, projectId, requestId, type: "request", workspaceId });
  };

  const deleteRequest = (workspaceId: string, projectId: string | null, requestId: string) => {
    const workspace = workspaces.find((item) => item.id === workspaceId);
    const project = projectId ? workspace?.projects.find((item) => item.id === projectId) : null;
    const siblingRequests = project?.requests ?? workspace?.requests ?? [];

    if (!workspace || siblingRequests.length === 0) {
      return;
    }

    const requestToDelete = siblingRequests.find((request) => request.id === requestId);
    if (!requestToDelete) {
      return;
    }

    const requestIndex = siblingRequests.findIndex((request) => request.id === requestId);
    const nextRequest =
      siblingRequests.filter((request) => request.id !== requestId)[requestIndex === 0 ? 0 : requestIndex - 1] ?? null;
    setWorkspaces((current) =>
      current.map((item) =>
        item.id === workspaceId
          ? {
              ...item,
              requests: projectId ? item.requests : item.requests.filter((request) => request.id !== requestId),
              projects: projectId
                ? item.projects.map((projectItem) =>
                    projectItem.id === projectId
                      ? {
                          ...projectItem,
                          requests: projectItem.requests.filter((request) => request.id !== requestId),
                        }
                      : projectItem,
                  )
                : item.projects,
            }
          : item,
      ),
    );
    setContextMenu(null);
    setClosedRequestTabIds((current) => {
      if (!current.has(requestId)) {
        return current;
      }

      const next = new Set(current);
      next.delete(requestId);
      return next;
    });
    setDirtyRequestIds((current) => {
      if (!current.has(requestId)) {
        return current;
      }

      const next = new Set(current);
      next.delete(requestId);
      return next;
    });

    if (
      activeWorkspace.id === workspaceId &&
      (activeProject?.id ?? null) === projectId &&
      activeRequest?.id === requestId
    ) {
      setActiveRequestId(nextRequest?.id ?? "");
      setActiveMainView(nextRequest ? "request" : environmentTabOpen ? "environment" : shareTabOpen ? "share" : "blank");
      resetResponse();
    }
  };

  const copyText = (text: string) => {
    setContextMenu(null);
    void navigator.clipboard?.writeText(text);
  };

  const copyShareJson = () => {
    copyText(shareJson);
    setShareError("");
    setShareMessage("JSON 已复制。");
  };

  const downloadShareJson = () => {
    const blob = new Blob([shareJson], { type: "application/json;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `${activeWorkspace.name.replace(/[\\/:*?"<>|]/g, "_") || "http-workspace"}.portiva-http.json`;
    link.click();
    URL.revokeObjectURL(url);
    setShareError("");
    setShareMessage("JSON 已下载。");
  };

  const importShareJson = () => {
    setShareError("");
    setShareMessage("");

    try {
      const importedWorkspace = parseWorkspaceShareJson(
        importJson,
        workspaces.map((workspace) => workspace.name),
      );

      if (importTarget === "current") {
        const mergeResult = mergeImportedWorkspaceIntoCurrent(activeWorkspace, importedWorkspace, importConflictMode);
        const firstImportedRequestId = mergeResult.importedRequestIds[0] ?? "";
        const firstImportedRequestLocation = firstImportedRequestId
          ? requestLocationById(mergeResult.workspace, firstImportedRequestId)
          : null;

        setWorkspaces((current) =>
          current.map((workspace) => (workspace.id === activeWorkspace.id ? mergeResult.workspace : workspace)),
        );
        setActiveWorkspaceId(activeWorkspace.id);
        if (firstImportedRequestLocation) {
          setActiveProjectId(firstImportedRequestLocation.projectId);
          setActiveRequestId(firstImportedRequestLocation.requestId);
          setClosedRequestTabIds((current) => {
            const next = new Set(current);
            mergeResult.importedRequestIds.forEach((requestId) => next.delete(requestId));
            return next;
          });
        }
        setSelectedShareRequestIds(new Set(mergeResult.importedRequestIds));
        setImportJson("");
        setShareTabOpen(true);
        setActiveMainView("share");
        setActiveShareView("export");
        setShareMessage(
          `已导入到当前工作区：新增 ${mergeResult.added}，覆盖 ${mergeResult.overwritten}，忽略 ${mergeResult.ignored}。`,
        );
        return;
      }

      const nextProject = importedWorkspace.projects[0] ?? null;
      const nextRequest = importedWorkspace.requests[0] ?? nextProject?.requests[0] ?? null;

      setWorkspaces((current) => [...current, importedWorkspace]);
      setActiveWorkspaceId(importedWorkspace.id);
      setActiveProjectId(importedWorkspace.requests[0] ? null : nextProject?.id ?? null);
      setActiveRequestId(nextRequest?.id ?? "");
      setClosedRequestTabIds(new Set());
      setSelectedShareRequestIds(new Set(collectShareRequestOptions(importedWorkspace).map((option) => option.id)));
      setImportJson("");
      setShareTabOpen(true);
      setActiveMainView("share");
      setActiveShareView("export");
      setShareMessage(`已导入「${importedWorkspace.name}」。`);
    } catch (error) {
      setShareError(formatErrorMessage(error));
    }
  };

  const updateActiveAuth = (patch: Partial<HttpAuthDraft>) => {
    if (!activeRequest) {
      return;
    }

    updateActiveRequest({
      auth: {
        ...activeRequest.auth,
        ...patch,
      },
    });
  };

  const updateActiveWorkspace = (patch: Partial<HttpWorkspaceDraft>) => {
    setWorkspaces((current) =>
      current.map((workspace) => (workspace.id === activeWorkspace.id ? normalizeWorkspace({ ...workspace, ...patch }) : workspace)),
    );
  };

  const setActiveEnvironment = (environmentId: string) => {
    updateActiveWorkspace({ activeEnvironmentId: environmentId });
  };

  const createEnvironment = () => {
    const environments = workspaceEnvironments;
    const environment: HttpEnvironmentDraft = {
      id: makeId("env"),
      name: uniqueName(environments.map((item) => item.name), "新环境"),
      variables: [],
    };

    updateActiveWorkspace({
      activeEnvironmentId: environment.id,
      environments: [...environments, environment],
    });
  };

  const renameActiveEnvironment = (name: string) => {
    if (!activeEnvironment) {
      return;
    }

    updateActiveWorkspace({
      environments: workspaceEnvironments.map((environment) =>
        environment.id === activeEnvironment.id ? { ...environment, name } : environment,
      ),
    });
  };

  const requestDeleteActiveEnvironment = () => {
    if (!activeEnvironment || workspaceEnvironments.length <= 1) {
      return;
    }

    setDeleteConfirm({ environmentId: activeEnvironment.id, name: activeEnvironment.name, type: "environment" });
  };

  const deleteEnvironment = (environmentId: string) => {
    if (workspaceEnvironments.length <= 1) {
      return;
    }

    const environment = workspaceEnvironments.find((item) => item.id === environmentId);
    if (!environment) {
      return;
    }

    const nextEnvironments = workspaceEnvironments.filter((environment) => environment.id !== environmentId);
    updateActiveWorkspace({
      activeEnvironmentId: nextEnvironments[0]?.id ?? null,
      environments: nextEnvironments,
    });
  };

  const confirmDeleteTarget = () => {
    const target = deleteConfirm;
    if (!target) {
      return;
    }

    setDeleteConfirm(null);

    if (target.type === "workspace") {
      deleteWorkspace(target.workspaceId);
      return;
    }

    if (target.type === "project") {
      deleteProject(target.workspaceId, target.projectId);
      return;
    }

    if (target.type === "request") {
      deleteRequest(target.workspaceId, target.projectId, target.requestId);
      return;
    }

    deleteEnvironment(target.environmentId);
  };

  const updateEnvironmentVariables = (environmentId: string, variables: KeyValueEntry[]) => {
    updateActiveWorkspace({
      environments: workspaceEnvironments.map((environment) =>
        environment.id === environmentId ? { ...environment, variables } : environment,
      ),
    });
  };

  const variableScopeAvailable = (scope: VariableScope) => {
    if (scope === "project") {
      return Boolean(activeProject);
    }

    if (scope === "request-temp") {
      return Boolean(activeRequest);
    }

    if (scope === "environment") {
      return Boolean(activeEnvironment);
    }

    return true;
  };

  const updateVariableRowsForScope = (scope: VariableScope, rows: KeyValueEntry[]) => {
    const nextRows = trimTrailingBlankRows(rows);

    if (scope === "workspace") {
      updateActiveWorkspace({ variables: nextRows });
      return;
    }

    if (scope === "environment" && activeEnvironment) {
      updateEnvironmentVariables(activeEnvironment.id, nextRows);
      return;
    }

    if (scope === "project" && activeProject) {
      updateActiveWorkspace({
        projects: activeWorkspace.projects.map((project) =>
          project.id === activeProject.id ? { ...project, variables: nextRows } : project,
        ),
      });
      return;
    }

    if (scope === "request-temp" && activeRequest) {
      updateActiveRequest({ tempVariables: nextRows });
    }
  };

  const resetVariableDraft = (scope: VariableScope) => {
    setVariableDraftRows((current) => ({ ...current, [scope]: { ...createBlankRow(), enabled: false } }));
  };

  const updateVariableDraft = (scope: VariableScope, patch: Partial<KeyValueEntry>) => {
    setVariableDraftRows((current) => ({
      ...current,
      [scope]: {
        ...current[scope],
        ...patch,
        enabled: false,
      },
    }));
  };

  const commitVariableDraft = (scope: VariableScope) => {
    if (!variableScopeAvailable(scope)) {
      return;
    }

    const draft = variableDraftRows[scope];
    if (!hasKeyValueContent(draft)) {
      resetVariableDraft(scope);
      return;
    }

    updateVariableRowsForScope(scope, [...trimTrailingBlankRows(activeVariableRows[scope]), { ...draft, enabled: true }]);
    resetVariableDraft(scope);
  };

  const updateScopedVariable = (scope: VariableScope, index: number, patch: Partial<KeyValueEntry>) => {
    if (!variableScopeAvailable(scope)) {
      return;
    }

    const rows = trimTrailingBlankRows(activeVariableRows[scope]);

    if (index >= rows.length) {
      updateVariableDraft(scope, patch);
      return;
    }

    updateVariableRowsForScope(
      scope,
      rows.map((row, rowIndex) => (rowIndex === index ? { ...row, ...patch } : row)),
    );
  };

  const removeScopedVariable = (scope: VariableScope, index: number) => {
    if (!variableScopeAvailable(scope)) {
      return;
    }

    updateVariableRowsForScope(
      scope,
      trimTrailingBlankRows(activeVariableRows[scope]).filter((_, rowIndex) => rowIndex !== index),
    );
  };

  const resetRequestDraft = (field: RequestRowField) => {
    setRequestDraftRows((current) => ({
      ...current,
      [field]: {
        ...createBlankRow(),
        enabled: false,
        ...(field === "formBody" ? { formValueType: "text" as FormValueType } : {}),
      },
    }));
  };

  const updateRequestDraft = (field: RequestRowField, patch: Partial<KeyValueEntry>) => {
    setRequestDraftRows((current) => ({
      ...current,
      [field]: {
        ...current[field],
        ...patch,
        enabled: false,
      },
    }));
  };

  const updateRequestRows = (field: RequestRowField, rows: KeyValueEntry[]) => {
    updateActiveRequest({ [field]: rows } as Partial<HttpRequestDraft>);
  };

  const commitRequestDraft = (field: RequestRowField) => {
    if (!activeRequest) {
      return;
    }

    const draft = requestDraftRows[field];
    if (!hasKeyValueContent(draft)) {
      resetRequestDraft(field);
      return;
    }

    updateRequestRows(field, [...trimTrailingBlankRows(activeRequest[field]), { ...draft, enabled: true }]);
    resetRequestDraft(field);
  };

  const updateRequestRow = (field: RequestRowField, index: number, patch: Partial<KeyValueEntry>) => {
    if (!activeRequest) {
      return;
    }

    const rows = trimTrailingBlankRows(activeRequest[field]);

    if (index >= rows.length) {
      updateRequestDraft(field, patch);
      return;
    }

    const nextRows = rows.map((row, rowIndex) => (rowIndex === index ? { ...row, ...patch } : row));
    updateRequestRows(field, trimTrailingBlankRows(nextRows));
  };

  const forgetFormFile = (row: KeyValueEntry | undefined) => {
    if (row?.localFileId) {
      formFilesRef.current.delete(row.localFileId);
    }
  };

  const setFormRowValueType = (index: number, valueType: FormValueType) => {
    if (!activeRequest) {
      return;
    }

    const rows = trimTrailingBlankRows(activeRequest.formBody);
    const currentRow = index >= rows.length ? requestDraftRows.formBody : rows[index];
    forgetFormFile(currentRow);

    updateRequestRow("formBody", index, {
      fileName: undefined,
      fileSize: undefined,
      fileType: undefined,
      formValueType: valueType === "file" ? "file" : undefined,
      localFileId: undefined,
      value: "",
    });
  };

  const selectFormFile = (index: number, file: File | undefined) => {
    if (!file || !activeRequest) {
      return;
    }

    if (file.size > HTTP_FILE_UPLOAD_MAX_BYTES) {
      setResponseError(`单个上传文件不能超过 ${formatHttpByteLimit(HTTP_FILE_UPLOAD_MAX_BYTES)}。`);
      return;
    }

    const rows = trimTrailingBlankRows(activeRequest.formBody);
    const currentRow = index >= rows.length ? requestDraftRows.formBody : rows[index];
    const localFileId = makeId("form-file");
    forgetFormFile(currentRow);
    formFilesRef.current.set(localFileId, file);

    updateRequestRow("formBody", index, {
      fileName: file.name,
      fileSize: file.size,
      fileType: file.type,
      formValueType: "file",
      localFileId,
      value: file.name,
    });
  };

  const removeRequestRow = (field: RequestRowField, index: number) => {
    if (!activeRequest) {
      return;
    }

    if (field === "formBody") {
      forgetFormFile(trimTrailingBlankRows(activeRequest.formBody)[index]);
    }

    updateRequestRows(
      field,
      trimTrailingBlankRows(activeRequest[field]).filter((_, rowIndex) => rowIndex !== index),
    );
  };

  const moveRequestRow = (field: RequestRowField, index: number, direction: -1 | 1) => {
    if (!activeRequest) {
      return;
    }

    const nextIndex = index + direction;
    const rows = trimTrailingBlankRows(activeRequest[field]);

    if (nextIndex < 0 || nextIndex >= rows.length) {
      return;
    }

    [rows[index], rows[nextIndex]] = [rows[nextIndex], rows[index]];
    updateRequestRows(field, rows);
  };

  const formatJsonBody = () => {
    if (!activeRequest || activeRequest.bodyMode !== "json") {
      return;
    }

    const body = activeRequest.body.trim();

    if (!body) {
      return;
    }

    try {
      updateActiveRequest({ body: JSON.stringify(JSON.parse(body), null, 2) });
      setResponseError("");
    } catch {
      setResponseError("请求体 JSON 格式无效，无法格式化。");
    }
  };

  const cancelActiveHttpRequest = () => {
    const activeSend = activeHttpSendRef.current;

    if (!activeSend) {
      return;
    }

    activeSend.abortController.abort();
    if (isTauriRuntime()) {
      void httpCancel(activeSend.requestId);
    }
  };

  const pushResponseHistory = (entry: Omit<HttpResponseHistoryEntry, "id" | "timestamp">) => {
    setResponseHistory((current) => [
      {
        ...entry,
        id: makeId("http-history"),
        timestamp: Date.now(),
      },
      ...current,
    ].slice(0, 50));
  };

  const sendPreviewRequest = async () => {
    if (isSending) {
      cancelActiveHttpRequest();
      return;
    }

    setResponseError("");
    setResponseView("body");

    if (!activeRequest) {
      setResponse(null);
      setResponseError("请先选择或创建请求。");
      return;
    }

    if (!activeRequest.url.trim()) {
      setResponse(null);
      setResponseError("请输入请求地址。");
      return;
    }

    const requestSnapshot = activeRequest;
    const missing = missingRequestVariables(requestSnapshot, activeVariables);
    if (missing.length > 0) {
      setResponse(null);
      setResponseError(`变量未定义：${missing.join(", ")}`);
      return;
    }

    const requestId = makeId("http-send");
    const abortController = new AbortController();
    const pendingUrl = requestUrlFor(requestSnapshot, activeVariables);
    let payload: HttpSendRequest | null = null;
    let unlistenStream: (() => void) | null = null;

    activeHttpSendRef.current = {
      abortController,
      requestId,
    };
    setResponse({
      body: "",
      bodyKind: "text",
      durationMs: 0,
      headers: {},
      sizeBytes: 0,
      status: 0,
      statusText: requestUsesMultipart(requestSnapshot) ? "读取文件" : "请求中",
      url: pendingUrl,
    });
    setIsSending(true);

    try {
      payload = await buildHttpPayloadForSend(requestSnapshot, activeVariables, formFilesRef.current, abortController.signal);
      setResponse((current) => ({
        body: current?.body ?? "",
        bodyKind: current?.bodyKind ?? "text",
        durationMs: current?.durationMs ?? 0,
        headers: current?.headers ?? {},
        sizeBytes: current?.sizeBytes ?? 0,
        status: current?.status ?? 0,
        statusText: "请求中",
        url: payload?.url ?? pendingUrl,
      }));

      if (isTauriRuntime()) {
        const { listen } = await import("@tauri-apps/api/event");
        unlistenStream = await listen<HttpStreamChunkPayload>("http-stream-chunk", (event) => {
          if (event.payload.requestId !== requestId) {
            return;
          }

          setResponse((current) => ({
            body: appendHttpStreamPreview(current?.body ?? "", event.payload.chunk),
            bodyKind: event.payload.bodyKind,
            durationMs: current?.durationMs ?? 0,
            headers: current?.headers ?? {},
            sizeBytes: event.payload.sizeBytes,
            status: current?.status ?? 0,
            statusText: current?.statusText ?? "请求中",
            url: current?.url ?? payload?.url ?? pendingUrl,
          }));
        });
      }

      const nextResponse = await sendHttpDraftRequest(payload, {
        requestId,
        signal: abortController.signal,
        onChunk: (chunk, bodyKind, sizeBytes) => {
          setResponse((current) => ({
            body: appendHttpStreamPreview(current?.body ?? "", chunk),
            bodyKind,
            durationMs: current?.durationMs ?? 0,
            headers: current?.headers ?? {},
            sizeBytes,
            status: current?.status ?? 0,
            statusText: current?.statusText ?? "请求中",
            url: current?.url ?? payload?.url ?? pendingUrl,
          }));
        },
      });
      setResponse(nextResponse);
      pushResponseHistory({
        method: requestSnapshot.method,
        name: requestSnapshot.name,
        response: nextResponse,
        url: payload.url,
      });
    } catch (error) {
      setResponse(null);
      const message =
        abortController.signal.aborted || formatErrorMessage(error).includes("取消")
          ? "请求已取消。"
          : formatErrorMessage(error);
      setResponseError(message);
      pushResponseHistory({
        error: message,
        method: requestSnapshot.method,
        name: requestSnapshot.name,
        url: payload?.url ?? pendingUrl,
      });
    } finally {
      unlistenStream?.();
      if (activeHttpSendRef.current?.requestId === requestId) {
        activeHttpSendRef.current = null;
      }
      setIsSending(false);
    }
  };

  const startResponseResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    const updateResponseRatio = (clientY: number) => {
      const workbench = workbenchRef.current;

      if (!workbench) {
        return;
      }

      const bounds = workbench.getBoundingClientRect();
      if (bounds.height <= 0) {
        return;
      }

      if (clientY <= bounds.top + 92) {
        setRequestConfigCollapsed(true);
        return;
      }

      const nextRatio = (bounds.bottom - clientY) / bounds.height;
      setRequestConfigCollapsed(false);
      setResponsePanelRatio(Math.min(0.82, Math.max(0.22, nextRatio)));
    };
    const onPointerMove = (moveEvent: PointerEvent) => updateResponseRatio(moveEvent.clientY);
    const onPointerUp = () => {
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
      document.body.classList.remove("http-workbench-resizing");
    };

    document.body.classList.add("http-workbench-resizing");
    updateResponseRatio(event.clientY);
    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp);
  };

  const renderEditableName = (type: TreeNodeType, id: string, value: string) => {
    if (editingNode?.type !== type || editingNode.id !== id) {
      return <strong title={value}>{value}</strong>;
    }

    return (
      <TextInput
        autoFocus
        className="http-tree-inline-input"
        value={editingNode.value}
        onBlur={commitRename}
        onChange={(event) => setEditingNode({ ...editingNode, value: event.target.value })}
        onClick={(event) => event.stopPropagation()}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            commitRename();
          }

          if (event.key === "Escape") {
            event.preventDefault();
            setEditingNode(null);
          }
        }}
      />
    );
  };

  const renderKeyValueRows = (field: RequestRowField) => {
    const rows = trimTrailingBlankRows(activeRequest?.[field] ?? []);
    const displayRows = [...rows, requestDraftRows[field]];
    const isFormBody = field === "formBody";

    return (
      <div className={["http-parameter-table", isFormBody ? "http-form-table" : ""].filter(Boolean).join(" ")}>
        <div className="http-parameter-header" aria-hidden="true">
          <span />
          <span>名称</span>
          {isFormBody ? <span>类型</span> : null}
          <span>值</span>
          <span>描述</span>
          <span />
        </div>
        {displayRows.map((entry, index) => {
          const isVirtualRow = index >= rows.length;

          return (
            <div
              className={[
                "http-parameter-row",
                isFormBody ? "http-form-row" : "",
                entry.enabled ? "enabled" : "",
                isVirtualRow ? "virtual" : "",
              ]
                .filter(Boolean)
                .join(" ")}
              key={`${field}-${isVirtualRow ? "blank" : index}`}
              onBlur={
                isVirtualRow
                  ? (event) => {
                      const nextFocus = event.relatedTarget;
                      if (nextFocus instanceof Node && event.currentTarget.contains(nextFocus)) {
                        return;
                      }
                      commitRequestDraft(field);
                    }
                  : undefined
              }
              onKeyDown={
                isVirtualRow
                  ? (event) => {
                      if (event.key === "Enter") {
                        event.preventDefault();
                        commitRequestDraft(field);
                      }
                    }
                  : undefined
              }
            >
              <button
                aria-label={entry.enabled ? "停用条目" : "启用条目"}
                className="http-param-check"
                disabled={isVirtualRow}
                onClick={() => updateRequestRow(field, index, { enabled: !entry.enabled })}
                type="button"
              >
                {entry.enabled ? <Icon name="check" /> : null}
              </button>
              <TextInput
                value={entry.key}
                onChange={(event) => updateRequestRow(field, index, { key: event.target.value })}
                placeholder="key"
                aria-label="名称"
              />
              {isFormBody ? (
                <button
                  className="http-form-type-toggle"
                  onClick={() => setFormRowValueType(index, formValueTypeFor(entry) === "file" ? "text" : "file")}
                  title="切换表单值类型"
                  type="button"
                >
                  {formValueTypeFor(entry) === "file" ? "文件" : "文本"}
                </button>
              ) : null}
              {isFormBody && formValueTypeFor(entry) === "file" ? (
                <div className="http-form-file-control">
                  <div className="http-form-file-summary" title={entry.fileName || entry.value || "未选择文件"}>
                    <strong>{entry.fileName || entry.value || "未选择文件"}</strong>
                    <small>
                      {entry.localFileId
                        ? typeof entry.fileSize === "number"
                          ? formatBytes(entry.fileSize)
                          : "已选择"
                        : entry.fileName || entry.value
                          ? "需要重新选择"
                          : "重新选择文件后可发送"}
                    </small>
                  </div>
                  <label className="http-form-file-button">
                    <Icon name="upload" />
                    <span>选择</span>
                    <input
                      aria-label="选择表单文件"
                      type="file"
                      onChange={(event) => {
                        selectFormFile(index, event.currentTarget.files?.[0]);
                        event.currentTarget.value = "";
                      }}
                    />
                  </label>
                </div>
              ) : (
                <TextInput
                  value={entry.value}
                  onChange={(event) => updateRequestRow(field, index, { value: event.target.value })}
                  placeholder="value"
                  aria-label="值"
                />
              )}
              <TextInput
                value={entry.description ?? ""}
                onChange={(event) => updateRequestRow(field, index, { description: event.target.value })}
                placeholder="描述"
                aria-label="描述"
              />
              <div className="http-param-actions">
                <IconButton
                  aria-label="上移条目"
                  disabled={isVirtualRow || index === 0}
                  icon="chevron-left"
                  onClick={() => moveRequestRow(field, index, -1)}
                />
                <IconButton
                  aria-label="下移条目"
                  disabled={isVirtualRow || index === rows.length - 1}
                  icon="chevron-right"
                  onClick={() => moveRequestRow(field, index, 1)}
                />
                <IconButton
                  aria-label="删除条目"
                  disabled={isVirtualRow}
                  icon="trash"
                  onClick={() => removeRequestRow(field, index)}
                  tone="danger"
                />
              </div>
            </div>
          );
        })}
      </div>
    );
  };

  const renderBodyEditor = () => {
    if (!activeRequest) {
      return null;
    }

    return (
      <div className="http-body-editor">
        <div className="http-editor-toolbar">
          <span>Body 类型</span>
          <div className="http-editor-toolbar-actions">
            {activeRequest.bodyMode === "json" ? (
              <Button
                disabled={!activeRequest.body.trim()}
                icon="file-code"
                onClick={formatJsonBody}
                tone="muted"
              >
                格式化
              </Button>
            ) : null}
            <Select
              aria-label="请求体类型"
              value={activeRequest.bodyMode}
              options={bodyModeOptions}
              onChange={(bodyMode) => updateActiveRequest({ bodyMode })}
            />
          </div>
        </div>
        {activeRequest.bodyMode === "none" ? (
          <div className="http-panel-empty">
            <Icon name="ban" />
            <strong>当前请求不发送请求体</strong>
            <span>GET、HEAD 请求发送时也会自动忽略 Body。</span>
          </div>
        ) : null}
        {activeRequest.bodyMode === "json" || activeRequest.bodyMode === "text" ? (
          <TextArea
            mono
            aria-label="请求 Body"
            value={activeRequest.body}
            onChange={(event) => updateActiveRequest({ body: event.target.value })}
            placeholder={activeRequest.bodyMode === "json" ? "{\n  \"key\": \"value\"\n}" : "Request body"}
          />
        ) : null}
        {activeRequest.bodyMode === "form" ? renderKeyValueRows("formBody") : null}
      </div>
    );
  };

  const renderAuthEditor = () => {
    if (!activeRequest) {
      return null;
    }

    return (
      <div className="http-auth-editor">
        <div className="http-editor-toolbar">
          <span>认证方式</span>
          <Select
            aria-label="认证方式"
            value={activeRequest.auth.type}
            options={authTypeOptions}
            onChange={(type) => updateActiveAuth({ type })}
          />
        </div>
        {activeRequest.auth.type === "none" ? (
          <div className="http-panel-empty">
            <Icon name="shield" />
            <strong>不使用认证</strong>
            <span>发送时不会自动追加 Authorization 或 API Key。</span>
          </div>
        ) : null}
        {activeRequest.auth.type === "bearer" ? (
          <label className="http-field-row http-token-row">
            <span>Token</span>
            <TextArea
              mono
              value={activeRequest.auth.bearerToken}
              onChange={(event) => updateActiveAuth({ bearerToken: event.target.value })}
              placeholder="Bearer token"
            />
          </label>
        ) : null}
        {activeRequest.auth.type === "basic" ? (
          <div className="http-auth-grid">
            <label className="http-field-row">
              <span>用户名</span>
              <TextInput
                value={activeRequest.auth.username}
                onChange={(event) => updateActiveAuth({ username: event.target.value })}
                placeholder="username"
              />
            </label>
            <label className="http-field-row">
              <span>密码</span>
              <TextInput
                type="password"
                value={activeRequest.auth.password}
                onChange={(event) => updateActiveAuth({ password: event.target.value })}
                placeholder="password"
              />
            </label>
          </div>
        ) : null}
        {activeRequest.auth.type === "api-key" ? (
          <div className="http-auth-grid">
            <label className="http-field-row">
              <span>位置</span>
              <Select
                aria-label="API Key 位置"
                value={activeRequest.auth.apiKeyLocation}
                options={apiKeyLocationOptions}
                onChange={(apiKeyLocation) => updateActiveAuth({ apiKeyLocation })}
              />
            </label>
            <label className="http-field-row">
              <span>名称</span>
              <TextInput
                value={activeRequest.auth.apiKeyName}
                onChange={(event) => updateActiveAuth({ apiKeyName: event.target.value })}
                placeholder={activeRequest.auth.apiKeyLocation === "header" ? "X-API-Key" : "api_key"}
              />
            </label>
            <label className="http-field-row">
              <span>值</span>
              <TextInput
                mono
                value={activeRequest.auth.apiKeyValue}
                onChange={(event) => updateActiveAuth({ apiKeyValue: event.target.value })}
                placeholder="value"
              />
            </label>
          </div>
        ) : null}
      </div>
    );
  };

  const renderRequestPreview = () => {
    if (!activeRequest) {
      return null;
    }

    return (
      <div className="http-preview-panel">
        <div className="http-editor-toolbar">
          <span>发送预览</span>
          <Button icon="copy" onClick={() => copyText(buildRequestPreview(activeRequest, activeVariables))} tone="muted">
            复制
          </Button>
        </div>
        <pre>{buildRequestPreview(activeRequest, activeVariables)}</pre>
      </div>
    );
  };

  const renderResponseHeaders = (targetResponse = response) => {
    if (!targetResponse) {
      return null;
    }

    const headerEntries = Object.entries(targetResponse.headers);

    return (
      <div className="http-response-headers">
        {headerEntries.length ? (
          headerEntries.map(([key, value]) => (
            <div key={key}>
              <span>{key}</span>
              <code>{value}</code>
            </div>
          ))
        ) : (
          <div className="http-response-empty compact">暂无响应头。</div>
        )}
      </div>
    );
  };

	  const renderResponseBody = () => {
	    if (!response) {
	      return null;
	    }

	    const renderBodyCopyButton = () => (
	      <div className="http-response-body-toolbar">
	        <Button disabled={!response.body} icon="copy" onClick={() => copyText(response.body)} tone="muted">
	          复制
	        </Button>
	      </div>
	    );
	
	    if (response.bodyKind === "image" && response.body) {
	      return (
	        <div className="http-response-body-panel">
	          {renderBodyCopyButton()}
	          <div className="http-response-image">
	            <img alt="HTTP 响应图片" src={response.body} />
	          </div>
	        </div>
	      );
	    }

    if (isSending && !response.body) {
      return (
        <div className="http-response-loading">
          <span className="http-response-loading-orbit" aria-hidden="true">
            <span />
            <span />
            <span />
          </span>
          <strong>请求发送中</strong>
          <small>正在等待服务器响应...</small>
        </div>
      );
    }
	
	    return (
	      <div className="http-response-body-panel">
	        {renderBodyCopyButton()}
	        <pre className={isSending ? "streaming" : ""}>
	          {response.body || (isSending ? "正在接收响应..." : "响应体为空。")}
	        </pre>
	      </div>
	    );
	  };

  const renderResponseHistory = () => (
    <div className="http-response-history">
      {responseHistory.length ? (
        responseHistory.map((entry) => (
          <button
            className={["http-response-history-item", entry.error ? "error" : ""].filter(Boolean).join(" ")}
            key={entry.id}
            onClick={() => {
              setResponse(entry.response ?? null);
              setResponseError(entry.error ?? "");
              setResponseView(entry.response ? "body" : "history");
            }}
            type="button"
          >
            <span className={methodClass(entry.method)}>{entry.method}</span>
            <strong>{entry.name}</strong>
            <code>{entry.url || "<未填写 URL>"}</code>
            <small>{new Date(entry.timestamp).toLocaleTimeString()}</small>
            <small>{entry.response ? `${entry.response.status} ${entry.response.statusText}` : entry.error}</small>
          </button>
        ))
      ) : (
        <div className="http-response-empty compact">
          <Icon name="activity" />
          <strong>暂无历史记录</strong>
          <span>发送请求后会记录最近 50 次结果。</span>
        </div>
      )}
    </div>
  );

  const renderContextMenu = () => {
    if (!contextMenu) {
      return null;
    }

    const menuWorkspace = workspaces.find((workspace) => workspace.id === contextMenu.workspaceId) ?? activeWorkspace;
    const menuProject = contextMenu.projectId
      ? menuWorkspace.projects.find((project) => project.id === contextMenu.projectId) ?? menuWorkspace.projects[0]
      : menuWorkspace.projects[0];
    const menuRequestList = contextMenu.projectId ? menuProject?.requests ?? [] : menuWorkspace.requests;
    const menuRequest =
      menuRequestList.find((request) => request.id === contextMenu.requestId) ?? (contextMenu.requestId ? null : activeRequest);

    return (
      <div
        className="http-context-menu"
        role="menu"
        style={{ left: contextMenu.x, top: contextMenu.y }}
        onPointerDown={(event) => event.stopPropagation()}
      >
        {contextMenu.type === "tree" || contextMenu.type === "workspace" ? (
          <>
            <Button icon="server" onClick={createWorkspace} role="menuitem" title="创建工作区" tone="muted">
              <span>新建工作区</span>
            </Button>
            <Button icon="folder-plus" onClick={() => createProject(menuWorkspace.id)} role="menuitem" title="创建项目" tone="muted">
              <span>新建项目</span>
            </Button>
            <Button icon="file-text" onClick={() => createRequest(menuWorkspace.id, null)} role="menuitem" title="创建请求" tone="muted">
              <span>新建请求</span>
            </Button>
          </>
        ) : null}
        {contextMenu.type === "workspace" ? (
          <>
            <Button
              icon="edit"
              onClick={() => beginRename("workspace", menuWorkspace.id, menuWorkspace.name)}
              role="menuitem"
              title="重命名工作区"
              tone="muted"
            >
              <span>重命名</span>
            </Button>
            <Button icon="copy" onClick={() => copyText(menuWorkspace.name)} role="menuitem" title="复制工作区名称" tone="muted">
              <span>复制名称</span>
            </Button>
            <Button
              className="danger-action"
              disabled={workspaces.length <= 1}
              icon="trash"
              onClick={() => requestDeleteWorkspace(menuWorkspace.id)}
              role="menuitem"
              title={workspaces.length <= 1 ? "至少保留一个工作区" : "删除工作区"}
              tone="danger"
            >
              <span>删除工作区</span>
            </Button>
          </>
        ) : null}
        {contextMenu.type === "project" && menuProject ? (
          <>
            <Button
              icon="plus"
              onClick={() => createRequest(menuWorkspace.id, menuProject.id)}
              role="menuitem"
              title="创建请求"
              tone="muted"
            >
              <span>新建请求</span>
            </Button>
            <Button
              icon="edit"
              onClick={() => beginRename("project", menuProject.id, menuProject.name)}
              role="menuitem"
              title="重命名项目"
              tone="muted"
            >
              <span>重命名</span>
            </Button>
            <Button icon="copy" onClick={() => copyText(menuProject.name)} role="menuitem" title="复制项目名称" tone="muted">
              <span>复制名称</span>
            </Button>
            <Button
              className="danger-action"
              icon="trash"
              onClick={() => requestDeleteProject(menuWorkspace.id, menuProject.id)}
              role="menuitem"
              title="删除项目"
              tone="danger"
            >
              <span>删除项目</span>
            </Button>
          </>
        ) : null}
        {contextMenu.type === "request" && menuRequest ? (
          <>
            <Button
              icon="copy"
              onClick={() => duplicateRequest(menuWorkspace.id, contextMenu.projectId ?? null, menuRequest.id)}
              role="menuitem"
              title="复制请求"
              tone="muted"
            >
              <span>复制请求</span>
            </Button>
            <Button
              icon="edit"
              onClick={() => beginRename("request", menuRequest.id, menuRequest.name)}
              role="menuitem"
              title="重命名请求"
              tone="muted"
            >
              <span>重命名</span>
            </Button>
            <Button icon="external-link" onClick={() => copyText(menuRequest.url || menuRequest.name)} role="menuitem" title="复制请求地址" tone="muted">
              <span>复制 URL</span>
            </Button>
            <Button
              className="danger-action"
              icon="trash"
              onClick={() => requestDeleteRequest(menuWorkspace.id, contextMenu.projectId ?? null, menuRequest.id)}
              role="menuitem"
              title="删除请求"
              tone="danger"
            >
              <span>删除请求</span>
            </Button>
          </>
        ) : null}
      </div>
    );
  };

  const workspaceRequestCount =
    activeWorkspace.requests.length +
    activeWorkspace.projects.reduce((count, project) => count + project.requests.length, 0);
  const treeDndHandlers: HttpTreeDndHandlers = {
    clearTreeDrag,
    dropTreeNode,
    startTreeDrag,
    startTreePointerDrag,
    treeDragClassName,
    treeDropClassName,
    updateTreeDropTarget,
  };

  const renderTreeDragPreview = () => {
    if (!treeDragPreview) {
      return null;
    }

    const workspace = workspaces.find((item) => item.id === treeDragPreview.drag.workspaceId);

    if (!workspace) {
      return null;
    }

    if (treeDragPreview.drag.type === "project") {
      const project = workspace.projects.find((item) => item.id === treeDragPreview.drag.nodeId);

      if (!project) {
        return null;
      }

      return (
        <div
          className="http-tree-drag-preview http-tree-drag-preview-project"
          style={{ left: treeDragPreview.x + 14, top: treeDragPreview.y + 14 }}
        >
          <Icon name="folder-open" />
          <strong>{project.name}</strong>
        </div>
      );
    }

    const requestList = treeDragPreview.drag.projectId
      ? workspace.projects.find((item) => item.id === treeDragPreview.drag.projectId)?.requests
      : workspace.requests;
    const request = requestList?.find((item) => item.id === treeDragPreview.drag.nodeId);

    if (!request) {
      return null;
    }

    return (
      <div
        className="http-tree-drag-preview http-tree-drag-preview-request"
        style={{ left: treeDragPreview.x + 14, top: treeDragPreview.y + 14 }}
      >
        <span className={methodClass(request.method)}>{request.method}</span>
        <strong>{request.name}</strong>
      </div>
    );
  };

  const renderRequestTreeMoreAction = (request: HttpRequestDraft, projectId: string | null) => (
    <IconButton
      aria-label="请求更多操作"
      className="http-tree-action"
      icon="more-horizontal"
      title="更多"
      onClick={(event) => {
        event.stopPropagation();
        selectRequest(projectId, request.id);
        const bounds = event.currentTarget.getBoundingClientRect();
        setContextMenu({
          type: "request",
          workspaceId: activeWorkspace.id,
          projectId: projectId ?? undefined,
          requestId: request.id,
          x: bounds.right,
          y: bounds.bottom + 4,
        });
      }}
      onPointerDown={(event) => event.stopPropagation()}
    />
  );

  const renderShareWorkspace = () => {
    const selectedCount = selectedShareRequestIdsForWorkspace.size;

    return (
      <section className="http-share-workbench" aria-label="分享与导入">
        <header className="http-share-heading">
          <div>
            <strong>分享与导入</strong>
            <span>{activeWorkspace.name}</span>
          </div>
          <Tag icon="file-code" tone="accent">
            v{httpWorkspaceShareVersion}
          </Tag>
        </header>

        <div className="http-share-tabs" role="tablist" aria-label="分享导入">
          <Button active={activeShareView === "export"} icon="download" onClick={() => setActiveShareView("export")} tone="muted">
            <span>导出 JSON</span>
            <small>{selectedCount}</small>
          </Button>
          <Button active={activeShareView === "import"} icon="upload" onClick={() => setActiveShareView("import")} tone="muted">
            <span>导入 JSON</span>
          </Button>
        </div>

        <div className="http-share-editor">
          {activeShareView === "export" ? (
            <div className="http-share-export-panel">
              <div className="http-share-toolbar">
                <span>{shareRequestOptions.length} 请求 · 已选 {selectedCount}</span>
                <div>
                  <Button icon="check" onClick={selectAllShareRequests} tone="muted">
                    全选
                  </Button>
                  <Button icon="x" onClick={clearShareRequestSelection} tone="muted">
                    清空
                  </Button>
                </div>
              </div>

              <div className="http-share-export-grid">
                <div className="http-share-request-list" aria-label="选择导出的请求">
                  {shareRequestOptions.length > 0 ? (
                    shareRequestOptions.map((option) => (
                      <label className="check-row http-share-request-row" key={option.id}>
                        <input
                          checked={selectedShareRequestIdsForWorkspace.has(option.id)}
                          onChange={() => toggleShareRequestSelection(option.id)}
                          type="checkbox"
                        />
                        <span className="check-row-label">
                          <span className={methodClass(option.request.method)}>{option.request.method}</span>
                          <strong>{option.request.name}</strong>
                          <small>{option.projectName}</small>
                          <code>{option.request.url || "<未填写 URL>"}</code>
                        </span>
                      </label>
                    ))
                  ) : (
                    <div className="http-response-empty compact">
                      <Icon name="file-text" />
                      <strong>暂无请求</strong>
                      <span>JSON 会包含工作区变量和环境。</span>
                    </div>
                  )}
                </div>

                <div className="http-share-json-panel">
                  <TextArea aria-label="导出 JSON" className="http-share-json-textarea" mono readOnly value={shareJson} />
                </div>
              </div>

              <div className="http-share-actions">
                {shareError ? <span className="http-share-error">{shareError}</span> : <span>{shareMessage}</span>}
                <div>
                  <Button icon="copy" onClick={copyShareJson} tone="muted">
                    复制 JSON
                  </Button>
                  <Button icon="download" onClick={downloadShareJson} tone="primary">
                    下载 JSON
                  </Button>
                </div>
              </div>
            </div>
          ) : (
            <div className="http-share-import-panel">
              <div className="http-share-import-options">
                <div className="http-share-option-group">
                  <span>导入目标</span>
                  <div className="http-share-choice-row" role="tablist" aria-label="导入目标">
                    <Button active={importTarget === "current"} onClick={() => setImportTarget("current")} tone="muted">
                      当前工作区
                    </Button>
                    <Button active={importTarget === "new"} onClick={() => setImportTarget("new")} tone="muted">
                      新建工作区
                    </Button>
                  </div>
                </div>
                <div className="http-share-option-group">
                  <span>同 URL 请求</span>
                  <div className="http-share-choice-row" role="tablist" aria-label="同 URL 请求处理">
                    <Button
                      active={importConflictMode === "overwrite"}
                      disabled={importTarget !== "current"}
                      onClick={() => setImportConflictMode("overwrite")}
                      tone="muted"
                    >
                      覆盖
                    </Button>
                    <Button
                      active={importConflictMode === "ignore"}
                      disabled={importTarget !== "current"}
                      onClick={() => setImportConflictMode("ignore")}
                      tone="muted"
                    >
                      忽略
                    </Button>
                  </div>
                </div>
              </div>
              <TextArea
                aria-label="导入 JSON"
                className="http-share-import-textarea"
                mono
                onChange={(event) => {
                  setImportJson(event.target.value);
                  setShareError("");
                  setShareMessage("");
                }}
                placeholder={`{\n  "kind": "${httpWorkspaceShareKind}",\n  "version": ${httpWorkspaceShareVersion},\n  "workspace": {}\n}`}
                value={importJson}
              />
              <div className="http-share-actions">
                {shareError ? <span className="http-share-error">{shareError}</span> : <span>{shareMessage}</span>}
                <div>
                  <Button disabled={!importJson.trim()} icon="upload" onClick={importShareJson} tone="primary">
                    {importTarget === "current" ? "导入到当前工作区" : "导入为新工作区"}
                  </Button>
                </div>
              </div>
            </div>
          )}
        </div>
      </section>
    );
  };

  const renderEnvironmentWorkspace = () => {
    const selectedScopeRows = activeVariableRows[selectedVariableScope];
    const selectedScopeIsAvailable = variableScopeAvailable(selectedVariableScope);
    const rows = trimTrailingBlankRows(selectedScopeRows);
    const displayRows = [...rows, variableDraftRows[selectedVariableScope]];

    return (
      <section className="http-environment-workbench" aria-label="变量环境">
        <header className="http-environment-heading">
          <div>
            <strong>变量环境</strong>
            <span>{activeWorkspace.name}</span>
          </div>
          {selectedVariableScope === "environment" ? (
            <IconButton aria-label="新建环境" icon="plus" onClick={createEnvironment} title="新建环境" />
          ) : null}
        </header>
        <div className="http-environment-toolbar">
          <div className="http-variable-scope-tabs" role="tablist" aria-label="变量作用域">
            {variableScopeOptions.map((scope) => (
              <Button
                active={selectedVariableScope === scope.value}
                disabled={!variableScopeAvailable(scope.value)}
                key={scope.value}
                onClick={() => setSelectedVariableScope(scope.value)}
                tone="muted"
              >
                <span>{scope.label}</span>
                <small>{trimTrailingBlankRows(activeVariableRows[scope.value]).length}</small>
              </Button>
            ))}
          </div>
          {selectedVariableScope === "environment" ? (
            <div className="http-environment-tags" aria-label="环境列表">
              {workspaceEnvironments.map((environment) => (
                <button
                  className={environment.id === activeEnvironment?.id ? "active" : ""}
                  key={environment.id}
                  onClick={() => setActiveEnvironment(environment.id)}
                  type="button"
                >
                  {environment.name}
                </button>
              ))}
            </div>
          ) : null}
        </div>
        <div className="http-environment-editor">
          {selectedScopeIsAvailable ? (
            <>
            {selectedVariableScope === "environment" && activeEnvironment ? (
              <div className="http-environment-name-row">
                <TextInput
                  aria-label="环境名称"
                  value={activeEnvironment.name}
                  onChange={(event) => renameActiveEnvironment(event.target.value)}
                />
                <IconButton
                  aria-label="删除当前环境"
                  disabled={workspaceEnvironments.length <= 1}
                  icon="trash"
                  onClick={requestDeleteActiveEnvironment}
                  title="删除环境"
                  tone="danger"
                />
              </div>
            ) : null}
            <div className="http-environment-variable-table">
              <div className="http-environment-variable-header">
                <span />
                <span>变量</span>
                <span>值</span>
                <span>引用</span>
                <span>敏感</span>
                <span>描述</span>
                <span />
              </div>
              {displayRows.map((entry, index) => {
                const isVirtualRow = index >= rows.length;

                return (
	                  <div
	                    className={["http-environment-variable-row", entry.enabled ? "enabled" : "", isVirtualRow ? "virtual" : ""]
	                      .filter(Boolean)
	                      .join(" ")}
	                    key={isVirtualRow ? "blank" : index}
	                    onBlur={
	                      isVirtualRow
	                        ? (event) => {
	                            const nextFocus = event.relatedTarget;
	                            if (nextFocus instanceof Node && event.currentTarget.contains(nextFocus)) {
	                              return;
	                            }
	                            commitVariableDraft(selectedVariableScope);
	                          }
	                        : undefined
	                    }
	                    onKeyDown={
	                      isVirtualRow
	                        ? (event) => {
	                            if (event.key === "Enter") {
	                              event.preventDefault();
	                              commitVariableDraft(selectedVariableScope);
	                            }
	                          }
	                        : undefined
	                    }
	                  >
                    <button
                      aria-label={entry.enabled ? "停用变量" : "启用变量"}
                      className="http-param-check"
                      disabled={isVirtualRow}
                      onClick={() => updateScopedVariable(selectedVariableScope, index, { enabled: !entry.enabled })}
                      type="button"
                    >
                      {entry.enabled ? <Icon name="check" /> : null}
                    </button>
                    <TextInput
                      aria-label="变量名"
                      value={entry.key}
                      onChange={(event) => updateScopedVariable(selectedVariableScope, index, { key: event.target.value })}
                      placeholder="name"
                    />
	                    <TextInput
	                      aria-label="变量值"
	                      value={entry.value}
	                      onChange={(event) => updateScopedVariable(selectedVariableScope, index, { value: event.target.value })}
	                      placeholder="value"
	                      type={entry.sensitive ? "password" : "text"}
                    />
                    <button
                      className="http-variable-reference"
                      disabled={!entry.key.trim()}
                      onClick={() => copyText(`{{${entry.key.trim()}}}`)}
                      type="button"
                    >
                      {entry.key.trim() ? `{{${entry.key.trim()}}}` : "{{name}}"}
                    </button>
                    <button
                      aria-label={entry.sensitive ? "取消敏感变量" : "设为敏感变量"}
                      className="http-param-check"
                      disabled={isVirtualRow}
                      onClick={() => updateScopedVariable(selectedVariableScope, index, { sensitive: !entry.sensitive })}
                      type="button"
                    >
                      {entry.sensitive ? <Icon name="check" /> : null}
                    </button>
                    <TextInput
                      aria-label="变量描述"
                      value={entry.description ?? ""}
	                      onChange={(event) => updateScopedVariable(selectedVariableScope, index, { description: event.target.value })}
	                      placeholder="描述"
	                    />
	                    <IconButton
                      aria-label="删除变量"
                      disabled={isVirtualRow}
                      icon="trash"
                      onClick={() => removeScopedVariable(selectedVariableScope, index)}
                      tone="danger"
                    />
                  </div>
                );
              })}
            </div>
            </>
          ) : (
            <div className="http-request-empty">
              <Icon name="palette" />
              <strong>当前作用域不可用</strong>
              <span>选择对应项目或请求后可编辑。</span>
            </div>
          )}
        </div>
      </section>
    );
  };

  const deleteConfirmContent = deleteConfirm ? getDeleteConfirmContent(deleteConfirm) : null;

  return (
    <section className="http-console" aria-label="HTTP/API 调试">
      {renderTreeDragPreview()}
      <aside className="http-console-sidebar" aria-label="HTTP 工作区">
        <div className="http-sidebar-card http-sidebar-control-card">
          <div className="http-sidebar-brand">
            <strong>HTTP Console</strong>
            <span>{activeEnvironment?.name ?? "无环境"}</span>
          </div>
          <div className="http-workspace-row">
            <div className="http-workspace-switcher">
              <Select
                aria-label="选择 HTTP 工作区"
                value={activeWorkspace.id}
                options={workspaces.map((workspace) => ({
                  label: workspace.name,
                  value: workspace.id,
                }))}
                onChange={(workspaceId) => {
                  const workspace = workspaces.find((item) => item.id === workspaceId);
                  if (workspace) {
                    selectWorkspace(workspace);
                  }
                }}
              />
            </div>
            <IconButton aria-label="新建工作区" icon="plus" title="新建工作区" onClick={createWorkspace} />
          </div>
          <div className="http-sidebar-tool-row">
            <Button
              active={environmentTabOpen && activeMainView === "environment"}
              aria-label="变量环境"
              icon="palette"
              onClick={openEnvironmentTab}
              tone="muted"
              title="变量环境"
            >
              变量环境
            </Button>
            <Button
              active={shareTabOpen && activeMainView === "share"}
              aria-label="分享导入"
              icon="upload"
              onClick={openShareTab}
              tone="muted"
              title="分享导入"
            >
              分享导入
            </Button>
          </div>
        </div>

        <div className="http-sidebar-card http-tree-card">
          <div className="http-tree-title">
            <strong>工作区</strong>
            <span>{activeWorkspace.projects.length} 项目 · {workspaceRequestCount} 请求</span>
          </div>
          <div className="http-tree-search" onClick={() => treeSearchInputRef.current?.focus()}>
            <Icon name="search" />
            <TextInput
              aria-label="搜索工作区项目和请求"
              onChange={(event) => setTreeSearchQuery(event.target.value)}
              placeholder="搜索项目、分组、请求"
              ref={treeSearchInputRef}
              value={treeSearchQuery}
            />
          </div>
          <div
            className="http-tree"
            role="tree"
            onContextMenu={(event) => {
              event.preventDefault();
              setContextMenu({ type: "tree", workspaceId: activeWorkspace.id, x: event.clientX, y: event.clientY });
            }}
          >
            <HttpTreeItem
              dnd={treeDndHandlers}
              drop={{ type: "workspace", workspaceId: activeWorkspace.id, projectId: null }}
              onClick={(event) => {
                if (!ignoreTreeClickAfterDrag(event)) {
                  selectWorkspace(activeWorkspace);
                }
              }}
              onContextMenu={(event) => {
                event.preventDefault();
                event.stopPropagation();
                setContextMenu({
                  type: "workspace",
                  workspaceId: activeWorkspace.id,
                  x: event.clientX,
                  y: event.clientY,
                });
              }}
              onDoubleClick={() => beginRename("workspace", activeWorkspace.id, activeWorkspace.name)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  selectWorkspace(activeWorkspace);
                }

                if (event.key === "F2") {
                  event.preventDefault();
                  beginRename("workspace", activeWorkspace.id, activeWorkspace.name);
                }
              }}
              root
              title={activeWorkspace.name}
            >
              <Icon name="server" />
              {renderEditableName("workspace", activeWorkspace.id, activeWorkspace.name)}
              <HttpTreeCreateAction
                className="http-tree-root-action"
                label="在工作区中新建请求"
                onCreate={() => createRequest(activeWorkspace.id, null)}
                title="新建请求"
              />
              <IconButton
                aria-label="工作区更多操作"
                className="http-tree-root-action"
                icon="more-horizontal"
                title="更多"
                onClick={(event) => {
                  event.stopPropagation();
                  const bounds = event.currentTarget.getBoundingClientRect();
                  setContextMenu({
                    type: "workspace",
                    workspaceId: activeWorkspace.id,
                    x: bounds.right,
                    y: bounds.bottom + 4,
                  });
                }}
              />
            </HttpTreeItem>
            <div className="http-tree-group">
              {activeWorkspace.requests.map((request) => (
	                <HttpTreeItem
	                  active={showTreeSelection && !activeProject && request.id === activeRequest?.id}
                  className="http-request-row http-workspace-request-row"
                  dnd={treeDndHandlers}
                  drag={{
                    type: "request",
                    workspaceId: activeWorkspace.id,
                    projectId: null,
                    nodeId: request.id,
                  }}
                  drop={{
                    type: "request",
                    workspaceId: activeWorkspace.id,
                    projectId: null,
                    requestId: request.id,
                  }}
                  key={request.id}
                  onClick={(event) => {
                    if (!ignoreTreeClickAfterDrag(event) && editingNode?.id !== request.id) {
                      selectRequest(null, request.id);
                    }
                  }}
                  onContextMenu={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    selectRequest(null, request.id);
                    setContextMenu({
                      type: "request",
                      workspaceId: activeWorkspace.id,
                      requestId: request.id,
                      x: event.clientX,
                      y: event.clientY,
                    });
                  }}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      selectRequest(null, request.id);
                    }
                  }}
	                >
	                  <span className={methodClass(request.method)}>{request.method}</span>
	                  {renderEditableName("request", request.id, request.name)}
	                  {renderRequestTreeMoreAction(request, null)}
	                </HttpTreeItem>
              ))}

              {activeWorkspace.projects.map((project) => (
                <div className="http-tree-group" key={project.id}>
		                  <HttpTreeItem
		                    active={showTreeSelection && project.id === activeProject?.id && !activeRequest}
	                    className={[
	                      "http-project-row",
	                      showTreeSelection && project.id === activeProject?.id && activeRequest ? "parent-active" : "",
	                    ]
	                      .filter(Boolean)
	                      .join(" ")}
                    dnd={treeDndHandlers}
                    drag={{
                      type: "project",
                      workspaceId: activeWorkspace.id,
                      projectId: null,
                      nodeId: project.id,
                    }}
                    drop={{
                      type: "project",
                      workspaceId: activeWorkspace.id,
                      projectId: project.id,
                    }}
                    onClick={(event) => {
                      if (!ignoreTreeClickAfterDrag(event) && editingNode?.id !== project.id) {
                        selectProject(project);
                      }
                    }}
                    onContextMenu={(event) => {
                      event.preventDefault();
                      event.stopPropagation();
                      setContextMenu({
                        type: "project",
                        workspaceId: activeWorkspace.id,
                        projectId: project.id,
                        x: event.clientX,
                        y: event.clientY,
                      });
                    }}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") {
                        selectProject(project);
                      }
                    }}
                  >
                    <Icon name="folder-open" />
                    {renderEditableName("project", project.id, project.name)}
                    <HttpTreeCreateAction
                      label={`在 ${project.name} 中新建请求`}
                      onCreate={() => createRequest(activeWorkspace.id, project.id)}
                      title="新建请求"
                    />
                    <IconButton
                      aria-label="项目更多操作"
                      className="http-tree-action"
                      icon="more-horizontal"
                      title="更多"
                      onClick={(event) => {
                        event.stopPropagation();
                        const bounds = event.currentTarget.getBoundingClientRect();
                        setContextMenu({
                          type: "project",
                          workspaceId: activeWorkspace.id,
                          projectId: project.id,
                          x: bounds.right,
                          y: bounds.bottom + 4,
                        });
                      }}
                      onPointerDown={(event) => event.stopPropagation()}
                    />
                  </HttpTreeItem>
                  {project.requests.map((request) => (
	                    <HttpTreeItem
	                      active={showTreeSelection && activeProject?.id === project.id && request.id === activeRequest?.id}
                      className="http-request-row http-project-request-row"
                      dnd={treeDndHandlers}
                      drag={{
                        type: "request",
                        workspaceId: activeWorkspace.id,
                        projectId: project.id,
                        nodeId: request.id,
                      }}
                      drop={{
                        type: "request",
                        workspaceId: activeWorkspace.id,
                        projectId: project.id,
                        requestId: request.id,
                      }}
                      key={request.id}
                      onClick={(event) => {
                        if (!ignoreTreeClickAfterDrag(event) && editingNode?.id !== request.id) {
                          selectRequest(project.id, request.id);
                        }
                      }}
                      onContextMenu={(event) => {
                        event.preventDefault();
                        event.stopPropagation();
                        selectRequest(project.id, request.id);
                        setContextMenu({
                          type: "request",
                          workspaceId: activeWorkspace.id,
                          projectId: project.id,
                          requestId: request.id,
                          x: event.clientX,
                          y: event.clientY,
                        });
                      }}
                      onKeyDown={(event) => {
                        if (event.key === "Enter") {
                          selectRequest(project.id, request.id);
                        }
                      }}
	                    >
	                      <span className={methodClass(request.method)}>{request.method}</span>
	                      {renderEditableName("request", request.id, request.name)}
	                      {renderRequestTreeMoreAction(request, project.id)}
	                    </HttpTreeItem>
                  ))}
                </div>
              ))}
            </div>
          </div>
        </div>
      </aside>

      <div className="http-console-main">
        <div className="http-request-tabs" aria-label="HTTP 请求编辑标签" role="tablist">
          {environmentTabOpen ? (
            <div
              className={["http-request-tab", "http-environment-main-tab", activeMainView === "environment" ? "active" : ""]
                .filter(Boolean)
                .join(" ")}
              onAuxClick={(event) => {
                if (event.button === 1) {
                  event.preventDefault();
                  closeEnvironmentTab();
                }
              }}
            >
              <Button
                aria-selected={activeMainView === "environment"}
                className="http-request-tab-select"
                onClick={() => setActiveMainView("environment")}
                role="tab"
                tone="muted"
              >
                <Icon name="palette" />
                <strong>环境</strong>
                <small aria-hidden="true" className="saved" />
              </Button>
              <IconButton
                aria-label="关闭环境"
                className="http-request-tab-close"
                icon="x"
                onClick={closeEnvironmentTab}
                title="关闭环境"
                tone="muted"
              />
            </div>
          ) : null}
          {shareTabOpen ? (
            <div
              className={["http-request-tab", "http-share-main-tab", activeMainView === "share" ? "active" : ""]
                .filter(Boolean)
                .join(" ")}
              onAuxClick={(event) => {
                if (event.button === 1) {
                  event.preventDefault();
                  closeShareTab();
                }
              }}
            >
              <Button
                aria-selected={activeMainView === "share"}
                className="http-request-tab-select"
                onClick={() => setActiveMainView("share")}
                role="tab"
                tone="muted"
              >
                <Icon name="upload" />
                <strong>分享</strong>
                <small aria-hidden="true" className="saved" />
              </Button>
              <IconButton
                aria-label="关闭分享"
                className="http-request-tab-close"
                icon="x"
                onClick={closeShareTab}
                title="关闭分享"
                tone="muted"
              />
            </div>
          ) : null}
          {openRequestTabs.map((request) => {
            const active = activeMainView === "request" && request.id === activeRequest?.id;

            return (
              <div
                className={["http-request-tab", active ? "active" : ""].filter(Boolean).join(" ")}
                key={request.id}
                onAuxClick={(event) => {
                  if (event.button === 1) {
                    event.preventDefault();
                    closeRequestTab(request.id);
                  }
                }}
              >
                <Button
                  aria-selected={active}
                  className="http-request-tab-select"
                  onClick={() => selectRequest(activeProject?.id ?? null, request.id)}
                  role="tab"
                  tone="muted"
                >
                  <span className={methodClass(request.method)}>{request.method}</span>
                  <strong>{request.name}</strong>
                  <small
                    aria-label={dirtyRequestIds.has(request.id) ? "未保存" : undefined}
                    aria-hidden={dirtyRequestIds.has(request.id) ? undefined : "true"}
                    className={dirtyRequestIds.has(request.id) ? "" : "saved"}
                    title={dirtyRequestIds.has(request.id) ? "未保存" : undefined}
                  />
                </Button>
                <IconButton
                  aria-label="关闭请求"
                  className="http-request-tab-close"
                  icon="x"
                  onClick={() => closeRequestTab(request.id)}
                  title="关闭请求"
                  tone="muted"
                />
              </div>
            );
          })}
        </div>

        {activeMainView === "environment" && environmentTabOpen ? (
          renderEnvironmentWorkspace()
        ) : activeMainView === "share" && shareTabOpen ? (
          renderShareWorkspace()
        ) : activeMainView === "request" && activeRequest ? (
        <div className="http-workbench" ref={workbenchRef} style={workbenchStyle}>
          <section
            className={["http-request-editor", requestConfigCollapsed ? "collapsed" : ""].filter(Boolean).join(" ")}
            aria-label="请求编辑器"
          >
            {activeRequest ? (
              <>
                <div className="http-request-bar">
                  <Select
                    aria-label="HTTP 方法"
                    className="http-method-select"
                    menuClassName="http-method-select-menu"
                    value={activeRequest.method}
                    options={httpMethodOptions}
                    onChange={(method) => updateActiveRequest({ method })}
                  />
                  <TextInput
                    aria-label="请求地址"
                    value={activeRequest.url}
                    onChange={(event) => updateActiveRequest({ url: event.target.value })}
                    placeholder="https://api.example.local/resource"
                  />
                  <Button className="http-save-button" icon="save" onClick={() => void saveWorkspacesNow()}>
                    保存
                  </Button>
                  <Button
                    className={["http-send-button", isSending ? "sending" : ""].filter(Boolean).join(" ")}
                    icon={isSending ? "x" : "play"}
                    onClick={() => void sendPreviewRequest()}
                    tone="primary"
                  >
                    <span>{isSending ? "取消" : "发送"}</span>
                  </Button>
                </div>

                <div className="http-section-switcher" role="tablist" aria-label="请求配置">
	                  {[
	                    { id: "params" as const, label: "参数", count: enabledParams.length },
	                    { id: "auth" as const, label: "认证", count: activeRequest.auth.type === "none" ? 0 : 1 },
	                    { id: "headers" as const, label: "请求头", count: enabledHeaders.length },
	                    {
	                      id: "body" as const,
                      label: "请求体",
                      count:
                        activeRequest.bodyMode === "form"
                          ? enabledRows(activeRequest.formBody).length
                          : activeRequest.bodyMode !== "none" && activeRequest.body.trim()
	                            ? 1
	                            : 0,
	                    },
		                    { id: "preview" as const, label: "预览", count: buildHttpPayload(activeRequest, activeVariables).headers.length },
	                  ].map((section) => (
                    <Button
                      active={activeSection === section.id}
                      key={section.id}
                      onClick={() => {
                        setActiveSection(section.id);
                        setRequestConfigCollapsed(false);
                        setResponsePanelRatio((current) => (current > 0.7 ? 0.38 : current));
                      }}
                      tone="muted"
                    >
                      <span>{section.label}</span>
                      <small>{section.count}</small>
                    </Button>
                  ))}
                </div>

                <div className="http-editor-panel">
                  {activeSection === "params" ? renderKeyValueRows("params") : null}
                  {activeSection === "headers" ? renderKeyValueRows("headers") : null}
                  {activeSection === "body" ? renderBodyEditor() : null}
                  {activeSection === "auth" ? renderAuthEditor() : null}
                  {activeSection === "preview" ? renderRequestPreview() : null}
                </div>
              </>
            ) : (
              <div className="http-request-empty">
                <Icon name="file-text" />
                <strong>当前目标还没有请求</strong>
                <span>使用左侧加号或右键菜单创建请求。</span>
              </div>
            )}
          </section>

          <div
            aria-label="调整响应区高度"
            className="http-workbench-resizer"
            onPointerDown={startResponseResize}
            role="separator"
            title="调整响应区高度"
          />

          <section className="http-response-workspace" aria-label="响应查看器">
            <div className="http-response-summary">
              <div className="http-response-tabs">
                <Button active={responseView !== "history"} tone="muted" onClick={() => setResponseView("body")}>响应</Button>
                <Button active={responseView === "history"} tone="muted" onClick={() => setResponseView("history")}>历史</Button>
                <Tag className={["http-status-pill", isSending ? "sending" : ""].filter(Boolean).join(" ")} tone="accent">
                  {isSending ? "请求中" : response ? `${response.status} ${response.statusText}` : "未发送"}
                </Tag>
                <Tag className="http-duration-pill" tone="danger">{response?.durationMs ? `${response.durationMs} ms` : isSending ? "..." : "--"}</Tag>
                <Tag>{response ? formatBytes(response.sizeBytes) : "--"}</Tag>
              </div>
	              <div className="http-response-tools">
	                <Button active={responseView === "body"} tone="muted" onClick={() => setResponseView("body")}>响应体</Button>
	                <Button active={responseView === "headers"} tone="muted" onClick={() => setResponseView("headers")}>响应头</Button>
	              </div>
            </div>

            {responseError && responseView !== "history" ? <div className="http-response-error">{responseError}</div> : null}

            {responseView === "history" ? (
              renderResponseHistory()
            ) : response ? (
              <div className="http-response-grid single">
                {responseView === "headers" ? renderResponseHeaders() : renderResponseBody()}
              </div>
            ) : !responseError ? (
              <div className="http-response-empty">
                <Icon name="network" />
                <strong>HTTP Console 已就绪</strong>
                <span>发送请求后显示响应内容。</span>
              </div>
            ) : null}
          </section>
        </div>
        ) : (
          <div className="http-console-blank" aria-label="空白区域" />
        )}
      </div>

      {renderContextMenu()}
      <ConfirmDialog
        confirmLabel="删除"
        description={deleteConfirmContent?.description}
        open={Boolean(deleteConfirm)}
        title={deleteConfirmContent?.title ?? "确认删除"}
        tone="danger"
        onCancel={() => setDeleteConfirm(null)}
        onConfirm={confirmDeleteTarget}
      />
    </section>
  );
}
