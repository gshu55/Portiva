#![cfg_attr(target_os = "windows", windows_subsystem = "windows")]
extern crate gpui_kit as gpui;

mod app;
mod connection;
mod files;
mod jobs;
mod settings;
mod terminal;
mod theme;
mod update;

use anyhow::Result;
use gpui_kit::*;
use portiva_core::{Client, Store};
use std::path::PathBuf;

fn main() -> Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env().unwrap_or_else(|_| "warn".into()),
        )
        .init();
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()?;
    let data = std::env::var_os("PORTIVA2_DATA_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            std::env::var_os("APPDATA")
                .or_else(|| std::env::var_os("HOME"))
                .map(PathBuf::from)
                .unwrap_or_else(std::env::temp_dir)
                .join("Portiva2")
        });
    let (client, events) = Client::new(Store::open(data)?);
    let handle = runtime.handle().clone();
    let shutdown = client.clone();
    let local_directory = std::env::var_os("USERPROFILE")
        .or_else(|| std::env::var_os("HOME"))
        .map(PathBuf::from)
        .unwrap_or_else(std::env::temp_dir);
    let open_local = std::env::args_os().any(|arg| arg == "--local-terminal");
    gpui_kit::application()
        .with_assets(app::assets::AppAssets)
        .run(move |cx| {
            gpui_kit::init(cx);
            theme::init(cx);
            let bounds = Bounds::centered(None, size(px(1280.), px(800.)), cx);
            gpui_kit::open_window(
                WindowOptions {
                    titlebar: Some(TitlebarOptions {
                        title: Some("Portiva 2 · SSH / SFTP".into()),
                        ..gpui_kit::component::TitleBar::title_bar_options()
                    }),
                    window_bounds: Some(WindowBounds::Windowed(bounds)),
                    window_min_size: Some(size(px(1000.), px(640.))),
                    ..gpui_kit::component::TitleBar::window_options()
                },
                cx,
                move |window, cx| {
                    cx.new(|cx| {
                        let mut view = app::Workbench::new(
                            client,
                            handle,
                            events,
                            local_directory,
                            window,
                            cx,
                        );
                        if open_local {
                            view.begin_local_terminal(window, cx);
                        }
                        view
                    })
                },
            )
            .expect("无法打开 Portiva 窗口");
            cx.on_window_closed(|cx, _| {
                if cx.windows().is_empty() {
                    cx.quit();
                }
            })
            .detach();
            cx.activate(true);
        });
    runtime.block_on(async {
        let _ = tokio::time::timeout(std::time::Duration::from_secs(5), shutdown.shutdown()).await;
    });
    runtime.shutdown_timeout(std::time::Duration::from_secs(2));
    Ok(())
}
