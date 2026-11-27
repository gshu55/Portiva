use anyhow::{Context as _, Result};
use gpui_kit::{Context, Window};
use std::future::Future;

/// Tokio owns network and disk work; GPUI only awaits the completion and applies the result.
pub fn run<V: 'static, T: Send + 'static>(
    runtime: &tokio::runtime::Handle,
    window: &Window,
    cx: &mut Context<V>,
    future: impl Future<Output = Result<T>> + Send + 'static,
    complete: impl FnOnce(&mut V, Result<T>, &mut Window, &mut Context<V>) + 'static,
) {
    let task = runtime.spawn(future);
    cx.spawn_in(window, async move |view, cx| {
        let result = task.await.context("后台任务异常退出").and_then(|r| r);
        let _ =
            cx.update(|window, cx| view.update(cx, |view, cx| complete(view, result, window, cx)));
    })
    .detach();
}
