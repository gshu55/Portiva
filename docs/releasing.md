# 跨平台发布

版本号由根目录 `Cargo.toml` 的 `[workspace.package].version` 统一提供，两个 crate 和 `Cargo.lock` 必须同步。2.x 发布到 `gshu55/Portiva`，旧项目提交历史和 1.x 标签保留。

## 本地验证

```powershell
cargo fmt --all -- --check
cargo test --workspace --locked
.\build.cmd -Configuration Release
python scripts/package-release.py x86_64-pc-windows-msvc
```

Windows 构建仍只通过根目录 `build.cmd`，产品程序固定为 `dist/portiva2.exe`。ZIP 内也使用同名程序，不创建其他命名的 EXE。占用程序时先关闭后重试。

Linux 编译需要：

```sh
sudo apt-get install build-essential pkg-config clang cmake \
  libssl-dev libfontconfig1-dev libfreetype6-dev libx11-xcb-dev \
  libxcb1-dev libxcb-shape0-dev libxcb-xfixes0-dev \
  libxkbcommon-dev libxkbcommon-x11-dev libwayland-dev libvulkan-dev xauth
cargo build --release -p portiva-desktop --bin portiva2 --locked
python3 scripts/package-release.py x86_64-unknown-linux-gnu
```

ARM64 使用原生 ARM64 系统，目标参数改为 `aarch64-unknown-linux-gnu`。便携包需要与 `.deb` 相同的系统运行库，可查看 `scripts/package-release.py` 的 `Depends` 清单；图形驱动须由系统提供。官方 Linux 包以 Ubuntu 24.04 为基线。

macOS 使用 Apple Silicon、Xcode Command Line Tools 和 Rust 1.100.0，设置 `MACOSX_DEPLOYMENT_TARGET=13.0` 后构建，再执行 `python3 scripts/package-release.py aarch64-apple-darwin`。打包脚本生成 `.app`、校验架构和动态库、执行 ad-hoc 签名与验证，再生成和验证 DMG。

## GitHub Actions

`.github/workflows/release.yml` 使用 Windows x64、Linux AMD64、Linux ARM64 和 macOS ARM64 原生 Runner。每个平台核对版本、Rust host 和格式，执行工作区 Release 测试及产品优化构建，然后检查 PE / ELF / Mach-O 架构并打包。

在 Actions 中手动运行 **Release Portiva 2**，默认只构建；勾选 `publish` 后，四个平台全部通过才会发布。推送与 Cargo 版本匹配的 `v2.*` 标签也会触发发布。发布前先上传全部附件到草稿并校验完整文件集合和 SHA-256，最后公开并设为最新版本；已公开的版本不能被此流水线覆盖。

每个版本需提供 `docs/releases/v<版本>.md`。发布 job 原样沿用 v1.15.1 的 `latest.json`，防止旧版 Tauri 更新器误将独立的 Rust 客户端当作原位更新。2.x 的安装方式与数据兼容限制应在发布说明中明确。
