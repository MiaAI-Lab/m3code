import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  AuthEnvironmentMaintainScope,
  AuthOrchestrationOperateScope,
  AuthSessionId,
  type AuthEnvironmentScope,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpRouter } from "effect/http";
import { afterEach, expect, it } from "vite-plus/test";

import * as EnvironmentAuth from "./auth/EnvironmentAuth.ts";
import * as ServerConfig from "./config.ts";
import * as M3PluginRoute from "./m3PluginRoute.ts";

const disposers: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const dispose of disposers.splice(0)) await dispose();
});

const fixture = (scopes: ReadonlyArray<AuthEnvironmentScope> | null) => {
  const { handler, dispose } = HttpRouter.toWebHandler(
    M3PluginRoute.routeLayer.pipe(
      Layer.provideMerge(
        Layer.mock(EnvironmentAuth.EnvironmentAuth)({
          authenticateWebSocketUpgrade: () =>
            scopes === null
              ? Effect.fail(new EnvironmentAuth.ServerAuthMissingCredentialError({}))
              : Effect.succeed({
                  sessionId: AuthSessionId.make("test"),
                  subject: "test",
                  method: "bearer-access-token",
                  scopes,
                }),
        }),
      ),
      Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "m3-plugin-route-" })),
      Layer.provideMerge(NodeServices.layer),
    ),
  );
  disposers.push(dispose);
  return handler;
};

const install = () =>
  new Request("http://t3.test/api/m3-plugins/install", {
    method: "POST",
    headers: { "content-type": "text/plain" },
    body: JSON.stringify({ source: "https://example.test/plugin.git" }),
  });

it.each([
  ["without credentials", null, 401],
  ["without the maintain scope", [AuthOrchestrationOperateScope], 403],
] as const)("refuses plugin installs %s", async (_label, scopes, status) => {
  const handler = fixture(scopes);
  expect((await handler(install())).status).toBe(status);
});

it("lists plugins for a session that may maintain the environment", async () => {
  const handler = fixture([AuthEnvironmentMaintainScope]);
  const response = await handler(new Request("http://t3.test/api/m3-plugins"));
  expect(response.status).toBe(200);
});
