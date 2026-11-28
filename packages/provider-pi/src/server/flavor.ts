import { ProviderDriverKind, type UsageProviderKind } from "@t3tools/contracts";

export interface PiFlavor {
  readonly driverKind: ProviderDriverKind;
  readonly displayName: string;
  readonly binaryName: string;
  readonly npmPackageName: string;
  readonly miseTool?: string;
  readonly probeDirName: string;
  readonly defaultAgentDirSegments: readonly [string, ...string[]];
  readonly usageProvider: UsageProviderKind;
  /** Tool name this CLI uses for subagent fan-out (pi-subagents: "subagent"; OMP: "task"). */
  readonly subagentToolName?: string;
}

export const PI_FLAVOR: PiFlavor = {
  driverKind: ProviderDriverKind.make("pi"),
  displayName: "Pi",
  binaryName: "pi",
  npmPackageName: "@earendil-works/pi-coding-agent",
  miseTool: "pi",
  probeDirName: "pi-status-probe",
  defaultAgentDirSegments: [".pi", "agent"],
  usageProvider: "pi",
  subagentToolName: "subagent",
};
