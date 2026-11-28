// @effect-diagnostics nodeBuiltinImport:off globalFetch:off -- tests exercise the standalone CI Runners plugin store, direct HTTP runner API, and deployment planner against loopback servers.
import * as NodeFSP from "node:fs/promises";
import * as NodeHttp from "node:http";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { assert, describe, it } from "vitest";

import { PluginHostManager } from "../../plugin-host/server/PluginHostManager.ts";
import { generateDeploymentPlan, M3_RUNNER_AGENT_SCRIPT } from "./runnerDeployer.mjs";
import { RunnerStore } from "./runnerStore.mjs";
import { startServer } from "./server.mjs";

function listenMockServer(
  handler: (req: NodeHttp.IncomingMessage, res: NodeHttp.ServerResponse) => void,
): Promise<{ readonly server: NodeHttp.Server; readonly baseUrl: string }> {
  return new Promise((resolve, reject) => {
    const server = NodeHttp.createServer(handler);
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (!addr || typeof addr === "string") {
        reject(new Error("Failed to bind mock server"));
        return;
      }
      resolve({ server, baseUrl: `http://127.0.0.1:${addr.port}` });
    });
  });
}

function closeServer(server: NodeHttp.Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

describe("m3/plugins/ci-runners", () => {
  it("auto-discovers built-in ci-runners plugin in PluginHostManager, spawns sidecar, and blocks uninstall", async () => {
    const tmpDir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "m3-ci-plugin-host-"));
    const manager = new PluginHostManager({ m3HomeDir: tmpDir });
    try {
      const listed = await manager.list();
      const ciPlugin = listed.plugins.find((p) => p.manifest.id === "ci-runners");
      assert.isDefined(ciPlugin);
      assert.strictEqual(ciPlugin.builtin, true);
      assert.strictEqual(ciPlugin.status, "active");
      assert.isNotNull(ciPlugin.sidecarPort);

      const healthRes = await fetch(`http://127.0.0.1:${ciPlugin.sidecarPort}/api/health`);
      assert.strictEqual(healthRes.status, 200);
      const health = (await healthRes.json()) as { ok: boolean; pluginId: string };
      assert.strictEqual(health.ok, true);
      assert.strictEqual(health.pluginId, "ci-runners");

      let uninstallFailed = false;
      try {
        await manager.uninstall("ci-runners");
      } catch (err) {
        uninstallFailed = err instanceof Error && err.message.includes("Built-in plugin");
      }
      assert.strictEqual(uninstallFailed, true);
    } finally {
      await manager.shutdown();
      await NodeFSP.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("masks secrets in RunnerStore and proxies probe, trigger, runs, logs, and cancel directly to a custom HTTP runner", async () => {
    const tmpDir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "m3-ci-runners-api-"));
    let capturedAuth = "";
    let cancelledId = "";

    const mockRunner = await listenMockServer((req, res) => {
      capturedAuth = req.headers.authorization ?? "";
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      res.writeHead(200, { "content-type": "application/json" });

      if (req.method === "GET" && url.pathname === "/health") {
        res.end(
          JSON.stringify({
            ok: true,
            name: "spark-runner-1",
            version: "1.0.0",
            platform: "linux",
            concurrency: 4,
            activeJobs: 1,
            busy: false,
            labels: ["self-hosted", "gpu"],
          }),
        );
        return;
      }
      if (req.method === "POST" && url.pathname === "/runs") {
        res.end(JSON.stringify({ id: "run_live_42", status: "in_progress" }));
        return;
      }
      if (req.method === "GET" && url.pathname === "/runs") {
        res.end(
          JSON.stringify({
            runs: [
              {
                id: "run_live_42",
                name: "pnpm test",
                ref: "feat/ci",
                status: "completed",
                exitCode: 0,
              },
            ],
          }),
        );
        return;
      }
      if (req.method === "GET" && url.pathname === "/runs/run_live_42/logs") {
        res.end(JSON.stringify({ id: "run_live_42", logs: "$ pnpm test\nPASS all 12 tests\n" }));
        return;
      }
      if (req.method === "POST" && url.pathname === "/runs/run_live_42/cancel") {
        cancelledId = "run_live_42";
        res.end(JSON.stringify({ ok: true, id: "run_live_42", status: "cancelled" }));
        return;
      }
      res.statusCode = 404;
      res.end(JSON.stringify({ error: "not found" }));
    });

    const sidecar = await startServer({
      port: 0,
      store: new RunnerStore(tmpDir),
    });
    const apiBase = `http://127.0.0.1:${sidecar.port}`;

    try {
      // 1. Register runner and verify token masking
      const createRes = await fetch(`${apiBase}/api/runners`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: "Spark Runner",
          provider: "custom-http",
          apiBaseUrl: mockRunner.baseUrl,
          labels: "self-hosted, gpu",
          token: "super-secret-runner-token-9876",
        }),
      });
      assert.strictEqual(createRes.status, 201);
      const created = (await createRes.json()) as {
        ok: boolean;
        runner: { id: string; tokenSet: boolean; tokenPreview: string; token?: string };
      };
      assert.strictEqual(created.ok, true);
      assert.strictEqual(created.runner.tokenSet, true);
      assert.strictEqual(created.runner.tokenPreview, "••••9876");
      assert.isUndefined(created.runner.token);

      const runnerId = created.runner.id;

      // 2. Probe runner directly
      const probeRes = await fetch(`${apiBase}/api/runners/${runnerId}/probe`, { method: "POST" });
      const probe = (await probeRes.json()) as {
        online: boolean;
        concurrency: number;
        activeJobs: number;
      };
      assert.strictEqual(probe.online, true);
      assert.strictEqual(probe.concurrency, 4);
      assert.strictEqual(probe.activeJobs, 1);
      assert.strictEqual(capturedAuth, "Bearer super-secret-runner-token-9876");

      // 3. Trigger run
      const trigRes = await fetch(`${apiBase}/api/runners/${runnerId}/trigger`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ref: "feat/ci", command: "pnpm test" }),
      });
      assert.strictEqual(trigRes.status, 202);
      const trig = (await trigRes.json()) as { ok: boolean; runId: string };
      assert.strictEqual(trig.runId, "run_live_42");

      // 4. List runs
      const runsRes = await fetch(`${apiBase}/api/runners/${runnerId}/runs`);
      const runsBody = (await runsRes.json()) as {
        runs: Array<{ id: string; conclusion: string }>;
      };
      assert.strictEqual(runsBody.runs.length, 1);
      assert.strictEqual(runsBody.runs[0]?.id, "run_live_42");
      assert.strictEqual(runsBody.runs[0]?.conclusion, "success");

      // 5. Fetch logs
      const logsRes = await fetch(`${apiBase}/api/runners/${runnerId}/runs/run_live_42/logs`);
      const logsBody = (await logsRes.json()) as { logs: string };
      assert.include(logsBody.logs, "PASS all 12 tests");

      // 6. Cancel run
      const cancelRes = await fetch(`${apiBase}/api/runners/${runnerId}/runs/run_live_42/cancel`, {
        method: "POST",
      });
      assert.strictEqual(cancelRes.status, 200);
      assert.strictEqual(cancelledId, "run_live_42");
    } finally {
      await closeServer(sidecar.server);
      await closeServer(mockRunner.server);
      await NodeFSP.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("generates Docker, systemd, and SSH deployment plans for self-hosted runners", () => {
    const dockerPlan = generateDeploymentPlan({
      provider: "custom-http",
      mode: "docker",
      name: "Spark CI 01",
      port: 8899,
      concurrency: 4,
      labels: ["self-hosted", "arm64"],
    });
    assert.strictEqual(dockerPlan.name, "spark-ci-01");
    assert.strictEqual(dockerPlan.suggestedApiBaseUrl, "http://127.0.0.1:8899");
    assert.include(dockerPlan.dockerComposeYaml, "8899:8899");
    assert.include(dockerPlan.dockerComposeYaml, "M3_RUNNER_CONCURRENCY");
    assert.include(M3_RUNNER_AGENT_SCRIPT, "/health");

    const ghSystemd = generateDeploymentPlan({
      provider: "github",
      mode: "systemd",
      name: "gh-linux-1",
      instanceUrl: "https://github.com/MiaAI-Lab/m3code",
      labels: "self-hosted,linux,x64",
    });
    assert.include(ghSystemd.systemdUnit, "REPO_URL=https://github.com/MiaAI-Lab/m3code");
    assert.include(ghSystemd.systemdUnit, "NoNewPrivileges=true");

    const sshPlan = generateDeploymentPlan({
      provider: "forgejo",
      mode: "ssh",
      name: "forgejo-box",
      sshHost: "10.0.0.42",
      sshUser: "deploy",
      instanceUrl: "https://git.internal",
    });
    assert.include(sshPlan.sshCommand, "deploy@10.0.0.42");
    assert.include(sshPlan.remoteInstallScript, "FORGEJO_INSTANCE_URL=https://git.internal");
  });

  it("quotes shell metacharacters in the remote install script and rejects newlines", () => {
    const plan = generateDeploymentPlan({
      provider: "forgejo",
      mode: "ssh",
      sshHost: "10.0.0.42",
      image: "img`id`",
      workDir: "/srv/$(id)",
    });
    assert.include(plan.remoteInstallScript, "'img`id`'");
    assert.notInclude(plan.remoteInstallScript, 'echo "');
    assert.throws(
      () => generateDeploymentPlan({ provider: "forgejo", workDir: "/srv\nEOF_UNIT\nid" }),
      /control characters/,
    );
    assert.throws(
      () => generateDeploymentPlan({ provider: "forgejo", labels: ["ok", "a\nb"] }),
      /control characters/,
    );
  });

  it("rejects requests that reach the sidecar without the plugin host proxy", async () => {
    const tmpDir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "m3-ci-direct-"));
    const sidecar = await startServer({ port: 0, store: new RunnerStore(tmpDir) });
    try {
      const fromPage = await fetch(`http://127.0.0.1:${sidecar.port}/api/deploy/execute`, {
        method: "POST",
        headers: { origin: "https://evil.example" },
        body: "{}",
      });
      assert.strictEqual(fromPage.status, 403);
      const rebound = await new Promise<number>((resolve, reject) => {
        NodeHttp.get(
          {
            host: "127.0.0.1",
            port: sidecar.port,
            path: "/api/runners",
            headers: { host: "evil.example" },
          },
          (res) => {
            res.resume();
            resolve(res.statusCode ?? 0);
          },
        ).on("error", reject);
      });
      assert.strictEqual(rebound, 403);
    } finally {
      await closeServer(sidecar.server);
      await NodeFSP.rm(tmpDir, { recursive: true, force: true });
    }
  });
});
