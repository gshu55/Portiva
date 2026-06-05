import { useEffect, useMemo, useRef, useState } from "react";
import type { DragEvent, MouseEvent } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
import { httpSend, httpWorkspacesGet, httpWorkspacesSave } from "../../shared/ipc/commands";
import type { HttpSendRequest, HttpSendResponse } from "../../shared/ipc/commands";
import { Icon } from "../../shared/Icon";
import { Button, IconButton, Select, Tag, TextArea, TextInput } from "../../shared/ui";

type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "HEAD" | "OPTIONS";
type RequestSection = "params" | "headers" | "body" | "auth" | "preview";
type TreeNodeType = "workspace" | "project" | "request";
type KeyValueEntry = { description?: string; enabled: boolean; key: string; value: string };
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
  url: string;
}

interface HttpProjectDraft {
  id: string;
  name: string;
  requests: HttpRequestDraft[];
}

interface HttpWorkspaceDraft {
  id: string;
  name: string;
  projects: HttpProjectDraft[];
  requests: HttpRequestDraft[];
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

type HttpTreeDragType = "project" | "request";
type HttpTreeDropType = "workspace" | "project" | "request";
type HttpTreeDropPosition = "before" | "after" | "inside";

interface HttpTreeDragPayload {
  nodeId: string;
  projectId: string | null;
  type: HttpTreeDragType;
  workspaceId: string;
}

interface HttpTreeDropTarget {
  position: HttpTreeDropPosition;
  projectId: string | null;
  requestId?: string;
  type: HttpTreeDropType;
  workspaceId: string;
}

type HttpTreeDropTargetBase = Omit<HttpTreeDropTarget, "position">;

interface HttpTreePointerDragState {
  active: boolean;
  drag: HttpTreeDragPayload;
  pointerId: number;
  startX: number;
  startY: number;
}

const httpTreeDragMimeType = "application/x-portiva-http-tree-node";

const defaultWorkspaces: HttpWorkspaceDraft[] = [
  {
    id: "ws-default",
    name: "默认工作区",
    requests: [
      {
        auth: createDefaultAuth(),
        body: "",
        bodyMode: "none",
        formBody: [],
        headers: [{ enabled: true, key: "Accept", value: "application/json" }],
        id: "req-workspace-status",
        method: "GET",
        name: "工作区状态",
        params: [],
        url: "https://api.example.local/status",
      },
    ],
    projects: [
      {
        id: "project-default",
        name: "默认项目",
        requests: [
          {
            auth: createDefaultAuth(),
            body: "",
            bodyMode: "none",
            formBody: [],
            headers: [{ enabled: true, key: "Accept", value: "application/json" }],
            id: "req-health",
            method: "GET",
            name: "服务健康检查",
            params: [{ enabled: true, key: "verbose", value: "true" }],
            url: "https://api.example.local/health",
          },
          {
            auth: {
              ...createDefaultAuth(),
              bearerToken: "{{token}}",
              type: "bearer",
            },
            body: '{\n  "username": "demo",\n  "password": "{{password}}"\n}',
            bodyMode: "json",
            formBody: [],
            headers: [
              { enabled: true, key: "Content-Type", value: "application/json" },
            ],
            id: "req-login",
            method: "POST",
            name: "登录接口",
            params: [],
            url: "https://api.example.local/auth/login",
          },
        ],
      },
    ],
  },
];
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
    value: "",
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
    url: "",
  };
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

function authHeaderRows(auth: HttpAuthDraft): KeyValueEntry[] {
  if (auth.type === "bearer" && auth.bearerToken.trim()) {
    return [{ enabled: true, key: "Authorization", value: `Bearer ${auth.bearerToken.trim()}` }];
  }

  if (auth.type === "basic" && (auth.username || auth.password)) {
    const encodedCredentials = encodeBasicCredentials(auth.username, auth.password);
    return encodedCredentials ? [{ enabled: true, key: "Authorization", value: `Basic ${encodedCredentials}` }] : [];
  }

  if (auth.type === "api-key" && auth.apiKeyLocation === "header" && auth.apiKeyName.trim()) {
    return [{ enabled: true, key: auth.apiKeyName.trim(), value: auth.apiKeyValue }];
  }

  return [];
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

  return "application/x-www-form-urlencoded";
}

function requestHeaderRows(request: HttpRequestDraft) {
  const headers = [...enabledRows(request.headers), ...authHeaderRows(request.auth)];
  const contentType = bodyContentType(request);

  if (contentType && !hasHeader(headers, "Content-Type")) {
    headers.push({ enabled: true, key: "Content-Type", value: contentType });
  }

  return headers
    .map((entry) => ({ key: entry.key.trim(), value: entry.value }));
}

function requestBodyFor(request: HttpRequestDraft) {
  if (request.method === "GET" || request.method === "HEAD" || request.bodyMode === "none") {
    return undefined;
  }

  if (request.bodyMode === "form") {
    const body = new URLSearchParams();
    enabledRows(request.formBody).forEach((entry) => body.append(entry.key.trim(), entry.value));
    const bodyText = body.toString();
    return bodyText || undefined;
  }

  return request.body.length > 0 ? request.body : undefined;
}

function requestUrlFor(request: HttpRequestDraft) {
  const params = [...request.params];

  if (request.auth.type === "api-key" && request.auth.apiKeyLocation === "query" && request.auth.apiKeyName.trim()) {
    params.push({
      enabled: true,
      key: request.auth.apiKeyName.trim(),
      value: request.auth.apiKeyValue,
    });
  }

  return appendEnabledQueryParams(request.url.trim(), params);
}

function buildHttpPayload(request: HttpRequestDraft): HttpSendRequest {
  return {
    body: requestBodyFor(request),
    headers: requestHeaderRows(request),
    method: request.method,
    timeoutMs: 30_000,
    url: requestUrlFor(request),
  };
}

function buildRequestPreview(request: HttpRequestDraft) {
  const payload = buildHttpPayload(request);
  const headers = payload.headers.length
    ? payload.headers.map((header) => `${header.key}: ${header.value}`).join("\n")
    : "无";
  const body = payload.body || "无";

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
    return false;
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

async function decodeBrowserResponseBody(response: Response) {
  const contentType = response.headers.get("content-type") ?? "";
  const buffer = await response.arrayBuffer();
  const sizeBytes = buffer.byteLength;

  if (sizeBytes === 0) {
    return { body: "", bodyKind: "empty" as const, sizeBytes };
  }

  if (isTextualResponse(contentType) || !contentType) {
    const text = new TextDecoder().decode(buffer);

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

async function sendWithBrowserFetch(request: HttpSendRequest): Promise<HttpResponsePreview> {
  const headers = new Headers();
  request.headers.forEach((header) => headers.append(header.key, header.value));

  const startedAt = performance.now();
  const response = await fetch(request.url, {
    body: request.body,
    headers,
    method: request.method,
    redirect: "follow",
  });
  const decodedBody = await decodeBrowserResponseBody(response);

  return {
    ...decodedBody,
    durationMs: Math.max(1, Math.round(performance.now() - startedAt)),
    headers: Object.fromEntries(response.headers.entries()),
    status: response.status,
    statusText: response.statusText,
    url: response.url,
  };
}

async function sendHttpDraftRequest(request: HttpRequestDraft): Promise<HttpResponsePreview> {
  const payload = buildHttpPayload(request);

  if (isTauriRuntime()) {
    return httpSend(payload);
  }

  return sendWithBrowserFetch(payload);
}

export function HttpConsolePanel() {
  const [workspaces, setWorkspaces] = useState<HttpWorkspaceDraft[]>(defaultWorkspaces);
  const [activeWorkspaceId, setActiveWorkspaceId] = useState(defaultWorkspaces[0].id);
  const [activeProjectId, setActiveProjectId] = useState<string | null>(null);
  const [activeRequestId, setActiveRequestId] = useState(defaultWorkspaces[0].requests[0].id);
  const [activeSection, setActiveSection] = useState<RequestSection>("params");
  const [response, setResponse] = useState<HttpResponsePreview | null>(null);
  const [responseError, setResponseError] = useState("");
  const [isSending, setIsSending] = useState(false);
  const [contextMenu, setContextMenu] = useState<HttpContextMenuState | null>(null);
  const [editingNode, setEditingNode] = useState<EditingNodeState | null>(null);
  const [draggedTreeNode, setDraggedTreeNode] = useState<HttpTreeDragPayload | null>(null);
  const [treeDropTarget, setTreeDropTarget] = useState<HttpTreeDropTarget | null>(null);
  const [responsePanelRatio, setResponsePanelRatio] = useState(0.38);
  const [storageReady, setStorageReady] = useState(false);
  const [dirtyRequestIds, setDirtyRequestIds] = useState<Set<string>>(() => new Set());
  const workbenchRef = useRef<HTMLDivElement | null>(null);
  const draggedTreeNodeRef = useRef<HttpTreeDragPayload | null>(null);
  const treeDropTargetRef = useRef<HttpTreeDropTarget | null>(null);
  const pointerTreeDragRef = useRef<HttpTreePointerDragState | null>(null);
  const suppressTreeClickRef = useRef(false);
  const saveWorkspacesTimerRef = useRef<number | null>(null);

  const activeWorkspace = workspaces.find((workspace) => workspace.id === activeWorkspaceId) ?? workspaces[0];
  const activeProject = activeProjectId
    ? activeWorkspace.projects.find((project) => project.id === activeProjectId) ?? null
    : null;
  const activeRequestList = activeProject?.requests ?? activeWorkspace.requests;
  const activeRequest = activeRequestList.find((request) => request.id === activeRequestId) ?? null;
  const enabledParams = useMemo(
    () => activeRequest?.params.filter((entry) => entry.enabled && entry.key.trim()) ?? [],
    [activeRequest?.params],
  );
  const enabledHeaders = useMemo(
    () => activeRequest?.headers.filter((entry) => entry.enabled && entry.key.trim()) ?? [],
    [activeRequest?.headers],
  );
  const editorPanelRatio = 1 - responsePanelRatio;
  const workbenchStyle = {
    gridTemplateRows: `minmax(220px, calc(${Math.round(editorPanelRatio * 100)}% - 4px)) 8px minmax(150px, calc(${Math.round(
      responsePanelRatio * 100,
    )}% - 4px))`,
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

        const nextWorkspace = storedWorkspaces[0];
        const nextProject = nextWorkspace.projects[0] ?? null;
        const nextRequest = nextWorkspace.requests[0] ?? nextProject?.requests[0] ?? null;
        setWorkspaces(storedWorkspaces);
        setActiveWorkspaceId(nextWorkspace.id);
        setActiveProjectId(nextWorkspace.requests[0] ? null : nextProject?.id ?? null);
        setActiveRequestId(nextRequest?.id ?? "");
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
      void httpWorkspacesSave<HttpWorkspaceDraft>(workspaces)
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
      await httpWorkspacesSave<HttpWorkspaceDraft>(workspaces);
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
    setCurrentTreeDropTarget(null);
  };

  const selectWorkspace = (workspace: HttpWorkspaceDraft) => {
    setActiveWorkspaceId(workspace.id);
    setActiveProjectId(null);
    setActiveRequestId(workspace.requests[0]?.id ?? "");
    resetResponse();
  };

  const selectProject = (project: HttpProjectDraft) => {
    setActiveProjectId(project.id);
    setActiveRequestId(project.requests[0]?.id ?? "");
    resetResponse();
  };

  const selectRequest = (projectId: string | null, requestId: string) => {
    setActiveProjectId(projectId);
    setActiveRequestId(requestId);
    resetResponse();
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

  const deleteWorkspace = (workspaceId: string) => {
    if (workspaces.length <= 1) {
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

  const deleteProject = (workspaceId: string, projectId: string) => {
    const workspace = workspaces.find((item) => item.id === workspaceId);

    if (!workspace) {
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

  const deleteRequest = (workspaceId: string, projectId: string | null, requestId: string) => {
    const workspace = workspaces.find((item) => item.id === workspaceId);
    const project = projectId ? workspace?.projects.find((item) => item.id === projectId) : null;
    const siblingRequests = project?.requests ?? workspace?.requests ?? [];

    if (!workspace || siblingRequests.length === 0) {
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
      resetResponse();
    }
  };

  const copyText = (text: string) => {
    setContextMenu(null);
    void navigator.clipboard?.writeText(text);
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

  const updateRequestRows = (field: "formBody" | "headers" | "params", rows: KeyValueEntry[]) => {
    updateActiveRequest({ [field]: rows } as Partial<HttpRequestDraft>);
  };

  const updateRequestRow = (
    field: "formBody" | "headers" | "params",
    index: number,
    patch: Partial<KeyValueEntry>,
  ) => {
    if (!activeRequest) {
      return;
    }

    updateRequestRows(
      field,
      activeRequest[field].map((row, rowIndex) => (rowIndex === index ? { ...row, ...patch } : row)),
    );
  };

  const addRequestRow = (field: "formBody" | "headers" | "params") => {
    if (!activeRequest) {
      return;
    }

    updateRequestRows(field, [...activeRequest[field], createBlankRow()]);
  };

  const removeRequestRow = (field: "formBody" | "headers" | "params", index: number) => {
    if (!activeRequest) {
      return;
    }

    updateRequestRows(
      field,
      activeRequest[field].filter((_, rowIndex) => rowIndex !== index),
    );
  };

  const moveRequestRow = (field: "formBody" | "headers" | "params", index: number, direction: -1 | 1) => {
    if (!activeRequest) {
      return;
    }

    const nextIndex = index + direction;
    const rows = [...activeRequest[field]];

    if (nextIndex < 0 || nextIndex >= rows.length) {
      return;
    }

    [rows[index], rows[nextIndex]] = [rows[nextIndex], rows[index]];
    updateRequestRows(field, rows);
  };

  const sendPreviewRequest = async () => {
    setResponseError("");

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

    setIsSending(true);
    try {
      setResponse(await sendHttpDraftRequest(activeRequest));
    } catch (error) {
      setResponse(null);
      setResponseError(formatErrorMessage(error));
    } finally {
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

      const nextRatio = (bounds.bottom - clientY) / bounds.height;
      setResponsePanelRatio(Math.min(0.7, Math.max(0.22, nextRatio)));
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

  const renderKeyValueRows = (field: "formBody" | "headers" | "params", emptyText: string) => {
    const rows = activeRequest?.[field] ?? [];
    return (
      <div className="http-parameter-table">
        <div className="http-parameter-header" aria-hidden="true">
          <span />
          <span>名称</span>
          <span>值</span>
          <span>描述</span>
          <span />
        </div>
        {rows.length === 0 ? (
          <div className="http-parameter-empty">暂无条目</div>
        ) : null}
        {rows.map((entry, index) => (
          <div className={["http-parameter-row", entry.enabled ? "enabled" : ""].filter(Boolean).join(" ")} key={`${field}-${index}`}>
            <button
              aria-label={entry.enabled ? "停用条目" : "启用条目"}
              className="http-param-check"
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
            <TextInput
              value={entry.value}
              onChange={(event) => updateRequestRow(field, index, { value: event.target.value })}
              placeholder="value"
              aria-label="值"
            />
            <TextInput
              value={entry.description ?? ""}
              onChange={(event) => updateRequestRow(field, index, { description: event.target.value })}
              placeholder="描述"
              aria-label="描述"
            />
            <div className="http-param-actions">
              <IconButton
                aria-label="上移条目"
                disabled={index === 0}
                icon="chevron-left"
                onClick={() => moveRequestRow(field, index, -1)}
              />
              <IconButton
                aria-label="下移条目"
                disabled={index === rows.length - 1}
                icon="chevron-right"
                onClick={() => moveRequestRow(field, index, 1)}
              />
              <IconButton aria-label="删除条目" icon="trash" onClick={() => removeRequestRow(field, index)} tone="danger" />
            </div>
          </div>
        ))}
        <Button className="http-add-parameter" fullWidth icon="plus" onClick={() => addRequestRow(field)}>
          {emptyText}
        </Button>
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
          <Select
            aria-label="请求体类型"
            value={activeRequest.bodyMode}
            options={bodyModeOptions}
            onChange={(bodyMode) => updateActiveRequest({ bodyMode })}
          />
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
        {activeRequest.bodyMode === "form" ? renderKeyValueRows("formBody", "添加表单字段") : null}
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
          <label className="http-field-row">
            <span>Token</span>
            <TextInput
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
          <Button icon="copy" onClick={() => copyText(buildRequestPreview(activeRequest))} tone="muted">
            复制
          </Button>
        </div>
        <pre>{buildRequestPreview(activeRequest)}</pre>
      </div>
    );
  };

  const renderContextMenu = () => {
    if (!contextMenu) {
      return null;
    }

    const menuWorkspace = workspaces.find((workspace) => workspace.id === contextMenu.workspaceId) ?? activeWorkspace;
    const menuProject = contextMenu.projectId
      ? menuWorkspace.projects.find((project) => project.id === contextMenu.projectId) ?? menuWorkspace.projects[0]
      : menuWorkspace.projects[0];
    const menuRequestList = contextMenu.projectId ? menuProject.requests : menuWorkspace.requests;
    const menuRequest = menuRequestList.find((request) => request.id === contextMenu.requestId) ?? activeRequest;

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
              onClick={() => deleteWorkspace(menuWorkspace.id)}
              role="menuitem"
              title={workspaces.length <= 1 ? "至少保留一个工作区" : "删除工作区"}
              tone="danger"
            >
              <span>删除工作区</span>
            </Button>
          </>
        ) : null}
        {contextMenu.type === "project" ? (
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
              onClick={() => deleteProject(menuWorkspace.id, menuProject.id)}
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
              onClick={() => deleteRequest(menuWorkspace.id, contextMenu.projectId ?? null, menuRequest.id)}
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

  return (
    <section className="http-console" aria-label="HTTP/API 调试">
      <aside className="http-console-sidebar" aria-label="HTTP 工作区">
        <div className="http-sidebar-card http-sidebar-control-card">
          <div className="http-sidebar-brand">
            <strong>HTTP Console</strong>
            <span>无环境</span>
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
            <IconButton aria-label="变量环境" icon="palette" title="变量环境" />
            <IconButton aria-label="HTTP 设置" icon="settings" title="HTTP 设置" />
          </div>
        </div>

        <div className="http-sidebar-card http-tree-card">
          <div className="http-tree-title">
            <strong>工作区</strong>
            <span>{activeWorkspace.projects.length} 项目 · {workspaceRequestCount} 请求</span>
          </div>
          <div className="http-tree-search">
            <Icon name="search" />
            <TextInput readOnly placeholder="搜索项目、分组、请求" />
          </div>
          <div
            className="http-tree"
            onContextMenu={(event) => {
              event.preventDefault();
              setContextMenu({ type: "tree", workspaceId: activeWorkspace.id, x: event.clientX, y: event.clientY });
            }}
          >
            <div
              className={[
                "http-tree-root",
                treeDropClassName({ type: "workspace", workspaceId: activeWorkspace.id, projectId: null }),
              ]
                .filter(Boolean)
                .join(" ")}
              data-http-drop-type="workspace"
              data-workspace-id={activeWorkspace.id}
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
              role="button"
              tabIndex={0}
              title={activeWorkspace.name}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  selectWorkspace(activeWorkspace);
                }

                if (event.key === "F2") {
                  event.preventDefault();
                  beginRename("workspace", activeWorkspace.id, activeWorkspace.name);
                }
              }}
              onDragOver={(event) =>
                updateTreeDropTarget(event, { type: "workspace", workspaceId: activeWorkspace.id, projectId: null })
              }
              onDrop={(event) => dropTreeNode(event, { type: "workspace", workspaceId: activeWorkspace.id, projectId: null })}
            >
              <Icon name="server" />
              {renderEditableName("workspace", activeWorkspace.id, activeWorkspace.name)}
              <IconButton
                aria-label="在工作区中新建请求"
                className="http-tree-root-action"
                icon="plus"
                title="新建请求"
                onClick={(event) => {
                  event.stopPropagation();
                  createRequest(activeWorkspace.id, null);
                }}
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
            </div>
            <div className="http-tree-group">
              {activeWorkspace.requests.map((request) => (
                <div
                  className={[
                    "http-tree-row",
                    "http-request-row",
                    "http-workspace-request-row",
                    "drag-enabled",
                    !activeProject && request.id === activeRequest?.id ? "active" : "",
                    treeDragClassName({
                      type: "request",
                      workspaceId: activeWorkspace.id,
                      projectId: null,
                      nodeId: request.id,
                    }),
                    treeDropClassName({
                      type: "request",
                      workspaceId: activeWorkspace.id,
                      projectId: null,
                      requestId: request.id,
                    }),
                  ]
                    .filter(Boolean)
                    .join(" ")}
                  data-http-drop-type="request"
                  data-project-id=""
                  data-request-id={request.id}
                  data-workspace-id={activeWorkspace.id}
                  draggable={false}
                  key={request.id}
                  onDragEnd={clearTreeDrag}
                  onDragOver={(event) =>
                    updateTreeDropTarget(event, {
                      type: "request",
                      workspaceId: activeWorkspace.id,
                      projectId: null,
                      requestId: request.id,
                    })
                  }
                  onDragStart={(event) =>
                    startTreeDrag(event, {
                      type: "request",
                      workspaceId: activeWorkspace.id,
                      projectId: null,
                      nodeId: request.id,
                    })
                  }
                  onDrop={(event) =>
                    dropTreeNode(event, {
                      type: "request",
                      workspaceId: activeWorkspace.id,
                      projectId: null,
                      requestId: request.id,
                    })
                  }
                  onPointerDown={(event) =>
                    startTreePointerDrag(event, {
                      type: "request",
                      workspaceId: activeWorkspace.id,
                      projectId: null,
                      nodeId: request.id,
                    })
                  }
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
                  role="button"
                  tabIndex={0}
                >
                  <span className={methodClass(request.method)}>{request.method}</span>
                  {renderEditableName("request", request.id, request.name)}
                </div>
              ))}

              {activeWorkspace.projects.map((project) => (
                <div className="http-tree-group" key={project.id}>
                  <div
                    className={[
                      "http-tree-row",
                      "http-project-row",
                      "drag-enabled",
                      project.id === activeProject?.id ? "active" : "",
                      treeDragClassName({
                        type: "project",
                        workspaceId: activeWorkspace.id,
                        projectId: null,
                        nodeId: project.id,
                      }),
                      treeDropClassName({
                        type: "project",
                        workspaceId: activeWorkspace.id,
                        projectId: project.id,
                      }),
                    ]
                      .filter(Boolean)
                      .join(" ")}
                    data-http-drop-type="project"
                    data-project-id={project.id}
                    data-workspace-id={activeWorkspace.id}
                    draggable={false}
                    onDragEnd={clearTreeDrag}
                    onDragOver={(event) =>
                      updateTreeDropTarget(event, {
                        type: "project",
                        workspaceId: activeWorkspace.id,
                        projectId: project.id,
                      })
                    }
                    onDragStart={(event) =>
                      startTreeDrag(event, {
                        type: "project",
                        workspaceId: activeWorkspace.id,
                        projectId: null,
                        nodeId: project.id,
                      })
                    }
                    onPointerDown={(event) =>
                      startTreePointerDrag(event, {
                        type: "project",
                        workspaceId: activeWorkspace.id,
                        projectId: null,
                        nodeId: project.id,
                      })
                    }
                    onDrop={(event) =>
                      dropTreeNode(event, {
                        type: "project",
                        workspaceId: activeWorkspace.id,
                        projectId: project.id,
                      })
                    }
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
                    role="button"
                    tabIndex={0}
                  >
                    <Icon name="folder-open" />
                    {renderEditableName("project", project.id, project.name)}
                    <IconButton
                      aria-label={`在 ${project.name} 中新建请求`}
                      className="http-tree-action"
                      icon="plus"
                      onClick={(event) => {
                        event.stopPropagation();
                        createRequest(activeWorkspace.id, project.id);
                      }}
                      onPointerDown={(event) => event.stopPropagation()}
                      title="新建请求"
                    />
                  </div>
                  {project.requests.map((request) => (
                    <div
                      className={[
                        "http-tree-row",
                        "http-request-row",
                        "drag-enabled",
                        activeProject?.id === project.id && request.id === activeRequest?.id ? "active" : "",
                        treeDragClassName({
                          type: "request",
                          workspaceId: activeWorkspace.id,
                          projectId: project.id,
                          nodeId: request.id,
                        }),
                        treeDropClassName({
                          type: "request",
                          workspaceId: activeWorkspace.id,
                          projectId: project.id,
                          requestId: request.id,
                        }),
                      ]
                        .filter(Boolean)
                        .join(" ")}
                      data-http-drop-type="request"
                      data-project-id={project.id}
                      data-request-id={request.id}
                      data-workspace-id={activeWorkspace.id}
                      draggable={false}
                      key={request.id}
                      onDragEnd={clearTreeDrag}
                      onDragOver={(event) =>
                        updateTreeDropTarget(event, {
                          type: "request",
                          workspaceId: activeWorkspace.id,
                          projectId: project.id,
                          requestId: request.id,
                        })
                      }
                      onDragStart={(event) =>
                        startTreeDrag(event, {
                          type: "request",
                          workspaceId: activeWorkspace.id,
                          projectId: project.id,
                          nodeId: request.id,
                        })
                      }
                      onPointerDown={(event) =>
                        startTreePointerDrag(event, {
                          type: "request",
                          workspaceId: activeWorkspace.id,
                          projectId: project.id,
                          nodeId: request.id,
                        })
                      }
                      onDrop={(event) =>
                        dropTreeNode(event, {
                          type: "request",
                          workspaceId: activeWorkspace.id,
                          projectId: project.id,
                          requestId: request.id,
                        })
                      }
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
                      role="button"
                      tabIndex={0}
                    >
                      <span className={methodClass(request.method)}>{request.method}</span>
                      {renderEditableName("request", request.id, request.name)}
                    </div>
                  ))}
                </div>
              ))}
            </div>
          </div>
        </div>
      </aside>

      <div className="http-console-main">
        <div className="http-request-tabs" aria-label="HTTP 请求编辑标签">
          {activeRequestList.map((request) => (
            <Button
              active={request.id === activeRequest?.id}
              key={request.id}
              onClick={() => selectRequest(activeProject?.id ?? null, request.id)}
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
              <span
                aria-label="关闭请求"
                className="http-request-tab-close"
                onClick={(event) => {
                  event.stopPropagation();
                  deleteRequest(activeWorkspace.id, activeProject?.id ?? null, request.id);
                }}
                onKeyDown={(event) => {
                  if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    event.stopPropagation();
                    deleteRequest(activeWorkspace.id, activeProject?.id ?? null, request.id);
                  }
                }}
                role="button"
                tabIndex={0}
                title="关闭请求"
              >
                <Icon name="x" />
              </span>
            </Button>
          ))}
        </div>

        <div className="http-workbench" ref={workbenchRef} style={workbenchStyle}>
          <section className="http-request-editor" aria-label="请求编辑器">
            {activeRequest ? (
              <>
                <div className="http-request-bar">
                  <Select
                    aria-label="HTTP 方法"
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
                  <Button className="http-send-button" icon={isSending ? "refresh-ccw" : "play"} onClick={() => void sendPreviewRequest()} disabled={isSending} tone="primary">
                    <span>{isSending ? "发送中" : "发送"}</span>
                  </Button>
                </div>

                <div className="http-request-name-row">
                  <label>
                    <span>请求名称</span>
                    <TextInput value={activeRequest.name} onChange={(event) => updateActiveRequest({ name: event.target.value })} />
                  </label>
                </div>

                <div className="http-section-switcher" role="tablist" aria-label="请求配置">
                  {[
                    { id: "params" as const, label: "参数", count: enabledParams.length },
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
                    { id: "auth" as const, label: "认证", count: activeRequest.auth.type === "none" ? 0 : 1 },
                    { id: "preview" as const, label: "预览", count: buildHttpPayload(activeRequest).headers.length },
                  ].map((section) => (
                    <Button
                      active={activeSection === section.id}
                      key={section.id}
                      onClick={() => setActiveSection(section.id)}
                      tone="muted"
                    >
                      <span>{section.label}</span>
                      <small>{section.count}</small>
                    </Button>
                  ))}
                </div>

                <div className="http-editor-panel">
                  {activeSection === "params" ? renderKeyValueRows("params", "添加参数") : null}
                  {activeSection === "headers" ? renderKeyValueRows("headers", "添加请求头") : null}
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
                <Button active tone="muted">响应</Button>
                <Button tone="muted">历史</Button>
                <Tag className="http-status-pill" tone="accent">{response ? `${response.status} ${response.statusText}` : "未发送"}</Tag>
                <Tag className="http-duration-pill" tone="danger">{response ? `${response.durationMs} ms` : "--"}</Tag>
                <Tag>{response ? formatBytes(response.sizeBytes) : "--"}</Tag>
              </div>
              <div className="http-response-tools">
                <Button active tone="muted">响应体</Button>
                <Button tone="muted">响应头</Button>
                <Button tone="muted">Cookie</Button>
                <IconButton aria-label="搜索响应" icon="search" />
                <IconButton aria-label="复制响应" icon="copy" onClick={() => copyText(response?.body ?? "")} disabled={!response?.body} />
              </div>
            </div>

            {responseError ? <div className="http-response-error">{responseError}</div> : null}

            {response ? (
              <div className="http-response-grid">
                <div className="http-response-headers">
                  <strong>Headers</strong>
                  {Object.entries(response.headers).map(([key, value]) => (
                    <div key={key}>
                      <span>{key}</span>
                      <code>{value}</code>
                    </div>
                  ))}
                </div>
                <pre>{response.body || "响应体为空。"}</pre>
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
      </div>

      {renderContextMenu()}
    </section>
  );
}
