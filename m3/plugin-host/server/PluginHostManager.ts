// @effect-diagnostics nodeBuiltinImport:off globalTimers:off globalDate:off globalFetch:off -- standalone M3 plugin host manages ~/.m3/plugins, sidecar processes, and dynamic localhost ports outside Effect core.
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeNet from "node:net";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import { createBridgeEvent, type M3BridgeEventMessage } from "../bridgeProtocol.ts";
import {
  sanitizePluginId,
  validatePluginManifest,
  type M3PluginManifest,
  type M3PluginRecord,
} from "../manifest.ts";

interface PersistedPluginStateEntry {
  readonly enabled?: boolean;
  readonly installedAt?: string;
  readonly sourceUrl?: string;
}

interface PersistedPluginsState {
  readonly plugins: Record<string, PersistedPluginStateEntry>;
}

interface RunningSidecar {
  readonly pluginId: string;
  readonly port: number;
  readonly child: NodeChildProcess.ChildProcess;
  readonly startedAt: number;
  lastError?: string;
}

export interface PluginHostOptions {
  /** Override base M3 home directory (defaults to M3CODE_HOME or ~/.m3). */
  readonly m3HomeDir?: string;
  /**
   * Optional directories containing bundled native plugins (defaults to `m3/plugins/`).
   * Pass `[]` to disable built-in plugin discovery in isolated tests.
   */
  readonly builtinPluginsDirs?: ReadonlyArray<string>;
}

const EMPTY_STATE: PersistedPluginsState = { plugins: {} };

const MIME_TYPES: Readonly<Record<string, string>> = {
  ".html": "text/html; charset=utf-8",
  ".htm": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
};

function resolveDefaultM3Home(): string {
  const envHome = process.env.M3CODE_HOME?.trim();
  if (envHome && envHome.length > 0) {
    return NodePath.resolve(envHome.replace(/^~(?=\/|$)/, NodeOS.homedir()));
  }
  return NodePath.join(NodeOS.homedir(), ".m3");
}

function allocateLoopbackPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = NodeNet.createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close(() => reject(new Error("Could not allocate loopback port.")));
        return;
      }
      const { port } = address;
      server.close((err) => {
        if (err) reject(err);
        else resolve(port);
      });
    });
  });
}

function isGitSource(source: string): boolean {
  return (
    source.startsWith("github:") ||
    source.startsWith("https://") ||
    source.startsWith("http://") ||
    source.startsWith("git@") ||
    source.startsWith("ssh://") ||
    source.endsWith(".git")
  );
}

function normalizeGitUrl(source: string): string {
  if (source.startsWith("github:")) {
    return `https://github.com/${source.slice("github:".length).replace(/^\/+|\/+$/g, "")}.git`;
  }
  return source;
}

function inferIdFromSource(source: string): string {
  const cleaned = source.replace(/\/+$/, "").replace(/\.git$/i, "");
  const lastSegment =
    cleaned
      .split(/[/:\\]/)
      .filter(Boolean)
      .at(-1) ?? "plugin";
  return sanitizePluginId(lastSegment);
}

function runGitClone(url: string, targetDir: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = NodeChildProcess.spawn("git", ["clone", "--depth", "1", url, targetDir], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(stderr.trim() || `git clone exited with code ${code ?? -1}`));
    });
  });
}

const DEFAULT_BUILTIN_PLUGINS_DIR = NodePath.resolve(
  NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)),
  "../../plugins",
);

export class PluginHostManager {
  readonly m3HomeDir: string;
  readonly pluginsDir: string;
  readonly builtinPluginsDirs: ReadonlyArray<string>;
  readonly statePath: string;

  private readonly sidecars = new Map<string, RunningSidecar>();
  private readonly sidecarErrors = new Map<string, string>();
  private readonly eventSubscribers = new Set<(event: M3BridgeEventMessage) => void>();

  constructor(options: PluginHostOptions = {}) {
    this.m3HomeDir = options.m3HomeDir
      ? NodePath.resolve(options.m3HomeDir)
      : resolveDefaultM3Home();
    this.pluginsDir = NodePath.join(this.m3HomeDir, "plugins");
    this.builtinPluginsDirs =
      options.builtinPluginsDirs !== undefined
        ? options.builtinPluginsDirs.map((dir) => NodePath.resolve(dir))
        : [DEFAULT_BUILTIN_PLUGINS_DIR];
    this.statePath = NodePath.join(this.m3HomeDir, "userdata", "plugins-state.json");
  }

  private async readState(): Promise<PersistedPluginsState> {
    try {
      const raw = await NodeFSP.readFile(this.statePath, "utf8");
      const parsed = JSON.parse(raw) as Partial<PersistedPluginsState>;
      return {
        plugins: parsed.plugins && typeof parsed.plugins === "object" ? parsed.plugins : {},
      };
    } catch {
      return EMPTY_STATE;
    }
  }

  private async writeState(state: PersistedPluginsState): Promise<void> {
    await NodeFSP.mkdir(NodePath.dirname(this.statePath), { recursive: true });
    await NodeFSP.writeFile(this.statePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  }

  subscribeEvents(listener: (event: M3BridgeEventMessage) => void): () => void {
    this.eventSubscribers.add(listener);
    return () => {
      this.eventSubscribers.delete(listener);
    };
  }

  publishEvent(eventName: string, payload: Record<string, unknown>): M3BridgeEventMessage {
    const message = createBridgeEvent(eventName, payload);
    for (const listener of this.eventSubscribers) {
      try {
        listener(message);
      } catch {
        // Isolate subscriber errors.
      }
    }
    return message;
  }

  private async ensureSidecarRunning(
    manifest: M3PluginManifest,
    rootDir: string,
  ): Promise<RunningSidecar | undefined> {
    if (manifest.runtime.type !== "sidecar") return undefined;

    const existing = this.sidecars.get(manifest.id);
    if (existing && existing.child.exitCode === null && !existing.child.killed) {
      return existing;
    }

    const port = await allocateLoopbackPort();
    // Desktop runs the server as Electron with ELECTRON_RUN_AS_NODE=1, and GUI sessions often
    // have no `node` on PATH, so reuse our own binary in node mode for "node" sidecars.
    const useOwnNode = manifest.runtime.command === "node";
    const resolvedCommand = useOwnNode ? process.execPath : manifest.runtime.command;
    const dataDir = NodePath.join(this.m3HomeDir, "userdata", "plugins", manifest.id);
    const child = NodeChildProcess.spawn(resolvedCommand, [...manifest.runtime.args], {
      cwd: rootDir,
      env: {
        ...process.env,
        ...manifest.runtime.env,
        PORT: String(port),
        M3_PLUGIN_PORT: String(port),
        M3_PLUGIN_ID: manifest.id,
        M3_PLUGIN_DIR: rootDir,
        M3_HOME_DIR: this.m3HomeDir,
        M3_PLUGIN_DATA_DIR: dataDir,
        ...(useOwnNode && "electron" in process.versions ? { ELECTRON_RUN_AS_NODE: "1" } : {}),
      },
      stdio: ["ignore", "pipe", "pipe"],
    });

    const running: RunningSidecar = {
      pluginId: manifest.id,
      port,
      child,
      startedAt: Date.now(),
    };
    this.sidecars.set(manifest.id, running);
    this.sidecarErrors.delete(manifest.id);

    let stderrTail = "";
    child.stderr?.on("data", (chunk: Buffer) => {
      stderrTail = `${stderrTail}${chunk.toString("utf8")}`.slice(-2000);
    });
    child.on("error", (err) => {
      this.sidecarErrors.set(manifest.id, err.message);
      this.sidecars.delete(manifest.id);
    });
    child.on("exit", (code) => {
      if (code !== null && code !== 0) {
        this.sidecarErrors.set(
          manifest.id,
          stderrTail.trim() || `Sidecar exited with code ${code}`,
        );
      }
      if (this.sidecars.get(manifest.id)?.child === child) {
        this.sidecars.delete(manifest.id);
      }
    });

    // Brief startup settle wait so fast sidecars are listening before first proxy call.
    const healthPath = manifest.runtime.healthPath ?? "/";
    const deadline = Date.now() + 2500;
    while (Date.now() < deadline && child.exitCode === null) {
      try {
        const response = await fetch(`http://127.0.0.1:${port}${healthPath}`, {
          signal: AbortSignal.timeout(300),
        });
        if (response.status < 500) break;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 60));
      }
    }

    return this.sidecars.get(manifest.id);
  }

  async stopSidecar(pluginId: string): Promise<void> {
    const running = this.sidecars.get(pluginId);
    if (!running) return;
    this.sidecars.delete(pluginId);
    try {
      running.child.kill("SIGTERM");
    } catch {
      // Ignore already exited processes.
    }
  }

  async shutdown(): Promise<void> {
    const ids = [...this.sidecars.keys()];
    await Promise.all(ids.map((id) => this.stopSidecar(id)));
  }

  private async scanPluginDirectory(
    dir: string,
    builtin: boolean,
    state: PersistedPluginsState,
  ): Promise<ReadonlyArray<M3PluginRecord>> {
    let entries: string[] = [];
    try {
      entries = await NodeFSP.readdir(dir);
    } catch {
      return [];
    }

    const visible = entries.filter((entry) => !entry.startsWith("."));
    const records = await Promise.all(
      visible.map(async (entry): Promise<M3PluginRecord | undefined> => {
        const rootDir = NodePath.join(dir, entry);
        let isSymlink = false;
        try {
          const lstat = await NodeFSP.lstat(rootDir);
          isSymlink = lstat.isSymbolicLink();
          const stat = isSymlink ? await NodeFSP.stat(rootDir) : lstat;
          if (!stat.isDirectory()) return undefined;
        } catch {
          return undefined;
        }

        const manifestPath = NodePath.join(rootDir, "plugin.json");
        let parsedJson: unknown;
        try {
          parsedJson = JSON.parse(await NodeFSP.readFile(manifestPath, "utf8"));
        } catch {
          return undefined;
        }

        const validated = validatePluginManifest(parsedJson, entry);
        if (!validated.ok) {
          return {
            manifest: {
              id: sanitizePluginId(entry),
              name: entry,
              version: "0.0.0",
              runtime: { type: "static", entry: "index.html" },
              slots: ["right-panel"],
              subscriptions: [],
            },
            rootDir,
            enabled: false,
            status: "error",
            isSymlink,
            ...(builtin ? { builtin: true } : {}),
            entryUrl: null,
            sidecarPort: null,
            errorMessage: validated.error,
          };
        }

        const { manifest } = validated;
        const saved = state.plugins[manifest.id];
        const enabled = saved?.enabled ?? true;

        if (!enabled) {
          await this.stopSidecar(manifest.id);
          return {
            manifest,
            rootDir,
            enabled: false,
            status: "disabled",
            isSymlink,
            ...(builtin ? { builtin: true } : {}),
            entryUrl: null,
            sidecarPort: null,
            ...(saved?.installedAt ? { installedAt: saved.installedAt } : {}),
            ...(saved?.sourceUrl ? { sourceUrl: saved.sourceUrl } : {}),
          };
        }

        if (manifest.runtime.type === "sidecar") {
          const running = await this.ensureSidecarRunning(manifest, rootDir);
          const errorMessage = this.sidecarErrors.get(manifest.id);
          return {
            manifest,
            rootDir,
            enabled: true,
            status: errorMessage ? "error" : running ? "active" : "starting",
            isSymlink,
            ...(builtin ? { builtin: true } : {}),
            entryUrl: running
              ? `/api/m3-plugins/sidecar/${encodeURIComponent(manifest.id)}/?m3_plugin_id=${encodeURIComponent(manifest.id)}`
              : null,
            sidecarPort: running?.port ?? null,
            ...(errorMessage ? { errorMessage } : {}),
            ...(saved?.installedAt ? { installedAt: saved.installedAt } : {}),
            ...(saved?.sourceUrl ? { sourceUrl: saved.sourceUrl } : {}),
          };
        }

        const cleanEntry = manifest.runtime.entry.replace(/^\/+/, "");
        return {
          manifest,
          rootDir,
          enabled: true,
          status: "active",
          isSymlink,
          ...(builtin ? { builtin: true } : {}),
          entryUrl: `/api/m3-plugins/static/${encodeURIComponent(manifest.id)}/${cleanEntry}?m3_plugin_id=${encodeURIComponent(manifest.id)}`,
          sidecarPort: null,
          ...(saved?.installedAt ? { installedAt: saved.installedAt } : {}),
          ...(saved?.sourceUrl ? { sourceUrl: saved.sourceUrl } : {}),
        };
      }),
    );

    return records.filter((record): record is M3PluginRecord => record !== undefined);
  }

  async list(): Promise<{
    readonly pluginsDir: string;
    readonly plugins: ReadonlyArray<M3PluginRecord>;
  }> {
    const state = await this.readState();
    const byId = new Map<string, M3PluginRecord>();

    for (const builtinDir of this.builtinPluginsDirs) {
      const builtinRecords = await this.scanPluginDirectory(builtinDir, true, state);
      for (const record of builtinRecords) {
        byId.set(record.manifest.id, record);
      }
    }

    const userRecords = await this.scanPluginDirectory(this.pluginsDir, false, state);
    for (const record of userRecords) {
      byId.set(record.manifest.id, record);
    }

    const plugins = [...byId.values()].sort((a, b) =>
      a.manifest.name.localeCompare(b.manifest.name),
    );

    return { pluginsDir: this.pluginsDir, plugins };
  }

  async install(input: {
    readonly source: string;
    readonly id?: string;
    readonly link?: boolean;
  }): Promise<M3PluginRecord> {
    await NodeFSP.mkdir(this.pluginsDir, { recursive: true });
    const pluginId = input.id ? sanitizePluginId(input.id) : inferIdFromSource(input.source);
    const targetDir = NodePath.join(this.pluginsDir, pluginId);

    try {
      await NodeFSP.lstat(targetDir);
      throw new Error(`Plugin "${pluginId}" already exists at ${targetDir}.`);
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") {
        throw err;
      }
    }

    if (isGitSource(input.source)) {
      await runGitClone(normalizeGitUrl(input.source), targetDir);
    } else {
      const resolved = NodePath.resolve(input.source.replace(/^~(?=\/|$)/, NodeOS.homedir()));
      if (input.link) {
        await NodeFSP.symlink(resolved, targetDir, "dir");
      } else {
        await NodeFSP.cp(resolved, targetDir, { recursive: true });
      }
    }

    try {
      const raw = JSON.parse(
        await NodeFSP.readFile(NodePath.join(targetDir, "plugin.json"), "utf8"),
      );
      const validated = validatePluginManifest(raw, pluginId);
      if (!validated.ok) {
        throw new Error(validated.error);
      }
      const state = await this.readState();
      await this.writeState({
        plugins: {
          ...state.plugins,
          [validated.manifest.id]: {
            enabled: true,
            installedAt: new Date().toISOString(),
            sourceUrl: input.source,
          },
        },
      });
      const listed = await this.list();
      const installed = listed.plugins.find((p) => p.manifest.id === validated.manifest.id);
      if (!installed) {
        throw new Error(`Installed plugin "${validated.manifest.id}" could not be loaded.`);
      }
      this.publishEvent("plugins:reloaded", { count: listed.plugins.length });
      return installed;
    } catch (err) {
      await NodeFSP.rm(targetDir, { recursive: true, force: true }).catch(() => {});
      throw err;
    }
  }

  async uninstall(pluginId: string): Promise<boolean> {
    const listed = await this.list();
    const target = listed.plugins.find((p) => p.manifest.id === pluginId);
    if (!target) return false;
    if (target.builtin) {
      throw new Error(`Built-in plugin "${pluginId}" cannot be uninstalled; disable it instead.`);
    }
    await this.stopSidecar(pluginId);
    await NodeFSP.rm(target.rootDir, { recursive: true, force: true });
    const state = await this.readState();
    const { [pluginId]: _removed, ...rest } = state.plugins;
    await this.writeState({ plugins: rest });
    this.publishEvent("plugins:reloaded", { removed: pluginId });
    return true;
  }

  async setEnabled(pluginId: string, enabled: boolean): Promise<M3PluginRecord> {
    const state = await this.readState();
    await this.writeState({
      plugins: {
        ...state.plugins,
        [pluginId]: {
          ...state.plugins[pluginId],
          enabled,
        },
      },
    });
    if (!enabled) {
      await this.stopSidecar(pluginId);
    }
    const listed = await this.list();
    const updated = listed.plugins.find((p) => p.manifest.id === pluginId);
    if (!updated) {
      throw new Error(`Plugin "${pluginId}" not found.`);
    }
    this.publishEvent("plugins:reloaded", { pluginId, enabled });
    return updated;
  }

  async reload(): Promise<{
    readonly pluginsDir: string;
    readonly plugins: ReadonlyArray<M3PluginRecord>;
  }> {
    await this.shutdown();
    this.sidecarErrors.clear();
    const result = await this.list();
    this.publishEvent("plugins:reloaded", { count: result.plugins.length });
    return result;
  }

  async resolveStaticAsset(
    pluginId: string,
    relativeAssetPath: string,
  ): Promise<{ readonly bytes: Uint8Array; readonly contentType: string } | null> {
    const listed = await this.list();
    const plugin = listed.plugins.find((p) => p.manifest.id === pluginId && p.enabled);
    if (!plugin) return null;

    const rootReal = await NodeFSP.realpath(plugin.rootDir);
    const cleaned = relativeAssetPath.replace(/^\/+/, "") || "index.html";
    const resolved = NodePath.resolve(rootReal, cleaned);
    if (!resolved.startsWith(`${rootReal}${NodePath.sep}`) && resolved !== rootReal) {
      return null;
    }

    try {
      const bytes = await NodeFSP.readFile(resolved);
      const ext = NodePath.extname(resolved).toLowerCase();
      return {
        bytes,
        contentType: MIME_TYPES[ext] ?? "application/octet-stream",
      };
    } catch {
      return null;
    }
  }

  getSidecarPort(pluginId: string): number | null {
    return this.sidecars.get(pluginId)?.port ?? null;
  }
}
