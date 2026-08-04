import type {
  ConnectionStatus,
  ConnectionType,
  TransferTask,
} from "./types";

type TransferDirection = TransferTask["direction"];
type TransferStatus = TransferTask["status"];
type TransferConflictPolicy = TransferTask["conflictPolicy"];

export function dataSourceLabel(source: string) {
  if (source === "tauri") {
    return "本机服务";
  }

  if (source === "mock") {
    return "演示数据";
  }

  return "加载中";
}

export function connectionStatusLabel(status: ConnectionStatus | string) {
  const labels: Record<string, string> = {
    ready: "就绪",
    connecting: "连接中",
    connected: "已连接",
    disconnected: "已断开",
    failed: "失败",
    todo: "待实现",
  };

  return labels[status] ?? status;
}

export function protocolLabel(type: ConnectionType | string) {
  const labels: Record<string, string> = {
    ssh: "SSH",
    sftp: "SFTP",
    telnet: "Telnet",
    serial: "串口",
    "raw-tcp": "Raw TCP",
    "local-shell": "本地 Shell",
    wsl: "WSL",
    "docker-exec": "Docker",
    "kubernetes-exec": "Kubernetes",
    ftp: "FTP",
    ftps: "FTPS",
    webdav: "WebDAV",
    s3: "S3",
  };

  return labels[type] ?? type;
}

export function capabilityLabel(capability: string) {
  const labels: Record<string, string> = {
    terminal: "终端",
    fileTransfer: "文件传输",
    sftp: "SFTP",
    scp: "SCP",
    tunnel: "隧道",
    portForwarding: "端口转发",
    ptyResize: "PTY 调整",
    secureTransport: "加密传输",
    reconnect: "重连",
    localFileAccess: "本地文件",
    requiresHostKeyVerification: "主机密钥校验",
  };

  return labels[capability] ?? capability;
}

export function transferDirectionLabel(direction: TransferDirection) {
  return direction === "upload" ? "上传" : "下载";
}

export function transferStatusLabel(status: TransferStatus) {
  const labels: Record<TransferStatus, string> = {
    pending: "等待中",
    running: "传输中",
    paused: "已暂停",
    "waiting-conflict": "等待处理冲突",
    completed: "已完成",
    partial: "已完成（有跳过）",
    failed: "失败",
    cancelled: "已取消",
  };

  return labels[status];
}

export function transferProgressPercent(task: TransferTask) {
  if (task.status === "completed" || task.status === "partial") {
    return 100;
  }
  if (task.totalBytes) {
    return Math.min(100, Math.round((task.transferredBytes / task.totalBytes) * 100));
  }
  if (task.totalItems) {
    const handledItems = task.completedItems + task.skippedItems + task.failedItems;
    return Math.min(100, Math.round((handledItems / task.totalItems) * 100));
  }

  return 0;
}

export function transferTaskSummary(task: TransferTask) {
  if (task.status === "failed" && task.error) {
    return `失败：${task.error}`;
  }
  if (task.itemKind === "directory" && task.status === "running" && task.totalItems === undefined) {
    return "正在扫描文件夹";
  }

  const status = transferStatusLabel(task.status);
  if (!task.totalItems) {
    return status;
  }

  const counts = [
    `${task.completedItems}/${task.totalItems}`,
    task.skippedItems ? `跳过 ${task.skippedItems}` : "",
    task.failedItems ? `失败 ${task.failedItems}` : "",
  ].filter(Boolean);

  return `${status} · ${counts.join("，")}`;
}

export function conflictPolicyLabel(policy: TransferConflictPolicy) {
  const labels: Record<TransferConflictPolicy, string> = {
    overwrite: "覆盖",
    "overwrite-all": "全部覆盖",
    skip: "跳过",
    "skip-all": "全部跳过",
    rename: "重命名",
    ask: "询问",
  };

  return labels[policy];
}

export function tunnelKindLabel(kind: string) {
  const labels: Record<string, string> = {
    local: "本地",
    remote: "远程",
    dynamic: "动态",
  };

  return labels[kind] ?? kind;
}

export function logLevelLabel(level: string) {
  const labels: Record<string, string> = {
    debug: "调试",
    info: "信息",
    warn: "警告",
    error: "错误",
  };

  return labels[level] ?? level;
}
