export function formatBytes(value: number | null, fallback = "—") {
  if (value === null || !Number.isFinite(value) || value < 0) {
    return fallback;
  }

  const units = ["B", "KB", "MB", "GB", "TB"];
  let size = value;
  let unitIndex = 0;

  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex += 1;
  }

  const digits = size >= 100 || unitIndex === 0 ? 0 : size >= 10 ? 1 : 2;
  return `${size.toFixed(digits)} ${units[unitIndex]}`;
}

export function formatUptime(value: number | null) {
  if (value === null || value < 0) {
    return "—";
  }

  const days = Math.floor(value / 86_400);
  const hours = Math.floor((value % 86_400) / 3_600);
  const minutes = Math.floor((value % 3_600) / 60);

  if (days > 0) {
    return `${days}天 ${hours}时`;
  }
  if (hours > 0) {
    return `${hours}时 ${minutes}分`;
  }
  return `${minutes}分钟`;
}

export function formatUptimeDays(value: number | null) {
  if (value === null || !Number.isFinite(value) || value < 0) {
    return "—";
  }

  const days = Math.floor(value / 86_400);
  return days > 0 ? `${days}天` : formatUptime(value);
}
