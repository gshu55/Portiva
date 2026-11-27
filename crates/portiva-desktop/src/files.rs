use crate::{jobs, theme::*};
use gpui_kit::assets::IconName;
use gpui_kit::component::{
    Disableable, Icon,
    input::{Input, InputEvent, InputState},
};
use gpui_kit::{prelude::*, *};
use portiva_core::{Client, DirectoryListing, FileEntry, FileKind, SessionId};
use std::{collections::BTreeSet, path::PathBuf};

fn entry_icon(entry: &FileEntry) -> IconName {
    match entry.kind {
        FileKind::Directory => return IconName::Folder,
        FileKind::Symlink => return IconName::FileSymlink,
        FileKind::Other => return IconName::FileQuestionMark,
        FileKind::File => {}
    }
    let extension = entry
        .name
        .rsplit_once('.')
        .map(|(_, extension)| extension.to_ascii_lowercase());
    match extension.as_deref() {
        Some("png" | "jpg" | "jpeg" | "gif" | "webp" | "bmp" | "svg" | "ico" | "avif") => {
            IconName::FileImage
        }
        Some("zip" | "gz" | "tgz" | "tar" | "bz2" | "xz" | "7z" | "rar" | "zst") => {
            IconName::FileArchive
        }
        Some("mp3" | "wav" | "flac" | "ogg" | "m4a" | "aac") => IconName::FileMusic,
        Some("mp4" | "mkv" | "mov" | "avi" | "webm" | "m4v") => IconName::FileVideoCamera,
        Some("sh" | "bash" | "zsh" | "fish" | "ps1" | "bat" | "cmd") => IconName::FileTerminal,
        Some("json" | "yaml" | "yml" | "toml" | "ini" | "conf" | "cfg" | "env") => {
            IconName::FileCog
        }
        Some(
            "rs" | "js" | "jsx" | "ts" | "tsx" | "py" | "c" | "h" | "cpp" | "hpp" | "java" | "go"
            | "rb" | "php" | "html" | "css" | "scss" | "xml" | "sql" | "lua",
        ) => IconName::FileCode,
        Some("csv" | "tsv" | "xls" | "xlsx" | "ods") => IconName::FileSpreadsheet,
        Some("txt" | "md" | "log" | "rst" | "pdf" | "doc" | "docx" | "rtf") => IconName::FileText,
        _ => IconName::File,
    }
}

#[derive(Clone)]
pub enum FileAction {
    Transfer {
        entries: Vec<FileEntry>,
        remote: bool,
    },
    Upload {
        directory: bool,
        parent: String,
    },
    CreateDirectory {
        parent: String,
    },
    Rename {
        entry: FileEntry,
    },
    Delete {
        entries: Vec<FileEntry>,
    },
}

pub struct FilePane {
    client: Client,
    runtime: tokio::runtime::Handle,
    session: Option<SessionId>,
    pub path: String,
    entries: Vec<FileEntry>,
    selected: BTreeSet<usize>,
    anchor: usize,
    input: Entity<InputState>,
    loading: bool,
    generation: u64,
    error: Option<String>,
    _subscription: Subscription,
}
impl EventEmitter<FileAction> for FilePane {}
impl FilePane {
    pub fn new(
        client: Client,
        runtime: tokio::runtime::Handle,
        session: Option<SessionId>,
        path: String,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Self {
        let input = cx.new(|cx| {
            InputState::new(window, cx)
                .placeholder("输入目录路径并回车")
                .default_value(path.clone())
        });
        let subscription = cx.subscribe_in(&input, window, |view, _, event, window, cx| {
            if matches!(event, InputEvent::PressEnter { .. }) {
                let path = view.input.read(cx).value().to_string();
                view.load(path, window, cx);
            }
        });
        let mut view = Self {
            client,
            runtime,
            session,
            path,
            entries: Vec::new(),
            selected: BTreeSet::new(),
            anchor: 0,
            input,
            loading: false,
            generation: 0,
            error: None,
            _subscription: subscription,
        };
        view.refresh(window, cx);
        view
    }
    pub fn refresh(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.load(self.path.clone(), window, cx);
    }
    fn load(&mut self, path: String, window: &mut Window, cx: &mut Context<Self>) {
        self.generation += 1;
        let generation = self.generation;
        self.loading = true;
        self.error = None;
        let client = self.client.clone();
        let session = self.session;
        jobs::run(
            &self.runtime,
            window,
            cx,
            async move {
                if let Some(id) = session {
                    client.list_remote(id, &path).await
                } else {
                    client.list_local(PathBuf::from(path)).await
                }
            },
            move |view, result, window, cx| {
                if view.generation != generation {
                    return;
                }
                view.loading = false;
                match result {
                    Ok(DirectoryListing { path, entries }) => {
                        view.path = path.clone();
                        view.entries = entries;
                        view.selected.clear();
                        view.input
                            .update(cx, |state, cx| state.set_value(path, window, cx));
                    }
                    Err(e) => view.error = Some(format!("{e:#}")),
                }
                cx.notify();
            },
        );
        cx.notify();
    }
    fn up(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let path = if self.session.is_some() {
            self.path
                .trim_end_matches('/')
                .rsplit_once('/')
                .map(|(p, _)| {
                    if p.is_empty() {
                        "/".to_string()
                    } else {
                        p.into()
                    }
                })
                .unwrap_or_else(|| "/".into())
        } else {
            PathBuf::from(&self.path)
                .parent()
                .map(|p| p.to_string_lossy().into_owned())
                .unwrap_or_else(|| self.path.clone())
        };
        self.load(path, window, cx);
    }
    fn choose_local(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let picker = rfd::AsyncFileDialog::new()
            .set_directory(self.path.clone())
            .pick_folder();
        jobs::run(
            &self.runtime,
            window,
            cx,
            async move {
                Ok(picker
                    .await
                    .map(|p| p.path().to_string_lossy().into_owned()))
            },
            |view, result, window, cx| {
                if let Ok(Some(path)) = result {
                    view.load(path, window, cx);
                }
            },
        );
    }
    fn chosen(&self) -> Vec<FileEntry> {
        self.selected
            .iter()
            .filter_map(|i| self.entries.get(*i).cloned())
            .collect()
    }
    fn transfer(&self, cx: &mut Context<Self>) {
        let entries = self.chosen();
        if !entries.is_empty() {
            cx.emit(FileAction::Transfer {
                entries,
                remote: self.session.is_some(),
            });
        }
    }
    fn select(
        &mut self,
        index: usize,
        event: &MouseDownEvent,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if self.loading {
            return;
        }
        if event.click_count == 2 {
            let entry = self.entries[index].clone();
            if entry.kind == FileKind::Directory {
                self.load(entry.path, window, cx);
            } else if entry.kind == FileKind::File {
                cx.emit(FileAction::Transfer {
                    entries: vec![entry],
                    remote: self.session.is_some(),
                });
            }
            return;
        }
        if event.modifiers.shift {
            let start = self.anchor.min(index);
            let end = self.anchor.max(index);
            self.selected.extend(start..=end);
        } else if event.modifiers.control || event.modifiers.platform {
            if !self.selected.remove(&index) {
                self.selected.insert(index);
            }
            self.anchor = index;
        } else {
            self.selected.clear();
            self.selected.insert(index);
            self.anchor = index;
        }
        cx.notify();
    }
}
impl Render for FilePane {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let remote = self.session.is_some();
        let empty = self.selected.is_empty();
        let one = self.selected.len() == 1;
        column()
            .size_full()
            .when(!background_enabled(cx), |el| el.bg(rgb(colors(cx).panel)))
            .child(
                row()
                    .w_full()
                    .px_3()
                    .h(px(30.))
                    .text_xs()
                    .text_color(rgb(colors(cx).muted))
                    .border_b_1()
                    .border_color(rgb(colors(cx).border))
                    .child(if remote {
                        "SFTP · 远端文件"
                    } else {
                        "LOCAL · 本地文件"
                    }),
            )
            .child(
                row()
                    .gap_1()
                    .p_2()
                    .child(
                        tool("up", IconName::ArrowUp, "返回上一级目录", false)
                            .on_click(cx.listener(|view, _, window, cx| view.up(window, cx))),
                    )
                    .child(div().flex_1().min_w_0().child(Input::new(&self.input)))
                    .child(
                        tool("refresh", IconName::RefreshCw, "刷新目录", false)
                            .disabled(self.loading)
                            .on_click(cx.listener(|view, _, window, cx| view.refresh(window, cx))),
                    ),
            )
            .child(
                row()
                    .gap_1()
                    .px_2()
                    .pb_2()
                    .when(remote, |el| {
                        el.child(
                            tool("upload", IconName::Upload, "选择文件上传", false)
                                .disabled(self.loading)
                                .on_click(cx.listener(|view, _, _, cx| {
                                    cx.emit(FileAction::Upload {
                                        directory: false,
                                        parent: view.path.clone(),
                                    })
                                })),
                        )
                        .child(
                            tool("upload-dir", IconName::FolderUp, "选择目录上传", false)
                                .disabled(self.loading)
                                .on_click(cx.listener(|view, _, _, cx| {
                                    cx.emit(FileAction::Upload {
                                        directory: true,
                                        parent: view.path.clone(),
                                    })
                                })),
                        )
                    })
                    .when(!remote, |el| {
                        el.child(
                            tool("choose-local", IconName::FolderOpen, "选择本地目录", false)
                                .disabled(self.loading)
                                .on_click(
                                    cx.listener(|view, _, window, cx| {
                                        view.choose_local(window, cx)
                                    }),
                                ),
                        )
                    })
                    .child(
                        tool(
                            "transfer",
                            if remote {
                                IconName::Download
                            } else {
                                IconName::Upload
                            },
                            if remote {
                                "下载选中项"
                            } else {
                                "上传选中项"
                            },
                            false,
                        )
                        .disabled(empty || self.loading)
                        .on_click(cx.listener(|view, _, _, cx| view.transfer(cx))),
                    )
                    .when(remote, |el| {
                        el.child(
                            tool("mkdir", IconName::FolderPlus, "新建远端目录", false)
                                .disabled(self.loading)
                                .on_click(cx.listener(|view, _, _, cx| {
                                    cx.emit(FileAction::CreateDirectory {
                                        parent: view.path.clone(),
                                    })
                                })),
                        )
                        .child(
                            tool("rename", IconName::Pencil, "重命名选中项", false)
                                .disabled(!one || self.loading)
                                .on_click(cx.listener(|view, _, _, cx| {
                                    if let Some(entry) = view.chosen().pop() {
                                        cx.emit(FileAction::Rename { entry });
                                    }
                                })),
                        )
                        .child(
                            tool("delete", IconName::Trash, "删除选中项", false)
                                .disabled(empty || self.loading)
                                .on_click(cx.listener(|view, _, _, cx| {
                                    cx.emit(FileAction::Delete {
                                        entries: view.chosen(),
                                    })
                                })),
                        )
                    }),
            )
            .child(
                row()
                    .h(px(24.))
                    .flex_shrink_0()
                    .px_3()
                    .text_xs()
                    .text_color(rgb(colors(cx).muted))
                    .child("Ctrl / Shift 多选 · 双击目录进入"),
            )
            .child(
                row()
                    .px_3()
                    .py_1()
                    .border_y_1()
                    .border_color(rgb(colors(cx).border))
                    .text_xs()
                    .text_color(rgb(colors(cx).muted))
                    .child(div().flex_1().child("名称"))
                    .child(div().w(px(78.)).text_right().child("大小")),
            )
            .child(
                uniform_list(
                    "files",
                    self.entries.len(),
                    cx.processor(|view, range: std::ops::Range<usize>, _window, cx| {
                        range
                            .map(|index| {
                                let entry = &view.entries[index];
                                row()
                                    .id(index)
                                    .w_full()
                                    .h(px(29.))
                                    .px_3()
                                    .gap_2()
                                    .cursor_pointer()
                                    .text_sm()
                                    .when(view.selected.contains(&index), |el| {
                                        el.bg(rgb(colors(cx).selection))
                                    })
                                    .hover(|style| style.bg(rgb(colors(cx).hover)))
                                    .child(
                                        Icon::new(entry_icon(entry))
                                            .size(px(16.))
                                            .flex_shrink_0()
                                            .text_color(rgb(
                                                if entry.kind == FileKind::Directory {
                                                    colors(cx).accent
                                                } else {
                                                    colors(cx).muted
                                                },
                                            )),
                                    )
                                    .child(div().flex_1().truncate().child(entry.name.clone()))
                                    .child(
                                        div()
                                            .w(px(78.))
                                            .text_right()
                                            .text_xs()
                                            .text_color(rgb(colors(cx).muted))
                                            .child(if entry.kind == FileKind::Directory {
                                                "—".into()
                                            } else {
                                                bytes(entry.size)
                                            }),
                                    )
                                    .on_mouse_down(
                                        MouseButton::Left,
                                        cx.listener(move |view, event, window, cx| {
                                            view.select(index, event, window, cx)
                                        }),
                                    )
                            })
                            .collect()
                    }),
                )
                .flex_1()
                .min_h_0(),
            )
            .when(
                self.entries.is_empty() && !self.loading && self.error.is_none(),
                |el| {
                    el.child(
                        div()
                            .p_4()
                            .text_color(rgb(colors(cx).muted))
                            .child("此目录为空"),
                    )
                },
            )
            .when_some(self.error.clone(), |el, error| {
                el.child(div().p_3().text_xs().text_color(rgb(0xe6a18e)).child(error))
            })
            .child(
                row()
                    .h(px(26.))
                    .px_3()
                    .text_xs()
                    .text_color(rgb(colors(cx).muted))
                    .border_t_1()
                    .border_color(rgb(colors(cx).border))
                    .child(if self.loading {
                        "正在读取目录…".into()
                    } else {
                        format!(
                            "{} 项 · 已选 {} 项",
                            self.entries.len(),
                            self.selected.len()
                        )
                    }),
            )
    }
}
