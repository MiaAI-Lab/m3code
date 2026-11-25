import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

export const RUNNER_PROVIDERS = ["custom-http", "github", "gitlab", "forgejo"];
const PROVIDER_SET = new Set(RUNNER_PROVIDERS);

const MAX_RUN_HISTORY = 200;

function asRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value : undefined;
}

function nonEmptyString(value) {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function validateApiBaseUrl(raw) {
  const str = nonEmptyString(raw);
  if (!str) {
    throw new Error("apiBaseUrl is required.");
  }
  let parsed;
  try {
    parsed = new URL(str);
  } catch {
    throw new Error(`Invalid apiBaseUrl: "${str}".`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`apiBaseUrl must use http:// or https:// (got "${parsed.protocol}").`);
  }
  return parsed.toString().replace(/\/+$/, "");
}

export function normalizeLabels(raw) {
  if (Array.isArray(raw)) {
    return [
      ...new Set(
        raw
          .map((item) => (typeof item === "string" ? item.trim() : ""))
          .filter((item) => item.length > 0),
      ),
    ];
  }
  if (typeof raw === "string") {
    return [
      ...new Set(
        raw
          .split(",")
          .map((item) => item.trim())
          .filter((item) => item.length > 0),
      ),
    ];
  }
  return [];
}

export function maskSecret(secret) {
  if (typeof secret !== "string" || secret.length === 0) return null;
  if (secret.length <= 4) return "••••";
  return `••••${secret.slice(-4)}`;
}

export function toPublicRunner(runner) {
  const { token, ...rest } = runner;
  return {
    ...rest,
    tokenSet: typeof token === "string" && token.length > 0,
    tokenPreview: maskSecret(token),
  };
}

export function resolveDefaultDataDir() {
  const envDir = nonEmptyString(process.env.M3_PLUGIN_DATA_DIR);
  if (envDir) return NodePath.resolve(envDir);
  const envHome =
    nonEmptyString(process.env.M3_HOME_DIR) ?? nonEmptyString(process.env.M3CODE_HOME);
  const baseHome = envHome
    ? NodePath.resolve(envHome.replace(/^~(?=\/|$)/, NodeOS.homedir()))
    : NodePath.join(NodeOS.homedir(), ".m3");
  return NodePath.join(baseHome, "userdata", "plugins", "ci-runners");
}

export class RunnerStore {
  constructor(dataDir = resolveDefaultDataDir()) {
    this.dataDir = NodePath.resolve(dataDir);
    this.statePath = NodePath.join(this.dataDir, "runners.json");
  }

  async readState() {
    try {
      const raw = await NodeFSP.readFile(this.statePath, "utf8");
      const parsed = JSON.parse(raw);
      return {
        runners: Array.isArray(parsed?.runners) ? parsed.runners : [],
        runs: Array.isArray(parsed?.runs) ? parsed.runs : [],
      };
    } catch {
      return { runners: [], runs: [] };
    }
  }

  async writeState(state) {
    await NodeFSP.mkdir(this.dataDir, { recursive: true, mode: 0o700 });
    const tmpPath = `${this.statePath}.${process.pid}.${NodeCrypto.randomBytes(4).toString("hex")}.tmp`;
    await NodeFSP.writeFile(tmpPath, `${JSON.stringify(state, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    await NodeFSP.rename(tmpPath, this.statePath);
  }

  async listRunners() {
    const state = await this.readState();
    return state.runners.map(toPublicRunner);
  }

  async getRunnerRaw(id) {
    const state = await this.readState();
    return state.runners.find((r) => r.id === id) ?? null;
  }

  async createRunner(input) {
    const rec = asRecord(input);
    if (!rec) throw new Error("Runner payload must be a JSON object.");

    const name = nonEmptyString(rec.name);
    if (!name) throw new Error('Field "name" is required.');

    const provider = nonEmptyString(rec.provider) ?? "custom-http";
    if (!PROVIDER_SET.has(provider)) {
      throw new Error(
        `Unsupported provider "${provider}". Expected: ${RUNNER_PROVIDERS.join(", ")}.`,
      );
    }

    const apiBaseUrl = validateApiBaseUrl(rec.apiBaseUrl);
    const repo = nonEmptyString(rec.repo) ?? "";
    const defaultWorkflow = nonEmptyString(rec.defaultWorkflow) ?? "";
    const defaultRef = nonEmptyString(rec.defaultRef) ?? "main";
    const token = typeof rec.token === "string" ? rec.token.trim() : "";
    const labels = normalizeLabels(rec.labels);
    const deploy = asRecord(rec.deploy) ?? null;
    const now = new Date().toISOString();

    const runner = {
      id: nonEmptyString(rec.id) ?? `runner_${NodeCrypto.randomBytes(6).toString("hex")}`,
      name,
      provider,
      apiBaseUrl,
      repo,
      defaultWorkflow,
      defaultRef,
      labels,
      token,
      deploy,
      createdAt: now,
      updatedAt: now,
    };

    const state = await this.readState();
    if (state.runners.some((r) => r.id === runner.id)) {
      throw new Error(`Runner "${runner.id}" already exists.`);
    }
    state.runners.push(runner);
    await this.writeState(state);
    return toPublicRunner(runner);
  }

  async updateRunner(id, patch) {
    const rec = asRecord(patch);
    if (!rec) throw new Error("Update payload must be a JSON object.");

    const state = await this.readState();
    const index = state.runners.findIndex((r) => r.id === id);
    if (index === -1) return null;

    const existing = state.runners[index];
    const nextProvider =
      rec.provider !== undefined ? nonEmptyString(rec.provider) : existing.provider;
    if (!nextProvider || !PROVIDER_SET.has(nextProvider)) {
      throw new Error(`Unsupported provider "${String(rec.provider)}".`);
    }

    const updated = {
      ...existing,
      name: rec.name !== undefined ? (nonEmptyString(rec.name) ?? existing.name) : existing.name,
      provider: nextProvider,
      apiBaseUrl:
        rec.apiBaseUrl !== undefined ? validateApiBaseUrl(rec.apiBaseUrl) : existing.apiBaseUrl,
      repo:
        rec.repo !== undefined
          ? typeof rec.repo === "string"
            ? rec.repo.trim()
            : ""
          : existing.repo,
      defaultWorkflow:
        rec.defaultWorkflow !== undefined
          ? typeof rec.defaultWorkflow === "string"
            ? rec.defaultWorkflow.trim()
            : ""
          : existing.defaultWorkflow,
      defaultRef:
        rec.defaultRef !== undefined
          ? (nonEmptyString(rec.defaultRef) ?? "main")
          : existing.defaultRef,
      labels: rec.labels !== undefined ? normalizeLabels(rec.labels) : existing.labels,
      token:
        rec.token !== undefined
          ? typeof rec.token === "string" && rec.token.trim().length > 0
            ? rec.token.trim()
            : rec.clearToken === true
              ? ""
              : existing.token
          : existing.token,
      deploy: rec.deploy !== undefined ? (asRecord(rec.deploy) ?? null) : existing.deploy,
      updatedAt: new Date().toISOString(),
    };

    state.runners[index] = updated;
    await this.writeState(state);
    return toPublicRunner(updated);
  }

  async deleteRunner(id) {
    const state = await this.readState();
    const next = state.runners.filter((r) => r.id !== id);
    if (next.length === state.runners.length) return false;
    state.runners = next;
    await this.writeState(state);
    return true;
  }

  async recordLocalRun(entry) {
    const state = await this.readState();
    const record = {
      id: entry.id ?? `run_${NodeCrypto.randomBytes(6).toString("hex")}`,
      runnerId: entry.runnerId,
      ref: entry.ref ?? "main",
      workflow: entry.workflow ?? "",
      command: entry.command ?? "",
      status: entry.status ?? "queued",
      conclusion: entry.conclusion ?? null,
      url: entry.url ?? null,
      createdAt: entry.createdAt ?? new Date().toISOString(),
    };
    state.runs = [record, ...state.runs.filter((r) => r.id !== record.id)].slice(
      0,
      MAX_RUN_HISTORY,
    );
    await this.writeState(state);
    return record;
  }

  async listLocalRuns(runnerId) {
    const state = await this.readState();
    return runnerId ? state.runs.filter((r) => r.runnerId === runnerId) : state.runs;
  }
}
