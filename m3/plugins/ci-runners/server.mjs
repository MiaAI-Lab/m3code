import * as NodeFSP from "node:fs/promises";
import * as NodeHttp from "node:http";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import { cancelRun, getRunLogs, listRuns, probeRunner, triggerRun } from "./runnerApi.mjs";
import {
  executeDeployment,
  generateDeploymentPlan,
  M3_RUNNER_AGENT_SCRIPT,
} from "./runnerDeployer.mjs";
import { RunnerStore } from "./runnerStore.mjs";

const __dirname = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
const UI_INDEX_PATH = NodePath.join(__dirname, "ui", "index.html");

function sendJson(res, status, body) {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(JSON.stringify(body));
}

function readJsonBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (!raw.trim()) {
        resolve({});
        return;
      }
      try {
        const parsed = JSON.parse(raw);
        resolve(
          typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? parsed : {},
        );
      } catch {
        resolve({});
      }
    });
    req.on("error", () => resolve({}));
  });
}

const LOOPBACK_HOST_RE = /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i;

// This sidecar has no auth of its own: only the plugin host proxy (which checks the admin
// session and forwards no Origin/Sec-Fetch-* headers) may reach it. Browser-originated or
// DNS-rebound requests straight to the loopback port could otherwise run deployments.
function isDirectBrowserRequest(req) {
  const host = req.headers.host ?? "";
  return (
    !LOOPBACK_HOST_RE.test(host) ||
    req.headers.origin !== undefined ||
    req.headers["sec-fetch-site"] !== undefined
  );
}

export function createCiRunnersRequestHandler(store = new RunnerStore()) {
  return async function handleRequest(req, res) {
    if (isDirectBrowserRequest(req)) {
      return sendJson(res, 403, { ok: false, error: "Use the M3 plugin host proxy." });
    }
    const method = req.method ?? "GET";
    const parsedUrl = new URL(req.url ?? "/", "http://127.0.0.1");
    const pathname = parsedUrl.pathname.replace(/\/+$/, "") || "/";

    try {
      if (method === "GET" && (pathname === "/" || pathname === "/index.html")) {
        const html = await NodeFSP.readFile(UI_INDEX_PATH, "utf8");
        res.writeHead(200, {
          "content-type": "text/html; charset=utf-8",
          "cache-control": "no-store",
        });
        res.end(html);
        return;
      }

      if (method === "GET" && pathname === "/api/health") {
        const runners = await store.listRunners();
        return sendJson(res, 200, {
          ok: true,
          pluginId: process.env.M3_PLUGIN_ID ?? "ci-runners",
          version: "1.0.0",
          runnerCount: runners.length,
        });
      }

      if (method === "GET" && pathname === "/api/runners") {
        const runners = await store.listRunners();
        return sendJson(res, 200, { ok: true, runners });
      }

      if (method === "POST" && pathname === "/api/runners") {
        const body = await readJsonBody(req);
        const runner = await store.createRunner(body);
        return sendJson(res, 201, { ok: true, runner });
      }

      const runnerMatch = /^\/api\/runners\/([^/]+)$/.exec(pathname);
      if (runnerMatch) {
        const id = decodeURIComponent(runnerMatch[1]);
        if (method === "PUT" || method === "PATCH") {
          const body = await readJsonBody(req);
          const updated = await store.updateRunner(id, body);
          if (!updated)
            return sendJson(res, 404, { ok: false, error: `Runner "${id}" not found.` });
          return sendJson(res, 200, { ok: true, runner: updated });
        }
        if (method === "DELETE") {
          const deleted = await store.deleteRunner(id);
          if (!deleted)
            return sendJson(res, 404, { ok: false, error: `Runner "${id}" not found.` });
          return sendJson(res, 200, { ok: true, id });
        }
      }

      const probeMatch = /^\/api\/runners\/([^/]+)\/probe$/.exec(pathname);
      if (method === "POST" && probeMatch) {
        const id = decodeURIComponent(probeMatch[1]);
        const runner = await store.getRunnerRaw(id);
        if (!runner) return sendJson(res, 404, { ok: false, error: `Runner "${id}" not found.` });
        const status = await probeRunner(runner);
        return sendJson(res, 200, { ok: true, runnerId: id, ...status });
      }

      const runsMatch = /^\/api\/runners\/([^/]+)\/runs$/.exec(pathname);
      if (method === "GET" && runsMatch) {
        const id = decodeURIComponent(runsMatch[1]);
        const runner = await store.getRunnerRaw(id);
        if (!runner) return sendJson(res, 404, { ok: false, error: `Runner "${id}" not found.` });
        const limit = Number(parsedUrl.searchParams.get("limit") ?? 20);
        try {
          const runs = await listRuns(runner, { limit });
          return sendJson(res, 200, { ok: true, runnerId: id, runs, source: "live" });
        } catch (err) {
          const localRuns = await store.listLocalRuns(id);
          return sendJson(res, 200, {
            ok: true,
            runnerId: id,
            runs: localRuns,
            source: "local-history",
            warning: err instanceof Error ? err.message : String(err),
          });
        }
      }

      const triggerMatch = /^\/api\/runners\/([^/]+)\/trigger$/.exec(pathname);
      if (method === "POST" && triggerMatch) {
        const id = decodeURIComponent(triggerMatch[1]);
        const runner = await store.getRunnerRaw(id);
        if (!runner) return sendJson(res, 404, { ok: false, error: `Runner "${id}" not found.` });
        const body = await readJsonBody(req);
        const result = await triggerRun(runner, body);
        const recorded = await store.recordLocalRun({
          id: result.runId || undefined,
          runnerId: id,
          ref: result.ref,
          workflow: result.workflow,
          command: result.command,
          status: result.status,
          url: result.url ?? null,
        });
        return sendJson(res, 202, { ok: true, ...result, record: recorded });
      }

      const cancelMatch = /^\/api\/runners\/([^/]+)\/runs\/([^/]+)\/cancel$/.exec(pathname);
      if (method === "POST" && cancelMatch) {
        const id = decodeURIComponent(cancelMatch[1]);
        const runId = decodeURIComponent(cancelMatch[2]);
        const runner = await store.getRunnerRaw(id);
        if (!runner) return sendJson(res, 404, { ok: false, error: `Runner "${id}" not found.` });
        const result = await cancelRun(runner, runId);
        return sendJson(res, 200, result);
      }

      const logsMatch = /^\/api\/runners\/([^/]+)\/runs\/([^/]+)\/logs$/.exec(pathname);
      if (method === "GET" && logsMatch) {
        const id = decodeURIComponent(logsMatch[1]);
        const runId = decodeURIComponent(logsMatch[2]);
        const runner = await store.getRunnerRaw(id);
        if (!runner) return sendJson(res, 404, { ok: false, error: `Runner "${id}" not found.` });
        const result = await getRunLogs(runner, runId);
        return sendJson(res, 200, { ok: true, ...result });
      }

      if (method === "POST" && pathname === "/api/deploy/plan") {
        const body = await readJsonBody(req);
        const plan = generateDeploymentPlan(body);
        return sendJson(res, 200, { ok: true, plan });
      }

      if (method === "POST" && pathname === "/api/deploy/execute") {
        const body = await readJsonBody(req);
        const result = await executeDeployment(body);
        let registeredRunner = null;
        if (result.ok && body.autoRegister === true) {
          try {
            registeredRunner = await store.createRunner({
              name: result.plan.name,
              provider: result.plan.provider,
              apiBaseUrl: result.plan.suggestedApiBaseUrl,
              labels: result.plan.labels,
              token: typeof body.registrationToken === "string" ? body.registrationToken : "",
              deploy: { mode: result.mode, host: body.sshHost ?? "127.0.0.1" },
            });
          } catch {
            // Runner with same id/name may already exist; still return deploy success.
          }
        }
        return sendJson(res, result.ok ? 200 : 500, {
          ...result,
          ...(registeredRunner ? { registeredRunner } : {}),
        });
      }

      if (method === "GET" && pathname === "/api/deploy/agent-script") {
        res.writeHead(200, {
          "content-type": "application/javascript; charset=utf-8",
          "content-disposition": 'attachment; filename="m3-runner-agent.mjs"',
          "cache-control": "no-store",
        });
        res.end(M3_RUNNER_AGENT_SCRIPT);
        return;
      }

      return sendJson(res, 404, { ok: false, error: `Unknown endpoint: ${method} ${pathname}` });
    } catch (err) {
      return sendJson(res, 400, {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  };
}

export function startServer(options = {}) {
  const port = Number(options.port ?? process.env.M3_PLUGIN_PORT ?? process.env.PORT ?? 0);
  const host = options.host ?? "127.0.0.1";
  const store = options.store ?? new RunnerStore(options.dataDir);
  const server = NodeHttp.createServer(createCiRunnersRequestHandler(store));
  return new Promise((resolve, reject) => {
    server.on("error", reject);
    server.listen(port, host, () => {
      const addr = server.address();
      resolve({
        server,
        port: typeof addr === "object" && addr ? addr.port : port,
        store,
      });
    });
  });
}

const isMain =
  process.argv[1] && NodePath.resolve(process.argv[1]) === NodeURL.fileURLToPath(import.meta.url);

if (isMain) {
  startServer().catch((err) => {
    console.error("[ci-runners] failed to start:", err);
    process.exit(1);
  });
}
