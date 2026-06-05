import {
  ConnectionProfileDialog,
  type ConnectionSecretInput,
} from "../features/connections/ConnectionProfileDialog";
import type { ConnectionProfile } from "../shared/types";
import type { usePortivaWorkspace } from "./usePortivaWorkspace";

type Workspace = ReturnType<typeof usePortivaWorkspace>;

interface HostTrustRegistrationResult {
  requiresFingerprintConfirmation?: boolean;
  status?: string;
}

interface HostTrustRequestInput extends ConnectionSecretInput {
  authenticate?: boolean;
}

interface ProfileDialogState {
  mode: "create" | "edit";
  profile: ConnectionProfile;
}

interface ProfileDialogHostProps {
  dialog: ProfileDialogState | null;
  reconnectTabId: string | null;
  workspace: Workspace;
  onActiveShellTabChange: (tabId: string | null) => void;
  onDialogChange: (dialog: ProfileDialogState | null) => void;
  onHostTrustRequired: (
    result: HostTrustRegistrationResult,
    request: {
      connectAfterTrust: boolean;
      input?: HostTrustRequestInput;
      profile: ConnectionProfile;
      reconnectTabId?: string;
    },
  ) => boolean;
  onReconnectTabChange: (tabId: string | null) => void;
}

export function ProfileDialogHost({
  dialog,
  reconnectTabId,
  workspace,
  onActiveShellTabChange,
  onDialogChange,
  onHostTrustRequired,
  onReconnectTabChange,
}: ProfileDialogHostProps) {
  if (!dialog) {
    return null;
  }

  return (
    <ConnectionProfileDialog
      mode={dialog.mode}
      profile={dialog.profile}
      rememberedSecret={workspace.secrets.some(
        (secret) =>
          secret.profileId === dialog.profile.id &&
          secret.purpose === "password" &&
          secret.hasValue,
      )}
      serialPorts={workspace.serialPorts}
      onCreateDraft={workspace.createProfileDraft}
      onClose={() => {
        onDialogChange(null);
        onReconnectTabChange(null);
      }}
      onConnect={async (profile, input) => {
        const saved = await workspace.saveProfile(profile);

        if (!saved) {
          return {
            ok: false,
            message: "保存配置失败，未发起连接。",
          };
        }

        const connectOptions = {
          authenticate: profile.type === "ssh" || profile.type === "sftp",
          rememberSecret: input?.rememberSecret,
          secret: input?.secret,
        };
        const result = reconnectTabId
          ? await workspace.reconnectSessionTab(reconnectTabId, connectOptions, saved)
          : await workspace.openProfileConnection(saved, connectOptions);
        onHostTrustRequired(result, {
          connectAfterTrust: true,
          input: connectOptions,
          profile: saved,
          reconnectTabId: reconnectTabId ?? undefined,
        });
        if (result.status === "opened") {
          onActiveShellTabChange(null);
          onDialogChange(null);
          onReconnectTabChange(null);
        }
        return {
          ok: result.status === "opened",
          needsTrust: result.status === "needs-trust",
          message: result.message,
        };
      }}
      onDelete={(profileId) => {
        void workspace.deleteProfile(profileId);
        onDialogChange(null);
        onReconnectTabChange(null);
      }}
      onRefreshSerialPorts={workspace.refreshWorkspace}
      onSave={async (profile, input) => {
        const saved = await workspace.saveProfile(profile, input);
        if (!saved) {
          return {
            ok: false,
            message: "保存配置失败。",
          };
        }

        onReconnectTabChange(null);
        onDialogChange({ mode: "edit", profile: saved });
        return {
          ok: true,
          message: "已保存配置。",
        };
      }}
      onTest={async (profile, input) => {
        const result = await workspace.testProfile(profile, input);
        onHostTrustRequired(result, {
          connectAfterTrust: false,
          input,
          profile,
        });
        return result;
      }}
    />
  );
}
