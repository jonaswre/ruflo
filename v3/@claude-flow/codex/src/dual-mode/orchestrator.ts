/**
 * Dual-Mode Orchestrator
 * Runs Claude Code and Codex workers in parallel with shared memory
 */

import { spawn, ChildProcess } from 'child_process';
import { EventEmitter } from 'events';
import * as path from 'path';
import * as fs from 'fs';

export type SandboxMode = 'read-only' | 'workspace-write' | 'danger-full-access';

export interface WorkerConfig {
  id: string;
  platform: 'claude' | 'codex';
  role: string;
  prompt: string;
  model?: string;
  maxTurns?: number;
  timeout?: number;
  dependsOn?: string[];

  /**
   * Sandbox mode for codex workers. Ignored for claude (which has no equivalent
   * flag in print mode). Default: 'workspace-write'.
   */
  sandbox?: SandboxMode;

  /**
   * Whether the worker may make network calls. Codex defaults workspace-write
   * to network-disabled, which breaks the `npx claude-flow memory ...` calls
   * the collaboration protocol relies on. We default to `true` so the memory
   * protocol works; set to `false` to enforce isolation.
   * Has no effect for claude (no equivalent print-mode flag).
   */
  network?: boolean;

  /** Tools the worker is allowed to use. Forwarded to claude's --allowedTools.
   *  Not natively supported by codex exec — emits a warning and is ignored. */
  allowedTools?: string[];

  /** Tools the worker is denied. Forwarded to claude's --disallowedTools.
   *  Not natively supported by codex exec — emits a warning and is ignored. */
  disallowedTools?: string[];

  /** Per-worker working directory. Overrides DualModeConfig.projectPath. */
  cwd?: string;

  /** Additional directories the worker may write to.
   *  claude: --add-dir A B  /  codex: --add-dir A --add-dir B (repeatable). */
  addDirs?: string[];

  /** Resume an existing claude session by UUID. Codex resume has a different
   *  argv shape and is not yet supported here. */
  resumeSessionId?: string;
}

export interface WorkerResult {
  id: string;
  platform: 'claude' | 'codex';
  role: string;
  status: 'pending' | 'running' | 'completed' | 'failed';
  output?: string;
  error?: string;
  startedAt?: Date;
  completedAt?: Date;
  memoryKeys?: string[];
}

export interface DualModeConfig {
  projectPath: string;
  maxConcurrent?: number;
  sharedNamespace?: string;
  timeout?: number;
  claudeCommand?: string;
  codexCommand?: string;
}

export interface CollaborationResult {
  success: boolean;
  workers: WorkerResult[];
  sharedMemory: Record<string, any>;
  totalDuration: number;
  errors: string[];
}

/**
 * Orchestrates parallel execution of Claude Code and Codex workers
 */
export class DualModeOrchestrator extends EventEmitter {
  private config: Required<DualModeConfig>;
  private workers: Map<string, WorkerResult> = new Map();
  private processes: Map<string, ChildProcess> = new Map();

  constructor(config: DualModeConfig) {
    super();
    this.config = {
      projectPath: config.projectPath,
      maxConcurrent: config.maxConcurrent ?? 4,
      sharedNamespace: config.sharedNamespace ?? 'collaboration',
      timeout: config.timeout ?? 300000, // 5 minutes
      claudeCommand: config.claudeCommand ?? 'claude',
      codexCommand: config.codexCommand ?? 'codex',
    };
  }

  /**
   * Cache of preflight checks: command -> resolved | rejected error
   */
  private preflightCache: Map<string, Promise<void>> = new Map();

  /**
   * Verify a CLI binary exists on PATH. Throws a friendly, actionable error
   * if missing. Result is cached per-command for the lifetime of the orchestrator.
   */
  private preflightBinary(command: string): Promise<void> {
    const cached = this.preflightCache.get(command);
    if (cached) return cached;

    const probe = new Promise<void>((resolve, reject) => {
      const isWin = process.platform === 'win32';
      const proc = spawn(
        isWin ? 'where' : 'sh',
        isWin ? [command] : ['-c', `command -v ${command}`],
        { stdio: ['ignore', 'pipe', 'pipe'] }
      );
      let stdout = '';
      proc.stdout?.on('data', (d) => { stdout += d.toString(); });
      proc.on('close', (code) => {
        if (code === 0 && stdout.trim().length > 0) {
          resolve();
        } else {
          reject(this.binaryMissingError(command));
        }
      });
      proc.on('error', () => reject(this.binaryMissingError(command)));
    });

    this.preflightCache.set(command, probe);
    return probe;
  }

  private binaryMissingError(command: string): Error {
    if (command === 'codex' || command === this.config.codexCommand) {
      return new Error(
        `Codex CLI not found on PATH (looked for "${command}"). ` +
        `Install it from https://github.com/openai/codex#install ` +
        `— or pass codexCommand in DualModeConfig / --codex-command on the CLI.`
      );
    }
    if (command === 'claude' || command === this.config.claudeCommand) {
      return new Error(
        `Claude Code CLI not found on PATH (looked for "${command}"). ` +
        `Install it from https://docs.anthropic.com/claude/docs/claude-code ` +
        `— or pass claudeCommand in DualModeConfig / --claude-command on the CLI.`
      );
    }
    return new Error(`CLI binary not found on PATH: "${command}".`);
  }

  /**
   * Initialize shared memory for collaboration
   */
  async initializeSharedMemory(taskContext: string): Promise<void> {
    const { projectPath, sharedNamespace } = this.config;

    // Initialize memory database
    await this.runCommand(
      'npx',
      ['claude-flow@alpha', 'memory', 'init', '--force'],
      projectPath
    );

    // Store task context
    await this.runCommand(
      'npx',
      [
        'claude-flow@alpha', 'memory', 'store',
        '--key', 'task-context',
        '--value', taskContext,
        '--namespace', sharedNamespace
      ],
      projectPath
    );

    this.emit('memory:initialized', { namespace: sharedNamespace, taskContext });
  }

  /**
   * Spawn a headless worker
   */
  async spawnWorker(config: WorkerConfig): Promise<void> {
    const result: WorkerResult = {
      id: config.id,
      platform: config.platform,
      role: config.role,
      status: 'pending',
      memoryKeys: [],
    };
    this.workers.set(config.id, result);

    // Wait for dependencies
    if (config.dependsOn?.length) {
      await this.waitForDependencies(config.dependsOn);
    }

    result.status = 'running';
    result.startedAt = new Date();
    this.emit('worker:started', { id: config.id, role: config.role, platform: config.platform });

    try {
      const output = await this.executeHeadless(config);
      result.status = 'completed';
      result.output = output;
      result.completedAt = new Date();
      this.emit('worker:completed', { id: config.id, output: output.slice(0, 1024) });
    } catch (error) {
      result.status = 'failed';
      result.error = error instanceof Error ? error.message : String(error);
      result.completedAt = new Date();
      this.emit('worker:failed', { id: config.id, error: result.error });
    }
  }

  /**
   * Threshold above which we pipe the prompt via stdin instead of argv.
   * ARG_MAX is 128KB on Linux, ~256KB on macOS — leave headroom for other args.
   */
  static readonly STDIN_THRESHOLD_BYTES = 64 * 1024;

  /**
   * Execute a headless Claude/Codex instance
   */
  private async executeHeadless(config: WorkerConfig): Promise<string> {
    const { timeout } = this.config;
    const command = config.platform === 'claude' ? this.config.claudeCommand : this.config.codexCommand;
    const cwd = config.cwd ?? this.config.projectPath;

    // Verify the binary is on PATH before spawning; surfaces a friendly error.
    await this.preflightBinary(command);

    // Build the prompt with memory integration
    const enhancedPrompt = this.buildCollaborativePrompt(config);
    const useStdin = Buffer.byteLength(enhancedPrompt, 'utf8') > DualModeOrchestrator.STDIN_THRESHOLD_BYTES;
    const args = this.buildArgs(config, enhancedPrompt, useStdin);

    return new Promise((resolve, reject) => {
      let output = '';
      let errorOutput = '';

      const proc = spawn(command, args, {
        cwd,
        env: { ...process.env, FORCE_COLOR: '0' },
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      this.processes.set(config.id, proc);

      // Pipe oversized prompts via stdin to avoid ARG_MAX truncation.
      if (useStdin) {
        proc.stdin?.write(enhancedPrompt);
      }
      proc.stdin?.end();

      proc.stdout?.on('data', (data) => {
        output += data.toString();
      });

      proc.stderr?.on('data', (data) => {
        errorOutput += data.toString();
      });

      const timer = setTimeout(() => {
        proc.kill('SIGTERM');
        reject(new Error(`Worker ${config.id} timed out after ${timeout}ms`));
      }, timeout);

      proc.on('close', (code) => {
        clearTimeout(timer);
        this.processes.delete(config.id);

        // Tightened: accept only on clean exit. Partial stdout from a crashed
        // process can look like success; surface the failure instead.
        if (code === 0) {
          resolve(output);
        } else {
          const detail = errorOutput.trim() || output.trim().slice(0, 500) || '(no output captured)';
          reject(new Error(`Worker ${config.id} exited with code ${code}: ${detail}`));
        }
      });

      proc.on('error', (err) => {
        clearTimeout(timer);
        this.processes.delete(config.id);
        reject(err);
      });
    });
  }

  /**
   * Build per-platform argv for the headless worker process.
   *
   * Claude Code: `claude -p [<prompt>] --output-format text [--max-turns N] [--model X] ...`
   * OpenAI Codex: `codex exec [<prompt>|-] --ask-for-approval never --sandbox <mode> ...`
   *
   * When `useStdin` is true the prompt is omitted from argv (claude reads stdin
   * after `-p`; codex reads stdin when the prompt argument is `-`).
   */
  private maxTurnsWarned = false;
  private codexToolsWarned = false;
  buildArgs(config: WorkerConfig, enhancedPrompt: string, useStdin = false): string[] {
    if (config.platform === 'codex') {
      if (config.maxTurns && !this.maxTurnsWarned) {
        console.warn(
          `[dual-mode] maxTurns is not supported by 'codex exec' and will be ignored for codex workers.`
        );
        this.maxTurnsWarned = true;
      }
      if ((config.allowedTools?.length || config.disallowedTools?.length) && !this.codexToolsWarned) {
        console.warn(
          `[dual-mode] allowedTools/disallowedTools are not supported by 'codex exec' and will be ignored for codex workers. ` +
          `Use --enable/--disable feature flags via WorkerConfig in a future version, or restrict via codex config.toml.`
        );
        this.codexToolsWarned = true;
      }
      if (config.resumeSessionId) {
        console.warn(
          `[dual-mode] resumeSessionId is not yet supported for codex workers (different argv shape). Ignoring for "${config.id}".`
        );
      }

      const sandbox: SandboxMode = config.sandbox ?? 'workspace-write';
      const args: string[] = ['exec', useStdin ? '-' : enhancedPrompt];
      args.push('--ask-for-approval', 'never');
      args.push('--sandbox', sandbox);

      // Codex defaults workspace-write to network-disabled; the collaboration
      // protocol's `npx claude-flow ... memory ...` calls need network. Default
      // to enabling it; let WorkerConfig.network=false opt out.
      if (sandbox === 'workspace-write') {
        const network = config.network !== false;
        args.push('-c', `sandbox_workspace_write.network_access=${network}`);
      }

      if (config.model) args.push('--model', config.model);
      if (config.addDirs?.length) {
        for (const d of config.addDirs) args.push('--add-dir', d);
      }
      return args;
    }

    // Claude Code
    if (config.sandbox || config.network !== undefined) {
      // Quietly informational: these don't map to claude print-mode flags.
      // No-op; documented in the WorkerConfig field comments.
    }
    const args: string[] = ['-p'];
    if (!useStdin) args.push(enhancedPrompt);
    args.push('--output-format', 'text');
    if (config.maxTurns) args.push('--max-turns', String(config.maxTurns));
    if (config.model) args.push('--model', config.model);
    if (config.allowedTools?.length) {
      args.push('--allowedTools', config.allowedTools.join(','));
    }
    if (config.disallowedTools?.length) {
      args.push('--disallowedTools', config.disallowedTools.join(','));
    }
    if (config.addDirs?.length) {
      args.push('--add-dir', ...config.addDirs);
    }
    if (config.resumeSessionId) {
      args.push('--resume', config.resumeSessionId, '--fork-session');
    }
    return args;
  }

  /**
   * Build a prompt that includes memory coordination instructions
   */
  private buildCollaborativePrompt(config: WorkerConfig): string {
    const { sharedNamespace, projectPath } = this.config;
    const instructionFile = config.platform === 'codex' ? 'AGENTS.md' : 'CLAUDE.md';

    return `You are a ${config.role.toUpperCase()} agent in a collaborative dual-mode swarm.
Platform: ${config.platform === 'claude' ? 'Claude Code' : 'OpenAI Codex'}
Working Directory: ${projectPath}
Shared Memory Namespace: ${sharedNamespace}
Project Instructions: read ${instructionFile} in the working directory for project-level guidance.

COLLABORATION PROTOCOL:
1. Search shared memory for context: npx claude-flow@alpha memory search --query "<relevant terms>" --namespace ${sharedNamespace}
2. Complete your assigned task
3. Store your results: npx claude-flow@alpha memory store --key "${config.id}-result" --value "<your summary>" --namespace ${sharedNamespace}

YOUR TASK:
${config.prompt}

Remember: Other agents depend on your results in shared memory. Be concise and store actionable outputs.`;
  }

  /**
   * Wait for dependent workers to complete
   */
  private async waitForDependencies(deps: string[]): Promise<void> {
    const checkInterval = 500;
    const maxWait = this.config.timeout;
    let waited = 0;

    while (waited < maxWait) {
      const allComplete = deps.every(depId => {
        const worker = this.workers.get(depId);
        return worker && (worker.status === 'completed' || worker.status === 'failed');
      });

      if (allComplete) return;

      await new Promise(resolve => setTimeout(resolve, checkInterval));
      waited += checkInterval;
    }

    throw new Error(`Dependencies [${deps.join(', ')}] did not complete in time`);
  }

  /**
   * Run a swarm of collaborative workers
   */
  async runCollaboration(workers: WorkerConfig[], taskContext: string): Promise<CollaborationResult> {
    const startTime = Date.now();
    const errors: string[] = [];

    // Initialize shared memory
    await this.initializeSharedMemory(taskContext);

    // Group workers by dependency level
    const levels = this.buildDependencyLevels(workers);

    // Execute each level in parallel
    for (const level of levels) {
      const promises = level.map(worker =>
        this.spawnWorker(worker).catch(err => {
          errors.push(`${worker.id}: ${err.message}`);
        })
      );
      await Promise.all(promises);
    }

    // Collect shared memory results
    const sharedMemory = await this.collectSharedMemory();

    return {
      success: errors.length === 0,
      workers: Array.from(this.workers.values()),
      sharedMemory,
      totalDuration: Date.now() - startTime,
      errors,
    };
  }

  /**
   * Build dependency levels for parallel execution
   */
  private buildDependencyLevels(workers: WorkerConfig[]): WorkerConfig[][] {
    const levels: WorkerConfig[][] = [];
    const placed = new Set<string>();

    while (placed.size < workers.length) {
      const level: WorkerConfig[] = [];

      for (const worker of workers) {
        if (placed.has(worker.id)) continue;

        const depsReady = !worker.dependsOn ||
          worker.dependsOn.every(dep => placed.has(dep));

        if (depsReady) {
          level.push(worker);
        }
      }

      if (level.length === 0 && placed.size < workers.length) {
        // Circular dependency detected, add remaining
        for (const worker of workers) {
          if (!placed.has(worker.id)) {
            level.push(worker);
          }
        }
      }

      for (const worker of level) {
        placed.add(worker.id);
      }

      if (level.length > 0) {
        levels.push(level);
      }
    }

    return levels;
  }

  /**
   * Collect results from shared memory
   */
  private async collectSharedMemory(): Promise<Record<string, any>> {
    const { projectPath, sharedNamespace } = this.config;

    try {
      const output = await this.runCommand(
        'npx',
        ['claude-flow@alpha', 'memory', 'list', '--namespace', sharedNamespace, '--format', 'json'],
        projectPath
      );
      return JSON.parse(output);
    } catch {
      return {};
    }
  }

  /**
   * Run a command and return output
   */
  private runCommand(command: string, args: string[], cwd: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const proc = spawn(command, args, { cwd, stdio: ['pipe', 'pipe', 'pipe'] });
      let output = '';
      let error = '';

      proc.stdout?.on('data', (data) => { output += data.toString(); });
      proc.stderr?.on('data', (data) => { error += data.toString(); });

      proc.on('close', (code) => {
        if (code === 0) {
          resolve(output);
        } else {
          reject(new Error(error || `Command failed with code ${code}`));
        }
      });

      proc.on('error', reject);
    });
  }

  /**
   * Stop all running workers
   */
  stopAll(): void {
    for (const [id, proc] of this.processes) {
      proc.kill('SIGTERM');
      this.emit('worker:stopped', { id });
    }
    this.processes.clear();
  }
}

/**
 * Pre-built collaboration templates
 */
export const CollaborationTemplates = {
  /**
   * Feature development swarm
   */
  featureDevelopment: (feature: string): WorkerConfig[] => [
    {
      id: 'architect',
      platform: 'claude',
      role: 'architect',
      prompt: `Design the architecture for: ${feature}. Define components, interfaces, and data flow.`,
      maxTurns: 10,
    },
    {
      id: 'coder',
      platform: 'codex',
      role: 'coder',
      prompt: `Implement the feature based on the architecture. Write clean, typed code.`,
      dependsOn: ['architect'],
      maxTurns: 15,
    },
    {
      id: 'tester',
      platform: 'codex',
      role: 'tester',
      prompt: `Write comprehensive tests for the implementation. Target 80% coverage.`,
      dependsOn: ['coder'],
      maxTurns: 10,
    },
    {
      id: 'reviewer',
      platform: 'claude',
      role: 'reviewer',
      prompt: `Review the code and tests for quality, security, and best practices.`,
      dependsOn: ['coder', 'tester'],
      maxTurns: 8,
    },
  ],

  /**
   * Security audit swarm
   */
  securityAudit: (target: string): WorkerConfig[] => [
    {
      id: 'scanner',
      platform: 'codex',
      role: 'security-scanner',
      prompt: `Scan ${target} for security vulnerabilities. Check OWASP Top 10.`,
      maxTurns: 10,
    },
    {
      id: 'analyzer',
      platform: 'claude',
      role: 'security-analyst',
      prompt: `Analyze scan results and identify critical vulnerabilities.`,
      dependsOn: ['scanner'],
      maxTurns: 8,
    },
    {
      id: 'fixer',
      platform: 'codex',
      role: 'security-fixer',
      prompt: `Generate fixes for identified vulnerabilities.`,
      dependsOn: ['analyzer'],
      maxTurns: 12,
    },
  ],

  /**
   * Refactoring swarm
   */
  refactoring: (target: string): WorkerConfig[] => [
    {
      id: 'analyzer',
      platform: 'claude',
      role: 'code-analyzer',
      prompt: `Analyze ${target} for refactoring opportunities. Identify code smells.`,
      maxTurns: 8,
    },
    {
      id: 'planner',
      platform: 'claude',
      role: 'refactor-planner',
      prompt: `Create a refactoring plan based on the analysis.`,
      dependsOn: ['analyzer'],
      maxTurns: 6,
    },
    {
      id: 'refactorer',
      platform: 'codex',
      role: 'refactorer',
      prompt: `Execute the refactoring plan. Maintain all existing functionality.`,
      dependsOn: ['planner'],
      maxTurns: 15,
    },
    {
      id: 'validator',
      platform: 'codex',
      role: 'validator',
      prompt: `Run tests and validate the refactoring didn't break anything.`,
      dependsOn: ['refactorer'],
      maxTurns: 5,
    },
  ],
};
