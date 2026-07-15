import fs from "node:fs";
import path from "node:path";
import type { AppConfig } from "../config.js";
import { assertInside } from "../domain/paths.js";
import { createSafeProcessEnvironment, runProcess } from "./process.js";
import type { GitHubCredentialProvider } from "./githubCredentialProvider.js";

export interface GitCommandContext {
  cwd?: string | undefined;
  onOutput?: ((line: string) => void) | undefined;
  timeoutMs?: number | undefined;
}

export interface RemoteBranchState {
  branches: string[];
  commit: string;
}

export class GitService {
  private askPassPath: string | null = null;

  constructor(
    private readonly config: AppConfig,
    private readonly credentials: GitHubCredentialProvider
  ) {}

  async cloneRepository(remoteUrl: string, targetPath: string, context: GitCommandContext = {}): Promise<void> {
    const safeTarget = assertInside(this.config.memorepoHome, targetPath);

    if (fs.existsSync(path.join(safeTarget, ".git"))) {
      context.onOutput?.("Repository already cloned; keeping existing clone.");
      return;
    }

    if (fs.existsSync(safeTarget) && fs.readdirSync(safeTarget).length > 0) {
      throw new Error(`Target directory exists and is not a Git clone: ${safeTarget}`);
    }

    fs.mkdirSync(path.dirname(safeTarget), { recursive: true });
    await this.git(["clone", remoteUrl, safeTarget], { onOutput: context.onOutput, timeoutMs: context.timeoutMs ?? 30 * 60_000 });
  }

  async fetchBranches(repoPath: string, context: GitCommandContext = {}): Promise<string[]> {
    await this.git(["fetch", "--prune", "origin"], { ...context, cwd: repoPath, timeoutMs: context.timeoutMs ?? 10 * 60_000 });
    const result = await this.git(
      ["for-each-ref", "--format=%(refname:short)", "refs/remotes/origin"],
      { ...context, cwd: repoPath, timeoutMs: context.timeoutMs ?? 60_000 }
    );

    return result.stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && line !== "origin/HEAD")
      .map((line) => line.replace(/^origin\//, ""))
      .sort((a, b) => a.localeCompare(b));
  }

  async fetchBranchState(repoPath: string, branch: string, context: GitCommandContext = {}): Promise<RemoteBranchState> {
    this.validateBranch(branch);
    const branches = await this.fetchBranches(repoPath, context);
    if (!branches.includes(branch)) {
      throw new Error(`Remote branch not found: ${branch}`);
    }

    const result = await this.git(["rev-parse", "--verify", `refs/remotes/origin/${branch}`], {
      ...context,
      cwd: repoPath,
      timeoutMs: 60_000
    });
    return { branches, commit: result.stdout.trim() };
  }

  async checkoutRemoteBranch(repoPath: string, branch: string, context: GitCommandContext = {}): Promise<string> {
    this.validateBranch(branch);
    await this.fetchBranches(repoPath, context);
    return this.checkoutFetchedRemoteBranch(repoPath, branch, context);
  }

  async checkoutFetchedRemoteBranch(repoPath: string, branch: string, context: GitCommandContext = {}): Promise<string> {
    this.validateBranch(branch);
    await this.git(["checkout", "-B", branch, `origin/${branch}`], {
      ...context,
      cwd: repoPath,
      timeoutMs: context.timeoutMs ?? 10 * 60_000
    });
    await this.git(["reset", "--hard", `origin/${branch}`], {
      ...context,
      cwd: repoPath,
      timeoutMs: context.timeoutMs ?? 5 * 60_000
    });
    await this.git(["clean", "-fd"], {
      ...context,
      cwd: repoPath,
      timeoutMs: context.timeoutMs ?? 5 * 60_000
    });
    const result = await this.git(["rev-parse", "HEAD"], { ...context, cwd: repoPath, timeoutMs: 60_000 });
    return result.stdout.trim();
  }

  async currentCommit(repoPath: string, context: GitCommandContext = {}): Promise<string> {
    const result = await this.git(["rev-parse", "HEAD"], { ...context, cwd: repoPath, timeoutMs: 60_000 });
    return result.stdout.trim();
  }

  private async git(args: string[], context: GitCommandContext) {
    const askPassPath = this.ensureAskPass();
    const accessToken = this.credentials.getAccessToken();
    const result = await runProcess({
      command: "git",
      args,
      cwd: context.cwd,
      timeoutMs: context.timeoutMs,
      sensitiveValues: [accessToken],
      onOutput: context.onOutput,
      env: {
        ...createSafeProcessEnvironment(),
        GIT_ASKPASS: askPassPath,
        GIT_TERMINAL_PROMPT: "0",
        MEMOREPO_GIT_CREDENTIAL: accessToken
      },
      inheritEnv: false
    });

    if (result.exitCode !== 0) {
      throw new Error(result.stderr || result.stdout || `git ${args[0]} failed`);
    }

    return result;
  }

  private validateBranch(branch: string): void {
    if (branch.includes("..") || branch.startsWith("-") || branch.trim().length === 0) {
      throw new Error("Invalid branch name");
    }
  }

  private ensureAskPass(): string {
    if (this.askPassPath) {
      return this.askPassPath;
    }

    const scriptPath = path.join(this.config.binDir, "git-askpass.sh");
    fs.writeFileSync(
      scriptPath,
      [
        "#!/bin/sh",
        "case \"$1\" in",
        "  *Username*) printf '%s\\n' 'x-access-token' ;;",
        "  *) printf '%s\\n' \"$MEMOREPO_GIT_CREDENTIAL\" ;;",
        "esac",
        ""
      ].join("\n"),
      { mode: 0o700 }
    );
    fs.chmodSync(scriptPath, 0o700);
    this.askPassPath = scriptPath;
    return scriptPath;
  }
}
