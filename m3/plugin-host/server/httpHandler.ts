// @effect-diagnostics globalFetch:off -- standalone M3 plugin host proxies requests to local sidecar servers over loopback HTTP.
import { M3_PLUGIN_SDK_SOURCE } from "../sdk/m3-plugin-sdk.ts";
import { PluginHostManager } from "./PluginHostManager.ts";

export interface M3PluginHttpRequest {
  readonly method: string;
  readonly url: string;
  readonly headers: Readonly<Record<string, string | ReadonlyArray<string> | undefined>>;
  readonly readText: () => Promise<string>;
  readonly readBytes: () => Promise<Uint8Array>;
}

export interface M3PluginHttpResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: Uint8Array | string;
}

function jsonResponse(body: unknown, status = 200): M3PluginHttpResponse {
  return {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
    body: JSON.stringify(body),
  };
}

function errorResponse(message: string, status = 400): M3PluginHttpResponse {
  return jsonResponse({ ok: false, error: message }, status);
}

async function readJsonBody(request: M3PluginHttpRequest): Promise<Record<string, unknown>> {
  try {
    const raw = await request.readText();
    const parsed = JSON.parse(raw);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

async function proxyToSidecar(
  manager: PluginHostManager,
  pluginId: string,
  subPath: string,
  search: string,
  request: M3PluginHttpRequest,
): Promise<M3PluginHttpResponse> {
  let port = manager.getSidecarPort(pluginId);
  if (port === null) {
    await manager.list();
    port = manager.getSidecarPort(pluginId);
  }
  if (port === null) {
    return errorResponse(`Sidecar for plugin "${pluginId}" is not running.`, 503);
  }

  const targetUrl = `http://127.0.0.1:${port}/${subPath.replace(/^\/+/, "")}${search}`;
  const method = request.method;
  const hasBody = method !== "GET" && method !== "HEAD";
  const body = hasBody ? await request.readBytes() : undefined;
  const contentType = request.headers["content-type"];
  const accept = request.headers["accept"];

  try {
    const upstream = await fetch(targetUrl, {
      method,
      headers: {
        ...(typeof contentType === "string" ? { "content-type": contentType } : {}),
        accept: typeof accept === "string" ? accept : "*/*",
      },
      ...(body !== undefined ? { body } : {}),
      signal: AbortSignal.timeout(15_000),
    });
    const bytes = new Uint8Array(await upstream.arrayBuffer());
    return {
      status: upstream.status,
      headers: {
        "content-type": upstream.headers.get("content-type") ?? "application/octet-stream",
        "cache-control": "no-store",
      },
      body: bytes,
    };
  } catch (err) {
    return errorResponse(
      `Sidecar proxy error: ${err instanceof Error ? err.message : String(err)}`,
      502,
    );
  }
}

export async function handleM3PluginHttpRequest(
  manager: PluginHostManager,
  request: M3PluginHttpRequest,
): Promise<M3PluginHttpResponse> {
  const parsedUrl = new URL(request.url, "http://localhost");
  const pathname = parsedUrl.pathname;
  const method = request.method;

  if (pathname === "/api/m3-plugins" && method === "GET") {
    return jsonResponse(await manager.list());
  }

  if (pathname === "/api/m3-plugins/sdk.js" && method === "GET") {
    return {
      status: 200,
      headers: {
        "content-type": "application/javascript; charset=utf-8",
        "cache-control": "no-store",
      },
      body: M3_PLUGIN_SDK_SOURCE,
    };
  }

  if (pathname === "/api/m3-plugins/install" && method === "POST") {
    const body = await readJsonBody(request);
    const source = typeof body.source === "string" ? body.source.trim() : "";
    if (!source) return errorResponse('Missing required field "source".', 400);
    try {
      const plugin = await manager.install({
        source,
        ...(typeof body.id === "string" && body.id.trim() ? { id: body.id.trim() } : {}),
        ...(body.link === true ? { link: true } : {}),
      });
      return jsonResponse({ ok: true, plugin });
    } catch (err) {
      return errorResponse(err instanceof Error ? err.message : String(err), 400);
    }
  }

  if (pathname === "/api/m3-plugins/uninstall" && method === "POST") {
    const body = await readJsonBody(request);
    const pluginId = typeof body.pluginId === "string" ? body.pluginId.trim() : "";
    if (!pluginId) return errorResponse('Missing required field "pluginId".', 400);
    const removed = await manager.uninstall(pluginId);
    return jsonResponse({ ok: true, removed, pluginId });
  }

  if (pathname === "/api/m3-plugins/toggle" && method === "POST") {
    const body = await readJsonBody(request);
    const pluginId = typeof body.pluginId === "string" ? body.pluginId.trim() : "";
    if (!pluginId || typeof body.enabled !== "boolean") {
      return errorResponse('Fields "pluginId" and boolean "enabled" are required.', 400);
    }
    try {
      const plugin = await manager.setEnabled(pluginId, body.enabled);
      return jsonResponse({ ok: true, plugin });
    } catch (err) {
      return errorResponse(err instanceof Error ? err.message : String(err), 404);
    }
  }

  if (pathname === "/api/m3-plugins/reload" && method === "POST") {
    const result = await manager.reload();
    return jsonResponse({ ok: true, ...result });
  }

  if (pathname === "/api/m3-plugins/event" && method === "POST") {
    const body = await readJsonBody(request);
    const eventName = typeof body.event === "string" ? body.event.trim() : "";
    const payload =
      typeof body.payload === "object" && body.payload !== null && !Array.isArray(body.payload)
        ? (body.payload as Record<string, unknown>)
        : {};
    if (!eventName) return errorResponse('Missing required field "event".', 400);
    const message = manager.publishEvent(eventName, payload);
    return jsonResponse({ ok: true, message });
  }

  const staticPrefix = "/api/m3-plugins/static/";
  if (pathname.startsWith(staticPrefix) && method === "GET") {
    const rest = pathname.slice(staticPrefix.length);
    const slashIdx = rest.indexOf("/");
    const pluginId = decodeURIComponent(slashIdx === -1 ? rest : rest.slice(0, slashIdx));
    const assetPath = slashIdx === -1 ? "index.html" : rest.slice(slashIdx + 1);
    const asset = await manager.resolveStaticAsset(pluginId, assetPath);
    if (!asset) return errorResponse("Plugin asset not found.", 404);
    return {
      status: 200,
      headers: {
        "content-type": asset.contentType,
        "cache-control": "no-store",
      },
      body: asset.bytes,
    };
  }

  const sidecarPrefix = "/api/m3-plugins/sidecar/";
  if (pathname.startsWith(sidecarPrefix)) {
    const rest = pathname.slice(sidecarPrefix.length);
    const slashIdx = rest.indexOf("/");
    const pluginId = decodeURIComponent(slashIdx === -1 ? rest : rest.slice(0, slashIdx));
    const subPath = slashIdx === -1 ? "" : rest.slice(slashIdx + 1);
    return proxyToSidecar(manager, pluginId, subPath, parsedUrl.search, request);
  }

  return errorResponse("Unknown M3 plugin endpoint.", 404);
}
