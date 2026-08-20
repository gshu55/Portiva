import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { profileTarget } from "../../shared/profile";
import { protocolLabel } from "../../shared/labels";
import { Icon, type IconName } from "../../shared/Icon";
import { formatBytes, formatUptimeDays } from "../../shared/format";
import { requiresSavedCredentialRecovery } from "../../shared/credentials";
import { exponentialBackoffDelay } from "../../shared/retryBackoff";
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
  connectingProfileIds: ReadonlySet<string>;
  profiles: ConnectionProfile[];
  rememberedPasswordProfileIds: ReadonlySet<string>;
  sessionTabs: WorkspaceSessionTab[];
  onConnectProfile: (profile: ConnectionProfile) => void;
  onCreateProfile: () => void;
  onDeleteProfile: (profileId: string) => void;
  onEditProfile: (profile: ConnectionProfile) => void;
  onOpenFileTransfer: (profile: ConnectionProfile, connectionId?: string) => void;
  onOpenSession: (tabId: string) => void;
  onOpenWslDistribution: (distribution: string) => Promise<unknown>;
  onOpenWslFiles: (distribution: string) => void;
  onRequestCredential: (profile: ConnectionProfile, message: string) => void;
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

const AUTO_REFRESH_DELAY_MS = 500;
const AUTO_REFRESH_TIMEOUT_MS = 60_000;
const HOST_OVERVIEW_REFRESH_INTERVAL_MS = 10_000;
const HOST_OVERVIEW_MAXIMUM_RETRY_INTERVAL_MS = 5 * 60_000;
const SSH_OVERVIEW_CONCURRENCY = 4;

interface HostOverviewRetryState {
  consecutiveFailures: number;
  contextKey: string;
  retryAt: number;
}

async function runWithConcurrency<T>(
  items: readonly T[],
  concurrency: number,
  task: (item: T) => Promise<void>,
) {
  let nextIndex = 0;
  const workerCount = Math.min(Math.max(1, concurrency), items.length);
  const workers = Array.from({ length: workerCount }, async () => {
    while (nextIndex < items.length) {
      const item = items[nextIndex];
      nextIndex += 1;
      await task(item);
    }
  });

  await Promise.all(workers);
}

export function ConnectionList({
  activeProfileId,
  connectingProfileIds,
  onConnectProfile,
  onCreateProfile,
  onDeleteProfile,
  onEditProfile,
  onOpenFileTransfer,
  onOpenSession,
  onOpenWslDistribution,
  onOpenWslFiles,
  onRequestCredential,
  onRefreshHostOverview,
  onRefreshWslHostOverview,
  onRefreshWslDistributions,
  onSelectProfile,
  profiles,
  rememberedPasswordProfileIds,
  sessionTabs,
  wslDiscovery,
}: ConnectionListProps) {
  const savedProfiles = useMemo(
    () => [...profiles].sort(
      (left, right) =>
        right.createdAt.localeCompare(left.createdAt) ||
        left.id.localeCompare(right.id),
    ),
    [profiles],
  );
  const [query, setQuery] = useState("");
  const [overviewByProfile, setOverviewByProfile] = useState<Record<string, HostOverviewState>>({});
  const [wslOverviewByDistribution, setWslOverviewByDistribution] = useState<Record<string, WslOverviewState>>({});
  const [openMenuProfileId, setOpenMenuProfileId] = useState<string | null>(null);
  const [openingWslDistributions, setOpeningWslDistributions] = useState<ReadonlySet<string>>(() => new Set());
  const [wslRefreshing, setWslRefreshing] = useState(false);
  const [wslRefreshError, setWslRefreshError] = useState<string | null>(null);
  const refreshingProfileIds = useRef(new Set<string>());
  const overviewRetryByProfileRef = useRef(new Map<string, HostOverviewRetryState>());
  const automaticRefreshRunningRef = useRef(false);
  const automaticCredentialPromptRef = useRef<string | null>(null);
  const refreshingWslDistributions = useRef(new Set<string>());
  const openingWslDistributionsRef = useRef(new Set<string>());
  const refreshingWslDiscoveryRef = useRef(false);
  const mountedRef = useRef(true);

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
    async (
      profile: ConnectionProfile,
      automatic = false,
      requestCredential = true,
    ): Promise<string | null> => {
      if ((profile.type !== "ssh" && profile.type !== "sftp") || refreshingProfileIds.current.has(profile.id)) {
        return null;
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
        const request = onRefreshHostOverview(profile.id, session?.connection.id);
        const overview = automatic
          ? await withTimeout(request, AUTO_REFRESH_TIMEOUT_MS, "自动刷新主机概览超时，请手动重试")
          : await request;
        if (!mountedRef.current) {
          return null;
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
        overviewRetryByProfileRef.current.delete(profile.id);
        return null;
      } catch (error) {
        const message = hostOverviewErrorMessage(error);
        const session = sessionsByProfile.get(profile.id);
        const contextKey = hostOverviewRetryContext(profile, session);
        const previousRetry = overviewRetryByProfileRef.current.get(profile.id);
        const consecutiveFailures =
          previousRetry?.contextKey === contextKey
            ? previousRetry.consecutiveFailures + 1
            : 1;
        overviewRetryByProfileRef.current.set(profile.id, {
          consecutiveFailures,
          contextKey,
          retryAt: Date.now() + exponentialBackoffDelay(
            consecutiveFailures,
            HOST_OVERVIEW_REFRESH_INTERVAL_MS,
            HOST_OVERVIEW_MAXIMUM_RETRY_INTERVAL_MS,
          ),
        });
        if (!mountedRef.current) {
          return message;
        }
        setOverviewByProfile((current) => ({
          ...current,
          [profile.id]: {
            data: current[profile.id]?.data ?? null,
            error: message,
            loading: false,
            refreshedAt: current[profile.id]?.refreshedAt ?? null,
          },
        }));
        if (requestCredential && requiresSavedCredentialRecovery(message)) {
          onRequestCredential(profile, message);
        }
        return message;
      } finally {
        refreshingProfileIds.current.delete(profile.id);
      }
    },
    [onRefreshHostOverview, onRequestCredential, sessionsByProfile],
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

  const refreshSavedOverviews = useCallback(async (automatic = false) => {
    if (automatic && automaticRefreshRunningRef.current) {
      return;
    }
    if (automatic) {
      automaticRefreshRunningRef.current = true;
    }

    try {
      const sshProfiles = savedProfiles.filter(
        (profile) => profile.type === "ssh" || profile.type === "sftp",
      );
      let profilesToRefresh = sshProfiles;
      let hasMissingCredentialProfiles = false;
      if (automatic) {
        const missingCredentialProfiles = sshProfiles.filter(
          (profile) =>
            profile.authType === "password" &&
            !rememberedPasswordProfileIds.has(profile.id) &&
            !sessionsByProfile.get(profile.id)?.connection.transport?.authenticated,
        );
        const missingCredentialProfile = missingCredentialProfiles[0];
        hasMissingCredentialProfiles = missingCredentialProfiles.length > 0;
        if (missingCredentialProfile) {
          const promptKey = `missing:${missingCredentialProfile.id}:${missingCredentialProfile.updatedAt}`;
          if (automaticCredentialPromptRef.current !== promptKey) {
            automaticCredentialPromptRef.current = promptKey;
            onRequestCredential(missingCredentialProfile, "未找到已保存的 SSH 密码");
          }
          const missingIds = new Set(missingCredentialProfiles.map((profile) => profile.id));
          profilesToRefresh = sshProfiles.filter((profile) => !missingIds.has(profile.id));
        }

        const now = Date.now();
        profilesToRefresh = profilesToRefresh.filter((profile) => {
          const retry = overviewRetryByProfileRef.current.get(profile.id);
          const session = sessionsByProfile.get(profile.id);
          return !retry ||
            retry.contextKey !== hostOverviewRetryContext(profile, session) ||
            retry.retryAt <= now;
        });
      }

      let stopScheduling = false;
      let credentialRequested = automatic && automaticCredentialPromptRef.current !== null;
      let credentialRecoveryFailed = false;
      await runWithConcurrency(profilesToRefresh, SSH_OVERVIEW_CONCURRENCY, async (profile) => {
        if (stopScheduling) {
          return;
        }

        const error = await refreshOverview(profile, automatic, false);
        if (!error || !requiresSavedCredentialRecovery(error)) {
          return;
        }
        credentialRecoveryFailed = true;
        if (!credentialRequested) {
          credentialRequested = true;
          if (automatic) {
            automaticCredentialPromptRef.current = `error:${profile.id}:${profile.updatedAt}`;
          }
          onRequestCredential(profile, error);
        }
        if (automatic) {
          stopScheduling = true;
        }
      });
      if (automatic && !hasMissingCredentialProfiles && !credentialRecoveryFailed) {
        automaticCredentialPromptRef.current = null;
      }
    } finally {
      if (automatic) {
        automaticRefreshRunningRef.current = false;
      }
    }
  }, [onRequestCredential, refreshOverview, rememberedPasswordProfileIds, savedProfiles, sessionsByProfile]);

  const refreshAll = useCallback(() => {
    void refreshSavedOverviews();
    if (wslDiscovery.supported) {
      void refreshWsl();
    }
  }, [refreshSavedOverviews, refreshWsl, wslDiscovery.supported]);

  const openWslDistribution = useCallback(async (distribution: string) => {
    if (openingWslDistributionsRef.current.has(distribution)) {
      return;
    }

    openingWslDistributionsRef.current.add(distribution);
    setOpeningWslDistributions(new Set(openingWslDistributionsRef.current));
    try {
      await onOpenWslDistribution(distribution);
    } finally {
      openingWslDistributionsRef.current.delete(distribution);
      setOpeningWslDistributions(new Set(openingWslDistributionsRef.current));
    }
  }, [onOpenWslDistribution]);

  const autoRefreshKey = useMemo(
    () =>
      savedProfiles
        .filter((profile) => profile.type === "ssh" || profile.type === "sftp")
        .map((profile) => {
          const session = sessionsByProfile.get(profile.id);
          return [
            profile.id,
            profile.updatedAt,
            session?.connection.id ?? "",
            session?.connection.status ?? "",
            session?.connection.transport?.authenticated ? "authenticated" : "pending",
            connectingProfileIds.has(profile.id) ? "connecting" : "settled",
            rememberedPasswordProfileIds.has(profile.id) ? "credential" : "no-credential",
          ].join(":");
        })
        .join("|"),
    [connectingProfileIds, rememberedPasswordProfileIds, savedProfiles, sessionsByProfile],
  );
  const wslAutoRefreshKey = useMemo(
    () => wslDiscovery.distributions
      .map((distribution) => `${distribution.name}:${distribution.state}:${distribution.version ?? ""}`)
      .join("|"),
    [wslDiscovery.distributions],
  );

  useEffect(() => {
    mountedRef.current = true;
    const initialTimer = window.setTimeout(
      () => void refreshSavedOverviews(true),
      AUTO_REFRESH_DELAY_MS,
    );
    const refreshTimer = window.setInterval(
      () => void refreshSavedOverviews(true),
      HOST_OVERVIEW_REFRESH_INTERVAL_MS,
    );
    return () => {
      window.clearTimeout(initialTimer);
      window.clearInterval(refreshTimer);
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
    }, HOST_OVERVIEW_REFRESH_INTERVAL_MS);
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
              title={totalRefreshingCount > 0 ? "正在刷新主机概览" : "刷新全部；未连接的 SSH 主机可能需要解锁凭据"}
              type="button"
            >
              <Icon className={totalRefreshingCount > 0 ? "is-spinning" : ""} name="refresh-ccw" />
            </button>
            <button aria-label="新建连接" className="saved-create-button" onClick={onCreateProfile} type="button">
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
                      opening={openingWslDistributions.has(distribution.name)}
                      onOpen={openWslDistribution}
                      onOpenFiles={onOpenWslFiles}
                      onRefresh={() => distribution.state === "running" ? refreshWslOverview(distribution) : refreshWsl()}
                      refreshing={wslRefreshing}
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
                const isConnecting = connectingProfileIds.has(profile.id);
                const session = sessionsByProfile.get(profile.id);
                const isSessionConnected = Boolean(session?.connection.transport?.authenticated);
                const overviewState = overviewByProfile[profile.id];
                const isReachable = Boolean(overviewState?.data || isSessionConnected);
                const tabId = session ? session.id ?? session.connection.id : null;
                const isSshProfile = profile.type === "ssh" || profile.type === "sftp";
                const supportsFileTransfer = isSshProfile || Boolean(session?.connection.capabilities.fileTransfer);
                const canOpenFileTransfer = supportsFileTransfer && (isSessionConnected || Boolean(overviewState?.data));
                const overviewStatus = isConnecting || overviewState?.loading
                  ? "connecting"
                  : isReachable
                    ? "online"
                    : overviewState?.error
                      ? "error"
                      : "idle";
                const overviewStatusLabel = overviewStatus === "connecting"
                  ? "检测中"
                  : overviewStatus === "online"
                    ? `可达${overviewState?.data ? ` · ${overviewState.data.latencyMs} ms` : ""}`
                    : overviewStatus === "error"
                      ? "不可达"
                      : "未检测";
                const overviewStatusIcon: IconName = overviewStatus === "error"
                    ? "plug"
                    : overviewStatus === "connecting"
                      ? "activity"
                      : "minus";

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
                        <span title={profileTarget(profile)}>{profileCardSubtitle(profile)}</span>
                      </div>
                      <button
                        aria-label={`${overviewStatusLabel}，刷新 ${profile.name || profileTarget(profile)} 的主机概览`}
                        className={["saved-card-status-button", overviewStatus].join(" ")}
                        disabled={!isSshProfile || overviewState?.loading}
                        onClick={(event) => {
                          event.stopPropagation();
                          void refreshOverview(profile);
                        }}
                        title={isSshProfile ? `${overviewStatusLabel} · 点击刷新` : "该协议不支持 SSH 主机概览"}
                        type="button"
                      >
                        <span className="saved-card-status-content">
                          {overviewStatus === "online" ? (
                            <span className="saved-card-status-latency">
                              {overviewState?.data ? formatLatencyBadge(overviewState.data.latencyMs) : "—"}
                            </span>
                          ) : (
                            <Icon name={overviewStatusIcon} />
                          )}
                        </span>
                      </button>
                    </div>

                    <HostOverviewPanel profile={profile} state={overviewState} />

                    <div className="saved-card-footer">
                      <button
                        aria-busy={isConnecting}
                        className="saved-card-primary"
                        disabled={isConnecting}
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
                        <Icon className={isConnecting ? "is-spinning" : ""} name={isConnecting ? "refresh-ccw" : "terminal"} />
                        <span>{isConnecting ? "正在连接…" : tabId && isSessionConnected ? "打开终端" : "新建终端"}</span>
                      </button>
                      <button
                        aria-label={`打开 ${profile.name} 的文件管理`}
                        className="saved-card-round-action"
                        disabled={isConnecting || !canOpenFileTransfer}
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
                          disabled={isConnecting}
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
              <button onClick={onCreateProfile} type="button"><Icon name="plus" />新建连接</button>
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
  onRefresh,
  overview,
  opening,
  refreshing,
}: {
  activeSessions: number;
  distribution: WslDistributionInfo;
  index: number;
  onOpen: (distribution: string) => Promise<void>;
  onOpenFiles: (distribution: string) => void;
  onRefresh: () => Promise<unknown>;
  overview: WslOverviewState | undefined;
  opening: boolean;
  refreshing: boolean;
}) {
  const versionLabel = distribution.version ? `WSL ${distribution.version}` : "WSL";
  const overviewStatus = overview?.loading || refreshing
    ? "connecting"
    : distribution.state === "running" && overview?.data
      ? "online"
      : distribution.state === "running" && overview?.error
        ? "error"
        : distribution.state === "stopped"
          ? "offline"
          : distribution.state === "running"
            ? "connecting"
            : "idle";
  const overviewStatusLabel = overviewStatus === "online"
    ? `运行中 · ${overview?.data?.latencyMs ?? 0} ms`
    : overviewStatus === "connecting"
      ? "检测中"
      : overviewStatus === "error"
        ? "资源获取失败"
        : overviewStatus === "offline"
          ? "已停止"
          : "状态未知";
  const overviewStatusIcon: IconName = overviewStatus === "error" || overviewStatus === "offline"
    ? "plug"
    : overviewStatus === "connecting"
      ? "activity"
      : "minus";
  const subtitle = [
    versionLabel,
    distribution.isDefault ? "默认" : null,
    activeSessions > 0 ? `${activeSessions} 会话` : null,
  ].filter(Boolean).join(" · ");

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
          <span>{subtitle}</span>
        </div>
        <button
          aria-label={`${overviewStatusLabel}，刷新 ${distribution.name} 状态`}
          className={["saved-card-status-button", "wsl-card-status-button", overviewStatus].join(" ")}
          disabled={overview?.loading || refreshing}
          onClick={() => void onRefresh()}
          title={`${overviewStatusLabel} · 点击刷新`}
          type="button"
        >
          <span className="saved-card-status-content">
            {overviewStatus === "online" ? (
              <span className="saved-card-status-latency">
                {overview?.data ? formatLatencyBadge(overview.data.latencyMs) : "—"}
              </span>
            ) : (
              <Icon name={overviewStatusIcon} />
            )}
          </span>
        </button>
      </div>

      <WslOverviewPanel distribution={distribution} state={overview} />

      <div className="wsl-card-actions">
        <button
          aria-busy={opening}
          className="wsl-card-open"
          disabled={opening}
          onClick={() => void onOpen(distribution.name)}
          type="button"
        >
          <Icon className={opening ? "is-spinning" : ""} name={opening ? "refresh-ccw" : "terminal"} />
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
      <div className="saved-card-overview wsl-card-overview">
        <div className="saved-card-metrics">
          <Metric label="CPU" value="—" />
          <Metric label="内存" value="—" />
          <Metric label="磁盘" value="—" />
          <Metric label="运行" value="—" />
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
          <Metric label="CPU" value={cpuPercent === null ? "—" : `${cpuPercent}%`} detail={overview.cpuCount ? `${overview.cpuCount} 核` : undefined} progress={cpuPercent} />
          <Metric
            label="内存"
            value={formatBytes(overview.memoryUsedBytes)}
            detail={formatCapacityTotal(overview.memoryTotalBytes)}
            progress={memoryPercent}
          />
          <Metric
            label="磁盘"
            value={formatBytes(overview.diskUsedBytes)}
            detail={formatCapacityTotal(overview.diskTotalBytes)}
            progress={diskPercent}
          />
          <Metric label="运行" value={formatUptimeDays(overview.uptimeSeconds)} detail={state.loading ? "刷新中" : undefined} />
        </div>
        <div className={["saved-card-system", state.error ? "error" : ""].filter(Boolean).join(" ")} title={state.error ?? `${overview.operatingSystem} · ${overview.kernelVersion}`}>
          <Icon name="activity" />
          <span>{overview.operatingSystem}</span>
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
    const diskPercent = usagePercent(overview.diskUsedBytes, overview.diskTotalBytes);

    return (
      <div className="saved-card-overview">
        <div className="saved-card-metrics">
          <Metric label="负载" value={overview.cpuLoad1 === null ? "—" : overview.cpuLoad1.toFixed(2)} detail={overview.cpuCount ? `${overview.cpuCount} 核` : undefined} />
          <Metric
            label="内存"
            value={formatBytes(overview.memoryUsedBytes)}
            detail={formatCapacityTotal(overview.memoryTotalBytes)}
            progress={memoryPercent}
          />
          <Metric
            label="磁盘"
            value={formatBytes(overview.diskUsedBytes)}
            detail={formatCapacityTotal(overview.diskTotalBytes)}
            progress={diskPercent}
          />
          <Metric label="运行" value={formatUptimeDays(overview.uptimeSeconds)} detail={state.loading ? "刷新中" : undefined} />
        </div>
        <div className="saved-card-system" title={`${overview.operatingSystem} · ${overview.kernelVersion}`}>
          <Icon name="activity" />
          <span>{overview.operatingSystem}</span>
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
  detail?: string;
  label: string;
  progress?: number | null;
  value: string;
}) {
  return (
    <div className="saved-metric" title={`${label}：${value}${detail ? ` ${detail}` : ""}`}>
      <span>{label}</span>
      <strong>{value}</strong>
      {typeof progress === "number" ? (
        <span className="saved-metric-progress" aria-label={`${label}使用率 ${progress}%`} role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={progress}>
          <i style={{ width: `${progress}%` }} />
        </span>
      ) : null}
      {detail ? <small>{detail}</small> : null}
    </div>
  );
}

function usagePercent(used: number | null, total: number | null) {
  return used !== null && total
    ? Math.min(100, Math.max(0, Math.round((used / total) * 100)))
    : null;
}

function formatCapacityTotal(total: number | null) {
  return total === null ? undefined : `/ ${formatBytes(total)}`;
}

function formatLatencyBadge(value: number) {
  return String(Math.round(value));
}

function profileCardSubtitle(profile: ConnectionProfile) {
  if ((profile.type === "ssh" || profile.type === "sftp") && profile.name.trim() === profile.host.trim()) {
    return [profile.username.trim(), String(profile.port)].filter(Boolean).join(" · ");
  }

  return profileTarget(profile);
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

function hostOverviewRetryContext(
  profile: ConnectionProfile,
  session: WorkspaceSessionTab | undefined,
) {
  return [
    profile.updatedAt,
    session?.connection.id ?? "",
    session?.connection.transport?.authenticated ? "authenticated" : "pending",
  ].join(":");
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(() => reject(new Error(message)), timeoutMs);
    promise.then(
      (value) => {
        window.clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        window.clearTimeout(timer);
        reject(error);
      },
    );
  });
}
