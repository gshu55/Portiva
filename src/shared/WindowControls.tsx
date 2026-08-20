import { useEffect, useState } from "react";
import { Icon, type IconName } from "./Icon";

export type WindowAction = "close" | "drag" | "minimize" | "toggle-maximize";
export type WindowControlPlatform = "linux" | "macos" | "windows";

export function detectWindowControlPlatform(): WindowControlPlatform {
  const platform = navigator.platform.toLowerCase();
  const userAgent = navigator.userAgent.toLowerCase();

  if (platform.includes("mac") || userAgent.includes("mac os")) {
    return "macos";
  }

  if (platform.includes("linux") || userAgent.includes("linux")) {
    return "linux";
  }

  return "windows";
}

export async function runWindowAction(action: WindowAction) {
  try {
    const { getCurrentWindow } = await import("@tauri-apps/api/window");
    const currentWindow = getCurrentWindow();

    if (action === "drag") {
      await currentWindow.startDragging();
    } else if (action === "minimize") {
      await currentWindow.minimize();
    } else if (action === "toggle-maximize") {
      await currentWindow.toggleMaximize();
    } else {
      await currentWindow.close();
    }
  } catch {
    // Browser preview and mocked mode do not have native window controls.
  }
}

async function readWindowMaximized() {
  try {
    const { getCurrentWindow } = await import("@tauri-apps/api/window");
    return await getCurrentWindow().isMaximized();
  } catch {
    return false;
  }
}

interface WindowControlsProps {
  className?: string;
  closeLabel?: string;
  closeTitle?: string;
}

export function WindowControls({
  className,
  closeLabel = "关闭",
  closeTitle = "关闭",
}: WindowControlsProps) {
  const [isMaximized, setIsMaximized] = useState(false);
  const platform = detectWindowControlPlatform();

  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | null = null;

    void (async () => {
      const initiallyMaximized = await readWindowMaximized();
      if (!disposed) {
        setIsMaximized(initiallyMaximized);
      }

      try {
        const { getCurrentWindow } = await import("@tauri-apps/api/window");
        const dispose = await getCurrentWindow().onResized(() => {
          void readWindowMaximized().then((maximized) => {
            if (!disposed) {
              setIsMaximized(maximized);
            }
          });
        });

        if (disposed) {
          dispose();
        } else {
          unlisten = dispose;
        }
      } catch {
        // Browser preview and mocked mode do not expose native resize events.
      }
    })();

    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  if (platform === "macos") {
    return null;
  }

  const maximizeIcon: IconName = isMaximized ? "restore" : "maximize";
  const maximizeLabel = isMaximized ? "还原" : "最大化";
  const toggleWindowMaximize = async () => {
    await runWindowAction("toggle-maximize");
    setIsMaximized(await readWindowMaximized());
  };
  const controls = [
    {
      action: "minimize" as const,
      className: "minimize",
      icon: "minus" as const,
      label: "最小化",
      title: "最小化",
    },
    {
      action: "toggle-maximize" as const,
      className: "maximize",
      icon: maximizeIcon,
      label: maximizeLabel,
      title: maximizeLabel,
    },
    {
      action: "close" as const,
      className: "close",
      icon: "x" as const,
      label: closeLabel,
      title: closeTitle,
    },
  ];

  return (
    <div
      aria-label="窗口控制"
      className={["window-controls", platform, className].filter(Boolean).join(" ")}
      role="group"
    >
      {controls.map((control) => (
        <button
          aria-label={control.label}
          className={`window-control ${control.className}`}
          key={control.action}
          title={control.title}
          type="button"
          onClick={() => {
            if (control.action === "toggle-maximize") {
              void toggleWindowMaximize();
              return;
            }

            void runWindowAction(control.action);
          }}
        >
          <Icon name={control.icon} />
        </button>
      ))}
    </div>
  );
}
