use super::*;
use gpui_kit::component::tooltip::Tooltip;
use std::time::{Duration, Instant};

#[derive(Default)]
pub(super) struct ResourceMonitor {
    pub(super) latest: Option<RemoteResources>,
    cpu_percent: Option<f32>,
    pending: bool,
    next_refresh: Option<Instant>,
    updated: Option<Instant>,
    error: Option<String>,
}

impl Workbench {
    pub(super) fn refresh_resources(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.home_active || self.settings_active {
            return;
        }
        let Some(id) = self.active else { return };
        let Some(tab) = self.tab_mut(id) else { return };
        if tab.local_shell.is_some()
            || tab.state != ConnectionState::Ready
            || tab.resources.pending
            || tab
                .resources
                .next_refresh
                .is_some_and(|time| Instant::now() < time)
        {
            return;
        }
        tab.resources.pending = true;
        let client = self.client.clone();
        jobs::run(
            &self.runtime,
            window,
            cx,
            async move { client.remote_resources(id).await },
            move |view, result, _, cx| {
                let Some(tab) = view.tab_mut(id) else { return };
                let monitor = &mut tab.resources;
                monitor.pending = false;
                match result {
                    Ok(latest) => {
                        monitor.cpu_percent = monitor
                            .updated
                            .filter(|time| time.elapsed() <= Duration::from_secs(10))
                            .and(monitor.latest.as_ref())
                            .and_then(|old| latest.cpu.usage_since(old.cpu));
                        monitor.latest = Some(latest);
                        monitor.updated = Some(Instant::now());
                        monitor.error = None;
                        monitor.next_refresh = Some(Instant::now() + Duration::from_secs(3));
                    }
                    Err(error) => {
                        monitor.latest = None;
                        monitor.cpu_percent = None;
                        monitor.updated = None;
                        monitor.error = Some(format!("{error:#}"));
                        monitor.next_refresh = Some(Instant::now() + Duration::from_secs(30));
                    }
                }
                cx.notify();
            },
        );
    }

    pub(super) fn render_resource_bar(&self, tab: &SessionTab, cx: &App) -> impl IntoElement {
        let monitor = &tab.resources;
        let current = monitor
            .updated
            .is_some_and(|time| time.elapsed() <= Duration::from_secs(10));
        let resources = monitor.latest.as_ref().filter(|_| current);
        let cpu = monitor.cpu_percent.filter(|_| current);
        let memory = resources.and_then(|sample| sample.memory);
        let disk = resources.and_then(|sample| sample.disk);
        let label = if monitor.error.is_some() {
            "资源信息不可用"
        } else if resources.is_none() || monitor.pending {
            "正在采集…"
        } else {
            "远端资源"
        };
        let tooltip = monitor.error.clone().unwrap_or_else(|| {
            "当前连接服务器的资源占用，每 3 秒采集；CPU 使用两次采样计算，磁盘为根分区 /。需要服务器支持 Linux /proc 和 SSH exec。".into()
        });
        row()
            .h(px(30.))
            .flex_shrink_0()
            .px_3()
            .gap_4()
            .bg(panel(cx))
            .border_t_1()
            .border_color(rgb(colors(cx).border))
            .text_xs()
            .text_color(rgb(colors(cx).muted))
            .child(
                row()
                    .id("resource-source")
                    .gap_2()
                    .min_w_0()
                    .tooltip(move |window, cx| Tooltip::new(tooltip.clone()).build(window, cx))
                    .child(
                        div()
                            .size(px(5.))
                            .rounded_full()
                            .bg(rgb(if resources.is_some() {
                                0x67c69d
                            } else {
                                colors(cx).muted
                            })),
                    )
                    .child(div().truncate().child(label)),
            )
            .child(div().flex_1())
            .child(resource_item("CPU", IconName::Cpu, cpu, None, cx))
            .child(resource_item(
                "内存",
                IconName::MemoryStick,
                memory.map(ResourceUsage::percent),
                memory,
                cx,
            ))
            .child(resource_item(
                "磁盘 /",
                IconName::HardDrive,
                disk.map(ResourceUsage::percent),
                disk,
                cx,
            ))
    }
}

fn resource_item(
    label: &'static str,
    icon: IconName,
    percent: Option<f32>,
    usage: Option<ResourceUsage>,
    cx: &App,
) -> impl IntoElement {
    let detail = usage.map(|usage| format!("{} / {}", bytes(usage.used), bytes(usage.total)));
    row()
        .gap_2()
        .flex_shrink_0()
        .child(Icon::new(icon).size(px(13.)))
        .child(label)
        .child(
            div()
                .text_color(rgb(if percent.is_some_and(|p| p >= 90.) {
                    0xe6a18e
                } else {
                    colors(cx).text
                }))
                .child(
                    percent
                        .map(|percent| format!("{percent:.1}%"))
                        .unwrap_or_else(|| "—".into()),
                ),
        )
        .when_some(detail, |el, detail| el.child(div().child(detail)))
}
