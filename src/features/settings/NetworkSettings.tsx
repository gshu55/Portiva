import { useEffect, useState } from "react";
import {
  networkProxyPasswordDelete,
  networkProxyPasswordSet,
  networkProxyPasswordStatus,
} from "../../shared/ipc/commands";
import type { AppSettings } from "../../shared/types";
import { Button, TextInput, Toggle } from "../../shared/ui";
import { SettingsSectionHeader } from "./SettingsSection";

interface NetworkSettingsProps {
  settings: AppSettings;
  onSaveSettings: (settings: AppSettings) => void;
}

type ProxyMode = AppSettings["network"]["proxy"]["mode"];

const proxyModes: Array<{ description: string; label: string; value: ProxyMode }> = [
  { value: "none", label: "不使用代理", description: "所有远程连接直接访问目标地址。" },
  { value: "http", label: "HTTP 代理", description: "HTTP 请求和 TCP 隧道使用 HTTP CONNECT。" },
  { value: "socks5", label: "SOCKS5 代理", description: "通过 SOCKS5 转发域名解析和远程连接。" },
  { value: "browser", label: "使用浏览器代理", description: "读取操作系统当前的浏览器或系统代理。" },
];

export function NetworkSettings({ onSaveSettings, settings }: NetworkSettingsProps) {
  const proxy = settings.network.proxy;
  const [hostDraft, setHostDraft] = useState(proxy.host);
  const [portDraft, setPortDraft] = useState(String(proxy.port));
  const [usernameDraft, setUsernameDraft] = useState(proxy.username);
  const [passwordDraft, setPasswordDraft] = useState("");
  const [passwordSaved, setPasswordSaved] = useState(false);
  const [credentialBusy, setCredentialBusy] = useState(false);
  const [credentialMessage, setCredentialMessage] = useState("");
  const customProxy = proxy.mode === "http" || proxy.mode === "socks5";
  const proxyEnabled = proxy.mode !== "none";

  useEffect(() => setHostDraft(proxy.host), [proxy.host]);
  useEffect(() => setPortDraft(String(proxy.port)), [proxy.port]);
  useEffect(() => setUsernameDraft(proxy.username), [proxy.username]);
  useEffect(() => {
    let active = true;
    void networkProxyPasswordStatus()
      .then((saved) => {
        if (active) {
          setPasswordSaved(saved);
        }
      })
      .catch((error: unknown) => {
        if (active) {
          setCredentialMessage(String(error));
        }
      });
    return () => {
      active = false;
    };
  }, []);

  const updateProxy = (value: Partial<AppSettings["network"]["proxy"]>) => {
    onSaveSettings({
      ...settings,
      network: { ...settings.network, proxy: { ...proxy, ...value } },
    });
  };
  const commitHost = () => {
    const host = hostDraft.trim();
    if (!host) {
      setHostDraft(proxy.host);
      return;
    }
    if (host !== proxy.host) {
      updateProxy({ host });
    }
  };
  const commitPort = () => {
    const parsed = Number.parseInt(portDraft, 10);
    const port = Number.isFinite(parsed) ? Math.min(65535, Math.max(1, parsed)) : proxy.port;
    setPortDraft(String(port));
    if (port !== proxy.port) {
      updateProxy({ port });
    }
  };
  const commitUsername = () => {
    const username = usernameDraft.trim();
    setUsernameDraft(username);
    if (username !== proxy.username) {
      updateProxy({ username });
    }
  };
  const savePassword = async () => {
    if (!passwordDraft) {
      setCredentialMessage("请输入代理密码。");
      return;
    }
    setCredentialBusy(true);
    setCredentialMessage("");
    try {
      await networkProxyPasswordSet(passwordDraft);
      setPasswordDraft("");
      setPasswordSaved(true);
      setCredentialMessage("代理密码已安全保存到系统凭据库。");
    } catch (error) {
      setCredentialMessage(String(error));
    } finally {
      setCredentialBusy(false);
    }
  };
  const deletePassword = async () => {
    setCredentialBusy(true);
    setCredentialMessage("");
    try {
      await networkProxyPasswordDelete();
      setPasswordDraft("");
      setPasswordSaved(false);
      setCredentialMessage("已清除保存的代理密码。");
    } catch (error) {
      setCredentialMessage(String(error));
    } finally {
      setCredentialBusy(false);
    }
  };
  const activeMode = proxyModes.find((item) => item.value === proxy.mode) ?? proxyModes[0];
  const endpoint = customProxy
    ? `${proxy.host}:${proxy.port}`
    : proxy.mode === "browser"
      ? "跟随系统"
      : "直接连接";

  return (
    <div className="network-settings">
      <section className="settings-block network-settings-block">
        <SettingsSectionHeader
          description="软件更新、HTTP、SSH/SFTP、Telnet 和 Raw TCP 共用同一代理策略。"
          meta={activeMode.label}
          title="全局网络代理"
        />
        <div className="proxy-mode-options" role="radiogroup" aria-label="全局网络代理模式">
          {proxyModes.map((option) => (
            <Button
              active={proxy.mode === option.value}
              aria-checked={proxy.mode === option.value}
              key={option.value}
              onClick={() => updateProxy({ mode: option.value })}
              role="radio"
              tone="muted"
            >
              <strong>{option.label}</strong>
              <span>{option.description}</span>
            </Button>
          ))}
        </div>
      </section>

      <section className="settings-block network-settings-block">
        <SettingsSectionHeader
          description={customProxy ? "代理地址修改后会立即应用到新建连接。" : "选择 HTTP 或 SOCKS5 后可编辑代理地址。"}
          title="代理服务器"
        />
        <div className="proxy-endpoint-grid" aria-disabled={!customProxy}>
          <label className="settings-field">
            <span>主机地址</span>
            <TextInput
              disabled={!customProxy}
              leadingIcon="network"
              placeholder="127.0.0.1"
              value={hostDraft}
              onBlur={commitHost}
              onChange={(event) => setHostDraft(event.currentTarget.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.currentTarget.blur();
                }
              }}
            />
          </label>
          <label className="settings-field compact">
            <span>端口</span>
            <TextInput
              disabled={!customProxy}
              inputMode="numeric"
              max="65535"
              min="1"
              type="number"
              value={portDraft}
              onBlur={commitPort}
              onChange={(event) => setPortDraft(event.currentTarget.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.currentTarget.blur();
                }
              }}
            />
          </label>
        </div>
        <div className="proxy-authentication" aria-disabled={!proxyEnabled}>
          <Toggle
            checked={proxy.authenticationEnabled}
            disabled={!proxyEnabled}
            description="支持 HTTP Basic 与 SOCKS5 用户名/密码认证，密码由系统凭据库保护。"
            label="代理服务器需要登录"
            onChange={(event) => updateProxy({ authenticationEnabled: event.currentTarget.checked })}
          />
          {proxy.authenticationEnabled && proxyEnabled ? (
            <div className="proxy-credential-fields">
              <label className="settings-field">
                <span>用户名</span>
                <TextInput
                  autoComplete="username"
                  placeholder="代理用户名"
                  value={usernameDraft}
                  onBlur={commitUsername}
                  onChange={(event) => setUsernameDraft(event.currentTarget.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      event.currentTarget.blur();
                    }
                  }}
                />
              </label>
              <label className="settings-field">
                <span>密码</span>
                <TextInput
                  autoComplete="new-password"
                  placeholder={passwordSaved ? "已保存；输入可替换" : "输入代理密码"}
                  type="password"
                  value={passwordDraft}
                  onChange={(event) => setPasswordDraft(event.currentTarget.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      void savePassword();
                    }
                  }}
                />
              </label>
              <div className="proxy-credential-actions">
                <Button disabled={credentialBusy || !passwordDraft} onClick={() => void savePassword()} tone="primary">
                  {credentialBusy ? "处理中" : passwordSaved ? "更新密码" : "保存密码"}
                </Button>
                {passwordSaved ? (
                  <Button disabled={credentialBusy} onClick={() => void deletePassword()} tone="muted">
                    清除密码
                  </Button>
                ) : null}
                <span className={passwordSaved ? "is-saved" : undefined}>
                  {passwordSaved ? "密码已保存" : "尚未保存密码"}
                </span>
              </div>
              {credentialMessage ? <p className="proxy-credential-message">{credentialMessage}</p> : null}
            </div>
          ) : null}
        </div>
        <div className={`proxy-summary is-${proxy.mode}`}>
          <span aria-hidden="true" className="proxy-summary-indicator" />
          <div>
            <strong>{activeMode.label}</strong>
            <span>
              {endpoint}
              {proxyEnabled && proxy.authenticationEnabled ? ` · ${proxy.username || "未填写用户名"}` : ""}
            </span>
          </div>
        </div>
      </section>

      <section className="settings-block network-settings-block">
        <SettingsSectionHeader title="直连范围" />
        <p className="network-settings-note">
          局域网扫描、Ping 探测和本地串口始终直连，不经过代理；密码不会写入设置文件。浏览器代理模式读取系统代理地址，登录凭据仍由本页统一提供。
        </p>
      </section>
    </div>
  );
}
