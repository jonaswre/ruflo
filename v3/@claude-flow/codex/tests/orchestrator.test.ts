/**
 * Tests for DualModeOrchestrator — covers per-platform argv construction
 * and the binary preflight check that runs before spawning a worker.
 */

import { describe, it, expect } from 'vitest';
import { DualModeOrchestrator, type WorkerConfig } from '../src/dual-mode/orchestrator.js';

function makeOrchestrator() {
  return new DualModeOrchestrator({ projectPath: process.cwd() });
}

const promptArg = 'You are a TEST agent...';

describe('DualModeOrchestrator.buildArgs', () => {
  describe('platform: claude', () => {
    it('uses `-p <prompt> --output-format text` shape', () => {
      const o = makeOrchestrator();
      const cfg: WorkerConfig = { id: 'a', platform: 'claude', role: 'tester', prompt: 'x' };
      const args = o.buildArgs(cfg, promptArg);
      expect(args.slice(0, 4)).toEqual(['-p', promptArg, '--output-format', 'text']);
    });

    it('forwards --max-turns and --model when set', () => {
      const o = makeOrchestrator();
      const cfg: WorkerConfig = {
        id: 'a', platform: 'claude', role: 'tester', prompt: 'x',
        maxTurns: 7, model: 'sonnet',
      };
      const args = o.buildArgs(cfg, promptArg);
      expect(args).toContain('--max-turns');
      expect(args[args.indexOf('--max-turns') + 1]).toBe('7');
      expect(args).toContain('--model');
      expect(args[args.indexOf('--model') + 1]).toBe('sonnet');
    });
  });

  describe('platform: codex', () => {
    it('uses `exec <prompt> --ask-for-approval never --sandbox workspace-write`', () => {
      const o = makeOrchestrator();
      const cfg: WorkerConfig = { id: 'c', platform: 'codex', role: 'coder', prompt: 'x' };
      const args = o.buildArgs(cfg, promptArg);
      expect(args[0]).toBe('exec');
      expect(args[1]).toBe(promptArg);
      expect(args).toContain('--ask-for-approval');
      expect(args[args.indexOf('--ask-for-approval') + 1]).toBe('never');
      expect(args).toContain('--sandbox');
      expect(args[args.indexOf('--sandbox') + 1]).toBe('workspace-write');
    });

    it('does NOT forward --output-format or --max-turns (unsupported on codex exec)', () => {
      const o = makeOrchestrator();
      const cfg: WorkerConfig = {
        id: 'c', platform: 'codex', role: 'coder', prompt: 'x',
        maxTurns: 7,
      };
      const args = o.buildArgs(cfg, promptArg);
      expect(args).not.toContain('--output-format');
      expect(args).not.toContain('--max-turns');
    });

    it('forwards --model when set', () => {
      const o = makeOrchestrator();
      const cfg: WorkerConfig = {
        id: 'c', platform: 'codex', role: 'coder', prompt: 'x',
        model: 'gpt-5-codex',
      };
      const args = o.buildArgs(cfg, promptArg);
      expect(args).toContain('--model');
      expect(args[args.indexOf('--model') + 1]).toBe('gpt-5-codex');
    });
  });
});

describe('DualModeOrchestrator preflight (binary on PATH)', () => {
  it('emits a friendly error mentioning the install URL when codex is missing', async () => {
    const o = new DualModeOrchestrator({
      projectPath: process.cwd(),
      codexCommand: '__definitely_not_a_real_codex_binary__',
    });
    const cfg: WorkerConfig = {
      id: 'c', platform: 'codex', role: 'coder', prompt: 'x',
    };
    await o.spawnWorker(cfg);
    const result = (o as any).workers.get('c');
    expect(result.status).toBe('failed');
    expect(result.error).toMatch(/Codex CLI not found/i);
    expect(result.error).toMatch(/github\.com\/openai\/codex/);
  });

  it('emits a friendly error mentioning the install URL when claude is missing', async () => {
    const o = new DualModeOrchestrator({
      projectPath: process.cwd(),
      claudeCommand: '__definitely_not_a_real_claude_binary__',
    });
    const cfg: WorkerConfig = {
      id: 'a', platform: 'claude', role: 'tester', prompt: 'x',
    };
    await o.spawnWorker(cfg);
    const result = (o as any).workers.get('a');
    expect(result.status).toBe('failed');
    expect(result.error).toMatch(/Claude Code CLI not found/i);
    expect(result.error).toMatch(/anthropic\.com/);
  });
});

describe('DualModeOrchestrator defaults', () => {
  it('defaults codexCommand to "codex" (not "claude")', () => {
    const o = new DualModeOrchestrator({ projectPath: '/tmp' });
    expect((o as any).config.codexCommand).toBe('codex');
  });

  it('defaults claudeCommand to "claude"', () => {
    const o = new DualModeOrchestrator({ projectPath: '/tmp' });
    expect((o as any).config.claudeCommand).toBe('claude');
  });
});

describe('codex network access (workspace-write default)', () => {
  it('injects sandbox_workspace_write.network_access=true by default', () => {
    const o = makeOrchestrator();
    const cfg: WorkerConfig = { id: 'c', platform: 'codex', role: 'coder', prompt: 'x' };
    const args = o.buildArgs(cfg, promptArg);
    const cIdx = args.indexOf('-c');
    expect(cIdx).toBeGreaterThan(-1);
    expect(args[cIdx + 1]).toBe('sandbox_workspace_write.network_access=true');
  });

  it('honors network: false to disable network access', () => {
    const o = makeOrchestrator();
    const cfg: WorkerConfig = { id: 'c', platform: 'codex', role: 'coder', prompt: 'x', network: false };
    const args = o.buildArgs(cfg, promptArg);
    const cIdx = args.indexOf('-c');
    expect(args[cIdx + 1]).toBe('sandbox_workspace_write.network_access=false');
  });

  it('does NOT inject network override when sandbox is read-only', () => {
    const o = makeOrchestrator();
    const cfg: WorkerConfig = { id: 'c', platform: 'codex', role: 'coder', prompt: 'x', sandbox: 'read-only' };
    const args = o.buildArgs(cfg, promptArg);
    expect(args).not.toContain('-c');
    expect(args[args.indexOf('--sandbox') + 1]).toBe('read-only');
  });
});

describe('per-worker overrides', () => {
  it('forwards --add-dir for both platforms', () => {
    const o = makeOrchestrator();
    const claudeArgs = o.buildArgs(
      { id: 'a', platform: 'claude', role: 'r', prompt: 'x', addDirs: ['/tmp/foo', '/tmp/bar'] },
      promptArg
    );
    expect(claudeArgs).toContain('--add-dir');
    // claude takes variadic
    expect(claudeArgs.slice(claudeArgs.indexOf('--add-dir') + 1, claudeArgs.indexOf('--add-dir') + 3))
      .toEqual(['/tmp/foo', '/tmp/bar']);

    const codexArgs = o.buildArgs(
      { id: 'c', platform: 'codex', role: 'r', prompt: 'x', addDirs: ['/tmp/foo', '/tmp/bar'] },
      promptArg
    );
    // codex requires repeated flag
    const occurrences = codexArgs.filter((a) => a === '--add-dir').length;
    expect(occurrences).toBe(2);
  });

  it('forwards allowedTools/disallowedTools to claude only', () => {
    const o = makeOrchestrator();
    const claudeArgs = o.buildArgs(
      { id: 'a', platform: 'claude', role: 'r', prompt: 'x', allowedTools: ['Read', 'Grep'], disallowedTools: ['Bash'] },
      promptArg
    );
    expect(claudeArgs).toContain('--allowedTools');
    expect(claudeArgs[claudeArgs.indexOf('--allowedTools') + 1]).toBe('Read,Grep');
    expect(claudeArgs).toContain('--disallowedTools');
    expect(claudeArgs[claudeArgs.indexOf('--disallowedTools') + 1]).toBe('Bash');

    // Codex: silently dropped (warning emitted by buildArgs, but argv has neither flag)
    const codexArgs = o.buildArgs(
      { id: 'c', platform: 'codex', role: 'r', prompt: 'x', allowedTools: ['Read'] },
      promptArg
    );
    expect(codexArgs).not.toContain('--allowedTools');
    expect(codexArgs).not.toContain('--disallowedTools');
  });

  it('forwards --resume + --fork-session for claude (codex resume not supported)', () => {
    const o = makeOrchestrator();
    const claudeArgs = o.buildArgs(
      { id: 'a', platform: 'claude', role: 'r', prompt: 'x', resumeSessionId: 'abc-123' },
      promptArg
    );
    expect(claudeArgs).toContain('--resume');
    expect(claudeArgs[claudeArgs.indexOf('--resume') + 1]).toBe('abc-123');
    expect(claudeArgs).toContain('--fork-session');

    const codexArgs = o.buildArgs(
      { id: 'c', platform: 'codex', role: 'r', prompt: 'x', resumeSessionId: 'abc-123' },
      promptArg
    );
    expect(codexArgs).not.toContain('--resume');
  });
});

describe('stdin fallback for oversized prompts', () => {
  it('omits the prompt from argv when useStdin is true (claude: -p with no value)', () => {
    const o = makeOrchestrator();
    const args = o.buildArgs(
      { id: 'a', platform: 'claude', role: 'r', prompt: 'x' },
      promptArg,
      true
    );
    // -p must be present but NOT immediately followed by the prompt content
    expect(args[0]).toBe('-p');
    expect(args[1]).toBe('--output-format');
    expect(args).not.toContain(promptArg);
  });

  it('uses "-" as the prompt arg for codex when useStdin is true', () => {
    const o = makeOrchestrator();
    const args = o.buildArgs(
      { id: 'c', platform: 'codex', role: 'r', prompt: 'x' },
      promptArg,
      true
    );
    expect(args[0]).toBe('exec');
    expect(args[1]).toBe('-');
    expect(args).not.toContain(promptArg);
  });

  it('STDIN_THRESHOLD_BYTES is 64KB', () => {
    expect(DualModeOrchestrator.STDIN_THRESHOLD_BYTES).toBe(64 * 1024);
  });
});
