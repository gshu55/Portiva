import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { profileTarget } from "../../shared/profile";
import { protocolLabel } from "../../shared/labels";
import { Icon, type IconName } from "../../shared/Icon";
import { formatBytes, formatUptime } from "../../shared/format";
import type {
  ConnectionProfile,
  SshHostOverview,
  WorkspaceSessionTab,
} from "../../shared/types";

interface ConnectionListProps {
  activeProfileId: string;
  connectingProfileId: string | null;
  profiles: ConnectionProfile[];
  sessionTabs: WorkspaceSessionTab[];
  onConnectProfile: (profile: ConnectionProfile) => void;
  onCreateProfile: () => void;
  onDeleteProfile: (profileId: string) => void;
  onEditProfile: (profile: ConnectionProfile) => void;
  onOpenFileTransfer: (profile: ConnectionProfile, connectionId?: string) => void;
  onOpenSession: (tabId: string) => void;
  onRefreshHostOverview: (profileId: string, connectionId?: string) => Promise<SshHostOverview>;
  onSelectProfile: (profileId: string) => void;
}

interface HostOverviewState {
  data: SshHostOverview | null;
  error: string | null;
  loading: boolean;
  refreshedAt: number | null;
}

const profileIcons: Record<ConnectionProfile["type"], IconName> = {
  "raw-tcp": "server",
  serial: "plug",
  sftp: "folder-open",
  ssh: "server",
  telnet: "network",
};

export function ConnectionList({
  activeProfileId,
  connectingProfileId,
  onConnectProfile,
  onCreateProfile,
  onDeleteProfile,
  onEditProfile,
  onOpenFileTransfer,
  onOpenSession,
  onRefreshHostOverview,
  onSelectProfile,
  profiles,
  sessionTabs,
}: ConnectionListProps) {
  const savedProfiles = useMemo(() => uniqueProfilesByTarget(profiles), [profiles]);
  const [query, setQuery] = useState("");
  const [overviewByProfile, setOverviewByProfile] = useState<Record<string, HostOverviewState>>({});
  const [openMenuProfileId, setOpenMenuProfileId] = useState<string | null>(null);
  const refreshingProfileIds = useRef(new Set<string>());
  const mountedRef = useRef(true);
  const connectionPending = Boolean(connectingProfileId);

  const sessionsByProfile = useMemo(() => {
    const result = new Map<string, WorkspaceSessionTab>();

    sessionTabs.forEach((tab) => {
      const current = result.get(tab.connection.profileId);
      const isAuthenticated = Boolean(tab.connection.transport?.authenticated);
      const currentIsAuthenticated = Boolean(current?.connection.transport?.authenticated);

      if (!current || (isAuthenticated && !currentIsAuthenticated)) {
        result.set(tab.connection.profileId, tab);
      }
    });

    return result;
  }, [sessionTabs]);

  const filteredProfiles = useMemo(() => {
    const normalizedQuery = query.trim().toLocaleLowerCase();
    if (!normalizedQuery) {
      return savedProfiles;
    }

    return savedProfiles.filter((profile) =>
      [profile.name, profileTarget(profile), protocolLabel(profile.type)]
        .join(" ")
        .toLocaleLowerCase()
        .includes(normalizedQuery),
    );
  }, [query, savedProfiles]);

  const refreshOverview = useCallback(
    async (profile: ConnectionProfile) => {
      if ((profile.type !== "ssh" && profile.type !== "sftp") || refreshingProfileIds.current.has(profile.id)) {
        return;
      }

      refreshingProfileIds.current.add(profile.id);
      setOverviewByProfile((current) => ({
        ...current,
        [profile.id]: {
          data: current[profile.id]?.data ?? null,
          error: null,
          loading: true,
          refreshedAt: current[profile.id]?.refreshedAt ?? null,
        },
      }));

      try {
        const session = sessionsByProfile.get(profile.id);
        const overview = await onRefreshHostOverview(profile.id, session?.connection.id);
        if (!mountedRef.current) {
          return;
        }
        setOverviewByProfile((current) => ({
          ...current,
          [profile.id]: {
            data: overview,
            error: null,
            loading: false,
            refreshedAt: Date.now(),
          },
        }));
      } catch (error) {
        if (!mountedRef.current) {
          return;
        }
        setOverviewByProfile((current) => ({
          ...current,
          [profile.id]: {
            data: current[profile.id]?.data ?? null,
            error: hostOverviewErrorMessage(error),
            loading: false,
            refreshedAt: current[profile.id]?.refreshedAt ?? null,
          },
        }));
      } finally {
        refreshingProfileIds.current.delete(profile.id);
      }
    },
    [onRefreshHostOverview, sessionsByProfile],
  );

  const refreshAll = useCallback(() => {
    savedProfiles.forEach((profile) => {
      void refreshOverview(profile);
    });
  }, [refreshOverview, savedProfiles]);

  const autoRefreshKey = useMemo(
    () =>
      savedProfiles
        .filter((profile) => profile.type === "ssh" || profile.type === "sftp")
        .map((profile) => `${profile.id}:${profile.updatedAt}:${sessionsByProfile.get(profile.id)?.connection.id ?? ""}`)
        .join("|"),
    [savedProfiles, sessionsByProfile],
  );

  useEffect(() => {
    mountedRef.current = true;
    refreshAll();
    return () => {
      mountedRef.current = false;
    };
    // autoRefreshKey intentionally captures profile edits and newly authenticated sessions.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoRefreshKey]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        if (openMenuProfileId) {
          setOpenMenuProfileId(null);
        }
      }
    };
    const closeMenu = (event: PointerEvent) => {
      if (!(event.target as HTMLElement).closest(".saved-card-more")) {
        setOpenMenuProfileId(null);
      }
    };

    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("pointerdown", closeMenu);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("pointerdown", closeMenu);
    };
  }, [openMenuProfileId]);

  const reachableCount = savedProfiles.filter((profile) => {
    const session = sessionsByProfile.get(profile.id);
    return Boolean(overviewByProfile[profile.id]?.data || session?.connection.transport?.authenticated);
  }).length;
  const refreshingCount = Object.values(overviewByProfile).filter((state) => state.loading).length;

  return (
    <section aria-label="轻量运维工作台" className="saved-connections-page">
        <header className="saved-connections-topbar">
          <div className="saved-connections-title">
            <span className="saved-connections-title-icon"><Icon name="server" /></span>
            <div>
              <strong>主机概览</strong>
              <span>{savedProfiles.length} 个已保存连接 · {reachableCount} 个可达</span>
            </div>
          </div>
          <div className="saved-connections-topbar-actions">
            <label className="saved-connections-search">
              <Icon name="search" />
              <input
                aria-label="搜索已保存连接"
                placeholder="搜索主机"
                type="search"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
              />
            </label>
            <button
              aria-label="刷新全部主机概览"
              className="saved-toolbar-icon-button"
              disabled={refreshingCount > 0}
              onClick={refreshAll}
              title={refreshingCount > 0 ? `正在刷新 ${refreshingCount} 个主机` : "刷新全部"}
              type="button"
            >
              <Icon className={refreshingCount > 0 ? "is-spinning" : ""} name="refresh-ccw" />
            </button>
            <button className="saved-create-button" disabled={connectionPending} onClick={onCreateProfile} type="button">
              <Icon name="plus" />
              <span>新建连接</span>
            </button>
          </div>
        </header>

        <div className="saved-connections-content">
          {filteredProfiles.length > 0 ? (
            <div className="saved-connections-grid">
              {filteredProfiles.map((profile, index) => {
                const isConnecting = profile.id === connectingProfileId;
                const session = sessionsByProfile.get(profile.id);
                const isSessionConnected = Boolean(session?.connection.transport?.authenticated);
                const overviewState = overviewByProfile[profile.id];
                const isReachable = Boolean(overviewState?.data || isSessionConnected);
                const tabId = session ? session.id ?? session.connection.id : null;
                const isSshProfile = profile.type === "ssh" || profile.type === "sftp";
                const supportsFileTransfer = isSshProfile || Boolean(session?.connection.capabilities.fileTransfer);
                const canOpenFileTransfer = supportsFileTransfer && (isSessionConnected || Boolean(overviewState?.data));

                return (
                  <article
                    aria-busy={isConnecting || overviewState?.loading}
                    className={[
                      "saved-connection-card",
                      profile.id === activeProfileId ? "active" : "",
                      isConnecting ? "is-connecting" : "",
                    ].filter(Boolean).join(" ")}
                    key={profile.id}
                    onClick={() => onSelectProfile(profile.id)}
                    style={{ "--card-index": index } as CSSProperties}
                  >
                    <div className="saved-card-header">
                      <span className="saved-card-server-icon"><Icon name={profileIcons[profile.type]} /></span>
                      <div className="saved-card-identity">
                        <strong title={profile.name || profileTarget(profile)}>{profile.name || profileTarget(profile)}</strong>
                        <span title={profileTarget(profile)}>{profileTarget(profile)}</span>
                      </div>
                      <button
                        aria-label={`刷新 ${profile.name || profileTarget(profile)} 的主机概览`}
                        className="saved-card-refresh"
                        disabled={!isSshProfile || overviewState?.loading}
                        onClick={(event) => {
                          event.stopPropagation();
                          void refreshOverview(profile);
                        }}
                        title={isSshProfile ? "通过 SSH 刷新主机概览" : "该协议不支持 SSH 主机概览"}
                        type="button"
                      >
                        <Icon className={overviewState?.loading ? "is-spinning" : ""} name="refresh-ccw" />
                      </button>
                    </div>

                    <HostOverviewPanel profile={profile} state={overviewState} />

                    <div className="saved-card-status-row">
                      <span className={["saved-status-dot", isConnecting ? "connecting" : isReachable ? "online" : overviewState?.error ? "error" : "idle"].join(" ")} />
                      <strong>{isConnecting ? "正在连接" : isSessionConnected ? "会话已连接" : overviewState?.data ? "SSH 可达" : overviewState?.error ? "暂不可用" : "等待检测"}</strong>
                      <span>{overviewState?.data ? `${overviewState.data.latencyMs} ms` : protocolLabel(profile.type)}</span>
                    </div>

                    <div className="saved-card-footer">
                      <button
                        className="saved-card-primary"
                        disabled={connectionPending}
                        onClick={(event) => {
                          event.stopPropagation();
                          if (tabId && isSessionConnected) {
                            onOpenSession(tabId);
                          } else {
                            onConnectProfile(profile);
                          }
                        }}
                        type="button"
                      >
                        <Icon name="terminal" />
                        <span>{isConnecting ? "正在连接…" : tabId && isSessionConnected ? "打开终端" : "新建终端"}</span>
                      </button>
                      <button
                        aria-label={`打开 ${profile.name} 的文件管理`}
                        className="saved-card-round-action"
                        disabled={connectionPending || !canOpenFileTransfer}
                        onClick={(event) => {
                          event.stopPropagation();
                          if (
                            isSessionConnected &&
                            session &&
                            (session.kind ?? "terminal") === "file-transfer" &&
                            tabId
                          ) {
                            onOpenSession(tabId);
                            return;
                          }

                          onOpenFileTransfer(
                            profile,
                            isSessionConnected ? session?.connection.id : undefined,
                          );
                        }}
                        title={
                          isSessionConnected
                            ? "打开 SFTP 文件管理"
                            : overviewState?.data
                            ? "连接并打开 SFTP 文件管理"
                            : supportsFileTransfer
                            ? "获取到设备信息后可打开 SFTP 文件管理"
                            : "该协议不支持 SFTP 文件管理"
                        }
                        type="button"
                      >
                        <Icon name="folder-open" />
                      </button>
                      <div className="saved-card-more">
                        <button
                          aria-expanded={openMenuProfileId === profile.id}
                          aria-haspopup="menu"
                          aria-label={`更多操作：${profile.name}`}
                          className="saved-card-round-action"
                          disabled={connectionPending}
                          onClick={(event) => {
                            event.stopPropagation();
                            setOpenMenuProfileId((current) => current === profile.id ? null : profile.id);
                          }}
                          type="button"
                        >
                          <Icon name="more-horizontal" />
                        </button>
                        {openMenuProfileId === profile.id ? (
                          <div className="saved-card-menu" role="menu" onClick={(event) => event.stopPropagation()}>
                            <button onClick={() => onEditProfile(profile)} role="menuitem" type="button">
                              <Icon name="edit" />
                              <span>编辑连接</span>
                            </button>
                            <button className="danger-action" onClick={() => onDeleteProfile(profile.id)} role="menuitem" type="button">
                              <Icon name="trash" />
                              <span>删除连接</span>
                            </button>
                          </div>
                        ) : null}
                      </div>
                    </div>
                  </article>
                );
              })}
            </div>
          ) : savedProfiles.length > 0 ? (
            <div className="saved-connections-empty">
              <Icon name="search" />
              <strong>没有匹配的主机</strong>
              <span>换个名称、地址或协议试试。</span>
            </div>
          ) : (
            <div className="saved-connections-empty">
              <Icon name="server" />
              <strong>还没有保存的连接</strong>
              <span>创建 SSH 连接后，这里会自动采集 CPU、内存、磁盘、网络和运行时长。</span>
              <button onClick={onCreateProfile} type="button"><Icon name="plus" />新建连接</button>
            </div>
          )}
        </div>
    </section>
  );
}

function HostOverviewPanel({
  profile,
  state,
}: {
  profile: ConnectionProfile;
  state: HostOverviewState | undefined;
}) {
  const isSshProfile = profile.type === "ssh" || profile.type === "sftp";

  if (state?.data) {
    const overview = state.data;
    const memoryPercent = overview.memoryUsedBytes !== null && overview.memoryTotalBytes
      ? Math.min(100, Math.round((overview.memoryUsedBytes / overview.memoryTotalBytes) * 100))
      : null;

    return (
      <div className="saved-card-overview">
        <div className="saved-card-metrics">
          <Metric label="平均负载" value={overview.cpuLoad1 === null ? "—" : overview.cpuLoad1.toFixed(2)} detail={overview.cpuCount ? `${overview.cpuCount} 核 CPU` : "CPU"} />
          <Metric
            label="内存"
            value={memoryPercent === null ? "—" : `${memoryPercent}%`}
            detail={overview.memoryUsedBytes !== null && overview.memoryTotalBytes !== null ? `${formatBytes(overview.memoryUsedBytes)} / ${formatBytes(overview.memoryTotalBytes)}` : "不可用"}
            progress={memoryPercent}
          />
          <Metric label="运行时间" value={formatUptime(overview.uptimeSeconds)} detail={state.loading ? "正在刷新…" : refreshedAtLabel(state.refreshedAt)} />
        </div>
        <div className="saved-card-system" title={`${overview.operatingSystem} · ${overview.kernelVersion}`}>
          <Icon name="activity" />
          <span>{overview.operatingSystem} · {overview.kernelVersion}</span>
        </div>
      </div>
    );
  }

  if (!isSshProfile) {
    return (
      <div className="saved-card-message">
        <Icon name="activity" />
        <span>{protocolLabel(profile.type)} 连接不支持 SSH 主机指标采集。</span>
      </div>
    );
  }

  if (state?.error) {
    return (
      <div className="saved-card-message error" title={state.error}>
        <Icon name="activity" />
        <div>
          <strong>主机信息获取失败</strong>
          <span>{state.error}</span>
        </div>
      </div>
    );
  }

  return (
    <div className="saved-card-message loading">
      <Icon className="is-spinning" name="refresh-ccw" />
      <span>正在通过 SSH 获取服务器信息…</span>
    </div>
  );
}

function Metric({
  detail,
  label,
  progress,
  value,
}: {
  detail: string;
  label: string;
  progress?: number | null;
  value: string;
}) {
  return (
    <div className="saved-metric">
      <span>{label}</span>
      <strong>{value}</strong>
      {typeof progress === "number" ? (
        <span className="saved-metric-progress" aria-label={`内存使用率 ${progress}%`} role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={progress}>
          <i style={{ width: `${progress}%` }} />
        </span>
      ) : null}
      <small>{detail}</small>
    </div>
  );
}

function refreshedAtLabel(value: number | null) {
  if (!value) {
    return "刚刚更新";
  }
  return new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit" }).format(value);
}

function hostOverviewErrorMessage(error: unknown) {
  const message = String(error)
    .replace(/^Error:\s*/i, "")
    .replace(/^命令失败：\s*/i, "")
    .trim();
  if (message.includes("not trusted")) {
    return "主机密钥尚未信任，请先连接并确认指纹";
  }
  if (message.includes("timed out") || message.includes("timeout")) {
    return "SSH 请求超时";
  }
  return message || "未知错误";
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

  return [...unique.values()].sort(
    (left, right) =>
      right.createdAt.localeCompare(left.createdAt) ||
      left.id.localeCompare(right.id),
  );
}

function profileDedupKey(profile: ConnectionProfile) {
  if (profile.type === "serial") {
    return `${profile.type}:${profile.portName.trim().toLowerCase()}`;
  }

  const username = "username" in profile ? profile.username ?? "" : "";
  return `${profile.type}:${username.trim().toLowerCase()}@${profile.host.trim().toLowerCase()}:${profile.port}`;
}
