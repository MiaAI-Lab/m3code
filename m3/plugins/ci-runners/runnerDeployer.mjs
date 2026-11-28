import * as NodeChildProcess from "node:child_process";

import { normalizeLabels, RUNNER_PROVIDERS } from "./runnerStore.mjs";

export const DEPLOY_MODES = ["docker", "systemd", "ssh"];

const SAFE_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/;
const SAFE_HOST_RE = /^[a-zA-Z0-9._:-]+$/;
const SAFE_USER_RE = /^[a-zA-Z0-9._-]+$/;

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function sanitizeRunnerName(raw) {
  const cleaned = String(raw ?? "m3-runner")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
  return cleaned.length > 0 && SAFE_NAME_RE.test(cleaned) ? cleaned : "m3-runner";
}

function sanitizePort(raw, fallback) {
  const num = Number(raw ?? fallback);
  if (!Number.isInteger(num) || num < 1 || num > 65535) {
    throw new Error(`Invalid port: ${raw}`);
  }
  return num;
}

function sanitizeConcurrency(raw) {
  const num = Number(raw ?? 2);
  if (!Number.isInteger(num) || num < 1 || num > 64) {
    throw new Error(`Invalid concurrency: ${raw} (expected 1..64)`);
  }
  return num;
}

/**
 * Zero-dependency self-hosted HTTP CI runner daemon (`m3-runner-agent.mjs`).
 * Teams can deploy this directly on any Linux/macOS host via Docker, systemd, or SSH
 * and manage it over the M3 CI Runners plugin API.
 */
export const M3_RUNNER_AGENT_SCRIPT = `#!/usr/bin/env node
import * as http from "node:http";
import * as cp from "node:child_process";
import * as crypto from "node:crypto";
import * as os from "node:os";

const PORT = Number(process.env.M3_RUNNER_PORT || process.env.PORT || 8787);
const HOST = process.env.M3_RUNNER_HOST || "0.0.0.0";
const NAME = process.env.M3_RUNNER_NAME || os.hostname();
const TOKEN = process.env.M3_RUNNER_TOKEN || "";
const WORKDIR = process.env.M3_RUNNER_WORKDIR || process.cwd();
const CONCURRENCY = Math.max(1, Number(process.env.M3_RUNNER_CONCURRENCY || 2));
const LABELS = (process.env.M3_RUNNER_LABELS || "self-hosted,m3-runner")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

if (!TOKEN && !["127.0.0.1", "localhost", "::1"].includes(HOST)) {
  console.error("[m3-runner-agent] M3_RUNNER_TOKEN is required when listening beyond loopback.");
  process.exit(1);
}

const runs = new Map();
const procs = new Map();

function activeCount() {
  let n = 0;
  for (const r of runs.values()) if (r.status === "in_progress") n++;
  return n;
}

function sendJson(res, status, data) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(data));
}

function isAuthorized(req) {
  if (!TOKEN) return true;
  const auth = req.headers.authorization || "";
  return auth === \`Bearer \${TOKEN}\`;
}

function readJson(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"));
      } catch {
        resolve({});
      }
    });
  });
}

http.createServer(async (req, res) => {
  if (!isAuthorized(req)) return sendJson(res, 401, { error: "Unauthorized" });
  const url = new URL(req.url || "/", "http://localhost");
  const pathname = url.pathname;

  if (req.method === "GET" && pathname === "/health") {
    const activeJobs = activeCount();
    return sendJson(res, 200, {
      ok: true,
      name: NAME,
      version: "1.0.0",
      platform: process.platform,
      arch: process.arch,
      labels: LABELS,
      concurrency: CONCURRENCY,
      activeJobs,
      busy: activeJobs >= CONCURRENCY,
    });
  }

  if (req.method === "GET" && pathname === "/runs") {
    const limit = Math.min(100, Math.max(1, Number(url.searchParams.get("limit") || 20)));
    const list = [...runs.values()]
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, limit)
      .map(({ logs: _logs, ...meta }) => meta);
    return sendJson(res, 200, { runs: list });
  }

  if (req.method === "POST" && pathname === "/runs") {
    if (activeCount() >= CONCURRENCY) {
      return sendJson(res, 429, { error: "Runner at max concurrency." });
    }
    const body = await readJson(req);
    const command = typeof body.command === "string" ? body.command.trim() : "";
    if (!command) return sendJson(res, 400, { error: 'Field "command" is required.' });
    const id = \`run_\${crypto.randomBytes(6).toString("hex")}\`;
    const startedAt = Date.now();
    const record = {
      id,
      name: body.workflow || command.slice(0, 60),
      ref: body.ref || "main",
      command,
      status: "in_progress",
      conclusion: null,
      exitCode: null,
      durationMs: null,
      createdAt: new Date(startedAt).toISOString(),
      logs: \`$ \${command}\\n\`,
    };
    runs.set(id, record);
    const child = cp.spawn("sh", ["-lc", command], {
      cwd: typeof body.cwd === "string" && body.cwd.trim() ? body.cwd.trim() : WORKDIR,
      env: { ...process.env, ...(body.env && typeof body.env === "object" ? body.env : {}) },
      stdio: ["ignore", "pipe", "pipe"],
    });
    procs.set(id, child);
    const append = (chunk) => {
      record.logs = (record.logs + chunk.toString("utf8")).slice(-200_000);
    };
    child.stdout.on("data", append);
    child.stderr.on("data", append);
    child.on("close", (code, signal) => {
      procs.delete(id);
      record.status = "completed";
      record.exitCode = code;
      record.durationMs = Date.now() - startedAt;
      if (record.conclusion !== "cancelled") {
        record.conclusion = code === 0 ? "success" : signal ? "cancelled" : "failure";
      }
    });
    return sendJson(res, 202, { id, status: record.status });
  }

  const logsMatch = /^\\/runs\\/([^/]+)\\/logs$/.exec(pathname);
  if (req.method === "GET" && logsMatch) {
    const run = runs.get(decodeURIComponent(logsMatch[1]));
    if (!run) return sendJson(res, 404, { error: "Run not found" });
    return sendJson(res, 200, { id: run.id, logs: run.logs });
  }

  const cancelMatch = /^\\/runs\\/([^/]+)\\/cancel$/.exec(pathname);
  if (req.method === "POST" && cancelMatch) {
    const id = decodeURIComponent(cancelMatch[1]);
    const run = runs.get(id);
    if (!run) return sendJson(res, 404, { error: "Run not found" });
    const child = procs.get(id);
    run.conclusion = "cancelled";
    if (child) child.kill("SIGTERM");
    return sendJson(res, 200, { ok: true, id, status: "cancelled" });
  }

  return sendJson(res, 404, { error: "Not found" });
}).listen(PORT, HOST, () => {
  console.log(\`[m3-runner-agent] \${NAME} listening on http://\${HOST}:\${PORT}\`);
});
`;

/**
 * Generate an auditable deployment plan (Docker Compose, `docker run` argv, systemd unit, or SSH script)
 * for a self-hosted CI runner.
 */
export function generateDeploymentPlan(input = {}) {
  const provider = RUNNER_PROVIDERS.includes(input.provider) ? input.provider : "custom-http";
  const mode = DEPLOY_MODES.includes(input.mode) ? input.mode : "docker";
  const name = sanitizeRunnerName(input.name ?? `m3-${provider}-runner`);
  const labels = normalizeLabels(input.labels ?? ["self-hosted", "linux", provider]);
  const concurrency = sanitizeConcurrency(input.concurrency ?? 2);
  const port = sanitizePort(input.port ?? 8787, 8787);
  const workDir =
    typeof input.workDir === "string" && input.workDir.trim().length > 0
      ? input.workDir.trim()
      : "/var/lib/m3-runner";
  // Values land in heredocs, unit files and YAML; a newline could end a heredoc early.
  for (const [field, value] of Object.entries({ ...input, workDir })) {
    if ([value].flat().some((v) => typeof v === "string" && /[\0-\x1f\x7f]/.test(v))) {
      throw new Error(`Field "${field}" must not contain control characters.`);
    }
  }
  const instanceUrl =
    typeof input.instanceUrl === "string" && input.instanceUrl.trim().length > 0
      ? input.instanceUrl.trim().replace(/\/+$/, "")
      : provider === "github"
        ? "https://github.com/OWNER/REPO"
        : provider === "gitlab"
          ? "https://gitlab.example.com"
          : provider === "forgejo"
            ? "https://git.example.com"
            : `http://127.0.0.1:${port}`;
  const registrationToken =
    typeof input.registrationToken === "string" ? input.registrationToken.trim() : "";
  const tokenPlaceholder = registrationToken || "<RUNNER_TOKEN>";

  let image = "node:22-alpine";
  let dockerEnv = [];
  let dockerPorts = [];
  let dockerVolumes = [];

  if (provider === "custom-http") {
    image =
      typeof input.image === "string" && input.image.trim() ? input.image.trim() : "node:22-alpine";
    dockerPorts = [`${port}:${port}`];
    dockerVolumes = [`${workDir}:/workspace`];
    dockerEnv = [
      `M3_RUNNER_NAME=${name}`,
      `M3_RUNNER_PORT=${port}`,
      `M3_RUNNER_WORKDIR=/workspace`,
      `M3_RUNNER_CONCURRENCY=${concurrency}`,
      `M3_RUNNER_LABELS=${labels.join(",")}`,
      ...(registrationToken ? [`M3_RUNNER_TOKEN=${registrationToken}`] : []),
    ];
  } else if (provider === "github") {
    image =
      typeof input.image === "string" && input.image.trim()
        ? input.image.trim()
        : "myoung34/github-runner:latest";
    dockerVolumes = ["/var/run/docker.sock:/var/run/docker.sock", `${workDir}:/tmp/runner`];
    dockerEnv = [
      `REPO_URL=${instanceUrl}`,
      `RUNNER_NAME=${name}`,
      `RUNNER_TOKEN=${tokenPlaceholder}`,
      `RUNNER_WORKDIR=/tmp/runner`,
      `LABELS=${labels.join(",")}`,
    ];
  } else if (provider === "gitlab") {
    image =
      typeof input.image === "string" && input.image.trim()
        ? input.image.trim()
        : "gitlab/gitlab-runner:latest";
    dockerVolumes = [
      "/var/run/docker.sock:/var/run/docker.sock",
      `${workDir}/config:/etc/gitlab-runner`,
    ];
    dockerEnv = [
      `CI_SERVER_URL=${instanceUrl}`,
      `REGISTRATION_TOKEN=${tokenPlaceholder}`,
      `RUNNER_NAME=${name}`,
      `RUNNER_TAG_LIST=${labels.join(",")}`,
    ];
  } else if (provider === "forgejo") {
    image =
      typeof input.image === "string" && input.image.trim()
        ? input.image.trim()
        : "code.forgejo.org/forgejo/runner:latest";
    dockerVolumes = ["/var/run/docker.sock:/var/run/docker.sock", `${workDir}:/data`];
    dockerEnv = [
      `FORGEJO_INSTANCE_URL=${instanceUrl}`,
      `FORGEJO_RUNNER_TOKEN=${tokenPlaceholder}`,
      `FORGEJO_RUNNER_NAME=${name}`,
      `FORGEJO_RUNNER_LABELS=${labels.join(",")}`,
    ];
  }

  const dockerRunArgv = [
    "run",
    "-d",
    "--restart",
    "unless-stopped",
    "--name",
    name,
    ...dockerPorts.flatMap((p) => ["-p", p]),
    ...dockerVolumes.flatMap((v) => ["-v", v]),
    ...dockerEnv.flatMap((e) => ["-e", e]),
    image,
    ...(provider === "custom-http"
      ? ["node", "-e", M3_RUNNER_AGENT_SCRIPT.replace(/^#!.*\n/, "")]
      : []),
  ];

  const displayDockerCmd = [
    "docker",
    ...dockerRunArgv.map((arg) =>
      arg.length > 160
        ? "<M3_RUNNER_AGENT_SCRIPT>"
        : /^[A-Za-z0-9_/.:,=@%+-]+$/.test(arg)
          ? arg
          : shellQuote(arg),
    ),
  ].join(" ");

  const composeLines = [
    "services:",
    `  ${name}:`,
    `    image: ${image}`,
    `    container_name: ${name}`,
    "    restart: unless-stopped",
    ...(dockerPorts.length > 0 ? ["    ports:", ...dockerPorts.map((p) => `      - "${p}"`)] : []),
    ...(dockerVolumes.length > 0
      ? ["    volumes:", ...dockerVolumes.map((v) => `      - "${v}"`)]
      : []),
    "    environment:",
    ...dockerEnv.map((e) => {
      const [k, ...rest] = e.split("=");
      return `      ${k}: "${rest.join("=")}"`;
    }),
  ];

  const systemdUnit = `[Unit]
Description=M3 Self-Hosted CI Runner (${name} / ${provider})
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=${workDir}
${dockerEnv.map((e) => `Environment="${e}"`).join("\n")}
ExecStart=${
    provider === "custom-http"
      ? `/usr/bin/env node ${workDir}/m3-runner-agent.mjs`
      : provider === "gitlab"
        ? `/usr/bin/gitlab-runner run --working-directory ${workDir}`
        : provider === "forgejo"
          ? `/usr/local/bin/forgejo-runner daemon --config ${workDir}/config.yml`
          : `${workDir}/run.sh`
  }
Restart=always
RestartSec=5
NoNewPrivileges=true

[Install]
WantedBy=multi-user.target
`;

  const sshHost = typeof input.sshHost === "string" ? input.sshHost.trim() : "";
  const sshUser =
    typeof input.sshUser === "string" && input.sshUser.trim() ? input.sshUser.trim() : "root";
  const sshPort = sanitizePort(input.sshPort ?? 22, 22);

  const remoteInstallScript = [
    "set -euo pipefail",
    `mkdir -p ${shellQuote(workDir)}`,
    ...(provider === "custom-http"
      ? [
          `cat <<'EOF_M3_AGENT' > ${shellQuote(`${workDir}/m3-runner-agent.mjs`)}`,
          M3_RUNNER_AGENT_SCRIPT.trimEnd(),
          "EOF_M3_AGENT",
          `chmod +x ${shellQuote(`${workDir}/m3-runner-agent.mjs`)}`,
        ]
      : []),
    `if command -v docker >/dev/null 2>&1; then`,
    `  docker rm -f ${shellQuote(name)} >/dev/null 2>&1 || true`,
    `  ${displayDockerCmd.replace("<M3_RUNNER_AGENT_SCRIPT>", shellQuote(M3_RUNNER_AGENT_SCRIPT.replace(/^#!.*\n/, "")))}`,
    `else`,
    `  echo ${shellQuote(`Docker not found on remote host; writing systemd unit to ${workDir}/${name}.service`)}`,
    `  cat <<'EOF_UNIT' > ${shellQuote(`${workDir}/${name}.service`)}`,
    systemdUnit.trimEnd(),
    "EOF_UNIT",
    "fi",
  ].join("\n");

  const sshPreview = sshHost
    ? `ssh -p ${sshPort} -o BatchMode=yes ${shellQuote(`${sshUser}@${sshHost}`)} 'bash -s' < deploy-${name}.sh`
    : `ssh -p ${sshPort} -o BatchMode=yes <user>@<host> 'bash -s' < deploy-${name}.sh`;

  const suggestedApiBaseUrl =
    provider === "custom-http" ? `http://${sshHost || "127.0.0.1"}:${port}` : instanceUrl;

  return {
    provider,
    mode,
    name,
    labels,
    concurrency,
    port,
    workDir,
    image,
    suggestedApiBaseUrl,
    dockerCommand: displayDockerCmd,
    dockerRunArgv,
    dockerComposeYaml: `${composeLines.join("\n")}\n`,
    systemdUnit,
    sshCommand: sshPreview,
    remoteInstallScript,
  };
}

function execFileCapture(command, args, options = {}) {
  return new Promise((resolve) => {
    const child = NodeChildProcess.spawn(command, args, {
      stdio: [options.stdin ? "pipe" : "ignore", "pipe", "pipe"],
      timeout: options.timeoutMs ?? 60_000,
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk) => {
      stdout = `${stdout}${chunk.toString("utf8")}`.slice(-32_000);
    });
    child.stderr?.on("data", (chunk) => {
      stderr = `${stderr}${chunk.toString("utf8")}`.slice(-32_000);
    });
    child.on("error", (err) => {
      resolve({ ok: false, exitCode: -1, stdout, stderr: err.message });
    });
    child.on("close", (code) => {
      resolve({
        ok: code === 0,
        exitCode: code ?? -1,
        stdout: stdout.trim(),
        stderr: stderr.trim(),
      });
    });
    if (options.stdin && child.stdin) {
      child.stdin.write(options.stdin);
      child.stdin.end();
    }
  });
}

/**
 * Execute a runner deployment via local Docker or remote SSH.
 * Uses argv-based `spawn` (no local shell interpolation) for safety.
 */
export async function executeDeployment(input = {}) {
  const plan = generateDeploymentPlan(input);

  if (plan.mode === "docker") {
    const result = await execFileCapture("docker", plan.dockerRunArgv, { timeoutMs: 90_000 });
    return {
      ...result,
      mode: "docker",
      plan: {
        name: plan.name,
        provider: plan.provider,
        suggestedApiBaseUrl: plan.suggestedApiBaseUrl,
        labels: plan.labels,
      },
    };
  }

  if (plan.mode === "ssh") {
    const sshHost = typeof input.sshHost === "string" ? input.sshHost.trim() : "";
    const sshUser =
      typeof input.sshUser === "string" && input.sshUser.trim() ? input.sshUser.trim() : "root";
    const sshPort = sanitizePort(input.sshPort ?? 22, 22);
    if (!sshHost || !SAFE_HOST_RE.test(sshHost)) {
      throw new Error('Valid "sshHost" is required for SSH deployment.');
    }
    if (!SAFE_USER_RE.test(sshUser)) {
      throw new Error('Invalid "sshUser" for SSH deployment.');
    }
    const result = await execFileCapture(
      "ssh",
      [
        "-p",
        String(sshPort),
        "-o",
        "BatchMode=yes",
        "-o",
        "ConnectTimeout=10",
        `${sshUser}@${sshHost}`,
        "bash -s",
      ],
      { stdin: `${plan.remoteInstallScript}\n`, timeoutMs: 120_000 },
    );
    return {
      ...result,
      mode: "ssh",
      plan: {
        name: plan.name,
        provider: plan.provider,
        suggestedApiBaseUrl: plan.suggestedApiBaseUrl,
        labels: plan.labels,
      },
    };
  }

  throw new Error(
    `Direct execution supports "docker" and "ssh" modes; for "systemd", copy the generated unit file.`,
  );
}
