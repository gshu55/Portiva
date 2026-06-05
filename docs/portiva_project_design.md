# Portiva 项目设计文档

> 文档版本：v0.3  
> 更新时间：2026-05-11  
> 项目名称：Portiva  
> 项目定位：现代化跨平台多协议终端网关与文件传输客户端  
> 核心技术栈：Tauri v2 + React + TypeScript + xterm.js + Rust  
> 参考方向：Tabby 的产品形态与交互体验，但不做完整克隆。

---

## 0. 总结

Portiva 的目标不是只做一个 SSH/SFTP 客户端，而是做一个可扩展的多协议终端与文件传输客户端。

第一阶段聚焦：

```text
SSH Terminal
SFTP 文件管理
连接 Profile
known_hosts 校验
安全存储
多标签
基础分屏
```

长期可扩展到：

```text
Serial 串口
Telnet
Raw TCP Socket
Local Shell
HTTP/API 调试
WSL
Docker exec
Kubernetes exec
SCP
FTP / FTPS
WebDAV
S3
SSH Tunnel
```

关键设计原则：

```text
1. Portiva 不是 SSH-only 客户端，而是多协议连接平台。
2. xterm.js 只负责终端输入和显示。
3. React 只负责 UI、布局、标签、状态和配置表单。
4. Tauri IPC 只负责受控通信。
5. Rust 后端负责协议连接、数据流、安全、文件传输和本地文件访问。
6. SSH/SFTP 是第一组协议实现，不是系统架构边界。
7. 所有协议能力通过 capabilities 暴露给 UI。
8. 文件传输和终端连接分开建模。
9. 密码、私钥、passphrase、token 不进入前端状态。
10. 大文件传输不经过前端内存。
11. HTTP/API 调试属于短请求/响应模型，不复用终端会话，也不通过 Raw TCP 手写 HTTP。
```

---

## 1. 项目命名

### 1.1 产品名

```text
Portiva
```

### 1.2 中文名

推荐：

```text
星穹终端
```

也可以保留英文名，不强制使用中文名。

### 1.3 仓库和工程命名

```text
GitHub 仓库：portiva-terminal
应用显示名：Portiva
配置目录：~/.portiva
Rust 后端核心：portiva-core
协议适配层：portiva-protocol
前端包名：@portiva/app
```

### 1.4 一句话定位

英文：

```text
Portiva is a modern cross-platform terminal gateway for SSH, SFTP, Serial, Telnet, and more.
```

中文：

```text
Portiva 是一个现代化跨平台终端网关，支持 SSH、SFTP、串口、Telnet 等多协议连接。
```

更偏开发者的中文标语：

```text
一个终端，连接 SSH、SFTP、串口与 Telnet。
```

---

## 2. 产品定位

### 2.1 Portiva 要解决的问题

开发者和运维人员经常需要同时处理：

```text
SSH 登录服务器
SFTP 上传下载文件
串口调试硬件设备
Telnet 登录老旧交换机或设备
Raw TCP 调试网络服务
本地 Shell / WSL / Docker / Kubernetes 终端
SSH 端口转发
多标签、多分屏、多配置管理
```

如果这些能力分别依赖不同工具，体验会割裂。Portiva 的目标是统一这些连接入口。

### 2.2 第一阶段定位

第一阶段不要铺太大，先做稳定的 SSH/SFTP 客户端：

```text
现代 SSH 终端
可视化 SFTP 文件管理
安全连接配置
多标签
基础分屏
轻量跨平台桌面体验
```

### 2.3 长期定位

长期目标是：

```text
Portiva = 多协议终端网关 + 文件传输客户端 + 连接配置中心
```

而不是：

```text
Portiva = SSH 客户端
```

---

## 3. 目标用户

### 3.1 核心用户

```text
后端开发者
全栈开发者
DevOps / SRE
系统管理员
嵌入式开发者
网络设备维护人员
自由开发者和独立工具开发者
```

### 3.2 高频场景

```text
1. 登录 Linux 服务器执行命令。
2. 用 SFTP 上传、下载、编辑配置文件。
3. 同时打开多个 SSH 会话。
4. 一个窗口内分屏查看日志、执行部署命令。
5. 串口连接开发板、路由器、交换机、单片机设备。
6. Telnet 连接老旧网络设备。
7. 使用 Raw TCP 调试端口服务。
8. 从连接 Profile 快速启动常用连接。
```

---

## 4. 非目标

第一阶段不做：

```text
插件市场
云同步
企业堡垒机审计
复杂 RBAC 权限系统
RDP / VNC 图形远程桌面
完整 Zmodem / Xmodem / Ymodem
Telnet / Serial，第一阶段只预留架构
本地 Shell 完整集成
Docker / Kubernetes exec
商业级自动更新体系
完整 Tabby 级别功能克隆
```

这些功能可以在后续版本做，但第一阶段不能影响 SSH/SFTP 的稳定性。

---

## 5. 技术栈

### 5.1 桌面框架

```text
Tauri v2
```

职责：

```text
跨平台桌面壳
窗口管理
菜单、托盘、快捷键
前后端 IPC
应用权限控制
文件选择器
打包发布
```

选择原因：

```text
1. 比 Electron 更轻。
2. 前端可以使用 React + TypeScript。
3. 后端可以使用 Rust 实现协议和系统能力。
4. 适合把敏感逻辑放到 Rust 侧。
5. 适合跨平台桌面应用。
```

### 5.2 前端

```text
React
TypeScript
Vite
xterm.js
Zustand 或 Jotai
TanStack Query
CSS Modules / Tailwind CSS
```

职责：

```text
窗口布局
多标签
分屏
连接管理 UI
终端显示
SFTP 文件列表
传输队列显示
主题和快捷键配置
错误提示
```

### 5.3 终端组件

```text
xterm.js
```

推荐插件：

```text
@xterm/xterm
@xterm/addon-fit
@xterm/addon-search
@xterm/addon-web-links
@xterm/addon-webgl，可选
@xterm/addon-clipboard，可选
@xterm/addon-serialize，后续可选
```

xterm.js 只负责：

```text
终端渲染
用户输入采集
ANSI / VT 序列显示
光标、颜色、滚屏、选择、搜索
```

xterm.js 不负责：

```text
SSH 连接
SFTP 文件传输
串口读写
Telnet 协商
密码保存
known_hosts
本地文件访问
```

### 5.4 Rust 后端

推荐依赖方向：

```text
tokio
serde
serde_json
thiserror
anyhow
tracing
tracing-subscriber
uuid
dashmap
bytes
async-trait
```

SSH/SFTP：

```text
首选：russh + russh-sftp
备选：ssh2 / libssh2 adapter
```

串口，后续：

```text
tokio-serial
serial2-tokio
serialport + blocking thread
```

Telnet，后续：

```text
telnet crate
nectar codec
自研 TelnetCodec
```

Secret 存储：

```text
tauri-plugin-stronghold
或系统 keyring
```

---

## 6. 总体架构

```text
┌─────────────────────────────────────────────┐
│ React + TypeScript UI                       │
│                                             │
│  ├─ TerminalPane / xterm.js                 │
│  ├─ FileTransferPanel                       │
│  ├─ ConnectionManager UI                    │
│  ├─ ProfileEditor                           │
│  ├─ TransferQueue                           │
│  ├─ Tabs / Split Panes                      │
│  ├─ Theme / Keymap Settings                 │
│  └─ Log / Error UI                          │
└─────────────────────────────────────────────┘
                    │
                    │ Tauri invoke / Channel
                    ▼
┌─────────────────────────────────────────────┐
│ Rust Backend                                │
│                                             │
│  ├─ ConnectionManager                       │
│  ├─ TerminalService                         │
│  ├─ FileTransferService                     │
│  ├─ TransferService                         │
│  ├─ ProfileStore                            │
│  ├─ SecretStore                             │
│  ├─ KnownHostsStore                         │
│  ├─ TunnelService                           │
│  └─ ProtocolBackend Registry                │
└─────────────────────────────────────────────┘
                    │
                    ▼
┌─────────────────────────────────────────────┐
│ Protocol Backends                           │
│                                             │
│  ├─ SSHBackend                              │
│  │   ├─ Terminal                            │
│  │   ├─ SFTP                                │
│  │   └─ Port Forwarding                     │
│  │                                         │
│  ├─ TelnetBackend                           │
│  ├─ SerialBackend                           │
│  ├─ RawSocketBackend                        │
│  ├─ LocalShellBackend                       │
│  ├─ DockerExecBackend                       │
│  └─ KubernetesExecBackend                   │
└─────────────────────────────────────────────┘
```

---

## 7. 核心抽象

### 7.1 不要使用 SSH-only 命名

不推荐：

```text
SshProfile
SshSession
SshTerminal
SshManager
SshOnlyBackend
```

推荐：

```text
ConnectionProfile
ConnectionSession
TerminalConnection
ConnectionManager
ProtocolBackend
ConnectionCapabilities
```

原因：

```text
SSH 只是第一种协议。
Telnet、Serial、Raw TCP、Local Shell 都需要共用终端 UI。
如果第一版命名过于 SSH 化，后续会被迫大规模重构。
```

### 7.2 连接类型

TypeScript：

```ts
export type ConnectionType =
  | 'ssh'
  | 'telnet'
  | 'serial'
  | 'raw-tcp'
  | 'local-shell'
  | 'wsl'
  | 'docker-exec'
  | 'kubernetes-exec'
  | 'ftp'
  | 'ftps'
  | 'webdav'
  | 's3'
```

### 7.3 Profile 联合类型

```ts
export type ConnectionProfile =
  | SshProfile
  | TelnetProfile
  | SerialProfile
  | RawSocketProfile
  | LocalShellProfile
  | WslProfile
  | DockerExecProfile
  | KubernetesExecProfile
  | FtpProfile
  | WebDavProfile
  | S3Profile

export interface BaseProfile {
  id: string
  name: string
  groupId?: string
  type: ConnectionType
  tags?: string[]
  terminal?: TerminalOptions
  createdAt: string
  updatedAt: string
}
```

SSH Profile：

```ts
export interface SshProfile extends BaseProfile {
  type: 'ssh'
  host: string
  port: number
  username: string
  authType: 'password' | 'private-key' | 'agent'
  privateKeyPath?: string
  enableSftp: boolean
  enableAgentForwarding?: boolean
  enableCompression?: boolean
  proxyJump?: string
}
```

Telnet Profile：

```ts
export interface TelnetProfile extends BaseProfile {
  type: 'telnet'
  host: string
  port: number
  username?: string
  passwordSecretId?: string
  terminalType: 'xterm' | 'vt100' | 'vt220'
  lineEnding: 'crlf' | 'cr' | 'lf'
  encoding: 'utf-8' | 'gbk' | 'latin1'
}
```

Serial Profile：

```ts
export interface SerialProfile extends BaseProfile {
  type: 'serial'
  portName: string
  baudRate: number
  dataBits: 5 | 6 | 7 | 8
  parity: 'none' | 'odd' | 'even' | 'mark' | 'space'
  stopBits: 1 | 1.5 | 2
  flowControl: 'none' | 'software' | 'hardware'
  lineEnding: 'crlf' | 'cr' | 'lf'
  encoding: 'utf-8' | 'gbk' | 'latin1'
  dtr?: boolean
  rts?: boolean
}
```

Raw TCP Profile：

```ts
export interface RawSocketProfile extends BaseProfile {
  type: 'raw-tcp'
  host: string
  port: number
  lineEnding: 'crlf' | 'cr' | 'lf'
  encoding: 'utf-8' | 'gbk' | 'latin1'
}
```

---

## 8. 能力模型

不同协议支持的功能不同。UI 不应该直接判断协议类型，而应该根据 capabilities 控制功能入口。

### 8.1 Capabilities 类型

```ts
export interface ConnectionCapabilities {
  terminal: boolean
  fileTransfer: boolean
  sftp: boolean
  scp: boolean
  tunnel: boolean
  portForwarding: boolean
  ptyResize: boolean
  secureTransport: boolean
  reconnect: boolean
  localFileAccess: boolean
  requiresHostKeyVerification: boolean
}
```

### 8.2 SSH capabilities

```ts
{
  terminal: true,
  fileTransfer: true,
  sftp: true,
  scp: true,
  tunnel: true,
  portForwarding: true,
  ptyResize: true,
  secureTransport: true,
  reconnect: true,
  localFileAccess: false,
  requiresHostKeyVerification: true
}
```

### 8.3 Telnet capabilities

```ts
{
  terminal: true,
  fileTransfer: false,
  sftp: false,
  scp: false,
  tunnel: false,
  portForwarding: false,
  ptyResize: true,
  secureTransport: false,
  reconnect: true,
  localFileAccess: false,
  requiresHostKeyVerification: false
}
```

### 8.4 Serial capabilities

```ts
{
  terminal: true,
  fileTransfer: false,
  sftp: false,
  scp: false,
  tunnel: false,
  portForwarding: false,
  ptyResize: false,
  secureTransport: false,
  reconnect: true,
  localFileAccess: false,
  requiresHostKeyVerification: false
}
```

### 8.5 FTP capabilities

```ts
{
  terminal: false,
  fileTransfer: true,
  sftp: false,
  scp: false,
  tunnel: false,
  portForwarding: false,
  ptyResize: false,
  secureTransport: false,
  reconnect: true,
  localFileAccess: false,
  requiresHostKeyVerification: false
}
```

### 8.6 UI 判断方式

```ts
if (capabilities.terminal) {
  showTerminalButton()
}

if (capabilities.fileTransfer) {
  showFileTransferPanel()
}

if (capabilities.sftp) {
  showSftpPanel()
}

if (capabilities.portForwarding) {
  showTunnelPanel()
}

if (!capabilities.secureTransport) {
  showInsecureConnectionWarning()
}
```

---

## 9. 终端连接抽象

### 9.1 Rust trait

```rust
use async_trait::async_trait;
use bytes::Bytes;

#[derive(Debug, Clone)]
pub struct TerminalSize {
    pub cols: u16,
    pub rows: u16,
    pub width_px: u16,
    pub height_px: u16,
}

#[derive(Debug, Clone)]
pub struct ConnectionCapabilities {
    pub terminal: bool,
    pub file_transfer: bool,
    pub sftp: bool,
    pub scp: bool,
    pub tunnel: bool,
    pub port_forwarding: bool,
    pub pty_resize: bool,
    pub secure_transport: bool,
    pub reconnect: bool,
    pub local_file_access: bool,
    pub requires_host_key_verification: bool,
}

#[async_trait]
pub trait TerminalConnection: Send + Sync {
    async fn write(&self, data: Bytes) -> anyhow::Result<()>;

    async fn resize(&self, size: TerminalSize) -> anyhow::Result<()> {
        let _ = size;
        Ok(())
    }

    async fn close(&self) -> anyhow::Result<()>;

    fn capabilities(&self) -> ConnectionCapabilities;
}
```

### 9.2 协议实现

```rust
pub struct SshTerminalConnection {
    // russh channel 或 ssh2 channel
}

pub struct TelnetTerminalConnection {
    // TcpStream + TelnetCodec
}

pub struct SerialTerminalConnection {
    // tokio_serial / serial2_tokio
}

pub struct RawSocketConnection {
    // TcpStream
}

pub struct LocalShellConnection {
    // pty process
}
```

---

## 10. 文件传输抽象

SFTP 只是 SSH 的一种文件传输能力。不要把上层 UI 永远命名成 SFTP-only。

推荐上层命名：

```text
FileTransferPanel
FileTransferService
RemoteFileService
TransferService
```

底层协议命名：

```text
SftpBackend
ScpBackend
FtpBackend
WebDavBackend
S3Backend
```

### 10.1 Rust trait

```rust
#[async_trait::async_trait]
pub trait FileTransferConnection: Send + Sync {
    async fn list_dir(&self, path: String) -> anyhow::Result<Vec<RemoteEntry>>;

    async fn upload(
        &self,
        local_path: std::path::PathBuf,
        remote_path: String,
    ) -> anyhow::Result<TransferId>;

    async fn download(
        &self,
        remote_path: String,
        local_path: std::path::PathBuf,
    ) -> anyhow::Result<TransferId>;

    async fn mkdir(&self, path: String) -> anyhow::Result<()>;

    async fn remove(&self, path: String) -> anyhow::Result<()>;

    async fn rename(&self, from: String, to: String) -> anyhow::Result<()>;
}
```

### 10.2 RemoteEntry

```ts
export interface RemoteEntry {
  name: string
  path: string
  kind: 'file' | 'directory' | 'symlink' | 'other'
  size: number
  modifiedAt?: string
  permissions?: string
  owner?: string
  group?: string
}
```

### 10.3 TransferTask

```ts
export interface TransferTask {
  id: string
  connectionId: string
  direction: 'upload' | 'download'
  protocol: 'sftp' | 'scp' | 'ftp' | 'webdav' | 's3'
  localPath: string
  remotePath: string
  status: 'pending' | 'running' | 'paused' | 'cancelled' | 'failed' | 'completed'
  totalBytes?: number
  transferredBytes: number
  speedBytesPerSecond?: number
  error?: string
  createdAt: string
  updatedAt: string
}
```

---

## 11. ProtocolBackend 抽象

```rust
#[async_trait::async_trait]
pub trait ProtocolBackend: Send + Sync {
    async fn connect(
        &self,
        profile: ConnectionProfile,
    ) -> anyhow::Result<ConnectionSession>;

    fn protocol_type(&self) -> ProtocolType;

    fn capabilities(&self) -> ConnectionCapabilities;
}
```

ConnectionSession 内部可以包含不同能力：

```rust
pub struct ConnectionSession {
    pub id: ConnectionId,
    pub profile_id: Option<ProfileId>,
    pub protocol_type: ProtocolType,
    pub capabilities: ConnectionCapabilities,
    pub terminal: Option<Arc<dyn TerminalConnection>>,
    pub file_transfer: Option<Arc<dyn FileTransferConnection>>,
}
```

---

## 12. 前端模块设计

```text
src/
  app/
    App.tsx
    providers.tsx
    routes.tsx

  features/
    terminal/
      TerminalPane.tsx
      TerminalTabs.tsx
      TerminalSplit.tsx
      terminal.store.ts
      terminal.ipc.ts
      useTerminalSession.ts

    file-transfer/
      FileTransferPanel.tsx
      RemoteFileTree.tsx
      RemoteFileList.tsx
      TransferQueue.tsx
      transfer.store.ts
      transfer.ipc.ts

    connections/
      ConnectionList.tsx
      ConnectionEditor.tsx
      ConnectionLauncher.tsx
      connection.schema.ts
      connection.store.ts

    protocols/
      ssh/
        SshProfileForm.tsx
      telnet/
        TelnetProfileForm.tsx
      serial/
        SerialProfileForm.tsx
      raw-tcp/
        RawTcpProfileForm.tsx

    settings/
      SettingsPage.tsx
      ThemeSettings.tsx
      KeymapSettings.tsx
      SecuritySettings.tsx

  shared/
    ipc/
      commands.ts
      channels.ts
      types.ts
    ui/
    utils/
```

---

## 13. Rust 后端模块设计

```text
src-tauri/src/
  lib.rs
  main.rs

  commands/
    connection.rs
    terminal.rs
    file_transfer.rs
    profiles.rs
    security.rs
    serial.rs

  domain/
    connection.rs
    profile.rs
    terminal.rs
    file_transfer.rs
    transfer.rs
    capability.rs
    error.rs

  services/
    connection_manager.rs
    terminal_service.rs
    file_transfer_service.rs
    transfer_service.rs
    profile_store.rs
    secret_store.rs
    known_hosts_store.rs
    tunnel_service.rs

  protocol/
    mod.rs

    ssh/
      mod.rs
      russh_backend.rs
      ssh2_backend.rs
      sftp.rs
      tunnel.rs

    telnet/
      mod.rs
      codec.rs
      backend.rs

    serial/
      mod.rs
      backend.rs
      port_list.rs

    raw_tcp/
      mod.rs
      backend.rs

    local_shell/
      mod.rs
      backend.rs

  security/
    fingerprint.rs
    redaction.rs
    permissions.rs

  logging/
    mod.rs
```

---

## 14. IPC 设计

### 14.1 统一连接命令

不要设计成：

```text
ssh_connect
ssh_write
telnet_write
serial_write
```

推荐统一成：

```text
connection_open(profileId | temporaryProfile) -> ConnectionId
connection_close(connectionId) -> void
connection_get_capabilities(connectionId) -> ConnectionCapabilities
connection_status(connectionId) -> ConnectionStatus
```

### 14.2 终端命令

```text
terminal_attach(connectionId, ptySize, outputChannel) -> TerminalId
terminal_write(terminalId, data) -> void
terminal_resize(terminalId, ptySize) -> void
terminal_detach(terminalId) -> void
terminal_close(terminalId) -> void
```

### 14.3 文件传输命令

```text
file_transfer_open(connectionId) -> FileTransferSessionId
file_transfer_list(sessionId, remotePath) -> RemoteEntry[]
file_transfer_upload(sessionId, localPath, remotePath, progressChannel) -> TransferId
file_transfer_download(sessionId, remotePath, localPath, progressChannel) -> TransferId
file_transfer_mkdir(sessionId, remotePath) -> void
file_transfer_remove(sessionId, remotePath) -> void
file_transfer_rename(sessionId, from, to) -> void
file_transfer_cancel(transferId) -> void
```

如果 Telnet 或 Serial 调用文件传输命令，后端返回：

```text
ConnectionDoesNotSupportFileTransfer
```

### 14.4 Profile 命令

```text
profile_list() -> ConnectionProfile[]
profile_create(profile) -> ProfileId
profile_update(profileId, patch) -> void
profile_delete(profileId) -> void
profile_test_connection(profileId | temporaryProfile) -> TestResult
```

### 14.5 Serial 命令

```text
serial_list_ports() -> SerialPortInfo[]
```

Serial 不需要独立连接命令。打开串口仍然使用：

```text
connection_open(serialProfile)
```

---

## 15. SSH/SFTP 详细设计

### 15.1 SSH 连接流程

```text
1. 用户选择或填写 SSH Profile。
2. 前端调用 connection_open。
3. Rust 读取 profile。
4. Rust 从 SecretStore 取密码或 passphrase。
5. Rust 建立 SSH transport。
6. Rust 校验 host key。
7. 首次连接时返回 fingerprint confirmation request。
8. 用户确认后保存 known_hosts。
9. 创建 ConnectionSession。
10. 前端调用 terminal_attach 打开 PTY。
11. 后端读取 SSH channel 输出，通过 Channel 推给 xterm.js。
12. 前端输入通过 terminal_write 写回 SSH channel。
```

### 15.2 known_hosts 要求

必须实现：

```text
首次连接显示 fingerprint
用户确认后保存 host key
后续连接自动校验
host key 改变时阻止连接
支持用户手动更新 known_hosts
日志中不泄露敏感字段
```

不要默认：

```text
静默信任所有 host key
```

### 15.3 SSH 终端要求

必须支持：

```text
bash / zsh
vim / nano
less / top / htop
tmux
窗口 resize
ANSI 颜色
复制粘贴
中文输入，尽量支持
大量输出不冻结
```

### 15.4 SFTP 文件管理要求

第一阶段支持：

```text
列目录
上传
下载
删除
重命名
新建目录
刷新
显示大小、时间、权限
传输进度
取消任务
失败重试
同名冲突处理
```

大文件处理原则：

```text
本地文件由 Rust 后端直接读写。
前端只传路径和操作参数。
前端只接收进度和状态。
文件内容不经过 IPC。
```

---

## 16. Serial 串口扩展设计

Serial 的数据模型非常适合复用 xterm.js：

```text
用户输入字节
  ↓
写入串口
  ↓
设备返回字节
  ↓
xterm.js 显示
```

需要支持的配置：

```text
portName: COM3 / /dev/ttyUSB0 / /dev/tty.usbserial-xxxx
baudRate: 9600 / 115200 / 921600
dataBits
parity
stopBits
flowControl
DTR
RTS
lineEnding
encoding
```

需要处理的问题：

```text
1. Linux 下串口权限问题。
2. macOS 下设备名称变化。
3. Windows 下 COM 口占用。
4. 设备拔出后的异常状态。
5. 串口热插拔刷新。
6. 高速输出时前端节流。
7. CR / LF / CRLF 转换。
8. DTR / RTS 控制。
```

Serial 不支持：

```text
SFTP
SSH agent
SSH tunnel
known_hosts
端口转发
```

---

## 17. Telnet 扩展设计

Telnet 不是简单 TCP 文本流，需要处理协议协商。

关键点：

```text
IAC
DO / DONT
WILL / WONT
ECHO
SUPPRESS-GO-AHEAD
TERMINAL-TYPE
NAWS，窗口大小协商
BINARY mode
LINEMODE
CR / LF 转换
```

Telnet 数据流：

```text
xterm.js onData
  ↓
terminal_write
  ↓
TelnetBackend.write
  ↓
TelnetCodec 处理 IAC 转义
  ↓
TcpStream.write
```

输出：

```text
TcpStream.read
  ↓
TelnetCodec 解析协商和数据
  ↓
Channel
  ↓
xterm.write
```

安全提示：

```text
Telnet 通常是明文传输。
用户名、密码、命令和输出可能被网络中间节点看到。
仅建议在可信内网、实验环境、老旧设备维护场景使用。
```

UI 中必须显示非加密连接提示。

---

## 18. Raw TCP 扩展设计

Raw TCP 适合调试：

```text
自定义端口服务
嵌入式设备 TCP 控制台
简单 socket 服务
网络协议调试
```

Raw TCP 可以直接复用：

```text
TerminalPane
terminal_write
Channel output
ConnectionManager
```

不需要：

```text
PTY
Telnet 协商
host key
SFTP
```

需要配置：

```text
host
port
lineEnding
encoding
reconnect
timeout
```

---

## 18.5 HTTP/API 调试扩展设计

HTTP/API 调试与 SSH、SFTP、Serial、Telnet、Raw TCP 的本质差异在于：它是短请求/响应模型，不是持续连接会话。

推荐迁移 EasyPost 的 HTTP 调试能力，但迁移边界必须清晰：

```text
迁移 EasyPost 的请求模型
迁移 EasyPost 的请求准备逻辑
迁移 EasyPost 的变量解析思路
迁移 EasyPost 的响应读取和格式化逻辑
不直接迁移 EasyPost 的完整 AppShell 视觉实现
不迁移 EasyPost 的整套 UI 样式
不把 HTTP 响应塞进 TerminalSession
不通过 Raw TCP 手写 HTTP
```

HTTP 调试在 Portiva 中应表现为一个工作台工具，而不是一个请求一个工作台标签：

```text
WorkspaceTab(kind = http-console)
  ↓
HttpConsolePanel
  ↓
HttpRequestDraft
  ↓
prepareHttpRequestDraft
  ↓
HttpClient.send
  ↓
HttpResponseSnapshot
```

HTTP Console 只允许一个顶层标签。多个请求通过左侧草稿、历史、收藏、集合和搜索来管理。MVP 不提供“固定/单独打开为工作台标签”能力。

EasyPost 有 Workspace / Project / Folder / Request 数据层级，请求编辑状态也绑定 workspaceId。因此 MVP 只允许一个 HTTP Console 顶层实例。重复打开 HTTP/API 调试时应聚焦已有 HTTP Console，而不是创建新标签。Phase 1 只维护一个默认 workspace；后续即使增加 workspace selector，也仍在同一个 HTTP Console 内切换。

HTTP Console 的内部布局沿用 EasyPost 原有方式：左侧 workspace tree，主区上半部分 request tabs / request editor，主区下半部分 response workspace，中间使用可拖拽分隔条。这里的 request tabs 是 HTTP Console 内部编辑标签，不是 Portiva 顶层工作台标签。

视觉实现必须适配 Portiva 当前风格：保留 EasyPost 的信息架构和操作路径，但替换 glass/liquid 视觉语言、Tailwind 全局样式、按钮输入框外观、面板边框、颜色和状态提示。

第一阶段推荐通过 Tauri HTTP 插件发送请求，后续再封装成 Portiva 自己的 Rust IPC 命令：

```text
http_request_send
http_request_cancel
http_request_history_list
http_request_history_delete
```

HTTP/API 调试可以复用：

```text
工作台标签体系
Tauri IPC 命令桥
应用日志
敏感字段脱敏
设置页
诊断页
浏览器 mock 数据源
```

HTTP/API 调试不复用：

```text
TerminalSession
FileTransferSession
PTY resize
SFTP transfer queue
Raw TCP 字节流
known_hosts 校验
```

详细迁移方案见：

```text
docs/easypost_http_integration.md
```

---

## 19. Local Shell / WSL / Docker / Kubernetes

这些功能适合后续版本。

### 19.1 Local Shell

需要本地 PTY：

```text
Windows: ConPTY
macOS / Linux: pty
```

### 19.2 WSL

可作为 Local Shell 的特殊 profile：

```text
wsl.exe -d <distribution>
```

### 19.3 Docker exec

可以选择：

```text
调用 docker CLI
或接 Docker Engine API
```

### 19.4 Kubernetes exec

可以选择：

```text
调用 kubectl exec
或接 Kubernetes API
```

这些都属于终端流类连接，可以共用 xterm.js。

---

## 20. 安全设计

### 20.1 Secret 管理

前端不能保存：

```text
密码
私钥内容
私钥 passphrase
token
已解密 secret
```

Profile 中只保存：

```text
secretId
privateKeyPath
authType
非敏感配置
```

Secret 由 Rust 后端管理：

```text
SecretStore
Stronghold 或 OS keyring
```

### 20.2 日志脱敏

日志中必须脱敏：

```text
password
passphrase
private_key
token
authorization
secret
```

错误信息应避免显示完整敏感路径或密钥内容。

### 20.3 Tauri 权限

原则：

```text
最小权限
按窗口或 WebView 控制 capabilities
前端不能直接读任意本地文件
上传下载路径必须经过文件选择器或后端校验
```

### 20.4 Telnet / Raw TCP 风险提示

对非加密协议显示：

```text
此连接不是加密传输，用户名、密码和输入内容可能被监听。
```

### 20.5 known_hosts

SSH 必须启用 host key 校验。

```text
首次连接：显示 fingerprint。
再次连接：自动比对。
发生变化：阻止连接。
```

---

## 21. 性能设计

### 21.1 终端输出

问题：

```text
远程日志大量输出时，不能每个字节触发一次 UI 更新。
```

策略：

```text
1. 后端按块读取。
2. Channel 推送批量数据。
3. 前端用 requestAnimationFrame 合并 xterm.write。
4. 大输出下限制渲染频率。
5. WebGL addon 可选启用。
6. WebGL 不稳定时回退 canvas/dom renderer。
```

### 21.2 SFTP 传输

策略：

```text
1. Rust 后端流式读写。
2. 前端不接触文件二进制内容。
3. 默认并发 2~4 个任务。
4. 支持取消。
5. 支持失败重试。
6. 进度事件节流，例如 100ms 更新一次。
```

### 21.3 多连接

目标：

```text
同时打开 5~10 个 SSH 终端，UI 不明显卡顿。
```

策略：

```text
每个连接独立任务。
ConnectionManager 管理生命周期。
关闭 tab 后释放后端资源。
断开连接后及时停止读取循环。
```

---

## 22. UI 设计

### 22.1 主窗口布局

```text
┌─────────────────────────────────────────────┐
│ 顶部工具栏 / Command Palette / Search       │
├───────────────┬─────────────────────────────┤
│ 连接列表       │ Tabs / Split Panes          │
│ Profiles      │                             │
│ Groups        │ TerminalPane / File Panel   │
│ Recent        │                             │
├───────────────┴─────────────────────────────┤
│ Transfer Queue / Logs / Status              │
└─────────────────────────────────────────────┘
```

### 22.2 新建连接

```text
新建连接
├─ SSH
├─ Telnet，后续
├─ Serial，后续
├─ Raw TCP，后续
├─ Local Shell，后续
├─ WSL，后续
├─ Docker Exec，后续
├─ Kubernetes Exec，后续
├─ FTP / FTPS，后续
├─ WebDAV，后续
└─ S3，后续
```

第一版只启用：

```text
SSH
```

SFTP 作为 SSH 的文件传输能力，不单独作为终端连接类型。

### 22.3 Tab 标题

建议显示协议类型：

```text
[SSH] root@192.168.1.10
[SERIAL] COM3
[TELNET] switch-01
[RAW] 10.0.0.5:9000
```

### 22.4 SFTP 面板

与 SSH 连接绑定：

```text
连接打开后，如果 capabilities.sftp == true，则显示 SFTP 按钮。
```

SFTP 面板功能：

```text
远程路径导航
目录树
文件列表
右键菜单
上传
下载
删除
重命名
新建目录
刷新
传输队列
```

---

## 23. 版本路线图

### v0.1：SSH Terminal MVP

目标：

```text
能稳定打开 SSH 交互终端。
```

功能：

```text
临时连接表单
SSH 密码登录
SSH 私钥登录
xterm.js 终端
输入输出
resize
断开连接
错误提示
```

验收：

```text
能连接 Ubuntu / Debian / Rocky / macOS SSH Server。
能运行 bash / zsh。
能运行 vim / top / htop / tmux。
窗口 resize 后布局正确。
连续输出大量日志时 UI 不冻结。
断开连接后资源释放。
```

### v0.2：Profile + Security

目标：

```text
连接配置可长期保存，安全边界成型。
```

功能：

```text
Profile CRUD
分组
最近连接
known_hosts
fingerprint 确认弹窗
密码/私钥 passphrase 安全存储
日志脱敏
```

验收：

```text
首次连接显示 fingerprint。
确认后保存 known_hosts。
host key 改变时阻止连接。
前端状态中看不到密码/passphrase。
日志中不出现敏感字段。
```

### v0.3：SFTP 文件管理

目标：

```text
SSH 连接内可打开 SFTP 面板。
```

功能：

```text
列目录
上传
下载
删除
重命名
mkdir
传输队列
进度显示
取消任务
失败重试
同名冲突处理
```

验收：

```text
上传 1GB 文件成功。
下载 1GB 文件成功。
传输过程中 UI 不冻结。
取消任务有效。
同名文件冲突有明确处理。
```

### v0.4：Tabby 式基础体验

目标：

```text
从能用变成愿意长期使用。
```

功能：

```text
多标签
基础分屏
终端搜索
链接识别
主题
字体配置
快捷键
右键菜单
Tab 恢复
```

验收：

```text
可同时打开 5 个 SSH 会话。
分屏后 resize 正常。
快捷键可配置。
主题切换不影响终端内容。
```

### v0.5：Serial

目标：

```text
接入串口终端。
```

功能：

```text
列出串口
打开串口
配置 baudRate / parity / stopBits / flowControl
DTR / RTS
CRLF 转换
设备拔出提示
```

验收：

```text
能打开 COM3 / /dev/ttyUSB0 / /dev/tty.usbserial-*。
支持 9600 / 115200 / 921600。
设备拔出后状态正确。
串口被占用时错误明确。
不显示 SFTP 入口。
```

### v0.6：Telnet

目标：

```text
接入 Telnet 终端。
```

功能：

```text
连接 Telnet server
基础 option negotiation
ECHO
TERMINAL-TYPE
NAWS
CRLF 配置
明文连接警告
```

验收：

```text
能连接标准 Telnet server。
登录提示正常。
IAC 字节不污染终端显示。
resize 后远端程序布局正确。
显示明文风险提示。
```

### v0.7：Raw TCP

目标：

```text
支持简单 socket 调试。
```

功能：

```text
host / port 连接
输入输出
line ending
encoding
reconnect
```

### v0.8：Local Shell / WSL

目标：

```text
支持本地终端。
```

功能：

```text
Windows ConPTY
macOS/Linux PTY
PowerShell / cmd / bash / zsh
WSL profile
```

### v0.9：HTTP/API 调试

目标：

```text
迁移 EasyPost 的核心 HTTP 请求调试能力。
```

功能：

```text
HTTP Console 工具页
沿用 EasyPost 的 workspace tree / request editor / response workspace 布局
method / URL / query / headers / body
JSON / text / formUrlEncoded body
发送和取消
响应状态、响应头、响应体
超时和响应大小限制
敏感 Header 脱敏
```

验收：

```text
HTTP Console 不显示终端或 SFTP 操作入口。
简单请求不会自动生成新的工作台标签。
重复打开 HTTP Console 会聚焦已有标签。
浏览器 mock 模式下可预览。
Tauri 桌面模式下可发送真实 HTTP/HTTPS 请求。
Authorization、Cookie、token 等敏感字段不进入明文日志。
超过响应大小限制时有明确提示。
```

### v1.0：稳定版

目标：

```text
形成稳定可发布版本。
```

必须具备：

```text
SSH Terminal
SFTP
Profile
known_hosts
SecretStore
多标签
基础分屏
主题/字体配置
传输队列
Windows/macOS/Linux 打包
基础崩溃日志
```

---

## 24. 测试计划

### 24.1 单元测试

```text
Profile 序列化和反序列化
ConnectionCapabilities 判断
known_hosts fingerprint 比较
路径规范化
错误类型转换
日志脱敏
传输进度计算
```

### 24.2 集成测试

使用 Docker 准备 OpenSSH Server：

```text
密码登录
私钥登录
错误密码
host key 改变
SFTP list/upload/download/delete
大文件传输
```

### 24.3 终端测试

```text
bash
zsh
vim
nano
tmux
htop
less
中文输入
emoji 显示
复制粘贴
多行粘贴
窗口 resize
大量日志输出
```

### 24.4 SFTP 测试

```text
空目录
大目录
文件名含空格
中文文件名
权限不足
符号链接
1GB 文件上传
1GB 文件下载
取消任务
断网重连
同名冲突
```

### 24.5 Serial 测试，后续

```text
列出串口
打开串口
关闭串口
设备拔出
设备重插
高速输出
DTR/RTS
不同波特率
```

### 24.6 Telnet 测试，后续

```text
标准 Telnet server
Echo 协商
NAWS 协商
终端类型协商
resize
CRLF
明文警告
```

---

## 25. 风险与应对

### 25.1 SSH 库兼容性风险

风险：

```text
russh 对某些老旧服务器兼容性不足。
```

应对：

```text
用 ProtocolBackend 抽象。
保留 ssh2/libssh2 adapter。
用集成测试覆盖常见 OpenSSH 服务器。
```

### 25.2 终端高输出卡顿

风险：

```text
大量输出导致 UI 卡顿。
```

应对：

```text
后端分块读取。
前端批量写入 xterm。
使用 requestAnimationFrame 合并刷新。
限制进度事件频率。
必要时启用 WebGL addon。
```

### 25.3 Secret 泄漏

风险：

```text
密码或 passphrase 进入前端状态或日志。
```

应对：

```text
Secret 只存 Rust 后端。
Profile 只存 secretId。
日志脱敏。
前端 DevTools 不可见 secret。
```

### 25.4 Telnet 安全误导

风险：

```text
用户误以为 Telnet 是安全连接。
```

应对：

```text
UI 明确标红提示明文风险。
Profile 中标记 secureTransport=false。
Tab 标题显示 [TELNET]。
```

### 25.5 功能范围膨胀

风险：

```text
过早做 Serial/Telnet/Docker/K8s，导致 SSH/SFTP 不稳定。
```

应对：

```text
第一阶段只做 SSH/SFTP。
架构预留，但不提前实现所有协议。
每个版本有明确验收标准。
```

---

## 26. 开发启动清单

### 26.1 初始化项目

```bash
pnpm create tauri-app
```

建议选择：

```text
Frontend: React + TypeScript
Package manager: pnpm
```

### 26.2 前端依赖

```bash
pnpm add @xterm/xterm
pnpm add @xterm/addon-fit @xterm/addon-search @xterm/addon-web-links @xterm/addon-webgl
pnpm add zustand @tanstack/react-query zod
```

### 26.3 Rust 依赖

```bash
cd src-tauri
cargo add tokio serde serde_json thiserror anyhow tracing tracing-subscriber uuid dashmap bytes async-trait
cargo add russh russh-sftp
```

### 26.4 第一批要实现的文件

```text
src/features/terminal/TerminalPane.tsx
src/features/terminal/terminal.ipc.ts
src/features/connections/ConnectionEditor.tsx
src/features/connections/connection.schema.ts

src-tauri/src/commands/connection.rs
src-tauri/src/commands/terminal.rs
src-tauri/src/domain/connection.rs
src-tauri/src/domain/profile.rs
src-tauri/src/services/connection_manager.rs
src-tauri/src/services/terminal_service.rs
src-tauri/src/protocol/mod.rs
src-tauri/src/protocol/ssh/russh_backend.rs
```

---

## 27. MVP 验收标准

v0.1 最小可用版本必须满足：

```text
1. 可以输入 SSH host、port、username、password 连接服务器。
2. 可以打开 xterm.js 交互终端。
3. 可以运行 bash、vim、top、tmux。
4. 终端 resize 正常。
5. 断开连接后状态正确。
6. 关闭 tab 后后端资源释放。
7. 错误密码有明确提示。
8. 后端日志不出现密码。
9. UI 大量输出不明显卡死。
10. 代码中已经使用 ConnectionProfile / ConnectionManager / ProtocolBackend 抽象。
```

v0.3 SFTP 版本必须满足：

```text
1. 可以打开当前 SSH 连接的 SFTP 面板。
2. 可以列远程目录。
3. 可以上传和下载文件。
4. 可以删除、重命名、新建目录。
5. 上传下载 1GB 文件时 UI 不冻结。
6. 文件内容不经过前端 IPC。
7. 传输队列可取消任务。
8. 传输失败有明确错误。
9. Telnet/Serial 类型不会显示 SFTP 入口。
10. capabilities 控制 UI 功能入口。
```

---

## 28. 推荐最终模块命名

```text
Portiva Core        Rust 后端核心
Portiva UI          React 前端
Portiva Terminal    xterm.js 终端模块
Portiva Bridge      协议适配层
Portiva Transfer    文件传输模块
Portiva Vault       Secret 和安全存储
Portiva Profiles    连接配置模块
Portiva Tunnel      SSH 隧道模块
```

---

## 29. 设计结论

Portiva 当前设计可以支持 SSH/SFTP，也可以扩展到 Serial、Telnet、Raw TCP、Local Shell、HTTP/API 调试、WSL、Docker exec、Kubernetes exec 等能力。

但必须从第一天就遵守这几个边界：

```text
1. 核心模型叫 Connection，不叫 SSH。
2. 终端能力抽象为 TerminalConnection。
3. 文件传输能力抽象为 FileTransferConnection。
4. 不同协议通过 ProtocolBackend 适配。
5. 不同功能通过 ConnectionCapabilities 控制。
6. SSH/SFTP 是第一阶段实现，不是架构边界。
7. Secret 永远不进入前端。
8. 大文件永远不经过前端内存。
9. Telnet、Raw TCP 等明文协议必须明确提示风险。
10. HTTP/API 调试是短请求/响应模型，不复用 TerminalSession，也不通过 Raw TCP 手写 HTTP。
11. 第一版聚焦 SSH/SFTP，把核心体验打磨稳定。
```

最终推荐路线：

```text
v0.1 SSH Terminal
v0.2 Profile + Security
v0.3 SFTP
v0.4 Tabs + Split + Theme + Keymap
v0.5 Serial
v0.6 Telnet
v0.7 Raw TCP
v0.8 Local Shell / WSL
v0.9 HTTP/API 调试
v1.0 Stable Release
```

Portiva 的核心竞争力不是“支持很多协议”本身，而是：

```text
统一的连接体验
稳定的终端体验
可靠的文件传输
清晰的安全边界
可扩展的协议架构
```

