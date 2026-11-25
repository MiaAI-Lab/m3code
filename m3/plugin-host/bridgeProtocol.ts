// @effect-diagnostics globalDate:off -- framework-agnostic bridge protocol shared by browser and server.
export const M3_PLUGIN_BRIDGE_VERSION = 1 as const;

export type M3BridgeCommandName =
  | "plugin:ready"
  | "thread:create"
  | "prompt:inject"
  | "file:open"
  | "toast:show"
  | "plugins:list";

export interface M3BridgeEventMessage {
  readonly version: typeof M3_PLUGIN_BRIDGE_VERSION;
  readonly type: "m3:event";
  readonly event: string;
  readonly payload: Record<string, unknown>;
  readonly timestamp: string;
}

export interface M3BridgeCommandMessage {
  readonly version: typeof M3_PLUGIN_BRIDGE_VERSION;
  readonly type: "m3:command";
  readonly id: string;
  readonly pluginId: string;
  readonly command: M3BridgeCommandName;
  readonly payload?: Record<string, unknown>;
}

export interface M3BridgeResponseMessage {
  readonly version: typeof M3_PLUGIN_BRIDGE_VERSION;
  readonly type: "m3:response";
  readonly id: string;
  readonly ok: boolean;
  readonly result?: unknown;
  readonly error?: string;
}

export type M3BridgeMessage =
  | M3BridgeEventMessage
  | M3BridgeCommandMessage
  | M3BridgeResponseMessage;

const VALID_COMMANDS: ReadonlySet<string> = new Set<M3BridgeCommandName>([
  "plugin:ready",
  "thread:create",
  "prompt:inject",
  "file:open",
  "toast:show",
  "plugins:list",
]);

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isM3BridgeCommandMessage(value: unknown): value is M3BridgeCommandMessage {
  if (!isObject(value)) return false;
  return (
    value.version === M3_PLUGIN_BRIDGE_VERSION &&
    value.type === "m3:command" &&
    typeof value.id === "string" &&
    typeof value.pluginId === "string" &&
    typeof value.command === "string" &&
    VALID_COMMANDS.has(value.command)
  );
}

export function isM3BridgeEventMessage(value: unknown): value is M3BridgeEventMessage {
  if (!isObject(value)) return false;
  return (
    value.version === M3_PLUGIN_BRIDGE_VERSION &&
    value.type === "m3:event" &&
    typeof value.event === "string" &&
    isObject(value.payload)
  );
}

export function createBridgeEvent(
  event: string,
  payload: Record<string, unknown>,
): M3BridgeEventMessage {
  return {
    version: M3_PLUGIN_BRIDGE_VERSION,
    type: "m3:event",
    event,
    payload,
    timestamp: new Date().toISOString(),
  };
}

export function createBridgeResponse(
  id: string,
  outcome:
    | { readonly ok: true; readonly result?: unknown }
    | { readonly ok: false; readonly error: string },
): M3BridgeResponseMessage {
  return outcome.ok
    ? {
        version: M3_PLUGIN_BRIDGE_VERSION,
        type: "m3:response",
        id,
        ok: true,
        ...(outcome.result !== undefined ? { result: outcome.result } : {}),
      }
    : {
        version: M3_PLUGIN_BRIDGE_VERSION,
        type: "m3:response",
        id,
        ok: false,
        error: outcome.error,
      };
}
