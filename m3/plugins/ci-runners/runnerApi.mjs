const DEFAULT_TIMEOUT_MS = 12_000;

function authHeaders(runner) {
  const headers = {
    accept: "application/json",
    "user-agent": "m3code-ci-runners-plugin/1.0",
  };
  if (!runner.token) return headers;

  switch (runner.provider) {
    case "github":
      headers.authorization = `Bearer ${runner.token}`;
      headers["x-github-api-version"] = "2022-11-28";
      break;
    case "gitlab":
      headers["private-token"] = runner.token;
      break;
    case "forgejo":
      headers.authorization = `token ${runner.token}`;
      break;
    default:
      headers.authorization = `Bearer ${runner.token}`;
      break;
  }
  return headers;
}

async function fetchJson(url, options = {}) {
  const startedAt = Date.now();
  const response = await fetch(url, {
    ...options,
    signal: AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS),
  });
  const latencyMs = Date.now() - startedAt;
  const text = await response.text();
  let json = null;
  try {
    json = text.length > 0 ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  return {
    ok: response.ok,
    status: response.status,
    latencyMs,
    text,
    json,
  };
}

function encodeGitLabProject(repo) {
  return encodeURIComponent(repo.replace(/^\/+|\/+$/g, ""));
}

function requireRepo(runner) {
  if (!runner.repo || runner.repo.trim().length === 0) {
    throw new Error(
      `Runner "${runner.name}" requires a repository/project path (e.g. "owner/repo").`,
    );
  }
  return runner.repo.trim();
}

/**
 * Probe a configured runner or self-hosted runner fleet for live health, status, and capacity.
 */
export async function probeRunner(runner) {
  const base = runner.apiBaseUrl.replace(/\/+$/, "");
  const headers = authHeaders(runner);

  try {
    if (runner.provider === "custom-http") {
      const res = await fetchJson(`${base}/health`, { method: "GET", headers });
      if (!res.ok) {
        return {
          online: false,
          status: "error",
          httpStatus: res.status,
          latencyMs: res.latencyMs,
          error: res.json?.error ?? res.text.slice(0, 300) ?? `HTTP ${res.status}`,
          nodes: [],
        };
      }
      const data = res.json ?? {};
      return {
        online: true,
        status: data.busy ? "busy" : "online",
        httpStatus: res.status,
        latencyMs: res.latencyMs,
        version: data.version ?? null,
        activeJobs: Number(data.activeJobs ?? 0),
        concurrency: Number(data.concurrency ?? 1),
        labels: Array.isArray(data.labels) ? data.labels : runner.labels,
        nodes: Array.isArray(data.nodes)
          ? data.nodes
          : [
              {
                id: data.runnerId ?? runner.id,
                name: data.name ?? runner.name,
                status: data.busy ? "busy" : "online",
                os: data.platform ?? data.os ?? "linux",
                labels: Array.isArray(data.labels) ? data.labels : runner.labels,
              },
            ],
      };
    }

    if (runner.provider === "github") {
      const repo = requireRepo(runner);
      const endpoint = repo.includes("/")
        ? `${base}/repos/${repo}/actions/runners`
        : `${base}/orgs/${repo}/actions/runners`;
      const res = await fetchJson(endpoint, { method: "GET", headers });
      if (!res.ok) {
        return {
          online: false,
          status: "error",
          httpStatus: res.status,
          latencyMs: res.latencyMs,
          error: res.json?.message ?? `GitHub API returned HTTP ${res.status}`,
          nodes: [],
        };
      }
      const rawRunners = Array.isArray(res.json?.runners) ? res.json.runners : [];
      const nodes = rawRunners.map((r) => ({
        id: String(r.id),
        name: r.name,
        status: r.busy ? "busy" : r.status === "online" ? "online" : "offline",
        os: r.os ?? "unknown",
        labels: Array.isArray(r.labels) ? r.labels.map((l) => l.name) : [],
      }));
      const onlineCount = nodes.filter((n) => n.status === "online" || n.status === "busy").length;
      return {
        online: onlineCount > 0 || nodes.length === 0,
        status: onlineCount > 0 ? "online" : nodes.length > 0 ? "offline" : "online",
        httpStatus: res.status,
        latencyMs: res.latencyMs,
        activeJobs: nodes.filter((n) => n.status === "busy").length,
        concurrency: nodes.length,
        nodes,
      };
    }

    if (runner.provider === "gitlab") {
      const endpoint = runner.repo
        ? `${base}/api/v4/projects/${encodeGitLabProject(runner.repo)}/runners`
        : `${base}/api/v4/runners`;
      const res = await fetchJson(endpoint, { method: "GET", headers });
      if (!res.ok) {
        return {
          online: false,
          status: "error",
          httpStatus: res.status,
          latencyMs: res.latencyMs,
          error: res.json?.message ?? `GitLab API returned HTTP ${res.status}`,
          nodes: [],
        };
      }
      const rawRunners = Array.isArray(res.json) ? res.json : [];
      const nodes = rawRunners.map((r) => ({
        id: String(r.id),
        name: r.description || `runner-${r.id}`,
        status: r.status === "online" ? "online" : r.paused ? "paused" : "offline",
        os: r.platform ?? "linux",
        labels: Array.isArray(r.tag_list) ? r.tag_list : [],
      }));
      const onlineCount = nodes.filter((n) => n.status === "online").length;
      return {
        online: onlineCount > 0 || nodes.length === 0,
        status: onlineCount > 0 ? "online" : nodes.length > 0 ? "offline" : "online",
        httpStatus: res.status,
        latencyMs: res.latencyMs,
        activeJobs: 0,
        concurrency: nodes.length,
        nodes,
      };
    }

    if (runner.provider === "forgejo") {
      const endpoint = runner.repo
        ? `${base}/api/v1/repos/${runner.repo}/actions/runners`
        : `${base}/api/v1/admin/runners`;
      const res = await fetchJson(endpoint, { method: "GET", headers });
      if (!res.ok) {
        return {
          online: false,
          status: "error",
          httpStatus: res.status,
          latencyMs: res.latencyMs,
          error: res.json?.message ?? `Forgejo API returned HTTP ${res.status}`,
          nodes: [],
        };
      }
      const rawRunners = Array.isArray(res.json)
        ? res.json
        : Array.isArray(res.json?.runners)
          ? res.json.runners
          : [];
      const nodes = rawRunners.map((r) => ({
        id: String(r.id),
        name: r.name ?? `runner-${r.id}`,
        status: r.busy
          ? "busy"
          : r.status === "online" || r.status === "idle"
            ? "online"
            : "offline",
        os: r.os ?? "linux",
        labels: Array.isArray(r.labels)
          ? r.labels.map((l) => (typeof l === "string" ? l : l.name))
          : [],
      }));
      const onlineCount = nodes.filter((n) => n.status === "online" || n.status === "busy").length;
      return {
        online: onlineCount > 0 || nodes.length === 0,
        status: onlineCount > 0 ? "online" : nodes.length > 0 ? "offline" : "online",
        httpStatus: res.status,
        latencyMs: res.latencyMs,
        activeJobs: nodes.filter((n) => n.status === "busy").length,
        concurrency: nodes.length,
        nodes,
      };
    }

    return {
      online: false,
      status: "error",
      error: `Unsupported provider: ${runner.provider}`,
      nodes: [],
    };
  } catch (err) {
    return {
      online: false,
      status: "unreachable",
      error: err instanceof Error ? err.message : String(err),
      nodes: [],
    };
  }
}

/**
 * List recent CI runs directly from the runner or forge API.
 */
export async function listRuns(runner, options = {}) {
  const limit = Math.min(Math.max(Number(options.limit ?? 20), 1), 100);
  const base = runner.apiBaseUrl.replace(/\/+$/, "");
  const headers = authHeaders(runner);

  if (runner.provider === "custom-http") {
    const res = await fetchJson(`${base}/runs?limit=${limit}`, { method: "GET", headers });
    if (!res.ok) {
      throw new Error(res.json?.error ?? `Runner returned HTTP ${res.status}`);
    }
    const items = Array.isArray(res.json)
      ? res.json
      : Array.isArray(res.json?.runs)
        ? res.json.runs
        : [];
    return items.map((r) => ({
      id: String(r.id),
      name: r.name ?? r.workflow ?? r.command ?? `Run ${r.id}`,
      ref: r.ref ?? r.branch ?? "main",
      status: r.status ?? "unknown",
      conclusion:
        r.conclusion ?? (r.exitCode === 0 ? "success" : r.exitCode != null ? "failure" : null),
      durationMs: r.durationMs ?? null,
      createdAt: r.createdAt ?? r.startedAt ?? null,
      url: r.url ?? null,
    }));
  }

  if (runner.provider === "github") {
    const repo = requireRepo(runner);
    const res = await fetchJson(`${base}/repos/${repo}/actions/runs?per_page=${limit}`, {
      method: "GET",
      headers,
    });
    if (!res.ok) {
      throw new Error(res.json?.message ?? `GitHub API returned HTTP ${res.status}`);
    }
    const items = Array.isArray(res.json?.workflow_runs) ? res.json.workflow_runs : [];
    return items.map((r) => ({
      id: String(r.id),
      name: r.name || r.display_title || `Run #${r.run_number}`,
      ref: r.head_branch ?? "main",
      status: r.status ?? "unknown",
      conclusion: r.conclusion ?? null,
      durationMs: null,
      createdAt: r.created_at ?? null,
      url: r.html_url ?? null,
    }));
  }

  if (runner.provider === "gitlab") {
    const repo = requireRepo(runner);
    const res = await fetchJson(
      `${base}/api/v4/projects/${encodeGitLabProject(repo)}/pipelines?per_page=${limit}`,
      { method: "GET", headers },
    );
    if (!res.ok) {
      throw new Error(res.json?.message ?? `GitLab API returned HTTP ${res.status}`);
    }
    const items = Array.isArray(res.json) ? res.json : [];
    return items.map((p) => ({
      id: String(p.id),
      name: `Pipeline #${p.id}`,
      ref: p.ref ?? "main",
      status:
        p.status === "success" || p.status === "failed" || p.status === "canceled"
          ? "completed"
          : p.status,
      conclusion:
        p.status === "success"
          ? "success"
          : p.status === "failed"
            ? "failure"
            : p.status === "canceled"
              ? "cancelled"
              : null,
      durationMs: null,
      createdAt: p.created_at ?? null,
      url: p.web_url ?? null,
    }));
  }

  if (runner.provider === "forgejo") {
    const repo = requireRepo(runner);
    const res = await fetchJson(`${base}/api/v1/repos/${repo}/actions/runs?limit=${limit}`, {
      method: "GET",
      headers,
    });
    if (!res.ok) {
      throw new Error(res.json?.message ?? `Forgejo API returned HTTP ${res.status}`);
    }
    const items = Array.isArray(res.json?.workflow_runs)
      ? res.json.workflow_runs
      : Array.isArray(res.json)
        ? res.json
        : [];
    return items.map((r) => ({
      id: String(r.id),
      name: r.title ?? r.name ?? `Run #${r.id}`,
      ref: r.ref ?? r.branch ?? "main",
      status: r.status ?? "unknown",
      conclusion: r.conclusion ?? null,
      durationMs: null,
      createdAt: r.created ?? r.created_at ?? null,
      url: r.html_url ?? null,
    }));
  }

  throw new Error(`Unsupported provider "${runner.provider}".`);
}

/**
 * Trigger a CI run directly on the runner or forge API.
 */
export async function triggerRun(runner, payload = {}) {
  const base = runner.apiBaseUrl.replace(/\/+$/, "");
  const headers = {
    ...authHeaders(runner),
    "content-type": "application/json",
  };
  const ref =
    (typeof payload.ref === "string" && payload.ref.trim()) || runner.defaultRef || "main";
  const workflow =
    (typeof payload.workflow === "string" && payload.workflow.trim()) ||
    runner.defaultWorkflow ||
    "";

  if (runner.provider === "custom-http") {
    const body = {
      ref,
      ...(workflow ? { workflow } : {}),
      ...(typeof payload.command === "string" && payload.command.trim()
        ? { command: payload.command.trim() }
        : {}),
      ...(typeof payload.cwd === "string" && payload.cwd.trim() ? { cwd: payload.cwd.trim() } : {}),
      ...(payload.env && typeof payload.env === "object" ? { env: payload.env } : {}),
      labels: runner.labels,
    };
    const res = await fetchJson(`${base}/runs`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      throw new Error(res.json?.error ?? `Runner rejected trigger (HTTP ${res.status})`);
    }
    return {
      ok: true,
      runId: String(res.json?.id ?? res.json?.runId ?? ""),
      status: res.json?.status ?? "queued",
      ref,
      workflow,
      command: body.command ?? "",
      raw: res.json,
    };
  }

  if (runner.provider === "github") {
    const repo = requireRepo(runner);
    if (!workflow) {
      throw new Error('GitHub workflow dispatch requires "workflow" (e.g. "ci.yml").');
    }
    const res = await fetchJson(
      `${base}/repos/${repo}/actions/workflows/${encodeURIComponent(workflow)}/dispatches`,
      {
        method: "POST",
        headers,
        body: JSON.stringify({
          ref,
          ...(payload.inputs && typeof payload.inputs === "object"
            ? { inputs: payload.inputs }
            : {}),
        }),
      },
    );
    if (!res.ok) {
      throw new Error(res.json?.message ?? `GitHub dispatch failed (HTTP ${res.status})`);
    }
    return { ok: true, runId: "", status: "dispatched", ref, workflow };
  }

  if (runner.provider === "gitlab") {
    const repo = requireRepo(runner);
    const variables =
      payload.env && typeof payload.env === "object"
        ? Object.entries(payload.env).map(([key, value]) => ({ key, value: String(value) }))
        : undefined;
    const res = await fetchJson(`${base}/api/v4/projects/${encodeGitLabProject(repo)}/pipeline`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        ref,
        ...(variables && variables.length > 0 ? { variables } : {}),
      }),
    });
    if (!res.ok) {
      throw new Error(res.json?.message ?? `GitLab pipeline trigger failed (HTTP ${res.status})`);
    }
    return {
      ok: true,
      runId: String(res.json?.id ?? ""),
      status: res.json?.status ?? "created",
      ref,
      workflow,
      url: res.json?.web_url ?? null,
    };
  }

  if (runner.provider === "forgejo") {
    const repo = requireRepo(runner);
    if (!workflow) {
      throw new Error('Forgejo workflow dispatch requires "workflow" (e.g. "ci.yaml").');
    }
    const res = await fetchJson(
      `${base}/api/v1/repos/${repo}/actions/workflows/${encodeURIComponent(workflow)}/dispatches`,
      {
        method: "POST",
        headers,
        body: JSON.stringify({
          ref,
          ...(payload.inputs && typeof payload.inputs === "object"
            ? { inputs: payload.inputs }
            : {}),
        }),
      },
    );
    if (!res.ok) {
      throw new Error(res.json?.message ?? `Forgejo dispatch failed (HTTP ${res.status})`);
    }
    return { ok: true, runId: "", status: "dispatched", ref, workflow };
  }

  throw new Error(`Unsupported provider "${runner.provider}".`);
}

/**
 * Cancel an active CI run.
 */
export async function cancelRun(runner, runId) {
  const base = runner.apiBaseUrl.replace(/\/+$/, "");
  const headers = authHeaders(runner);
  const safeId = encodeURIComponent(String(runId));

  let url;
  if (runner.provider === "custom-http") {
    url = `${base}/runs/${safeId}/cancel`;
  } else if (runner.provider === "github") {
    url = `${base}/repos/${requireRepo(runner)}/actions/runs/${safeId}/cancel`;
  } else if (runner.provider === "gitlab") {
    url = `${base}/api/v4/projects/${encodeGitLabProject(requireRepo(runner))}/pipelines/${safeId}/cancel`;
  } else if (runner.provider === "forgejo") {
    url = `${base}/api/v1/repos/${requireRepo(runner)}/actions/runs/${safeId}/cancel`;
  } else {
    throw new Error(`Unsupported provider "${runner.provider}".`);
  }

  const res = await fetchJson(url, { method: "POST", headers });
  if (!res.ok) {
    throw new Error(res.json?.error ?? res.json?.message ?? `Cancel failed (HTTP ${res.status})`);
  }
  return { ok: true, runId: String(runId), status: "cancelled" };
}

/**
 * Fetch logs / job trace for a CI run.
 */
export async function getRunLogs(runner, runId) {
  const base = runner.apiBaseUrl.replace(/\/+$/, "");
  const headers = authHeaders(runner);
  const safeId = encodeURIComponent(String(runId));

  if (runner.provider === "custom-http") {
    const res = await fetchJson(`${base}/runs/${safeId}/logs`, { method: "GET", headers });
    if (!res.ok) {
      throw new Error(res.json?.error ?? `Failed to fetch logs (HTTP ${res.status})`);
    }
    return {
      runId: String(runId),
      logs: typeof res.json?.logs === "string" ? res.json.logs : res.text,
    };
  }

  if (runner.provider === "github") {
    const repo = requireRepo(runner);
    const jobsRes = await fetchJson(`${base}/repos/${repo}/actions/runs/${safeId}/jobs`, {
      method: "GET",
      headers,
    });
    if (!jobsRes.ok) {
      throw new Error(
        jobsRes.json?.message ?? `GitHub jobs lookup failed (HTTP ${jobsRes.status})`,
      );
    }
    const jobs = Array.isArray(jobsRes.json?.jobs) ? jobsRes.json.jobs : [];
    const lines = jobs.map((job) => {
      const steps = Array.isArray(job.steps)
        ? job.steps.map((s) => `  - [${s.conclusion ?? s.status}] ${s.name}`).join("\n")
        : "";
      return `Job: ${job.name} (${job.conclusion ?? job.status})\n${steps}`;
    });
    return {
      runId: String(runId),
      logs: lines.join("\n\n") || "No jobs reported for this run.",
      jobs: jobs.map((j) => ({
        id: j.id,
        name: j.name,
        status: j.status,
        conclusion: j.conclusion,
      })),
    };
  }

  if (runner.provider === "gitlab") {
    const repo = encodeGitLabProject(requireRepo(runner));
    const jobsRes = await fetchJson(`${base}/api/v4/projects/${repo}/pipelines/${safeId}/jobs`, {
      method: "GET",
      headers,
    });
    if (!jobsRes.ok) {
      throw new Error(
        jobsRes.json?.message ?? `GitLab jobs lookup failed (HTTP ${jobsRes.status})`,
      );
    }
    const jobs = Array.isArray(jobsRes.json) ? jobsRes.json : [];
    const targetJob = jobs.find((j) => j.status === "failed") ?? jobs[0];
    if (!targetJob) {
      return { runId: String(runId), logs: "No jobs found for this pipeline." };
    }
    const traceRes = await fetchJson(`${base}/api/v4/projects/${repo}/jobs/${targetJob.id}/trace`, {
      method: "GET",
      headers: { ...headers, accept: "text/plain" },
    });
    return {
      runId: String(runId),
      jobId: String(targetJob.id),
      jobName: targetJob.name,
      logs: traceRes.ok ? traceRes.text : `Failed to read trace (HTTP ${traceRes.status})`,
    };
  }

  if (runner.provider === "forgejo") {
    const repo = requireRepo(runner);
    const jobsRes = await fetchJson(`${base}/api/v1/repos/${repo}/actions/runs/${safeId}/jobs`, {
      method: "GET",
      headers,
    });
    if (!jobsRes.ok) {
      throw new Error(
        jobsRes.json?.message ?? `Forgejo jobs lookup failed (HTTP ${jobsRes.status})`,
      );
    }
    const jobs = Array.isArray(jobsRes.json?.jobs)
      ? jobsRes.json.jobs
      : Array.isArray(jobsRes.json)
        ? jobsRes.json
        : [];
    const lines = jobs.map((j) => `Job: ${j.name ?? j.id} (${j.conclusion ?? j.status})`);
    return {
      runId: String(runId),
      logs: lines.join("\n") || "No jobs reported for this run.",
    };
  }

  throw new Error(`Unsupported provider "${runner.provider}".`);
}
