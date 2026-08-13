export type ConnectionType =
  | "ssh"
  | "sftp"
  | "telnet"
  | "serial"
  | "raw-tcp"
  | "local-shell"
  | "wsl"
  | "docker-exec"
  | "kubernetes-exec"
  | "ftp"
  | "ftps"
  | "webdav"
  | "s3";

export type ConnectionStatus = "ready" | "connecting" | "connected" | "disconnected" | "failed" | "todo";
export type TextEncoding = "ascii" | "utf-8" | "gbk" | "big5" | "shift-jis" | "euc-kr" | "utf-16le" | "utf-16be" | "latin1";

export interface ProfileGroup {
  id: string;
  name: string;
  profileCount: number;
}

export interface RecentConnection {
  profileId: string;
  title: string;
  lastConnectedAt: string;
}

export interface ConnectionCapabilities {
  terminal: boolean;
  fileTransfer: boolean;
  sftp: boolean;
  scp: boolean;
  tunnel: boolean;
  portForwarding: boolean;
  ptyResize: boolean;
  secureTransport: boolean;
  reconnect: boolean;
  localFileAccess: boolean;
  requiresHostKeyVerification: boolean;
}

export interface ProtocolDescriptor {
  protocolType: ConnectionType;
  label: string;
  enabled: boolean;
  capabilities: ConnectionCapabilities;
}

export interface BaseProfile {
  id: string;
  name: string;
  groupId?: string;
  type: ConnectionType;
  tags?: string[];
  createdAt: string;
  updatedAt: string;
}

export interface SshProfile extends BaseProfile {
  type: "ssh";
  host: string;
  port: number;
  username: string;
  authType: "password" | "private-key" | "agent";
  privateKeyPath?: string;
  enableAgentForwarding?: boolean;
  enableCompression?: boolean;
  proxyJump?: string;
}

export interface SftpProfile extends BaseProfile {
  type: "sftp";
  host: string;
  port: number;
  username: string;
  authType: "password" | "private-key" | "agent";
  privateKeyPath?: string;
  enableCompression?: boolean;
  proxyJump?: string;
}

export interface TelnetProfile extends BaseProfile {
  type: "telnet";
  host: string;
  port: number;
  username?: string;
  terminalType: "xterm" | "vt100" | "vt220";
  lineEnding: "crlf" | "cr" | "lf";
  encoding: TextEncoding;
}

export interface SerialProfile extends BaseProfile {
  type: "serial";
  portName: string;
  baudRate: number;
  dataBits: 5 | 6 | 7 | 8;
  parity: "none" | "odd" | "even" | "mark" | "space";
  stopBits: 1 | 1.5 | 2;
  flowControl: "none" | "software" | "hardware";
  lineEnding: "crlf" | "cr" | "lf";
  encoding: TextEncoding;
  dtr?: boolean;
  rts?: boolean;
}

export interface RawSocketProfile extends BaseProfile {
  type: "raw-tcp";
  host: string;
  port: number;
  lineEnding: "crlf" | "cr" | "lf";
  encoding: TextEncoding;
}

export type ConnectionProfile =
  | SshProfile
  | SftpProfile
  | TelnetProfile
  | SerialProfile
  | RawSocketProfile;

export interface ConnectionSummary {
  id: string;
  profileId: string;
  title: string;
  status: ConnectionStatus;
  capabilities: ConnectionCapabilities;
  transport?: ConnectionTransportInfo;
}

export interface ConnectionTransportInfo {
  kind: "ssh" | "telnet" | "serial" | "raw-tcp" | "local-shell" | "wsl";
  host: string;
  port: number;
  serverIdentification?: string;
  hostKeyFingerprint?: string;
  authenticated: boolean;
  terminalChannelReady: boolean;
  fileTransferReady: boolean;
}

export type WslDistributionState = "running" | "stopped" | "unknown";

export interface WslDistributionInfo {
  name: string;
  isDefault: boolean;
  state: WslDistributionState;
  version?: number | null;
}

export interface WslDiscovery {
  supported: boolean;
  available: boolean;
  distributions: WslDistributionInfo[];
  message?: string | null;
}

export interface WslHostOverview {
  distribution: string;
  hostname: string;
  operatingSystem: string;
  kernelVersion: string;
  cpuUsagePercent: number | null;
  cpuCount: number | null;
  memoryUsedBytes: number | null;
  memoryTotalBytes: number | null;
  diskUsedBytes: number | null;
  diskTotalBytes: number | null;
  networkReceivedBytes: number | null;
  networkTransmittedBytes: number | null;
  uptimeSeconds: number | null;
  latencyMs: number;
}

export interface SshHostOverview {
  hostname: string;
  operatingSystem: string;
  kernelVersion: string;
  cpuLoad1: number | null;
  cpuCount: number | null;
  memoryUsedBytes: number | null;
  memoryTotalBytes: number | null;
  diskUsedBytes: number | null;
  diskTotalBytes: number | null;
  networkReceivedBytes: number | null;
  networkTransmittedBytes: number | null;
  uptimeSeconds: number | null;
  latencyMs: number;
}

export interface RemoteEntry {
  name: string;
  path: string;
  kind: "file" | "directory" | "symlink" | "other";
  size: number;
  modifiedAt?: string;
  permissions?: string;
  owner?: string;
  group?: string;
}

export interface FileTransferSession {
  id: string;
  connectionId: string;
  protocol: TransferTask["protocol"];
}

export interface TransferUploadItem {
  localPath: string;
  remotePath: string;
  itemKind: "file" | "directory";
}

export interface TransferTask {
  id: string;
  connectionId: string;
  direction: "upload" | "download";
  protocol: "sftp" | "scp" | "ftp" | "webdav" | "s3" | "wsl";
  itemKind: "file" | "directory" | "batch";
  localPath: string;
  remotePath: string;
  batchItems?: TransferUploadItem[];
  status:
    | "pending"
    | "running"
    | "paused"
    | "waiting-conflict"
    | "cancelled"
    | "failed"
    | "partial"
    | "completed";
  conflictPolicy: "ask" | "overwrite" | "overwrite-all" | "rename" | "skip" | "skip-all";
  conflictPath?: string;
  retryCount: number;
  totalBytes?: number;
  transferredBytes: number;
  totalItems?: number;
  completedItems: number;
  skippedItems: number;
  failedItems: number;
  speedBytesPerSecond?: number;
  error?: string;
  createdAt: string;
  updatedAt: string;
}

export interface TerminalSize {
  cols: number;
  rows: number;
  widthPx: number;
  heightPx: number;
}

export interface TerminalSession {
  id: string;
  connectionId: string;
  size: TerminalSize;
  status: "attached" | "closed";
  renderPolicy: TerminalRenderPolicy;
}

export interface TerminalRenderPolicy {
  flushIntervalMs: number;
  maxChunkBytes: number;
  scrollbackLines: number;
}

export interface TerminalSnapshot {
  terminalId: string;
  status: TerminalSession["status"];
  bufferedBytes: number;
  bufferPreview: string;
  renderPolicy: TerminalRenderPolicy;
  outputChunk?: string;
}

export interface SerialRxEvent {
  terminalId: string;
  seq: number;
  timestampUs: number;
  bytes: number[];
  text: string;
}

export type TerminalColorPresetId = "dark" | "light" | "custom";

export interface TerminalColorPalette {
  background: string;
  foreground: string;
  cursor: string;
  selectionBackground: string;
  black: string;
  red: string;
  green: string;
  yellow: string;
  blue: string;
  magenta: string;
  cyan: string;
  white: string;
  brightBlack: string;
  brightRed: string;
  brightGreen: string;
  brightYellow: string;
  brightBlue: string;
  brightMagenta: string;
  brightCyan: string;
  brightWhite: string;
}

export type TerminalRightClickBehavior =
  | "disabled"
  | "context-menu"
  | "paste"
  | "copy-or-paste";

export type AppBackgroundPresetId = "aurora" | "horizon" | "topography" | "custom";

export interface AppBackgroundSettings {
  enabled: boolean;
  preset: AppBackgroundPresetId;
  customImage: string | null;
  opacity: number;
  blur: number;
}

export interface WorkspaceSessionTab {
  id?: string;
  kind?: "terminal" | "file-transfer" | "settings" | "http-console" | "host-dashboard" | "network-scan" | "wsl-files";
  connection: ConnectionSummary;
  fileTransferSession?: FileTransferSession | null;
  parentConnectionId?: string;
  restored?: boolean;
  terminal: TerminalSession | null;
  terminalSnapshot: TerminalSnapshot | null;
  terminalWorkingDirectory?: string | null;
}

export interface NetworkInterfaceInfo {
  name: string;
  address: string;
  prefixLength: number;
  cidr: string;
  isLoopback: boolean;
  isPrivate: boolean;
}

export interface NetworkScanRequest {
  cidr: string;
  pingEnabled: boolean;
  tcpEnabled: boolean;
  ports: number[];
  timeoutMs: number;
  concurrency: number;
}

export interface NetworkScanSession {
  scanId: string;
  total: number;
  status: "running";
}

export interface NetworkScanResult {
  ip: string;
  reachable: boolean;
  pingSucceeded: boolean;
  latencyMs?: number;
  openPorts: number[];
  discoveryMethods: Array<"ping" | "tcp">;
  error?: string;
}

export interface NetworkScanEvent {
  scanId: string;
  kind: "progress" | "completed" | "cancelled";
  scanned: number;
  total: number;
  results: NetworkScanResult[];
  message?: string;
}

export interface AppSettings {
  theme: {
    mode: "dark" | "light" | "system";
    background: AppBackgroundSettings;
    terminalFontFamily: string;
    terminalFontSize: number;
    terminalColorPreset: TerminalColorPresetId;
    terminalColors: TerminalColorPalette;
  };
  keymap: {
    commandPalette: string;
    newProfile: string;
    openHostOverview: string;
    openLocalTerminal: string;
    openSerialTerminal: string;
    openSettings: string;
    increaseFontSize: string;
    decreaseFontSize: string;
    closeTab: string;
  };
  security: {
    requireHostKeyVerification: boolean;
    redactSensitiveLogs: boolean;
    allowInsecureWithoutWarning: boolean;
  };
  terminal: {
    confirmMultilinePaste: boolean;
    copyRichText: boolean;
    rightClickBehavior: TerminalRightClickBehavior;
  };
  network: {
    proxy: {
      mode: "none" | "http" | "socks5" | "browser";
      host: string;
      port: number;
      authenticationEnabled: boolean;
      username: string;
    };
  };
}

export type WorkspaceCommandId = "connect" | "disconnect" | "newProfile";

export interface LogEntry {
  id: string;
  level: "debug" | "info" | "warn" | "error";
  target: string;
  message: string;
  createdAt: string;
}

export interface SecretMetadata {
  id: string;
  profileId: string;
  purpose: "password" | "private-key-passphrase" | "token" | "proxy-password";
  createdAt: string;
  hasValue: boolean;
}

export interface KnownHostEntry {
  host: string;
  fingerprint: string;
}

export interface TunnelRule {
  id: string;
  connectionId: string;
  kind: "local" | "remote" | "dynamic";
  localHost: string;
  localPort: number;
  remoteHost: string;
  remotePort: number;
  status: "pending" | "active" | "stopped" | "failed";
}

export interface SerialPortInfo {
  portName: string;
  portType: "usb" | "bluetooth" | "pci" | "unknown";
  displayName: string;
  manufacturer?: string;
  vid?: number;
  pid?: number;
  isAvailable: boolean;
}
