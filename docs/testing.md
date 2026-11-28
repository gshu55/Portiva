# 测试与验证

所有命令在仓库根目录执行。Windows 产品构建仍统一使用 `build.cmd`，交付路径固定为 `dist/portiva2.exe`，详见 [README](../README.md)。

## 常规检查

```sh
cargo fmt --all -- --check
cargo check --workspace --all-targets --locked
cargo test --workspace --locked
cargo clippy --workspace --all-targets --locked -- -D warnings
```

依赖已经缓存时，编译、测试和 Clippy 命令可添加 `--offline`。格式检查和 Clippy 需要对应工具链的 `rustfmt`、`clippy` 组件；常规安装可执行 `rustup component add rustfmt clippy`。

只验证无界面的核心库：

```sh
cargo test -p portiva-core --locked
```

截至 2026-11-28，Windows x64 的默认测试包含 66 项单元与回环协议测试：核心 53 项单测、4 项 SSH/SFTP 回环协议测试、2 项 SSH/X11 回环协议测试，桌面 7 项单测。本机没有 `cargo clippy` 启动入口，实际使用同一 Rust 1.100 工具链中的 `clippy-driver.exe` 作为 `RUSTC_WORKSPACE_WRAPPER` 完成静态检查。

Rustfmt、全目标 Clippy（`-D warnings`）及原生窗口回归均已通过；Linux AMD64 / ARM64、macOS ARM64 的原生 Release 构建及默认工作区测试由 [发布流水线](../.github/workflows/release.yml) 校验。真实图形服务及其他平台的验收范围见 [X11 转发](x11.md)。

## 覆盖范围

- 核心：主机信任与指纹变化、配置和凭据隔离/复用/替换/忘记、配置提交失败恢复原凭据、设置校验与自动保存合并、资源计数解析、本地 PTY、终端按键/鼠标协议与剪贴板事件、长粘贴、重排和滚动历史。
- 内容高亮：日志级别、HTML/C#/CSS 语法、命令和围栏切换、分批到达的 `tail` 输出、Unicode、长行、关闭开关、配色切换、ANSI / 真彩色和备用屏幕隔离。
- 回环协议：密码与私钥认证、错误密码拒绝、首次指纹确认和指纹变化拦截、多 PTY 输入输出及尺寸隔离、关闭通道后其余终端和 SFTP 继续工作、独立 exec 资源采样、文件操作、递归传输、4.2 MB 二进制校验、中文目录、空目录、冲突、暂停/取消和失败重试。
- 桌面单测：嵌套分屏关闭补位和最少保留一个终端、背景图、字体回退、任务标题更新与重置、文字批量排版。
- 更新：2.x 版本比较、预发布和降级拒绝、四平台附件和安装模式、源仓库与地址限制、缺失和重复附件、大小及 SHA-256 校验、真实本机 HTTP 下载流的损坏 / 截断拒绝、ZIP / TAR 固定路径提取与架构检查；原子替换及启动失败回滚脚本使用临时文件验证，不覆盖用户程序。
- X11：真实 SSH 的 `x11-req` 与服务器反向通道、屏幕号、分屏 cookie 隔离、本地 cookie 替换、跨连接和已撤销 cookie 拒绝、双向传输、断开清理、服务器拒绝及本机显示认证失败后 SSH/SFTP 继续可用。单测还覆盖大小端和分片握手、超长认证拒绝、并发限制、默认关闭的旧配置兼容与 Windows Job 生命周期。Unix 平台另有本地域套接字认证测试，尚未在本机执行。

默认测试使用临时目录与本机合成服务，不读取用户私钥，也不向真实系统凭据库写入数据。

## 系统凭据库

该测试默认忽略，需在正常的系统登录会话中单独启用。它创建并清除随机测试目录对应的合成凭据：

```sh
cargo test -p portiva-core --test native_keyring --locked -- --ignored
```

Windows 沙箱账户可能返回 `ERROR_NO_SUCH_LOGON_SESSION`；本机在真实 Windows 登录会话中已通过。此项不包含在上面的 66 项默认测试内。

## 原生窗口回归

```sh
cargo run -p portiva-desktop --example native_smoke --locked
```

该程序创建临时目录与本机协议服务，通过产品实际工作台验证：

- 左右/上下嵌套分屏、输入输出及焦点隔离、关闭分屏与最后一个终端守卫、SFTP 收起和模式切换。
- Tab / Shift+Tab / Ctrl+C 路由、默认与自定义复制粘贴快捷键、多行粘贴确认，并恢复测试前的剪贴板。
- 主题与背景处理、设置即时应用与自动保存、字体和快捷键校验、连续修改后关闭设置标签仍正确保存。
- 新建/编辑 SSH 和 SFTP 表单中的密码、私钥、Agent 逐帧反复切换，私钥路径保留与凭据状态重置。
- X11 开关逐帧显示/隐藏本机显示字段，认证切换保留 X11 配置，切到 SFTP 时关闭 X11。
- SSH / SFTP 连接、上传以及本地/远端双栏。

默认保留窗口 300 秒供人工检查。环境变量只影响该验证程序：

| 环境变量 | 用途 |
| --- | --- |
| `PORTIVA_SMOKE_SECONDS` | 调整窗口保留秒数，不延缓验证步骤 |
| `PORTIVA_SMOKE_HIGHLIGHT=0` | 关闭回归后的 `cat` / `tail` 合成日志及 HTML/C#/CSS 配色展示 |
| `PORTIVA_SMOKE_AUTH_ONLY=1` | 仅运行认证表单切换检查，随后自动退出 |
| `PORTIVA_SMOKE_UPDATE_ONLY=1` | 渲染关于 / 软件更新界面、验证活动会话阻止安装，随后访问真实 GitHub 检查更新并自动退出 |
| `PORTIVA_SMOKE_PREVIEW=1` | 验证 SFTP 默认收起、布局保存和恢复、连续设置与布局变化合并，再保留窗口预览；跳过剪贴板脚本 |

Windows 示例：

```powershell
$env:PORTIVA_SMOKE_SECONDS = '40'
$env:PORTIVA_SMOKE_HIGHLIGHT = '0'
cargo run -p portiva-desktop --example native_smoke --locked --offline
```

测试服务只绑定本机随机端口，文件服务仅访问它创建的临时目录。临时 Shell 只回显输入，资源通道返回合成计数器；这些检查不能代替真实 Shell 补全、真实 OpenSSH / SSH Agent、不同输入法以及 Vim/tmux/交互式全屏程序的联调。Linux 和 macOS Apple Silicon 的真实桌面、系统凭据库和远程图形窗口仍需实机验收。
