export const M3_PLUGIN_SLOTS = ["sidebar-tab", "right-panel", "thread-toolbar", "modal"] as const;

export type M3PluginSlot = (typeof M3_PLUGIN_SLOTS)[number];

export const M3_PLUGIN_EVENTS = [
  "thread:updated",
  "thread:selected",
  "agent:spawned",
  "agent:status",
  "message:sent",
  "workspace:changed",
  "plugins:reloaded",
] as const;

export type M3PluginEventName = (typeof M3_PLUGIN_EVENTS)[number];

export type M3PluginRuntime =
  | {
      readonly type: "static";
      /** Entry HTML file relative to the plugin directory (defaults to "index.html"). */
      readonly entry: string;
    }
  | {
      readonly type: "sidecar";
      /** Executable to spawn (e.g. "node", "python3", "./server"). */
      readonly command: string;
      readonly args: ReadonlyArray<string>;
      readonly env?: Readonly<Record<string, string>>;
      /** Optional HTTP path polled to check readiness (defaults to "/"). */
      readonly healthPath?: string;
    };

export interface M3PluginManifest {
  readonly id: string;
  readonly name: string;
  readonly version: string;
  readonly description?: string;
  readonly author?: string;
  readonly icon?: string;
  readonly runtime: M3PluginRuntime;
  readonly slots: ReadonlyArray<M3PluginSlot>;
  readonly subscriptions: ReadonlyArray<string>;
}

export type M3PluginStatus = "active" | "disabled" | "starting" | "error";

export interface M3PluginRecord {
  readonly manifest: M3PluginManifest;
  readonly rootDir: string;
  readonly enabled: boolean;
  readonly status: M3PluginStatus;
  readonly isSymlink: boolean;
  /** URL the UI iframe/webview loads (either static bundle path or sidecar proxy path). */
  readonly entryUrl: string | null;
  readonly sidecarPort: number | null;
  readonly errorMessage?: string;
  readonly installedAt?: string;
  readonly sourceUrl?: string;
}

const VALID_SLOT_SET: ReadonlySet<string> = new Set(M3_PLUGIN_SLOTS);

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function nonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function sanitizePluginId(raw: string): string {
  const normalized = raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return normalized.length > 0 ? normalized : "plugin";
}

export type ManifestValidationResult =
  | { readonly ok: true; readonly manifest: M3PluginManifest }
  | { readonly ok: false; readonly error: string };

export function validatePluginManifest(
  raw: unknown,
  fallbackId?: string,
): ManifestValidationResult {
  const rec = asRecord(raw);
  if (!rec) {
    return { ok: false, error: "plugin.json must be a JSON object." };
  }

  const rawId = nonEmptyString(rec.id) ?? nonEmptyString(rec.name) ?? fallbackId;
  if (!rawId) {
    return { ok: false, error: 'plugin.json requires a non-empty "id" or "name".' };
  }
  const id = sanitizePluginId(rawId);
  const name = nonEmptyString(rec.name) ?? id;
  const version = nonEmptyString(rec.version) ?? "0.1.0";
  const description = nonEmptyString(rec.description);
  const author = nonEmptyString(rec.author);
  const icon = nonEmptyString(rec.icon);

  const runtimeRaw = asRecord(rec.runtime);
  let runtime: M3PluginRuntime;
  if (!runtimeRaw) {
    runtime = { type: "static", entry: "index.html" };
  } else if (runtimeRaw.type === "sidecar") {
    const command = nonEmptyString(runtimeRaw.command);
    if (!command) {
      return { ok: false, error: 'Sidecar runtime requires a non-empty "command".' };
    }
    const args = Array.isArray(runtimeRaw.args)
      ? runtimeRaw.args.filter((item): item is string => typeof item === "string")
      : [];
    const envRaw = asRecord(runtimeRaw.env);
    const env: Record<string, string> = {};
    if (envRaw) {
      for (const [k, v] of Object.entries(envRaw)) {
        if (typeof v === "string") env[k] = v;
      }
    }
    const healthPath = nonEmptyString(runtimeRaw.healthPath);
    runtime = {
      type: "sidecar",
      command,
      args,
      ...(Object.keys(env).length > 0 ? { env } : {}),
      ...(healthPath ? { healthPath } : {}),
    };
  } else {
    const entry = nonEmptyString(runtimeRaw.entry) ?? "index.html";
    if (entry.includes("..") || entry.startsWith("/") || entry.startsWith("\\")) {
      return {
        ok: false,
        error: 'Static runtime "entry" must be a relative path inside the plugin directory.',
      };
    }
    runtime = { type: "static", entry };
  }

  const slotsRaw = Array.isArray(rec.slots) ? rec.slots : ["right-panel"];
  const slots = slotsRaw.filter(
    (slot): slot is M3PluginSlot => typeof slot === "string" && VALID_SLOT_SET.has(slot),
  );
  const normalizedSlots: ReadonlyArray<M3PluginSlot> =
    slots.length > 0 ? [...new Set(slots)] : ["right-panel"];

  const subscriptions = Array.isArray(rec.subscriptions)
    ? [
        ...new Set(
          rec.subscriptions.map(nonEmptyString).filter((s): s is string => s !== undefined),
        ),
      ]
    : [];

  return {
    ok: true,
    manifest: {
      id,
      name,
      version,
      ...(description ? { description } : {}),
      ...(author ? { author } : {}),
      ...(icon ? { icon } : {}),
      runtime,
      slots: normalizedSlots,
      subscriptions,
    },
  };
}
