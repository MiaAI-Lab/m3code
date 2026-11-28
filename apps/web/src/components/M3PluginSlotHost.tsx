import { T, Var, useGT } from "gt-react";
import { useEffect, useRef, useState } from "react";

const M3_PLUGIN_BRIDGE_VERSION = 1 as const;
const API_BASE = "/api/m3-plugins";

type M3PluginSlot = "sidebar-tab" | "right-panel" | "thread-toolbar" | "modal";

interface M3PluginManifest {
  readonly id: string;
  readonly name: string;
  readonly version: string;
  readonly description?: string;
  readonly runtime: { readonly type: "static" | "sidecar" };
  readonly slots: ReadonlyArray<M3PluginSlot>;
  readonly subscriptions: ReadonlyArray<string>;
}

interface M3PluginRecord {
  readonly manifest: M3PluginManifest;
  readonly enabled: boolean;
  readonly status: "active" | "disabled" | "starting" | "error";
  readonly builtin?: boolean;
  readonly entryUrl: string | null;
  readonly sidecarPort: number | null;
  readonly errorMessage?: string;
}

interface PluginListResponse {
  readonly pluginsDir: string;
  readonly plugins: ReadonlyArray<M3PluginRecord>;
}

interface BridgeCommandMessage {
  readonly version: typeof M3_PLUGIN_BRIDGE_VERSION;
  readonly type: "m3:command";
  readonly id: string;
  readonly pluginId: string;
  readonly command:
    | "plugin:ready"
    | "thread:create"
    | "prompt:inject"
    | "file:open"
    | "toast:show"
    | "plugins:list";
  readonly payload?: Record<string, unknown>;
}

const VALID_COMMANDS = new Set([
  "plugin:ready",
  "thread:create",
  "prompt:inject",
  "file:open",
  "toast:show",
  "plugins:list",
]);

function isBridgeCommand(value: unknown): value is BridgeCommandMessage {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const rec = value as Record<string, unknown>;
  return (
    rec.version === M3_PLUGIN_BRIDGE_VERSION &&
    rec.type === "m3:command" &&
    typeof rec.id === "string" &&
    typeof rec.pluginId === "string" &&
    typeof rec.command === "string" &&
    VALID_COMMANDS.has(rec.command)
  );
}

function buildBridgeEvent(eventName: string, payload: Record<string, unknown>) {
  return {
    version: M3_PLUGIN_BRIDGE_VERSION,
    type: "m3:event",
    event: eventName,
    payload,
    timestamp: new Date().toISOString(),
  };
}

/**
 * Single-line integration seam for `apps/web/src/routes/_chat.tsx`.
 * Renders sandboxed `<iframe>` slots (`sidebar-tab`, `right-panel`, `thread-toolbar`, `modal`),
 * manages the versioned `postMessage` Event Bridge, and provides a self-contained Plugin Manager.
 */
export function M3PluginSlotHost() {
  const gt = useGT();
  const [plugins, setPlugins] = useState<ReadonlyArray<M3PluginRecord>>([]);
  const [pluginsDir, setPluginsDir] = useState<string>("~/.m3/plugins");
  const [managerOpen, setManagerOpen] = useState(false);
  const [activeRightPluginId, setActiveRightPluginId] = useState<string | null>(null);
  const [activeTabPluginId, setActiveTabPluginId] = useState<string | null>(null);
  const [activeModalPluginId, setActiveModalPluginId] = useState<string | null>(null);
  const [installSource, setInstallSource] = useState("");
  const [installLink, setInstallLink] = useState(false);
  const [busy, setBusy] = useState(false);
  const [statusBanner, setStatusBanner] = useState<string | null>(null);

  const iframeRefs = useRef<Map<string, HTMLIFrameElement>>(new Map());

  const fetchPlugins = async () => {
    try {
      const response = await fetch(API_BASE, { cache: "no-store" });
      if (!response.ok) return;
      const data = (await response.json()) as PluginListResponse;
      setPlugins(data.plugins ?? []);
      if (data.pluginsDir) setPluginsDir(data.pluginsDir);
    } catch {
      // Server may still be booting.
    }
  };

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- initial plugin discovery fetch on mount
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const response = await fetch(API_BASE, { cache: "no-store" });
        if (!response.ok || cancelled) return;
        const data = (await response.json()) as PluginListResponse;
        if (cancelled) return;
        setPlugins(data.plugins ?? []);
        if (data.pluginsDir) setPluginsDir(data.pluginsDir);
      } catch {
        // Server may still be booting.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const broadcastEvent = (eventName: string, payload: Record<string, unknown>) => {
    const message = buildBridgeEvent(eventName, payload);
    for (const plugin of plugins) {
      if (!plugin.enabled) continue;
      if (
        plugin.manifest.subscriptions.length > 0 &&
        !plugin.manifest.subscriptions.includes(eventName) &&
        !plugin.manifest.subscriptions.includes("*")
      ) {
        continue;
      }
      const frame = iframeRefs.current.get(plugin.manifest.id);
      frame?.contentWindow?.postMessage(message, "*");
    }
  };

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- window postMessage listener for sandboxed plugin iframes
  useEffect(() => {
    const handleMessage = (event: MessageEvent) => {
      if (!isBridgeCommand(event.data)) return;
      const msg = event.data;
      const reply = (
        outcome:
          | { readonly ok: true; readonly result?: unknown }
          | { readonly ok: false; readonly error: string },
      ) => {
        const target = event.source as Window | null;
        target?.postMessage(
          {
            version: M3_PLUGIN_BRIDGE_VERSION,
            type: "m3:response",
            id: msg.id,
            ...outcome,
          },
          "*",
        );
      };

      switch (msg.command) {
        case "plugin:ready":
          reply({
            ok: true,
            result: {
              url: window.location.href,
              pathname: window.location.pathname,
            },
          });
          break;
        case "plugins:list":
          reply({ ok: true, result: plugins });
          break;
        case "toast:show": {
          const title = typeof msg.payload?.title === "string" ? msg.payload.title : msg.pluginId;
          const desc =
            typeof msg.payload?.description === "string" ? `: ${msg.payload.description}` : "";
          setStatusBanner(`${title}${desc}`);
          window.setTimeout(() => setStatusBanner(null), 4000);
          reply({ ok: true });
          break;
        }
        case "thread:create":
        case "prompt:inject":
        case "file:open":
          window.dispatchEvent(
            new CustomEvent(`m3-plugin:${msg.command}`, {
              detail: { pluginId: msg.pluginId, ...msg.payload },
            }),
          );
          reply({ ok: true, result: { dispatched: msg.command } });
          break;
      }
    };

    window.addEventListener("message", handleMessage);
    return () => window.removeEventListener("message", handleMessage);
  }, [plugins]);

  const activePlugins = plugins.filter((p) => p.enabled && p.entryUrl !== null);
  const pluginsForSlot = (slot: M3PluginSlot) =>
    activePlugins.filter((p) => p.manifest.slots.includes(slot));

  const toolbarPlugins = pluginsForSlot("thread-toolbar");
  const rightPanelPlugins = pluginsForSlot("right-panel");
  const sidebarTabPlugins = pluginsForSlot("sidebar-tab");
  const modalPlugins = pluginsForSlot("modal");

  const activeRightPlugin = rightPanelPlugins.find((p) => p.manifest.id === activeRightPluginId);
  const activeTabPlugin = sidebarTabPlugins.find((p) => p.manifest.id === activeTabPluginId);
  const activeModalPlugin = modalPlugins.find((p) => p.manifest.id === activeModalPluginId);

  const registerIframe = (pluginId: string) => (el: HTMLIFrameElement | null) => {
    if (el) iframeRefs.current.set(pluginId, el);
    else iframeRefs.current.delete(pluginId);
  };

  const handleInstall = async () => {
    const source = installSource.trim();
    if (!source) return;
    setBusy(true);
    try {
      const response = await fetch(`${API_BASE}/install`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ source, link: installLink }),
      });
      const json = (await response.json()) as { ok?: boolean; error?: string };
      if (!response.ok || !json.ok) {
        setStatusBanner(json.error ?? gt("Install failed"));
      } else {
        setInstallSource("");
        await fetchPlugins();
        broadcastEvent("plugins:reloaded", { source });
      }
    } catch {
      // Ignore transient network errors during install.
    }
    setBusy(false);
  };

  const handleToggle = async (pluginId: string, enabled: boolean) => {
    setBusy(true);
    try {
      await fetch(`${API_BASE}/toggle`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ pluginId, enabled }),
      });
      await fetchPlugins();
    } catch {
      // Ignore transient network errors during toggle.
    }
    setBusy(false);
  };

  const handleUninstall = async (pluginId: string) => {
    setBusy(true);
    try {
      await fetch(`${API_BASE}/uninstall`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ pluginId }),
      });
      if (activeRightPluginId === pluginId) setActiveRightPluginId(null);
      if (activeTabPluginId === pluginId) setActiveTabPluginId(null);
      if (activeModalPluginId === pluginId) setActiveModalPluginId(null);
      await fetchPlugins();
    } catch {
      // Ignore transient network errors during uninstall.
    }
    setBusy(false);
  };

  const handleReload = async () => {
    setBusy(true);
    try {
      await fetch(`${API_BASE}/reload`, { method: "POST" });
      await fetchPlugins();
      setStatusBanner(gt("Plugins reloaded"));
      window.setTimeout(() => setStatusBanner(null), 2500);
    } catch {
      // Ignore transient network errors during reload.
    }
    setBusy(false);
  };

  return (
    <>
      {statusBanner ? (
        <div
          role="status"
          style={{
            position: "fixed",
            bottom: 52,
            right: 16,
            zIndex: 70,
            maxWidth: 360,
            padding: "8px 12px",
            borderRadius: 8,
            fontSize: 12,
            background: "var(--popover, #18181b)",
            color: "var(--popover-foreground, #fafafa)",
            border: "1px solid var(--border, #27272a)",
            boxShadow: "0 8px 24px rgba(0,0,0,0.35)",
          }}
        >
          {statusBanner}
        </div>
      ) : null}

      {toolbarPlugins.length > 0 ? (
        <div
          style={{
            position: "fixed",
            top: 8,
            right: 140,
            zIndex: 45,
            display: "flex",
            gap: 6,
            alignItems: "center",
          }}
        >
          {toolbarPlugins.map((plugin) => (
            <iframe
              key={plugin.manifest.id}
              ref={registerIframe(plugin.manifest.id)}
              title={plugin.manifest.name}
              src={plugin.entryUrl ?? undefined}
              sandbox="allow-scripts allow-forms allow-same-origin"
              style={{
                height: 32,
                width: 180,
                border: "1px solid var(--border, #27272a)",
                borderRadius: 6,
                background: "transparent",
              }}
            />
          ))}
        </div>
      ) : null}

      {activeRightPlugin?.entryUrl ? (
        <aside
          aria-label={activeRightPlugin.manifest.name}
          style={{
            position: "fixed",
            top: 0,
            right: 0,
            bottom: 0,
            width: 420,
            maxWidth: "90vw",
            zIndex: 55,
            display: "flex",
            flexDirection: "column",
            background: "var(--background, #09090b)",
            borderLeft: "1px solid var(--border, #27272a)",
            boxShadow: "-8px 0 32px rgba(0,0,0,0.35)",
          }}
        >
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              padding: "8px 12px",
              borderBottom: "1px solid var(--border, #27272a)",
              fontSize: 12,
              fontWeight: 600,
            }}
          >
            <span>
              {activeRightPlugin.manifest.name} (v{activeRightPlugin.manifest.version})
            </span>
            <button
              type="button"
              onClick={() => setActiveRightPluginId(null)}
              style={{ cursor: "pointer", padding: "2px 6px", fontSize: 12 }}
            >
              ✕
            </button>
          </div>
          <iframe
            ref={registerIframe(activeRightPlugin.manifest.id)}
            title={activeRightPlugin.manifest.name}
            src={activeRightPlugin.entryUrl}
            sandbox="allow-scripts allow-forms allow-same-origin"
            style={{ flex: 1, width: "100%", border: 0 }}
          />
        </aside>
      ) : null}

      {activeTabPlugin?.entryUrl ? (
        <div
          aria-label={activeTabPlugin.manifest.name}
          style={{
            position: "fixed",
            inset: 24,
            zIndex: 60,
            display: "flex",
            flexDirection: "column",
            borderRadius: 12,
            overflow: "hidden",
            background: "var(--background, #09090b)",
            border: "1px solid var(--border, #27272a)",
            boxShadow: "0 16px 48px rgba(0,0,0,0.5)",
          }}
        >
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              padding: "10px 14px",
              borderBottom: "1px solid var(--border, #27272a)",
              fontSize: 13,
              fontWeight: 600,
            }}
          >
            <span>{activeTabPlugin.manifest.name}</span>
            <button
              type="button"
              onClick={() => setActiveTabPluginId(null)}
              style={{ cursor: "pointer", padding: "2px 8px", fontSize: 12 }}
            >
              ✕
            </button>
          </div>
          <iframe
            ref={registerIframe(activeTabPlugin.manifest.id)}
            title={activeTabPlugin.manifest.name}
            src={activeTabPlugin.entryUrl}
            sandbox="allow-scripts allow-forms allow-same-origin"
            style={{ flex: 1, width: "100%", border: 0 }}
          />
        </div>
      ) : null}

      {activeModalPlugin?.entryUrl ? (
        <div
          style={{
            position: "fixed",
            inset: 0,
            zIndex: 65,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            background: "rgba(0,0,0,0.55)",
          }}
          onClick={() => setActiveModalPluginId(null)}
        >
          <div
            style={{
              width: 640,
              maxWidth: "92vw",
              height: 480,
              maxHeight: "85vh",
              display: "flex",
              flexDirection: "column",
              borderRadius: 12,
              overflow: "hidden",
              background: "var(--background, #09090b)",
              border: "1px solid var(--border, #27272a)",
            }}
            onClick={(event) => event.stopPropagation()}
          >
            <div
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                padding: "10px 14px",
                borderBottom: "1px solid var(--border, #27272a)",
                fontSize: 13,
                fontWeight: 600,
              }}
            >
              <span>{activeModalPlugin.manifest.name}</span>
              <button
                type="button"
                onClick={() => setActiveModalPluginId(null)}
                style={{ cursor: "pointer", padding: "2px 8px", fontSize: 12 }}
              >
                ✕
              </button>
            </div>
            <iframe
              ref={registerIframe(activeModalPlugin.manifest.id)}
              title={activeModalPlugin.manifest.name}
              src={activeModalPlugin.entryUrl}
              sandbox="allow-scripts allow-forms allow-same-origin"
              style={{ flex: 1, width: "100%", border: 0 }}
            />
          </div>
        </div>
      ) : null}

      {managerOpen ? (
        <div
          style={{
            position: "fixed",
            inset: 0,
            zIndex: 68,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            background: "rgba(0,0,0,0.55)",
          }}
          onClick={() => setManagerOpen(false)}
        >
          <div
            style={{
              width: 640,
              maxWidth: "92vw",
              maxHeight: "82vh",
              overflow: "auto",
              borderRadius: 12,
              padding: 18,
              background: "var(--background, #09090b)",
              color: "var(--foreground, #fafafa)",
              border: "1px solid var(--border, #27272a)",
              boxShadow: "0 16px 48px rgba(0,0,0,0.55)",
            }}
            onClick={(event) => event.stopPropagation()}
          >
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <div>
                <h2 style={{ fontSize: 15, fontWeight: 600, margin: 0 }}>
                  <T>M3 Plugins</T>
                </h2>
                <p style={{ fontSize: 11, opacity: 0.7, margin: "2px 0 0" }}>
                  <T>
                    User-space plugins loaded from{" "}
                    <code>
                      <Var>{pluginsDir}</Var>
                    </code>
                  </T>
                </p>
              </div>
              <div style={{ display: "flex", gap: 6 }}>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void handleReload()}
                  style={{
                    fontSize: 12,
                    padding: "4px 10px",
                    borderRadius: 6,
                    border: "1px solid var(--border, #27272a)",
                    cursor: "pointer",
                  }}
                >
                  <T>Reload</T>
                </button>
                <button
                  type="button"
                  onClick={() => setManagerOpen(false)}
                  style={{ fontSize: 12, padding: "4px 8px", borderRadius: 6, cursor: "pointer" }}
                >
                  ✕
                </button>
              </div>
            </div>

            <div style={{ display: "flex", gap: 8, marginTop: 14, alignItems: "center" }}>
              <input
                value={installSource}
                onChange={(event) => setInstallSource(event.target.value)}
                placeholder={gt("Local path, git URL, or github:owner/repo")}
                disabled={busy}
                style={{
                  flex: 1,
                  fontSize: 12,
                  padding: "6px 10px",
                  borderRadius: 6,
                  border: "1px solid var(--border, #27272a)",
                  background: "transparent",
                }}
              />
              <label style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 11 }}>
                <input
                  type="checkbox"
                  checked={installLink}
                  onChange={(event) => setInstallLink(event.target.checked)}
                />
                <T>Symlink</T>
              </label>
              <button
                type="button"
                disabled={busy || installSource.trim().length === 0}
                onClick={() => void handleInstall()}
                style={{
                  fontSize: 12,
                  padding: "6px 12px",
                  borderRadius: 6,
                  border: "1px solid var(--border, #27272a)",
                  cursor: "pointer",
                }}
              >
                <T>Install</T>
              </button>
            </div>

            <div style={{ marginTop: 14, display: "flex", flexDirection: "column", gap: 8 }}>
              {plugins.length === 0 ? (
                <p style={{ fontSize: 12, opacity: 0.7, textAlign: "center", padding: "24px 0" }}>
                  <T>
                    Drop a folder with <code>plugin.json</code> into{" "}
                    <code>
                      <Var>{pluginsDir}</Var>
                    </code>{" "}
                    or install one above.
                  </T>
                </p>
              ) : (
                plugins.map((plugin) => (
                  <div
                    key={plugin.manifest.id}
                    style={{
                      padding: 10,
                      borderRadius: 8,
                      border: "1px solid var(--border, #27272a)",
                      display: "flex",
                      justifyContent: "space-between",
                      alignItems: "center",
                      gap: 12,
                    }}
                  >
                    <div style={{ minWidth: 0 }}>
                      <div style={{ fontSize: 13, fontWeight: 600 }}>
                        {plugin.manifest.name}{" "}
                        <span style={{ fontSize: 11, opacity: 0.65 }}>
                          v{plugin.manifest.version} · {plugin.manifest.runtime.type}
                          {plugin.sidecarPort ? ` :${plugin.sidecarPort}` : ""}
                        </span>
                      </div>
                      {plugin.manifest.description ? (
                        <div style={{ fontSize: 11, opacity: 0.75, marginTop: 2 }}>
                          {plugin.manifest.description}
                        </div>
                      ) : null}
                      {plugin.errorMessage ? (
                        <div style={{ fontSize: 11, color: "#f87171", marginTop: 2 }}>
                          {plugin.errorMessage}
                        </div>
                      ) : null}
                      <div style={{ fontSize: 10, opacity: 0.6, marginTop: 3 }}>
                        <T>
                          Slots: <Var>{plugin.manifest.slots.join(", ")}</Var>
                        </T>
                        {plugin.manifest.subscriptions.length > 0 ? (
                          <>
                            {" · "}
                            <T>
                              Events: <Var>{plugin.manifest.subscriptions.join(", ")}</Var>
                            </T>
                          </>
                        ) : null}
                      </div>
                    </div>
                    <div style={{ display: "flex", gap: 6, flexShrink: 0 }}>
                      {plugin.enabled && plugin.manifest.slots.includes("right-panel") ? (
                        <button
                          type="button"
                          onClick={() => {
                            setActiveRightPluginId(plugin.manifest.id);
                            setManagerOpen(false);
                          }}
                          style={{
                            fontSize: 11,
                            padding: "4px 8px",
                            borderRadius: 6,
                            border: "1px solid var(--border, #27272a)",
                            cursor: "pointer",
                          }}
                        >
                          <T>Panel</T>
                        </button>
                      ) : null}
                      {plugin.enabled && plugin.manifest.slots.includes("sidebar-tab") ? (
                        <button
                          type="button"
                          onClick={() => {
                            setActiveTabPluginId(plugin.manifest.id);
                            setManagerOpen(false);
                          }}
                          style={{
                            fontSize: 11,
                            padding: "4px 8px",
                            borderRadius: 6,
                            border: "1px solid var(--border, #27272a)",
                            cursor: "pointer",
                          }}
                        >
                          <T>Tab</T>
                        </button>
                      ) : null}
                      {plugin.enabled && plugin.manifest.slots.includes("modal") ? (
                        <button
                          type="button"
                          onClick={() => {
                            setActiveModalPluginId(plugin.manifest.id);
                            setManagerOpen(false);
                          }}
                          style={{
                            fontSize: 11,
                            padding: "4px 8px",
                            borderRadius: 6,
                            border: "1px solid var(--border, #27272a)",
                            cursor: "pointer",
                          }}
                        >
                          <T>Modal</T>
                        </button>
                      ) : null}
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => void handleToggle(plugin.manifest.id, !plugin.enabled)}
                        style={{
                          fontSize: 11,
                          padding: "4px 8px",
                          borderRadius: 6,
                          border: "1px solid var(--border, #27272a)",
                          cursor: "pointer",
                        }}
                      >
                        {plugin.enabled ? gt("Disable") : gt("Enable")}
                      </button>
                      {!plugin.builtin ? (
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => void handleUninstall(plugin.manifest.id)}
                          style={{
                            fontSize: 11,
                            padding: "4px 8px",
                            borderRadius: 6,
                            border: "1px solid var(--border, #27272a)",
                            cursor: "pointer",
                          }}
                        >
                          <T>Remove</T>
                        </button>
                      ) : null}
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>
        </div>
      ) : null}

      <button
        type="button"
        onClick={() => {
          void fetchPlugins();
          setManagerOpen((open) => !open);
        }}
        aria-label={gt("M3 Plugins")}
        style={{
          position: "fixed",
          bottom: 14,
          right: 16,
          zIndex: 50,
          display: "flex",
          alignItems: "center",
          gap: 6,
          padding: "5px 10px",
          borderRadius: 999,
          fontSize: 11,
          fontWeight: 500,
          background: "var(--popover, #18181b)",
          color: "var(--popover-foreground, #fafafa)",
          border: "1px solid var(--border, #27272a)",
          boxShadow: "0 4px 12px rgba(0,0,0,0.25)",
          cursor: "pointer",
        }}
      >
        <span>
          <T>Plugins</T>
        </span>
        {activePlugins.length > 0 ? (
          <span
            style={{
              padding: "0 5px",
              borderRadius: 999,
              fontSize: 10,
              background: "var(--muted, #27272a)",
            }}
          >
            {activePlugins.length}
          </span>
        ) : null}
      </button>
    </>
  );
}
