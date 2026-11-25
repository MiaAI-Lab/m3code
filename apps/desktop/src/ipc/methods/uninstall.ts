import { DesktopUninstallPlanSchema } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import * as DesktopUninstall from "../../app/DesktopUninstall.ts";
import * as IpcChannels from "../channels.ts";
import { makeIpcMethod } from "../DesktopIpc.ts";

export const getUninstallPlan = makeIpcMethod({
  channel: IpcChannels.UNINSTALL_GET_PLAN_CHANNEL,
  payload: Schema.Void,
  result: DesktopUninstallPlanSchema,
  handler: Effect.fn("desktop.ipc.uninstall.getPlan")(function* () {
    return yield* (yield* DesktopUninstall.DesktopUninstall).getPlan;
  }),
});

export const runUninstall = makeIpcMethod({
  channel: IpcChannels.UNINSTALL_RUN_CHANNEL,
  payload: Schema.Void,
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.uninstall.run")(function* () {
    return yield* (yield* DesktopUninstall.DesktopUninstall).run;
  }),
});
