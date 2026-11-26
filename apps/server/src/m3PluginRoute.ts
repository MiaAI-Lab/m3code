import { AuthEnvironmentMaintainScope } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";

import { handleM3PluginHttpRequest } from "../../../m3/plugin-host/server/httpHandler.ts";
import { PluginHostManager } from "../../../m3/plugin-host/server/PluginHostManager.ts";
import { authenticateMediaRequest } from "./auth/http.ts";
import * as ServerConfig from "./config.ts";

/**
 * Thin Effect HttpRouter bridge to the standalone `m3/plugin-host` server.
 * Kept in its own file so upstream `apps/server/src/server.ts` only needs one line.
 */
export const routeLayer = Layer.unwrap(
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    const manager = new PluginHostManager({ m3HomeDir: config.baseDir });

    const handler = Effect.fn("M3PluginRoute.handle")(function* () {
      // Plugins install from git and run sidecar processes on the host, so they need admin rights.
      yield* authenticateMediaRequest(AuthEnvironmentMaintainScope);
      const request = yield* HttpServerRequest.HttpServerRequest;
      const hasBody = request.method !== "GET" && request.method !== "HEAD";
      const rawBytes = hasBody
        ? new Uint8Array(
            yield* request.arrayBuffer.pipe(Effect.orElseSucceed(() => new ArrayBuffer(0))),
          )
        : new Uint8Array(0);
      const response = yield* Effect.promise(() =>
        handleM3PluginHttpRequest(manager, {
          method: request.method,
          url: request.url,
          headers: request.headers,
          readText: async () => new TextDecoder().decode(rawBytes),
          readBytes: async () => rawBytes,
        }),
      );
      return typeof response.body === "string"
        ? HttpServerResponse.text(response.body, {
            status: response.status,
            headers: response.headers,
          })
        : HttpServerResponse.uint8Array(response.body, {
            status: response.status,
            headers: response.headers,
          });
    });

    const shutdownLayer = Layer.effectDiscard(
      Effect.addFinalizer(() => Effect.promise(() => manager.shutdown())),
    );

    return Layer.mergeAll(
      HttpRouter.add("GET", "/api/m3-plugins", handler()),
      HttpRouter.add("*", "/api/m3-plugins/*", handler()),
      shutdownLayer,
    );
  }),
);
