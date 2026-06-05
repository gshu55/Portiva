# EasyPost HTTP 调试能力迁移设计

> 文档版本：v0.1  
> 更新时间：2026-06-05  
> 目标：把 EasyPost 的 HTTP/API 调试能力迁移到 Portiva，同时复用 Portiva 现有工作台、通信桥、安全和日志体系。

---

## 1. 结论

EasyPost 可以迁移进 Portiva，但迁移方式应是“能力模块移植”，不是“整仓合并”。

推荐定位：

```text
Portiva HTTP/API 调试模块
```

它与 SSH、SFTP、Serial、本地终端并列，作为工作台中的一种请求调试标签页存在。HTTP 调试不应该伪装成终端会话，也不应该复用 Raw TCP 实现 HTTP。

---

## 2. 迁移原则

```text
1. 复用 Portiva 的工作台、标签页、IPC、日志、设置和安全边界。
2. 复用 EasyPost 的请求模型、请求准备、变量解析、响应读取和导入导出思路。
3. HTTP 请求是短请求/响应模型，不套用 TerminalSession。
4. HTTP 不通过 Raw TCP 手写协议。
5. 第一阶段只做可发送、可查看、可取消的单请求调试器。
6. 历史记录、集合、变量、SQLite 持久化放到后续阶段。
7. token、Authorization、Cookie 等敏感字段必须进入脱敏日志规则。
8. 响应体必须设置大小上限，避免大响应拖垮前端。
9. UI 布局沿用 EasyPost 的工作区结构，但主题、配色、控件和间距适配 Portiva。
10. 所有新增能力必须能在浏览器 mock 模式下退化展示。
```

---

## 3. 与当前通信协议的关系

Portiva 现有协议抽象主要服务长连接：

```text
ConnectionType
ProtocolBackend
ConnectionSession
TerminalSession
FileTransferSession
ConnectionCapabilities
```

这些模型适合 SSH、SFTP、Serial、Telnet、Raw TCP、本地终端等持续会话。HTTP 调试的核心动作是一次性请求：

```text
RequestDraft -> PreparedRequest -> HttpClient.send -> ApiResponse
```

因此不能直接复用现有协议实现，但可以复用外层通信框架：

| Portiva 能力 | 是否复用 | 说明 |
| --- | --- | --- |
| Tauri IPC 命令桥 | 是 | 新增 `http_request_*` 命令，保持 `src/shared/ipc/commands.ts` 风格 |
| 工作台标签 | 是 | 新增 `http-console` 工具 tab，与终端、文件管理、设置页并列 |
| capabilities 思路 | 是 | 新增 HTTP 专用能力，避免误显示终端/SFTP入口 |
| 日志与脱敏 | 是 | 请求 URL、method、状态码可记录，敏感 header/body 需脱敏 |
| 设置页 | 是 | 超时、重定向、最大响应大小、默认 Header 可进入设置 |
| ProtocolBackend | 部分复用 | 可注册 HTTP 描述信息，但不用于 `TerminalSession` |
| TerminalSession | 否 | HTTP 响应不是终端字节流 |
| FileTransferSession | 否 | HTTP 上传下载后续单独建模，不混入 SFTP 队列 |
| Raw TCP | 否 | HTTP 应使用成熟 HTTP client，不手写协议 |

---

## 4. 推荐目标模型

### 4.0 Workspace 边界

EasyPost 不是只有请求草稿，它有明确的数据工作区层级：

```text
Workspace
  └─ Project
     └─ Folder
        └─ Request
```

同时 EasyPost 的请求编辑标签也绑定 `workspaceId`，这意味着 Portiva 不能把每个请求随意拆成多个互不相关的顶层标签，否则会遇到：

```text
同一 workspace 在多个标签中同时编辑
请求树排序、重命名、删除状态不同步
变量和临时变量解析上下文不同步
请求历史和响应快照被多个实例覆盖
导入导出时不知道哪个实例是权威状态
关闭其中一个标签时难以判断是否释放 workspace 状态
```

因此推荐约束：

```text
1. HTTP Console 是单实例工具。
2. 同一时间只允许打开一个 HTTP Console 顶层标签。
3. 再次点击“打开 HTTP/API 调试”时，聚焦已有 HTTP Console，而不是新建标签。
4. MVP 只支持一个 activeWorkspaceId。
5. MVP 不支持把请求单独打开成顶层标签。
6. MVP 不支持多个 HTTP Console。
7. 后续如果需要 workspace 切换器，也仍然在同一个 HTTP Console 内切换。
8. 后续如果需要单独查看请求响应，优先做只读弹窗或抽屉，不创建可编辑顶层标签。
```

这比“限制工作区打开”更明确：MVP 直接限制 HTTP Console 单实例，避免 workspace、请求树、变量和历史状态同步问题。

### 4.1 前端类型

新增 HTTP 请求相关类型，建议放在：

```text
src/features/http/httpTypes.ts
```

核心类型：

```ts
export type HttpMethod =
  | "GET"
  | "POST"
  | "PUT"
  | "PATCH"
  | "DELETE"
  | "HEAD"
  | "OPTIONS";

export type HttpBodyType =
  | "none"
  | "json"
  | "xml"
  | "text"
  | "formUrlEncoded"
  | "multipartFormData";

export interface HttpKeyValueEntry {
  description?: string;
  enabled: boolean;
  key: string;
  value: string;
}

export interface HttpRequestDraft {
  body: {
    content: string;
    formRows?: HttpKeyValueEntry[];
    type: HttpBodyType;
  };
  followRedirects: boolean;
  headers: HttpKeyValueEntry[];
  method: HttpMethod;
  queryParams: HttpKeyValueEntry[];
  timeoutMs: number;
  url: string;
}

export interface HttpResponseSnapshot {
  bodyBase64?: string;
  bodyKind: "text" | "image";
  bodyMimeType?: string;
  bodyText: string;
  durationMs: number;
  headers: Record<string, string>;
  sizeBytes: number;
  status: number;
  statusText: string;
}
```

### 4.2 工作台标签

扩展 `WorkspaceSessionTab.kind`：

```text
"terminal" | "file-transfer" | "settings" | "http-console"
```

HTTP 调试默认不是“一个请求一个标签”。更合理的单位是一个 HTTP Console 工具页：左侧管理 workspace 树、草稿、历史和集合，右侧编辑当前请求并查看响应。

HTTP Console 不需要 `connection` 真实后端会话，但为了兼容现有 tab 渲染，可以创建专用 tab model，避免继续把非连接类页面塞进 `ConnectionSummary`。

顶层 tab 管理规则：

```text
openHttpConsole()
  ├─ 如果已存在 kind = http-console 的 tab：切换到它
  └─ 如果不存在：创建一个 HTTP Console tab
```

推荐后续重构：

```ts
type WorkspaceTab =
  | TerminalWorkspaceTab
  | FileTransferWorkspaceTab
  | SettingsWorkspaceTab
  | HttpConsoleWorkspaceTab;
```

第一阶段若要降低改动，可以沿用 `customTabPanels`，把 HTTP Console 作为自定义 tab 接入，类似当前设置页。

---

## 5. IPC 与后端路线

### 5.1 第一阶段：Tauri HTTP 插件

优先使用 `@tauri-apps/plugin-http`，迁移 EasyPost 的 `TauriHttpClient` 思路：

```text
HttpRequestDraft
  -> prepareHttpRequestDraft
  -> TauriHttpClient.send
  -> HttpResponseSnapshot
```

需要新增依赖：

```text
@tauri-apps/plugin-http
tauri-plugin-http
```

需要更新：

```text
package.json
src-tauri/Cargo.toml
src-tauri/src/lib.rs
src-tauri/capabilities/default.json
```

优点：

```text
1. 实现最快。
2. 与 EasyPost 代码迁移成本低。
3. 不需要立刻扩展 Rust 命令层。
```

风险：

```text
1. HTTP 逻辑分散在前端。
2. 日志、脱敏、审计需要前端主动调用。
3. 后续若要统一后端安全策略，需要再包一层 Rust 命令。
```

### 5.2 第二阶段：Portiva Rust 命令封装

当基础功能稳定后，新增 Rust 命令：

```text
http_request_prepare
http_request_send
http_request_cancel
http_request_history_list
http_request_history_delete
```

前端统一通过 `src/shared/ipc/commands.ts` 调用：

```ts
export function httpRequestSend(draft: HttpRequestDraft) {
  return invoke<HttpResponseSnapshot>("http_request_send", { draft });
}
```

优点：

```text
1. 日志、脱敏、超时、响应大小限制可以统一在 Rust 层。
2. 后续支持代理、证书、mTLS、下载到文件更自然。
3. 与 Portiva 当前“协议能力在 Rust 后端”的原则一致。
```

---

## 6. 迁移 EasyPost 代码边界

优先迁移：

```text
src/domain/request/requestModel.ts
src/domain/request/prepareRequest.ts
src/domain/variables/resolveVariables.ts
src/domain/variables/variableScopes.ts
src/services/request/sendRequestUseCase.ts
src/infrastructure/http/HttpClient.ts
src/infrastructure/http/TauriHttpClient.ts
src/infrastructure/http/responseBody.ts
src/shared/bodyFormat.ts
```

暂不迁移：

```text
EasyPost 玻璃风格 UI 组件
EasyPost Tailwind 全局样式
EasyPost SQLite 仓储整套实现
```

布局层面保留 EasyPost 的原有信息架构，但不直接搬它的视觉实现。也就是说：

```text
保留：workspace tree / request editor / response workspace / variables panel / settings dialog 的布局关系
替换：玻璃风格面板、Tailwind 全局样式、按钮输入框样式、颜色和阴影
```

后续按需迁移：

```text
请求历史
请求集合
变量管理
导入导出
SQLite 持久化
```

---

## 7. UI 集成方案

第一阶段新增：

```text
src/features/http/HttpConsolePanel.tsx
src/features/http/HttpRequestEditor.tsx
src/features/http/httpRequestModel.ts
src/features/http/httpRequestClient.ts
src/features/http/httpBodyFormat.ts
```

基本布局：

```text
沿用 EasyPost 原有布局方式：
左侧 workspace sidebar：Workspace / Project / Folder / Request
主区上半部分：request tabs / request editor
主区下半部分：response workspace
中间分隔条：支持调整请求区和响应区高度
浮层面板：variables panel / settings dialog
```

视觉层级要求：

```text
1. 默认只打开一个 HTTP Console 顶层标签，不把每个简单请求都变成工作台标签。
2. HTTP Console 内部可以沿用 EasyPost 的 request tabs，但它们属于 HTTP Console 内部请求编辑标签，不是 Portiva 顶层工作台标签。
3. 多个请求通过左侧 workspace 树、内部 request tabs、历史、收藏和搜索管理。
4. 请求编辑区、响应区和拖拽分隔方式沿用 EasyPost。
5. Query、Headers、Body 的组织方式优先沿用 EasyPost 原组件交互。
6. Response workspace 的状态摘要、Headers、Body、History 组织方式优先沿用 EasyPost。
7. 高级配置、变量面板和设置弹窗沿用 EasyPost 的信息架构。
8. MVP 不提供“固定/单独打开为 Portiva 工作台标签”能力。
9. 视觉主题必须换成 Portiva 当前风格：深色工作台、紧凑面板、现有按钮/输入框/状态色。
```

推荐信息架构：

```text
HTTP Console Tab
├─ 左侧 workspace sidebar
│  ├─ Workspace selector
│  ├─ Project / Folder / Request tree
│  └─ workspace actions
└─ 主工作区
   ├─ request tabs / request editor
   │  ├─ method / URL / send / cancel
   │  ├─ query / headers / auth / body / options
   │  └─ request temp variables
   ├─ resizer
   └─ response workspace
      ├─ status / duration / size
      ├─ response headers / body
      └─ history entry detail
浮层
├─ variables panel
└─ settings dialog
```

视觉适配规则：

```text
1. 保留 EasyPost 的布局比例、面板关系和主要操作路径。
2. 移除 EasyPost 的 glass/liquid 视觉语言。
3. 使用 Portiva 的 app-shell 背景、panel 边框、输入框、按钮、状态提示和字体尺度。
4. 不引入 Tailwind 作为 HTTP Console 的样式基础，优先使用 Portiva 现有 CSS 组织方式。
5. 图标、按钮密度、表格行高和空状态文案应与 Portiva 终端/文件管理面板一致。
```

交互要求：

```text
1. 发送中按钮进入 busy 状态，并允许取消。
2. URL 为空或非法时不发送。
3. JSON/XML 格式化失败要显示明确错误。
4. 响应体过大时停止显示完整内容，提示保存到文件或复制部分内容。
5. `Authorization`、`Cookie`、`Set-Cookie` 默认脱敏。
6. 图片响应可以展示预览，未知二进制先显示元数据。
7. 浏览器 mock 模式下提供示例响应，不依赖 Tauri。
```

---

## 8. 能力矩阵建议

新增 HTTP 专用能力字段有两种方案。

方案 A：扩展现有 `ConnectionCapabilities`：

```ts
httpRequest: boolean;
requestHistory: boolean;
```

优点是改动小，缺点是 `ConnectionCapabilities` 会混入非连接语义。

方案 B：新增工作台能力模型：

```ts
interface WorkspaceToolCapabilities {
  httpRequest: boolean;
  requestHistory: boolean;
  variables: boolean;
}
```

推荐：第一阶段先不扩展 `ConnectionCapabilities`，通过 HTTP tab 独立控制 UI；第二阶段再决定是否把 HTTP 注册进协议诊断页。

---

## 9. 安全边界

必须默认脱敏：

```text
Authorization
Proxy-Authorization
Cookie
Set-Cookie
X-Api-Key
X-Auth-Token
token
password
secret
apiKey
```

必须有上限：

```text
默认请求超时：30000ms
默认最大响应展示：5MB
默认最大响应读取：可配置，初始建议 25MB
```

默认行为：

```text
1. 不把敏感 Header 写入普通日志。
2. 不自动保存响应体。
3. 不默认跟随危险重定向策略以外的自定义行为。
4. 不把请求历史作为第一阶段必选功能。
```

---

## 10. 分阶段落地

### Phase 0：文档和边界确认

```text
1. 固化迁移设计。
2. 明确不整仓合并。
3. 明确 HTTP 不复用 TerminalSession/Raw TCP。
4. 明确第一阶段只做单请求调试器。
```

### Phase 1：最小 HTTP Console

```text
1. 增加 HTTP Console 面板。
2. 支持 method、URL、headers、query、body。
3. 支持 JSON/text/formUrlEncoded。
4. 支持发送、取消、响应状态、响应头、响应体。
5. 接入 Portiva 工作台 tab，但默认只占一个 HTTP Console 标签。
6. 再次打开 HTTP Console 时聚焦已有标签。
7. Phase 1 只维护一个默认 workspace。
8. 浏览器 mock 模式可预览。
```

### Phase 2：Tauri HTTP 发送

```text
1. 增加 Tauri HTTP 插件。
2. 增加 HTTP client 封装。
3. 支持超时、重定向、响应大小限制。
4. 接入日志脱敏。
5. 前端构建通过。
```

### Phase 3：请求历史和变量

```text
1. 增加请求历史。
2. 增加变量解析。
3. 增加请求复制、重命名、删除。
4. 考虑 SQLite 持久化。
5. 增加 workspace selector，但仍保持 HTTP Console 单实例。
6. 明确所有 workspace 编辑都发生在同一个 HTTP Console 中。
```

### Phase 4：导入导出和高级能力

```text
1. 支持 EasyPost 数据导入。
2. 支持集合导入导出。
3. 支持 multipart。
4. 支持图片响应预览。
5. 支持下载响应到文件。
```

---

## 11. 验收标准

Phase 1 必须满足：

```text
1. 可以打开 HTTP Console 标签。
2. 可以输入 URL、method、headers、query、body。
3. 浏览器 mock 模式下可以显示模拟响应。
4. HTTP Console 不显示终端、SFTP、串口操作入口。
5. 简单请求不会自动生成新的工作台标签。
6. 重复打开 HTTP Console 会聚焦已有标签，不创建重复实例。
7. 关闭 HTTP Console 不会触发终端/连接关闭逻辑错误。
8. 构建通过。
```

Phase 2 必须满足：

```text
1. Tauri 桌面模式下可以发送真实 HTTP/HTTPS 请求。
2. 请求超时可配置且有明确错误。
3. 响应头、状态码、耗时、大小可见。
4. 超过响应大小限制时有明确提示。
5. 敏感 Header 不进入明文日志。
6. 构建通过。
```

---

## 12. 推荐下一步代码任务

```text
1. 新增 HTTP Console tab 的类型和 mock 状态。
2. 新增 HttpConsolePanel 基础 UI。
3. 在 AppTitlebar 增加打开 HTTP 请求入口。
4. 在 TerminalWorkspace/customTabPanels 接入 HTTP Console tab。
5. 先用 mock client 验证 UI，再接入 Tauri HTTP 插件。
```
