import type {
  EnvironmentId,
  LocalEngineKind,
  LocalEngineKvCacheQuant,
  LocalEngineLaunchConfig,
  LocalEnginesListResult,
  LocalEngineStatus,
  LocalHostHardware,
} from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import { Plural, T, useGT, Var } from "gt-react";
import {
  ArrowUpCircleIcon,
  CpuIcon,
  DownloadIcon,
  PackageIcon,
  PlayIcon,
  RotateCwIcon,
  SlidersHorizontalIcon,
  SquareIcon,
  TerminalIcon,
  Trash2Icon,
} from "lucide-react";
import { useEffect, useState } from "react";

import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { RefreshIcon } from "../ui/refresh-icon";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import { SettingsRow, SettingsSection } from "./settingsLayout";

function formatCommandError(
  result: { readonly _tag: string; readonly error?: unknown },
  fallback: string,
): string {
  if (
    result._tag === "Failure" &&
    result.error &&
    typeof result.error === "object" &&
    "message" in result.error &&
    typeof result.error.message === "string"
  ) {
    return result.error.message;
  }
  return fallback;
}

function formatBytes(bytes: number | undefined): string {
  if (bytes === undefined || !Number.isFinite(bytes) || bytes <= 0) return "-";
  const gb = bytes / 1024 ** 3;
  if (gb >= 1) return `${gb.toFixed(gb >= 100 ? 0 : 1)} GB`;
  const mb = bytes / 1024 ** 2;
  return `${Math.round(mb)} MB`;
}

function HardwareSummaryBar({ hardware }: { readonly hardware: LocalHostHardware }) {
  const memUsed = Math.max(0, hardware.totalMemoryBytes - hardware.freeMemoryBytes);
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border/60 bg-muted/20 px-4 py-2.5 text-xs text-muted-foreground">
      <div className="flex items-center gap-2">
        <CpuIcon className="size-3.5 shrink-0 text-foreground/70" aria-hidden />
        <span className="font-medium text-foreground">
          {hardware.gpuName ?? hardware.cpuModel ?? `${hardware.platform} (${hardware.arch})`}
        </span>
        <span>·</span>
        <span>
          <T>
            <Var>{hardware.cpuCores}</Var> cores
          </T>
        </span>
      </div>
      <div className="flex flex-wrap items-center gap-3">
        {hardware.unifiedMemory ? (
          <span>
            <T>
              Unified Memory:{" "}
              <strong className="text-foreground">
                <Var>{formatBytes(memUsed)}</Var>
              </strong>{" "}
              / <Var>{formatBytes(hardware.totalMemoryBytes)}</Var> (
              <Var>{formatBytes(hardware.freeMemoryBytes)}</Var> free)
            </T>
          </span>
        ) : (
          <>
            <span>
              <T>
                RAM:{" "}
                <strong className="text-foreground">
                  <Var>{formatBytes(memUsed)}</Var>
                </strong>{" "}
                / <Var>{formatBytes(hardware.totalMemoryBytes)}</Var>
              </T>
            </span>
            {hardware.vramTotalBytes !== undefined ? (
              <span>
                <T>
                  VRAM:{" "}
                  <strong className="text-foreground">
                    <Var>{formatBytes(hardware.vramUsedBytes)}</Var>
                  </strong>{" "}
                  / <Var>{formatBytes(hardware.vramTotalBytes)}</Var>
                </T>
              </span>
            ) : null}
          </>
        )}
      </div>
    </div>
  );
}

const CONTEXT_PRESETS = [
  { label: "8K", value: 8192 },
  { label: "32K", value: 32768 },
  { label: "64K", value: 65536 },
  { label: "128K", value: 131072 },
] as const;

export function LocalEnginesSection({
  environmentId,
  readOnly,
}: {
  readonly environmentId: EnvironmentId;
  readonly readOnly: boolean;
}) {
  const gt = useGT();
  const canList = useAtomValue(serverEnvironment.listLocalEngines.permissionAtom(environmentId));
  const canControl = useAtomValue(
    serverEnvironment.controlLocalEngine.permissionAtom(environmentId),
  );
  const listEngines = useAtomCommand(serverEnvironment.listLocalEngines, {
    label: "list local model engines",
  });
  const controlEngine = useAtomCommand(serverEnvironment.controlLocalEngine, {
    label: "control local model engine",
  });
  const updateEngine = useAtomCommand(serverEnvironment.updateLocalEngine, {
    label: "update local model engine",
  });
  const manageModel = useAtomCommand(serverEnvironment.manageLocalEngineModel, {
    label: "manage local engine model",
  });
  const saveConfig = useAtomCommand(serverEnvironment.saveLocalEngineConfig, {
    label: "save local engine options",
  });
  const getLogs = useAtomCommand(serverEnvironment.getLocalEngineLogs, {
    label: "fetch local engine logs",
  });

  const [data, setData] = useState<LocalEnginesListResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [busyKind, setBusyKind] = useState<LocalEngineKind | null>(null);
  const [notice, setNotice] = useState<{
    readonly tone: "info" | "error";
    readonly text: string;
  } | null>(null);
  const [configEngine, setConfigEngine] = useState<LocalEngineStatus | null>(null);
  const [modelsEngine, setModelsEngine] = useState<LocalEngineStatus | null>(null);
  const [logsEngine, setLogsEngine] = useState<{
    readonly engine: LocalEngineStatus;
    readonly lines: ReadonlyArray<string>;
  } | null>(null);

  const refresh = async (fresh = false) => {
    if (!canList) return;
    setLoading(true);
    const result = await listEngines({ environmentId, input: { fresh } });
    if (result._tag === "Success") {
      setData(result.value);
    } else {
      setNotice({
        tone: "error",
        text: formatCommandError(result, gt("Failed to inspect local model engines.")),
      });
    }
    setLoading(false);
  };

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- loads live local engine status from the connected environment over RPC when mounted or when environment changes
  useEffect(() => {
    if (!canList) return;
    let cancelled = false;
    void listEngines({ environmentId, input: { fresh: false } }).then((result) => {
      if (cancelled) return;
      if (result._tag === "Success") {
        setData(result.value);
      } else {
        setNotice({
          tone: "error",
          text: formatCommandError(result, gt("Failed to inspect local model engines.")),
        });
      }
    });
    return () => {
      cancelled = true;
    };
  }, [canList, environmentId, gt, listEngines]);

  const replaceEngine = (updated: LocalEngineStatus) => {
    setData((prev) =>
      prev
        ? {
            ...prev,
            engines: prev.engines.map((item) => (item.kind === updated.kind ? updated : item)),
          }
        : prev,
    );
    setModelsEngine((prev) => (prev?.kind === updated.kind ? updated : prev));
    setConfigEngine((prev) => (prev?.kind === updated.kind ? updated : prev));
  };

  const handleControl = async (
    kind: LocalEngineKind,
    action: "start" | "stop" | "restart",
    launchConfig?: LocalEngineLaunchConfig,
  ) => {
    setBusyKind(kind);
    setNotice(null);
    const result = await controlEngine({
      environmentId,
      input: { kind, action, ...(launchConfig ? { launchConfig } : {}) },
    });
    if (result._tag === "Success") {
      replaceEngine(result.value.engine);
      setNotice({ tone: "info", text: result.value.message });
    } else {
      setNotice({
        tone: "error",
        text: formatCommandError(result, gt("Failed to {action} {kind}.", { action, kind })),
      });
    }
    setBusyKind(null);
  };

  const handleUpdate = async (kind: LocalEngineKind) => {
    setBusyKind(kind);
    setNotice(null);
    const result = await updateEngine({ environmentId, input: { kind } });
    if (result._tag === "Success") {
      setNotice({ tone: "info", text: result.value.message });
      await refresh(true);
    } else {
      setNotice({
        tone: "error",
        text: formatCommandError(result, gt("Failed to update {kind}.", { kind })),
      });
    }
    setBusyKind(null);
  };

  const handleOpenLogs = async (engine: LocalEngineStatus) => {
    const result = await getLogs({ environmentId, input: { kind: engine.kind, limit: 200 } });
    setLogsEngine({
      engine,
      lines: result._tag === "Success" ? result.value.lines : engine.recentLogs,
    });
  };

  const sortedEngines = [...(data?.engines ?? [])].toSorted((a, b) => {
    if (a.running !== b.running) return a.running ? -1 : 1;
    if (a.installed !== b.installed) return a.installed ? -1 : 1;
    return 0;
  });

  const editable = !readOnly && canControl;

  return (
    <>
      <SettingsSection
        title={gt("Local Model Engines")}
        headerAction={
          <Button
            size="xs"
            variant="ghost-muted"
            disabled={loading || !canList}
            aria-busy={loading}
            onClick={() => void refresh(true)}
          >
            <RefreshIcon refreshing={loading} />
            {loading ? <T>Scanning</T> : <T>Refresh</T>}
          </Button>
        }
      >
        {data?.hardware ? <HardwareSummaryBar hardware={data.hardware} /> : null}
        {notice ? (
          <div
            role={notice.tone === "error" ? "alert" : "status"}
            className={
              notice.tone === "error"
                ? "border-b border-destructive/30 bg-destructive/10 px-4 py-2 text-xs text-destructive"
                : "border-b border-border/60 bg-muted/30 px-4 py-2 text-xs text-muted-foreground"
            }
          >
            {notice.text}
          </div>
        ) : null}
        {sortedEngines.length === 0 ? (
          <SettingsRow
            title={
              loading ? gt("Scanning local model engines...") : gt("No local engine data yet.")
            }
            description={gt(
              "Click Refresh to detect Ollama, llama.cpp, MLX, LM Studio, vLLM, SGLang, and Omega on this environment.",
            )}
          />
        ) : (
          sortedEngines.map((engine) => {
            const busy = busyKind === engine.kind;
            return (
              <SettingsRow
                key={engine.kind}
                title={
                  <span className="flex flex-wrap items-center gap-1.5">
                    <span>{engine.displayName}</span>
                    {engine.running ? (
                      <Badge variant="success" size="sm">
                        <T>Running</T>
                      </Badge>
                    ) : engine.installed ? (
                      <Badge variant="outline" size="sm">
                        <T>Installed</T>
                      </Badge>
                    ) : (
                      <Badge variant="secondary" size="sm">
                        <T>Not installed</T>
                      </Badge>
                    )}
                    {engine.version ? (
                      <Badge variant="outline" size="sm">
                        {`v${engine.version}`}
                      </Badge>
                    ) : null}
                    {engine.registeredServerId ? (
                      <Badge variant="secondary" size="sm">
                        <T>Gateway linked</T>
                      </Badge>
                    ) : null}
                  </span>
                }
                description={
                  <span className="flex flex-col gap-1">
                    <span>{engine.description}</span>
                    {engine.installed ? (
                      <span className="font-mono text-2xs text-muted-foreground">
                        {engine.baseUrl}
                        {engine.activeModels.length > 0
                          ? ` · ${gt("Active: {models}", { models: engine.activeModels.slice(0, 3).join(", ") })}`
                          : engine.launchConfig.model
                            ? ` · ${gt("Default model: {model}", { model: engine.launchConfig.model })}`
                            : ""}
                        {engine.launchConfig.contextLength
                          ? ` · ${gt("{size}K ctx", { size: Math.round(engine.launchConfig.contextLength / 1024) })}`
                          : ""}
                      </span>
                    ) : engine.installHint ? (
                      <span className="font-mono text-2xs text-muted-foreground">
                        <T>
                          Install: <Var>{engine.installHint}</Var>
                        </T>
                      </span>
                    ) : null}
                    {engine.lastError ? (
                      <span className="text-2xs text-destructive">{engine.lastError}</span>
                    ) : null}
                  </span>
                }
                control={
                  engine.installed ? (
                    <div className="flex flex-wrap items-center justify-end gap-1">
                      {editable ? (
                        engine.running ? (
                          <>
                            <Button
                              size="xs"
                              variant="outline"
                              disabled={busy}
                              onClick={() => void handleControl(engine.kind, "restart")}
                              title={gt("Restart engine")}
                            >
                              <RotateCwIcon className="size-3" aria-hidden />
                              <T>Restart</T>
                            </Button>
                            <Button
                              size="xs"
                              variant="outline"
                              disabled={busy}
                              onClick={() => void handleControl(engine.kind, "stop")}
                              title={gt("Stop engine")}
                            >
                              <SquareIcon className="size-3" aria-hidden />
                              <T>Stop</T>
                            </Button>
                          </>
                        ) : (
                          <Button
                            size="xs"
                            variant="default"
                            disabled={busy}
                            onClick={() => void handleControl(engine.kind, "start")}
                            title={gt("Start engine")}
                          >
                            <PlayIcon className="size-3" aria-hidden />
                            <T>Start</T>
                          </Button>
                        )
                      ) : null}
                      <Button
                        size="xs"
                        variant="ghost-muted"
                        disabled={busy}
                        onClick={() => setModelsEngine(engine)}
                      >
                        <PackageIcon className="size-3" aria-hidden />
                        <T>
                          Models (<Var>{engine.localModels.length}</Var>)
                        </T>
                      </Button>
                      {editable ? (
                        <Button
                          size="xs"
                          variant="ghost-muted"
                          disabled={busy}
                          onClick={() => setConfigEngine(engine)}
                        >
                          <SlidersHorizontalIcon className="size-3" aria-hidden />
                          <T>Options</T>
                        </Button>
                      ) : null}
                      {editable && engine.capabilities.canUpdate ? (
                        <Button
                          size="xs"
                          variant="ghost-muted"
                          disabled={busy}
                          onClick={() => void handleUpdate(engine.kind)}
                          title={gt("Check & run engine update")}
                        >
                          <ArrowUpCircleIcon className="size-3" aria-hidden />
                          <T>Update</T>
                        </Button>
                      ) : null}
                      {engine.managedByServer || engine.recentLogs.length > 0 ? (
                        <Button
                          size="xs"
                          variant="ghost-muted"
                          disabled={busy}
                          onClick={() => void handleOpenLogs(engine)}
                          title={gt("View engine logs")}
                        >
                          <TerminalIcon className="size-3" aria-hidden />
                          <T>Logs</T>
                        </Button>
                      ) : null}
                    </div>
                  ) : null
                }
              />
            );
          })
        )}
      </SettingsSection>

      {configEngine ? (
        <EngineOptionsDialog
          engine={configEngine}
          onClose={() => setConfigEngine(null)}
          onSave={async (nextConfig, restartAfter) => {
            setBusyKind(configEngine.kind);
            if (restartAfter) {
              await handleControl(
                configEngine.kind,
                configEngine.running ? "restart" : "start",
                nextConfig,
              );
            } else {
              const res = await saveConfig({
                environmentId,
                input: { kind: configEngine.kind, launchConfig: nextConfig },
              });
              if (res._tag === "Success") {
                replaceEngine(res.value.engine);
                setNotice({
                  tone: "info",
                  text: gt("Saved launch options for {engine}.", {
                    engine: configEngine.displayName,
                  }),
                });
              } else {
                setNotice({
                  tone: "error",
                  text: formatCommandError(res, gt("Failed to save engine options.")),
                });
              }
            }
            setBusyKind(null);
            setConfigEngine(null);
          }}
        />
      ) : null}

      {modelsEngine ? (
        <EngineModelsDialog
          engine={modelsEngine}
          editable={editable}
          onClose={() => setModelsEngine(null)}
          onAction={async (action, model) => {
            setBusyKind(modelsEngine.kind);
            const res = await manageModel({
              environmentId,
              input: { kind: modelsEngine.kind, action, model },
            });
            setBusyKind(null);
            if (res._tag === "Success") {
              replaceEngine(res.value.engine);
              setNotice({ tone: "info", text: res.value.message });
              return { ok: true, message: res.value.message };
            }
            const errMsg = formatCommandError(
              res,
              gt("Failed to {action} {model}.", { action, model }),
            );
            setNotice({ tone: "error", text: errMsg });
            return { ok: false, message: errMsg };
          }}
          onSelectDefaultModel={async (model) => {
            const nextConfig: LocalEngineLaunchConfig = {
              ...modelsEngine.launchConfig,
              model,
            };
            const res = await saveConfig({
              environmentId,
              input: { kind: modelsEngine.kind, launchConfig: nextConfig },
            });
            if (res._tag === "Success") {
              replaceEngine(res.value.engine);
              setNotice({
                tone: "info",
                text: gt("Set {model} as default launch model for {engine}.", {
                  model,
                  engine: modelsEngine.displayName,
                }),
              });
            }
          }}
        />
      ) : null}

      {logsEngine ? (
        <Dialog open onOpenChange={(open) => (!open ? setLogsEngine(null) : undefined)}>
          <DialogPopup className="max-w-2xl">
            <DialogHeader>
              <DialogTitle>
                <T>
                  <Var>{logsEngine.engine.displayName}</Var> Logs
                </T>
              </DialogTitle>
              <DialogDescription>
                <T>Recent stdout/stderr from the M3 Code managed engine process.</T>
              </DialogDescription>
            </DialogHeader>
            <DialogPanel>
              <pre className="max-h-96 overflow-auto rounded-md border border-border bg-muted/40 p-3 font-mono text-2xs leading-relaxed whitespace-pre-wrap">
                {logsEngine.lines.length > 0
                  ? logsEngine.lines.join("\n")
                  : gt("No log lines captured yet.")}
              </pre>
            </DialogPanel>
            <DialogFooter>
              <Button
                size="sm"
                variant="outline"
                onClick={() => void handleOpenLogs(logsEngine.engine)}
              >
                <T>Refresh logs</T>
              </Button>
              <Button size="sm" onClick={() => setLogsEngine(null)}>
                <T>Close</T>
              </Button>
            </DialogFooter>
          </DialogPopup>
        </Dialog>
      ) : null}
    </>
  );
}

function EngineOptionsDialog({
  engine,
  onClose,
  onSave,
}: {
  readonly engine: LocalEngineStatus;
  readonly onClose: () => void;
  readonly onSave: (config: LocalEngineLaunchConfig, restartAfter: boolean) => Promise<void>;
}) {
  const gt = useGT();
  const [port, setPort] = useState(String(engine.launchConfig.port ?? engine.defaultPort));
  const [host, setHost] = useState(engine.launchConfig.host ?? "127.0.0.1");
  const [model, setModel] = useState(engine.launchConfig.model ?? "");
  const [contextLength, setContextLength] = useState(
    engine.launchConfig.contextLength ? String(engine.launchConfig.contextLength) : "",
  );
  const [gpuLayers, setGpuLayers] = useState(
    engine.launchConfig.gpuLayers !== undefined ? String(engine.launchConfig.gpuLayers) : "",
  );
  const [kvCacheQuant, setKvCacheQuant] = useState<LocalEngineKvCacheQuant>(
    engine.launchConfig.kvCacheQuant ?? "auto",
  );
  const [parallelSlots, setParallelSlots] = useState(
    engine.launchConfig.parallelSlots ? String(engine.launchConfig.parallelSlots) : "",
  );
  const [flashAttention, setFlashAttention] = useState(engine.launchConfig.flashAttention ?? true);
  const [extraArgs, setExtraArgs] = useState(engine.launchConfig.extraArgs ?? "");
  const [autoRegister, setAutoRegister] = useState(engine.launchConfig.autoRegister ?? true);
  const [saving, setSaving] = useState(false);

  const buildConfig = (): LocalEngineLaunchConfig => {
    const parsedPort = Number(port);
    const parsedCtx = Number(contextLength);
    const parsedGpu = Number(gpuLayers);
    const parsedParallel = Number(parallelSlots);
    return {
      ...(Number.isInteger(parsedPort) && parsedPort > 0 ? { port: parsedPort } : {}),
      ...(host.trim() ? { host: host.trim() } : {}),
      ...(model.trim() ? { model: model.trim() } : {}),
      ...(Number.isInteger(parsedCtx) && parsedCtx > 0 ? { contextLength: parsedCtx } : {}),
      ...(gpuLayers.trim() !== "" && Number.isInteger(parsedGpu) && parsedGpu >= 0
        ? { gpuLayers: parsedGpu }
        : {}),
      kvCacheQuant,
      ...(Number.isInteger(parsedParallel) && parsedParallel > 0
        ? { parallelSlots: parsedParallel }
        : {}),
      flashAttention,
      ...(extraArgs.trim() ? { extraArgs: extraArgs.trim() } : {}),
      autoRegister,
    };
  };

  const submit = async (restartAfter: boolean) => {
    setSaving(true);
    await onSave(buildConfig(), restartAfter);
    setSaving(false);
  };

  return (
    <Dialog open onOpenChange={(open) => (!open ? onClose() : undefined)}>
      <DialogPopup className="max-w-lg">
        <DialogHeader>
          <DialogTitle>
            <T>
              <Var>{engine.displayName}</Var> Launch Options
            </T>
          </DialogTitle>
          <DialogDescription>
            <T>Configure port, model, context window, KV cache quantization, and CLI flags.</T>
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <Label htmlFor="le-host">
                  <T>Host</T>
                </Label>
                <Input
                  id="le-host"
                  value={host}
                  onChange={(e) => setHost(e.target.value)}
                  placeholder="127.0.0.1"
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="le-port">
                  <T>Port</T>
                </Label>
                <Input
                  id="le-port"
                  type="number"
                  value={port}
                  onChange={(e) => setPort(e.target.value)}
                  placeholder={String(engine.defaultPort)}
                />
              </div>
            </div>

            <div className="space-y-1">
              <Label htmlFor="le-model">
                <T>Default model (path, Hugging Face repo, or tag)</T>
              </Label>
              <Input
                id="le-model"
                value={model}
                onChange={(e) => setModel(e.target.value)}
                placeholder={
                  engine.kind === "mlx"
                    ? "mlx-community/Qwen3-32B-4bit"
                    : engine.kind === "llama-cpp"
                      ? gt("/path/to/model.gguf or bartowski/Qwen3-32B-GGUF")
                      : "qwen3:32b"
                }
              />
            </div>

            <div className="space-y-1">
              <div className="flex items-center justify-between">
                <Label htmlFor="le-ctx">
                  <T>Context length (tokens)</T>
                </Label>
                <div className="flex items-center gap-1">
                  {CONTEXT_PRESETS.map((preset) => (
                    <Button
                      key={preset.label}
                      type="button"
                      size="xs"
                      variant="ghost-muted"
                      onClick={() => setContextLength(String(preset.value))}
                    >
                      {preset.label}
                    </Button>
                  ))}
                </div>
              </div>
              <Input
                id="le-ctx"
                type="number"
                value={contextLength}
                onChange={(e) => setContextLength(e.target.value)}
                placeholder={gt("e.g. 32768 or 131072")}
              />
            </div>

            <div className="grid grid-cols-3 gap-3">
              <div className="space-y-1">
                <Label htmlFor="le-ngl">
                  <T>GPU layers</T>
                </Label>
                <Input
                  id="le-ngl"
                  type="number"
                  value={gpuLayers}
                  onChange={(e) => setGpuLayers(e.target.value)}
                  placeholder="999"
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="le-kv">
                  <T>KV cache</T>
                </Label>
                <Select
                  value={kvCacheQuant}
                  onValueChange={(value) => {
                    if (value) setKvCacheQuant(value as LocalEngineKvCacheQuant);
                  }}
                >
                  <SelectTrigger id="le-kv">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectPopup>
                    <SelectItem value="auto">
                      <T>Auto</T>
                    </SelectItem>
                    <SelectItem value="f16">FP16</SelectItem>
                    <SelectItem value="q8_0">Q8_0</SelectItem>
                    <SelectItem value="q4_0">Q4_0</SelectItem>
                    <SelectItem value="fp8">FP8</SelectItem>
                  </SelectPopup>
                </Select>
              </div>
              <div className="space-y-1">
                <Label htmlFor="le-parallel">
                  <T>Parallel slots</T>
                </Label>
                <Input
                  id="le-parallel"
                  type="number"
                  value={parallelSlots}
                  onChange={(e) => setParallelSlots(e.target.value)}
                  placeholder="2"
                />
              </div>
            </div>

            <div className="space-y-1">
              <Label htmlFor="le-extra">
                <T>Extra CLI arguments</T>
              </Label>
              <Input
                id="le-extra"
                value={extraArgs}
                onChange={(e) => setExtraArgs(e.target.value)}
                placeholder={gt("e.g. --cache-reuse 256 --jinja")}
              />
            </div>

            <div className="flex items-center justify-between rounded-md border border-border/60 px-3 py-2">
              <div>
                <p className="text-xs font-medium">
                  <T>Flash Attention</T>
                </p>
                <p className="text-2xs text-muted-foreground">
                  <T>Enable Flash Attention when supported by this engine.</T>
                </p>
              </div>
              <Switch checked={flashAttention} onCheckedChange={setFlashAttention} />
            </div>

            <div className="flex items-center justify-between rounded-md border border-border/60 px-3 py-2">
              <div>
                <p className="text-xs font-medium">
                  <T>Auto-register in Inference Servers</T>
                </p>
                <p className="text-2xs text-muted-foreground">
                  <T>Automatically link this engine to M3 Code&apos;s gateway when started.</T>
                </p>
              </div>
              <Switch checked={autoRegister} onCheckedChange={setAutoRegister} />
            </div>
          </div>
        </DialogPanel>
        <DialogFooter>
          <Button size="sm" variant="ghost-muted" disabled={saving} onClick={onClose}>
            <T>Cancel</T>
          </Button>
          <Button size="sm" variant="outline" disabled={saving} onClick={() => void submit(false)}>
            <T>Save</T>
          </Button>
          <Button size="sm" disabled={saving} onClick={() => void submit(true)}>
            {engine.running ? <T>Save &amp; Restart</T> : <T>Save &amp; Start</T>}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

function EngineModelsDialog({
  engine,
  editable,
  onClose,
  onAction,
  onSelectDefaultModel,
}: {
  readonly engine: LocalEngineStatus;
  readonly editable: boolean;
  readonly onClose: () => void;
  readonly onAction: (
    action: "pull" | "load" | "unload" | "delete",
    model: string,
  ) => Promise<{ readonly ok: boolean; readonly message: string }>;
  readonly onSelectDefaultModel: (model: string) => Promise<void>;
}) {
  const gt = useGT();
  const [pullName, setPullName] = useState("");
  const [busyModel, setBusyModel] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<string | null>(null);

  const runAction = async (action: "pull" | "load" | "unload" | "delete", model: string) => {
    setBusyModel(model);
    setFeedback(null);
    const res = await onAction(action, model);
    setFeedback(res.message);
    setBusyModel(null);
    if (action === "pull" && res.ok) setPullName("");
  };

  return (
    <Dialog open onOpenChange={(open) => (!open ? onClose() : undefined)}>
      <DialogPopup className="max-w-xl">
        <DialogHeader>
          <DialogTitle>
            <T>
              <Var>{engine.displayName}</Var> Models
            </T>
          </DialogTitle>
          <DialogDescription>
            <T>
              <Plural
                n={engine.localModels.length}
                one={
                  <>
                    <Var>{engine.localModels.length}</Var> local model detected.
                  </>
                }
                other={
                  <>
                    <Var>{engine.localModels.length}</Var> local models detected.
                  </>
                }
              />
            </T>
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <div className="space-y-3">
            {editable && engine.capabilities.canPullModels ? (
              <form
                className="flex items-center gap-2"
                onSubmit={(e) => {
                  e.preventDefault();
                  if (pullName.trim()) void runAction("pull", pullName.trim());
                }}
              >
                <Input
                  value={pullName}
                  onChange={(e) => setPullName(e.target.value)}
                  placeholder={
                    engine.kind === "ollama"
                      ? gt("Pull model tag (e.g. qwen3:32b, llama3.3:latest)")
                      : gt("Download model key")
                  }
                  disabled={busyModel !== null}
                />
                <Button type="submit" size="sm" disabled={!pullName.trim() || busyModel !== null}>
                  <DownloadIcon className="size-3.5" aria-hidden />
                  {busyModel === pullName.trim() && pullName.trim() ? (
                    <T>Pulling...</T>
                  ) : (
                    <T>Pull</T>
                  )}
                </Button>
              </form>
            ) : null}

            {feedback ? (
              <p className="rounded-md bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
                {feedback}
              </p>
            ) : null}

            {engine.localModels.length === 0 ? (
              <p className="py-6 text-center text-xs text-muted-foreground">
                <T>
                  No local models found yet for <Var>{engine.displayName}</Var>.
                </T>
              </p>
            ) : (
              <div className="max-h-80 divide-y divide-border/60 overflow-auto rounded-md border border-border/60">
                {engine.localModels.map((model) => {
                  const isBusy = busyModel === model.id;
                  return (
                    <div
                      key={model.id}
                      className="flex items-center justify-between gap-2 px-3 py-2 text-xs"
                    >
                      <div className="min-w-0">
                        <div className="flex items-center gap-1.5">
                          <span className="truncate font-mono font-medium">{model.id}</span>
                          {model.loaded ? (
                            <Badge variant="success" size="sm">
                              <T>Loaded</T>
                            </Badge>
                          ) : null}
                          {model.quantization ? (
                            <Badge variant="outline" size="sm">
                              {model.quantization}
                            </Badge>
                          ) : null}
                        </div>
                        {model.sizeBytes !== undefined ? (
                          <span className="text-2xs text-muted-foreground">
                            {formatBytes(model.sizeBytes)}
                          </span>
                        ) : null}
                      </div>
                      {editable ? (
                        <div className="flex shrink-0 items-center gap-1">
                          {engine.capabilities.canLoadUnload ? (
                            model.loaded ? (
                              <Button
                                size="xs"
                                variant="outline"
                                disabled={isBusy}
                                onClick={() => void runAction("unload", model.id)}
                              >
                                <T>Unload</T>
                              </Button>
                            ) : (
                              <Button
                                size="xs"
                                variant="outline"
                                disabled={isBusy}
                                onClick={() => void runAction("load", model.id)}
                              >
                                <T>Load</T>
                              </Button>
                            )
                          ) : (
                            <Button
                              size="xs"
                              variant="outline"
                              disabled={isBusy}
                              onClick={() => void onSelectDefaultModel(model.id)}
                            >
                              <T>Use on start</T>
                            </Button>
                          )}
                          {engine.capabilities.canDeleteModels ? (
                            <Button
                              size="xs"
                              variant="ghost-muted"
                              disabled={isBusy}
                              onClick={() => void runAction("delete", model.id)}
                              title={gt("Delete model")}
                            >
                              <Trash2Icon className="size-3" aria-hidden />
                            </Button>
                          ) : null}
                        </div>
                      ) : null}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </DialogPanel>
        <DialogFooter>
          <Button size="sm" onClick={onClose}>
            <T>Close</T>
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
