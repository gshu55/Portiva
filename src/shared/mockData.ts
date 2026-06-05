import type {
  ConnectionProfile,
  KnownHostEntry,
  LogEntry,
  ProfileGroup,
  ProtocolDescriptor,
  RecentConnection,
  SecretMetadata,
  SerialPortInfo,
  TunnelRule,
  TransferTask,
} from "./types";
import { capabilitiesByType } from "./capabilities";
export { profileTarget } from "./profile";

const now = new Date("2026-05-11T08:00:00.000Z").toISOString();

function capabilitiesByProtocol(protocol: keyof typeof capabilitiesByType) {
  return capabilitiesByType[protocol];
}

export const sampleProfiles: ConnectionProfile[] = [];

export const sampleGroups: ProfileGroup[] = [];

export const sampleRecentConnections: RecentConnection[] = [];

export const sampleProtocolDescriptors: ProtocolDescriptor[] = [
  { protocolType: "ssh", label: "SSH", enabled: true, capabilities: capabilitiesByProtocol("ssh") },
  { protocolType: "sftp", label: "SFTP", enabled: true, capabilities: capabilitiesByProtocol("sftp") },
  { protocolType: "telnet", label: "Telnet", enabled: false, capabilities: capabilitiesByProtocol("telnet") },
  { protocolType: "serial", label: "Serial", enabled: true, capabilities: capabilitiesByProtocol("serial") },
  { protocolType: "raw-tcp", label: "Raw TCP", enabled: false, capabilities: capabilitiesByProtocol("raw-tcp") },
];

export const sampleTransfers: TransferTask[] = [];

export const sampleLogs: LogEntry[] = [
  {
    id: "log-ui-ready",
    level: "info",
    target: "ui",
    message: "Portiva 工作区已初始化",
    createdAt: now,
  },
  {
    id: "log-security-todo",
    level: "warn",
    target: "security",
    message: "主机密钥确认流程尚未接入",
    createdAt: now,
  },
  {
    id: "log-transfer-todo",
    level: "debug",
    target: "transfer",
    message: "进度事件后续应节流到 100ms",
    createdAt: now,
  },
];

export const sampleSecrets: SecretMetadata[] = [];

export const sampleKnownHosts: KnownHostEntry[] = [];

export const sampleTunnels: TunnelRule[] = [];

export const sampleSerialPorts: SerialPortInfo[] = [
  {
    portName: "COM3",
    portType: "usb",
    displayName: "USB 串口设备 (COM3)",
    manufacturer: "Portiva Lab",
    vid: 0x1a86,
    pid: 0x7523,
    isAvailable: true,
  },
  {
    portName: "COM4",
    portType: "unknown",
    displayName: "已占用串口 (COM4)",
    isAvailable: false,
  },
];
