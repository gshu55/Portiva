import type { usePortivaWorkspace } from "./usePortivaWorkspace";
import { FileTransferPanel } from "../features/file-transfer/FileTransferPanel";

interface ActiveFileTransferPanelProps {
  onOpenSsh: () => void;
  openSshPending?: boolean;
  workspace: ReturnType<typeof usePortivaWorkspace>;
}

export function ActiveFileTransferPanel({
  onOpenSsh,
  openSshPending = false,
  workspace,
}: ActiveFileTransferPanelProps) {
  if (workspace.activeSessionTabKind !== "file-transfer") {
    return null;
  }

  const activeProfile = workspace.profiles.find(
    (profile) => profile.id === workspace.activeConnection?.profileId,
  );
  const connectionName = activeProfile && (activeProfile.type === "ssh" || activeProfile.type === "sftp")
    ? `${activeProfile.username}@${activeProfile.host}`
    : workspace.activeConnection?.transport?.host || "远程主机";

  return (
    <FileTransferPanel
      capabilities={workspace.capabilities}
      openSshPending={openSshPending}
      localEntries={workspace.localEntries}
      localPath={workspace.localPath}
      remoteEntries={workspace.remoteEntries}
      remotePath={workspace.remotePath}
      remoteTitle={`SFTP / ${connectionName}`}
      selectedLocalEntry={workspace.selectedLocalEntry}
      selectedRemoteEntry={workspace.selectedRemoteEntry}
      transfers={workspace.transfers}
      onCancelTransfer={(transferId) => workspace.updateTransferTask(transferId, "cancel")}
      onDeleteTransfer={(transferId) => workspace.updateTransferTask(transferId, "delete")}
      onOpenSsh={onOpenSsh}
      onCreateLocalDirectory={workspace.createLocalDirectory}
      onCreateRemoteDirectory={workspace.createRemoteDirectory}
      onDownloadEntry={workspace.downloadRemoteEntry}
      onRefreshLocal={workspace.refreshLocalFiles}
      onRefreshRemote={workspace.refreshRemoteFiles}
      onRemoveLocal={workspace.removeLocalEntry}
      onRemoveRemote={workspace.removeRemoteEntry}
      onRemoveRemoteEntries={workspace.removeRemoteEntries}
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
