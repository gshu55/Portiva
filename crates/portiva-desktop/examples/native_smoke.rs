//! Visible, disposable integration fixture. No user credentials or real server are used.
//! Set PORTIVA_SMOKE_PREVIEW=1 for layout checks and manual preview without clipboard automation.
extern crate gpui_kit as gpui;
#[path = "../src/app.rs"]
mod app;
#[path = "../src/connection.rs"]
mod connection;
#[path = "../src/files.rs"]
mod files;
#[path = "../src/jobs.rs"]
mod jobs;
#[path = "../src/settings.rs"]
mod settings;
#[path = "../../portiva-core/tests/support/mod.rs"]
mod support;
#[path = "../src/terminal.rs"]
mod terminal;
#[path = "../src/theme.rs"]
mod theme;

use anyhow::Result;
use app::terminal_layout::SplitDirection;
use gpui_kit::*;
use portiva_core::*;
use std::{
    collections::BTreeMap,
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};

fn main() -> Result<()> {
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()?;
    let server = runtime.block_on(support::TestServer::start(Duration::from_millis(3)))?;
    let data = tempfile::tempdir()?;
    let source = tempfile::tempdir()?;
    std::fs::write(
        source.path().join("example.txt"),
        "GPUI native smoke test\n你好，Portiva。\n",
    )?;
    std::fs::write(source.path().join("binary.dat"), vec![0x53; 4096])?;
    std::fs::create_dir(source.path().join("documents"))?;
    for name in [
        "config.toml",
        "main.rs",
        "start.sh",
        "photo.png",
        "backup.tar.gz",
        "music.flac",
        "video.mp4",
        "report.csv",
    ] {
        std::fs::write(source.path().join(name), b"Synthetic icon preview fixture")?;
        std::fs::write(
            server.root.path().join(name),
            b"Synthetic icon preview fixture",
        )?;
    }
    std::fs::write(
        data.path().join("known_hosts.json"),
        serde_json::to_vec(&BTreeMap::from([(
            format!("[127.0.0.1]:{}", server.port),
            server.fingerprint.clone(),
        )]))?,
    )?;
    let profile = Profile {
        name: "本机回环验证".into(),
        host: "127.0.0.1".into(),
        port: server.port,
        username: "demo".into(),
        ..Default::default()
    };
    let reconnect_profile = profile.clone();
    let tab_test_profile = profile.clone();
    let store = Store::open(data.path())?;
    store.save_profile(profile.clone())?;
    let (client, events) = Client::new(store);
    let handle = runtime.handle().clone();
    let received = server.input.clone();
    let mut preferences = Settings {
        theme: ThemeMode::Light,
        ..Default::default()
    };
    preferences.terminal.palette_preset = PalettePreset::Dracula;
    preferences.terminal.font_size = 16;
    preferences.keymap.copy = "Ctrl+Alt+C".into();
    preferences.keymap.paste = "Ctrl+Alt+V".into();
    let background_path = data.path().join("smoke-background.png");
    let background = image::RgbImage::from_fn(480, 300, |x, y| {
        image::Rgb([(x / 2) as u8, (y / 2) as u8, 140])
    });
    background.save(&background_path)?;
    preferences.background = BackgroundSettings {
        enabled: true,
        image: Some(background_path),
        opacity: 55,
        blur: 6,
    };
    let complete = Arc::new(AtomicBool::new(false));
    let verification = complete.clone();
    let preview = std::env::var_os("PORTIVA_SMOKE_PREVIEW").is_some();
    let auth_only = std::env::var_os("PORTIVA_SMOKE_AUTH_ONLY").is_some();
    let highlight_preview = std::env::var("PORTIVA_SMOKE_HIGHLIGHT").as_deref() != Ok("0");
    let initial = source.path().to_path_buf();
    let seconds = std::env::var("PORTIVA_SMOKE_SECONDS")
        .ok()
        .and_then(|s| s.parse::<u64>().ok())
        .unwrap_or(300)
        .clamp(10, 600);
    gpui_kit::application().with_assets(app::assets::AppAssets).run(move |cx| {
        gpui_kit::init(cx);theme::init(cx);
        let bounds=Bounds::centered(None,size(px(1420.),px(900.)),cx);
        let check_client=client.clone();let check_runtime=handle.clone();let source_path=initial.join("example.txt");let mut session_id=uuid::Uuid::nil();
        let (window,view)=gpui_kit::open_window(WindowOptions{titlebar:Some(TitlebarOptions{title:Some("Portiva 2 · 本机回环 UI 验证".into()),..gpui_kit::component::TitleBar::title_bar_options()}),window_bounds:Some(WindowBounds::Windowed(bounds)),..gpui_kit::component::TitleBar::window_options()},cx,|window,cx|{
            window.set_window_title("Portiva 2 · 本机回环 UI 验证");
            cx.new(|cx|{let mut app=app::Workbench::new(client,handle,events,initial,window,cx);if preview {app.save_settings(preferences.clone(),window,cx);}session_id=app.begin_connection(profile,Credentials::password("portiva-test".into()),window,cx);app.open_settings(window,cx);app})
        }).expect("window");
        // Exercise the same core API while the GPUI event loop keeps rendering.
        cx.spawn(async move |cx| {
            let delay=check_runtime.spawn(async move{tokio::time::sleep(Duration::from_secs(2)).await;});let _=delay.await;
            for (protocol,editing) in [(Protocol::Ssh,true),(Protocol::Ssh,false),(Protocol::Sftp,true),(Protocol::Sftp,false)] {
                let mut auth_profile=tab_test_profile.clone();
                auth_profile.protocol=protocol.clone();
                auth_profile.x11=X11Settings{enabled:protocol==Protocol::Ssh,display:"localhost:0.2".into()};
                auth_profile.remember_secret=true;
                auth_profile.private_key_path=Some(source_path.with_file_name("synthetic-key"));
                if !editing {auth_profile.id=uuid::Uuid::new_v4().to_string();}
                let _=window.update(cx,|_,window,cx|view.update(cx,|view,cx|view.open_form(auth_profile,window,cx)));
                cx.background_executor().timer(Duration::from_millis(100)).await;
                for auth in [AuthMethod::PrivateKey,AuthMethod::Agent,AuthMethod::Password,AuthMethod::PrivateKey,AuthMethod::Password] {
                    let expected=auth.clone();
                    let _=window.update(cx,|_,window,cx|view.update(cx,|view,cx|view.select_authentication(auth,window,cx)));
                    cx.background_executor().timer(Duration::from_millis(100)).await;
                    let _=window.update(cx,|_,_,cx|{
                        let form=view.read(cx).form.as_ref().expect("connection form disappeared during authentication change");
                        assert_eq!(form.profile.auth,expected);
                        assert!(!form.busy);
                        assert!(!form.has_saved_secret);
                        let (profile,credentials)=form.values(cx).unwrap();
                        assert_eq!(profile.protocol,protocol);
                        assert_eq!(profile.x11.enabled,protocol==Protocol::Ssh,"authentication switching changed X11 forwarding");
                        assert_eq!(profile.x11.display,"localhost:0.2","authentication switching lost the X11 display");
                        assert!(profile.private_key_path.as_ref().is_some_and(|path|path.ends_with("synthetic-key")),"switching authentication lost the key path");
                        assert!(!profile.remember_secret,"switching authentication reused another method's credentials");
                        assert!(credentials.password.is_empty() && credentials.passphrase.is_empty(),"switching authentication retained a secret");
                    });
                }
                if protocol==Protocol::Ssh {
                    for enabled in [false,true] {
                        let _=window.update(cx,|_,_,cx|view.update(cx,|view,cx|view.set_x11_forwarding(enabled,cx)));
                        cx.background_executor().timer(Duration::from_millis(100)).await;
                        let _=window.update(cx,|_,_,cx|{
                            let (profile,_)=view.read(cx).form.as_ref().unwrap().values(cx).unwrap();
                            assert_eq!(profile.x11.enabled,enabled);
                            assert_eq!(profile.x11.display,"localhost:0.2");
                        });
                    }
                    for next in [Protocol::Sftp,Protocol::Ssh] {
                        let _=window.update(cx,|_,_,cx|view.update(cx,|view,cx|view.select_protocol(next,cx)));
                        cx.background_executor().timer(Duration::from_millis(100)).await;
                        let _=window.update(cx,|_,_,cx|assert!(!view.read(cx).form.as_ref().unwrap().values(cx).unwrap().0.x11.enabled,"SFTP retained X11 forwarding"));
                    }
                }
                let _=window.update(cx,|_,window,cx|window.dispatch_keystroke(Keystroke::parse("escape").unwrap(),cx));
                cx.background_executor().timer(Duration::from_millis(100)).await;
                let _=window.update(cx,|_,_,cx|assert!(view.read(cx).form.is_none(),"authentication form did not close"));
            }
            println!("Authentication form PASSED: new/edit SSH/SFTP auth methods, X11 enable/disable and protocol switching render on separate frames and preserve paths without reusing secrets.");
            if auth_only {
                verification.store(true,Ordering::SeqCst);
                cx.update(|cx|cx.quit());
                return;
            }
            // Persist layout through the real controls, then reopen a connection with it.
            let stale_settings=window.update(cx,|_,window,cx|view.update(cx,|view,cx|{
                assert_eq!(view.sftp_panel_state(session_id),Some(SftpPanelSettings::default()),"first SSH connection must hide SFTP");
                let stale=view.settings_view.as_ref().unwrap().read(cx).settings.clone();
                view.toggle_sftp(session_id,window,cx);
                view.swap_sftp_side(session_id,window,cx);
                assert!(view.sftp_panel_state(session_id).is_some_and(|s|s.visible && s.left));
                stale
            })).unwrap();
            cx.background_executor().timer(Duration::from_millis(400)).await;
            let remembered=check_client.store().settings().unwrap().sftp_panel;
            assert!(remembered.visible && remembered.left,"expanded/left SFTP state did not persist");
            let _=window.update(cx,|_,window,cx|view.update(cx,|view,cx|{
                let restored=view.begin_connection(reconnect_profile,Credentials::password("portiva-test".into()),window,cx);
                assert_eq!(view.sftp_panel_state(restored),Some(remembered.clone()),"new connection did not restore SFTP layout");
                view.close_tab(restored,window,cx);
                // A pending settings edit must not overwrite more recent panel changes.
                view.settings_view.as_ref().unwrap().update(cx,|_,cx|cx.emit(settings::SettingsEvent::Change(Box::new(stale_settings))));
            }));
            cx.background_executor().timer(Duration::from_millis(300)).await;
            assert_eq!(check_client.store().settings().unwrap().sftp_panel,remembered,"settings editor overwrote SFTP layout");
            let _=window.update(cx,|_,window,cx|view.update(cx,|view,cx|{
                view.toggle_sftp(session_id,window,cx);
                view.swap_sftp_side(session_id,window,cx);
                assert_eq!(view.sftp_panel_state(session_id),Some(SftpPanelSettings::default()));
                view.open_settings(window,cx);
            }));
            cx.background_executor().timer(Duration::from_millis(300)).await;
            assert_eq!(check_client.store().settings().unwrap().sftp_panel,SftpPanelSettings::default(),"collapsed/right SFTP state did not persist");
            println!("SFTP layout PASSED: hidden default, last side/visibility persisted, new connection restored, stale settings edit preserved layout.");
            // These tabs wait for a synthetic password inline and never contact a server.
            let mut scratch=window.update(cx,|_,window,cx|view.update(cx,|view,cx|{
                view.close_settings(window,cx);
                (0..3).map(|index| {
                    let mut profile=tab_test_profile.clone();
                    profile.name=format!("标签滚动验证 {}",index+1);
                    view.begin_connection(profile,Credentials::default(),window,cx)
                }).collect::<Vec<_>>()
            })).unwrap();
            cx.background_executor().timer(Duration::from_millis(200)).await;
            let _=window.update(cx,|_,window,cx|{
                let scroll=&view.read(cx).tabs_scroll;
                assert_eq!(scroll.bounds_for_item(1).unwrap().size.width,px(208.),"inactive tab collapsed while there was enough room");
                assert_eq!(scroll.max_offset().x,px(0.),"expanded tabs overflowed the available room");
                window.resize(size(px(1000.),px(900.)));
            });
            cx.background_executor().timer(Duration::from_millis(250)).await;
            let _=window.update(cx,|_,window,cx|{
                let scroll=&view.read(cx).tabs_scroll;
                assert_eq!(scroll.bounds_for_item(1).unwrap().size.width,px(44.),"tabs did not compact when the window became too narrow");
                assert_eq!(scroll.bounds_for_item(4).unwrap().size.width,px(208.),"selected tab collapsed with inactive tabs");
                window.resize(size(px(1420.),px(900.)));
            });
            cx.background_executor().timer(Duration::from_millis(250)).await;
            let more=window.update(cx,|_,window,cx|{
                assert_eq!(view.read(cx).tabs_scroll.bounds_for_item(1).unwrap().size.width,px(208.),"tabs did not expand after restoring window space");
                view.update(cx,|view,cx|(3..26).map(|index|{
                    let mut profile=tab_test_profile.clone();
                    profile.name=format!("标签滚动验证 {}",index+1);
                    view.begin_connection(profile,Credentials::default(),window,cx)
                }).collect::<Vec<_>>())
            }).unwrap();
            scratch.extend(more);
            cx.background_executor().timer(Duration::from_millis(200)).await;
            let old_offset=window.update(cx,|_,window,cx|{
                let scroll=&view.read(cx).tabs_scroll;
                assert!(scroll.max_offset().x>px(0.),"overflowing tabs did not form a horizontal viewport");
                assert!(scroll.offset().x<px(0.),"newly selected tab was not revealed");
                assert_eq!(scroll.bounds_for_item(1).unwrap().size.width,px(44.),"inactive SSH tab did not collapse");
                assert_eq!(scroll.bounds_for_item(27).unwrap().size.width,px(208.),"active tab did not expand");
                let offset=scroll.offset().x;
                let position=scroll.bounds().center();
                window.dispatch_event(ScrollEvent{position,delta:ScrollDelta::Lines(point(0.,3.)),..Default::default()}.to_platform_input(),cx);
                offset
            }).unwrap();
            cx.background_executor().timer(Duration::from_millis(150)).await;
            let _=window.update(cx,|_,_,cx|{
                let scroll=&view.read(cx).tabs_scroll;
                assert!(scroll.offset().x>old_offset,"vertical mouse wheel did not scroll the tab strip horizontally");
                scroll.scroll_to_item(1);
                cx.notify(view.entity_id());
            });
            cx.background_executor().timer(Duration::from_millis(150)).await;
            let _=window.update(cx,|_,window,cx|{
                let scroll=&view.read(cx).tabs_scroll;
                let position=scroll.bounds_for_item(2).unwrap().center()+scroll.offset();
                window.dispatch_event(MouseDownEvent{position,button:MouseButton::Middle,click_count:1,..Default::default()}.to_platform_input(),cx);
                window.dispatch_event(MouseUpEvent{position,button:MouseButton::Middle,click_count:1,..Default::default()}.to_platform_input(),cx);
            });
            cx.background_executor().timer(Duration::from_millis(150)).await;
            let _=window.update(cx,|_,window,cx|view.update(cx,|view,cx|{
                assert!(view.tabs_scroll.bounds_for_item(27).is_none(),"middle click did not close an inactive tab");
                for id in scratch {view.close_tab(id,window,cx);}
            }));
            let local_id=window.update(cx,|_,window,cx|view.update(cx,|view,cx|view.begin_local_terminal(window,cx).expect("local terminal tab"))).unwrap();
            let mut local_terminal=None;
            for _ in 0..50 {
                cx.background_executor().timer(Duration::from_millis(100)).await;
                local_terminal=window.update(cx,|_,_,cx|view.read(cx).active_terminal()).unwrap();
                if local_terminal.is_some(){break;}
            }
            let local_terminal=local_terminal.expect("native local shell never opened");
            let local_first=window.update(cx,|_,_,cx|local_terminal.read(cx).handle.id).unwrap();
            let _=window.update(cx,|_,window,cx|view.update(cx,|view,cx|view.split_terminal(local_id,SplitDirection::Rows,window,cx)));
            for _ in 0..50 {
                cx.background_executor().timer(Duration::from_millis(100)).await;
                if window.update(cx,|_,_,cx|view.read(cx).active_terminal().is_some_and(|pane|pane.read(cx).handle.id!=local_first)).unwrap(){break;}
            }
            let local_second=window.update(cx,|_,_,cx|{
                let second=view.read(cx).active_terminal().unwrap();
                assert_ne!(second.read(cx).handle.id,local_first,"local terminal split did not open an independent PTY");
                assert!(local_terminal.read(cx).can_close);
                assert!(second.read(cx).can_close);
                local_terminal.update(cx,|terminal,cx|terminal.request_close(cx));
                second
            }).unwrap();
            cx.background_executor().timer(Duration::from_millis(75)).await;
            let _=window.update(cx,|_,window,cx|view.update(cx,|view,cx|{
                let remaining=local_second.read(cx).handle.id;
                assert_eq!(view.active_terminal().unwrap().read(cx).handle.id,remaining,"closing an inactive pane changed the active terminal");
                assert!(!local_second.read(cx).can_close,"last local pane's close button should be disabled");
                view.close_terminal(local_id,remaining,window,cx);
                assert_eq!(view.active_terminal().unwrap().read(cx).handle.id,remaining,"closed the last local terminal");
                view.close_tab(local_id,window,cx);
                view.select_session(session_id,window,cx);
                view.open_settings(window,cx);
            }));
            println!("Local terminal and tabs PASSED: native PTY split/close, last-pane guard, inline login, compact/expanded tabs, horizontal wheel, automatic reveal, middle-click close.");
            if preview {
                verification.store(true,Ordering::SeqCst);
                println!("Native preview READY: disposable loopback SSH/SFTP with background settings; clipboard checks skipped.");
                return;
            }
            let terminal=window.update(cx,|_,_,cx|view.read(cx).active_terminal().expect("terminal must be ready")).unwrap();
            let _=window.update(cx,|_,window,cx| { window.dispatch_keystroke(Keystroke::parse("tab").unwrap(),cx); });
            cx.background_executor().timer(Duration::from_millis(150)).await;
            assert!(received.lock().unwrap().is_empty(),"background SSH connection stole keyboard focus from settings");
            let _=window.update(cx,|_,window,cx|view.update(cx,|view,cx|view.select_session(session_id,window,cx)));
            let _=window.update(cx,|_,window,cx|{
                for key in ["tab","shift-tab","ctrl-c"] {assert!(window.dispatch_keystroke(Keystroke::parse(key).unwrap(),cx),"terminal did not handle {key}");}
            });
            cx.background_executor().timer(Duration::from_millis(150)).await;
            assert_eq!(&*received.lock().unwrap(),b"\t\x1b[Z\x03","Tab, Shift+Tab and Ctrl+C must reach SSH exactly once");
            let _=window.update(cx,|_,window,cx|{
                let previous_clipboard=cx.read_from_clipboard();
                terminal.update(cx,|terminal,cx|terminal.select_all(cx));
                let expected=terminal.read(cx).selected_text().expect("fixture has selectable output");
                assert!(window.dispatch_keystroke(Keystroke::parse("ctrl-shift-c").unwrap(),cx));
                assert_eq!(cx.read_from_clipboard().and_then(|c|c.text()),Some(expected.clone())); assert!(window.dispatch_keystroke(Keystroke::parse("ctrl-c").unwrap(),cx)); assert_eq!(cx.read_from_clipboard().and_then(|c|c.text()),Some(expected));
                cx.write_to_clipboard(ClipboardItem::new_string("smoke-single".into()));
                assert!(window.dispatch_keystroke(Keystroke::parse("ctrl-shift-v").unwrap(),cx));
                cx.write_to_clipboard(ClipboardItem::new_string("first\nsecond".into()));
                assert!(window.dispatch_keystroke(Keystroke::parse("ctrl-shift-v").unwrap(),cx));
                assert!(terminal.read(cx).has_pending_paste(),"multiline paste should require confirmation");
                if let Some(previous)=previous_clipboard {cx.write_to_clipboard(previous);}else{cx.write_to_clipboard(ClipboardItem::new_string(String::new()));}
            });
            cx.background_executor().timer(Duration::from_millis(150)).await;
            assert_eq!(&*received.lock().unwrap(),b"\t\x1b[Z\x03smoke-single","multiline text leaked before confirmation");
            let _=window.update(cx,|_,window,cx|terminal.update(cx,|terminal,cx|terminal.confirm_paste(window,cx)));
            cx.background_executor().timer(Duration::from_millis(150)).await;
            assert!(received.lock().unwrap().ends_with(b"first\rsecond"));
            let mut saved_preferences=preferences.clone();
            saved_preferences.terminal.font_family=window.update(cx,|_,_,cx|{
                let installed=cx.text_system().all_font_names();
                assert!(!installed.is_empty(),"platform text system returned no installed fonts");
                installed.iter().find(|family| family.as_str()=="Cascadia Mono")
                    .unwrap_or(&installed[0]).clone()
            }).unwrap();
            saved_preferences.terminal.font_size=18;
            preferences.keymap=KeymapSettings::default();
            let editor=window.update(cx,|_,window,cx|view.update(cx,|view,cx|{
                view.open_settings(window,cx);
                let editor=view.settings_view.clone().unwrap();
                editor.update(cx,|editor,cx|{
                    editor.settings=preferences.clone();
                    editor.select_section(1,cx);
                });
                view.save_settings(preferences,window,cx);
                assert_eq!(theme::colors(cx).bg,0xf5f7fa,"theme should apply before disk or background work finishes");
                editor
            })).unwrap();
            cx.background_executor().timer(Duration::from_millis(150)).await;
            let font_size=window.update(cx,|_,window,cx|{
                let font=editor.read(cx).font.clone();
                font.update(cx,|select,cx|{
                    select.set_selected_value(&saved_preferences.terminal.font_family,window,cx);
                    cx.emit(gpui_kit::component::select::SelectEvent::Confirm(select.selected_value().cloned()));
                });
                let font_size=editor.read(cx).font_size.clone();
                font_size.update(cx,|input,cx|{
                    input.focus(window,cx);
                    input.replace_all("18",window,cx);
                });
                font_size
            }).unwrap();
            cx.background_executor().timer(Duration::from_millis(300)).await;
            let _=window.update(cx,|_,window,cx|{
                assert!(font_size.read(cx).focus_handle(cx).is_focused(window),"autosave stole font size input focus");
                assert_eq!(editor.read(cx).settings.terminal.font_family,saved_preferences.terminal.font_family);
                assert_eq!(editor.read(cx).settings.terminal.font_size,18);
                let language=editor.read(cx).code_language.clone();
                language.update(cx,|select,cx|{
                    select.set_selected_value(&"C#".to_owned(),window,cx);
                    cx.emit(gpui_kit::component::select::SelectEvent::Confirm(select.selected_value().cloned()));
                });
            });
            cx.background_executor().timer(Duration::from_millis(250)).await;
            assert_eq!(check_client.store().settings().unwrap().terminal.highlighting.language,CodeLanguage::CSharp,"highlight language did not autosave");
            let _=window.update(cx,|_,window,cx|{
                assert_eq!(editor.read(cx).settings.terminal.highlighting.language,CodeLanguage::CSharp);
                let language=editor.read(cx).code_language.clone();
                language.update(cx,|select,cx|{
                    select.set_selected_value(&"自动识别".to_owned(),window,cx);
                    cx.emit(gpui_kit::component::select::SelectEvent::Confirm(select.selected_value().cloned()));
                });
                font_size.update(cx,|input,cx|input.replace_all("",window,cx));
            });
            cx.background_executor().timer(Duration::from_millis(150)).await;
            let _=window.update(cx,|_,window,cx|{
                assert_eq!(editor.read(cx).settings.terminal.font_size,18,"incomplete size replaced last valid value");
                font_size.update(cx,|input,cx|input.replace_all("100",window,cx));
            });
            cx.background_executor().timer(Duration::from_millis(75)).await;
            let _=window.update(cx,|_,window,cx|{
                assert_eq!(editor.read(cx).settings.terminal.font_size,18,"out-of-range size replaced last valid value");
                font_size.update(cx,|input,cx|input.replace_all("18",window,cx));
                editor.update(cx,|editor,cx|editor.select_section(2,cx));
            });
            cx.background_executor().timer(Duration::from_millis(100)).await;
            let _=window.update(cx,|_,window,cx|{
                for (index,text) in [(0,"Ctrl+Alt+C"),(1,"Ctrl+Alt+V")] {
                    let input=editor.read(cx).shortcuts[index].clone();
                    input.update(cx,|input,cx|input.replace_all(text,window,cx));
                }
            });
            cx.background_executor().timer(Duration::from_millis(200)).await;
            let copy_input=window.update(cx,|_,window,cx|{
                assert_eq!(editor.read(cx).settings.keymap,saved_preferences.keymap,"valid shortcut edits did not apply");
                let input=editor.read(cx).shortcuts[0].clone();
                input.update(cx,|input,cx|{
                    input.focus(window,cx);
                    input.replace_all("Ctrl+Alt+V",window,cx);
                });
                input
            }).unwrap();
            cx.background_executor().timer(Duration::from_millis(150)).await;
            let _=window.update(cx,|_,window,cx|{
                assert_eq!(editor.read(cx).settings.keymap.copy,"Ctrl+Alt+C","duplicate shortcut replaced last valid value");
                copy_input.update(cx,|input,cx|input.replace_all("Ctrl+",window,cx));
            });
            cx.background_executor().timer(Duration::from_millis(150)).await;
            let _=window.update(cx,|_,window,cx|{
                assert_eq!(editor.read(cx).settings.keymap.copy,"Ctrl+Alt+C","incomplete shortcut replaced last valid value");
                assert!(copy_input.read(cx).focus_handle(cx).is_focused(window),"autosave stole shortcut input focus");
                editor.update(cx,|editor,cx|{
                    for step in 0..25 {
                        editor.settings.background.opacity=step;
                        editor.settings.background.blur=step%12;
                        cx.emit(settings::SettingsEvent::Change(Box::new(editor.settings.clone())));
                    }
                    editor.settings.background=saved_preferences.background.clone();
                    cx.emit(settings::SettingsEvent::Change(Box::new(editor.settings.clone())));
                });
            });
            // Let the emitted changes enter the writer, then close the settings tab while pending.
            cx.background_executor().timer(Duration::from_millis(15)).await;
            let _=window.update(cx,|_,window,cx|view.update(cx,|view,cx|{
                view.close_settings(window,cx);
                assert!(view.settings_view.is_none(),"pending autosave blocked closing settings");
            }));
            drop(editor);
            cx.background_executor().timer(Duration::from_secs(2)).await;
            assert_eq!(check_client.store().settings().unwrap(),saved_preferences,"final valid preferences did not persist after settings closed");
            let _=window.update(cx,|_,window,cx|{
                assert_eq!(theme::colors(cx).bg,0xf5f7fa,"light theme did not apply");
                let previous_clipboard=cx.read_from_clipboard();
                terminal.update(cx,|terminal,cx|terminal.select_all(cx));
                assert!(window.dispatch_keystroke(Keystroke::parse("ctrl-alt-c").unwrap(),cx),"custom copy shortcut did not apply");
                assert_eq!(cx.read_from_clipboard().and_then(|c|c.text()),terminal.read(cx).selected_text());
                cx.write_to_clipboard(ClipboardItem::new_string("custom-paste".into()));
                assert!(window.dispatch_keystroke(Keystroke::parse("ctrl-alt-v").unwrap(),cx),"custom paste shortcut did not apply");
                if let Some(previous)=previous_clipboard {cx.write_to_clipboard(previous);}else{cx.write_to_clipboard(ClipboardItem::new_string(String::new()));}
                assert!(window.dispatch_keystroke(Keystroke::parse("ctrl-,").unwrap(),cx),"settings shortcut did not open");
                assert!(window.dispatch_keystroke(Keystroke::parse("ctrl-n").unwrap(),cx),"new connection shortcut did not open the modal");
                assert!(window.dispatch_keystroke(Keystroke::parse("escape").unwrap(),cx),"Escape did not close the connection modal");
            });
            for _ in 0..40 {
                if received.lock().unwrap().ends_with(b"custom-paste") {break;}
                cx.background_executor().timer(Duration::from_millis(50)).await;
            }
            assert!(received.lock().unwrap().ends_with(b"custom-paste"),"custom paste did not reach SSH: {:?}",String::from_utf8_lossy(&received.lock().unwrap()));
            let _=window.update(cx,|_,window,cx|view.update(cx,|view,cx|{
                view.select_session(session_id,window,cx);
                view.split_terminal(session_id,SplitDirection::Columns,window,cx);
            }));
            let mut second=None;
            for _ in 0..100 {
                cx.background_executor().timer(Duration::from_millis(50)).await;
                let current=window.update(cx,|_,_,cx|view.read(cx).active_terminal()).unwrap();
                if let Some(current)=current && window.update(cx,|_,_,cx|current.read(cx).handle.id!=terminal.read(cx).handle.id).unwrap() {
                    second=Some(current);break;
                }
            }
            let second=second.expect("left/right split did not open a second PTY");
            let _=window.update(cx,|_,window,cx|view.update(cx,|view,cx|view.split_terminal(session_id,SplitDirection::Rows,window,cx)));
            let mut third=None;
            for _ in 0..100 {
                cx.background_executor().timer(Duration::from_millis(50)).await;
                let current=window.update(cx,|_,_,cx|view.read(cx).active_terminal()).unwrap();
                if let Some(current)=current && window.update(cx,|_,_,cx|current.read(cx).handle.id!=second.read(cx).handle.id).unwrap() {
                    third=Some(current);break;
                }
            }
            let third=third.expect("top/bottom split did not open a third PTY");
            let panes=[terminal.clone(),second.clone(),third.clone()];
            for (index,pane) in panes.iter().enumerate() {
                let _=window.update(cx,|_,window,cx|{window.activate_window();let focus=pane.focus_handle(cx);window.focus(&focus,cx);});
                // Focus subscriptions run with rendered frames; background Windows can be throttled.
                for _ in 0..40 {
                    cx.background_executor().timer(Duration::from_millis(50)).await;
                    if window.update(cx,|_,window,cx|{
                        pane.focus_handle(cx).is_focused(window) && view.read(cx).active_terminal().is_some_and(|active|active.read(cx).handle.id==pane.read(cx).handle.id)
                    }).unwrap_or(false) {break;}
                }
                let _=window.update(cx,|_,window,cx|{
                    assert_eq!(view.read(cx).active_terminal().unwrap().read(cx).handle.id,pane.read(cx).handle.id,"focus did not select pane {index}; window active: {}",window.is_window_active());
                    for candidate in &panes {
                        assert_eq!(candidate.read(cx).active,candidate==pane,"title highlight did not follow the active pane");
                    }
                    pane.update(cx,|pane,cx|pane.feed(format!("\x1b]2;终端 {}\x07",index+1).as_bytes(),window,cx));
                    assert_eq!(pane.read(cx).title,format!("终端 {}",index+1),"OSC title stopped updating");
                    assert_eq!(view.read(cx).session_title(session_id,cx),Some(format!("终端 {}",index+1)),"session title did not follow the focused pane");
                    pane.read(cx).handle.write(format!("\r\npane-{}-only\r\n",index+1)).unwrap();
                    assert!(window.dispatch_keystroke(Keystroke::parse("tab").unwrap(),cx));
                });
            }
            cx.background_executor().timer(Duration::from_millis(200)).await;
            let _=window.update(cx,|_,window,cx|{
                second.update(cx,|pane,cx|pane.feed(b"\x1b]2;Background task\x07",window,cx));
                assert_eq!(view.read(cx).session_title(session_id,cx).as_deref(),Some("终端 3"),"background pane replaced the active task title");
                third.update(cx,|pane,cx|pane.feed(b"\x1b]2;\x07",window,cx));
                assert_eq!(view.read(cx).session_title(session_id,cx).as_deref(),Some("本机回环验证"),"empty title did not restore the connection name");
                third.update(cx,|pane,cx|pane.feed(b"\x1b]2;Codex CLI\x07",window,cx));
                assert_eq!(view.read(cx).session_title(session_id,cx).as_deref(),Some("Codex CLI"));
            });
            let mut split_preferences=saved_preferences.clone();
            split_preferences.keymap.copy="Ctrl+Alt+Shift+C".into();
            let _=window.update(cx,|_,window,cx|view.update(cx,|view,cx|view.save_settings(split_preferences,window,cx)));
            for pane in &panes {
                let _=window.update(cx,|_,window,cx|{let focus=pane.focus_handle(cx);window.focus(&focus,cx);});
                cx.background_executor().timer(Duration::from_millis(50)).await;
                let _=window.update(cx,|_,window,cx|{
                    let previous_clipboard=cx.read_from_clipboard();
                    pane.update(cx,|pane,cx|pane.select_all(cx));
                    assert!(window.dispatch_keystroke(Keystroke::parse("ctrl-alt-shift-c").unwrap(),cx),"settings did not reach every split pane");
                    assert_eq!(cx.read_from_clipboard().and_then(|c|c.text()),pane.read(cx).selected_text());
                    if let Some(previous)=previous_clipboard {cx.write_to_clipboard(previous);}else{cx.write_to_clipboard(ClipboardItem::new_string(String::new()));}
                });
            }
            let _=window.update(cx,|_,window,cx|view.update(cx,|view,cx|view.save_settings(saved_preferences.clone(),window,cx)));
            for _ in 0..2 {
                let _=window.update(cx,|_,window,cx|view.update(cx,|view,cx|view.swap_sftp_side(session_id,window,cx)));
                cx.background_executor().timer(Duration::from_millis(100)).await;
                let _=window.update(cx,|_,_,cx|{
                    assert_eq!(view.read(cx).active_terminal().unwrap(),third,"SFTP swap changed the active terminal");
                    assert!(third.read(cx).active,"SFTP swap cleared the active title highlight");
                });
            }
            let _=window.update(cx,|_,window,cx|{
                for (index,pane) in panes.iter().enumerate() {
                    pane.update(cx,|pane,cx|pane.select_all(cx));
                    let text=pane.read(cx).selected_text().unwrap();
                    assert!(text.contains(&format!("pane-{}-only",index+1)),"pane lost its own output: {text}");
                    for other in 0..3 {
                        if index!=other {assert!(!text.contains(&format!("pane-{}-only",other+1)),"output crossed pane boundaries");}
                    }
                }
                view.update(cx,|view,cx|{
                    view.toggle_sftp(session_id,window,cx);
                    view.swap_sftp_side(session_id,window,cx);
                    view.toggle_files_mode(session_id,window,cx);
                    view.swap_sftp_side(session_id,window,cx);
                    view.toggle_files_mode(session_id,window,cx);
                    view.toggle_sftp(session_id,window,cx);
                });
                let focus=third.focus_handle(cx);window.focus(&focus,cx);
            });
            cx.background_executor().timer(Duration::from_millis(75)).await;
            let _=window.update(cx,|_,_,cx|{
                second.update(cx,|terminal,cx|terminal.request_close(cx));
            });
            cx.background_executor().timer(Duration::from_millis(75)).await;
            let _=window.update(cx,|_,_,cx|{
                assert_eq!(view.read(cx).active_terminal().unwrap(),third,"closing an inactive SSH pane changed the active terminal");
                assert!(third.read(cx).active,"inactive close cleared the active title highlight");
                third.update(cx,|terminal,cx|terminal.request_close(cx));
            });
            cx.background_executor().timer(Duration::from_millis(75)).await;
            let _=window.update(cx,|_,window,cx|view.update(cx,|view,cx|{
                assert_eq!(view.active_terminal().unwrap(),terminal);
                assert!(terminal.read(cx).active,"last terminal lost its title highlight");
                assert_eq!(view.session_title(session_id,cx).as_deref(),Some("终端 1"),"closing the active pane did not restore its sibling's task title");
                assert!(!terminal.read(cx).can_close,"last SSH pane's close button should be disabled");
                view.close_terminal(session_id,terminal.read(cx).handle.id,window,cx);
                terminal.read(cx).handle.write(b"last-pane-alive".to_vec()).unwrap();
                assert_eq!(view.active_terminal().unwrap().read(cx).handle.id,terminal.read(cx).handle.id,"last terminal was removed");
            }));
            cx.background_executor().timer(Duration::from_millis(150)).await;
            assert!(received.lock().unwrap().ends_with(b"last-pane-alive"));
            let previous_clipboard=window.update(cx,|_,window,cx|{
                let previous=cx.read_from_clipboard();
                window.activate_window();
                let focus=terminal.focus_handle(cx);window.focus(&focus,cx);
                previous
            }).unwrap();
            cx.background_executor().timer(Duration::from_millis(150)).await;
            let cli_text="长提示词 / code block / emoji 👩‍💻\r\n".repeat(4096);
            let expected_paste=format!("\x1b[200~{}\x1b[201~",cli_text.replace("\r\n","\n")).into_bytes();
            let _=window.update(cx,|_,window,cx|{
                terminal.update(cx,|terminal,cx|{
                    terminal.feed(b"\x1b[?2004h\x1b[?1006h\x1b[?1002h\x1b]52;c;bmF0aXZlLWNsaS1jb3B5\x07",window,cx);
                });
                assert_eq!(cx.read_from_clipboard().and_then(|item|item.text()).as_deref(),Some("native-cli-copy"),"focused CLI OSC 52 copy did not reach the OS clipboard");
                terminal.update(cx,|terminal,cx|{
                    terminal.set_active(false,cx);
                    terminal.feed(b"\x1b]52;c;aGlkZGVu\x07\x1b]52;c;?\x07",window,cx);
                    terminal.set_active(true,cx);
                });
                assert_eq!(cx.read_from_clipboard().and_then(|item|item.text()).as_deref(),Some("native-cli-copy"),"background CLI overwrote the clipboard");
                cx.write_to_clipboard(ClipboardItem::new_string(cli_text));
                assert!(window.dispatch_keystroke(Keystroke::parse("ctrl-shift-v").unwrap(),cx),"standard paste shortcut was lost after customizing shortcuts");
                assert!(terminal.read(cx).has_pending_paste());
                terminal.update(cx,|terminal,cx|terminal.confirm_paste(window,cx));
            });
            for _ in 0..100 {
                if received.lock().unwrap().ends_with(&expected_paste){break;}
                cx.background_executor().timer(Duration::from_millis(25)).await;
            }
            assert!(received.lock().unwrap().ends_with(&expected_paste),"large CLI paste was truncated or split into repeated paste events");
            cx.background_executor().timer(Duration::from_millis(250)).await;
            let _=window.update(cx,|_,window,cx|{
                assert!(window.dispatch_keystroke(Keystroke::parse("ctrl-shift-home").unwrap(),cx));
                assert!(window.dispatch_keystroke(Keystroke::parse("ctrl-shift-end").unwrap(),cx));
                assert!(window.dispatch_keystroke(Keystroke::parse("ctrl-shift-a").unwrap(),cx));
                assert!(window.dispatch_keystroke(Keystroke::parse("ctrl-shift-c").unwrap(),cx));
                assert!(cx.read_from_clipboard().and_then(|item|item.text()).is_some_and(|text|text.contains("长提示词 / code block")),"large CLI output could not be copied");
                terminal.update(cx,|terminal,cx|terminal.feed(b"\x1b[?2004l\x1b[?1002l\x1b[?1006l",window,cx));
                if let Some(previous)=previous_clipboard {cx.write_to_clipboard(previous);}else{cx.write_to_clipboard(ClipboardItem::new_string(String::new()));}
            });
            println!("CLI terminal PASSED: focused OSC 52 copy, background/read isolation, standard shortcuts after customization, 4,096-line Unicode paste as one bracketed event, long output copy and history navigation.");
            let browse_client=check_client.clone();
            assert!(!check_runtime.spawn(async move {browse_client.list_remote(session_id,"/").await}).await.unwrap().unwrap().entries.is_empty(),"closing panes disconnected SFTP");
            let _=window.update(cx,|_,window,cx|view.update(cx,|view,cx|view.file_action(session_id,files::FileAction::Transfer{entries:vec![FileEntry{name:"example.txt".into(),path:source_path.to_string_lossy().into_owned(),kind:FileKind::File,size:0,modified:None,permissions:None}],remote:false},window,cx)));
            cx.background_executor().timer(Duration::from_secs(2)).await;
            let _=window.update(cx,|_,window,cx|view.update(cx,|view,cx|{view.select_session(session_id,window,cx);view.set_files_mode(session_id,true,cx);}));
            assert!(!check_client.transfers().is_empty(),"UI did not enqueue the fixture upload");
            assert!(check_client.transfers().iter().all(|t|t.status==TransferStatus::Completed),"fixture transfer failed: {:?}",check_client.transfers());
            if highlight_preview {
                let _=window.update(cx,|_,window,cx|view.update(cx,|view,cx|{
                    let mut display=saved_preferences.clone();
                    display.theme=ThemeMode::Dark;
                    display.background.enabled=false;
                    display.terminal.font_size=16;
                    display.terminal.palette_preset=PalettePreset::Dark;
                    view.close_settings(window,cx);
                    view.save_settings(display,window,cx);
                    view.select_session(session_id,window,cx);
                    view.set_files_mode(session_id,false,cx);
                    terminal.update(cx,|terminal,cx|terminal.feed(concat!(
                        "\x1bc\x1b[3J\x1b[2J\x1b[H\x1b]2;颜色预览 · cat / tail\x07",
                        "demo@host:~$ tail -f /var/log/app.log\r\n",
                        "2026-11-27 18:32:01 [INFO] 服务已启动，等待连接\r\n",
                        "2026-11-27 18:32:02 [WARN] 请求耗时较长，即将重试\r\n",
                        "2026-11-27 18:32:03 [ERROR] 连接失败：connection refused\r\n",
                        "    at Portiva.Client.Connect()\r\n",
                        "SUCCESS 重新连接成功\r\n",
                        "DEBUG loading configuration\r\n",
                        "demo@host:~$ cat index.html\r\n",
                        "<!DOCTYPE html>\r\n",
                        "<div class=\"notice\" id=\"welcome\">\r\n",
                        "  <!-- 提示内容 -->\r\n",
                        "  <h1>Hello, Portiva!</h1>\r\n",
                        "</div>\r\n",
                        "demo@host:~$ cat Greeting.cs\r\n",
                        "using System;\r\n",
                        "public class Greeting {\r\n",
                        "    public string Welcome() { return \"你好，Portiva\"; }\r\n",
                        "}\r\n",
                        "demo@host:~$ cat site.css\r\n",
                        ".notice { color: #61afef; padding: 16px; }\r\n",
                        "demo@host:~$ "
                    ).as_bytes(),window,cx));
                }));
            }
            verification.store(true,Ordering::SeqCst);
            println!("Native smoke PASSED: SFTP side swaps in terminal/files/hidden modes, active title highlights and OSC updates, left/right and top/bottom splits, independent PTYs/output/focus, sibling close and last-terminal guard, SFTP collapse and mode restore, immediate theme, automatic font/shortcut changes, validation, focus preservation, rapid settings edits saved after closing, background SSH focus, modal Escape, Tab/Shift+Tab/Ctrl+C, clipboard, multiline confirmation, live shortcuts, background processing, SSH/SFTP and upload.");
        }).detach();
        cx.spawn(async move |cx|{cx.background_executor().timer(Duration::from_secs(seconds)).await;cx.update(|cx|cx.quit());}).detach();
        cx.activate(true);
    });
    drop(server);
    drop(source);
    drop(data);
    runtime.shutdown_timeout(Duration::from_secs(2));
    anyhow::ensure!(
        complete.load(Ordering::SeqCst),
        "native smoke did not finish verification"
    );
    Ok(())
}
