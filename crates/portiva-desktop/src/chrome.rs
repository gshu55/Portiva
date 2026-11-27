use super::*;
use gpui_kit::{
    assets::IconName,
    component::{Icon, Sizable, TitleBar, button::Button, tooltip::Tooltip},
};

const TAB_WIDTH: f32 = 208.;
const COMPACT_TAB_WIDTH: f32 = 44.;
const TAB_GAP: f32 = 4.;
// Four 28px buttons, three gaps, padding and the left border.
const TOOLBAR_WIDTH: f32 = 4. * 28. + 3. * 6. + 2. * 12. + 1.;

impl Workbench {
    pub(crate) fn session_title(&self, id: SessionId, cx: &App) -> Option<String> {
        let tab = self.tab(id)?;
        let connection = tab.title();
        if tab.state == ConnectionState::Ready
            && let Some(terminal) = tab.active_terminal()
        {
            let terminal = terminal.read(cx);
            if terminal.status.is_none()
                && let Some(title) = terminal_task_title(&terminal.title, &tab.profile)
            {
                return Some(title.to_owned());
            }
        }
        Some(connection)
    }

    pub(super) fn reveal_active_tab(&self) {
        let index = if self.settings_active {
            self.tabs.len() + 1
        } else if self.home_active {
            0
        } else {
            self.active
                .and_then(|id| self.tabs.iter().position(|tab| tab.id == id))
                .map_or(0, |index| index + 1)
        };
        self.tabs_scroll.scroll_to_item(index);
    }

    fn chrome_blocked(&self, cx: &App) -> bool {
        self.form.is_some()
            || !self.prompts.is_empty()
            || self
                .active_terminal()
                .is_some_and(|v| v.read(cx).has_pending_paste())
    }

    fn show_home(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.home_active = true;
        self.settings_active = false;
        self.reveal_active_tab();
        window.focus(&self.workspace_focus, cx);
        cx.notify();
    }

    pub(crate) fn select_session(
        &mut self,
        id: SessionId,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.home_active = false;
        self.settings_active = false;
        self.active = Some(id);
        self.reveal_active_tab();
        self.restore_terminal_focus(window, cx);
        cx.notify();
    }

    pub(crate) fn close_settings(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.settings_view = None;
        self.settings_subscription = None;
        if self.settings_active {
            self.settings_active = false;
            self.home_active = self.active.is_none();
            self.restore_terminal_focus(window, cx);
        }
        self.reveal_active_tab();
        cx.notify();
    }

    pub(super) fn render_titlebar(
        &self,
        window: &Window,
        cx: &mut Context<Self>,
    ) -> impl IntoElement {
        let c = colors(cx);
        let blocked = self.chrome_blocked(cx);
        // TitleBar's internal content row does not shrink. Bound our row to the
        // viewport so overflowing tabs cannot push the toolbar/window buttons out.
        let reserved = if cfg!(target_os = "macos") { 80. } else { 107. };
        let content_width = (window.viewport_size().width - px(reserved)).max(px(0.));
        let tab_count = self.tabs.len() + 1 + usize::from(self.settings_view.is_some());
        let tabs_width = (content_width - px(TOOLBAR_WIDTH + TAB_GAP)).max(px(0.));
        let compact =
            px(tab_count as f32 * TAB_WIDTH + tab_count.saturating_sub(1) as f32 * TAB_GAP)
                > tabs_width;
        TitleBar::new()
            .h(px(44.))
            .pl(px(if cfg!(target_os = "macos") { 80. } else { 5. }))
            .bg(panel(cx))
            .border_color(rgb(c.border))
            .child(
                row()
                    .w(content_width)
                    .min_w_0()
                    .h_full()
                    .gap(px(TAB_GAP))
                    .child(
                        row()
                            .id("titlebar-tabs")
                            .flex_1()
                            .h_full()
                            .gap(px(TAB_GAP))
                            .overflow_x_scroll()
                            .track_scroll(&self.tabs_scroll)
                            .child(
                                tab_chip(
                                    "hosts-tab",
                                    "主机概览".into(),
                                    IconName::Server,
                                    self.home_active,
                                    compact,
                                    cx,
                                )
                                .tooltip(|w, cx| Tooltip::new("主机概览").build(w, cx))
                                .on_mouse_down(MouseButton::Left, stop_tab_drag)
                                .on_click(cx.listener(
                                    move |v, _, w, cx| {
                                        if !blocked {
                                            v.show_home(w, cx);
                                        }
                                    },
                                )),
                            )
                            .children(self.tabs.iter().map(|tab| {
                                let id = tab.id;
                                let selected = self.active == Some(id)
                                    && !self.settings_active
                                    && !self.home_active;
                                let icon = if tab.local_shell.is_some() {
                                    IconName::Monitor
                                } else if tab.profile.protocol == Protocol::Sftp {
                                    IconName::FolderOpen
                                } else {
                                    IconName::Terminal
                                };
                                let title =
                                    self.session_title(id, cx).unwrap_or_else(|| tab.title());
                                let description = if tab.local_shell.is_some() {
                                    format!("{title}\n{}", tab.title())
                                } else {
                                    format!(
                                        "{title}\n主机：{}\n{}@{}:{}",
                                        tab.profile.title(),
                                        tab.profile.username,
                                        tab.profile.host,
                                        tab.profile.port
                                    )
                                };
                                tab_chip(
                                    ("session-tab", id.as_u128() as u64),
                                    title,
                                    icon,
                                    selected,
                                    compact,
                                    cx,
                                )
                                .tooltip(move |w, cx| {
                                    Tooltip::new(description.clone()).build(w, cx)
                                })
                                .when(selected, |el| {
                                    el.child(
                                        tab_close(("close-session", id.as_u128() as u64))
                                            .disabled(blocked)
                                            .on_click(cx.listener(move |v, _, w, cx| {
                                                cx.stop_propagation();
                                                v.close_tab(id, w, cx);
                                            })),
                                    )
                                })
                                .on_mouse_down(MouseButton::Left, stop_tab_drag)
                                .on_mouse_down(
                                    MouseButton::Middle,
                                    cx.listener(move |v, _, w, cx| {
                                        w.prevent_default();
                                        cx.stop_propagation();
                                        if !blocked {
                                            v.close_tab(id, w, cx);
                                        }
                                    }),
                                )
                                .on_click(cx.listener(
                                    move |v, _, w, cx| {
                                        if !blocked {
                                            v.select_session(id, w, cx);
                                        }
                                    },
                                ))
                            }))
                            .when(self.settings_view.is_some(), |el| {
                                el.child(
                                    tab_chip(
                                        "settings-tab",
                                        if self.settings_save_error.is_some() {
                                            "设置 · 保存失败".into()
                                        } else {
                                            "设置".into()
                                        },
                                        IconName::Settings,
                                        self.settings_active,
                                        compact,
                                        cx,
                                    )
                                    .tooltip(|w, cx| Tooltip::new("设置").build(w, cx))
                                    .when(self.settings_active, |el| {
                                        el.child(
                                            tab_close("close-settings-tab")
                                                .disabled(blocked)
                                                .on_click(cx.listener(|v, _, w, cx| {
                                                    cx.stop_propagation();
                                                    v.close_settings(w, cx);
                                                })),
                                        )
                                    })
                                    .on_mouse_down(MouseButton::Left, stop_tab_drag)
                                    .on_mouse_down(
                                        MouseButton::Middle,
                                        cx.listener(move |v, _, w, cx| {
                                            w.prevent_default();
                                            cx.stop_propagation();
                                            if !blocked {
                                                v.close_settings(w, cx);
                                            }
                                        }),
                                    )
                                    .on_click(cx.listener(
                                        move |v, _, w, cx| {
                                            if !blocked {
                                                v.open_settings(w, cx);
                                            }
                                        },
                                    )),
                                )
                            }),
                    )
                    .child(
                        row()
                            .h_full()
                            .w(px(TOOLBAR_WIDTH))
                            .occlude()
                            .on_mouse_down(MouseButton::Left, stop_tab_drag)
                            .gap(px(6.))
                            .px(px(12.))
                            .flex_shrink_0()
                            .border_l_1()
                            .border_color(rgb(c.border))
                            .child(
                                tool(
                                    "toolbar-hosts",
                                    IconName::Server,
                                    "主机概览",
                                    self.home_active,
                                )
                                .disabled(blocked)
                                .on_click(cx.listener(|v, _, w, cx| v.show_home(w, cx))),
                            )
                            .child(
                                tool("toolbar-new", IconName::Plus, "新建连接", false)
                                    .disabled(blocked)
                                    .on_click(cx.listener(|v, _, w, cx| {
                                        v.open_form(Profile::default(), w, cx)
                                    })),
                            )
                            .child(
                                tool("toolbar-local", IconName::Terminal, "打开本地终端", false)
                                    .disabled(blocked)
                                    .on_click(cx.listener(|v, _, w, cx| {
                                        v.begin_local_terminal(w, cx);
                                    })),
                            )
                            .child(
                                tool(
                                    "toolbar-settings",
                                    IconName::Settings,
                                    if self.settings_save_error.is_some() {
                                        "设置（自动保存失败）"
                                    } else {
                                        "设置"
                                    },
                                    self.settings_active,
                                )
                                .when(self.settings_save_error.is_some(), |button| {
                                    button.text_color(rgb(0xe87979))
                                })
                                .disabled(blocked)
                                .on_click(cx.listener(|v, _, w, cx| v.open_settings(w, cx))),
                            ),
                    ),
            )
    }

    pub(super) fn render_hosts(&self, cx: &mut Context<Self>) -> AnyElement {
        let c = colors(cx);
        let blocked = self.chrome_blocked(cx);
        div()
            .id("hosts-scroll")
            .size_full()
            .overflow_y_scroll()
            .p_8()
            .child(
                column()
                    .max_w(px(980.))
                    .mx_auto()
                    .gap_5()
                    .child(
                        column()
                            .gap_1()
                            .child(
                                div()
                                    .text_size(px(22.))
                                    .font_weight(FontWeight::SEMIBOLD)
                                    .child("主机概览"),
                            )
                            .child(
                                div()
                                    .text_color(rgb(c.muted))
                                    .child("点击已保存的主机直接连接；顶部 + 号可添加连接。"),
                            ),
                    )
                    .when(self.notice_error, |el| {
                        el.child(div().text_color(rgb(0xe87979)).child(self.notice.clone()))
                    })
                    .child(
                        row()
                            .gap_2()
                            .child(
                                div()
                                    .font_weight(FontWeight::SEMIBOLD)
                                    .child("已保存的连接"),
                            )
                            .child(
                                div()
                                    .text_xs()
                                    .text_color(rgb(c.muted))
                                    .child(self.profiles.len().to_string()),
                            ),
                    )
                    .when(self.profiles.is_empty(), |el| {
                        el.child(
                            column()
                                .p_8()
                                .gap_3()
                                .items_center()
                                .rounded_lg()
                                .border_1()
                                .border_color(rgb(c.border))
                                .bg(panel(cx))
                                .child(
                                    Icon::new(IconName::Server)
                                        .size(px(32.))
                                        .text_color(rgb(c.muted)),
                                )
                                .child("还没有保存的连接")
                                .child(
                                    div()
                                        .text_xs()
                                        .text_color(rgb(c.muted))
                                        .child("点击顶部 + 号，添加 SSH 或 SFTP 连接。"),
                                ),
                        )
                    })
                    .children(self.profiles.iter().map(|profile| {
                        let profile = profile.clone();
                        let edit_profile = profile.clone();
                        row()
                            .id(SharedString::from(format!("saved-host-{}", profile.id)))
                            .p_4()
                            .gap_4()
                            .rounded_lg()
                            .border_1()
                            .border_color(rgb(c.border))
                            .bg(panel(cx))
                            .cursor_pointer()
                            .hover(move |s| s.bg(rgb(c.hover)).border_color(rgb(c.accent)))
                            .child(
                                Icon::new(if profile.protocol == Protocol::Ssh {
                                    IconName::Terminal
                                } else {
                                    IconName::FolderOpen
                                })
                                .size(px(20.))
                                .text_color(rgb(c.accent)),
                            )
                            .child(
                                column()
                                    .gap_1()
                                    .flex_1()
                                    .child(
                                        div()
                                            .font_weight(FontWeight::SEMIBOLD)
                                            .child(profile.title()),
                                    )
                                    .child(div().text_xs().text_color(rgb(c.muted)).child(
                                        format!(
                                            "{}@{}:{}",
                                            profile.username, profile.host, profile.port
                                        ),
                                    )),
                            )
                            .child(
                                div()
                                    .text_xs()
                                    .text_color(rgb(c.muted))
                                    .child(protocol_label(&profile.protocol)),
                            )
                            .child(
                                tool("edit-saved-host", IconName::Pencil, "编辑连接", false)
                                    .disabled(blocked)
                                    .on_click(cx.listener(move |v, _, w, cx| {
                                        cx.stop_propagation();
                                        v.open_form(edit_profile.clone(), w, cx);
                                    })),
                            )
                            .on_click(cx.listener(move |v, _, w, cx| {
                                if !blocked {
                                    v.begin_connection(
                                        profile.clone(),
                                        Credentials::default(),
                                        w,
                                        cx,
                                    );
                                }
                            }))
                    })),
            )
            .into_any_element()
    }
}

fn terminal_task_title<'a>(title: &'a str, profile: &Profile) -> Option<&'a str> {
    let title = title.trim();
    let path = title.starts_with(['/', '\\'])
        || title.starts_with("~/")
        || title.starts_with("~\\")
        || title
            .as_bytes()
            .get(1..3)
            .is_some_and(|suffix| matches!(suffix, b":/" | b":\\"));
    let login = title.split_once('@').is_some_and(|(user, host)| {
        !user.is_empty()
            && !user.chars().any(char::is_whitespace)
            && !host.is_empty()
            && !host.chars().any(char::is_whitespace)
    });
    let shell = title
        .split(|c: char| c.is_whitespace() || matches!(c, '/' | '\\' | ':' | '|' | '-' | '—'))
        .any(|part| {
            matches!(
                part.to_ascii_lowercase().trim_end_matches(".exe"),
                "bash" | "cmd" | "fish" | "nu" | "powershell" | "pwsh" | "sh" | "zsh"
            )
        });
    (!title.is_empty()
        && !path
        && !login
        && !shell
        && !title.eq_ignore_ascii_case(&profile.title())
        && !title.eq_ignore_ascii_case(&profile.host))
    .then_some(title)
}

fn stop_tab_drag(_: &MouseDownEvent, w: &mut Window, cx: &mut App) {
    w.prevent_default();
    cx.stop_propagation();
}

fn tab_chip(
    id: impl Into<ElementId>,
    title: String,
    icon: IconName,
    selected: bool,
    compact: bool,
    cx: &App,
) -> Stateful<Div> {
    let c = colors(cx);
    let expanded = selected || !compact;
    row()
        .id(id)
        .block_mouse_except_scroll()
        .h(px(36.))
        .w(px(if expanded {
            TAB_WIDTH
        } else {
            COMPACT_TAB_WIDTH
        }))
        .flex_shrink_0()
        .px(px(12.))
        .gap_2()
        .rounded_md()
        .cursor_pointer()
        .hover(move |s| s.bg(rgb(if selected { c.accent } else { c.hover })))
        .when(selected, |el| {
            el.bg(rgb(c.accent)).text_color(rgb(0xffffff))
        })
        .child(Icon::new(icon).size(px(16.)).flex_shrink_0())
        .when(expanded, |el| {
            el.child(div().flex_1().truncate().child(title))
        })
}

fn tab_close(id: impl Into<ElementId>) -> Button {
    Button::new(id)
        .icon(IconName::X)
        .ghost()
        .small()
        .size(px(20.))
        .text_color(rgb(0xffffff))
        .accessibility_label("关闭标签")
        .tooltip("关闭标签")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[::core::prelude::v1::test]
    fn task_titles_distinguish_foreground_tools_from_shell_defaults() {
        let profile = Profile {
            name: "开发机".into(),
            host: "server.local".into(),
            ..Default::default()
        };
        for title in [
            "",
            "开发机",
            "SERVER.LOCAL",
            "demo@server.local:~/repo",
            "/home/demo",
            r"C:\work",
            "~/repo",
            "bash",
            "Windows PowerShell",
            "zsh: ~/repo",
        ] {
            assert_eq!(
                terminal_task_title(title, &profile),
                None,
                "default title {title}"
            );
        }
        for title in [
            "Claude Code · 修复登录",
            "Codex CLI",
            "vim README.md",
            "cargo build",
            "Claude 👩‍💻",
        ] {
            assert_eq!(terminal_task_title(title, &profile), Some(title));
        }
    }
}
