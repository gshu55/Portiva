use super::*;

impl Workbench {
    pub(super) fn render_local_session(
        &self,
        tab: &SessionTab,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let id = tab.id;
        let blocked = tab.opening_terminal
            || tab
                .active_terminal()
                .is_some_and(|view| view.read(cx).has_pending_paste());
        let content = tab
            .layout
            .as_ref()
            .map(|layout| self.render_terminal_layout(tab, layout, cx));
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
                    .child(
                        Icon::new(IconName::Terminal)
                            .size(px(15.))
                            .text_color(rgb(colors(cx).accent)),
                    )
                    .child(div().flex_1().truncate().text_xs().child(tab.title()))
                    .when(tab.opening_terminal, |el| {
                        el.child(div().text_xs().child("正在打开终端…"))
                    })
                    .when(tab.terminals.is_empty(), |el| {
                        el.child(
                            tool(
                                "retry-local-terminal",
                                IconName::RefreshCw,
                                "重新打开本地终端",
                                false,
                            )
                            .disabled(blocked)
                            .on_click(cx.listener(move |v, _, w, cx| v.open_shell(id, w, cx))),
                        )
                    })
                    .child(
                        tool(
                            "local-split-columns",
                            IconName::Columns2,
                            "左右拆分终端",
                            false,
                        )
                        .disabled(blocked || tab.terminals.is_empty())
                        .on_click(cx.listener(move |v, _, w, cx| {
                            v.split_terminal(id, SplitDirection::Columns, w, cx)
                        })),
                    )
                    .child(
                        tool("local-split-rows", IconName::Rows2, "上下拆分终端", false)
                            .disabled(blocked || tab.terminals.is_empty())
                            .on_click(cx.listener(move |v, _, w, cx| {
                                v.split_terminal(id, SplitDirection::Rows, w, cx)
                            })),
                    ),
            )
            .when_some(tab.error.clone(), |el, error| {
                el.child(div().p_3().text_xs().text_color(rgb(0xe87979)).child(error))
            })
            .child(
                div()
                    .flex_1()
                    .min_h_0()
                    .min_w_0()
                    .overflow_hidden()
                    .children(content),
            )
            .into_any_element()
    }

    pub(crate) fn begin_local_terminal(
        &mut self,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Option<SessionId> {
        let shell = match LocalShell::detect() {
            Ok(shell) => shell,
            Err(error) => {
                self.message(Err(error), "", cx);
                return None;
            }
        };
        let id = Uuid::new_v4();
        self.tabs.push(SessionTab {
            id,
            profile: Profile::default(),
            local_shell: Some(shell),
            login_secret: None,
            state: ConnectionState::Ready,
            message: String::new(),
            terminals: Vec::new(),
            layout: None,
            terminal_splits: HashMap::new(),
            active_terminal: None,
            opening_terminal: false,
            remote: None,
            local: None,
            files_mode: false,
            sftp_visible: false,
            sftp_left: false,
            sftp_width: px(360.),
            file_panels: cx.new(|_| ResizableState::default()),
            show_transfers: false,
            resources: ResourceMonitor::default(),
            error: None,
            subscriptions: Vec::new(),
        });
        self.active = Some(id);
        self.home_active = false;
        self.settings_active = false;
        self.reveal_active_tab();
        self.open_shell(id, window, cx);
        cx.notify();
        Some(id)
    }
}
