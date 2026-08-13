import { useEffect, useState } from "react";
import {
  networkProxyPasswordDelete,
  networkProxyPasswordSet,
  networkProxyPasswordStatus,
} from "../../shared/ipc/commands";
import type { AppSettings } from "../../shared/types";
import { Select, TextInput, Toggle } from "../../shared/ui";
import { SettingsSectionHeader } from "./SettingsSection";

interface NetworkSettingsProps {
  settings: AppSettings;
  onSaveSettings: (settings: AppSettings) => void;
}

type ProxyMode = AppSettings["network"]["proxy"]["mode"];

const proxyModes: Array<{ label: string; value: ProxyMode }> = [
  { value: "none", label: "不使用代理" },
  { value: "http", label: "HTTP" },
  { value: "socks5", label: "SOCKS5" },
  { value: "browser", label: "系统代理" },
];

export function NetworkSettings({ onSaveSettings, settings }: NetworkSettingsProps) {
  const proxy = settings.network.proxy;
  const [modeDraft, setModeDraft] = useState<ProxyMode>(proxy.mode);
  const [hostDraft, setHostDraft] = useState(proxy.host);
  const [portDraft, setPortDraft] = useState(String(proxy.port));
  const [usernameDraft, setUsernameDraft] = useState(proxy.username);
  const [passwordDraft, setPasswordDraft] = useState("");
  const [passwordSaved, setPasswordSaved] = useState(false);
  const [credentialBusy, setCredentialBusy] = useState(false);
  const [credentialMessage, setCredentialMessage] = useState("");
  const proxyEnabled = modeDraft !== "none";
  const customProxy = modeDraft === "http" || modeDraft === "socks5";

  useEffect(() => setModeDraft(proxy.mode), [proxy.mode]);
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
      .catch(() => undefined);
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
      setCredentialMessage("请输入代理地址。");
      return;
    }
    setHostDraft(host);
    setCredentialMessage("");
    if (host !== proxy.host) {
      updateProxy({ host });
    }
  };

  const commitPort = () => {
    const port = Number.parseInt(portDraft, 10);
    if (!Number.isFinite(port) || port < 1 || port > 65535) {
      setPortDraft(String(proxy.port));
      setCredentialMessage("端口范围为 1–65535。");
      return;
    }
    setPortDraft(String(port));
    setCredentialMessage("");
    if (port !== proxy.port) {
      updateProxy({ port });
    }
  };

  const commitUsername = () => {
    const username = usernameDraft.trim();
    const authenticationEnabled = proxyEnabled && (Boolean(username) || passwordSaved);
    setUsernameDraft(username);
    setCredentialMessage("");
    if (username !== proxy.username || authenticationEnabled !== proxy.authenticationEnabled) {
      updateProxy({ authenticationEnabled, username });
    }
  };

  const commitPassword = async () => {
    if (!passwordDraft || credentialBusy) {
      return;
    }

    setCredentialBusy(true);
    setCredentialMessage("");
    try {
      await networkProxyPasswordSet(passwordDraft);
      setPasswordSaved(true);
      setPasswordDraft("");
      if (!proxy.authenticationEnabled) {
        updateProxy({ authenticationEnabled: true, username: usernameDraft.trim() });
      }
    } catch {
      setCredentialMessage("代理密码保存失败。");
    } finally {
      setCredentialBusy(false);
    }
  };

  const clearPassword = async () => {
    setCredentialBusy(true);
    setCredentialMessage("");
    try {
      await networkProxyPasswordDelete();
      setPasswordSaved(false);
      setPasswordDraft("");
      updateProxy({ authenticationEnabled: Boolean(usernameDraft.trim()) });
    } catch {
      setCredentialMessage("代理密码清除失败。");
    } finally {
      setCredentialBusy(false);
    }
  };

  return (
    <div className="network-settings">
      <section className="settings-block network-settings-block network-proxy-form-block">
        <SettingsSectionHeader title="网络设置" />
        <div className="network-proxy-form">
          <div className="network-proxy-row">
            <span>类型</span>
            <Select
              aria-label="代理类型"
              options={proxyModes}
              value={modeDraft}
              onChange={(value) => {
                setModeDraft(value);
                setCredentialMessage("");
                updateProxy({
                  authenticationEnabled: value !== "none" && proxy.authenticationEnabled,
                  mode: value,
                });
              }}
            />
          </div>
          <label className="network-proxy-row">
            <span>地址</span>
            <TextInput
              aria-label="代理地址"
              disabled={!customProxy}
              placeholder={customProxy ? "127.0.0.1" : ""}
              value={customProxy ? hostDraft : ""}
              onBlur={commitHost}
              onChange={(event) => setHostDraft(event.currentTarget.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.currentTarget.blur();
                }
              }}
            />
          </label>
          <label className="network-proxy-row">
            <span>端口</span>
            <TextInput
              aria-label="代理端口"
              disabled={!customProxy}
              inputMode="numeric"
              max="65535"
              min="1"
              placeholder={customProxy ? "7890" : ""}
              type="number"
              value={customProxy ? portDraft : ""}
              onBlur={commitPort}
              onChange={(event) => setPortDraft(event.currentTarget.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.currentTarget.blur();
                }
              }}
            />
          </label>
          <label className="network-proxy-row">
            <span>用户名</span>
            <TextInput
              aria-label="代理用户名"
              autoComplete="username"
              disabled={!proxyEnabled}
              placeholder={proxyEnabled ? "可选" : ""}
              value={proxyEnabled ? usernameDraft : ""}
              onBlur={commitUsername}
              onChange={(event) => setUsernameDraft(event.currentTarget.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.currentTarget.blur();
                }
              }}
            />
          </label>
          <label className="network-proxy-row">
            <span>密码</span>
            <span className="network-proxy-password">
              <TextInput
                aria-label="代理密码"
                autoComplete="new-password"
                disabled={!proxyEnabled || credentialBusy}
                placeholder={proxyEnabled ? (passwordSaved ? "已保存" : "可选") : ""}
                type="password"
                value={passwordDraft}
                onBlur={() => void commitPassword()}
                onChange={(event) => setPasswordDraft(event.currentTarget.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.currentTarget.blur();
                  }
                }}
              />
              {proxyEnabled && passwordSaved && !passwordDraft ? (
                <button
                  className="network-proxy-clear"
                  disabled={credentialBusy}
                  onClick={() => void clearPassword()}
                  type="button"
                >
                  清除
                </button>
              ) : null}
            </span>
          </label>
        </div>
        {credentialMessage ? <p className="proxy-credential-message" role="alert">{credentialMessage}</p> : null}
      </section>

      <section className="settings-block network-settings-block connection-security-settings-block">
        <SettingsSectionHeader title="安全提示" />
        <div className="settings-toggle-grid">
          <Toggle
            checked={settings.security.allowInsecureWithoutWarning}
            label="不提示非加密协议风险"
            onChange={(event) =>
              onSaveSettings({
                ...settings,
                security: { ...settings.security, allowInsecureWithoutWarning: event.currentTarget.checked },
              })
            }
          />
        </div>
      </section>
    </div>
  );
}
