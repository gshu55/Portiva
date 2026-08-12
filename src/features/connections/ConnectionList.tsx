import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { profileTarget } from "../../shared/profile";
import { protocolLabel } from "../../shared/labels";
import { Icon, type IconName } from "../../shared/Icon";
import { formatBytes, formatUptime } from "../../shared/format";
import type {
  ConnectionProfile,
  SshHostOverview,
  WslDiscovery,
  WslDistributionInfo,
  WslHostOverview,
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
  onOpenWslDistribution: (distribution: string) => Promise<unknown>;
  onOpenWslFiles: (distribution: string) => void;
  onRefreshHostOverview: (profileId: string, connectionId?: string) => Promise<SshHostOverview>;
  onRefreshWslHostOverview: (distribution: string) => Promise<WslHostOverview>;
  onRefreshWslDistributions: () => Promise<WslDiscovery>;
  onSelectProfile: (profileId: string) => void;
  wslDiscovery: WslDiscovery;
}

interface HostOverviewState {
  data: SshHostOverview | null;
  error: string | null;
  loading: boolean;
  refreshedAt: number | null;
}

interface WslOverviewState {
  data: WslHostOverview | null;
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
  onOpenWslDistribution,
  onOpenWslFiles,
  onRefreshHostOverview,
  onRefreshWslHostOverview,
  onRefreshWslDistributions,
  onSelectProfile,
  profiles,
  sessionTabs,
  wslDiscovery,
}: ConnectionListProps) {
  const savedProfiles = useMemo(() => uniqueProfilesByTarget(profiles), [profiles]);
  const [query, setQuery] = useState("");
  const [overviewByProfile, setOverviewByProfile] = useState<Record<string, HostOverviewState>>({});
  const [wslOverviewByDistribution, setWslOverviewByDistribution] = useState<Record<string, WslOverviewState>>({});
  const [openMenuProfileId, setOpenMenuProfileId] = useState<string | null>(null);
  const [openingWslDistribution, setOpeningWslDistribution] = useState<string | null>(null);
  const [wslRefreshing, setWslRefreshing] = useState(false);
  const [wslRefreshError, setWslRefreshError] = useState<string | null>(null);
  const refreshingProfileIds = useRef(new Set<string>());
  const refreshingWslDistributions = useRef(new Set<string>());
  const refreshingWslDiscoveryRef = useRef(false);
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

  const filteredWslDistributions = useMemo(() => {
    const normalizedQuery = query.trim().toLocaleLowerCase();
    if (!normalizedQuery) {
      return wslDiscovery.distributions;
    }

    return wslDiscovery.distributions.filter((distribution) =>
      [distribution.name, `WSL${distribution.version ?? ""}`, distribution.isDefault ? "默认" : ""]
        .join(" ")
        .toLocaleLowerCase()
        .includes(normalizedQuery),
    );
  }, [query, wslDiscovery.distributions]);

  const wslSessionCountByDistribution = useMemo(() => {
    const counts = new Map<string, number>();
    sessionTabs.forEach((tab) => {
      const transport = tab.connection.transport;
      if (transport?.kind !== "wsl" || tab.connection.status === "disconnected") {
        return;
      }

      counts.set(transport.host, (counts.get(transport.host) ?? 0) + 1);
    });
    return counts;
  }, [sessionTabs]);

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

  const refreshWslOverview = useCallback(async (distribution: WslDistributionInfo) => {
    if (distribution.state !== "running") {
      setWslOverviewByDistribution((current) => {
        if (!current[distribution.name]) {
          return current;
        }
        const next = { ...current };
        delete next[distribution.name];
        return next;
      });
      return;
    }
    if (refreshingWslDistributions.current.has(distribution.name)) {
      return;
    }

    refreshingWslDistributions.current.add(distribution.name);
    setWslOverviewByDistribution((current) => ({
      ...current,
      [distribution.name]: {
        data: current[distribution.name]?.data ?? null,
        error: null,
        loading: true,
        refreshedAt: current[distribution.name]?.refreshedAt ?? null,
      },
    }));

    try {
      const overview = await onRefreshWslHostOverview(distribution.name);
      if (!mountedRef.current) {
        return;
      }
      setWslOverviewByDistribution((current) => ({
        ...current,
        [distribution.name]: {
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
      setWslOverviewByDistribution((current) => ({
        ...current,
        [distribution.name]: {
          data: current[distribution.name]?.data ?? null,
          error: hostOverviewErrorMessage(error),
          loading: false,
          refreshedAt: current[distribution.name]?.refreshedAt ?? null,
        },
      }));
    } finally {
      refreshingWslDistributions.current.delete(distribution.name);
    }
  }, [onRefreshWslHostOverview]);

  const refreshWsl = useCallback(async (silent = false) => {
    if (refreshingWslDiscoveryRef.current) {
      return null;
    }
    refreshingWslDiscoveryRef.current = true;
    if (!silent) {
      setWslRefreshing(true);
    }
    try {
      const discovery = await onRefreshWslDistributions();
      setWslRefreshError(null);
      discovery.distributions.forEach((distribution) => {
        void refreshWslOverview(distribution);
      });
      return discovery;
    } catch (error) {
      setWslRefreshError(hostOverviewErrorMessage(error));
      return null;
    } finally {
      refreshingWslDiscoveryRef.current = false;
      if (!silent) {
        setWslRefreshing(false);
      }
    }
  }, [onRefreshWslDistributions, refreshWslOverview]);

  const refreshSavedOverviews = useCallback(() => {
    savedProfiles.forEach((profile) => {
      void refreshOverview(profile);
    });
  }, [refreshOverview, savedProfiles]);

  const refreshAll = useCallback(() => {
    refreshSavedOverviews();
    if (wslDiscovery.supported) {
      void refreshWsl();
    }
  }, [refreshSavedOverviews, refreshWsl, wslDiscovery.supported]);

  const openWslDistribution = useCallback(async (distribution: string) => {
    if (openingWslDistribution) {
      return;
    }

    setOpeningWslDistribution(distribution);
    try {
      await onOpenWslDistribution(distribution);
    } finally {
      setOpeningWslDistribution(null);
    }
  }, [onOpenWslDistribution, openingWslDistribution]);

  const autoRefreshKey = useMemo(
    () =>
      savedProfiles
        .filter((profile) => profile.type === "ssh" || profile.type === "sftp")
        .map((profile) => `${profile.id}:${profile.updatedAt}:${sessionsByProfile.get(profile.id)?.connection.id ?? ""}`)
        .join("|"),
    [savedProfiles, sessionsByProfile],
  );
  const wslAutoRefreshKey = useMemo(
    () => wslDiscovery.distributions
      .map((distribution) => `${distribution.name}:${distribution.state}:${distribution.version ?? ""}`)
      .join("|"),
    [wslDiscovery.distributions],
  );

  useEffect(() => {
    mountedRef.current = true;
    refreshSavedOverviews();
    return () => {
      mountedRef.current = false;
    };
    // autoRefreshKey intentionally captures profile edits and newly authenticated sessions.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoRefreshKey]);

  useEffect(() => {
    wslDiscovery.distributions.forEach((distribution) => {
      void refreshWslOverview(distribution);
    });
    // wslAutoRefreshKey intentionally captures distribution lifecycle changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wslAutoRefreshKey]);

  useEffect(() => {
    if (!wslDiscovery.supported) {
      return;
    }
    const timer = window.setInterval(() => {
      void refreshWsl(true);
    }, 15_000);
    return () => window.clearInterval(timer);
  }, [refreshWsl, wslDiscovery.supported]);

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
  const refreshingWslCount = Object.values(wslOverviewByDistribution).filter((state) => state.loading).length;
  const totalRefreshingCount = refreshingCount + refreshingWslCount + (wslRefreshing ? 1 : 0);
  const hasInventory = savedProfiles.length > 0 || wslDiscovery.distributions.length > 0;
  const hasFilteredInventory = filteredProfiles.length > 0 || filteredWslDistributions.length > 0;
  const normalizedQuery = query.trim();
  const showWslSection = wslDiscovery.supported
    && hasInventory
    && (
      !normalizedQuery
      || filteredWslDistributions.length > 0
      || wslDiscovery.distributions.length === 0
    );

  return (
    <section aria-label="轻量运维工作台" className="saved-connections-page">
        <header className="saved-connections-topbar">
          <div className="saved-connections-title">
            <span className="saved-connections-title-icon"><Icon name="server" /></span>
            <div>
              <strong>主机概览</strong>
              <span>
                {savedProfiles.length} 个已保存连接
                {wslDiscovery.supported ? ` · ${wslDiscovery.distributions.length} 个 WSL 环境` : ""}
                {` · ${reachableCount} 个远程可达`}
              </span>
            </div>
          </div>
          <div className="saved-connections-topbar-actions">
            <label className="saved-connections-search">
              <Icon name="search" />
              <input
                aria-label="搜索主机和本机环境"
                placeholder="搜索主机或 WSL"
                type="search"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
              />
            </label>
            <button
              aria-label="刷新全部主机概览"
              className="saved-toolbar-icon-button"
              disabled={totalRefreshingCount > 0}
              onClick={refreshAll}
              title={totalRefreshingCount > 0 ? "正在刷新主机概览" : "刷新全部"}
              type="button"
            >
              <Icon className={totalRefreshingCount > 0 ? "is-spinning" : ""} name="refresh-ccw" />
            </button>
            <button aria-label="新建连接" className="saved-create-button" disabled={connectionPending} onClick={onCreateProfile} type="button">
              <Icon name="plus" />
              <span>新建连接</span>
            </button>
          </div>
        </header>

        <div className="saved-connections-content">
          {showWslSection ? (
            <section aria-label="Windows Subsystem for Linux" className="wsl-environments-section">
              <header className="saved-section-heading">
                <div>
                  <span className="wsl-section-mark"><Icon name="terminal" /></span>
                  <span>
                    <strong>本机 WSL 环境</strong>
                    {wslRefreshError ? <small className="error" role="status" title={wslRefreshError}>刷新失败</small> : null}
                  </span>
                </div>
                <button
                  aria-label="刷新 WSL 发行版"
                  disabled={wslRefreshing}
                  onClick={() => void refreshWsl()}
                  title="刷新 WSL 发行版"
                  type="button"
                >
                  <Icon className={wslRefreshing ? "is-spinning" : ""} name="refresh-ccw" />
                </button>
              </header>

              {filteredWslDistributions.length > 0 ? (
                <div className="wsl-environments-grid">
                  {filteredWslDistributions.map((distribution, index) => (
                    <WslDistributionCard
                      activeSessions={wslSessionCountByDistribution.get(distribution.name) ?? 0}
                      distribution={distribution}
                      index={index}
                      key={distribution.name}
                      overview={wslOverviewByDistribution[distribution.name]}
                      opening={openingWslDistribution === distribution.name}
                      openingBlocked={Boolean(openingWslDistribution) || connectionPending}
                      onOpen={openWslDistribution}
                      onOpenFiles={onOpenWslFiles}
                    />
                  ))}
                </div>
              ) : (
                <div className={["wsl-environments-notice", wslDiscovery.available ? "" : "error"].filter(Boolean).join(" ")}>
                  <Icon name={wslDiscovery.available ? "terminal" : "ban"} />
                  <div>
                    <strong>{wslDiscovery.available ? "尚未安装 Linux 发行版" : "WSL 当前不可用"}</strong>
                    <span>{wslDiscovery.message ?? "安装发行版后刷新此页面即可使用。"}</span>
                  </div>
                </div>
              )}
            </section>
          ) : null}

          {filteredProfiles.length > 0 && wslDiscovery.supported ? (
            <div className="saved-section-heading remote-section-heading">
              <div>
                <span className="remote-section-mark"><Icon name="server" /></span>
                <span>
                  <strong>远程与设备连接</strong>
                </span>
              </div>
            </div>
          ) : null}
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
          ) : !hasFilteredInventory && normalizedQuery ? (
            <div className="saved-connections-empty">
              <Icon name="search" />
              <strong>没有匹配的主机或 WSL 环境</strong>
              <span>换个名称、地址、协议或发行版试试。</span>
            </div>
          ) : !hasInventory ? (
            <div className="saved-connections-empty inventory-empty">
              <Icon name="server" />
              <strong>暂无连接</strong>
              <span>新建连接后会显示在这里。</span>
              <button disabled={connectionPending} onClick={onCreateProfile} type="button"><Icon name="plus" />新建连接</button>
            </div>
          ) : null}
        </div>
    </section>
  );
}

function WslDistributionCard({
  activeSessions,
  distribution,
  index,
  onOpen,
  onOpenFiles,
  overview,
  opening,
  openingBlocked,
}: {
  activeSessions: number;
  distribution: WslDistributionInfo;
  index: number;
  onOpen: (distribution: string) => Promise<void>;
  onOpenFiles: (distribution: string) => void;
  overview: WslOverviewState | undefined;
  opening: boolean;
  openingBlocked: boolean;
}) {
  const stateLabel = distribution.state === "running"
    ? "运行中"
    : distribution.state === "stopped"
      ? "已停止"
      : "状态未知";
  const versionLabel = distribution.version ? `WSL ${distribution.version}` : "WSL";

  return (
    <article
      aria-busy={opening}
      className={["wsl-environment-card", distribution.state === "running" ? "is-running" : ""].filter(Boolean).join(" ")}
      style={{ "--card-index": index } as CSSProperties}
    >
      <div className="wsl-card-header">
        <span className="wsl-card-glyph"><Icon name="terminal" /></span>
        <div className="wsl-card-identity">
          <strong title={distribution.name}>{distribution.name}</strong>
          <span>{versionLabel}{distribution.isDefault ? " · 默认发行版" : ""}</span>
        </div>
        <span className={["wsl-state-chip", distribution.state].join(" ")}>{stateLabel}</span>
      </div>

      <WslOverviewPanel distribution={distribution} state={overview} />

      <div className="wsl-card-meta">
        <span><i className={["saved-status-dot", distribution.state === "running" ? "online" : "idle"].join(" ")} />{stateLabel}</span>
        <span>{activeSessions > 0 ? `${activeSessions} 个终端会话` : "尚未打开终端"}</span>
      </div>

      <div className="wsl-card-actions">
        <button
          className="wsl-card-open"
          disabled={openingBlocked}
          onClick={() => void onOpen(distribution.name)}
          type="button"
        >
          <Icon name="terminal" />
          <span>{opening ? "正在启动…" : "打开 Linux 终端"}</span>
        </button>
        <button
          aria-label={`打开 ${distribution.name} 文件管理`}
          className="wsl-card-files"
          onClick={() => onOpenFiles(distribution.name)}
          title="Windows ↔ WSL 快速传文件"
          type="button"
        >
          <Icon name="folder-open" />
        </button>
      </div>
    </article>
  );
}

function WslOverviewPanel({
  distribution,
  state,
}: {
  distribution: WslDistributionInfo;
  state: WslOverviewState | undefined;
}) {
  if (distribution.state !== "running") {
    return (
      <div className="saved-card-message wsl-not-running">
        <Icon name="activity" />
        <div>
          <strong>资源采集已暂停</strong>
          <span>发行版未运行，不会读取占用信息或启动 WSL。</span>
        </div>
      </div>
    );
  }

  if (state?.data) {
    const overview = state.data;
    const memoryPercent = usagePercent(overview.memoryUsedBytes, overview.memoryTotalBytes);
    const diskPercent = usagePercent(overview.diskUsedBytes, overview.diskTotalBytes);
    const cpuPercent = overview.cpuUsagePercent === null ? null : Math.round(overview.cpuUsagePercent);

    return (
      <div className="saved-card-overview wsl-card-overview">
        <div className="saved-card-metrics">
          <Metric label="CPU" value={cpuPercent === null ? "—" : `${cpuPercent}%`} detail={overview.cpuCount ? `${overview.cpuCount} 核` : "不可用"} progress={cpuPercent} />
          <Metric
            label="内存"
            value={memoryPercent === null ? "—" : `${memoryPercent}%`}
            detail={formatUsage(overview.memoryUsedBytes, overview.memoryTotalBytes)}
            progress={memoryPercent}
          />
          <Metric
            label="磁盘"
            value={diskPercent === null ? "—" : `${diskPercent}%`}
            detail={formatUsage(overview.diskUsedBytes, overview.diskTotalBytes)}
            progress={diskPercent}
          />
        </div>
        <div className={["saved-card-system", state.error ? "error" : ""].filter(Boolean).join(" ")} title={state.error ?? `${overview.operatingSystem} · ${overview.kernelVersion}`}>
          <Icon name="activity" />
          <span>{overview.operatingSystem} · 已运行 {formatUptime(overview.uptimeSeconds)}{state.error ? " · 更新失败" : state.loading ? " · 刷新中" : ""}</span>
        </div>
      </div>
    );
  }

  if (state?.error) {
    return (
      <div className="saved-card-message error" title={state.error}>
        <Icon name="activity" />
        <div>
          <strong>WSL 占用获取失败</strong>
          <span>{state.error}</span>
        </div>
      </div>
    );
  }

  return (
    <div className="saved-card-message loading">
      <Icon className="is-spinning" name="refresh-ccw" />
      <span>正在读取 WSL 资源占用…</span>
    </div>
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
        <span className="saved-metric-progress" aria-label={`${label}使用率 ${progress}%`} role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={progress}>
          <i style={{ width: `${progress}%` }} />
        </span>
      ) : null}
      <small>{detail}</small>
    </div>
  );
}

function usagePercent(used: number | null, total: number | null) {
  return used !== null && total
    ? Math.min(100, Math.max(0, Math.round((used / total) * 100)))
    : null;
}

function formatUsage(used: number | null, total: number | null) {
  return used !== null && total !== null ? `${formatBytes(used)} / ${formatBytes(total)}` : "不可用";
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
