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
  kind: "ssh" | "telnet" | "serial" | "raw-tcp" | "local-shell";
  host: string;
  port: number;
  serverIdentification?: string;
  hostKeyFingerprint?: string;
  authenticated: boolean;
  terminalChannelReady: boolean;
  fileTransferReady: boolean;
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

export interface TransferTask {
  id: string;
  connectionId: string;
  direction: "upload" | "download";
  protocol: "sftp" | "scp" | "ftp" | "webdav" | "s3";
  localPath: string;
  remotePath: string;
  status: "pending" | "running" | "paused" | "cancelled" | "failed" | "completed";
  conflictPolicy: "ask" | "overwrite" | "rename" | "skip";
  retryCount: number;
  totalBytes?: number;
  transferredBytes: number;
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

export interface WorkspaceSessionTab {
  id?: string;
  kind?: "terminal" | "file-transfer" | "settings" | "http-console";
  connection: ConnectionSummary;
  fileTransferSession?: FileTransferSession | null;
  parentConnectionId?: string;
  restored?: boolean;
  terminal: TerminalSession | null;
  terminalSnapshot: TerminalSnapshot | null;
}

export interface AppSettings {
  theme: {
    mode: "dark" | "light" | "system";
    terminalFontFamily: string;
    terminalFontSize: number;
    terminalColorPreset: TerminalColorPresetId;
    terminalColors: TerminalColorPalette;
  };
  keymap: {
    commandPalette: string;
    newProfile: string;
    openLocalTerminal: string;
    openSerialTerminal: string;
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
  purpose: "password" | "private-key-passphrase" | "token";
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
