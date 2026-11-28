#!/usr/bin/env python3
"""Package an already-built native release, using only Python's standard library."""

import argparse
import os
from pathlib import Path
import plistlib
import shutil
import struct
import subprocess
import sys
import tarfile
import tempfile
import tomllib
import zipfile


ROOT = Path(__file__).resolve().parent.parent
TARGETS = {
    "x86_64-pc-windows-msvc": ("windows", "x64"),
    "x86_64-unknown-linux-gnu": ("linux", "amd64"),
    "aarch64-unknown-linux-gnu": ("linux", "arm64"),
    "aarch64-apple-darwin": ("macos", "arm64"),
}


def run(*args):
    try:
        return subprocess.run(args, cwd=ROOT, check=True, text=True, capture_output=True).stdout
    except subprocess.CalledProcessError as error:
        print(error.stdout, file=sys.stderr)
        print(error.stderr, file=sys.stderr)
        raise


def verify_binary(binary, system, architecture):
    with binary.open("rb") as stream:
        header = stream.read(64)
        if system == "windows":
            assert header[:2] == b"MZ", "Expected a Windows executable"
            stream.seek(struct.unpack_from("<I", header, 60)[0])
            pe = stream.read(6)
            assert pe[:4] == b"PE\0\0" and struct.unpack_from("<H", pe, 4)[0] == 0x8664
        elif system == "linux":
            assert header[:6] == b"\x7fELF\x02\x01", "Expected a 64-bit ELF executable"
            assert struct.unpack_from("<H", header, 18)[0] == {"amd64": 62, "arm64": 183}[architecture]
            dependencies = run("ldd", str(binary))
            assert "not found" not in dependencies, dependencies
            print(dependencies)
        else:
            assert header[:4] == b"\xcf\xfa\xed\xfe", "Expected a 64-bit Mach-O executable"
            assert struct.unpack_from("<I", header, 4)[0] == 0x0100000C, "Expected Apple Silicon"
            dependencies = run("otool", "-L", str(binary))
            assert "/opt/homebrew/" not in dependencies and "/usr/local/" not in dependencies, dependencies
            print(dependencies)


def copy_docs(destination):
    destination.mkdir(parents=True, exist_ok=True)
    for name in ("README.md", "LICENSE"):
        shutil.copy2(ROOT / name, destination / name)


def package_windows(output, version):
    binary = ROOT / "dist" / "portiva2.exe"
    verify_binary(binary, "windows", "x64")
    archive = output / f"Portiva_{version}_windows_x64.zip"
    with zipfile.ZipFile(archive, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=9) as bundle:
        bundle.write(binary, "portiva2.exe")
        for name in ("README.md", "LICENSE"):
            bundle.write(ROOT / name, name)
    with zipfile.ZipFile(archive) as bundle:
        assert bundle.testzip() is None
        assert bundle.namelist() == ["portiva2.exe", "README.md", "LICENSE"]


def package_linux(output, version, architecture):
    binary = ROOT / "target" / "release" / "portiva2"
    verify_binary(binary, "linux", architecture)
    name = f"Portiva_{version}_linux_{architecture}"
    with tempfile.TemporaryDirectory(prefix="portiva-package-") as temporary:
        staging = Path(temporary)
        portable = staging / name
        copy_docs(portable)
        shutil.copy2(binary, portable / "portiva2")
        (portable / "portiva2").chmod(0o755)
        with tarfile.open(output / f"{name}.tar.gz", "w:gz") as bundle:
            bundle.add(portable, arcname=name)

        package = staging / "deb"
        (package / "DEBIAN").mkdir(parents=True)
        (package / "usr/bin").mkdir(parents=True)
        shutil.copy2(binary, package / "usr/bin/portiva2")
        (package / "usr/bin/portiva2").chmod(0o755)
        applications = package / "usr/share/applications"
        applications.mkdir(parents=True)
        shutil.copy2(ROOT / "packaging/portiva2.desktop", applications / "portiva2.desktop")
        icons = package / "usr/share/icons/hicolor/256x256/apps"
        icons.mkdir(parents=True)
        shutil.copy2(ROOT / "packaging/portiva.png", icons / "portiva2.png")
        copy_docs(package / "usr/share/doc/portiva2")
        installed_size = sum(path.stat().st_size for path in (package / "usr").rglob("*") if path.is_file()) // 1024
        dependencies = ", ".join([
            "libc6 (>= 2.39)", "libgcc-s1", "libstdc++6", "libssl3t64",
            "libfontconfig1", "libfreetype6", "libx11-6", "libx11-xcb1", "libxcb1",
            "libxcb-render0", "libxcb-shape0", "libxcb-xfixes0",
            "libxkbcommon0", "libxkbcommon-x11-0", "libwayland-client0", "libvulkan1",
        ])
        (package / "DEBIAN/control").write_text(
            f"Package: portiva2\nVersion: {version}\nArchitecture: {architecture}\n"
            "Section: net\nPriority: optional\nMaintainer: gshu <gshu55@users.noreply.github.com>\n"
            f"Installed-Size: {installed_size}\nDepends: {dependencies}\n"
            "Recommends: xdg-desktop-portal, xauth, fonts-noto-cjk\n"
            "Homepage: https://github.com/gshu55/Portiva\n"
            "Description: Native SSH and SFTP desktop workbench\n"
            " Rust and GPUI workbench with local terminals, split SSH sessions,\n"
            " file transfers, and optional X11 forwarding.\n",
            encoding="utf-8",
        )
        archive = output / f"{name}.deb"
        run("dpkg-deb", "--root-owner-group", "--build", str(package), str(archive))
        assert run("dpkg-deb", "--field", str(archive), "Architecture").strip() == architecture
        assert run("dpkg-deb", "--field", str(archive), "Version").strip() == version


def package_macos(output, version):
    binary = ROOT / "target" / "release" / "portiva2"
    verify_binary(binary, "macos", "arm64")
    with tempfile.TemporaryDirectory(prefix="portiva-package-") as temporary:
        staging = Path(temporary)
        app = staging / "Portiva.app"
        executable = app / "Contents/MacOS/portiva2"
        executable.parent.mkdir(parents=True)
        shutil.copy2(binary, executable)
        executable.chmod(0o755)
        resources = app / "Contents/Resources"
        copy_docs(resources)
        shutil.copy2(ROOT / "packaging/portiva.icns", resources / "portiva.icns")
        with (app / "Contents/Info.plist").open("wb") as stream:
            plistlib.dump({
                "CFBundleDevelopmentRegion": "zh_CN",
                "CFBundleDisplayName": "Portiva",
                "CFBundleExecutable": "portiva2",
                "CFBundleIconFile": "portiva.icns",
                "CFBundleIdentifier": "com.gs.portiva2",
                "CFBundleInfoDictionaryVersion": "6.0",
                "CFBundleName": "Portiva",
                "CFBundlePackageType": "APPL",
                "CFBundleShortVersionString": version,
                "CFBundleVersion": version,
                "LSMinimumSystemVersion": "13.0",
                "NSHighResolutionCapable": True,
                "NSPrincipalClass": "NSApplication",
                "NSSupportsAutomaticGraphicsSwitching": True,
            }, stream)
        run("codesign", "--force", "--deep", "--sign", "-", str(app))
        run("codesign", "--verify", "--deep", "--strict", str(app))
        with tarfile.open(output / f"Portiva_{version}_macos_arm64.app.tar.gz", "w:gz") as bundle:
            bundle.add(app, arcname="Portiva.app")
        (staging / "Applications").symlink_to("/Applications")
        image = output / f"Portiva_{version}_macos_arm64.dmg"
        run("hdiutil", "create", "-volname", f"Portiva {version}", "-srcfolder", str(staging), "-ov", "-format", "UDZO", str(image))
        print(run("hdiutil", "verify", str(image)))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("target", choices=TARGETS)
    parser.add_argument("--verify-only", action="store_true")
    args = parser.parse_args()
    version = tomllib.loads((ROOT / "Cargo.toml").read_text(encoding="utf-8"))["workspace"]["package"]["version"]
    assert version.startswith("2."), "This release workflow is for Portiva 2.x"
    reference = os.environ.get("GITHUB_REF", "")
    if reference.startswith("refs/tags/"):
        assert reference == f"refs/tags/v{version}", "Tag and Cargo version differ"
    host = next(line.removeprefix("host: ") for line in run("rustc", "-vV").splitlines() if line.startswith("host: "))
    assert host == args.target, f"Use a native runner: expected {args.target}, got {host}"
    assert (ROOT / f"docs/releases/v{version}.md").is_file(), "Release notes are missing"
    print(f"Verified Portiva {version}: {host}")
    if args.verify_only:
        return
    output = ROOT / "dist"
    output.mkdir(exist_ok=True)
    system, architecture = TARGETS[args.target]
    if system == "windows":
        package_windows(output, version)
    elif system == "linux":
        package_linux(output, version, architecture)
    else:
        package_macos(output, version)
    for path in sorted(output.glob(f"Portiva_{version}_*")):
        print(f"Packaged {path.name}: {path.stat().st_size} bytes")


if __name__ == "__main__":
    main()
