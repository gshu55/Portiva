use crate::{
    connection::{ConnectionForm, auth_label, protocol_label},
    files::{FileAction, FilePane},
    jobs,
    settings::{self, SettingsEvent, SettingsView},
    terminal::{TerminalEvent, TerminalView},
    theme::*,
};
use anyhow::Result;
use gpui_kit::assets::IconName;
use gpui_kit::component::{
    ActiveTheme, Disableable, Icon, Selectable,
    button::ButtonVariants,
    checkbox::Checkbox,
    input::{Input, InputEvent, InputState},
    menu::{DropdownMenu, PopupMenuItem},
    resizable::ResizableState,
};
use gpui_kit::{prelude::*, *};
use portiva_core::*;
use std::{
    collections::{HashMap, VecDeque},
    path::PathBuf,
};
use uuid::Uuid;

#[path = "assets.rs"]
pub(crate) mod assets;
#[path = "chrome.rs"]
mod chrome;
#[path = "terminal_layout.rs"]
pub(crate) mod terminal_layout;
use terminal_layout::{SplitDirection, TerminalLayout};
#[path = "local_terminal.rs"]
mod local_terminal;
#[path = "resource_bar.rs"]
mod resource_bar;
#[path = "session.rs"]
mod session;
use resource_bar::ResourceMonitor;

struct TerminalPane {
    id: TerminalId,
    view: Entity<TerminalView>,
    _focus_subscription: Subscription,
    _event_subscription: Subscription,
}

struct SessionTab {
    id: SessionId,
    profile: Profile,
    local_shell: Option<LocalShell>,
    login_secret: Option<Entity<InputState>>,
    state: ConnectionState,
    message: String,
    terminals: Vec<TerminalPane>,
    layout: Option<TerminalLayout>,
    terminal_splits: HashMap<Uuid, Entity<ResizableState>>,
    active_terminal: Option<TerminalId>,
    opening_terminal: bool,
    remote: Option<Entity<FilePane>>,
    local: Option<Entity<FilePane>>,
    files_mode: bool,
    sftp_visible: bool,
    sftp_left: bool,
    sftp_width: Pixels,
    file_panels: Entity<ResizableState>,
    show_transfers: bool,
    resources: ResourceMonitor,
    error: Option<String>,
    subscriptions: Vec<Subscription>,
}

impl SessionTab {
    fn title(&self) -> String {
        self.local_shell
            .as_ref()
            .map_or_else(|| self.profile.title(), LocalShell::title)
    }

    fn sync_split_states(&mut self, cx: &mut App) {
        fn collect(layout: &TerminalLayout, ids: &mut Vec<Uuid>) {
            if let TerminalLayout::Split {
                id, first, second, ..
            } = layout
            {
                ids.push(*id);
                collect(first, ids);
                collect(second, ids);
            }
        }
        let mut ids = Vec::new();
        if let Some(layout) = &self.layout {
            collect(layout, &mut ids);
        }
        self.terminal_splits.retain(|id, _| ids.contains(id));
        for id in ids {
            self.terminal_splits
                .entry(id)
                .or_insert_with(|| cx.new(|_| ResizableState::default()));
        }
    }

    fn sync_terminal_controls(&self, cx: &mut App) {
        let can_close = self.terminals.len() > 1 && !self.opening_terminal;
        for pane in &self.terminals {
            pane.view
                .update(cx, |view, cx| view.set_can_close(can_close, cx));
        }
    }

    fn set_active_terminal(&mut self, id: TerminalId, cx: &mut App) {
        if self.active_terminal == Some(id) || !self.terminals.iter().any(|pane| pane.id == id) {
            return;
        }
        self.active_terminal = Some(id);
        for pane in &self.terminals {
            pane.view
                .update(cx, |view, cx| view.set_active(pane.id == id, cx));
        }
    }

    fn active_terminal(&self) -> Option<Entity<TerminalView>> {
        self.terminals
            .iter()
            .find(|pane| Some(pane.id) == self.active_terminal)
            .map(|pane| pane.view.clone())
    }
}
enum NameOperation {
    Create { parent: String },
    Rename { path: String },
}
enum Prompt {
    Host(HostKeyChallenge),
    Conflict {
        id: TransferId,
        path: String,
        response: tokio::sync::oneshot::Sender<ConflictDecision>,
    },
    Name {
        id: SessionId,
        title: String,
        input: Entity<InputState>,
        operation: NameOperation,
    },
    Delete {
        id: SessionId,
        entries: Vec<FileEntry>,
    },
}

pub struct Workbench {
    client: Client,
    runtime: tokio::runtime::Handle,
    profiles: Vec<Profile>,
    tabs: Vec<SessionTab>,
    active: Option<SessionId>,
    pub(crate) tabs_scroll: ScrollHandle,
    pub(crate) form: Option<ConnectionForm>,
    prompts: VecDeque<Prompt>,
    transfers: Vec<TransferSnapshot>,
    notice: String,
    notice_error: bool,
    local_directory: PathBuf,
    modal_focus: FocusHandle,
    workspace_focus: FocusHandle,
    settings: Settings,
    settings_saver: SettingsAutosave,
    settings_save_error: Option<String>,
    pub(crate) settings_view: Option<Entity<SettingsView>>,
    settings_subscription: Option<Subscription>,
    update_subscription: Option<Subscription>,
    settings_active: bool,
    home_active: bool,
    background: Option<PathBuf>,
    background_preparing: bool,
    _appearance_subscription: Subscription,
}

impl Workbench {
    pub fn new(
        client: Client,
        runtime: tokio::runtime::Handle,
        events: async_channel::Receiver<CoreEvent>,
        local_directory: PathBuf,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Self {
        let profiles = client.store().profiles();
        let preferences = client.store().settings();
        let notice = profiles
            .as_ref()
            .err()
            .map(|e| format!("{e:#}"))
            .or_else(|| preferences.as_ref().err().map(|e| format!("{e:#}")));
        let mut settings = preferences.unwrap_or_default();
        settings.terminal.font_family = settings::installed_font_family(
            &settings.terminal.font_family,
            &cx.text_system().all_font_names(),
        );
        crate::theme::apply(&settings, window.appearance(), cx);
        crate::terminal::init(cx);
        let weak = cx.entity().downgrade();
        let appearance_subscription = window.observe_window_appearance(move |window, cx| {
            let _ = weak.update(cx, |view, cx| {
                if view.settings.theme == ThemeMode::System {
                    crate::theme::apply(&view.settings, window.appearance(), cx);
                    cx.notify();
                }
            });
        });
        let settings_saver = SettingsAutosave::new(client.store().clone());
        let mut view = Self {
            client,
            runtime,
            profiles: profiles.unwrap_or_default(),
            tabs: Vec::new(),
            active: None,
            tabs_scroll: ScrollHandle::new(),
            form: None,
            prompts: VecDeque::new(),
            transfers: Vec::new(),
            notice_error: notice.is_some(),
            notice: notice.unwrap_or_else(|| "就绪".into()),
            local_directory,
            modal_focus: cx.focus_handle(),
            workspace_focus: cx.focus_handle(),
            settings,
            settings_saver,
            settings_save_error: None,
            settings_view: None,
            settings_subscription: None,
            update_subscription: None,
            settings_active: false,
            home_active: true,
            background: None,
            background_preparing: false,
            _appearance_subscription: appearance_subscription,
        };
        view.refresh_background(window, cx);
        window.focus(&view.workspace_focus, cx);
        cx.spawn_in(window, async move |view, cx| {
            while let Ok(event) = events.recv().await {
                let mut batch = vec![event];
                while batch.len() < 128 {
                    match events.try_recv() {
                        Ok(event) => batch.push(event),
                        Err(_) => break,
                    }
                }
                if cx
                    .update(|window, cx| {
                        view.update(cx, |view, cx| {
                            for event in batch {
                                view.event(event, window, cx);
                            }
                        })
                    })
                    .is_err()
                {
                    break;
                }
                cx.background_executor()
                    .timer(std::time::Duration::from_millis(8))
                    .await;
            }
        })
        .detach();
        // Poll only the visible connection. Settings and hidden tabs do not sample servers.
        cx.spawn_in(window, async move |view, cx| {
            loop {
                cx.background_executor()
                    .timer(std::time::Duration::from_secs(1))
                    .await;
                if cx
                    .update(|window, cx| {
                        view.update(cx, |view, cx| view.refresh_resources(window, cx))
                    })
                    .is_err()
                {
                    break;
                }
            }
        })
        .detach();
        view
    }
    fn tab(&self, id: SessionId) -> Option<&SessionTab> {
        self.tabs.iter().find(|t| t.id == id)
    }
    fn tab_mut(&mut self, id: SessionId) -> Option<&mut SessionTab> {
        self.tabs.iter_mut().find(|t| t.id == id)
    }
    fn message(&mut self, result: Result<()>, success: &str, cx: &mut Context<Self>) {
        self.notice_error = result.is_err();
        self.notice = result
            .err()
            .map(|e| format!("{e:#}"))
            .unwrap_or_else(|| success.into());
        cx.notify();
    }
    fn session_message(&mut self, id: SessionId, result: Result<()>, cx: &mut Context<Self>) {
        if let Some(tab) = self.tab_mut(id) {
            tab.error = result.err().map(|error| format!("{error:#}"));
            cx.notify();
        }
    }
    pub(crate) fn open_form(
        &mut self,
        profile: Profile,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.notice_error = false;
        self.form = Some(ConnectionForm::new(profile, window, cx));
        if let Some(form) = &self.form {
            form.focus(window, cx);
        }
        cx.notify();
    }
    pub(crate) fn select_authentication(
        &mut self,
        auth: AuthMethod,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if let Some(form) = &mut self.form
            && !form.busy
        {
            form.change_auth(auth, window, cx);
            cx.notify();
        }
    }
    pub(crate) fn select_protocol(&mut self, protocol: Protocol, cx: &mut Context<Self>) {
        if let Some(form) = &mut self.form
            && !form.busy
        {
            form.profile.protocol = protocol;
            if form.profile.protocol == Protocol::Sftp {
                form.profile.x11.enabled = false;
            }
            cx.notify();
        }
    }
    pub(crate) fn set_x11_forwarding(&mut self, enabled: bool, cx: &mut Context<Self>) {
        if let Some(form) = &mut self.form
            && !form.busy
        {
            form.profile.x11.enabled = enabled && form.profile.protocol == Protocol::Ssh;
            cx.notify();
        }
    }
    pub(crate) fn open_settings(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.settings_view.is_none() {
            let editor = cx.new(|cx| {
                let mut editor = SettingsView::new(
                    self.settings.clone(),
                    self.runtime.clone(),
                    self.client.store().root().to_path_buf(),
                    window,
                    cx,
                );
                editor.save_error = self.settings_save_error.clone();
                editor
            });
            let subscription =
                cx.subscribe_in(&editor, window, |view, _, event, window, cx| match event {
                    SettingsEvent::Change(settings) => {
                        let mut settings = (**settings).clone();
                        // Layout can change while this editor remains open in another tab.
                        settings.sftp_panel = view.settings.sftp_panel.clone();
                        view.save_settings(settings, window, cx)
                    }
                });
            let updater = editor.read(cx).updater.clone();
            self.update_subscription = Some(cx.subscribe_in(&updater, window, |view, updater, _, _, cx| {
                let sessions = view.tabs.iter().filter(|tab| tab.state != ConnectionState::Disconnected).count();
                let transfers = view.transfers.iter().filter(|transfer| !transfer.status.finished()).count();
                if sessions != 0 || transfers != 0 {
                    updater.update(cx, |updater, cx| updater.set_error(format!("请先关闭 {sessions} 个活动会话并结束 {transfers} 个传输，再安装更新。"), cx));
                } else if updater.update(cx, |updater, cx| updater.install(cx)) {
                    cx.quit();
                }
            }));
            self.settings_view = Some(editor);
            self.settings_subscription = Some(subscription);
            window.focus(&self.workspace_focus, cx);
        }
        self.settings_active = true;
        self.home_active = false;
        self.reveal_active_tab();
        window.focus(&self.workspace_focus, cx);
        cx.notify();
    }
    fn restore_terminal_focus(&self, window: &mut Window, cx: &mut App) {
        if self.settings_active || self.home_active {
            window.focus(&self.workspace_focus, cx);
            return;
        }
        if let Some(terminal) = self
            .active
            .and_then(|id| self.tab(id))
            .filter(|tab| !tab.files_mode)
            .and_then(SessionTab::active_terminal)
        {
            let focus = terminal.focus_handle(cx);
            window.focus(&focus, cx);
        } else {
            window.focus(&self.workspace_focus, cx);
        }
    }
    pub(crate) fn save_settings(
        &mut self,
        settings: Settings,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if let Err(error) = settings.validate() {
            self.message(Err(error), "", cx);
            return;
        }
        if self.settings == settings {
            return;
        }
        let background_changed = self.settings.background.enabled != settings.background.enabled
            || self.settings.background.image != settings.background.image
            || self.settings.background.blur != settings.background.blur;
        if !settings.background.enabled {
            self.background = None;
        } else if self.settings.background.image != settings.background.image
            || !self.settings.background.enabled
        {
            self.background = settings.background.image.clone();
        }
        if self.settings.theme != settings.theme || self.settings.background != settings.background
        {
            crate::theme::apply(&settings, window.appearance(), cx);
        }
        if self.settings.terminal != settings.terminal || self.settings.keymap != settings.keymap {
            for tab in &self.tabs {
                for terminal in &tab.terminals {
                    terminal
                        .view
                        .update(cx, |v, cx| v.apply_settings(settings.clone(), cx));
                }
            }
        }
        self.settings = settings.clone();
        if let Some(editor) = &self.settings_view {
            editor.update(cx, |editor, _| {
                editor.settings.sftp_panel = settings.sftp_panel.clone();
            });
        }
        if background_changed {
            self.refresh_background(window, cx);
        }
        cx.notify();
        let Some(write) = self.settings_saver.save(settings, &self.runtime) else {
            return;
        };
        jobs::run(
            &self.runtime,
            window,
            cx,
            async move { Ok(write.await?) },
            |view, result, _, cx| {
                let result = match result {
                    Ok((saved, result)) if saved == view.settings => result,
                    Ok(_) => return,
                    Err(error) => Err(error),
                };
                view.settings_save_error = result
                    .as_ref()
                    .err()
                    .map(|error| format!("自动保存失败：{error:#}"));
                if let Some(editor) = &view.settings_view {
                    editor.update(cx, |v, cx| {
                        v.save_error = view.settings_save_error.clone();
                        cx.notify();
                    });
                }
                // Persistence feedback belongs to the settings editor, not a session's footer.
                cx.notify();
            },
        );
    }
    fn refresh_background(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.background_preparing {
            return;
        }
        self.background_preparing = true;
        let requested = self.settings.background.clone();
        let settings = self.settings.clone();
        let data = self.client.store().root().to_path_buf();
        jobs::run(
            &self.runtime,
            window,
            cx,
            async move {
                tokio::time::sleep(std::time::Duration::from_millis(120)).await;
                tokio::task::spawn_blocking(move || settings::prepare_background(&settings, &data))
                    .await?
            },
            move |view, result, window, cx| {
                view.background_preparing = false;
                let current = &view.settings.background;
                if current.enabled != requested.enabled
                    || current.image != requested.image
                    || current.blur != requested.blur
                {
                    view.refresh_background(window, cx);
                    return;
                }
                let error = match result {
                    Ok(background) => {
                        view.background = background;
                        None
                    }
                    Err(error) => Some(format!("背景处理失败：{error:#}")),
                };
                if let Some(editor) = &view.settings_view {
                    editor.update(cx, |v, cx| {
                        v.background_error = error.clone();
                        cx.notify();
                    });
                }
                if let Some(error) = error {
                    view.message(Err(anyhow::anyhow!(error)), "", cx);
                }
                cx.notify();
            },
        );
    }
    fn forget_secret(&mut self, id: String, window: &mut Window, cx: &mut Context<Self>) {
        let store = self.client.store().clone();
        let target = id.clone();
        jobs::run(
            &self.runtime,
            window,
            cx,
            async move { tokio::task::spawn_blocking(move || store.forget_secret(&target)).await? },
            move |view, result, window, cx| {
                if result.is_ok() {
                    if let Some(profile) = view.profiles.iter_mut().find(|p| p.id == id) {
                        profile.remember_secret = false;
                    }
                    if let Some(form) = &mut view.form
                        && form.profile.id == id
                    {
                        form.profile.remember_secret = false;
                        form.has_saved_secret = false;
                        form.clear_secret(window, cx);
                    }
                }
                if let Some(form) = &mut view.form {
                    form.busy = false;
                }
                if view.settings_active && view.form.is_none() && view.prompts.is_empty() {
                    window.focus(&view.workspace_focus, cx);
                }
                view.message(result, "已删除保存的凭据", cx);
            },
        );
    }
    fn choose_private_key(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(form) = &mut self.form else {
            return;
        };
        form.busy = true;
        let id = form.profile.id.clone();
        // rfd inspects AppKit windows when creating the future on macOS.
        let picker = rfd::AsyncFileDialog::new()
            .set_title("选择 SSH 私钥文件")
            .pick_file();
        jobs::run(
            &self.runtime,
            window,
            cx,
            async move { Ok(picker.await.map(|f| f.path().to_path_buf())) },
            move |view, result, window, cx| {
                if let Some(form) = &mut view.form {
                    form.busy = false;
                    if form.profile.id == id {
                        match result {
                            Ok(Some(path)) => form.set_key_path(path, window, cx),
                            Ok(None) => {}
                            Err(error) => view.message(Err(error), "", cx),
                        }
                    }
                }
                cx.notify();
            },
        );
    }
    fn delete_form(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(form) = &mut self.form else {
            return;
        };
        if form.busy {
            return;
        }
        form.busy = true;
        let id = form.profile.id.clone();
        let target = id.clone();
        let store = self.client.store().clone();
        jobs::run(
            &self.runtime,
            window,
            cx,
            async move { tokio::task::spawn_blocking(move || store.delete_profile(&target)).await? },
            move |view, result, window, cx| {
                if result.is_ok() {
                    view.profiles.retain(|p| p.id != id);
                    view.form = None;
                    view.restore_terminal_focus(window, cx);
                } else if let Some(form) = &mut view.form {
                    form.busy = false;
                }
                view.message(result, "连接与已保存凭据已删除", cx);
            },
        );
    }
    fn global_key(&mut self, event: &KeyDownEvent, window: &mut Window, cx: &mut Context<Self>) {
        if event.keystroke.key == "escape"
            && self.prompts.is_empty()
            && self.form.as_ref().is_some_and(|f| !f.busy)
        {
            self.form = None;
            if !self.settings_active && !self.home_active {
                self.restore_terminal_focus(window, cx);
            }
            cx.stop_propagation();
            cx.notify();
            return;
        }
        if self.form.is_some()
            || !self.prompts.is_empty()
            || self
                .active_terminal()
                .is_some_and(|t| t.read(cx).has_pending_paste())
        {
            return;
        }
        if crate::terminal::shortcut_matches(&self.settings.keymap.open_settings, &event.keystroke)
        {
            self.open_settings(window, cx);
            cx.stop_propagation();
        } else if crate::terminal::shortcut_matches(
            &self.settings.keymap.new_connection,
            &event.keystroke,
        ) {
            self.open_form(Profile::default(), window, cx);
            cx.stop_propagation();
        }
    }
    pub(crate) fn active_terminal(&self) -> Option<Entity<TerminalView>> {
        self.active
            .and_then(|id| self.tab(id))
            .and_then(SessionTab::active_terminal)
    }
    fn save_profile(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.submit_form(false, window, cx);
    }
    fn connect(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.submit_form(true, window, cx);
    }
    fn submit_form(&mut self, connect: bool, window: &mut Window, cx: &mut Context<Self>) {
        let Some(form) = &self.form else {
            return;
        };
        if form.busy {
            return;
        }
        let (profile, credentials) = match form.values(cx) {
            Ok(v) => v,
            Err(e) => {
                self.message(Err(e), "", cx);
                return;
            }
        };
        if connect
            && profile.auth == AuthMethod::Password
            && !profile.remember_secret
            && credentials.password.is_empty()
        {
            self.message(Err(anyhow::anyhow!("请输入本次连接的密码")), "", cx);
            return;
        }
        if let Some(form) = &mut self.form {
            form.busy = true;
        }
        let store = self.client.store().clone();
        jobs::run(
            &self.runtime,
            window,
            cx,
            async move {
                tokio::task::spawn_blocking(move || {
                    store.save_connection(profile.clone(), &credentials)?;
                    Ok((profile, credentials, store.profiles()?))
                })
                .await?
            },
            move |view, result, window, cx| {
                if let Some(form) = &mut view.form {
                    form.busy = false;
                }
                match result {
                    Ok((profile, credentials, profiles)) => {
                        view.profiles = profiles;
                        if let Some(form) = &mut view.form {
                            form.has_saved_secret = profile.remember_secret;
                            form.refresh_secret_hint(window, cx);
                            if connect || profile.remember_secret {
                                form.clear_secret(window, cx);
                            }
                        }
                        if connect {
                            view.form = None;
                            view.begin_connection(profile, credentials, window, cx);
                        } else {
                            view.message(Ok(()), "连接与凭据选项已保存", cx);
                        }
                    }
                    Err(error) => view.message(Err(error), "", cx),
                }
                cx.notify();
            },
        );
    }
    pub(crate) fn begin_connection(
        &mut self,
        profile: Profile,
        credentials: Credentials,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> SessionId {
        let id = Uuid::new_v4();
        let mode = profile.protocol == Protocol::Sftp;
        self.tabs.push(SessionTab {
            id,
            profile: profile.clone(),
            local_shell: None,
            login_secret: None,
            state: ConnectionState::Connecting,
            message: "正在连接…".into(),
            terminals: Vec::new(),
            layout: None,
            terminal_splits: HashMap::new(),
            active_terminal: None,
            opening_terminal: false,
            remote: None,
            local: None,
            files_mode: mode,
            sftp_visible: self.settings.sftp_panel.visible,
            sftp_left: self.settings.sftp_panel.left,
            sftp_width: px(f32::from(self.settings.sftp_panel.width)),
            file_panels: cx.new(|_| ResizableState::default()),
            show_transfers: false,
            resources: ResourceMonitor::default(),
            error: None,
            subscriptions: Vec::new(),
        });
        self.active = Some(id);
        self.settings_active = false;
        self.home_active = false;
        self.reveal_active_tab();
        if profile.auth == AuthMethod::Password
            && !profile.remember_secret
            && credentials.password.is_empty()
        {
            let input = cx.new(|cx| {
                InputState::new(window, cx)
                    .masked(true)
                    .placeholder("本次连接的密码")
            });
            let subscription =
                cx.subscribe_in(&input, window, move |view, _, event, window, cx| {
                    if matches!(event, InputEvent::PressEnter { .. }) {
                        view.submit_login_secret(id, window, cx);
                    }
                });
            window.focus(&input.focus_handle(cx), cx);
            if let Some(tab) = self.tab_mut(id) {
                tab.login_secret = Some(input);
                tab.subscriptions.push(subscription);
                tab.message = "该连接未保存密码，请输入本次连接的密码。".into();
            }
        } else {
            self.start_connection(id, profile, credentials, window, cx);
        }
        cx.notify();
        id
    }

    fn submit_login_secret(&mut self, id: SessionId, window: &mut Window, cx: &mut Context<Self>) {
        let Some(tab) = self.tab_mut(id) else { return };
        let Some(input) = &tab.login_secret else {
            return;
        };
        let password = input.read(cx).value().to_string();
        if password.is_empty() {
            return;
        }
        input.update(cx, |input, cx| input.set_value("", window, cx));
        tab.login_secret = None;
        tab.message = "正在连接…".into();
        let profile = tab.profile.clone();
        window.focus(&self.workspace_focus, cx);
        self.start_connection(id, profile, Credentials::password(password), window, cx);
        cx.notify();
    }

    fn start_connection(
        &mut self,
        id: SessionId,
        profile: Profile,
        credentials: Credentials,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let client = self.client.clone();
        jobs::run(
            &self.runtime,
            window,
            cx,
            async move { client.connect(id, profile, credentials).await },
            move |view, result, window, cx| {
                if result.is_ok() {
                    if view.tab(id).is_some() {
                        view.setup(id, window, cx);
                    } else {
                        let client = view.client.clone();
                        view.runtime.spawn(async move {
                            let _ = client.disconnect(id).await;
                        });
                    }
                } else if let Err(e) = result {
                    view.message(Err(e), "", cx);
                }
                cx.notify();
            },
        );
        cx.notify();
    }
    fn setup(&mut self, id: SessionId, window: &mut Window, cx: &mut Context<Self>) {
        let client = self.client.clone();
        let runtime = self.runtime.clone();
        let remote = cx.new(|cx| {
            FilePane::new(
                client.clone(),
                runtime.clone(),
                Some(id),
                ".".into(),
                window,
                cx,
            )
        });
        let local_path = self.local_directory.clone();
        let local = cx.new(|cx| {
            FilePane::new(
                client,
                runtime,
                None,
                local_path.to_string_lossy().into_owned(),
                window,
                cx,
            )
        });
        let a = cx.subscribe_in(&remote, window, move |view, _, event, window, cx| {
            view.file_action(id, event.clone(), window, cx)
        });
        let b = cx.subscribe_in(&local, window, move |view, _, event, window, cx| {
            view.file_action(id, event.clone(), window, cx)
        });
        let shell = if let Some(tab) = self.tab_mut(id) {
            tab.remote = Some(remote);
            tab.local = Some(local);
            tab.subscriptions = vec![a, b];
            tab.profile.protocol == Protocol::Ssh
        } else {
            false
        };
        if shell {
            self.open_shell(id, window, cx);
        }
        cx.notify();
    }
    fn open_shell(&mut self, id: SessionId, window: &mut Window, cx: &mut Context<Self>) {
        if self.tab(id).is_none_or(|tab| !tab.terminals.is_empty()) {
            return;
        }
        self.open_terminal(id, None, window, cx);
    }
    pub(crate) fn split_terminal(
        &mut self,
        id: SessionId,
        direction: SplitDirection,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let Some(tab) = self.tab(id) else { return };
        if tab.files_mode || tab.state != ConnectionState::Ready {
            return;
        }
        let Some(target) = tab.active_terminal else {
            return;
        };
        self.open_terminal(id, Some((target, direction)), window, cx);
    }
    fn open_terminal(
        &mut self,
        id: SessionId,
        split: Option<(TerminalId, SplitDirection)>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let Some(tab) = self.tab_mut(id) else { return };
        if tab.opening_terminal {
            return;
        }
        tab.opening_terminal = true;
        tab.sync_terminal_controls(cx);
        tab.error = None;
        let local_shell = tab.local_shell.clone();
        let directory = self.local_directory.clone();
        cx.notify();
        let client = self.client.clone();
        jobs::run(
            &self.runtime,
            window,
            cx,
            async move {
                if let Some(shell) = local_shell {
                    client
                        .open_local_terminal(id, shell, directory, TerminalSize::default())
                        .await
                } else {
                    client.open_terminal(id, TerminalSize::default()).await
                }
            },
            move |view, result, window, cx| {
                if let Some(tab) = view.tab_mut(id) {
                    tab.opening_terminal = false;
                    tab.sync_terminal_controls(cx);
                }
                match result {
                    Ok(handle) => {
                        if view.tab(id).is_none() {
                            handle.close();
                            return;
                        }
                        let terminal = cx
                            .new(|cx| TerminalView::new(handle.clone(), view.settings.clone(), cx));
                        let terminal_id = handle.id;
                        let focus = terminal.focus_handle(cx);
                        let subscription = cx.on_focus(&focus, window, move |view, _, cx| {
                            if let Some(tab) = view.tab_mut(id)
                                && tab.active_terminal != Some(terminal_id)
                            {
                                tab.set_active_terminal(terminal_id, cx);
                                cx.notify();
                            }
                        });
                        let event_subscription = cx.subscribe_in(
                            &terminal,
                            window,
                            move |view, _, event, window, cx| match event {
                                TerminalEvent::CloseRequested => {
                                    view.close_terminal(id, terminal_id, window, cx);
                                }
                                TerminalEvent::TitleChanged => {
                                    if view
                                        .tab(id)
                                        .is_some_and(|tab| tab.active_terminal == Some(terminal_id))
                                    {
                                        cx.notify();
                                    }
                                }
                            },
                        );
                        let focus_new = view.active == Some(id)
                            && !view.settings_active
                            && !view.home_active
                            && view.form.is_none()
                            && view.prompts.is_empty()
                            && view.tab(id).is_some_and(|tab| {
                                !tab.files_mode
                                    && split.is_none_or(|(target, _)| {
                                        tab.active_terminal == Some(target)
                                    })
                            });
                        if let Some(tab) = view.tab_mut(id) {
                            match split {
                                Some((target, direction)) => {
                                    if !tab.layout.as_mut().is_some_and(|layout| {
                                        layout.split(target, terminal_id, direction)
                                    }) {
                                        handle.close();
                                        cx.notify();
                                        return;
                                    }
                                }
                                None => tab.layout = Some(TerminalLayout::Terminal(terminal_id)),
                            }
                            tab.sync_split_states(cx);
                            tab.terminals.push(TerminalPane {
                                id: terminal_id,
                                view: terminal.clone(),
                                _focus_subscription: subscription,
                                _event_subscription: event_subscription,
                            });
                            tab.sync_terminal_controls(cx);
                            if tab.active_terminal.is_none() || focus_new {
                                tab.set_active_terminal(terminal_id, cx);
                            }
                        }
                        // Register every consumer before releasing buffered first output.
                        if let Err(e) = handle.activate() {
                            view.session_message(id, Err(e), cx);
                        }
                        if focus_new {
                            window.focus(&focus, cx);
                        }
                    }
                    Err(e) => view.session_message(id, Err(e), cx),
                }
                cx.notify();
            },
        );
    }
    pub(crate) fn close_terminal(
        &mut self,
        id: SessionId,
        target: TerminalId,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let Some(tab) = self.tab_mut(id) else { return };
        if tab.terminals.len() <= 1 || tab.opening_terminal || tab.files_mode {
            return;
        }
        let Some(pane) = tab.terminals.iter().find(|pane| pane.id == target) else {
            return;
        };
        if pane.view.read(cx).has_pending_paste() {
            return;
        }
        let Some(next) = tab.layout.as_mut().and_then(|layout| layout.close(target)) else {
            return;
        };
        tab.sync_split_states(cx);
        if let Some(index) = tab.terminals.iter().position(|pane| pane.id == target) {
            let pane = tab.terminals.remove(index);
            pane.view.read(cx).handle.close();
        }
        let restore_focus = tab.active_terminal == Some(target);
        if restore_focus {
            tab.set_active_terminal(next, cx);
        }
        tab.sync_terminal_controls(cx);
        if restore_focus {
            self.restore_terminal_focus(window, cx);
        }
        cx.notify();
    }
    pub(crate) fn close_tab(&mut self, id: SessionId, window: &mut Window, cx: &mut Context<Self>) {
        let restore_focus = self.active == Some(id) && !self.settings_active && !self.home_active;
        if let Some(tab) = self.tab(id) {
            for pane in &tab.terminals {
                pane.view.read(cx).handle.close();
            }
        }
        self.tabs.retain(|t| t.id != id);
        if self.active == Some(id) {
            self.active = self.tabs.last().map(|t| t.id);
        }
        if self.active.is_none() && !self.settings_active {
            self.home_active = true;
        }
        self.reveal_active_tab();
        if restore_focus {
            self.restore_terminal_focus(window, cx);
        }
        // Dropping a host-key question rejects that handshake immediately.
        self.prompts
            .retain(|p| !matches!(p,Prompt::Host(h) if h.session_id==id));
        let client = self.client.clone();
        jobs::run(
            &self.runtime,
            window,
            cx,
            async move { client.disconnect(id).await },
            |view, result, _, cx| view.message(result, "连接已关闭", cx),
        );
        cx.notify();
    }
    fn event(&mut self, event: CoreEvent, window: &mut Window, cx: &mut Context<Self>) {
        let was_empty = self.prompts.is_empty();
        match event {
            CoreEvent::HostKey(host) => {
                if self.tab(host.session_id).is_some() {
                    self.prompts.push_back(Prompt::Host(host));
                }
            }
            CoreEvent::Connection {
                session_id,
                state,
                message,
            } => {
                if let Some(tab) = self.tab_mut(session_id) {
                    tab.state = state;
                    tab.message = message;
                }
                if state == ConnectionState::Disconnected {
                    self.prompts
                        .retain(|p| !matches!(p,Prompt::Host(host) if host.session_id==session_id));
                }
            }
            CoreEvent::TerminalOutput { terminal_id, data } => {
                if let Some(pane) = self
                    .tabs
                    .iter()
                    .flat_map(|tab| &tab.terminals)
                    .find(|pane| pane.id == terminal_id)
                {
                    pane.view
                        .update(cx, |view, cx| view.feed(&data, window, cx));
                }
                return;
            }
            CoreEvent::TerminalClosed {
                terminal_id,
                message,
            } => {
                if let Some(pane) = self
                    .tabs
                    .iter()
                    .flat_map(|tab| &tab.terminals)
                    .find(|pane| pane.id == terminal_id)
                {
                    pane.view.update(cx, |view, cx| {
                        view.status = Some(message);
                        cx.notify();
                    });
                }
            }
            CoreEvent::Transfer(state) => {
                let complete = state.status == TransferStatus::Completed;
                let session_id = state.session_id;
                if let Some(old) = self.transfers.iter_mut().find(|t| t.id == state.id) {
                    *old = state;
                } else {
                    self.transfers.push(state);
                }
                if complete {
                    self.refresh_files(session_id, window, cx);
                }
                self.prompts.retain(|p|!matches!(p,Prompt::Conflict{id,..} if self.transfers.iter().any(|t|t.id==*id&&t.status.finished())));
            }
            CoreEvent::TransferConflict {
                transfer_id,
                path,
                response,
            } => self.prompts.push_back(Prompt::Conflict {
                id: transfer_id,
                path,
                response,
            }),
        }
        if was_empty && !self.prompts.is_empty() {
            window.focus(&self.modal_focus, cx);
        }
        cx.notify();
    }
    fn refresh_files(&self, id: SessionId, window: &mut Window, cx: &mut Context<Self>) {
        if let Some(tab) = self.tab(id) {
            for pane in [&tab.local, &tab.remote].into_iter().flatten() {
                pane.update(cx, |p, cx| p.refresh(window, cx));
            }
        }
    }
    pub(crate) fn file_action(
        &mut self,
        id: SessionId,
        action: FileAction,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let was_empty = self.prompts.is_empty();
        match action {
            FileAction::Upload { directory, parent } => {
                let client = self.client.clone();
                if let Some(tab) = self.tab_mut(id) {
                    tab.show_transfers = true;
                }
                let dialog = rfd::AsyncFileDialog::new().set_title(if directory {
                    "选择要上传的目录"
                } else {
                    "选择要上传的文件"
                });
                let folder_picker = directory.then(|| dialog.clone().pick_folder());
                let file_picker = (!directory).then(|| dialog.pick_files());
                jobs::run(
                    &self.runtime,
                    window,
                    cx,
                    async move {
                        let paths = if let Some(picker) = folder_picker {
                            picker.await.map(|p| vec![p]).unwrap_or_default()
                        } else if let Some(picker) = file_picker {
                            picker.await.unwrap_or_default()
                        } else {
                            Vec::new()
                        };
                        for path in paths {
                            client
                                .upload(id, path.path().into(), parent.clone())
                                .await?;
                        }
                        Ok(())
                    },
                    move |view, result, _, cx| view.session_message(id, result, cx),
                );
            }
            FileAction::Transfer { entries, remote } => {
                let Some(tab) = self.tab(id) else {
                    return;
                };
                let destination = if remote {
                    if tab.files_mode {
                        tab.local.as_ref().map(|p| p.read(cx).path.clone())
                    } else {
                        None
                    }
                } else {
                    tab.remote.as_ref().map(|p| p.read(cx).path.clone())
                };
                let folder_picker = destination.is_none().then(|| {
                    rfd::AsyncFileDialog::new()
                        .set_title("选择下载目录")
                        .pick_folder()
                });
                let client = self.client.clone();
                if let Some(tab) = self.tab_mut(id) {
                    tab.show_transfers = true;
                }
                jobs::run(
                    &self.runtime,
                    window,
                    cx,
                    async move {
                        let destination = if let Some(path) = destination {
                            path
                        } else {
                            let selected = match folder_picker {
                                Some(picker) => picker.await,
                                None => None,
                            };
                            let Some(folder) = selected else {
                                return Ok(());
                            };
                            folder.path().to_string_lossy().into_owned()
                        };
                        for entry in entries {
                            if remote {
                                client
                                    .download(id, entry.path, PathBuf::from(&destination))
                                    .await?;
                            } else {
                                client
                                    .upload(id, PathBuf::from(entry.path), destination.clone())
                                    .await?;
                            }
                        }
                        Ok(())
                    },
                    move |view, result, _, cx| view.session_message(id, result, cx),
                );
            }
            FileAction::CreateDirectory { parent } => {
                let input = cx.new(|cx| InputState::new(window, cx).placeholder("目录名称"));
                self.prompts.push_back(Prompt::Name {
                    id,
                    title: "新建远端目录".into(),
                    input,
                    operation: NameOperation::Create { parent },
                });
            }
            FileAction::Rename { entry } => {
                let input = cx.new(|cx| InputState::new(window, cx).default_value(entry.name));
                self.prompts.push_back(Prompt::Name {
                    id,
                    title: "重命名远端文件".into(),
                    input,
                    operation: NameOperation::Rename { path: entry.path },
                });
            }
            FileAction::Delete { entries } => {
                self.prompts.push_back(Prompt::Delete { id, entries })
            }
        }
        if was_empty && !self.prompts.is_empty() {
            let focus = match self.prompts.front() {
                Some(Prompt::Name { input, .. }) => input.focus_handle(cx),
                _ => self.modal_focus.clone(),
            };
            window.focus(&focus, cx);
        }
        cx.notify();
    }
    pub(crate) fn set_files_mode(&mut self, id: SessionId, mode: bool, cx: &mut Context<Self>) {
        if let Some(tab) = self.tab_mut(id) {
            tab.files_mode = mode;
        }
        cx.notify();
    }
    fn answer_host(&mut self, accept: bool, cx: &mut Context<Self>) {
        if let Some(Prompt::Host(host)) = self.prompts.pop_front() {
            let _ = host.response.send(accept);
        }
        cx.notify();
    }
    fn answer_conflict(&mut self, decision: ConflictDecision, cx: &mut Context<Self>) {
        if let Some(Prompt::Conflict { response, .. }) = self.prompts.pop_front() {
            let _ = response.send(decision);
        }
        cx.notify();
    }
    fn confirm_operation(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        // Validate before dismissing so a typo can be corrected in the same dialog.
        if let Some(Prompt::Name { input, .. }) = self.prompts.front() {
            let name = input.read(cx).value();
            if name.trim().is_empty() {
                self.message(Err(anyhow::anyhow!("名称不能为空")), "", cx);
                return;
            }
        }
        let client = self.client.clone();
        let Some(prompt) = self.prompts.pop_front() else {
            return;
        };
        match prompt {
            Prompt::Name {
                id,
                input,
                operation,
                ..
            } => {
                let name = input.read(cx).value().to_string();
                jobs::run(
                    &self.runtime,
                    window,
                    cx,
                    async move {
                        match operation {
                            NameOperation::Create { parent } => {
                                client.create_remote_directory(id, &parent, &name).await
                            }
                            NameOperation::Rename { path } => {
                                client.rename_remote(id, &path, &name).await
                            }
                        }
                    },
                    move |view, result, window, cx| {
                        view.session_message(id, result, cx);
                        view.refresh_files(id, window, cx);
                    },
                );
            }
            Prompt::Delete { id, entries } => {
                jobs::run(
                    &self.runtime,
                    window,
                    cx,
                    async move {
                        for entry in entries {
                            client.remove_remote(id, &entry.path).await?;
                        }
                        Ok(())
                    },
                    move |view, result, window, cx| {
                        view.session_message(id, result, cx);
                        view.refresh_files(id, window, cx);
                    },
                );
            }
            _ => {}
        }
        cx.notify();
    }
    fn transfer_control(
        &mut self,
        id: TransferId,
        action: u8,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let client = self.client.clone();
        jobs::run(
            &self.runtime,
            window,
            cx,
            async move {
                match action {
                    0 => client.pause_transfer(id, true).await,
                    1 => client.pause_transfer(id, false).await,
                    2 => client.cancel_transfer(id),
                    3 => client.retry_transfer(id).await.map(|_| ()),
                    _ => client.forget_transfer(id),
                }
            },
            move |view, result, _, cx| {
                if result.is_ok() && action == 4 {
                    view.transfers.retain(|t| t.id != id);
                }
                if let Some(session_id) = view
                    .transfers
                    .iter()
                    .find(|t| t.id == id)
                    .map(|t| t.session_id)
                {
                    view.session_message(session_id, result, cx);
                }
            },
        );
    }
    fn render_workspace(&self, cx: &mut Context<Self>) -> AnyElement {
        if self.settings_active
            && let Some(settings) = &self.settings_view
        {
            return settings.clone().into_any_element();
        }
        if self.home_active {
            return self.render_hosts(cx);
        }
        let Some(tab) = self.active.and_then(|id| self.tab(id)) else {
            return self.render_hosts(cx);
        };
        let id = tab.id;
        if tab.state != ConnectionState::Ready {
            return column()
                .flex_1()
                .size_full()
                .items_center()
                .justify_center()
                .gap_3()
                .child(div().text_lg().child(tab.title()))
                .child(
                    div()
                        .max_w(px(680.))
                        .text_color(rgb(colors(cx).muted))
                        .child(tab.message.clone()),
                )
                .when_some(tab.login_secret.clone(), |el, input| {
                    el.child(
                        column()
                            .w(px(320.))
                            .gap_3()
                            .child(Input::new(&input))
                            .child(button("saved-host-login", "连接").primary().on_click(
                                cx.listener(move |view, _, window, cx| {
                                    view.submit_login_secret(id, window, cx);
                                }),
                            )),
                    )
                })
                .when(tab.state == ConnectionState::Disconnected, |el| {
                    let profile = tab.profile.clone();
                    el.child(button("reconnect", "重新连接").on_click(cx.listener(
                        move |view, _, window, cx| {
                            view.close_tab(id, window, cx);
                            view.begin_connection(
                                profile.clone(),
                                Credentials::default(),
                                window,
                                cx,
                            );
                        },
                    )))
                })
                .into_any_element();
        }
        self.render_session(tab, cx)
    }
    fn render_transfers(&self, session_id: SessionId, cx: &mut Context<Self>) -> impl IntoElement {
        let indices: Vec<_> = self
            .transfers
            .iter()
            .enumerate()
            .filter(|(_, t)| t.session_id == session_id)
            .map(|(i, _)| i)
            .collect();
        column()
            .h(px(190.))
            .flex_shrink_0()
            .bg(panel(cx))
            .border_t_1()
            .border_color(rgb(colors(cx).border))
            .child(
                row()
                    .h(px(30.))
                    .px_3()
                    .text_xs()
                    .text_color(rgb(colors(cx).muted))
                    .child("当前连接 · 传输队列")
                    .child(div().flex_1())
                    .child("暂停保留当前进度 · 重试重新开始"),
            )
            .child(
                uniform_list(
                    "transfers",
                    indices.len(),
                    cx.processor(move |view, range: std::ops::Range<usize>, _, cx| {
                        range
                            .map(|index| {
                                let transfer = &view.transfers[indices[index]];
                                let id = transfer.id;
                                let finished = transfer.status.finished();
                                let paused = transfer.status == TransferStatus::Paused;
                                let status = match transfer.status {
                                    TransferStatus::Queued => "排队",
                                    TransferStatus::Running => "传输中",
                                    TransferStatus::Paused => "已暂停",
                                    TransferStatus::WaitingConflict => "等待处理",
                                    TransferStatus::Completed if transfer.skipped_files > 0 => {
                                        "完成（含跳过）"
                                    }
                                    TransferStatus::Completed => "已完成",
                                    TransferStatus::Cancelled => "已取消",
                                    TransferStatus::Failed => "失败",
                                };
                                row()
                                    .id(index)
                                    .w_full()
                                    .h(px(48.))
                                    .px_3()
                                    .gap_3()
                                    .border_b_1()
                                    .border_color(rgb(colors(cx).border))
                                    .child(div().text_color(rgb(colors(cx).accent)).child(
                                        if transfer.direction == TransferDirection::Upload {
                                            "↑"
                                        } else {
                                            "↓"
                                        },
                                    ))
                                    .child(
                                        column()
                                            .flex_1()
                                            .child(div().truncate().child(transfer.name.clone()))
                                            .child(
                                                div()
                                                    .text_xs()
                                                    .text_color(rgb(colors(cx).muted))
                                                    .truncate()
                                                    .child(transfer.error.clone().unwrap_or_else(
                                                        || {
                                                            format!(
                                                                "{} → {}",
                                                                transfer.source,
                                                                transfer.destination
                                                            )
                                                        },
                                                    )),
                                            ),
                                    )
                                    .child(
                                        div()
                                            .w(px(190.))
                                            .text_xs()
                                            .text_color(rgb(colors(cx).muted))
                                            .child(format!(
                                                "{status}  {} / {}",
                                                bytes(transfer.transferred_bytes),
                                                bytes(transfer.total_bytes)
                                            )),
                                    )
                                    .when(!finished, |el| {
                                        el.child(
                                            button(
                                                ("pause", index),
                                                if paused { "继续" } else { "暂停" },
                                            )
                                            .disabled(
                                                transfer.status == TransferStatus::WaitingConflict,
                                            )
                                            .on_click(
                                                cx.listener(move |view, _, window, cx| {
                                                    view.transfer_control(
                                                        id,
                                                        if paused { 1 } else { 0 },
                                                        window,
                                                        cx,
                                                    )
                                                }),
                                            ),
                                        )
                                        .child(
                                            button(("cancel", index), "取消").on_click(
                                                cx.listener(move |view, _, window, cx| {
                                                    view.transfer_control(id, 2, window, cx)
                                                }),
                                            ),
                                        )
                                    })
                                    .when(finished, |el| {
                                        el.child(button(("retry", index), "重试").on_click(
                                            cx.listener(move |view, _, window, cx| {
                                                view.transfer_control(id, 3, window, cx)
                                            }),
                                        ))
                                        .child(
                                            button(("remove", index), "移除").on_click(
                                                cx.listener(move |view, _, window, cx| {
                                                    view.transfer_control(id, 4, window, cx)
                                                }),
                                            ),
                                        )
                                    })
                            })
                            .collect()
                    }),
                )
                .flex_1()
                .min_h_0(),
            )
    }
    fn render_modal(&self, cx: &mut Context<Self>) -> Option<AnyElement> {
        // Separate builders keep debug-mode UI temporaries off a single large stack frame.
        if let Some(prompt) = self.prompts.front() {
            Some(self.render_prompt(prompt, cx))
        } else {
            self.form
                .as_ref()
                .map(|form| self.render_connection_modal(form, cx))
        }
    }
    fn render_prompt(&self, prompt: &Prompt, cx: &mut Context<Self>) -> AnyElement {
        let (title, body, buttons) = match prompt {
            Prompt::Host(host) => (
                "核对 SSH 主机指纹".to_string(),
                column()
                    .gap_3()
                    .child(format!("首次连接 {}:{}", host.host, host.port))
                    .child(
                        div()
                            .text_xs()
                            .font_family(cx.theme().mono_font_family.clone())
                            .child(host.fingerprint.clone()),
                    )
                    .child(div().text_color(rgb(colors(cx).muted)).child(
                        "请与服务器管理员提供的指纹核对。接受后会保存，指纹变化将阻止连接。",
                    ))
                    .into_any_element(),
                row()
                    .gap_2()
                    .justify_end()
                    .child(
                        button("reject-key", "拒绝")
                            .on_click(cx.listener(|view, _, _, cx| view.answer_host(false, cx))),
                    )
                    .child(
                        button("trust-key", "信任并连接")
                            .primary()
                            .on_click(cx.listener(|view, _, _, cx| view.answer_host(true, cx))),
                    )
                    .into_any_element(),
            ),
            Prompt::Conflict { path, .. } => (
                "目标已存在".into(),
                column()
                    .gap_2()
                    .child(path.clone())
                    .child("请选择如何处理这个文件。目录中的其他文件会继续逐个检查。")
                    .into_any_element(),
                row()
                    .gap_2()
                    .justify_end()
                    .child(button("conflict-cancel", "取消任务").on_click(
                        cx.listener(|v, _, _, cx| v.answer_conflict(ConflictDecision::Cancel, cx)),
                    ))
                    .child(button("conflict-skip", "跳过").on_click(
                        cx.listener(|v, _, _, cx| v.answer_conflict(ConflictDecision::Skip, cx)),
                    ))
                    .child(
                        button("conflict-overwrite", "覆盖")
                            .primary()
                            .on_click(cx.listener(|v, _, _, cx| {
                                v.answer_conflict(ConflictDecision::Overwrite, cx)
                            })),
                    )
                    .into_any_element(),
            ),
            Prompt::Name { title, input, .. } => (
                title.clone(),
                Input::new(input).into_any_element(),
                row()
                    .gap_2()
                    .justify_end()
                    .child(
                        button("cancel-op", "取消").on_click(cx.listener(|v, _, _, cx| {
                            v.prompts.pop_front();
                            cx.notify();
                        })),
                    )
                    .child(
                        button("confirm-op", "确定")
                            .primary()
                            .on_click(cx.listener(|v, _, w, cx| v.confirm_operation(w, cx))),
                    )
                    .into_any_element(),
            ),
            Prompt::Delete { entries, .. } => (
                "删除远端文件".into(),
                column()
                    .gap_2()
                    .child(format!("删除所选的 {} 项？", entries.len()))
                    .child(
                        div().text_color(rgb(colors(cx).muted)).child(
                            entries
                                .iter()
                                .take(8)
                                .map(|e| e.name.clone())
                                .collect::<Vec<_>>()
                                .join("、"),
                        ),
                    )
                    .child("目录及其内容会递归删除，此操作无法撤销。")
                    .into_any_element(),
                row()
                    .gap_2()
                    .justify_end()
                    .child(
                        button("cancel-delete", "取消").on_click(cx.listener(|v, _, _, cx| {
                            v.prompts.pop_front();
                            cx.notify();
                        })),
                    )
                    .child(
                        button("confirm-delete", "确认删除")
                            .primary()
                            .on_click(cx.listener(|v, _, w, cx| v.confirm_operation(w, cx))),
                    )
                    .into_any_element(),
            ),
        };
        overlay(
            &self.modal_focus,
            column()
                .w(px(580.))
                .p_5()
                .gap_5()
                .rounded_lg()
                .bg(panel(cx))
                .border_1()
                .border_color(rgb(colors(cx).border))
                .child(div().text_lg().child(title))
                .child(body)
                .child(buttons),
        )
        .into_any_element()
    }
    fn render_connection_modal(&self, form: &ConnectionForm, cx: &mut Context<Self>) -> AnyElement {
        let selected_id = form.profile.id.clone();
        let editing = self.profiles.iter().any(|p| p.id == selected_id);
        let c = colors(cx);
        let weak = cx.entity().downgrade();
        let selected_auth = form.profile.auth.clone();
        let auth_menu = button("auth-selector", auth_label(&selected_auth))
            .dropdown_caret(true)
            .w_full()
            .h(px(34.))
            .justify_between()
            .disabled(form.busy)
            .dropdown_menu(move |mut menu, _, _| {
                for auth in [
                    AuthMethod::Password,
                    AuthMethod::PrivateKey,
                    AuthMethod::Agent,
                ] {
                    let weak = weak.clone();
                    let selected = selected_auth == auth;
                    menu = menu.item(
                        PopupMenuItem::new(auth_label(&auth))
                            .checked(selected)
                            .on_click(move |_, window, cx| {
                                let _ = weak.update(cx, |v, cx| {
                                    v.select_authentication(auth.clone(), window, cx);
                                });
                            }),
                    );
                }
                menu
            });
        let protocols =
            row()
                .gap_2()
                .children([Protocol::Ssh, Protocol::Sftp].into_iter().enumerate().map(
                    |(i, protocol)| {
                        let chosen = form.profile.protocol == protocol;
                        button(("protocol", i), protocol_label(&protocol))
                            .icon(if protocol == Protocol::Ssh {
                                IconName::Terminal
                            } else {
                                IconName::FolderOpen
                            })
                            .flex_1()
                            .h(px(40.))
                            .selected(chosen)
                            .toggled(chosen)
                            .disabled(form.busy)
                            .when(chosen, |b| {
                                b.bg(rgb(c.selection))
                                    .border_color(rgb(c.accent))
                                    .text_color(rgb(c.text))
                            })
                            .on_click(cx.listener(move |v, _, _, cx| {
                                v.select_protocol(protocol.clone(), cx);
                            }))
                    },
                ));
        let key_button = button("choose-private-key", "选择文件…")
            .icon(IconName::FolderOpen)
            .h(px(34.))
            .disabled(form.busy)
            .on_click(cx.listener(|v, _, w, cx| v.choose_private_key(w, cx)));
        let x11_enabled = form.profile.x11.enabled;
        let x11_toggle = tool(
            "x11-forwarding",
            IconName::Monitor,
            if x11_enabled {
                "关闭 X11 转发"
            } else {
                "启用 X11 转发"
            },
            x11_enabled,
        )
        .selected(x11_enabled)
        .toggled(x11_enabled)
        .disabled(form.busy)
        .on_click(cx.listener(move |v, _, _, cx| {
            v.set_x11_forwarding(!x11_enabled, cx);
        }));
        overlay(
            &self.modal_focus,
            column()
                .w(px(680.))
                .h(px(620.))
                .max_h(relative(0.9))
                .rounded_lg()
                .overflow_hidden()
                .bg(panel(cx))
                .border_1()
                .border_color(rgb(c.border))
                .shadow_lg()
                .child(
                    row()
                        .h(px(52.))
                        .flex_shrink_0()
                        .px_4()
                        .border_b_1()
                        .border_color(rgb(c.border))
                        .child(div().font_weight(FontWeight::SEMIBOLD).child(format!(
                            "{} {} 配置",
                            if editing { "编辑" } else { "新建" },
                            protocol_label(&form.profile.protocol)
                        )))
                        .child(div().flex_1())
                        .child(
                            button("close-form", "")
                                .icon(IconName::X)
                                .accessibility_label("关闭连接配置")
                                .size(px(34.))
                                .tooltip("关闭 · Esc")
                                .disabled(form.busy)
                                .on_click(cx.listener(|v, _, w, cx| {
                                    v.form = None;
                                    if !v.settings_active && !v.home_active {
                                        v.restore_terminal_focus(w, cx);
                                    }
                                    cx.notify();
                                })),
                        ),
                )
                .child(
                    div()
                        .id("connection-form-scroll")
                        .flex_1()
                        .min_h_0()
                        .overflow_y_scroll()
                        .p_4()
                        .child(
                            column()
                                .gap_2()
                                .child(
                                    form.render(protocols, auth_menu, key_button, x11_toggle, cx),
                                )
                                .when(form.profile.auth != AuthMethod::Agent, |el| {
                                    el.child(
                                        row()
                                            .px_3()
                                            .py_2()
                                            .gap_2()
                                            .rounded_md()
                                            .border_1()
                                            .border_color(rgb(c.border))
                                            .child(
                                                Checkbox::new("remember-secret")
                                                    .label(
                                                        if form.profile.auth
                                                            == AuthMethod::PrivateKey
                                                        {
                                                            "记住私钥口令"
                                                        } else {
                                                            "记住密码"
                                                        },
                                                    )
                                                    .checked(form.profile.remember_secret)
                                                    .disabled(form.busy)
                                                    .flex_1()
                                                    .on_click(cx.listener(|v, checked, _, cx| {
                                                        if let Some(form) = &mut v.form {
                                                            form.profile.remember_secret = *checked;
                                                        }
                                                        cx.notify();
                                                    })),
                                            )
                                            .when(form.has_saved_secret, |el| {
                                                let id = selected_id.clone();
                                                el.child(
                                                    button("forget-secret", "忘记凭据")
                                                        .ghost()
                                                        .disabled(form.busy)
                                                        .on_click(cx.listener(
                                                            move |v, _, w, cx| {
                                                                if let Some(form) = &mut v.form {
                                                                    form.busy = true;
                                                                }
                                                                v.forget_secret(id.clone(), w, cx);
                                                            },
                                                        )),
                                                )
                                            }),
                                    )
                                })
                                .when(self.notice_error, |el| {
                                    el.child(
                                        div()
                                            .text_xs()
                                            .text_color(rgb(0xe87979))
                                            .child(self.notice.clone()),
                                    )
                                }),
                        ),
                )
                .child(
                    row()
                        .h(px(52.))
                        .flex_shrink_0()
                        .px_4()
                        .gap_2()
                        .border_t_1()
                        .border_color(rgb(c.border))
                        .child(
                            Icon::new(if form.profile.protocol == Protocol::Ssh {
                                IconName::Terminal
                            } else {
                                IconName::FolderOpen
                            })
                            .size(px(16.))
                            .text_color(rgb(c.muted)),
                        )
                        .when(editing, |el| {
                            el.child(
                                tool("delete-profile", IconName::Trash, "删除配置", false)
                                    .ghost()
                                    .disabled(form.busy)
                                    .on_click(cx.listener(|v, _, w, cx| v.delete_form(w, cx))),
                            )
                        })
                        .child(div().flex_1())
                        .child(
                            tool("save-profile", IconName::Save, "保存", false)
                                .disabled(form.busy)
                                .on_click(cx.listener(|v, _, w, cx| v.save_profile(w, cx))),
                        )
                        .child(
                            tool("connect", IconName::Plug, "保存并连接", true)
                                .loading(form.busy)
                                .disabled(form.busy)
                                .on_click(cx.listener(|v, _, w, cx| v.connect(w, cx))),
                        ),
                ),
        )
        .into_any_element()
    }
}
fn overlay(focus: &FocusHandle, child: impl IntoElement) -> impl IntoElement {
    div()
        .id("modal-backdrop")
        .track_focus(focus)
        .absolute()
        .inset_0()
        .flex()
        .items_center()
        .justify_center()
        .occlude()
        .bg(rgba(0x05080bb3))
        .child(
            div()
                .id("modal-card")
                .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
                .child(child),
        )
}
impl Render for Workbench {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        column()
            .relative()
            .size_full()
            .track_focus(&self.workspace_focus)
            .capture_key_down(cx.listener(Self::global_key))
            .font_family(cx.theme().font_family.clone())
            .text_size(px(14.))
            .text_color(rgb(colors(cx).text))
            .bg(rgb(colors(cx).bg))
            .when_some(self.background.clone(), |el, path| {
                el.child(
                    div().absolute().inset_0().child(
                        img(path)
                            .size_full()
                            .object_fit(ObjectFit::Cover)
                            .opacity(self.settings.background.opacity as f32 / 100.),
                    ),
                )
            })
            .child(self.render_titlebar(window, cx))
            .child(div().flex_1().min_h_0().child(self.render_workspace(cx)))
            .when_some(self.render_modal(cx), |el, modal| el.child(modal))
    }
}
