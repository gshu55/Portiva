use crate::{jobs, theme::*};
use gpui_kit::{
    component::{Disableable, button::ButtonVariants},
    prelude::*,
    *,
};
use portiva_core::update::{
    AvailableUpdate, DownloadProgress, DownloadedUpdate, GithubUpdater, InstallAction,
    RELEASES_URL, last_install_error,
};
use std::{path::PathBuf, time::Duration};

pub enum UpdateEvent {
    InstallRequested,
}

pub struct UpdateView {
    runtime: tokio::runtime::Handle,
    data: PathBuf,
    latest: Option<AvailableUpdate>,
    downloaded: Option<DownloadedUpdate>,
    pub(crate) checking: bool,
    downloading: bool,
    progress: DownloadProgress,
    message: String,
    pub(crate) error: Option<String>,
}

impl EventEmitter<UpdateEvent> for UpdateView {}

impl UpdateView {
    pub fn new(runtime: tokio::runtime::Handle, data: PathBuf) -> Self {
        let error = last_install_error(&data);
        Self {
            runtime,
            data,
            latest: None,
            downloaded: None,
            checking: false,
            downloading: false,
            progress: DownloadProgress::default(),
            message: "检查 GitHub Releases 中的 2.x 稳定版本".into(),
            error,
        }
    }

    pub(crate) fn check(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.checking || self.downloading {
            return;
        }
        self.checking = true;
        self.error = None;
        self.message = "正在检查 GitHub…".into();
        jobs::run(
            &self.runtime,
            window,
            cx,
            async {
                tokio::time::timeout(Duration::from_secs(60), GithubUpdater::new()?.check()).await?
            },
            |view, result, _, cx| {
                view.checking = false;
                match result {
                    Ok(update) => {
                        view.message = update.as_ref().map_or_else(
                            || "当前已是最新的 2.x 稳定版本".into(),
                            |update| {
                                format!("发现新版本 {} · {}", update.version, bytes(update.size()))
                            },
                        );
                        view.latest = update;
                        view.downloaded = None;
                    }
                    Err(error) => view.error = Some(format!("{error:#}")),
                }
                cx.notify();
            },
        );
        cx.notify();
    }

    fn download(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.checking || self.downloading {
            return;
        }
        let Some(update) = self.latest.clone() else {
            return;
        };
        self.downloading = true;
        self.error = None;
        self.progress = DownloadProgress {
            downloaded: 0,
            total: update.size(),
        };
        let data = self.data.clone();
        let (progress, mut receiver) = tokio::sync::watch::channel(self.progress);
        cx.spawn_in(window, async move |view, cx| {
            while receiver.changed().await.is_ok() {
                let progress = *receiver.borrow_and_update();
                if cx
                    .update(|_, cx| {
                        view.update(cx, |view, cx| {
                            view.progress = progress;
                            cx.notify();
                        })
                    })
                    .is_err()
                {
                    break;
                }
            }
        })
        .detach();
        jobs::run(
            &self.runtime,
            window,
            cx,
            async move {
                tokio::time::timeout(
                    Duration::from_secs(15 * 60),
                    GithubUpdater::new()?.download(update, data, progress),
                )
                .await?
            },
            |view, result, _, cx| {
                view.downloading = false;
                match result {
                    Ok(downloaded) => {
                        view.message = format!("{} 已下载，SHA-256 校验通过", downloaded.version);
                        view.downloaded = Some(downloaded);
                    }
                    Err(error) => view.error = Some(format!("{error:#}")),
                }
                cx.notify();
            },
        );
        cx.notify();
    }

    pub fn install(&mut self, cx: &mut Context<Self>) -> bool {
        let Some(update) = self.downloaded.take() else {
            return false;
        };
        match update.install() {
            Ok(InstallAction::Restart) => true,
            Ok(InstallAction::OpenedPackage) => {
                self.message = "已打开安装包。完成系统安装或替换应用后，重新启动 Portiva。".into();
                cx.notify();
                false
            }
            Err(error) => {
                self.set_error(format!("{error:#}"), cx);
                false
            }
        }
    }

    pub fn set_error(&mut self, error: String, cx: &mut Context<Self>) {
        self.error = Some(error);
        cx.notify();
    }
}

impl Render for UpdateView {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let c = colors(cx);
        let busy = self.checking || self.downloading;
        column()
            .gap_3()
            .child(div().font_weight(FontWeight::SEMIBOLD).child("软件更新"))
            .child(
                div()
                    .text_xs()
                    .text_color(rgb(c.muted))
                    .child("更新源：GitHub · gshu55/Portiva"),
            )
            .child(if self.downloading {
                format!(
                    "正在下载：{} / {}（{}%）",
                    bytes(self.progress.downloaded),
                    bytes(self.progress.total),
                    self.progress
                        .downloaded
                        .saturating_mul(100)
                        .checked_div(self.progress.total)
                        .unwrap_or(0)
                )
            } else {
                self.message.clone()
            })
            .when_some(self.error.clone(), |view, error| {
                view.child(div().text_xs().text_color(rgb(0xe87979)).child(error))
            })
            .when_some(self.downloaded.as_ref(), |view, update| {
                view.child(div().text_xs().text_color(rgb(c.muted)).child(
                    if update.requires_restart() {
                        "先关闭所有 SSH / 本地终端和传输，再安装并重启。更新失败时会保留原程序。"
                            .to_owned()
                    } else if cfg!(target_os = "macos") {
                        "打开 DMG，将 Portiva.app 拖入“应用程序”并替换，完成后重新启动。".to_owned()
                    } else {
                        "使用系统软件安装器完成 .deb 更新，再重新启动 Portiva。".to_owned()
                    },
                ))
                .child(
                    div()
                        .text_xs()
                        .text_color(rgb(c.muted))
                        .child(format!("下载位置：{}", update.path().display())),
                )
            })
            .child(
                row()
                    .gap_2()
                    .child(
                        button(
                            "check-github-update",
                            if self.checking {
                                "检查中…"
                            } else {
                                "检查更新"
                            },
                        )
                        .disabled(busy)
                        .on_click(cx.listener(|view, _, window, cx| view.check(window, cx))),
                    )
                    .when(self.latest.is_some() && self.downloaded.is_none(), |row| {
                        row.child(
                            button(
                                "download-github-update",
                                if self.downloading {
                                    "下载中…"
                                } else {
                                    "下载更新"
                                },
                            )
                            .primary()
                            .disabled(busy)
                            .on_click(cx.listener(|view, _, window, cx| view.download(window, cx))),
                        )
                    })
                    .when_some(self.downloaded.as_ref(), |row, update| {
                        row.child(
                            button(
                                "install-github-update",
                                if update.requires_restart() {
                                    "安装并重启"
                                } else {
                                    "打开安装包"
                                },
                            )
                            .primary()
                            .disabled(busy)
                            .on_click(
                                cx.listener(|_, _, _, cx| cx.emit(UpdateEvent::InstallRequested)),
                            ),
                        )
                    })
                    .child(
                        button("github-releases", "版本说明")
                            .on_click(|_, _, cx| cx.open_url(RELEASES_URL)),
                    ),
            )
            .when_some(self.latest.as_ref(), |view, update| {
                view.child(
                    div()
                        .text_xs()
                        .text_color(rgb(c.muted))
                        .child(update.notes.lines().take(12).collect::<Vec<_>>().join("\n")),
                )
            })
    }
}
