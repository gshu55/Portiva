export interface NetworkScanDraft {
  cidr: string;
  pingEnabled: boolean;
  tcpEnabled: boolean;
  portsText: string;
  timeoutMs: string;
  concurrency: string;
}

export const MIN_SCAN_TIMEOUT_MS = 100;
export const MAX_SCAN_TIMEOUT_MS = 3 * 60 * 1000;
export const MIN_SCAN_CONCURRENCY = 1;
export const MAX_SCAN_CONCURRENCY = 128;

export function capNumericInput(value: string, maximum: number): string {
  if (!value) {
    return value;
  }

  const numericValue = Number(value);
  return Number.isFinite(numericValue) && numericValue > maximum
    ? String(maximum)
    : value;
}

export const defaultNetworkScanDraft: NetworkScanDraft = {
  cidr: "",
  pingEnabled: true,
  tcpEnabled: false,
  portsText: "22, 23, 80, 443",
  timeoutMs: "800",
  concurrency: "32",
};

export function parseScanLimits(
  timeoutInput: string,
  concurrencyInput: string,
): { concurrency: number; error?: string; timeoutMs: number } {
  const timeoutMs = Number(timeoutInput);
  if (
    !Number.isInteger(timeoutMs)
    || timeoutMs < MIN_SCAN_TIMEOUT_MS
    || timeoutMs > MAX_SCAN_TIMEOUT_MS
  ) {
    return {
      concurrency: 0,
      error: `单次超时必须是 ${MIN_SCAN_TIMEOUT_MS}–${MAX_SCAN_TIMEOUT_MS} 毫秒之间的整数`,
      timeoutMs: 0,
    };
  }

  const concurrency = Number(concurrencyInput);
  if (
    !Number.isInteger(concurrency)
    || concurrency < MIN_SCAN_CONCURRENCY
    || concurrency > MAX_SCAN_CONCURRENCY
  ) {
    return {
      concurrency: 0,
      error: `并发任务必须是 ${MIN_SCAN_CONCURRENCY}–${MAX_SCAN_CONCURRENCY} 之间的整数`,
      timeoutMs: 0,
    };
  }

  return { concurrency, timeoutMs };
}

export function parsePortList(input: string): { error?: string; ports: number[] } {
  const values = new Set<number>();
  const tokens = input
    .split(/[\s,，;；]+/)
    .map((token) => token.trim())
    .filter(Boolean);

  for (const token of tokens) {
    const range = token.match(/^(\d+)-(\d+)$/);
    if (range) {
      const start = Number(range[1]);
      const end = Number(range[2]);
      if (!isValidPort(start) || !isValidPort(end) || start > end) {
        return { error: `端口范围无效：${token}`, ports: [] };
      }
      if (end - start + 1 > 32) {
        return { error: "单个端口范围不能超过 32 个端口", ports: [] };
      }
      for (let port = start; port <= end; port += 1) {
        values.add(port);
      }
    } else {
      const port = Number(token);
      if (!/^\d+$/.test(token) || !isValidPort(port)) {
        return { error: `端口无效：${token}`, ports: [] };
      }
      values.add(port);
    }

    if (values.size > 32) {
      return { error: "一次最多探测 32 个 TCP 端口", ports: [] };
    }
  }

  return { ports: [...values].sort((left, right) => left - right) };
}

function isValidPort(port: number) {
  return Number.isInteger(port) && port >= 1 && port <= 65535;
}
