# Portiva

Portiva 是一个基于 Tauri v2、React、TypeScript、xterm.js 和 Rust 构建的跨平台桌面终端客户端。项目目标是提供统一的连接工作台，把 SSH 终端、SFTP 文件管理、串口调试、本地终端以及后续可扩展的 Telnet、Raw TCP 等协议放在同一个应用体验里。

当前项目已经围绕“连接 Profile + 终端会话 + 文件传输 + 安全配置”建立了完整的前后端结构：前端负责工作台、标签页、配置表单和终端渲染，Rust 后端负责协议连接、PTY/串口读写、SFTP 传输、本地文件访问、日志、设置和安全相关数据。

## 主要功能

### 连接与 Profile

- 支持保存和管理连接配置。
- 支持连接分组、最近连接和快速启动。
- 已建模的连接类型包括 SSH、SFTP、Serial、Telnet、Raw TCP。
- UI 通过协议 capabilities 控制终端、文件传输、端口转发、安全提示等入口。

### SSH 终端

- 使用 `russh` 建立 SSH transport。
- 支持密码认证、私钥认证和 SSH agent 认证。
- 支持 known_hosts 校验：首次连接需要确认 fingerprint，host key 变化会阻止连接。
- 支持 PTY 终端、输入输出转发、窗口 resize、断开状态提示。
- 终端渲染基于 xterm.js，并支持快照恢复和输出事件推送。

### SFTP 文件管理

- SSH 连接认证后可打开 SFTP 文件管理。
- 支持远程目录列表、上传、下载、新建目录、删除、重命名。
- 支持本地文件列表、新建目录、删除和重命名。
- 支持传输队列、进度更新、暂停、继续、取消、重试和删除任务。
- 文件内容由 Rust 后端直接读写，前端只处理路径、状态和进度。

### 串口终端

- 支持列出可用串口。
- 支持打开串口终端并读写数据。
- 支持 baud rate、data bits、parity、stop bits、flow control、DTR、RTS、line ending、encoding 等配置。
- 串口输出会批量推送到终端，避免高频数据直接压垮 UI。

### 本地终端

- 支持启动本机 shell。
- Windows 下优先尝试 `pwsh.exe`，然后是 `powershell.exe` 和 `cmd.exe`。
- macOS/Linux 下优先使用 `$SHELL`，并回退到常见 shell。
- 基于 `portable-pty` 管理本地 PTY，支持输入输出和 resize。

### 工作台体验

- 多标签会话工作区。
- 支持终端标签和 SFTP 文件管理标签。
- 支持将终端或文件管理标签分离到独立窗口，并可合并回主窗口。
- 支持标签切换、关闭、重连和排序。
- 支持设置页，包含主题、终端、快捷键、安全、诊断日志等配置。
- 支持应用级日志和敏感字段脱敏预览。

## 当前协议状态

| 协议 | 状态 | 说明 |
| --- | --- | --- |
| SSH | 可用 | 已实现 transport、host key 校验、认证、PTY 终端 |
| SFTP | 可用 | 通过 SSH 会话打开 SFTP，支持基础文件管理和传输队列 |
| Serial | 可用 | 支持串口枚举、配置、读写和终端显示 |
| Local Shell | 可用 | 支持本地 PTY 终端 |
| Telnet | 预留 | 已建模 capabilities 和 Profile，协议协商尚未实现 |
| Raw TCP | 预留 | 已建模 capabilities 和 Profile，TCP 数据流尚未实现 |

## 技术栈

- 桌面框架：Tauri v2
- 前端：React 19、TypeScript、Vite
- 终端：xterm.js、addon-fit、addon-search、addon-serialize
- 后端：Rust、Tokio
- SSH/SFTP：russh、russh-sftp
- 本地终端：portable-pty
- 串口：serial2
- 剪贴板：arboard
- 包管理：pnpm

## 开发环境

需要安装：

- Node.js
- pnpm
- Rust stable toolchain
- Tauri v2 所需的系统依赖

安装依赖：

```bash
pnpm install
```

启动前端开发服务器：

```bash
pnpm dev
```

启动 Tauri 桌面应用：

```bash
pnpm tauri dev
```

构建前端：

```bash
pnpm build
```

构建桌面应用：

```bash
pnpm build:desktop
```

平台打包脚本：

```bash
pnpm build:windows
pnpm build:macos
pnpm build:linux
```

清理构建产物：

```bash
pnpm clean
```

## 设计原则

- 连接模型使用通用的 `ConnectionProfile`、`ConnectionSession`、`ProtocolBackend`，避免把架构绑定到 SSH。
- xterm.js 只负责终端显示和输入采集，协议连接和数据流放在 Rust 后端。
- 密码、私钥 passphrase 等敏感信息不进入长期前端状态。
- 文件传输不通过前端内存搬运文件内容。
- UI 功能入口由 capabilities 决定，不直接依赖协议名称硬编码。
- 非加密协议需要明确安全边界和风险提示。
