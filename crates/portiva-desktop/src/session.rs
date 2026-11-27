use super::*;
use gpui_kit::component::resizable::{h_resizable, resizable_panel, v_resizable};

impl Workbench {
    pub(crate) fn sftp_panel_state(&self, id: SessionId) -> Option<SftpPanelSettings> {
        self.tab(id).map(|tab| SftpPanelSettings {
            visible: tab.sftp_visible,
            left: tab.sftp_left,
            width: f32::from(tab.sftp_width).round().clamp(260., 1600.) as u16,
        })
    }

    fn remember_sftp_layout(&mut self, id: SessionId, window: &mut Window, cx: &mut Context<Self>) {
        let Some(layout) = self.sftp_panel_state(id) else {
            return;
        };
        let mut settings = self.settings.clone();
        settings.sftp_panel = layout;
        self.save_settings(settings, window, cx);
    }

    pub(crate) fn swap_sftp_side(
        &mut self,
        id: SessionId,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if let Some(tab) = self.tab_mut(id) {
            let remote_index = usize::from(!tab.sftp_left);
            if let Some(width) = tab.file_panels.read(cx).sizes().get(remote_index) {
                tab.sftp_width = *width;
            }
            tab.sftp_left = !tab.sftp_left;
            // ResizableState stores widths by slot; swapping must keep the SFTP width.
            tab.file_panels = cx.new(|_| ResizableState::default());
            self.remember_sftp_layout(id, window, cx);
            self.restore_terminal_focus(window, cx);
            cx.notify();
        }
    }

    pub(crate) fn toggle_sftp(
        &mut self,
        id: SessionId,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if let Some(tab) = self.tab_mut(id) {
            if tab.files_mode {
                return;
            }
            tab.sftp_visible = !tab.sftp_visible;
            self.remember_sftp_layout(id, window, cx);
            self.restore_terminal_focus(window, cx);
            cx.notify();
        }
    }

    pub(crate) fn toggle_files_mode(
        &mut self,
        id: SessionId,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let Some(tab) = self.tab_mut(id) else { return };
        if tab.opening_terminal {
            return;
        }
        // The terminal icon also opens/retries the first shell on an SFTP-only tab.
        let mode = if tab.terminals.is_empty() {
            false
        } else {
            !tab.files_mode
        };
        self.set_files_mode(id, mode, cx);
        if !mode && self.tab(id).is_some_and(|tab| tab.terminals.is_empty()) {
            self.open_shell(id, window, cx);
        }
        self.restore_terminal_focus(window, cx);
        cx.notify();
    }

    pub(super) fn render_terminal_layout(
        &self,
        tab: &SessionTab,
        layout: &TerminalLayout,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        match layout {
            TerminalLayout::Terminal(terminal_id) => {
                let terminal_id = *terminal_id;
                let id = tab.id;
                let terminal = tab
                    .terminals
                    .iter()
                    .find(|pane| pane.id == terminal_id)
                    .map(|pane| pane.view.clone());
                div()
                    .id(("terminal-pane", terminal_id.as_u128() as u64))
                    .size_full()
                    .min_w_0()
                    .min_h_0()
                    .overflow_hidden()
                    .on_mouse_down(
                        MouseButton::Left,
                        cx.listener(move |view, _, _, cx| {
                            if let Some(tab) = view.tab_mut(id)
                                && tab.active_terminal != Some(terminal_id)
                            {
                                tab.set_active_terminal(terminal_id, cx);
                                cx.notify();
                            }
                        }),
                    )
                    .on_mouse_down(
                        MouseButton::Right,
                        cx.listener(move |view, _, _, cx| {
                            if let Some(tab) = view.tab_mut(id)
                                && tab.active_terminal != Some(terminal_id)
                            {
                                tab.set_active_terminal(terminal_id, cx);
                                cx.notify();
                            }
                        }),
                    )
                    .children(terminal)
                    .into_any_element()
            }
            TerminalLayout::Split {
                id,
                direction,
                first,
                second,
            } => {
                let element_id = ("terminal-split", id.as_u128() as u64);
                let group = match direction {
                    SplitDirection::Columns => h_resizable(element_id),
                    SplitDirection::Rows => v_resizable(element_id),
                };
                group
                    .with_state(&tab.terminal_splits[id])
                    .child(
                        resizable_panel()
                            .size_range(px(80.)..Pixels::MAX)
                            .child(self.render_terminal_layout(tab, first, cx)),
                    )
                    .child(
                        resizable_panel()
                            .size_range(px(80.)..Pixels::MAX)
                            .child(self.render_terminal_layout(tab, second, cx)),
                    )
                    .into_any_element()
            }
        }
    }

    pub(super) fn render_session(&self, tab: &SessionTab, cx: &mut Context<Self>) -> AnyElement {
        if tab.local_shell.is_some() {
            return self.render_local_session(tab, cx);
        }
        let id = tab.id;
        let files_mode = tab.files_mode;
        let empty = tab.terminals.is_empty();
        let blocked = tab.opening_terminal
            || self
                .active_terminal()
                .is_some_and(|v| v.read(cx).has_pending_paste());
        let terminal_mode = !files_mode && !empty;
        let content = if files_mode {
            tab.local
                .clone()
                .map(|v| v.into_any_element())
                .unwrap_or_else(|| div().into_any_element())
        } else if let Some(layout) = &tab.layout {
            self.render_terminal_layout(tab, layout, cx)
        } else {
            div()
                .p_4()
                .text_color(rgb(colors(cx).muted))
                .child(if tab.opening_terminal {
                    "正在打开终端…"
                } else {
                    "终端未打开，点击顶部终端图标重试。"
                })
                .into_any_element()
        };
        let content = if files_mode || tab.sftp_visible {
            let main = resizable_panel()
                .size_range(px(160.)..Pixels::MAX)
                .child(content);
            let sftp = resizable_panel()
                .size(tab.sftp_width)
                .size_range(px(260.)..px(1600.))
                .fixed()
                .children(tab.remote.clone());
            let panels = if tab.sftp_left {
                [sftp, main]
            } else {
                [main, sftp]
            };
            h_resizable(("session-panels", id.as_u128() as u64))
                .with_state(&tab.file_panels)
                .on_resize(
                    cx.listener(move |view, state: &Entity<ResizableState>, window, cx| {
                        if let Some(tab) = view.tab_mut(id) {
                            let remote_index = usize::from(!tab.sftp_left);
                            if let Some(width) = state.read(cx).sizes().get(remote_index) {
                                tab.sftp_width = *width;
                            }
                        }
                        view.remember_sftp_layout(id, window, cx);
                    }),
                )
                .children(panels)
                .into_any_element()
        } else {
            content
        };
        let transfer_count = self
            .transfers
            .iter()
            .filter(|t| t.session_id == id && !t.status.finished())
            .count();
        column()
            .size_full()
            .child(
                row()
                    .h(px(42.))
                    .flex_shrink_0()
                    .px_3()
                    .gap_2()
                    .bg(panel(cx))
                    .border_b_1()
                    .border_color(rgb(colors(cx).border))
                    .child(div().text_color(rgb(colors(cx).accent)).child("●"))
                    .child(
                        div()
                            .min_w_0()
                            .truncate()
                            .text_xs()
                            .text_color(rgb(colors(cx).muted))
                            .child(format!(
                                "{}@{}:{}",
                                tab.profile.username, tab.profile.host, tab.profile.port
                            )),
                    )
                    .child(div().flex_1())
                    .when(tab.opening_terminal, |el| {
                        el.child(
                            div()
                                .text_xs()
                                .text_color(rgb(colors(cx).muted))
                                .child("正在打开终端…"),
                        )
                    })
                    .when(tab.terminals.len() > 1, |el| {
                        el.child(
                            div()
                                .text_xs()
                                .text_color(rgb(colors(cx).muted))
                                .child(format!("{} 个终端", tab.terminals.len())),
                        )
                    })
                    .child(
                        row()
                            .flex_shrink_0()
                            .gap_1()
                            .child(
                                tool(
                                    "switch-mode",
                                    if files_mode || empty {
                                        IconName::Terminal
                                    } else {
                                        IconName::Folders
                                    },
                                    if files_mode {
                                        "显示终端"
                                    } else if empty {
                                        "打开终端"
                                    } else {
                                        "双栏文件"
                                    },
                                    files_mode,
                                )
                                .disabled(blocked)
                                .on_click(cx.listener(
                                    move |view, _, w, cx| view.toggle_files_mode(id, w, cx),
                                )),
                            )
                            .child(
                                tool(
                                    "toggle-sftp",
                                    match (tab.sftp_left, tab.sftp_visible) {
                                        (true, true) => IconName::PanelLeftClose,
                                        (true, false) => IconName::PanelLeftOpen,
                                        (false, true) => IconName::PanelRightClose,
                                        (false, false) => IconName::PanelRightOpen,
                                    },
                                    if tab.sftp_visible {
                                        "收起 SFTP"
                                    } else {
                                        "展开 SFTP"
                                    },
                                    tab.sftp_visible && !files_mode,
                                )
                                .disabled(!terminal_mode || blocked)
                                .on_click(
                                    cx.listener(move |view, _, w, cx| view.toggle_sftp(id, w, cx)),
                                ),
                            )
                            .child(
                                tool(
                                    "swap-sftp-side",
                                    IconName::ArrowLeftRight,
                                    if tab.sftp_left {
                                        "将 SFTP 移到右侧"
                                    } else {
                                        "将 SFTP 移到左侧"
                                    },
                                    false,
                                )
                                .disabled(blocked)
                                .on_click(
                                    cx.listener(move |view, _, w, cx| {
                                        view.swap_sftp_side(id, w, cx)
                                    }),
                                ),
                            )
                            .child(
                                tool("split-columns", IconName::Columns2, "左右拆分终端", false)
                                    .disabled(!terminal_mode || blocked)
                                    .on_click(cx.listener(move |view, _, w, cx| {
                                        view.split_terminal(id, SplitDirection::Columns, w, cx)
                                    })),
                            )
                            .child(
                                tool("split-rows", IconName::Rows2, "上下拆分终端", false)
                                    .disabled(!terminal_mode || blocked)
                                    .on_click(cx.listener(move |view, _, w, cx| {
                                        view.split_terminal(id, SplitDirection::Rows, w, cx)
                                    })),
                            )
                            .child(
                                div()
                                    .h(px(18.))
                                    .border_l_1()
                                    .border_color(rgb(colors(cx).border))
                                    .mx_1(),
                            )
                            .child(
                                tool(
                                    "session-transfers",
                                    IconName::ArrowDownUp,
                                    "当前连接的传输队列",
                                    tab.show_transfers,
                                )
                                .on_click(cx.listener(
                                    move |view, _, _, cx| {
                                        if let Some(tab) = view.tab_mut(id) {
                                            tab.show_transfers = !tab.show_transfers;
                                        }
                                        cx.notify();
                                    },
                                )),
                            )
                            .when(transfer_count > 0, |el| {
                                el.child(
                                    div()
                                        .text_xs()
                                        .text_color(rgb(colors(cx).accent))
                                        .child(transfer_count.to_string()),
                                )
                            }),
                    ),
            )
            .when_some(tab.error.clone(), |el, error| {
                el.child(
                    row()
                        .h(px(30.))
                        .flex_shrink_0()
                        .px_3()
                        .gap_2()
                        .bg(panel(cx))
                        .text_xs()
                        .text_color(rgb(0xe87979))
                        .child(div().flex_1().truncate().child(error))
                        .child(
                            tool("dismiss-session-error", IconName::X, "关闭提示", false).on_click(
                                cx.listener(move |view, _, _, cx| {
                                    if let Some(tab) = view.tab_mut(id) {
                                        tab.error = None;
                                    }
                                    cx.notify();
                                }),
                            ),
                        ),
                )
            })
            .child(
                div()
                    .flex_1()
                    .min_h_0()
                    .min_w_0()
                    .overflow_hidden()
                    .child(content),
            )
            .when(tab.show_transfers, |el| {
                el.child(self.render_transfers(id, cx))
            })
            .child(self.render_resource_bar(tab, cx))
            .into_any_element()
    }
}
