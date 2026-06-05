import { useEffect } from "react";
import { profileTarget } from "../../shared/profile";
import { protocolLabel } from "../../shared/labels";
import { Icon, type IconName } from "../../shared/Icon";
import type { ConnectionProfile } from "../../shared/types";

interface ConnectionListProps {
  activeProfileId: string;
  profiles: ConnectionProfile[];
  onConnectProfile: (profile: ConnectionProfile) => void;
  onClose: () => void;
  onCreateProfile: () => void;
  onDeleteProfile: (profileId: string) => void;
  onEditProfile: (profile: ConnectionProfile) => void;
  onSelectProfile: (profileId: string) => void;
}

const profileIcons: Record<ConnectionProfile["type"], IconName> = {
  "raw-tcp": "server",
  serial: "plug",
  sftp: "folder-open",
  ssh: "terminal",
  telnet: "network",
};

export function ConnectionList({
  activeProfileId,
  onClose,
  onConnectProfile,
  onCreateProfile,
  onDeleteProfile,
  onEditProfile,
  onSelectProfile,
  profiles,
}: ConnectionListProps) {
  const savedProfiles = uniqueProfilesByTarget(profiles);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onClose();
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  return (
    <div className="modal-backdrop" onMouseDown={(event) => {
      if (event.target === event.currentTarget) {
        onClose();
      }
    }}>
      <section className="profile-dialog saved-connections saved-connections-dialog" aria-label="已保存连接" role="dialog">
        <div className="profile-dialog-heading">
          <div>
            <strong>已保存连接</strong>
            <span>{savedProfiles.length} 个连接配置</span>
          </div>
          <div className="saved-connections-heading-actions">
            <button aria-label="关闭已保存连接" onClick={onClose} title="关闭" type="button">
              <Icon name="x" />
            </button>
          </div>
        </div>
        <div className="saved-connections-toolbar" aria-label="已保存连接工具栏">
          <button aria-label="新建连接" onClick={onCreateProfile} title="新建连接" type="button">
            <Icon name="plus" />
            <span>新建</span>
          </button>
        </div>
      <div className="profile-list">
        {savedProfiles.length > 0 ? (
          savedProfiles.map((profile) => (
            <div className={`profile-item ${profile.id === activeProfileId ? "active" : ""}`} key={profile.id}>
              <button
                aria-label={`选择 ${profile.name || profileTarget(profile)}`}
                onClick={() => onSelectProfile(profile.id)}
                onDoubleClick={() => onConnectProfile(profile)}
                title={`双击连接 ${profile.name || profileTarget(profile)}`}
                type="button"
              >
                <Icon name={profileIcons[profile.type]} />
                <span className="profile-protocol">{protocolLabel(profile.type)}</span>
                <span className="profile-name">{profile.name || profileTarget(profile)}</span>
                <span className="profile-target">{profileTarget(profile)}</span>
              </button>
              <div className="profile-actions">
                <button aria-label={`连接 ${profile.name}`} onClick={() => onConnectProfile(profile)} title="连接" type="button">
                  <Icon name="plug" />
                </button>
                <button aria-label={`编辑 ${profile.name}`} onClick={() => onEditProfile(profile)} title="编辑连接" type="button">
                  <Icon name="edit" />
                </button>
                <button
                  aria-label={`删除 ${profile.name}`}
                  className="danger-action"
                  onClick={() => onDeleteProfile(profile.id)}
                  title="删除连接"
                  type="button"
                >
                  <Icon name="trash" />
                </button>
              </div>
            </div>
          ))
        ) : (
          <span className="profile-empty">还没有保存的连接。</span>
        )}
      </div>
      </section>
    </div>
  );
}

function uniqueProfilesByTarget(profiles: ConnectionProfile[]) {
  const unique = new Map<string, ConnectionProfile>();

  for (const profile of profiles) {
    const key = profileDedupKey(profile);
    const current = unique.get(key);

    if (!current || profile.updatedAt > current.updatedAt) {
      unique.set(key, profile);
    }
  }

  return [...unique.values()];
}

function profileDedupKey(profile: ConnectionProfile) {
  if (profile.type === "serial") {
    return `${profile.type}:${profile.portName.trim().toLowerCase()}`;
  }

  const username = "username" in profile ? profile.username ?? "" : "";
  return `${profile.type}:${username.trim().toLowerCase()}@${profile.host.trim().toLowerCase()}:${profile.port}`;
}
