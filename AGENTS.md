# 构建与交付

- Windows 构建统一执行根目录 `build.cmd`（调用 `scripts/build.ps1`）；需要启动时加 `-Run`。
- 日常迭代默认 Debug，正式优化构建使用 `-Configuration Release`；依赖已缓存时可加 `-Offline`。
- 面向用户只交付固定路径 `dist/portiva2.exe`，每次替换为最新版本。
- 不新增 `settings`、`preview`、日期或版本后缀的可执行文件，不为绕过文件占用临时增加 Cargo bin 或复制改名。
- 程序占用导致无法覆盖时，保留现有产物并说明需要关闭后重试；不要自动结束可能仍有 SSH 会话的进程。
- `target` 是 Cargo 缓存；`native_smoke` 是独立的临时验证程序，均不作为交付目录。
