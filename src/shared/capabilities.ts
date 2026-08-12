import type { ConnectionCapabilities, ConnectionType } from "./types";

const disabled: ConnectionCapabilities = {
  terminal: false,
  fileTransfer: false,
  sftp: false,
  scp: false,
  tunnel: false,
  portForwarding: false,
  ptyResize: false,
  secureTransport: false,
  reconnect: false,
  localFileAccess: false,
  requiresHostKeyVerification: false,
};

export const capabilitiesByType: Record<ConnectionType, ConnectionCapabilities> = {
  ssh: {
    terminal: true,
    fileTransfer: true,
    sftp: true,
    scp: true,
    tunnel: true,
    portForwarding: true,
    ptyResize: true,
    secureTransport: true,
    reconnect: true,
    localFileAccess: false,
    requiresHostKeyVerification: true,
  },
  sftp: {
    ...disabled,
    fileTransfer: true,
    sftp: true,
    secureTransport: true,
    reconnect: true,
    requiresHostKeyVerification: true,
  },
  telnet: {
    ...disabled,
    terminal: true,
    ptyResize: true,
    reconnect: true,
  },
  serial: {
    ...disabled,
    terminal: true,
    reconnect: true,
  },
  "raw-tcp": {
    ...disabled,
    terminal: true,
    reconnect: true,
  },
  "local-shell": {
    ...disabled,
    terminal: true,
    ptyResize: true,
    reconnect: true,
    localFileAccess: true,
    secureTransport: true,
  },
  wsl: {
    ...disabled,
    terminal: true,
    ptyResize: true,
    reconnect: true,
    localFileAccess: true,
    secureTransport: true,
  },
  "docker-exec": {
    ...disabled,
    terminal: true,
    ptyResize: true,
    reconnect: true,
  },
  "kubernetes-exec": {
    ...disabled,
    terminal: true,
    ptyResize: true,
    reconnect: true,
  },
  ftp: {
    ...disabled,
    fileTransfer: true,
    reconnect: true,
  },
  ftps: {
    ...disabled,
    fileTransfer: true,
    secureTransport: true,
    reconnect: true,
  },
  webdav: {
    ...disabled,
    fileTransfer: true,
    reconnect: true,
  },
  s3: {
    ...disabled,
    fileTransfer: true,
    secureTransport: true,
    reconnect: true,
  },
};

export function enabledCapabilityNames(capabilities: ConnectionCapabilities) {
  return Object.entries(capabilities)
    .filter(([, enabled]) => enabled)
    .map(([name]) => name);
}
