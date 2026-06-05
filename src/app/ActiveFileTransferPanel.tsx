import type { usePortivaWorkspace } from "./usePortivaWorkspace";
import { FileTransferPanel } from "../features/file-transfer/FileTransferPanel";

interface ActiveFileTransferPanelProps {
  workspace: ReturnType<typeof usePortivaWorkspace>;
}

export function ActiveFileTransferPanel({ workspace }: ActiveFileTransferPanelProps) {
  if (workspace.activeSessionTabKind !== "file-transfer") {
    return null;
  }

  return (
    <FileTransferPanel
      capabilities={workspace.capabilities}
      sftpConnectionOptions={workspace.sftpConnectionOptions}
      localEntries={workspace.localEntries}
      localPath={workspace.localPath}
      remoteEntries={workspace.remoteEntries}
      remotePath={workspace.remotePath}
      selectedLocalEntry={workspace.selectedLocalEntry}
      selectedRemoteEntry={workspace.selectedRemoteEntry}
      transfers={workspace.transfers}
      onCancelTransfer={(transferId) => workspace.updateTransferTask(transferId, "cancel")}
      onDeleteTransfer={(transferId) => workspace.updateTransferTask(transferId, "delete")}
      onOpenConnectionFileTransfer={workspace.openFileTransferTab}
      onCreateLocalDirectory={workspace.createLocalDirectory}
      onCreateRemoteDirectory={workspace.createRemoteDirectory}
      onDownloadEntry={workspace.downloadRemoteEntry}
      onDownloadSelected={workspace.downloadSelectedRemoteEntry}
      onRefreshLocal={workspace.refreshLocalFiles}
      onRefreshRemote={workspace.refreshRemoteFiles}
      onRemoveLocal={workspace.removeLocalEntry}
      onRemoveRemote={workspace.removeRemoteEntry}
      onPauseTransfer={(transferId) => workspace.updateTransferTask(transferId, "pause")}
      onRenameLocal={workspace.renameLocalEntry}
      onRenameRemote={workspace.renameRemoteEntry}
      onResumeTransfer={(transferId) => workspace.updateTransferTask(transferId, "resume")}
      onRetryTransfer={(transferId) => workspace.updateTransferTask(transferId, "retry")}
      onSelectLocalEntry={workspace.setSelectedLocalEntry}
      onSelectRemoteEntry={workspace.setSelectedRemoteEntry}
      onUploadEntry={workspace.uploadLocalEntry}
      onUploadSelected={workspace.uploadSelectedLocalEntry}
      onUploadLocalPaths={workspace.uploadLocalPaths}
    />
  );
}
