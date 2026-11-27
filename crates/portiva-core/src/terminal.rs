//! Headless terminal emulation. The renderer receives plain cells; no window types cross this API.
use std::{
    cell::RefCell,
    ops::Range,
    sync::{Arc, Mutex},
};

use alacritty_terminal::{
    Term,
    event::{Event, EventListener, WindowSize},
    grid::{Dimensions, Scroll},
    index::{Column, Line, Point, Side},
    selection::{Selection, SelectionType},
    term::{ClipboardType, Config, Osc52, TermMode, cell::Flags, color::Colors},
    vte::ansi::{Color, CursorShape, NamedColor, Processor, Rgb},
};

use crate::{TerminalHighlighting, TerminalPalette, TerminalSize, terminal_highlight};

pub const BACKGROUND: u32 = 0x282c34;
pub const FOREGROUND: u32 = 0xabb2bf;

#[derive(Clone, Default)]
struct EventSink(Arc<Mutex<Vec<Event>>>);
impl EventListener for EventSink {
    fn send_event(&self, event: Event) {
        self.0.lock().unwrap_or_else(|e| e.into_inner()).push(event);
    }
}

#[derive(Debug)]
pub enum TerminalSignal {
    Write(Vec<u8>),
    Title(String),
    Bell,
    ClipboardStore(String),
}

#[derive(Clone, Debug)]
pub struct Cell {
    pub row: usize,
    pub column: usize,
    pub text: String,
    pub foreground: u32,
    pub background: u32,
    pub bold: bool,
    pub italic: bool,
    pub underline: bool,
    pub strikeout: bool,
    pub wide: bool,
}

pub struct Snapshot {
    pub cells: Vec<Cell>,
    pub cursor: Option<(usize, usize)>,
    pub size: TerminalSize,
    pub scrolled: bool,
}

#[derive(Clone, Copy, Default)]
pub struct Modifiers {
    pub control: bool,
    pub alt: bool,
    pub shift: bool,
}

pub struct TerminalModel {
    term: Term<EventSink>,
    parser: Processor,
    events: EventSink,
    size: TerminalSize,
    palette: TerminalPalette,
    highlighting: TerminalHighlighting,
    revision: u64,
    highlight_cache: RefCell<HighlightCache>,
}

#[derive(Default)]
struct HighlightCache {
    key: Option<(u64, usize)>,
    colors: Vec<u32>,
}

const NO_HIGHLIGHT: u32 = u32::MAX;

impl TerminalModel {
    pub fn new(size: TerminalSize) -> Self {
        let size = clamp_size(size);
        let events = EventSink::default();
        Self {
            term: Term::new(
                Config {
                    scrolling_history: 50_000,
                    osc52: Osc52::OnlyCopy,
                    ..Default::default()
                },
                &size,
                events.clone(),
            ),
            parser: Processor::new(),
            events,
            size,
            palette: TerminalPalette::default(),
            highlighting: TerminalHighlighting::default(),
            revision: 0,
            highlight_cache: RefCell::new(HighlightCache::default()),
        }
    }

    pub fn set_palette(&mut self, palette: TerminalPalette) {
        if self.palette != palette {
            self.palette = palette;
            self.revision = self.revision.wrapping_add(1);
        }
    }

    pub fn set_highlighting(&mut self, highlighting: TerminalHighlighting) {
        if self.highlighting != highlighting {
            self.highlighting = highlighting;
            self.revision = self.revision.wrapping_add(1);
        }
    }

    pub fn feed(&mut self, data: &[u8]) -> Vec<TerminalSignal> {
        self.parser.advance(&mut self.term, data);
        self.revision = self.revision.wrapping_add(1);
        let events = std::mem::take(&mut *self.events.0.lock().unwrap_or_else(|e| e.into_inner()));
        events
            .into_iter()
            .filter_map(|event| match event {
                Event::PtyWrite(text) => Some(TerminalSignal::Write(text.into_bytes())),
                Event::Title(title) => Some(TerminalSignal::Title(normalize_title(&title))),
                Event::ResetTitle => Some(TerminalSignal::Title(String::new())),
                Event::Bell => Some(TerminalSignal::Bell),
                Event::ClipboardStore(ClipboardType::Clipboard, text) => {
                    Some(TerminalSignal::ClipboardStore(text))
                }
                Event::ColorRequest(index, format) => {
                    let color = self.term.colors()[index]
                        .unwrap_or_else(|| unpack(palette(index, &self.palette)));
                    Some(TerminalSignal::Write(format(color).into_bytes()))
                }
                Event::TextAreaSizeRequest(format) => Some(TerminalSignal::Write(
                    format(WindowSize {
                        num_lines: self.size.rows,
                        num_cols: self.size.columns,
                        cell_width: 9,
                        cell_height: 20,
                    })
                    .into_bytes(),
                )),
                // Clipboard reads are disabled; the UI decides whether to accept a copy request.
                _ => None,
            })
            .collect()
    }

    pub fn resize(&mut self, size: TerminalSize) -> bool {
        let size = clamp_size(size);
        if self.size == size {
            return false;
        }
        self.size = size;
        self.term.resize(size);
        self.revision = self.revision.wrapping_add(1);
        true
    }

    pub fn snapshot(&self) -> Snapshot {
        let content = self.term.renderable_content();
        let cursor = self.cursor_position();
        let highlighted = (self.highlighting.logs || self.highlighting.code)
            && !self.term.mode().contains(TermMode::ALT_SCREEN);
        let mut highlights = self.highlight_cache.borrow_mut();
        if highlighted && highlights.key != Some((self.revision, content.display_offset)) {
            highlights.colors = self.highlight_colors(content.display_offset);
            highlights.key = Some((self.revision, content.display_offset));
        }
        let mut cells = Vec::new();
        for indexed in content.display_iter {
            let row = indexed.point.line.0 + content.display_offset as i32;
            if row < 0 || row >= self.size.rows as i32 {
                continue;
            }
            let cell = indexed.cell;
            if cell
                .flags
                .intersects(Flags::WIDE_CHAR_SPACER | Flags::LEADING_WIDE_CHAR_SPACER)
            {
                continue;
            }
            let mut foreground = resolve_color(
                cell.fg,
                content.colors,
                cell.flags.contains(Flags::BOLD),
                &self.palette,
            );
            if highlighted
                && cell.fg == Color::Named(NamedColor::Foreground)
                && cell.bg == Color::Named(NamedColor::Background)
                && !cell
                    .flags
                    .intersects(Flags::DIM | Flags::INVERSE | Flags::HIDDEN)
            {
                let color = highlights.colors
                    [row as usize * usize::from(self.size.columns) + indexed.point.column.0];
                if color != NO_HIGHLIGHT {
                    foreground = color;
                }
            }
            let mut background = resolve_color(cell.bg, content.colors, false, &self.palette);
            if cell.flags.contains(Flags::INVERSE) {
                std::mem::swap(&mut foreground, &mut background);
            }
            if cell.flags.contains(Flags::DIM) {
                foreground = dim(foreground);
            }
            if content
                .selection
                .as_ref()
                .is_some_and(|s| s.contains(indexed.point))
            {
                background = self.palette.selection;
            }
            let mut text = if cell.flags.contains(Flags::HIDDEN) {
                " ".into()
            } else {
                cell.c.to_string()
            };
            if let Some(extra) = cell.zerowidth() {
                text.extend(extra);
            }
            if text == " "
                && background == self.palette.background
                && !cell
                    .flags
                    .intersects(Flags::ALL_UNDERLINES | Flags::STRIKEOUT)
            {
                continue;
            }
            cells.push(Cell {
                row: row as usize,
                column: indexed.point.column.0,
                text,
                foreground,
                background,
                bold: cell.flags.contains(Flags::BOLD),
                italic: cell.flags.contains(Flags::ITALIC),
                underline: cell.flags.intersects(Flags::ALL_UNDERLINES),
                strikeout: cell.flags.contains(Flags::STRIKEOUT),
                wide: cell.flags.contains(Flags::WIDE_CHAR),
            });
        }
        Snapshot {
            cells,
            cursor,
            size: self.size,
            scrolled: content.display_offset > 0,
        }
    }

    fn highlight_colors(&self, display_offset: usize) -> Vec<u32> {
        struct Glyph {
            bytes: Range<usize>,
            row: usize,
            column: usize,
        }
        let columns = usize::from(self.size.columns);
        let rows = usize::from(self.size.rows);
        let grid = self.term.grid();
        let context = grid
            .history_size()
            .saturating_sub(display_offset)
            .min(128)
            .min(32_768 / columns);
        let mut lines = Vec::new();
        let mut mappings = Vec::new();
        let mut text = String::new();
        let mut glyphs = Vec::new();
        let mut bytes = 0;
        for screen_row in -(context as i32)..rows as i32 {
            let line = &grid[Line(screen_row - display_offset as i32)];
            for column in 0..columns {
                let cell = &line[Column(column)];
                if cell
                    .flags
                    .intersects(Flags::WIDE_CHAR_SPACER | Flags::LEADING_WIDE_CHAR_SPACER)
                {
                    continue;
                }
                let start = text.len();
                text.push(if cell.flags.contains(Flags::HIDDEN) {
                    ' '
                } else {
                    cell.c
                });
                if let Some(extra) = cell.zerowidth() {
                    text.extend(extra);
                }
                bytes += text.len() - start;
                if screen_row >= 0 {
                    glyphs.push(Glyph {
                        bytes: start..text.len(),
                        row: screen_row as usize,
                        column,
                    });
                }
            }
            if !line[Column(columns - 1)].flags.contains(Flags::WRAPLINE) || bytes >= 131_072 {
                text.truncate(text.trim_end().len());
                lines.push(std::mem::take(&mut text));
                mappings.push(std::mem::take(&mut glyphs));
            }
            if bytes >= 131_072 {
                break;
            }
        }
        if !text.is_empty() {
            lines.push(text);
            mappings.push(glyphs);
        }
        let mut colors = vec![NO_HIGHLIGHT; rows * columns];
        for (spans, glyphs) in
            terminal_highlight::highlight(&lines, &self.highlighting, &self.palette)
                .into_iter()
                .zip(mappings)
        {
            let mut spans = spans.iter().peekable();
            for glyph in glyphs {
                while spans
                    .peek()
                    .is_some_and(|span| span.bytes.end <= glyph.bytes.start)
                {
                    spans.next();
                }
                if let Some(span) = spans.peek()
                    && span.bytes.start <= glyph.bytes.start
                    && glyph.bytes.start < span.bytes.end
                {
                    colors[glyph.row * columns + glyph.column] = span.color;
                }
            }
        }
        colors
    }

    pub fn scroll(&mut self, lines: i32) {
        self.term.scroll_display(Scroll::Delta(lines));
    }
    pub fn scroll_to_bottom(&mut self) {
        self.term.scroll_display(Scroll::Bottom);
    }
    pub fn scroll_to_top(&mut self) {
        self.term.scroll_display(Scroll::Top);
    }
    pub fn is_scrolled(&self) -> bool {
        self.term.grid().display_offset() > 0
    }
    pub fn alternate_scroll(&self) -> bool {
        self.term
            .mode()
            .contains(TermMode::ALT_SCREEN | TermMode::ALTERNATE_SCROLL)
    }
    pub fn cursor_position(&self) -> Option<(usize, usize)> {
        let content = self.term.renderable_content();
        let row = content.cursor.point.line.0 + content.display_offset as i32;
        (content.cursor.shape != CursorShape::Hidden && row >= 0 && row < self.size.rows as i32)
            .then_some((row.max(0) as usize, content.cursor.point.column.0))
    }
    pub fn has_selection(&self) -> bool {
        self.term.selection.as_ref().is_some_and(|s| !s.is_empty())
    }
    pub fn clear_selection(&mut self) {
        self.term.selection = None;
    }
    pub fn start_selection(&mut self, row: usize, column: usize, words: bool) {
        let point = self.grid_point(row, column);
        self.term.selection = Some(Selection::new(
            if words {
                SelectionType::Semantic
            } else {
                SelectionType::Simple
            },
            point,
            Side::Left,
        ));
    }
    pub fn update_selection(&mut self, row: usize, column: usize, right: bool) {
        let point = self.grid_point(row, column);
        if let Some(selection) = &mut self.term.selection {
            selection.update(point, if right { Side::Right } else { Side::Left });
        }
    }
    fn grid_point(&self, row: usize, column: usize) -> Point {
        Point::new(
            Line(
                row.min(self.size.rows as usize - 1) as i32
                    - self.term.grid().display_offset() as i32,
            ),
            Column(column.min(self.size.columns as usize - 1)),
        )
    }
    pub fn selected_text(&self) -> Option<String> {
        self.term.selection_to_string()
    }
    pub fn select_all(&mut self) {
        let mut selection = Selection::new(
            SelectionType::Simple,
            Point::new(self.term.grid().topmost_line(), Column(0)),
            Side::Left,
        );
        selection.update(
            Point::new(
                self.term.grid().bottommost_line(),
                Column(self.size.columns as usize - 1),
            ),
            Side::Right,
        );
        self.term.selection = Some(selection);
    }

    pub fn paste(&self, text: &str) -> Vec<u8> {
        // Remove embedded terminators so pasted text cannot escape bracketed paste mode.
        let text = text
            .replace('\u{1b}', "")
            .replace("\r\n", "\n")
            .replace('\r', "\n");
        if self.term.mode().contains(TermMode::BRACKETED_PASTE) {
            format!("\x1b[200~{text}\x1b[201~").into_bytes()
        } else {
            text.replace('\n', "\r").into_bytes()
        }
    }

    /// Printable text is committed by the platform IME; this handles control and special keys.
    pub fn key(&self, key: &str, modifiers: Modifiers) -> Option<Vec<u8>> {
        let Modifiers {
            control,
            alt,
            shift,
        } = modifiers;
        let parameter = 1 + u8::from(shift) + 2 * u8::from(alt) + 4 * u8::from(control);
        let application = self.term.mode().contains(TermMode::APP_CURSOR);
        let result = match key {
            "enter" if shift || control => format!("\x1b[13;{parameter}u"),
            "enter" => {
                if alt {
                    "\x1b\r".into()
                } else {
                    "\r".into()
                }
            }
            "backspace" => {
                if alt {
                    "\x1b\x7f".into()
                } else if control {
                    "\x08".into()
                } else {
                    "\x7f".into()
                }
            }
            "escape" => "\x1b".into(),
            "tab" if shift => "\x1b[Z".into(),
            "tab" => "\t".into(),
            "up" | "down" | "right" | "left" | "home" | "end" => {
                let suffix = match key {
                    "up" => 'A',
                    "down" => 'B',
                    "right" => 'C',
                    "left" => 'D',
                    "home" => 'H',
                    _ => 'F',
                };
                if parameter != 1 {
                    format!("\x1b[1;{parameter}{suffix}")
                } else {
                    format!("\x1b{}{suffix}", if application { 'O' } else { '[' })
                }
            }
            "insert" | "delete" | "pageup" | "pagedown" | "f5" | "f6" | "f7" | "f8" | "f9"
            | "f10" | "f11" | "f12" => {
                let number = match key {
                    "insert" => 2,
                    "delete" => 3,
                    "pageup" => 5,
                    "pagedown" => 6,
                    "f5" => 15,
                    "f6" => 17,
                    "f7" => 18,
                    "f8" => 19,
                    "f9" => 20,
                    "f10" => 21,
                    "f11" => 23,
                    _ => 24,
                };
                if parameter == 1 {
                    format!("\x1b[{number}~")
                } else {
                    format!("\x1b[{number};{parameter}~")
                }
            }
            "f1" | "f2" | "f3" | "f4" => {
                let suffix = match key {
                    "f1" => 'P',
                    "f2" => 'Q',
                    "f3" => 'R',
                    _ => 'S',
                };
                if parameter == 1 {
                    format!("\x1bO{suffix}")
                } else {
                    format!("\x1b[1;{parameter}{suffix}")
                }
            }
            _ if control && key.len() == 1 => {
                let ch = key.as_bytes()[0].to_ascii_uppercase();
                let byte = match ch {
                    b'@'..=b'_' => ch & 0x1f,
                    b' ' | b'2' => 0,
                    b'6' => 30,
                    b'-' => 31,
                    _ => return None,
                };
                let mut bytes = Vec::new();
                if alt {
                    bytes.push(27);
                }
                bytes.push(byte);
                return Some(bytes);
            }
            _ if alt && !control && key.chars().count() == 1 => format!("\x1b{key}"),
            _ => return None,
        };
        Some(result.into_bytes())
    }

    pub fn mouse_enabled(&self) -> bool {
        self.term.mode().intersects(TermMode::MOUSE_MODE)
    }
    pub fn mouse_motion(
        &self,
        button: Option<u8>,
        row: usize,
        column: usize,
        modifiers: Modifiers,
    ) -> Option<Vec<u8>> {
        let mode = self.term.mode();
        if mode.contains(TermMode::MOUSE_MOTION)
            || (button.is_some() && mode.contains(TermMode::MOUSE_DRAG))
        {
            self.mouse(32 + button.unwrap_or(3), row, column, false, modifiers)
        } else {
            None
        }
    }
    /// button: 0 left, 1 middle, 2 right, 64/65 wheel, 32 + button for drag.
    pub fn mouse(
        &self,
        button: u8,
        row: usize,
        column: usize,
        release: bool,
        modifiers: Modifiers,
    ) -> Option<Vec<u8>> {
        if !self.mouse_enabled() || modifiers.shift {
            return None;
        }
        let button = button
            + 4 * u8::from(modifiers.shift)
            + 8 * u8::from(modifiers.alt)
            + 16 * u8::from(modifiers.control);
        if self.term.mode().contains(TermMode::SGR_MOUSE) {
            Some(
                format!(
                    "\x1b[<{button};{};{}{}",
                    column + 1,
                    row + 1,
                    if release { 'm' } else { 'M' }
                )
                .into_bytes(),
            )
        } else if row < 223 && column < 223 {
            Some(vec![
                27,
                b'[',
                b'M',
                if release { 3 + 32 } else { button + 32 },
                column as u8 + 33,
                row as u8 + 33,
            ])
        } else {
            None
        }
    }
}

fn normalize_title(title: &str) -> String {
    title.chars()
        .filter(|ch| !matches!(ch, '\u{200b}' | '\u{200e}'..='\u{200f}' | '\u{202a}'..='\u{202e}' | '\u{2060}'..='\u{206f}' | '\u{feff}'))
        .map(|ch| if ch.is_control() { ' ' } else { ch })
        .collect::<String>()
        .split_whitespace().collect::<Vec<_>>().join(" ")
        .chars().take(120).collect()
}

fn clamp_size(size: TerminalSize) -> TerminalSize {
    TerminalSize {
        columns: size.columns.clamp(2, 1000),
        rows: size.rows.clamp(1, 500),
    }
}
impl Dimensions for TerminalSize {
    fn columns(&self) -> usize {
        self.columns.into()
    }
    fn screen_lines(&self) -> usize {
        self.rows.into()
    }
    fn total_lines(&self) -> usize {
        self.rows.into()
    }
}
fn unpack(color: u32) -> Rgb {
    Rgb {
        r: (color >> 16) as u8,
        g: (color >> 8) as u8,
        b: color as u8,
    }
}
fn pack(color: Rgb) -> u32 {
    (u32::from(color.r) << 16) | (u32::from(color.g) << 8) | u32::from(color.b)
}
fn dim(color: u32) -> u32 {
    let c = unpack(color);
    pack(Rgb {
        r: c.r / 2,
        g: c.g / 2,
        b: c.b / 2,
    })
}
fn resolve_color(color: Color, colors: &Colors, bold: bool, configured: &TerminalPalette) -> u32 {
    match color {
        Color::Spec(rgb) => pack(rgb),
        Color::Named(named) => {
            let mut index = named as usize;
            if bold && index < 8 {
                index += 8;
            }
            colors[index]
                .map(pack)
                .unwrap_or_else(|| palette(index, configured))
        }
        Color::Indexed(index) => colors[index as usize]
            .map(pack)
            .unwrap_or_else(|| palette(index as usize, configured)),
    }
}
fn palette(index: usize, configured: &TerminalPalette) -> u32 {
    match index {
        0..=15 => configured.ansi[index],
        16..=231 => {
            let i = index - 16;
            let value = |n| if n == 0 { 0 } else { 55 + n * 40 };
            ((value(i / 36) << 16) | (value((i / 6) % 6) << 8) | value(i % 6)) as u32
        }
        232..=255 => {
            let v = (8 + (index - 232) * 10) as u32;
            v * 0x010101
        }
        x if x == NamedColor::Background as usize => configured.background,
        x if x == NamedColor::Cursor as usize => configured.cursor,
        _ => configured.foreground,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn terminal_titles_follow_osc_changes_reset_and_preserve_unicode() {
        assert_eq!(
            normalize_title("  Codex\t·\u{202e}重构  👩‍💻  "),
            "Codex ·重构 👩‍💻"
        );
        assert_eq!(normalize_title(&"终".repeat(130)).chars().count(), 120);
        let mut model = TerminalModel::new(TerminalSize::default());
        let mut titles = Vec::new();
        for bytes in [
            b"\x1b]0;Claude CLI\x07".as_slice(),
            b"\x1b]2;Codex CLI\x1b\\",
            b"\x1b]2;\x07",
        ] {
            for signal in model.feed(bytes) {
                if let TerminalSignal::Title(title) = signal {
                    titles.push(title);
                }
            }
        }
        assert_eq!(titles, ["Claude CLI", "Codex CLI", ""]);
    }

    #[test]
    fn fragmented_unicode_color_and_alternate_screen() {
        let mut term = TerminalModel::new(TerminalSize {
            columns: 40,
            rows: 6,
        });
        let bytes = "你好 \x1b[31mred\x1b[0m".as_bytes();
        for byte in bytes {
            term.feed(&[*byte]);
        }
        let snapshot = term.snapshot();
        assert!(snapshot.cells.iter().any(|c| c.text == "你" && c.wide));
        assert!(
            snapshot
                .cells
                .iter()
                .any(|c| c.text == "r" && c.foreground == palette(1, &TerminalPalette::default()))
        );
        term.feed(b"\x1b[?1049hALT\x1b[?1049l");
        assert!(term.snapshot().cells.iter().any(|c| c.text == "你"));
    }
    #[test]
    fn terminal_modes_affect_input_and_queries_are_answered() {
        let mut term = TerminalModel::new(TerminalSize::default());
        assert_eq!(term.key("up", Modifiers::default()).unwrap(), b"\x1b[A");
        assert_eq!(term.key("tab", Modifiers::default()).unwrap(), b"\t");
        assert_eq!(
            term.key(
                "tab",
                Modifiers {
                    shift: true,
                    ..Default::default()
                }
            )
            .unwrap(),
            b"\x1b[Z"
        );
        assert_eq!(
            term.key(
                "c",
                Modifiers {
                    control: true,
                    ..Default::default()
                }
            )
            .unwrap(),
            b"\x03"
        );
        term.feed(b"\x1b[?1h\x1b[?2004h");
        assert_eq!(term.key("up", Modifiers::default()).unwrap(), b"\x1bOA");
        assert_eq!(term.paste("one\r\ntwo\x1b"), b"\x1b[200~one\ntwo\x1b[201~");
        assert!(
            term.feed(b"\x1b[6n")
                .iter()
                .any(|e| matches!(e,TerminalSignal::Write(bytes) if bytes==b"\x1b[1;1R"))
        );
    }

    #[test]
    fn palette_changes_recolor_existing_cells_but_preserve_true_color_and_osc() {
        let mut term = TerminalModel::new(TerminalSize::default());
        term.feed(b"\x1b[31mR\x1b[0mD\x1b[38;2;18;52;86mT");
        let mut custom = TerminalPalette::default();
        custom.ansi[1] = 0x123456;
        custom.foreground = 0xaabbcc;
        custom.background = 0xfdfcfb;
        term.set_palette(custom.clone());
        let cells = term.snapshot().cells;
        assert!(
            cells
                .iter()
                .any(|c| c.text == "R" && c.foreground == 0x123456)
        );
        assert!(
            cells
                .iter()
                .any(|c| c.text == "D" && c.foreground == 0xaabbcc)
        );
        assert!(
            cells
                .iter()
                .any(|c| c.text == "T" && c.foreground == 0x123456)
        );
        assert!(cells.iter().all(|c| c.background == 0xfdfcfb));
        let response = term.feed(b"\x1b]11;?\x07");
        assert!(response.iter().any(|s|matches!(s,TerminalSignal::Write(b) if String::from_utf8_lossy(b).contains("fdfd/fcfc/fbfb"))));
        term.feed(b"\x1b]4;1;rgb:ff/00/00\x07\x1b[31mO");
        term.set_palette(TerminalPalette::preset(crate::PalettePreset::Light));
        assert!(
            term.snapshot()
                .cells
                .iter()
                .any(|c| c.text == "O" && c.foreground == 0xff0000)
        );
    }
    #[test]
    fn selection_handles_wide_characters() {
        let mut term = TerminalModel::new(TerminalSize::default());
        term.feed("你好 world".as_bytes());
        term.start_selection(0, 0, false);
        term.update_selection(0, 3, true);
        assert_eq!(term.selected_text().as_deref(), Some("你好"));
    }

    #[test]
    fn display_highlighting_preserves_ansi_selection_and_alternate_screen() {
        let palette = TerminalPalette::default();
        let mut term = TerminalModel::new(TerminalSize {
            columns: 80,
            rows: 8,
        });
        term.feed(
            "ERROR 中文 e\u{301} 👩‍💻 \x1b[32mANSI\x1b[0m \x1b[38;2;171;178;191mEXPLICIT\x1b[0m"
                .as_bytes(),
        );
        let snapshot = term.snapshot();
        assert!(
            snapshot
                .cells
                .iter()
                .any(|c| c.text == "中" && c.foreground == palette.ansi[1])
        );
        assert!(
            snapshot
                .cells
                .iter()
                .any(|c| c.text == "e\u{301}" && c.foreground == palette.ansi[1])
        );
        assert!(
            snapshot
                .cells
                .iter()
                .any(|c| c.text == "A" && c.foreground == palette.ansi[2])
        );
        assert!(
            snapshot
                .cells
                .iter()
                .any(|c| c.text == "X" && c.foreground == palette.foreground)
        );
        term.start_selection(0, 0, false);
        term.update_selection(0, 79, true);
        let selected = term.selected_text().unwrap();
        assert!(selected.contains("ERROR 中文 e\u{301} 👩‍💻 ANSI EXPLICIT"));
        assert!(
            term.snapshot()
                .cells
                .iter()
                .any(|c| c.background == palette.selection)
        );
        term.set_highlighting(TerminalHighlighting {
            logs: false,
            code: false,
            ..Default::default()
        });
        assert!(
            term.snapshot()
                .cells
                .iter()
                .any(|c| c.text == "中" && c.foreground == palette.foreground)
        );
        assert_eq!(term.selected_text().unwrap(), selected);
        term.set_highlighting(TerminalHighlighting::default());
        term.feed(b"\x1b[?1049hERROR full screen");
        assert!(
            term.snapshot()
                .cells
                .iter()
                .filter(|c| c.text != " ")
                .all(|c| c.foreground == palette.foreground)
        );
        term.feed(b"\x1b[?1049l");
        assert!(
            term.snapshot()
                .cells
                .iter()
                .any(|c| c.text == "中" && c.foreground == palette.ansi[1])
        );
    }

    #[test]
    fn highlight_context_survives_scrollback_reflow_and_palette_changes() {
        let mut term = TerminalModel::new(TerminalSize {
            columns: 24,
            rows: 6,
        });
        term.feed("<html>\r\n<!-- a multiline comment\r\n".as_bytes());
        for _ in 0..20 {
            term.feed("中文 comment wraps across the terminal\r\n".as_bytes());
        }
        term.feed(b"-->\r\n</html>");
        let palette = TerminalPalette::default();
        assert!(
            term.snapshot()
                .cells
                .iter()
                .any(|c| c.text == "中" && c.foreground == palette.muted_foreground())
        );
        term.scroll(8);
        assert!(
            term.snapshot()
                .cells
                .iter()
                .filter(|c| c.text == "中")
                .all(|c| c.foreground == palette.muted_foreground())
        );
        term.resize(TerminalSize {
            columns: 40,
            rows: 8,
        });
        assert!(
            term.snapshot()
                .cells
                .iter()
                .any(|c| c.text == "中" && c.foreground == palette.muted_foreground())
        );
        let light = TerminalPalette::preset(crate::PalettePreset::Light);
        term.set_palette(light.clone());
        assert!(
            term.snapshot()
                .cells
                .iter()
                .any(|c| c.text == "中" && c.foreground == light.muted_foreground())
        );
        term.scroll_to_bottom();
        assert!(
            term.snapshot()
                .cells
                .iter()
                .any(|c| c.text == "h" && c.foreground == light.ansi[1])
        );
    }

    #[test]
    fn cat_and_live_tail_color_incremental_output_without_altering_text() {
        let palette = TerminalPalette::default();
        let mut term = TerminalModel::new(TerminalSize {
            columns: 60,
            rows: 10,
        });
        term.feed(b"demo@host:~$ tail -n 100 -f app.log\r\n2026-11-27 11:20:30 [ER");
        let _ = term.snapshot();
        term.feed("ROR] 连接失败\r\n".as_bytes());
        assert!(
            term.snapshot()
                .cells
                .iter()
                .any(|c| c.text == "连" && c.foreground == palette.ansi[1])
        );
        term.feed("[WARN] 正在重试\r\n".as_bytes());
        assert!(
            term.snapshot()
                .cells
                .iter()
                .any(|c| c.text == "重" && c.foreground == palette.ansi[3])
        );
        term.feed(b"demo@host:~$ cat Greeting.cs\r\npublic class Greeting {\r\n");
        let _ = term.snapshot();
        term.feed(b"  public void Welcome() {}\r\n}\r\n");
        assert!(
            term.snapshot()
                .cells
                .iter()
                .any(|c| c.text == "W" && c.foreground == palette.ansi[4])
        );
        term.select_all();
        let copied = term.selected_text().unwrap();
        assert!(copied.contains("[ERROR] 连接失败\n[WARN] 正在重试"));
        assert!(copied.contains("public class Greeting {\n  public void Welcome() {}"));
        term.feed(format!("\x1b[3J\x1b[2J\x1b[HERROR {}", "x".repeat(5000)).as_bytes());
        assert!(
            term.snapshot()
                .cells
                .iter()
                .any(|c| c.text == "x" && c.foreground == palette.ansi[1])
        );
    }

    #[test]
    fn cli_clipboard_requests_only_export_text_and_never_read_the_clipboard() {
        let mut term = TerminalModel::new(TerminalSize::default());
        let mut signals = Vec::new();
        for byte in b"\x1b]52;c;aGVsbG8=\x07" {
            signals.extend(term.feed(&[*byte]));
        }
        assert!(matches!(&signals[..], [TerminalSignal::ClipboardStore(text)] if text == "hello"));
        assert!(term.feed(b"\x1b]52;c;?\x07").is_empty());
        assert!(term.feed(b"\x1b]52;p;aGVsbG8=\x07").is_empty());

        term.feed(b"\x1b[?2004h");
        let text = "你好\tlong prompt\r\n".repeat(16_384);
        let paste = term.paste(&text);
        assert_eq!(
            paste,
            format!("\x1b[200~{}\x1b[201~", text.replace("\r\n", "\n")).into_bytes()
        );
        assert_eq!(
            term.paste("first\x1b[201~second"),
            b"\x1b[200~first[201~second\x1b[201~"
        );
    }

    #[test]
    fn long_output_survives_reflow_and_scrolling_without_inserting_soft_wrap_newlines() {
        let mut term = TerminalModel::new(TerminalSize {
            columns: 24,
            rows: 6,
        });
        let text = "abc你好def ".repeat(800);
        term.feed(text.as_bytes());
        term.select_all();
        assert_eq!(
            term.selected_text().unwrap().trim_end_matches('\n'),
            text.trim_end()
        );
        term.clear_selection();
        term.resize(TerminalSize {
            columns: 17,
            rows: 9,
        });
        term.select_all();
        assert_eq!(
            term.selected_text().unwrap().trim_end_matches('\n'),
            text.trim_end()
        );
        term.clear_selection();
        term.scroll_to_top();
        let first_page = term
            .snapshot()
            .cells
            .into_iter()
            .map(|c| c.text)
            .collect::<String>();
        assert!(term.is_scrolled());
        term.feed(b"\r\nnew output\r\n");
        assert_eq!(
            term.snapshot()
                .cells
                .into_iter()
                .map(|c| c.text)
                .collect::<String>(),
            first_page
        );
        term.scroll_to_bottom();
        assert!(!term.is_scrolled());

        let lines = (0..12_000)
            .map(|n| format!("line-{n:05}\r\n"))
            .collect::<String>();
        term.feed(lines.as_bytes());
        term.scroll_to_top();
        assert!(
            term.snapshot()
                .cells
                .into_iter()
                .map(|c| c.text)
                .collect::<String>()
                .starts_with("abc你好")
        );
    }

    #[test]
    fn cli_multiline_keys_and_mouse_modes_preserve_terminal_selection_override() {
        let mut term = TerminalModel::new(TerminalSize::default());
        assert_eq!(
            term.key(
                "enter",
                Modifiers {
                    shift: true,
                    ..Default::default()
                }
            )
            .unwrap(),
            b"\x1b[13;2u"
        );
        assert_eq!(
            term.key(
                "enter",
                Modifiers {
                    alt: true,
                    ..Default::default()
                }
            )
            .unwrap(),
            b"\x1b\r"
        );
        term.feed(b"\x1b[?1049h\x1b[?1006h\x1b[?1002h");
        assert!(term.alternate_scroll());
        assert_eq!(
            term.mouse_motion(Some(0), 2, 4, Modifiers::default())
                .unwrap(),
            b"\x1b[<32;5;3M"
        );
        assert!(
            term.mouse_motion(None, 2, 4, Modifiers::default())
                .is_none()
        );
        assert!(
            term.mouse(
                0,
                2,
                4,
                false,
                Modifiers {
                    shift: true,
                    ..Default::default()
                }
            )
            .is_none()
        );
        term.feed(b"\x1b[?1002l\x1b[?1049l");
        assert!(!term.alternate_scroll());
        assert!(
            term.mouse_motion(Some(0), 2, 4, Modifiers::default())
                .is_none()
        );
    }
}
