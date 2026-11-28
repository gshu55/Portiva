use crate::theme::*;
use anyhow::{Context as _, Result};
use gpui_kit::component::input::{Input, InputState};
use gpui_kit::{prelude::*, *};
use portiva_core::{AuthMethod, Credentials, Profile, Protocol};
use std::path::PathBuf;

pub struct ConnectionForm {
    pub profile: Profile,
    name: Entity<InputState>,
    host: Entity<InputState>,
    port: Entity<InputState>,
    username: Entity<InputState>,
    secret: Entity<InputState>,
    key_path: Entity<InputState>,
    x11_display: Entity<InputState>,
    pub busy: bool,
    pub has_saved_secret: bool,
}

impl ConnectionForm {
    pub fn focus(&self, window: &mut Window, cx: &mut App) {
        let focus = self.host.focus_handle(cx);
        window.focus(&focus, cx);
    }
    pub fn new(profile: Profile, window: &mut Window, cx: &mut App) -> Self {
        let input = |value: String,
                     placeholder: &'static str,
                     secret: bool,
                     window: &mut Window,
                     cx: &mut App| {
            cx.new(|cx| {
                InputState::new(window, cx)
                    .placeholder(placeholder)
                    .default_value(value)
                    .masked(secret)
            })
        };
        Self {
            name: input(profile.name.clone(), "例如：开发服务器", false, window, cx),
            host: input(profile.host.clone(), "主机名或 IP 地址", false, window, cx),
            port: input(profile.port.to_string(), "22", false, window, cx),
            username: input(profile.username.clone(), "用户名", false, window, cx),
            secret: input(
                String::new(),
                if profile.remember_secret {
                    "留空使用已保存的凭据"
                } else {
                    ""
                },
                true,
                window,
                cx,
            ),
            key_path: input(
                profile
                    .private_key_path
                    .as_ref()
                    .map(|p| p.to_string_lossy().into_owned())
                    .unwrap_or_default(),
                "私钥文件绝对路径",
                false,
                window,
                cx,
            ),
            busy: false,
            x11_display: input(profile.x11.display.clone(), "自动检测", false, window, cx),
            has_saved_secret: profile.remember_secret,
            profile,
        }
    }
    pub fn set_key_path(&self, path: PathBuf, window: &mut Window, cx: &mut App) {
        self.key_path.update(cx, |input, cx| {
            input.set_value(path.to_string_lossy().into_owned(), window, cx)
        });
    }
    pub fn change_auth(&mut self, auth: AuthMethod, window: &mut Window, cx: &mut App) {
        self.clear_secret(window, cx);
        self.profile.auth = auth;
        self.profile.remember_secret = false;
        self.has_saved_secret = false;
    }
    pub fn values(&self, cx: &App) -> Result<(Profile, Credentials)> {
        let mut profile = self.profile.clone();
        profile.name = self.name.read(cx).value().trim().into();
        profile.host = self.host.read(cx).value().trim().into();
        profile.username = self.username.read(cx).value().trim().into();
        profile.port = self
            .port
            .read(cx)
            .value()
            .parse()
            .context("端口必须为 1–65535")?;
        let key = self.key_path.read(cx).value();
        profile.private_key_path = (!key.trim().is_empty()).then(|| PathBuf::from(key.trim()));
        profile.x11.display = self.x11_display.read(cx).value().trim().into();
        profile.validate()?;
        let secret = self.secret.read(cx).value().to_string();
        let credentials = if profile.auth == AuthMethod::PrivateKey {
            Credentials::passphrase(secret)
        } else {
            Credentials::password(secret)
        };
        Ok((profile, credentials))
    }
    pub fn clear_secret(&self, window: &mut Window, cx: &mut App) {
        self.secret
            .update(cx, |input, cx| input.set_value("", window, cx));
    }
    pub fn refresh_secret_hint(&self, window: &mut Window, cx: &mut App) {
        self.secret.update(cx, |input, cx| {
            input.set_placeholder(
                if self.profile.remember_secret {
                    "留空使用已保存的凭据"
                } else {
                    ""
                },
                window,
                cx,
            )
        });
    }
    pub fn render(
        &self,
        protocols: impl IntoElement,
        authentication: impl IntoElement,
        key_button: impl IntoElement,
        x11_toggle: impl IntoElement,
        cx: &App,
    ) -> impl IntoElement {
        let label = |name: &'static str, input: &Entity<InputState>| {
            column()
                .gap_1()
                .child(div().text_color(rgb(colors(cx).muted)).child(name))
                .child(Input::new(input).aria_label(name).disabled(self.busy))
        };
        column()
            .gap_3()
            .child(label("配置名称", &self.name))
            .child(label("主机", &self.host))
            .child(
                column()
                    .gap_1()
                    .child(div().text_color(rgb(colors(cx).muted)).child("连接类型"))
                    .child(protocols),
            )
            .child(
                row()
                    .gap_3()
                    .child(div().flex_1().child(label("端口", &self.port)))
                    .child(div().flex_1().child(label("用户", &self.username))),
            )
            .child(
                row()
                    .items_start()
                    .gap_3()
                    .child(
                        column()
                            .flex_1()
                            .gap_1()
                            .child(div().text_color(rgb(colors(cx).muted)).child("认证"))
                            .child(authentication),
                    )
                    .when(self.profile.auth != AuthMethod::Agent, |el| {
                        el.child(
                            column()
                                .flex_1()
                                .gap_1()
                                .child(div().text_color(rgb(colors(cx).muted)).child(
                                    match self.profile.auth {
                                        AuthMethod::PrivateKey => "私钥口令",
                                        AuthMethod::Agent => "SSH Agent",
                                        AuthMethod::Password => "SSH 密码",
                                    },
                                ))
                                .child(
                                    Input::new(&self.secret)
                                        .aria_label(
                                            if self.profile.auth == AuthMethod::PrivateKey {
                                                "私钥口令"
                                            } else {
                                                "SSH 密码"
                                            },
                                        )
                                        .mask_toggle()
                                        .disabled(self.busy),
                                ),
                        )
                    }),
            )
            .when(self.profile.auth == AuthMethod::PrivateKey, |el| {
                el.child(
                    row()
                        .items_end()
                        .gap_2()
                        .child(div().flex_1().child(label("私钥路径", &self.key_path)))
                        .child(key_button),
                )
            })
            .when(self.profile.protocol == Protocol::Ssh, |el| {
                el.child(self.render_x11(x11_toggle, cx))
            })
    }

    fn render_x11(&self, toggle: impl IntoElement, cx: &App) -> AnyElement {
        column()
            .gap_2()
            .child(toggle)
            .when(self.profile.x11.enabled, |el| {
                el.child(
                    column()
                        .gap_1()
                        .child(div().text_color(rgb(colors(cx).muted)).child("本机显示"))
                        .child(
                            Input::new(&self.x11_display)
                                .aria_label("X11 本机显示")
                                .disabled(self.busy),
                        ),
                )
            })
            .into_any_element()
    }
}

pub fn auth_label(auth: &AuthMethod) -> &'static str {
    match auth {
        AuthMethod::Password => "密码",
        AuthMethod::PrivateKey => "私钥",
        AuthMethod::Agent => "SSH Agent",
    }
}
pub fn protocol_label(protocol: &Protocol) -> &'static str {
    if *protocol == Protocol::Sftp {
        "SFTP"
    } else {
        "SSH"
    }
}
