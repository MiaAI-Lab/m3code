// @effect-diagnostics nodeBuiltinImport:off -- tests create temporary ~/.m3/plugins fixtures and spawn a local Node sidecar server.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { assert, describe, it } from "vitest";

import {
  createBridgeEvent,
  createBridgeResponse,
  isM3BridgeCommandMessage,
  isM3BridgeEventMessage,
  M3_PLUGIN_BRIDGE_VERSION,
} from "./bridgeProtocol.ts";
import { validatePluginManifest } from "./manifest.ts";
import { PluginHostManager } from "./server/PluginHostManager.ts";

describe("m3/plugin-host", () => {
  it("validates static and sidecar plugin.json manifests and rejects path traversal", () => {
    const validStatic = validatePluginManifest({
      id: "prompt-dashboard",
      name: "Prompt Dashboard",
      version: "1.0.0",
      runtime: { type: "static", entry: "index.html" },
      slots: ["sidebar-tab", "modal"],
      subscriptions: ["thread:updated", "agent:spawned"],
    });
    assert.strictEqual(validStatic.ok, true);
    if (validStatic.ok) {
      assert.strictEqual(validStatic.manifest.id, "prompt-dashboard");
      assert.deepStrictEqual(validStatic.manifest.slots, ["sidebar-tab", "modal"]);
      assert.strictEqual(validStatic.manifest.runtime.type, "static");
    }

    const badTraversal = validatePluginManifest({
      id: "evil",
      runtime: { type: "static", entry: "../../etc/passwd" },
    });
    assert.strictEqual(badTraversal.ok, false);

    const validSidecar = validatePluginManifest({
      id: "vikunja-sync",
      name: "Vikunja Sync",
      version: "0.2.0",
      runtime: { type: "sidecar", command: "node", args: ["server.mjs"], healthPath: "/health" },
      slots: ["right-panel"],
      subscriptions: ["thread:updated"],
    });
    assert.strictEqual(validSidecar.ok, true);
  });

  it("validates versioned Event Bridge commands and events", () => {
    const evt = createBridgeEvent("agent:spawned", { agentId: "a1" });
    assert.strictEqual(isM3BridgeEventMessage(evt), true);
    assert.strictEqual(evt.version, M3_PLUGIN_BRIDGE_VERSION);

    assert.strictEqual(
      isM3BridgeCommandMessage({
        version: 1,
        type: "m3:command",
        id: "cmd_1",
        pluginId: "vikunja-sync",
        command: "thread:create",
        payload: { title: "Fix bug" },
      }),
      true,
    );
    assert.strictEqual(
      isM3BridgeCommandMessage({
        version: 99,
        type: "m3:command",
        id: "cmd_1",
        pluginId: "vikunja-sync",
        command: "thread:create",
      }),
      false,
    );

    const res = createBridgeResponse("cmd_1", { ok: true, result: { threadId: "t1" } });
    assert.strictEqual(res.ok, true);
    assert.deepStrictEqual(res.result, { threadId: "t1" });
  });

  it("discovers static & sidecar plugins in ~/.m3/plugins, spawns sidecar on dynamic port, and blocks path traversal", async () => {
    const tmpDir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "m3-plugin-host-test-"));
    const manager = new PluginHostManager({ m3HomeDir: tmpDir, builtinPluginsDirs: [] });
    try {
      // 1. Static HTML/JS plugin
      const staticDir = NodePath.join(tmpDir, "plugins", "dashboard");
      await NodeFSP.mkdir(staticDir, { recursive: true });
      await NodeFSP.writeFile(
        NodePath.join(staticDir, "plugin.json"),
        JSON.stringify({
          id: "dashboard",
          name: "Prompt Dashboard",
          version: "1.0.0",
          runtime: { type: "static", entry: "index.html" },
          slots: ["sidebar-tab"],
          subscriptions: ["thread:updated"],
        }),
      );
      await NodeFSP.writeFile(NodePath.join(staticDir, "index.html"), "<h1>M3 Dashboard</h1>");

      // 2. Sidecar Node HTTP server plugin
      const sidecarDir = NodePath.join(tmpDir, "plugins", "sidecar-demo");
      await NodeFSP.mkdir(sidecarDir, { recursive: true });
      await NodeFSP.writeFile(
        NodePath.join(sidecarDir, "plugin.json"),
        JSON.stringify({
          id: "sidecar-demo",
          name: "Sidecar Demo",
          version: "0.1.0",
          runtime: {
            type: "sidecar",
            command: process.execPath,
            args: ["server.mjs"],
            healthPath: "/health",
          },
          slots: ["right-panel"],
          subscriptions: ["agent:spawned"],
        }),
      );
      await NodeFSP.writeFile(
        NodePath.join(sidecarDir, "server.mjs"),
        `import http from "node:http";
const port = Number(process.env.M3_PLUGIN_PORT || process.env.PORT);
http.createServer((req, res) => {
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ ok: true, pluginId: process.env.M3_PLUGIN_ID, url: req.url }));
}).listen(port, "127.0.0.1");
`,
      );

      const listed = await manager.list();
      assert.strictEqual(listed.plugins.length, 2);

      const dashboard = listed.plugins.find((p) => p.manifest.id === "dashboard");
      assert.isDefined(dashboard);
      assert.strictEqual(dashboard.status, "active");
      assert.include(dashboard.entryUrl ?? "", "/api/m3-plugins/static/dashboard/index.html");

      // Static asset resolution & path traversal defense
      const indexAsset = await manager.resolveStaticAsset("dashboard", "index.html");
      assert.isNotNull(indexAsset);
      assert.strictEqual(new TextDecoder().decode(indexAsset.bytes), "<h1>M3 Dashboard</h1>");

      const traversalAsset = await manager.resolveStaticAsset("dashboard", "../../etc/passwd");
      assert.isNull(traversalAsset);

      // Sidecar spawned on dynamic localhost port and responds
      const sidecar = listed.plugins.find((p) => p.manifest.id === "sidecar-demo");
      assert.isDefined(sidecar);
      assert.strictEqual(sidecar.status, "active");
      assert.isNotNull(sidecar.sidecarPort);

      const healthRes = await fetch(`http://127.0.0.1:${sidecar.sidecarPort}/health`);
      assert.strictEqual(healthRes.status, 200);
      const body = (await healthRes.json()) as { ok: boolean; pluginId: string };
      assert.strictEqual(body.ok, true);
      assert.strictEqual(body.pluginId, "sidecar-demo");

      // Disable stops the sidecar cleanly
      const disabled = await manager.setEnabled("sidecar-demo", false);
      assert.strictEqual(disabled.enabled, false);
      assert.strictEqual(disabled.status, "disabled");
      assert.isNull(manager.getSidecarPort("sidecar-demo"));
    } finally {
      await manager.shutdown();
      await NodeFSP.rm(tmpDir, { recursive: true, force: true });
    }
  });
});
