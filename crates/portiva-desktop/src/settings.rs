use crate::{jobs, theme::*};
use anyhow::{Context as _, Result, ensure};
use gpui_kit::component::{
    Icon, Sizable,
    button::ButtonVariants,
    checkbox::Checkbox,
    color_picker::{ColorPicker, ColorPickerEvent, ColorPickerState},
    input::{Input, InputEvent, InputState},
    select::{SearchableVec, Select, SelectEvent, SelectState},
    slider::{Slider, SliderEvent, SliderState},
};
use gpui_kit::{assets::IconName, prelude::*, *};
use portiva_core::{
    CodeLanguage, PalettePreset, RightClickBehavior, Settings, TerminalPalette, ThemeMode,
};
use std::{
    io::Cursor,
    path::{Path, PathBuf},
};

pub enum SettingsEvent {
    Change(Box<Settings>),
}

const CODE_LANGUAGES: &[(CodeLanguage, &str)] = &[
    (CodeLanguage::Auto, "自动识别"),
    (CodeLanguage::Html, "HTML"),
    (CodeLanguage::Css, "CSS"),
    (CodeLanguage::CSharp, "C#"),
    (CodeLanguage::JavaScript, "JavaScript"),
    (CodeLanguage::Json, "JSON"),
    (CodeLanguage::Rust, "Rust"),
    (CodeLanguage::Python, "Python"),
    (CodeLanguage::Shell, "Shell"),
];
pub struct SettingsView {
    pub settings: Settings,
    section: usize,
    pub(crate) font: Entity<SelectState<SearchableVec<String>>>,
    pub(crate) font_size: Entity<InputState>,
    pub(crate) code_language: Entity<SelectState<Vec<String>>>,
    pub(crate) shortcuts: Vec<Entity<InputState>>,
    colors: Vec<Entity<ColorPickerState>>,
    opacity: Entity<SliderState>,
    blur: Entity<SliderState>,
    runtime: tokio::runtime::Handle,
    data: PathBuf,
    loading_image: bool,
    presets_ready: bool,
    error: Option<String>,
    pub save_error: Option<String>,
    pub background_error: Option<String>,
    font_size_error: Option<String>,
    shortcut_errors: [Option<String>; 4],
    scroll: ScrollHandle,
    _subscriptions: Vec<Subscription>,
}
impl EventEmitter<SettingsEvent> for SettingsView {}
impl SettingsView {
    pub fn new(
        settings: Settings,
        runtime: tokio::runtime::Handle,
        data: PathBuf,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Self {
        let input = |value: String, window: &mut Window, cx: &mut Context<Self>| {
            cx.new(|cx| InputState::new(window, cx).default_value(value))
        };
        let fonts = cx.text_system().all_font_names();
        let selected = fonts
            .iter()
            .position(|family| family == &settings.terminal.font_family)
            .map(|row| gpui_kit::component::IndexPath::default().row(row));
        let font = cx.new(|cx| {
            SelectState::new(SearchableVec::new(fonts), selected, window, cx).searchable(true)
        });
        let font_size = input(settings.terminal.font_size.to_string(), window, cx);
        let code_language = cx.new(|cx| {
            SelectState::new(
                CODE_LANGUAGES
                    .iter()
                    .map(|(_, label)| (*label).to_owned())
                    .collect::<Vec<_>>(),
                CODE_LANGUAGES
                    .iter()
                    .position(|(language, _)| *language == settings.terminal.highlighting.language)
                    .map(|row| gpui_kit::component::IndexPath::default().row(row)),
                window,
                cx,
            )
        });
        let shortcuts: Vec<_> = [
            &settings.keymap.copy,
            &settings.keymap.paste,
            &settings.keymap.open_settings,
            &settings.keymap.new_connection,
        ]
        .into_iter()
        .map(|s| input(s.clone(), window, cx))
        .collect();
        let colors: Vec<_> = settings
            .terminal
            .palette()
            .colors()
            .into_iter()
            .map(|c| cx.new(|cx| ColorPickerState::new(window, cx).default_value(rgb(c))))
            .collect();
        let opacity = cx.new(|_| {
            SliderState::new()
                .min(0.)
                .max(100.)
                .step(1.)
                .default_value(f32::from(settings.background.opacity))
        });
        let blur = cx.new(|_| {
            SliderState::new()
                .min(0.)
                .max(24.)
                .step(1.)
                .default_value(f32::from(settings.background.blur))
        });
        let mut subscriptions = vec![
            cx.subscribe(&opacity, |v, _, event: &SliderEvent, cx| {
                if let SliderEvent::Change(value) = event {
                    v.settings.background.opacity = value.start().round() as u8;
                    v.changed(cx);
                }
            }),
            cx.subscribe(&blur, |v, _, event: &SliderEvent, cx| {
                if let SliderEvent::Change(value) = event {
                    v.settings.background.blur = value.start().round() as u8;
                    v.changed(cx);
                }
            }),
        ];
        subscriptions.push(cx.subscribe(&font, |v, _, event, cx| {
            if let SelectEvent::Confirm(Some(family)) = event {
                v.settings.terminal.font_family = family.clone();
                v.changed(cx);
            }
        }));
        subscriptions.push(cx.subscribe(&code_language, |v, _, event, cx| {
            if let SelectEvent::Confirm(Some(label)) = event
                && let Some((language, _)) =
                    CODE_LANGUAGES.iter().find(|(_, value)| *value == label)
            {
                v.settings.terminal.highlighting.language = *language;
                v.changed(cx);
            }
        }));
        subscriptions.push(
            cx.subscribe(&font_size, |v, input, event: &InputEvent, cx| {
                if matches!(
                    event,
                    InputEvent::Change | InputEvent::Blur | InputEvent::PressEnter { .. }
                ) {
                    let value = input.read(cx).value();
                    match value
                        .trim()
                        .parse::<u8>()
                        .ok()
                        .filter(|size| (9..=36).contains(size))
                    {
                        Some(size) => {
                            v.font_size_error = None;
                            v.settings.terminal.font_size = size;
                            v.changed(cx);
                        }
                        None => {
                            v.font_size_error = (!value.trim().is_empty()
                                || !matches!(event, InputEvent::Change))
                            .then(|| "字号应为 9–36".into());
                        }
                    }
                    cx.notify();
                }
            }),
        );
        for (index, input) in shortcuts.iter().enumerate() {
            subscriptions.push(
                cx.subscribe(input, move |v, input, event: &InputEvent, cx| {
                    if matches!(
                        event,
                        InputEvent::Change | InputEvent::Blur | InputEvent::PressEnter { .. }
                    ) {
                        let mut settings = v.settings.clone();
                        let keymap = &mut settings.keymap;
                        let shortcut = match index {
                            0 => &mut keymap.copy,
                            1 => &mut keymap.paste,
                            2 => &mut keymap.open_settings,
                            _ => &mut keymap.new_connection,
                        };
                        *shortcut = input.read(cx).value().trim().into();
                        v.shortcut_errors[index] = settings.validate().err().map(|e| e.to_string());
                        if v.shortcut_errors[index].is_none() {
                            v.settings = settings;
                            v.changed(cx);
                        }
                        cx.notify();
                    }
                }),
            );
        }
        for (index, color) in colors.iter().enumerate() {
            subscriptions.push(
                cx.subscribe(color, move |v, _, event: &ColorPickerEvent, cx| {
                    if let ColorPickerEvent::Change(Some(color)) = event {
                        let mut palette = v.settings.terminal.palette().colors();
                        palette[index] = rgb_value(*color);
                        v.settings.terminal.custom_palette = TerminalPalette::from_colors(palette);
                        v.settings.terminal.palette_preset = PalettePreset::Custom;
                        v.changed(cx);
                    }
                }),
            );
        }
        let preset_data = data.clone();
        jobs::run(
            &runtime,
            window,
            cx,
            async move { tokio::task::spawn_blocking(move || prepare_presets(&preset_data)).await? },
            |v, result, _, cx| {
                match result {
                    Ok(()) => v.presets_ready = true,
                    Err(error) => v.error = Some(format!("{error:#}")),
                }
                cx.notify();
            },
        );
        Self {
            font,
            font_size,
            code_language,
            settings,
            section: 0,
            shortcuts,
            colors,
            opacity,
            blur,
            runtime,
            data,
            loading_image: false,
            presets_ready: false,
            error: None,
            save_error: None,
            background_error: None,
            font_size_error: None,
            shortcut_errors: Default::default(),
            scroll: ScrollHandle::new(),
            _subscriptions: subscriptions,
        }
    }
    fn changed(&self, cx: &mut Context<Self>) {
        cx.emit(SettingsEvent::Change(Box::new(self.settings.clone())));
        cx.notify();
    }
    pub(crate) fn select_section(&mut self, section: usize, cx: &mut Context<Self>) {
        self.section = section;
        self.scroll.set_offset(point(px(0.), px(0.)));
        cx.notify();
    }
    fn choose_background(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.loading_image = true;
        self.error = None;
        let data = self.data.clone();
        let picker = rfd::AsyncFileDialog::new()
            .set_title("选择背景图")
            .add_filter("图片", &["png", "jpg", "jpeg", "webp", "bmp"])
            .pick_file();
        jobs::run(
            &self.runtime,
            window,
            cx,
            async move {
                let selected = picker.await;
                let Some(file) = selected else {
                    return Ok(None);
                };
                tokio::task::spawn_blocking(move || import_background(file.path(), &data))
                    .await?
                    .map(Some)
            },
            |view, result, _, cx| {
                view.loading_image = false;
                match result {
                    Ok(Some(path)) => {
                        view.settings.background.image = Some(path);
                        view.settings.background.enabled = true;
                        view.changed(cx);
                    }
                    Ok(None) => {}
                    Err(error) => view.error = Some(format!("{error:#}")),
                }
                cx.notify();
            },
        );
        cx.notify();
    }
    fn appearance(&self, cx: &mut Context<Self>) -> AnyElement {
        let c = colors(cx);
        let background = &self.settings.background;
        let custom_image = background.image.as_ref().filter(|p| !is_preset(p));
        column()
            .gap(px(10.))
            .child(
                card("主题", cx).child(
                    row()
                        .w_full()
                        .overflow_hidden()
                        .rounded_md()
                        .border_1()
                        .border_color(rgb(c.border))
                        .children(
                            [
                                (ThemeMode::Dark, IconName::Moon, "深色"),
                                (ThemeMode::Light, IconName::Sun, "浅色"),
                                (ThemeMode::System, IconName::Monitor, "跟随系统"),
                            ]
                            .into_iter()
                            .enumerate()
                            .map(|(i, (mode, icon, label))| {
                                row()
                                    .id(("theme", i))
                                    .flex_1()
                                    .justify_center()
                                    .gap_2()
                                    .h(px(40.))
                                    .cursor_pointer()
                                    .when(i > 0, |el| el.border_l_1().border_color(rgb(c.border)))
                                    .when(self.settings.theme == mode, |el| {
                                        el.bg(rgb(c.selection)).text_color(rgb(c.accent))
                                    })
                                    .hover(move |s| s.bg(rgb(c.hover)))
                                    .child(Icon::new(icon).size(px(15.)))
                                    .child(label)
                                    .on_click(cx.listener(move |v, _, _, cx| {
                                        v.settings.theme = mode;
                                        v.changed(cx);
                                    }))
                            }),
                        ),
                ),
            )
            .child(
                card("全局背景", cx)
                    .child(
                        check_row("background-enabled", "显示背景图", background.enabled, cx)
                            .on_click(cx.listener(|v, checked, _, cx| {
                                v.settings.background.enabled = *checked;
                                v.changed(cx);
                            })),
                    )
                    .child(
                        row()
                            .items_stretch()
                            .gap_2()
                            .children(PRESETS.iter().enumerate().map(
                                |(i, (name, label, description, _))| {
                                    let path = preset_path(&self.data, name);
                                    let selected = background.image.as_ref() == Some(&path);
                                    column()
                                        .id(("background-preset", i))
                                        .flex_1()
                                        .p(px(5.))
                                        .gap_1()
                                        .rounded_md()
                                        .border_1()
                                        .border_color(rgb(if selected {
                                            c.accent
                                        } else {
                                            c.border
                                        }))
                                        .when(selected, |el| el.bg(rgb(c.hover)))
                                        .cursor_pointer()
                                        .hover(move |s| s.border_color(rgb(c.accent)))
                                        .child(
                                            div()
                                                .h(px(72.))
                                                .w_full()
                                                .rounded_sm()
                                                .overflow_hidden()
                                                .bg(rgb(c.panel))
                                                .when(self.presets_ready, |el| {
                                                    el.child(
                                                        img(path.clone())
                                                            .size_full()
                                                            .object_fit(ObjectFit::Cover),
                                                    )
                                                }),
                                        )
                                        .child(
                                            div()
                                                .px_1()
                                                .font_weight(FontWeight::SEMIBOLD)
                                                .child(*label),
                                        )
                                        .child(
                                            div()
                                                .px_1()
                                                .text_xs()
                                                .text_color(rgb(c.muted))
                                                .child(*description),
                                        )
                                        .on_click(cx.listener(move |v, _, _, cx| {
                                            if v.presets_ready {
                                                v.settings.background.image = Some(path.clone());
                                                v.settings.background.enabled = true;
                                                v.changed(cx);
                                            }
                                        }))
                                },
                            ))
                            .child(
                                column()
                                    .id("background-choose")
                                    .flex_1()
                                    .p(px(5.))
                                    .gap_1()
                                    .rounded_md()
                                    .border_1()
                                    .border_color(rgb(if custom_image.is_some() {
                                        c.accent
                                    } else {
                                        c.border
                                    }))
                                    .when(custom_image.is_some(), |el| el.bg(rgb(c.hover)))
                                    .cursor_pointer()
                                    .hover(move |s| s.border_color(rgb(c.accent)))
                                    .child(
                                        div()
                                            .h(px(72.))
                                            .w_full()
                                            .rounded_sm()
                                            .overflow_hidden()
                                            .bg(rgb(c.hover))
                                            .flex()
                                            .items_center()
                                            .justify_center()
                                            .when_some(custom_image, |el, path| {
                                                el.child(
                                                    img(path.clone())
                                                        .size_full()
                                                        .object_fit(ObjectFit::Cover),
                                                )
                                            })
                                            .when(custom_image.is_none(), |el| {
                                                el.child(
                                                    Icon::new(IconName::Image)
                                                        .size(px(24.))
                                                        .text_color(rgb(c.muted)),
                                                )
                                            }),
                                    )
                                    .child(
                                        div()
                                            .px_1()
                                            .font_weight(FontWeight::SEMIBOLD)
                                            .child("自定义"),
                                    )
                                    .child(div().px_1().text_xs().text_color(rgb(c.muted)).child(
                                        if self.loading_image {
                                            "正在处理…"
                                        } else {
                                            "点击替换"
                                        },
                                    ))
                                    .on_click(cx.listener(|v, _, w, cx| {
                                        if !v.loading_image {
                                            v.choose_background(w, cx);
                                        }
                                    })),
                            ),
                    )
                    .child(
                        row()
                            .gap_2()
                            .child(slider_field(
                                "显示强度",
                                &self.opacity,
                                format!("{}%", background.opacity),
                                cx,
                            ))
                            .child(slider_field(
                                "模糊",
                                &self.blur,
                                format!("{}px", background.blur),
                                cx,
                            )),
                    )
                    .when_some(background.image.as_ref(), |el, path| {
                        el.child(
                            row()
                                .gap_2()
                                .child(
                                    div()
                                        .flex_1()
                                        .truncate()
                                        .text_xs()
                                        .text_color(rgb(c.muted))
                                        .child(background_name(path)),
                                )
                                .child(button("background-clear", "移除").ghost().on_click(
                                    cx.listener(|v, _, _, cx| {
                                        v.settings.background.image = None;
                                        v.settings.background.enabled = false;
                                        v.changed(cx);
                                    }),
                                )),
                        )
                    })
                    .when(!self.presets_ready, |el| {
                        el.child(
                            div()
                                .text_xs()
                                .text_color(rgb(c.muted))
                                .child("正在准备内置背景…"),
                        )
                    }),
            )
            .into_any_element()
    }
    fn select_palette(
        &mut self,
        preset: PalettePreset,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if preset == PalettePreset::Custom {
            self.settings.terminal.custom_palette = self.settings.terminal.palette();
        }
        self.settings.terminal.palette_preset = preset;
        for (picker, color) in self
            .colors
            .iter()
            .zip(self.settings.terminal.palette().colors())
        {
            picker.update(cx, |picker, cx| picker.set_value(rgb(color), window, cx));
        }
        self.changed(cx);
    }
    fn color_grid(&self, start: usize, end: usize, cx: &App) -> impl IntoElement {
        let c = colors(cx);
        column().gap_2().children(
            (start..end)
                .collect::<Vec<_>>()
                .chunks(4)
                .map(|indices| {
                    row().gap_2().children(indices.iter().map(|&index| {
                        row()
                            .flex_1()
                            .min_w_0()
                            .h(px(32.))
                            .pl_2()
                            .pr_1()
                            .gap_1()
                            .rounded_md()
                            .border_1()
                            .border_color(rgb(c.border))
                            .child(
                                div()
                                    .flex_1()
                                    .text_color(rgb(c.muted))
                                    .child(COLOR_NAMES[index]),
                            )
                            .child(
                                ColorPicker::new(&self.colors[index])
                                    .small()
                                    .anchor(Anchor::TopRight)
                                    .accessibility_label(format!(
                                        "终端颜色：{}",
                                        COLOR_NAMES[index]
                                    )),
                            )
                    }))
                })
                .collect::<Vec<_>>(),
        )
    }
    fn terminal(&self, cx: &mut Context<Self>) -> AnyElement {
        let c = colors(cx);
        column()
            .gap(px(10.))
            .child(
                card("字体", cx).child(
                    row()
                        .items_start()
                        .gap_3()
                        .child(
                            column()
                                .flex_1()
                                .gap_1()
                                .child(div().text_xs().text_color(rgb(c.muted)).child("字体"))
                                .child(
                                    Select::new(&self.font)
                                        .w_full()
                                        .accessibility_label("终端字体")
                                        .placeholder(self.settings.terminal.font_family.clone())
                                        .search_placeholder("搜索字体")
                                        .menu_max_h(px(280.)),
                                ),
                        )
                        .child(
                            column()
                                .w(px(96.))
                                .flex_shrink_0()
                                .gap_1()
                                .child(div().text_xs().text_color(rgb(c.muted)).child("字号"))
                                .child(Input::new(&self.font_size).aria_label("终端字号"))
                                .when_some(self.font_size_error.clone(), |el, error| {
                                    el.child(div().text_xs().text_color(rgb(0xe87979)).child(error))
                                }),
                        ),
                ),
            )
            .child(
                card("内容高亮", cx)
                    .child(
                        row()
                            .gap_4()
                            .child(
                                check_row(
                                    "highlight-logs",
                                    "日志级别",
                                    self.settings.terminal.highlighting.logs,
                                    cx,
                                )
                                .on_click(cx.listener(
                                    |v, checked, _, cx| {
                                        v.settings.terminal.highlighting.logs = *checked;
                                        v.changed(cx);
                                    },
                                )),
                            )
                            .child(
                                check_row(
                                    "highlight-code",
                                    "代码语法",
                                    self.settings.terminal.highlighting.code,
                                    cx,
                                )
                                .on_click(cx.listener(
                                    |v, checked, _, cx| {
                                        v.settings.terminal.highlighting.code = *checked;
                                        v.changed(cx);
                                    },
                                )),
                            ),
                    )
                    .child(
                        row()
                            .gap_4()
                            .child(div().w(px(96.)).child("代码语言"))
                            .child(
                                Select::new(&self.code_language)
                                    .flex_1()
                                    .accessibility_label("代码高亮语言")
                                    .disabled(!self.settings.terminal.highlighting.code),
                            ),
                    )
                    .child(
                        row()
                            .gap_3()
                            .flex_wrap()
                            .p_3()
                            .rounded_md()
                            .bg(rgb(self.settings.terminal.palette().background))
                            .children(
                                [
                                    ("错误", 1),
                                    ("警告", 3),
                                    ("提示", 6),
                                    ("成功", 2),
                                    ("调试", 8),
                                    ("类名", 3),
                                    ("函数名", 4),
                                ]
                                .into_iter()
                                .map(|(label, index)| {
                                    div()
                                        .text_xs()
                                        .text_color(rgb(if index == 8 {
                                            self.settings.terminal.palette().muted_foreground()
                                        } else {
                                            self.settings.terminal.palette().ansi[index]
                                        }))
                                        .child(label)
                                }),
                            ),
                    ),
            )
            .child(
                card("终端配色", cx)
                    .child(
                        row().gap_2().children(
                            [
                                (PalettePreset::Dark, "深色"),
                                (PalettePreset::Light, "浅色"),
                                (PalettePreset::Dracula, "Dracula"),
                                (PalettePreset::Custom, "自定义"),
                            ]
                            .into_iter()
                            .enumerate()
                            .map(|(i, (preset, label))| {
                                button(("palette", i), label)
                                    .flex_1()
                                    .when(self.settings.terminal.palette_preset == preset, |b| {
                                        b.primary()
                                    })
                                    .on_click(cx.listener(move |v, _, w, cx| {
                                        v.select_palette(preset, w, cx)
                                    }))
                            }),
                        ),
                    )
                    .child(palette_preview(
                        &self.settings.terminal.palette(),
                        &self.settings.terminal.font_family,
                        self.settings.terminal.font_size,
                    ))
                    .child(self.color_grid(0, 4, cx))
                    .child(
                        div()
                            .text_xs()
                            .font_weight(FontWeight::SEMIBOLD)
                            .child("ANSI"),
                    )
                    .child(self.color_grid(4, 12, cx))
                    .child(div().h(px(1.)).bg(rgb(c.border)))
                    .child(
                        div()
                            .text_xs()
                            .font_weight(FontWeight::SEMIBOLD)
                            .child("亮色 ANSI"),
                    )
                    .child(self.color_grid(12, 20, cx)),
            )
            .child(
                card("鼠标", cx).child(
                    column().gap_2().children(
                        [
                            [
                                (RightClickBehavior::Disabled, "关闭", "右键不触发终端操作。"),
                                (
                                    RightClickBehavior::ContextMenu,
                                    "右键菜单",
                                    "打开复制、粘贴和全选菜单。",
                                ),
                            ],
                            [
                                (
                                    RightClickBehavior::Paste,
                                    "粘贴",
                                    "右键直接粘贴剪贴板内容。",
                                ),
                                (
                                    RightClickBehavior::CopyOrPaste,
                                    "智能粘贴",
                                    "选中文本复制，未选择时粘贴。",
                                ),
                            ],
                        ]
                        .into_iter()
                        .enumerate()
                        .map(|(r, choices)| {
                            row().gap_2().children(choices.into_iter().enumerate().map(
                                |(i, (behavior, label, description))| {
                                    column()
                                        .id(("right-click", r * 2 + i))
                                        .flex_1()
                                        .gap_1()
                                        .p_3()
                                        .rounded_md()
                                        .border_1()
                                        .border_color(rgb(
                                            if self.settings.terminal.right_click == behavior {
                                                c.accent
                                            } else {
                                                c.border
                                            },
                                        ))
                                        .bg(rgb(
                                            if self.settings.terminal.right_click == behavior {
                                                c.selection
                                            } else {
                                                c.panel
                                            },
                                        ))
                                        .cursor_pointer()
                                        .hover(move |s| s.border_color(rgb(c.accent)))
                                        .child(div().font_weight(FontWeight::SEMIBOLD).child(label))
                                        .child(
                                            div()
                                                .text_xs()
                                                .text_color(rgb(c.muted))
                                                .child(description),
                                        )
                                        .on_click(cx.listener(move |v, _, _, cx| {
                                            v.settings.terminal.right_click = behavior;
                                            v.changed(cx);
                                        }))
                                },
                            ))
                        }),
                    ),
                ),
            )
            .child(
                card("粘贴", cx).child(
                    check_row(
                        "confirm-multiline",
                        "多行粘贴前编辑并确认",
                        self.settings.terminal.confirm_multiline_paste,
                        cx,
                    )
                    .on_click(cx.listener(|v, checked, _, cx| {
                        v.settings.terminal.confirm_multiline_paste = *checked;
                        v.changed(cx);
                    })),
                ),
            )
            .child(
                card("复制", cx).child(
                    check_row(
                        "copy-ctrl-c",
                        "选中时 Ctrl+C 复制，无选中时中断",
                        self.settings.terminal.copy_on_ctrl_c_when_selected,
                        cx,
                    )
                    .on_click(cx.listener(|v, checked, _, cx| {
                        v.settings.terminal.copy_on_ctrl_c_when_selected = *checked;
                        v.changed(cx);
                    })),
                ),
            )
            .into_any_element()
    }
    fn keymap(&self, cx: &mut Context<Self>) -> AnyElement {
        card("快捷键", cx)
            .children(
                ["终端复制", "终端粘贴", "打开设置", "新建连接"]
                    .into_iter()
                    .zip(&self.shortcuts)
                    .enumerate()
                    .map(|(index, (label, input))| {
                        row().gap_4().child(div().w(px(130.)).child(label)).child(
                            column()
                                .flex_1()
                                .gap_1()
                                .child(Input::new(input))
                                .when_some(self.shortcut_errors[index].clone(), |el, error| {
                                    el.child(div().text_xs().text_color(rgb(0xe87979)).child(error))
                                }),
                        )
                    }),
            )
            .into_any_element()
    }
    fn about(&self, cx: &App) -> AnyElement {
        card("关于 Portiva 2", cx)
            .child(
                row()
                    .gap_3()
                    .child(
                        Icon::new(IconName::Terminal)
                            .size(px(28.))
                            .text_color(rgb(colors(cx).accent)),
                    )
                    .child(
                        column()
                            .gap_1()
                            .child(
                                div()
                                    .text_lg()
                                    .font_weight(FontWeight::SEMIBOLD)
                                    .child("Portiva 2"),
                            )
                            .child(
                                div()
                                    .text_xs()
                                    .text_color(rgb(colors(cx).muted))
                                    .child(format!("版本 {}", env!("CARGO_PKG_VERSION"))),
                            ),
                    ),
            )
            .child("SSH 终端与 SFTP 文件管理")
            .child(
                div()
                    .text_xs()
                    .text_color(rgb(colors(cx).muted))
                    .child("Rust · GPUI · russh · Alacritty"),
            )
            .into_any_element()
    }
}
impl Render for SettingsView {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let c = colors(cx);
        row()
            .relative()
            .size_full()
            .child(
                column()
                    .w(px(254.))
                    .h_full()
                    .flex_shrink_0()
                    .p(px(18.))
                    .gap(px(5.))
                    .children(
                        [
                            (IconName::Palette, "外观"),
                            (IconName::Terminal, "终端"),
                            (IconName::Keyboard, "快捷键"),
                            (IconName::FileText, "关于"),
                        ]
                        .into_iter()
                        .enumerate()
                        .map(|(i, (icon, label))| {
                            row()
                                .id(("settings-section", i))
                                .text_size(px(16.))
                                .gap_3()
                                .h(px(44.))
                                .px_4()
                                .rounded_md()
                                .border_1()
                                .border_color(rgb(if self.section == i {
                                    c.accent
                                } else {
                                    c.border
                                }))
                                .bg(rgb(if self.section == i {
                                    c.selection
                                } else {
                                    c.panel
                                }))
                                .when(self.section == i, |el| el.border_l(px(3.)))
                                .cursor_pointer()
                                .hover(move |s| s.border_color(rgb(c.accent)))
                                .child(Icon::new(icon).size(px(16.)).text_color(rgb(
                                    if self.section == i { c.accent } else { c.muted },
                                )))
                                .child(div().font_weight(FontWeight::SEMIBOLD).child(label))
                                .on_click(cx.listener(move |v, _, _, cx| {
                                    v.select_section(i, cx);
                                }))
                        }),
                    ),
            )
            .child(
                column().flex_1().h_full().child(
                    div()
                        .id("settings-scroll")
                        .flex_1()
                        .min_h_0()
                        .overflow_y_scroll()
                        .track_scroll(&self.scroll)
                        .p(px(14.))
                        .child(
                            column()
                                .max_w(px(594.))
                                .mx_auto()
                                .gap(px(10.))
                                .when_some(
                                    self.save_error
                                        .clone()
                                        .or(self.background_error.clone())
                                        .or(self.error.clone()),
                                    |el, error| {
                                        el.child(
                                            div()
                                                .p_3()
                                                .rounded_md()
                                                .bg(panel(cx))
                                                .text_xs()
                                                .text_color(rgb(0xe87979))
                                                .child(error),
                                        )
                                    },
                                )
                                .child(match self.section {
                                    0 => self.appearance(cx),
                                    1 => self.terminal(cx),
                                    2 => self.keymap(cx),
                                    _ => self.about(cx),
                                }),
                        ),
                ),
            )
    }
}
pub(crate) fn installed_font_family(current: &str, installed: &[String]) -> String {
    let find = |name: &str| {
        installed
            .iter()
            .find(|family| family.eq_ignore_ascii_case(name))
    };
    if let Some(family) = find(current) {
        return family.clone();
    }
    let preferred = if cfg!(target_os = "macos") {
        [
            "Menlo",
            "Monaco",
            "SF Mono",
            "Cascadia Mono",
            "DejaVu Sans Mono",
            "Liberation Mono",
            "Courier New",
        ]
    } else if cfg!(target_os = "windows") {
        [
            "Cascadia Mono",
            "Consolas",
            "Cascadia Code",
            "DejaVu Sans Mono",
            "Liberation Mono",
            "Noto Sans Mono",
            "Courier New",
        ]
    } else {
        [
            "DejaVu Sans Mono",
            "Liberation Mono",
            "Noto Sans Mono",
            "Cascadia Mono",
            "Ubuntu Mono",
            "FreeMono",
            "Courier New",
        ]
    };
    preferred
        .into_iter()
        .find_map(find)
        .or_else(|| installed.first())
        .cloned()
        .unwrap_or_else(|| current.to_owned())
}

fn card(title: &'static str, cx: &App) -> Div {
    column()
        .w_full()
        .p_4()
        .gap_3()
        .rounded_lg()
        .border_1()
        .border_color(rgb(colors(cx).border))
        .bg(panel(cx))
        .child(div().font_weight(FontWeight::SEMIBOLD).child(title))
}
fn check_row(id: &'static str, label: &'static str, checked: bool, cx: &App) -> Checkbox {
    Checkbox::new(id)
        .label(label)
        .checked(checked)
        .w_full()
        .p_3()
        .rounded_md()
        .border_1()
        .border_color(rgb(if checked {
            colors(cx).accent
        } else {
            colors(cx).border
        }))
        .when(checked, |el| el.bg(rgb(colors(cx).selection)))
}
fn slider_field(label: &'static str, slider: &Entity<SliderState>, value: String, cx: &App) -> Div {
    row()
        .flex_1()
        .p_2()
        .gap_3()
        .rounded_md()
        .border_1()
        .border_color(rgb(colors(cx).border))
        .child(
            div()
                .text_xs()
                .text_color(rgb(colors(cx).muted))
                .child(label),
        )
        .child(
            Slider::new(slider)
                .flex_1()
                .bg(rgb(colors(cx).accent))
                .text_color(rgb(colors(cx).accent))
                .accessibility_label(label),
        )
        .child(div().w(px(36.)).text_right().text_xs().child(value))
}
fn palette_preview(palette: &TerminalPalette, family: &str, font_size: u8) -> impl IntoElement {
    column()
        .p_3()
        .gap_1()
        .rounded_md()
        .bg(rgb(palette.background))
        .text_color(rgb(palette.foreground))
        .font_family(SharedString::from(family.to_owned()))
        .text_size(px(f32::from(font_size)))
        .child(
            row()
                .gap_2()
                .child(div().text_color(rgb(palette.ansi[2])).child("user@portiva"))
                .child("~ $ ls -la"),
        )
        .child(
            row().gap_3().children(
                ["src/", "README.md", "Cargo.toml"]
                    .into_iter()
                    .enumerate()
                    .map(|(i, text)| {
                        div()
                            .text_color(rgb(palette.ansi[[4, 7, 3][i]]))
                            .child(text)
                    }),
            ),
        )
}
fn rgb_value(color: Hsla) -> u32 {
    let color = color.to_rgb();
    let byte = |v: f32| (v.clamp(0., 1.) * 255.).round() as u32;
    (byte(color.r) << 16) | (byte(color.g) << 8) | byte(color.b)
}
const COLOR_NAMES: [&str; 20] = [
    "背景", "文字", "光标", "选区", "黑", "红", "绿", "黄", "蓝", "紫", "青", "白", "亮黑", "亮红",
    "亮绿", "亮黄", "亮蓝", "亮紫", "亮青", "亮白",
];
const PRESETS: [(&str, &str, &str, &[u8]); 3] = [
    (
        "aurora",
        "极光",
        "冷色流光",
        include_bytes!("../assets/backgrounds/aurora.svg"),
    ),
    (
        "horizon",
        "远山",
        "柔和山影",
        include_bytes!("../assets/backgrounds/horizon.svg"),
    ),
    (
        "topography",
        "等高线",
        "低对比纹理",
        include_bytes!("../assets/backgrounds/topography.svg"),
    ),
];
fn preset_path(data: &Path, name: &str) -> PathBuf {
    data.join("backgrounds").join(format!("preset-{name}.png"))
}
fn is_preset(path: &Path) -> bool {
    PRESETS.iter().any(|(name, _, _, _)| {
        path.file_stem()
            .is_some_and(|s| s == format!("preset-{name}").as_str())
    })
}
fn background_name(path: &Path) -> String {
    if let Some((_, label, _, _)) = PRESETS.iter().find(|(name, _, _, _)| {
        path.file_stem()
            .is_some_and(|s| s == format!("preset-{name}").as_str())
    }) {
        format!("当前背景：{label}")
    } else {
        "当前背景：自定义图片".into()
    }
}
fn prepare_presets(data: &Path) -> Result<()> {
    std::fs::create_dir_all(data.join("backgrounds"))?;
    for (name, _, _, source) in PRESETS {
        let target = preset_path(data, name);
        if target.is_file() {
            continue;
        }
        let tree = resvg::usvg::Tree::from_data(source, &resvg::usvg::Options::default())?;
        let mut pixmap = resvg::tiny_skia::Pixmap::new(1920, 1080).context("无法创建背景图")?;
        resvg::render(
            &tree,
            resvg::tiny_skia::Transform::identity(),
            &mut pixmap.as_mut(),
        );
        let image = image::load_from_memory(&pixmap.encode_png()?)?;
        save_image(&image, &target)?;
    }
    Ok(())
}
fn import_background(path: &Path, data: &Path) -> Result<PathBuf> {
    ensure!(
        std::fs::metadata(path)?.len() <= 32 * 1024 * 1024,
        "背景图不能超过 32 MB"
    );
    let bytes = std::fs::read(path)?;
    let (width, height) = image::ImageReader::new(Cursor::new(&bytes))
        .with_guessed_format()?
        .into_dimensions()
        .context("无法识别图片")?;
    ensure!(
        u64::from(width) * u64::from(height) <= 40_000_000,
        "背景图不能超过 4000 万像素"
    );
    let image = image::load_from_memory(&bytes).context("图片解码失败")?;
    let image = if width > 2560 || height > 1600 {
        image.thumbnail(2560, 1600)
    } else {
        image
    };
    let directory = data.join("backgrounds");
    std::fs::create_dir_all(&directory)?;
    let target = directory.join(format!("{}.png", uuid::Uuid::new_v4()));
    save_image(&image, &target)?;
    Ok(target)
}
pub fn prepare_background(settings: &Settings, data: &Path) -> Result<Option<PathBuf>> {
    if !settings.background.enabled {
        return Ok(None);
    }
    let Some(source) = &settings.background.image else {
        return Ok(None);
    };
    if settings.background.blur == 0 {
        ensure!(source.is_file(), "背景图不存在，请重新选择");
        return Ok(Some(source.clone()));
    }
    let directory = data.join("backgrounds");
    std::fs::create_dir_all(&directory)?;
    let target = directory.join(format!(
        "{}-blur-{}.png",
        source.file_stem().unwrap_or_default().to_string_lossy(),
        settings.background.blur
    ));
    if !target.exists() {
        let image = image::open(source)
            .context("无法读取背景图")?
            .blur(f32::from(settings.background.blur));
        save_image(&image, &target)?;
    }
    Ok(Some(target))
}
fn save_image(image: &image::DynamicImage, target: &Path) -> Result<()> {
    use std::io::Write;
    let mut temporary =
        tempfile::NamedTempFile::new_in(target.parent().context("图片目录不存在")?)?;
    image.write_to(&mut temporary, image::ImageFormat::Png)?;
    temporary.flush()?;
    temporary.as_file().sync_all()?;
    temporary.persist(target).map_err(|e| e.error)?;
    Ok(())
}
#[cfg(test)]
mod tests {
    use super::*;
    #[::core::prelude::v1::test]
    fn font_selection_preserves_installed_fonts_and_falls_back_across_platforms() {
        let installed = ["Custom Font", "DejaVu Sans Mono"].map(String::from);
        assert_eq!(
            installed_font_family("custom font", &installed),
            "Custom Font"
        );
        assert_eq!(
            installed_font_family("Missing Font", &installed),
            "DejaVu Sans Mono"
        );
        assert_eq!(
            installed_font_family("Missing Font", &installed[..1]),
            "Custom Font"
        );
    }

    #[::core::prelude::v1::test]
    fn embedded_presets_render_without_external_resources_and_reuse_cache() -> Result<()> {
        let data = tempfile::tempdir()?;
        prepare_presets(data.path())?;
        let mut cached = Vec::new();
        for (name, label, _, _) in PRESETS {
            let path = preset_path(data.path(), name);
            assert!(is_preset(&path));
            assert_eq!(background_name(&path), format!("当前背景：{label}"));
            assert_eq!(image::image_dimensions(&path)?, (1920, 1080));
            cached.push((path.clone(), std::fs::metadata(path)?.modified()?));
        }
        prepare_presets(data.path())?;
        for (path, modified) in cached {
            assert_eq!(std::fs::metadata(path)?.modified()?, modified);
        }
        Ok(())
    }
    #[::core::prelude::v1::test]
    fn background_import_survives_source_removal_and_blur_cache_is_reused() -> Result<()> {
        let source = tempfile::tempdir()?;
        let data = tempfile::tempdir()?;
        let path = source.path().join("source.png");
        image::RgbImage::from_fn(240, 120, |x, y| image::Rgb([x as u8, y as u8, 80]))
            .save(&path)?;
        let imported = import_background(&path, data.path())?;
        std::fs::remove_file(path)?;
        assert!(imported.starts_with(data.path()));
        assert_eq!(image::image_dimensions(&imported)?, (240, 120));
        let mut settings = Settings {
            background: portiva_core::BackgroundSettings {
                enabled: true,
                image: Some(imported.clone()),
                blur: 6,
                ..Default::default()
            },
            ..Default::default()
        };
        let blurred = prepare_background(&settings, data.path())?.unwrap();
        assert_ne!(blurred, imported);
        assert!(image::open(&blurred).is_ok());
        assert_eq!(prepare_background(&settings, data.path())?, Some(blurred));
        settings.background.enabled = false;
        assert_eq!(prepare_background(&settings, data.path())?, None);
        let invalid = source.path().join("invalid.png");
        std::fs::write(&invalid, b"not-an-image")?;
        assert!(import_background(&invalid, data.path()).is_err());
        Ok(())
    }
}
