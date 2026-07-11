import type { FastifyInstance } from "fastify";
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { sanitizePublicMessage } from "../domain/publicSanitize.js";

export async function systemRoutes(app: FastifyInstance) {
  app.get("/api/health", async () => ({ ok: true }));
  app.get("/api/auth/status", async (_request, reply) => reply.code(204).send());

  app.get("/api/system", async () => {
    const github = await app.services.github
      .getViewer()
      .then((viewer) => ({ connected: true, viewer }))
      .catch((error: unknown) => ({ connected: false, error: publicError(app, error) }));

    const cbm = await app.services.cbm
      .version()
      .then((version) => ({ installed: true, version }))
      .catch((error: unknown) => ({ installed: false, error: publicError(app, error) }));

    return {
      github,
      codebaseMemory: cbm,
      jobConcurrency: app.services.jobs.getConcurrency()
    };
  });

  app.get("/api/preflight", async () => {
    const checks: PreflightCheck[] = [];
    const checkedAt = new Date().toISOString();

    checks.push(checkGithubToken());
    checks.push(checkMcpContainerTarget(app.services.config.mcpContainerName));
    checks.push(checkMemorepoHomeLocation(app.services.config.memorepoHome));
    checks.push(checkMemorepoHomeWritable(app.services.config.memorepoHome, app.services.config.tmpDir));
    checks.push(checkDiskSpace(app.services.config.memorepoHome));

    const github = await app.services.github
      .diagnoseAccess()
      .then((diagnostics) => {
        const warningCount = diagnostics.warnings.length;
        checks.push({
          id: "github-access",
          label: "GitHub access",
          status: diagnostics.visibleRepositoryCount > 0 ? (warningCount > 0 ? "warn" : "pass") : "warn",
          message:
            diagnostics.visibleRepositoryCount > 0
              ? `${diagnostics.visibleRepositoryCount} visible repositories, ${diagnostics.visibleOrganizationCount} visible organizations`
              : "Token is valid but no repositories are visible.",
          ...(warningCount > 0 ? { detail: diagnostics.warnings.join(" ") } : {})
        });
        checks.push({
          id: "github-scopes",
          label: "GitHub scopes",
          status: diagnostics.tokenScopes.length > 0 ? "pass" : "warn",
          message: diagnostics.tokenScopes.length > 0 ? diagnostics.tokenScopes.join(", ") : "GitHub did not report token scopes."
        });
        return diagnostics;
      })
      .catch((error: unknown) => {
        const message = publicError(app, error);
        checks.push({
          id: "github-access",
          label: "GitHub access",
          status: "fail",
          message
        });
        return { connected: false, error: message };
      });

    const codebaseMemory = await app.services.cbm
      .version()
      .then((version) => {
        checks.push({
          id: "codebase-memory-mcp",
          label: "codebase-memory-mcp",
          status: "pass",
          message: version
        });
        return { installed: true, version };
      })
      .catch((error: unknown) => {
        const message = publicError(app, error);
        checks.push({
          id: "codebase-memory-mcp",
          label: "codebase-memory-mcp",
          status: "fail",
          message
        });
        return { installed: false, error: message };
      });

    const status = aggregatePreflightStatus(checks);

    return {
      status,
      checkedAt,
      checks,
      github,
      codebaseMemory,
      mcpContainerName: app.services.config.mcpContainerName
    };
  });

  app.get("/api/maintenance/summary", async () => {
    return app.services.maintenance.summary();
  });

  app.post("/api/maintenance/gc", async (request) => {
    const body = z.object({ jobRetentionDays: z.number().int().min(1).max(3650).optional() }).parse(request.body ?? {});
    return app.services.maintenance.runGarbageCollection(body.jobRetentionDays);
  });
}

type PreflightStatus = "ready" | "warning" | "failed";
type PreflightCheckStatus = "pass" | "warn" | "fail";

interface PreflightCheck {
  id: string;
  label: string;
  status: PreflightCheckStatus;
  message: string;
  detail?: string;
  value?: string | number | boolean;
}

function checkGithubToken(): PreflightCheck {
  const present = Boolean(process.env.GH_TOKEN?.trim());
  return {
    id: "github-token",
    label: "GH_TOKEN",
    status: present ? "pass" : "fail",
    message: present ? "Configured for the API container." : "Set GH_TOKEN before starting MemoRepo."
  };
}

function checkMcpContainerTarget(containerName: string): PreflightCheck {
  const configured = containerName.trim().length > 0;
  return {
    id: "mcp-container-target",
    label: "MCP container target",
    status: configured ? "pass" : "fail",
    message: configured
      ? `Generated stdio configs target Docker container ${containerName}.`
      : "Set MEMOREPO_API_CONTAINER_NAME so generated MCP configs can call docker exec.",
    value: containerName
  };
}

function checkMemorepoHomeLocation(memorepoHome: string): PreflightCheck {
  const repoRoot = path.resolve(process.cwd());
  const resolvedHome = path.resolve(memorepoHome);
  const relative = path.relative(repoRoot, resolvedHome);
  const insideRepo = relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));

  return {
    id: "memorepo-home-location",
    label: "MEMOREPO_HOME location",
    status: insideRepo ? "warn" : "pass",
    message: insideRepo
      ? "MEMOREPO_HOME is inside the source tree. Use an external path for regular use."
      : "MEMOREPO_HOME is outside the source tree.",
    value: insideRepo
  };
}

function checkMemorepoHomeWritable(memorepoHome: string, tmpDir: string): PreflightCheck {
  const targetDir = path.resolve(tmpDir || memorepoHome);
  const probePath = path.join(targetDir, `.preflight-${process.pid}-${Date.now()}.tmp`);
  try {
    fs.mkdirSync(targetDir, { recursive: true });
    fs.writeFileSync(probePath, "ok");
    fs.rmSync(probePath, { force: true });
    return {
      id: "memorepo-home-writable",
      label: "MEMOREPO_HOME writable",
      status: "pass",
      message: "MemoRepo can write managed state.",
      value: true
    };
  } catch (error) {
    return {
      id: "memorepo-home-writable",
      label: "MEMOREPO_HOME writable",
      status: "fail",
      message: "MemoRepo cannot write managed state.",
      value: false
    };
  }
}

function publicError(app: FastifyInstance, error: unknown): string {
  return sanitizePublicMessage(error, [app.services.config.memorepoHome, app.services.config.tmpDir]);
}

function checkDiskSpace(memorepoHome: string): PreflightCheck {
  try {
    const stats = fs.statfsSync(memorepoHome);
    const availableBytes = Number(stats.bavail) * Number(stats.bsize);
    const availableGb = availableBytes / 1024 / 1024 / 1024;
    const status: PreflightCheckStatus = availableGb < 0.5 ? "fail" : availableGb < 5 ? "warn" : "pass";
    return {
      id: "disk-space",
      label: "Disk space",
      status,
      message: `${availableGb.toFixed(1)} GB available for managed clones and indexes.`,
      value: Math.round(availableBytes)
    };
  } catch (error) {
    return {
      id: "disk-space",
      label: "Disk space",
      status: "warn",
      message: error instanceof Error ? error.message : String(error)
    };
  }
}

function aggregatePreflightStatus(checks: PreflightCheck[]): PreflightStatus {
  if (checks.some((check) => check.status === "fail")) {
    return "failed";
  }
  if (checks.some((check) => check.status === "warn")) {
    return "warning";
  }
  return "ready";
}
