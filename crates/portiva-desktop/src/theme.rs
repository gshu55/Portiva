use gpui_kit::assets::IconName;
use gpui_kit::component::{ActiveTheme, Theme, ThemeMode};
use gpui_kit::component::{
    Icon, Sizable,
    button::{Button, ButtonVariants},
};
use gpui_kit::{prelude::*, *};
use portiva_core::{Settings, ThemeMode as PreferenceMode};

#[derive(Clone, Copy)]
pub struct UiColors {
    pub bg: u32,
    pub panel: u32,
    pub border: u32,
    pub text: u32,
    pub muted: u32,
    pub accent: u32,
    pub hover: u32,
    pub selection: u32,
}
#[derive(Default)]
struct Appearance {
    background: bool,
}
impl Global for Appearance {}
pub fn colors(cx: &App) -> UiColors {
    if cx.theme().is_dark() {
        UiColors {
            bg: 0x101316,
            panel: 0x14191d,
            border: 0x2a3035,
            text: 0xe5eaf0,
            muted: 0x96a3ad,
            accent: 0x409eff,
            hover: 0x202930,
            selection: 0x1d3449,
        }
    } else {
        UiColors {
            bg: 0xf5f7fa,
            panel: 0xffffff,
            border: 0xdce1e6,
            text: 0x283440,
            muted: 0x6b7885,
            accent: 0x2584e6,
            hover: 0xeaf0f7,
            selection: 0xdbeafe,
        }
    }
}
pub fn panel(cx: &App) -> Hsla {
    rgba((colors(cx).panel << 8) | if background_enabled(cx) { 225 } else { 255 }).into()
}
pub fn background_enabled(cx: &App) -> bool {
    cx.try_global::<Appearance>().is_some_and(|a| a.background)
}

pub fn init(cx: &mut App) {
    apply(&Settings::default(), WindowAppearance::Dark, cx);
}
pub fn apply(settings: &Settings, appearance: WindowAppearance, cx: &mut App) {
    let dark = match settings.theme {
        PreferenceMode::Dark => true,
        PreferenceMode::Light => false,
        PreferenceMode::System => matches!(
            appearance,
            WindowAppearance::Dark | WindowAppearance::VibrantDark
        ),
    };
    cx.set_global(Appearance {
        background: settings.background.enabled && settings.background.image.is_some(),
    });
    Theme::change(
        if dark {
            ThemeMode::Dark
        } else {
            ThemeMode::Light
        },
        None,
        cx,
    );
    let c = colors(cx);
    Theme::update(cx, |theme| {
        // Keep the themed 1px focus border without an additional outer ring.
        theme.focus_ring = false;
        theme.background = rgb(c.bg).into();
        theme.foreground = rgb(c.text).into();
        theme.border = rgb(c.border).into();
        theme.input = rgb(c.border).into();
        theme.secondary = rgb(c.panel).into();
        theme.secondary_foreground = rgb(c.text).into();
        theme.secondary_hover = rgb(c.hover).into();
        theme.secondary_active = rgb(c.selection).into();
        theme.muted = rgb(c.panel).into();
        theme.muted_foreground = rgb(c.muted).into();
        theme.title_bar = rgb(c.bg).into();
        theme.title_bar_border = rgb(c.border).into();
        theme.primary = rgb(c.accent).into();
        theme.primary_foreground = rgb(0xffffff).into();
        theme.primary_hover = rgb(0x66b1ff).into();
        theme.primary_active = rgb(0x267fda).into();
        theme.button_primary = theme.primary;
        theme.button_primary_foreground = theme.primary_foreground;
        theme.button_primary_hover = theme.primary_hover;
        theme.button_primary_active = theme.primary_active;
        theme.ring = rgb(c.accent).into();
    });
}

pub fn button(id: impl Into<ElementId>, label: impl Into<SharedString>) -> Button {
    Button::new(id).label(label).small()
}
pub fn tool(id: &'static str, icon: IconName, label: &'static str, active: bool) -> Button {
    Button::new(id)
        .icon(Icon::new(icon).size(px(15.)))
        .small()
        .size(px(28.))
        .accessibility_label(label)
        .tooltip(label)
        .when(active, |b| b.primary())
}
pub fn column() -> Div {
    div().flex().flex_col().min_h_0().min_w_0()
}
pub fn row() -> Div {
    div().flex().items_center().min_w_0()
}
pub fn bytes(value: u64) -> String {
    if value < 1024 {
        format!("{value} B")
    } else if value < 1024 * 1024 {
        format!("{:.1} KB", value as f64 / 1024.)
    } else if value < 1024 * 1024 * 1024 {
        format!("{:.1} MB", value as f64 / 1048576.)
    } else {
        format!("{:.2} GB", value as f64 / 1073741824.)
    }
}
