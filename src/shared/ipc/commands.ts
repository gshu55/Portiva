import { invoke } from "@tauri-apps/api/core";
import type {
  ConnectionCapabilities,
  ConnectionProfile,
  ConnectionSummary,
  AppSettings,
  FileTransferSession,
  KnownHostEntry,
  LogEntry,
  ProfileGroup,
  ProtocolDescriptor,
  RecentConnection,
  RemoteEntry,
  TerminalSession,
  TerminalSize,
  TerminalSnapshot,
  TransferTask,
  SecretMetadata,
  TunnelRule,
  SerialPortInfo,
  SshHostOverview,
  NetworkInterfaceInfo,
  NetworkScanRequest,
  NetworkScanSession,
  WslDiscovery,
  WslHostOverview,
} from "../types";

export const commandNames = {
  connectionOpen: "connection_open",
  connectionClose: "connection_close",
  clipboardReadText: "clipboard_read_text",
  clipboardWriteHtml: "clipboard_write_html",
  clipboardWriteText: "clipboard_write_text",
  connectionGet: "connection_get",
  connectionGetCapabilities: "connection_get_capabilities",
  sshAuthenticatePassword: "ssh_authenticate_password",
  sshAuthenticateSavedPassword: "ssh_authenticate_saved_password",
  sshAuthenticatePrivateKey: "ssh_authenticate_private_key",
  sshAuthenticateAgent: "ssh_authenticate_agent",
  sshCollectHostOverview: "ssh_collect_host_overview",
  profileGroups: "profile_groups",
  profileRecent: "profile_recent",
  profileMarkRecent: "profile_mark_recent",
  protocolList: "protocol_list",
  protocolGet: "protocol_get",
  tunnelCreate: "tunnel_create",
  tunnelStart: "tunnel_start",
  tunnelStop: "tunnel_stop",
  tunnelList: "tunnel_list",
  profileCreate: "profile_create",
  profileUpdate: "profile_update",
  profileDelete: "profile_delete",
  profileTestConnection: "profile_test_connection",
  knownHostTrustPlaceholder: "known_host_trust_placeholder",
  securityRedactPreview: "security_redact_preview",
  secretList: "secret_list",
  secretSet: "secret_set",
  secretDelete: "secret_delete",
  secretRevealPassword: "secret_reveal_password",
  knownHostsList: "known_hosts_list",
  knownHostDelete: "known_host_delete",
  terminalAttach: "terminal_attach",
  terminalSession: "terminal_session",
  terminalWrite: "terminal_write",
  terminalWriteBytes: "terminal_write_bytes",
  terminalResize: "terminal_resize",
  terminalClose: "terminal_close",
  terminalSnapshot: "terminal_snapshot",
  fileTransferOpen: "file_transfer_open",
  fileTransferSession: "file_transfer_session",
  fileTransferClose: "file_transfer_close",
  fileTransferList: "file_transfer_list",
  fileTransferUpload: "file_transfer_upload",
  fileTransferUploadBatch: "file_transfer_upload_batch",
  fileTransferDownload: "file_transfer_download",
  fileTransferMkdir: "file_transfer_mkdir",
  fileTransferRemove: "file_transfer_remove",
  fileTransferRename: "file_transfer_rename",
  fileTransferCancel: "file_transfer_cancel",
  fileTransferPause: "file_transfer_pause",
  fileTransferResume: "file_transfer_resume",
  fileTransferResolveConflict: "file_transfer_resolve_conflict",
  fileTransferRetry: "file_transfer_retry",
  fileTransferDelete: "file_transfer_delete",
  localDownloadDirectory: "local_download_directory",
  localFileList: "local_file_list",
  localFileMkdir: "local_file_mkdir",
  localFileRemove: "local_file_remove",
  localFileRename: "local_file_rename",
  localRevealItemInDirectory: "local_reveal_item_in_directory",
  transferList: "transfer_list",
  profileList: "profile_list",
  serialListPorts: "serial_list_ports",
  serialTerminalCreate: "serial_terminal_create",
  serialTerminalClose: "serial_terminal_close",
  serialTerminalOpen: "serial_terminal_open",
  serialTerminalReconfigure: "serial_terminal_reconfigure",
  settingsGet: "settings_get",
  settingsUpdate: "settings_update",
  logClear: "log_clear",
  logList: "log_list",
  logRecordPlaceholder: "log_record_placeholder",
  localShellOpen: "local_shell_open",
  wslDistributionsList: "wsl_distributions_list",
  wslCollectHostOverview: "wsl_collect_host_overview",
  wslShellOpen: "wsl_shell_open",
  wslFileHome: "wsl_file_home",
  wslFileList: "wsl_file_list",
  wslFileMkdir: "wsl_file_mkdir",
  wslFileRemove: "wsl_file_remove",
  wslFileRename: "wsl_file_rename",
  wslTransferUpload: "wsl_transfer_upload",
  wslTransferDownload: "wsl_transfer_download",
  wslTransferList: "wsl_transfer_list",
  wslTransferAction: "wsl_transfer_action",
  httpSend: "http_send",
  httpSendStream: "http_send_stream",
  httpCancel: "http_cancel",
  httpWorkspacesGet: "http_workspaces_get",
  httpWorkspacesSave: "http_workspaces_save",
  networkScanInterfaces: "network_scan_interfaces",
  networkScanStart: "network_scan_start",
  networkScanCancel: "network_scan_cancel",
  networkProxyPasswordStatus: "network_proxy_password_status",
  networkProxyPasswordSet: "network_proxy_password_set",
  networkProxyPasswordDelete: "network_proxy_password_delete",
  appUpdateCheck: "app_update_check",
  appUpdateDownloadAndInstall: "app_update_download_and_install",
} as const;

export interface AppUpdateMetadata {
  currentVersion: string;
  version: string;
  body?: string;
}

export interface ProfileSaveResult {
  profileId: string;
}

export interface TestConnectionResult {
  fingerprint?: string;
  host?: string;
  port?: number;
  ok: boolean;
  message: string;
  requiresFingerprintConfirmation: boolean;
}

export interface KnownHostTrustResult {
  host: string;
  port: number;
  fingerprint: string;
}

export interface LocalFileListResult {
  path: string;
  entries: RemoteEntry[];
}

export interface LocalShellOpenResult {
  connection: ConnectionSummary;
  terminal: TerminalSession;
  terminalSnapshot: TerminalSnapshot;
}

export interface SerialTerminalCreateResult {
  connection: ConnectionSummary;
  terminal: TerminalSession;
  terminalSnapshot: TerminalSnapshot;
}

export interface HttpSendHeader {
  key: string;
  value: string;
}

export interface HttpSendMultipartPart {
  bytes?: number[];
  bytesBase64?: string;
  contentType?: string;
  fileName?: string;
  kind: "text" | "file";
  name: string;
  value?: string;
}

export interface HttpSendRequest {
  body?: string;
  headers: HttpSendHeader[];
  method: string;
  multipart?: HttpSendMultipartPart[];
  timeoutMs?: number;
  url: string;
}

export interface HttpSendResponse {
  body: string;
  bodyKind: "binary" | "empty" | "image" | "json" | "text";
  durationMs: number;
  headers: Record<string, string>;
  sizeBytes: number;
  status: number;
  statusText: string;
  url: string;
}

export function profileList() {
  return invoke<ConnectionProfile[]>(commandNames.profileList);
}

export function profileGroups() {
  return invoke<ProfileGroup[]>(commandNames.profileGroups);
}

export function profileRecent() {
  return invoke<RecentConnection[]>(commandNames.profileRecent);
}

export function profileMarkRecent(profileId: string) {
  return invoke<RecentConnection>(commandNames.profileMarkRecent, { profileId });
}

export function protocolList() {
  return invoke<ProtocolDescriptor[]>(commandNames.protocolList);
}

export function protocolGet(protocolType: ProtocolDescriptor["protocolType"]) {
  return invoke<ProtocolDescriptor>(commandNames.protocolGet, { protocolType });
}

export function tunnelCreate(rule: TunnelRule) {
  return invoke<TunnelRule>(commandNames.tunnelCreate, { rule });
}

export function tunnelStart(tunnelId: string) {
  return invoke<TunnelRule>(commandNames.tunnelStart, { tunnelId });
}

export function tunnelStop(tunnelId: string) {
  return invoke<TunnelRule>(commandNames.tunnelStop, { tunnelId });
}

export function tunnelList() {
  return invoke<TunnelRule[]>(commandNames.tunnelList);
}

export function profileCreate(profile: ConnectionProfile) {
  return invoke<ProfileSaveResult>(commandNames.profileCreate, { profile });
}

export function profileUpdate(profileId: string, profile: ConnectionProfile) {
  return invoke<ProfileSaveResult>(commandNames.profileUpdate, { profileId, profile });
}

export function profileDelete(profileId: string) {
  return invoke<void>(commandNames.profileDelete, { profileId });
}

export function profileTestConnection(profile: ConnectionProfile, secret?: string) {
  return invoke<TestConnectionResult>(commandNames.profileTestConnection, { profile, secret });
}

export function knownHostTrustPlaceholder(host: string, port: number, fingerprint: string) {
  return invoke<KnownHostTrustResult>(commandNames.knownHostTrustPlaceholder, { host, port, fingerprint });
}

export function securityRedactPreview(input: string) {
  return invoke<string>(commandNames.securityRedactPreview, { input });
}

export function secretList() {
  return invoke<SecretMetadata[]>(commandNames.secretList);
}

export function secretSet(profileId: string, purpose: SecretMetadata["purpose"], value: string) {
  return invoke<SecretMetadata>(commandNames.secretSet, { profileId, purpose, value });
}

export function secretDelete(secretId: string) {
  return invoke<void>(commandNames.secretDelete, { secretId });
}

export interface WslFileListResult {
  path: string;
  entries: RemoteEntry[];
}

export function secretRevealPassword(profileId: string) {
  return invoke<string | null>(commandNames.secretRevealPassword, { profileId });
}

export function knownHostsList() {
  return invoke<KnownHostEntry[]>(commandNames.knownHostsList);
}

export function knownHostDelete(host: string) {
  return invoke<void>(commandNames.knownHostDelete, { host });
}

export function connectionOpen(profile: ConnectionProfile) {
  return invoke<ConnectionSummary>(commandNames.connectionOpen, { profile });
}

export function connectionClose(connectionId: string) {
  return invoke<void>(commandNames.connectionClose, { connectionId });
}

export function clipboardReadText() {
  return invoke<string>(commandNames.clipboardReadText);
}

export function clipboardWriteHtml(html: string, text: string) {
  return invoke<void>(commandNames.clipboardWriteHtml, { html, text });
}

export function clipboardWriteText(text: string) {
  return invoke<void>(commandNames.clipboardWriteText, { text });
}

export function connectionGet(connectionId: string) {
  return invoke<ConnectionSummary>(commandNames.connectionGet, { connectionId });
}

export function connectionGetCapabilities(connectionId: string) {
  return invoke<ConnectionCapabilities>(commandNames.connectionGetCapabilities, { connectionId });
}

export function sshAuthenticatePassword(connectionId: string, password: string) {
  return invoke<ConnectionSummary>(commandNames.sshAuthenticatePassword, { connectionId, password });
}

export function sshAuthenticateSavedPassword(connectionId: string) {
  return invoke<ConnectionSummary>(commandNames.sshAuthenticateSavedPassword, { connectionId });
}

export function sshAuthenticatePrivateKey(
  connectionId: string,
  privateKeyPath: string,
  passphrase?: string,
) {
  return invoke<ConnectionSummary>(commandNames.sshAuthenticatePrivateKey, {
    connectionId,
    privateKeyPath,
    passphrase,
  });
}

export function sshAuthenticateAgent(connectionId: string) {
  return invoke<ConnectionSummary>(commandNames.sshAuthenticateAgent, { connectionId });
}

export function sshCollectHostOverview(profileId: string, connectionId?: string) {
  return invoke<SshHostOverview>(commandNames.sshCollectHostOverview, {
    profileId,
    connectionId,
  });
}

export function fileTransferList(sessionId: string, remotePath: string) {
  return invoke<RemoteEntry[]>(commandNames.fileTransferList, { sessionId, remotePath });
}

export function terminalAttach(connectionId: string, size: TerminalSize) {
  return invoke<TerminalSession>(commandNames.terminalAttach, { connectionId, size });
}

export function localShellOpen(size: TerminalSize) {
  return invoke<LocalShellOpenResult>(commandNames.localShellOpen, { size });
}

export function wslDistributionsList() {
  return invoke<WslDiscovery>(commandNames.wslDistributionsList);
}

export function wslCollectHostOverview(distribution: string) {
  return invoke<WslHostOverview>(commandNames.wslCollectHostOverview, { distribution });
}

export function wslShellOpen(distribution: string, size: TerminalSize) {
  return invoke<LocalShellOpenResult>(commandNames.wslShellOpen, { distribution, size });
}

export function wslFileHome(distribution: string) {
  return invoke<string>(commandNames.wslFileHome, { distribution });
}

export function wslFileList(distribution: string, path: string) {
  return invoke<WslFileListResult>(commandNames.wslFileList, { distribution, path });
}

export function wslFileMkdir(distribution: string, path: string) {
  return invoke<void>(commandNames.wslFileMkdir, { distribution, path });
}

export function wslFileRemove(distribution: string, path: string) {
  return invoke<void>(commandNames.wslFileRemove, { distribution, path });
}

export function wslFileRename(distribution: string, from: string, to: string) {
  return invoke<void>(commandNames.wslFileRename, { distribution, from, to });
}

export function wslTransferUpload(distribution: string, localPath: string, wslPath: string) {
  return invoke<TransferTask>(commandNames.wslTransferUpload, { distribution, localPath, wslPath });
}

export function wslTransferDownload(distribution: string, wslPath: string, localPath: string) {
  return invoke<TransferTask>(commandNames.wslTransferDownload, { distribution, wslPath, localPath });
}

export function wslTransferList(distribution: string) {
  return invoke<TransferTask[]>(commandNames.wslTransferList, { distribution });
}

export function wslTransferAction(
  transferId: string,
  action: "pause" | "resume" | "retry" | "cancel" | "delete",
) {
  return invoke<TransferTask>(commandNames.wslTransferAction, { transferId, action });
}

export function serialTerminalCreate(profile: ConnectionProfile, size: TerminalSize) {
  return invoke<SerialTerminalCreateResult>(commandNames.serialTerminalCreate, { profile, size });
}

export function terminalSession(terminalId: string) {
  return invoke<TerminalSession>(commandNames.terminalSession, { terminalId });
}

export function terminalWrite(terminalId: string, data: string) {
  return invoke<void>(commandNames.terminalWrite, { terminalId, data });
}

export function terminalWriteBytes(terminalId: string, bytes: number[]) {
  return invoke<void>(commandNames.terminalWriteBytes, { terminalId, bytes });
}

export function terminalResize(terminalId: string, size: TerminalSize) {
  return invoke<void>(commandNames.terminalResize, { terminalId, size });
}

export function terminalClose(terminalId: string) {
  return invoke<void>(commandNames.terminalClose, { terminalId });
}

export function terminalSnapshot(terminalId: string) {
  return invoke<TerminalSnapshot>(commandNames.terminalSnapshot, { terminalId });
}

export function fileTransferOpen(connectionId: string) {
  return invoke<FileTransferSession>(commandNames.fileTransferOpen, { connectionId });
}

export function fileTransferSession(sessionId: string) {
  return invoke<FileTransferSession>(commandNames.fileTransferSession, { sessionId });
}

export function fileTransferClose(sessionId: string) {
  return invoke<boolean>(commandNames.fileTransferClose, { sessionId });
}

export function fileTransferUpload(sessionId: string, localPath: string, remotePath: string) {
  return invoke<TransferTask>(commandNames.fileTransferUpload, { sessionId, localPath, remotePath });
}

export function fileTransferUploadBatch(
  sessionId: string,
  remotePath: string,
  uploads: Array<{ localPath: string; remotePath: string }>,
) {
  return invoke<TransferTask>(commandNames.fileTransferUploadBatch, { sessionId, remotePath, uploads });
}

export function fileTransferDownload(sessionId: string, remotePath: string, localPath: string) {
  return invoke<TransferTask>(commandNames.fileTransferDownload, { sessionId, remotePath, localPath });
}

export function fileTransferMkdir(sessionId: string, remotePath: string) {
  return invoke<void>(commandNames.fileTransferMkdir, { sessionId, remotePath });
}

export function fileTransferRemove(sessionId: string, remotePath: string) {
  return invoke<void>(commandNames.fileTransferRemove, { sessionId, remotePath });
}

export function fileTransferRename(sessionId: string, from: string, to: string) {
  return invoke<void>(commandNames.fileTransferRename, { sessionId, from, to });
}

export function localFileList(path: string) {
  return invoke<LocalFileListResult>(commandNames.localFileList, { path });
}

export function localDownloadDirectory() {
  return invoke<string>(commandNames.localDownloadDirectory);
}

export function localFileMkdir(path: string) {
  return invoke<void>(commandNames.localFileMkdir, { path });
}

export function localFileRemove(path: string) {
  return invoke<void>(commandNames.localFileRemove, { path });
}

export function localFileRename(from: string, to: string) {
  return invoke<void>(commandNames.localFileRename, { from, to });
}

export function localRevealItemInDirectory(path: string) {
  return invoke<void>(commandNames.localRevealItemInDirectory, { path });
}

export function fileTransferCancel(transferId: string) {
  return invoke<TransferTask>(commandNames.fileTransferCancel, { transferId });
}

export function fileTransferPause(transferId: string) {
  return invoke<TransferTask>(commandNames.fileTransferPause, { transferId });
}

export function fileTransferResume(transferId: string) {
  return invoke<TransferTask>(commandNames.fileTransferResume, { transferId });
}

export function fileTransferResolveConflict(
  transferId: string,
  policy: "overwrite" | "overwrite-all" | "skip" | "skip-all",
) {
  return invoke<TransferTask>(commandNames.fileTransferResolveConflict, { transferId, policy });
}

export function fileTransferRetry(transferId: string) {
  return invoke<TransferTask>(commandNames.fileTransferRetry, { transferId });
}

export function fileTransferDelete(transferId: string) {
  return invoke<TransferTask>(commandNames.fileTransferDelete, { transferId });
}

export function transferList() {
  return invoke<TransferTask[]>(commandNames.transferList);
}

export function settingsGet() {
  return invoke<AppSettings>(commandNames.settingsGet);
}

export function settingsUpdate(settings: AppSettings) {
  return invoke<AppSettings>(commandNames.settingsUpdate, { settings });
}

export function networkProxyPasswordStatus() {
  return invoke<boolean>(commandNames.networkProxyPasswordStatus);
}

export function networkProxyPasswordSet(password: string) {
  return invoke<void>(commandNames.networkProxyPasswordSet, { password });
}

export function networkProxyPasswordDelete() {
  return invoke<void>(commandNames.networkProxyPasswordDelete);
}

export function appUpdateCheck() {
  return invoke<AppUpdateMetadata | null>(commandNames.appUpdateCheck);
}

export function appUpdateDownloadAndInstall() {
  return invoke<void>(commandNames.appUpdateDownloadAndInstall);
}

export function logList() {
  return invoke<LogEntry[]>(commandNames.logList);
}

export function logClear() {
  return invoke<LogEntry[]>(commandNames.logClear);
}

export function logRecordPlaceholder(level: LogEntry["level"], target: string, message: string) {
  return invoke<LogEntry>(commandNames.logRecordPlaceholder, { level, target, message });
}

export function serialListPorts() {
  return invoke<SerialPortInfo[]>(commandNames.serialListPorts);
}

export function serialTerminalClose(terminalId: string) {
  return invoke<boolean>(commandNames.serialTerminalClose, { terminalId });
}

export function serialTerminalOpen(terminalId: string, profile: ConnectionProfile) {
  return invoke<void>(commandNames.serialTerminalOpen, { terminalId, profile });
}

export function serialTerminalReconfigure(terminalId: string, profile: ConnectionProfile) {
  return invoke<void>(commandNames.serialTerminalReconfigure, { terminalId, profile });
}

export function httpSend(request: HttpSendRequest) {
  return invoke<HttpSendResponse>(commandNames.httpSend, { request });
}

export function httpSendStream(requestId: string, request: HttpSendRequest) {
  return invoke<HttpSendResponse>(commandNames.httpSendStream, { requestId, request });
}

export function httpCancel(requestId: string) {
  return invoke<void>(commandNames.httpCancel, { requestId });
}

export function httpWorkspacesGet<T>() {
  return invoke<T[]>(commandNames.httpWorkspacesGet);
}

export function httpWorkspacesSave<T>(workspaces: T[]) {
  return invoke<T[]>(commandNames.httpWorkspacesSave, { workspaces });
}

export function networkScanInterfaces() {
  return invoke<NetworkInterfaceInfo[]>(commandNames.networkScanInterfaces);
}

export function networkScanStart(request: NetworkScanRequest) {
  return invoke<NetworkScanSession>(commandNames.networkScanStart, { request });
}

export function networkScanCancel(scanId: string) {
  return invoke<boolean>(commandNames.networkScanCancel, { scanId });
}
