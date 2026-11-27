use crate::theme::*;
use gpui_kit::component::{
    Disableable,
    button::ButtonVariants,
    input::{Textarea, TextareaState},
};
use gpui_kit::{prelude::*, *};
use portiva_core::{
    RightClickBehavior, Settings, Shortcut, TerminalHandle, TerminalSize,
    terminal::{self, TerminalModel, TerminalSignal},
};
use std::{ops::Range, time::Duration};

actions!(portiva_terminal, [SendTab, SendBackTab]);
pub(crate) enum TerminalEvent {
    CloseRequested,
    TitleChanged,
}
pub fn init(cx: &mut App) {
    cx.bind_keys([
        KeyBinding::new("tab", SendTab, Some("PortivaTerminal")),
        KeyBinding::new("shift-tab", SendBackTab, Some("PortivaTerminal")),
    ]);
}

pub struct TerminalView {
    pub handle: TerminalHandle,
    model: TerminalModel,
    focus: FocusHandle,
    bounds: Bounds<Pixels>,
    cell_width: f32,
    selecting: bool,
    selection_position: Option<Point<Pixels>>,
    selection_task: Option<Task<()>>,
    selection_text: Option<String>,
    scroll_remainder: f32,
    composition: String,
    pub title: String,
    pub status: Option<String>,
    pub(crate) active: bool,
    pub(crate) can_close: bool,
    settings: Settings,
    context_menu: Option<Point<Pixels>>,
    pending_paste: Option<Entity<TextareaState>>,
}
impl EventEmitter<TerminalEvent> for TerminalView {}
impl TerminalView {
    pub fn new(handle: TerminalHandle, settings: Settings, cx: &mut Context<Self>) -> Self {
        let mut model = TerminalModel::new(TerminalSize::default());
        model.set_palette(settings.terminal.palette());
        model.set_highlighting(settings.terminal.highlighting.clone());
        Self {
            handle,
            model,
            focus: cx.focus_handle(),
            bounds: Bounds::default(),
            cell_width: 8.4,
            selecting: false,
            selection_position: None,
            selection_task: None,
            selection_text: None,
            scroll_remainder: 0.,
            composition: String::new(),
            title: String::new(),
            status: None,
            active: false,
            can_close: false,
            settings,
            context_menu: None,
            pending_paste: None,
        }
    }
    pub fn apply_settings(&mut self, settings: Settings, cx: &mut Context<Self>) {
        self.model.set_palette(settings.terminal.palette());
        self.model
            .set_highlighting(settings.terminal.highlighting.clone());
        self.settings = settings;
        cx.notify();
    }
    pub(crate) fn set_active(&mut self, active: bool, cx: &mut Context<Self>) {
        if self.active != active {
            self.active = active;
            cx.notify();
        }
    }
    pub(crate) fn set_can_close(&mut self, can_close: bool, cx: &mut Context<Self>) {
        if self.can_close != can_close {
            self.can_close = can_close;
            cx.notify();
        }
    }
    pub(crate) fn request_close(&self, cx: &mut Context<Self>) {
        if self.can_close && !self.has_pending_paste() {
            cx.emit(TerminalEvent::CloseRequested);
        }
    }
    pub fn feed(&mut self, bytes: &[u8], window: &mut Window, cx: &mut Context<Self>) {
        let mut title_changed = false;
        for signal in self.model.feed(bytes) {
            match signal {
                TerminalSignal::Write(bytes) => self.send(bytes),
                TerminalSignal::Title(title) => {
                    if self.title != title {
                        self.title = title;
                        title_changed = true;
                    }
                }
                TerminalSignal::Bell => {}
                TerminalSignal::ClipboardStore(text) => {
                    if self.active && self.focus.is_focused(window) && window.is_window_active() {
                        cx.write_to_clipboard(ClipboardItem::new_string(text));
                    }
                }
            }
        }
        if title_changed {
            cx.emit(TerminalEvent::TitleChanged);
        }
        cx.notify();
    }
    pub fn focus(&self, window: &mut Window, cx: &mut App) {
        window.focus(&self.focus, cx);
    }
    pub(crate) fn select_all(&mut self, cx: &mut Context<Self>) {
        self.model.select_all();
        self.selection_text = self.model.selected_text();
        cx.notify();
    }
    pub(crate) fn selected_text(&self) -> Option<String> {
        self.selection_text
            .clone()
            .or_else(|| self.model.selected_text().filter(|text| !text.is_empty()))
    }
    fn has_selection(&self) -> bool {
        self.model.has_selection() || self.selection_text.is_some()
    }
    fn clear_selection(&mut self) {
        self.model.clear_selection();
        self.selection_text = None;
        self.selecting = false;
        self.selection_position = None;
        self.selection_task = None;
    }
    pub(crate) fn has_pending_paste(&self) -> bool {
        self.pending_paste.is_some()
    }
    pub(crate) fn confirm_paste(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if let Some(input) = self.pending_paste.take() {
            self.paste_text(&input.read(cx).value());
        }
        self.focus(window, cx);
        cx.notify();
    }
    fn send(&mut self, bytes: Vec<u8>) {
        if let Err(error) = self.handle.write(bytes) {
            self.status = Some(error.to_string());
        }
    }
    fn copy(&self, cx: &mut App) {
        if let Some(text) = self.selected_text().filter(|t| !t.is_empty()) {
            cx.write_to_clipboard(ClipboardItem::new_string(text));
        }
    }
    fn paste(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.focus(window, cx);
        if let Some(text) = cx.read_from_clipboard().and_then(|c| c.text()) {
            if self.settings.terminal.confirm_multiline_paste && text.contains(['\n', '\r']) {
                let input = cx.new(|cx| TextareaState::new(window, cx).default_value(text));
                window.focus(&input.focus_handle(cx), cx);
                self.pending_paste = Some(input);
            } else {
                self.paste_text(&text);
            }
        }
    }
    fn paste_text(&mut self, text: &str) {
        self.send(self.model.paste(text));
        self.clear_selection();
        self.model.scroll_to_bottom();
    }
    fn send_tab(&mut self, shift: bool, window: &mut Window, cx: &mut Context<Self>) {
        if self.composition.is_empty() {
            if let Some(bytes) = self.model.key(
                "tab",
                terminal::Modifiers {
                    shift,
                    ..Default::default()
                },
            ) {
                self.send(bytes);
            }
            self.clear_selection();
            self.model.scroll_to_bottom();
            window.notify_text_input_changed(&self.focus);
            cx.notify();
        }
        cx.stop_propagation();
    }
    fn cell_at(&self, p: Point<Pixels>) -> (usize, usize, bool) {
        let x: f32 = (p.x - self.bounds.left()).into();
        let y: f32 = (p.y - self.bounds.top()).into();
        (
            (y.max(0.) / self.settings.terminal.line_height()) as usize,
            (x.max(0.) / self.cell_width) as usize,
            x.max(0.) % self.cell_width > self.cell_width / 2.,
        )
    }
    fn key_down(&mut self, event: &KeyDownEvent, window: &mut Window, cx: &mut Context<Self>) {
        let key = event.keystroke.key.as_str();
        let m = event.keystroke.modifiers;
        if !self.composition.is_empty() {
            return;
        }
        if shortcut_matches(&self.settings.keymap.copy, &event.keystroke)
            || (m.control && !m.alt && !m.platform && m.shift && key == "c")
            || (m.control && !m.alt && !m.platform && !m.shift && key == "insert")
            || (self.settings.terminal.copy_on_ctrl_c_when_selected
                && m.control
                && !m.alt
                && !m.platform
                && key == "c"
                && self.has_selection())
            || (cfg!(target_os = "macos")
                && m.platform
                && !m.alt
                && !m.control
                && !m.shift
                && key == "c")
        {
            self.copy(cx);
            cx.stop_propagation();
            return;
        }
        if shortcut_matches(&self.settings.keymap.paste, &event.keystroke)
            || (m.control && !m.alt && !m.platform && m.shift && key == "v")
            || (m.shift && !m.control && !m.alt && !m.platform && key == "insert")
            || (cfg!(target_os = "macos")
                && m.platform
                && !m.alt
                && !m.control
                && !m.shift
                && key == "v")
        {
            self.paste(window, cx);
            cx.stop_propagation();
            cx.notify();
            return;
        }
        if (m.control && m.shift && !m.alt && !m.platform && key == "a")
            || (cfg!(target_os = "macos")
                && m.platform
                && !m.control
                && !m.alt
                && !m.shift
                && key == "a")
        {
            self.select_all(cx);
            cx.stop_propagation();
            return;
        }
        if m.control && m.shift && !m.alt && !m.platform && matches!(key, "home" | "end") {
            if key == "home" {
                self.model.scroll_to_top();
            } else {
                self.model.scroll_to_bottom();
            }
            cx.notify();
            cx.stop_propagation();
            return;
        }
        if m.shift && !m.control && !m.alt && !m.platform && matches!(key, "pageup" | "pagedown") {
            let page = (f32::from(self.bounds.size.height) / self.settings.terminal.line_height())
                .max(1.) as i32;
            self.model
                .scroll(if key == "pageup" { page } else { -page });
            cx.notify();
            cx.stop_propagation();
            return;
        }
        if let Some(bytes) = self.model.key(key, mods(m)) {
            self.send(bytes);
            self.clear_selection();
            self.model.scroll_to_bottom();
            window.notify_text_input_changed(&self.focus);
            cx.stop_propagation();
            cx.notify();
        }
    }
    fn mouse_down(&mut self, event: &MouseDownEvent, window: &mut Window, cx: &mut Context<Self>) {
        self.focus(window, cx);
        self.context_menu = None;
        // A right click owned by Portiva must not be consumed by the foreground TUI.
        if event.button == MouseButton::Right
            && self.settings.terminal.right_click != RightClickBehavior::Disabled
        {
            match self.settings.terminal.right_click {
                RightClickBehavior::ContextMenu => {
                    self.selection_text = self.selected_text();
                    self.context_menu = Some(event.position - self.bounds.origin);
                }
                RightClickBehavior::Paste => self.paste(window, cx),
                RightClickBehavior::CopyOrPaste if self.has_selection() => self.copy(cx),
                RightClickBehavior::CopyOrPaste => self.paste(window, cx),
                RightClickBehavior::Disabled => {}
            }
            window.prevent_default();
            cx.stop_propagation();
            cx.notify();
            return;
        }
        let (r, c, _) = self.cell_at(event.position);
        let button = match event.button {
            MouseButton::Left => 0,
            MouseButton::Middle => 1,
            _ => 2,
        };
        if let Some(bytes) = self.model.mouse(button, r, c, false, mods(event.modifiers)) {
            self.clear_selection();
            self.send(bytes);
        } else if event.button == MouseButton::Left {
            self.clear_selection();
            self.model.start_selection(r, c, event.click_count >= 2);
            self.selecting = true;
            self.selection_position = Some(event.position);
            self.selection_task = Some(cx.spawn_in(window, async move |view, cx| {
                loop {
                    cx.background_executor()
                        .timer(Duration::from_millis(40))
                        .await;
                    let keep = view.update(cx, |view, cx| {
                        if !view.selecting {
                            return false;
                        }
                        if let Some(position) = view.selection_position {
                            let edge = px(view.settings.terminal.line_height());
                            let lines = if position.y < view.bounds.top() + edge {
                                3
                            } else if position.y > view.bounds.bottom() - edge {
                                -3
                            } else {
                                0
                            };
                            if lines != 0 {
                                view.model.scroll(lines);
                                let (r, c, right) = view.cell_at(position);
                                view.model.update_selection(r, c, right);
                                cx.notify();
                            }
                        }
                        true
                    });
                    if !keep.unwrap_or(false) {
                        break;
                    }
                }
            }));
        }
        window.prevent_default();
        cx.stop_propagation();
        cx.notify();
    }
    fn mouse_up(&mut self, event: &MouseUpEvent, _: &mut Window, cx: &mut Context<Self>) {
        if event.button == MouseButton::Right
            && self.settings.terminal.right_click != RightClickBehavior::Disabled
        {
            cx.stop_propagation();
            return;
        }
        if self.selecting {
            self.selection_text = self.model.selected_text().filter(|text| !text.is_empty());
            self.selecting = false;
            self.selection_position = None;
            self.selection_task = None;
            cx.notify();
            return;
        }
        let (r, c, _) = self.cell_at(event.position);
        let button = match event.button {
            MouseButton::Left => 0,
            MouseButton::Middle => 1,
            _ => 2,
        };
        if let Some(bytes) = self.model.mouse(button, r, c, true, mods(event.modifiers)) {
            self.send(bytes);
        }
        cx.notify();
    }
    fn mouse_move(&mut self, event: &MouseMoveEvent, _: &mut Window, cx: &mut Context<Self>) {
        if self.selecting && event.pressed_button == Some(MouseButton::Left) {
            self.selection_position = Some(event.position);
            let (r, c, right) = self.cell_at(event.position);
            self.model.update_selection(r, c, right);
            cx.notify();
        } else if !self.has_selection() {
            let (r, c, _) = self.cell_at(event.position);
            let button = event.pressed_button.map(|button| match button {
                MouseButton::Left => 0,
                MouseButton::Middle => 1,
                _ => 2,
            });
            if let Some(bytes) = self.model.mouse_motion(button, r, c, mods(event.modifiers)) {
                self.send(bytes);
            }
        }
    }
    fn scroll(&mut self, event: &ScrollEvent, _: &mut Window, cx: &mut Context<Self>) {
        let line_height = self.settings.terminal.line_height();
        let delta: f32 = event.delta.pixel_delta(px(line_height)).y.into();
        let amount = self.scroll_remainder + delta / line_height;
        let lines = amount.trunc() as i32;
        self.scroll_remainder = amount - lines as f32;
        if lines != 0 {
            let (r, c, _) = self.cell_at(event.position);
            if self.model.mouse_enabled() && !event.modifiers.shift {
                for _ in 0..lines.unsigned_abs().min(20) {
                    if let Some(bytes) = self.model.mouse(
                        if lines > 0 { 64 } else { 65 },
                        r,
                        c,
                        false,
                        mods(event.modifiers),
                    ) {
                        self.send(bytes);
                    }
                }
            } else if self.model.alternate_scroll() && !event.modifiers.shift {
                if let Some(bytes) = self.model.key(
                    if lines > 0 { "up" } else { "down" },
                    terminal::Modifiers::default(),
                ) {
                    self.send(bytes.repeat(lines.unsigned_abs().min(20) as usize));
                }
            } else {
                self.model.scroll(lines);
            }
            cx.notify();
            cx.stop_propagation();
        }
    }
    fn cursor_bounds(&self) -> Bounds<Pixels> {
        let (row, col) = self.model.cursor_position().unwrap_or((0, 0));
        Bounds::new(
            self.bounds.origin
                + point(
                    px(col as f32 * self.cell_width),
                    px(row as f32 * self.settings.terminal.line_height()),
                ),
            size(
                px(self.cell_width),
                px(self.settings.terminal.line_height()),
            ),
        )
    }
}
pub fn shortcut_matches(shortcut: &str, keystroke: &Keystroke) -> bool {
    let m = keystroke.modifiers;
    shortcut.parse::<Shortcut>().is_ok_and(|shortcut| {
        shortcut.matches(&keystroke.key, m.control, m.shift, m.alt, m.platform)
    })
}
fn mods(m: Modifiers) -> terminal::Modifiers {
    terminal::Modifiers {
        control: m.control,
        alt: m.alt,
        shift: m.shift,
    }
}

struct TextSpan<'a> {
    cell: &'a terminal::Cell,
    text: String,
    end_column: usize,
    ascii: bool,
}

// Shape adjacent monospace ASCII together. Keep wide/combining glyphs anchored
// to their grid cells, so batching cannot shift a TUI's columns.
fn text_spans(cells: &[terminal::Cell]) -> Vec<TextSpan<'_>> {
    let mut spans: Vec<TextSpan<'_>> = Vec::new();
    for cell in cells {
        let ascii = cell.text.len() == 1 && cell.text.is_ascii();
        if let Some(span) = spans.last_mut()
            && ascii
            && span.ascii
            && span.cell.row == cell.row
            && span.end_column <= cell.column
            && (span.end_column == cell.column || (!cell.underline && !cell.strikeout))
            && span.cell.foreground == cell.foreground
            && span.cell.bold == cell.bold
            && span.cell.italic == cell.italic
            && span.cell.underline == cell.underline
            && span.cell.strikeout == cell.strikeout
        {
            span.text
                .extend(std::iter::repeat_n(' ', cell.column - span.end_column));
            span.text.push_str(&cell.text);
            span.end_column = cell.column + 1;
        } else {
            spans.push(TextSpan {
                cell,
                text: cell.text.clone(),
                end_column: cell.column + if cell.wide { 2 } else { 1 },
                ascii,
            });
        }
    }
    spans
}

impl Focusable for TerminalView {
    fn focus_handle(&self, _: &App) -> FocusHandle {
        self.focus.clone()
    }
}

impl Render for TerminalView {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let entity = cx.entity();
        let painter = entity.clone();
        let c = colors(cx);
        column()
            .relative()
            .size_full()
            .when(!background_enabled(cx), |el| {
                el.bg(rgb(self.settings.terminal.palette().background))
            })
            .child(
                row()
                    .on_mouse_down(
                        MouseButton::Left,
                        cx.listener(|view, _, window, cx| {
                            view.focus(window, cx);
                        }),
                    )
                    .px_3()
                    .gap_2()
                    .h(px(30.))
                    .flex_shrink_0()
                    .bg(panel(cx))
                    .when(self.active, |el| {
                        el.bg(rgba(
                            (c.selection << 8) | if background_enabled(cx) { 235 } else { 255 },
                        ))
                    })
                    .border_b_1()
                    .border_color(rgb(c.border))
                    .text_xs()
                    .text_color(rgb(if self.active { c.accent } else { c.muted }))
                    .child(
                        div()
                            .w(px(3.))
                            .h(px(12.))
                            .flex_shrink_0()
                            .rounded_full()
                            .bg(rgb(if self.active { c.accent } else { c.border })),
                    )
                    .child(
                        div()
                            .flex_1()
                            .truncate()
                            .when(self.active, |el| el.font_weight(FontWeight::MEDIUM))
                            .child(if self.title.is_empty() {
                                "TERMINAL".to_string()
                            } else {
                                self.title.clone()
                            }),
                    )
                    .when(self.model.is_scrolled(), |el| {
                        el.child(
                            tool(
                                "terminal-scroll-bottom",
                                gpui_kit::assets::IconName::ChevronDown,
                                "回到最新输出（Ctrl+Shift+End）",
                                false,
                            )
                            .on_click(cx.listener(|v, _, w, cx| {
                                v.model.scroll_to_bottom();
                                v.focus(w, cx);
                                cx.notify();
                            })),
                        )
                    })
                    .child(
                        div()
                            .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
                            .child(
                                tool(
                                    "terminal-close",
                                    gpui_kit::assets::IconName::X,
                                    "关闭此终端（至少保留一个）",
                                    false,
                                )
                                .ghost()
                                .size(px(24.))
                                .disabled(!self.can_close || self.has_pending_paste())
                                .on_click(cx.listener(
                                    |v, _, _, cx| {
                                        cx.stop_propagation();
                                        v.request_close(cx);
                                    },
                                )),
                            ),
                    ),
            )
            .child(
                div()
                    .id("terminal-input")
                    .relative()
                    .flex_1()
                    .min_h_0()
                    .p_2()
                    .overflow_hidden()
                    .track_focus(&self.focus)
                    .key_context("PortivaTerminal")
                    .on_action(cx.listener(|v, _: &SendTab, w, cx| v.send_tab(false, w, cx)))
                    .on_action(cx.listener(|v, _: &SendBackTab, w, cx| v.send_tab(true, w, cx)))
                    .cursor(CursorStyle::IBeam)
                    .on_key_down(cx.listener(Self::key_down))
                    .on_mouse_down(MouseButton::Left, cx.listener(Self::mouse_down))
                    .on_mouse_down(MouseButton::Right, cx.listener(Self::mouse_down))
                    .on_mouse_up(MouseButton::Left, cx.listener(Self::mouse_up))
                    .on_mouse_up(MouseButton::Right, cx.listener(Self::mouse_up))
                    .on_mouse_up_out(
                        MouseButton::Left,
                        cx.listener(|v, event, w, cx| {
                            if v.selecting {
                                v.mouse_up(event, w, cx);
                            }
                        }),
                    )
                    .on_mouse_move(cx.listener(Self::mouse_move))
                    .on_scroll(cx.listener(Self::scroll))
                    .child(
                        canvas(
                            move |bounds, window, cx| {
                                let settings = entity.read(cx).settings.terminal.clone();
                                let sample = window.text_system().shape_line(
                                    "M".into(),
                                    px(f32::from(settings.font_size)),
                                    &[TextRun {
                                        len: 1,
                                        font: font(SharedString::from(
                                            settings.font_family.clone(),
                                        )),
                                        color: rgb(colors(cx).text).into(),
                                        ..Default::default()
                                    }],
                                    None,
                                );
                                let width: f32 = sample.width.into();
                                entity.update(cx, |view, cx| {
                                    view.bounds = bounds;
                                    view.cell_width = width.max(1.);
                                    let width: f32 = bounds.size.width.into();
                                    let height: f32 = bounds.size.height.into();
                                    let size = TerminalSize {
                                        columns: ((width / view.cell_width) as u16).clamp(2, 1000),
                                        rows: ((height / settings.line_height()) as u16)
                                            .clamp(1, 500),
                                    };
                                    if view.model.resize(size) {
                                        if let Err(error) = view.handle.resize(size) {
                                            view.status = Some(error.to_string());
                                        }
                                        cx.notify();
                                    }
                                    (
                                        view.model.snapshot(),
                                        view.cell_width,
                                        view.composition.clone(),
                                        view.focus.clone(),
                                        settings,
                                    )
                                })
                            },
                            move |bounds,
                                  (snapshot, width, composition, focus, settings),
                                  window,
                                  cx| {
                                let line_height = settings.line_height();
                                let font_size = f32::from(settings.font_size);
                                let palette = settings.palette();
                                window.handle_input(
                                    &focus,
                                    ElementInputHandler::new(bounds, painter.clone()),
                                    cx,
                                );
                                for cell in &snapshot.cells {
                                    let origin = bounds.origin
                                        + point(
                                            px(cell.column as f32 * width),
                                            px(cell.row as f32 * line_height),
                                        );
                                    if cell.background != palette.background {
                                        window.paint_quad(fill(
                                            Bounds::new(
                                                origin,
                                                size(
                                                    px(width * if cell.wide { 2. } else { 1. }),
                                                    px(line_height),
                                                ),
                                            ),
                                            rgb(cell.background),
                                        ));
                                    }
                                }
                                for span in text_spans(&snapshot.cells) {
                                    let cell = span.cell;
                                    let origin = bounds.origin
                                        + point(
                                            px(cell.column as f32 * width),
                                            px(cell.row as f32 * line_height),
                                        );
                                    let mut cell_font =
                                        font(SharedString::from(settings.font_family.clone()));
                                    if cell.bold {
                                        cell_font = cell_font.bold();
                                    }
                                    if cell.italic {
                                        cell_font = cell_font.italic();
                                    }
                                    let len = span.text.len();
                                    let run = TextRun {
                                        len,
                                        font: cell_font,
                                        color: rgb(cell.foreground).into(),
                                        underline: cell.underline.then_some(UnderlineStyle {
                                            thickness: px(1.),
                                            color: None,
                                            wavy: false,
                                        }),
                                        strikethrough: cell.strikeout.then_some(
                                            StrikethroughStyle {
                                                thickness: px(1.),
                                                color: None,
                                            },
                                        ),
                                        ..Default::default()
                                    };
                                    let line = window.text_system().shape_line(
                                        span.text.into(),
                                        px(font_size),
                                        &[run],
                                        None,
                                    );
                                    let _ = line.paint(
                                        origin,
                                        px(line_height),
                                        TextAlign::Left,
                                        None,
                                        window,
                                        cx,
                                    );
                                }
                                if let Some((row, col)) = snapshot.cursor {
                                    let origin = bounds.origin
                                        + point(
                                            px(col as f32 * width),
                                            px(row as f32 * line_height),
                                        );
                                    if focus.is_focused(window) && !snapshot.scrolled {
                                        window.paint_quad(fill(
                                            Bounds::new(origin, size(px(2.), px(line_height))),
                                            rgb(palette.cursor),
                                        ));
                                    }
                                    if !composition.is_empty() {
                                        let len = composition.len();
                                        let line = window.text_system().shape_line(
                                            composition.into(),
                                            px(font_size),
                                            &[TextRun {
                                                len,
                                                font: font(SharedString::from(
                                                    settings.font_family.clone(),
                                                )),
                                                color: rgb(palette.cursor).into(),
                                                background_color: Some(
                                                    rgb(colors(cx).panel).into(),
                                                ),
                                                underline: Some(UnderlineStyle {
                                                    thickness: px(1.),
                                                    ..Default::default()
                                                }),
                                                ..Default::default()
                                            }],
                                            None,
                                        );
                                        let _ = line.paint(
                                            origin,
                                            px(line_height),
                                            TextAlign::Left,
                                            None,
                                            window,
                                            cx,
                                        );
                                    }
                                }
                            },
                        )
                        .size_full(),
                    ),
            )
            .when_some(self.status.clone(), |el, status| {
                el.child(
                    div()
                        .px_3()
                        .py_1()
                        .text_xs()
                        .text_color(rgb(0xe6a18e))
                        .child(status),
                )
            })
            .when_some(self.context_menu, |el, position| {
                el.child(
                    column()
                        .id("terminal-context-menu")
                        .absolute()
                        .left(
                            position
                                .x
                                .min(self.bounds.size.width - px(180.))
                                .max(px(0.)),
                        )
                        .top(
                            (position.y + px(30.))
                                .min(self.bounds.size.height - px(90.))
                                .max(px(0.)),
                        )
                        .w(px(180.))
                        .p_2()
                        .gap_2()
                        .rounded_md()
                        .bg(panel(cx))
                        .border_1()
                        .border_color(rgb(colors(cx).border))
                        .occlude()
                        .child(
                            button("terminal-copy", "复制选中内容")
                                .disabled(!self.has_selection())
                                .on_click(cx.listener(|v, _, w, cx| {
                                    v.copy(cx);
                                    v.context_menu = None;
                                    v.focus(w, cx);
                                    cx.notify();
                                })),
                        )
                        .child(button("terminal-select-all", "全选").on_click(cx.listener(
                            |v, _, w, cx| {
                                v.select_all(cx);
                                v.context_menu = None;
                                v.focus(w, cx);
                                cx.notify();
                            },
                        )))
                        .child(button("terminal-paste", "粘贴").on_click(cx.listener(
                            |v, _, w, cx| {
                                v.context_menu = None;
                                v.paste(w, cx);
                                cx.notify();
                            },
                        ))),
                )
            })
            .when_some(self.pending_paste.clone(), |el, input| {
                let text = input.read(cx).value();
                let summary = format!(
                    "{} 行 · {} 字符，确认后发送到当前终端。",
                    text.lines().count().max(1),
                    text.chars().count()
                );
                let height = (self.bounds.size.height - px(190.)).clamp(px(80.), px(360.));
                el.child(
                    div()
                        .absolute()
                        .inset_0()
                        .flex()
                        .items_center()
                        .justify_center()
                        .p_3()
                        .bg(rgba(0x060b13bf))
                        .occlude()
                        .child(
                            column()
                                .w_full()
                                .max_w(px(760.))
                                .p_4()
                                .gap_3()
                                .bg(panel(cx))
                                .border_1()
                                .border_color(rgb(colors(cx).border))
                                .rounded_lg()
                                .child(div().text_lg().child("确认多行粘贴"))
                                .child(div().text_xs().child(summary))
                                .child(Textarea::new(&input).h(height))
                                .child(
                                    row()
                                        .justify_end()
                                        .gap_2()
                                        .child(button("paste-cancel", "取消").on_click(
                                            cx.listener(|v, _, w, cx| {
                                                v.pending_paste = None;
                                                v.focus(w, cx);
                                                cx.notify();
                                            }),
                                        ))
                                        .child(
                                            button("paste-confirm", "确认粘贴").primary().on_click(
                                                cx.listener(|v, _, w, cx| v.confirm_paste(w, cx)),
                                            ),
                                        ),
                                ),
                        ),
                )
            })
    }
}

// The IME owns preedit text. Only the commit callback writes to the SSH channel.
impl EntityInputHandler for TerminalView {
    fn text_for_range(
        &mut self,
        range: Range<usize>,
        actual: &mut Option<Range<usize>>,
        _: &mut Window,
        _: &mut Context<Self>,
    ) -> Option<String> {
        let text: Vec<u16> = self.composition.encode_utf16().collect();
        let start = range.start.min(text.len());
        let end = range.end.min(text.len()).max(start);
        *actual = Some(start..end);
        Some(String::from_utf16_lossy(&text[start..end]))
    }
    fn selected_text_range(
        &mut self,
        _: bool,
        _: &mut Window,
        _: &mut Context<Self>,
    ) -> Option<UTF16Selection> {
        let n = self.composition.encode_utf16().count();
        Some(UTF16Selection {
            range: n..n,
            reversed: false,
        })
    }
    fn set_selected_text_range(&mut self, _: Range<usize>, _: &mut Window, _: &mut Context<Self>) {}
    fn text_length_utf16(&mut self, _: &mut Window, _: &mut Context<Self>) -> Option<usize> {
        Some(self.composition.encode_utf16().count())
    }
    fn marked_text_range(&self, _: &mut Window, _: &mut Context<Self>) -> Option<Range<usize>> {
        (!self.composition.is_empty()).then(|| 0..self.composition.encode_utf16().count())
    }
    fn unmark_text(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.composition.clear();
        window.notify_text_input_changed(&self.focus);
        cx.notify();
    }
    fn replace_text_in_range(
        &mut self,
        _: Option<Range<usize>>,
        text: &str,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.composition.clear();
        self.clear_selection();
        self.model.scroll_to_bottom();
        self.send(text.as_bytes().to_vec());
        window.notify_text_input_changed(&self.focus);
        cx.notify();
    }
    fn replace_and_mark_text_in_range(
        &mut self,
        _: Option<Range<usize>>,
        text: &str,
        _: Option<Range<usize>>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.composition = text.into();
        window.notify_text_input_changed(&self.focus);
        cx.notify();
    }
    fn bounds_for_range(
        &mut self,
        _: Range<usize>,
        _: Bounds<Pixels>,
        _: &mut Window,
        _: &mut Context<Self>,
    ) -> Option<Bounds<Pixels>> {
        Some(self.cursor_bounds())
    }
    fn selection_bounds_for_range(
        &mut self,
        _: Range<usize>,
        _: Bounds<Pixels>,
        _: &mut Window,
        _: &mut Context<Self>,
    ) -> Vec<Bounds<Pixels>> {
        vec![self.cursor_bounds()]
    }
    fn character_index_for_point(
        &mut self,
        _: Point<Pixels>,
        _: &mut Window,
        _: &mut Context<Self>,
    ) -> Option<usize> {
        Some(0)
    }
}

#[cfg(test)]
mod tests {
    use super::{TerminalModel, TerminalSize, text_spans};

    #[test]
    fn batched_text_preserves_grid_positions_colors_and_unicode_boundaries() {
        let mut model = TerminalModel::new(TerminalSize {
            columns: 80,
            rows: 4,
        });
        model.feed("hello world \x1b[31mRED\x1b[0m 你好 e\u{301} done\r\nsecond line".as_bytes());
        let snapshot = model.snapshot();
        let spans = text_spans(&snapshot.cells);
        assert!(
            spans.len() < snapshot.cells.len() / 2,
            "ASCII output was still shaped per character"
        );
        assert_eq!(spans[0].text, "hello world");
        assert_eq!(spans[1].text, "RED");
        assert_ne!(spans[0].cell.foreground, spans[1].cell.foreground);
        for cell in &snapshot.cells {
            let span = spans
                .iter()
                .find(|span| {
                    span.cell.row == cell.row
                        && span.cell.column <= cell.column
                        && span.end_column > cell.column
                })
                .unwrap();
            assert_eq!(span.cell.foreground, cell.foreground);
            if cell.text.is_ascii() {
                assert_eq!(&span.text[cell.column - span.cell.column..][..1], cell.text);
            } else {
                assert_eq!(span.cell.column, cell.column);
                assert_eq!(span.text, cell.text);
            }
        }
        assert!(spans.iter().any(|span| span.text == "e\u{301}"));
        assert!(spans.iter().any(|span| span.text == "你" && span.cell.wide));
    }
}
