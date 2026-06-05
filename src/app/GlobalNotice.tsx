import { useEffect, useMemo, useState } from "react";
import { Icon } from "../shared/Icon";

interface GlobalNoticeProps {
  message: string;
  durationMs?: number;
}

function noticeTone(message: string) {
  return /失败|错误|不可用|无法|需要|未找到|denied|error|failed/i.test(message) ? "error" : "info";
}

export function GlobalNotice({ durationMs = 3600, message }: GlobalNoticeProps) {
  const [visible, setVisible] = useState(Boolean(message));
  const tone = useMemo(() => noticeTone(message), [message]);

  useEffect(() => {
    if (!message) {
      setVisible(false);
      return undefined;
    }

    setVisible(true);
    const timer = window.setTimeout(() => setVisible(false), durationMs);
    return () => window.clearTimeout(timer);
  }, [durationMs, message]);

  if (!message || !visible) {
    return null;
  }

  return (
    <aside aria-live="polite" className={`global-notice ${tone}`} role="status">
      <span className="global-notice-mark" />
      <p>{message}</p>
      <button aria-label="关闭提示" type="button" onClick={() => setVisible(false)}>
        <Icon name="x" />
      </button>
    </aside>
  );
}
