import { spawn } from 'node:child_process';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Activity } from '../protocol.ts';
import { paths } from './workspace.ts';

/**
 * Codex is the brain. We do not reimplement the agent loop — the CLI already
 * has one, with tool use, shell access, web search and durable threads, billed
 * against your ChatGPT plan. This module spawns it, reads its JSONL event
 * stream, and translates it into things the dashboard can show.
 */

export type Usage = {
  input_tokens: number;
  cached_input_tokens: number;
  output_tokens: number;
  reasoning_output_tokens: number;
};

export type TurnResult = {
  threadId: string | null;
  text: string;
  usage: Usage | null;
  error: string | null;
  /**
   * Where the error came from. Only `event` errors are Codex talking; `stderr`
   * is a grab-bag that can contain the agent's own shell output, so it must
   * never be pattern-matched for anything consequential.
   */
  errorKind: 'event' | 'stderr' | 'spawn' | 'interrupted' | null;
};

export type TurnHandlers = {
  onActivity: (activity: Activity) => void;
  onMessage: (text: string) => void;
};

const clip = (text: string, max = 110) =>
  text.replace(/\s+/g, ' ').trim().slice(0, max) + (text.length > max ? '…' : '');

/**
 * Codex numbers its stream items per thread, so ids repeat after a rotation.
 * Namespacing by turn keeps the dashboard from rewriting old lines in place.
 */
let turn = 0;

/** Render one Codex stream item as a dashboard line. Unknown types still show. */
function describe(item: Record<string, any>): Activity | null {
  const status: Activity['status'] =
    item.status === 'in_progress' ? 'running' : item.status === 'failed' || item.exit_code ? 'failed' : 'ok';
  const id = `${turn}:${item.id ?? Math.random()}`;

  switch (item.type) {
    case 'agent_message':
      return null; // surfaced as a chat message instead
    case 'reasoning':
      return { id, kind: 'think', text: clip(item.summary ?? item.text ?? 'thinking'), status };
    case 'command_execution':
      return { id, kind: 'command', text: clip(item.command ?? ''), status };
    case 'file_change': {
      const changes: Array<{ path: string; kind: string }> = item.changes ?? [];
      const summary = changes.map((c) => `${c.kind} ${c.path.split(/[\\/]/).pop()}`).join(', ');
      return { id, kind: 'file', text: clip(summary), status };
    }
    case 'mcp_tool_call':
      return { id, kind: 'tool', text: clip(`${item.server ?? ''}.${item.tool ?? ''}`.replace(/^\./, '')), status };
    case 'web_search':
      return { id, kind: 'search', text: clip(item.query ?? ''), status };
    default:
      return { id, kind: 'note', text: clip(`${item.type}`), status };
  }
}

/** Render agent/codex.toml plus the bits Temper requires into CODEX_HOME. */
export function writeCodexConfig() {
  let base = '';
  try {
    base = readFileSync('/app/agent/codex.toml', 'utf8');
  } catch {
    base = 'model = "gpt-5.6-sol"\nmodel_reasoning_effort = "medium"\n';
  }
  const required = [
    '',
    '# --- managed by Temper, edits here are overwritten on boot ---',
    '# The container is the sandbox, so Codex itself runs unrestricted inside it.',
    'approval_policy = "never"',
    'sandbox_mode = "danger-full-access"',
    '',
    '[mcp_servers.temper]',
    'command = "node"',
    'args = ["/app/src/runtime/mcp.ts"]',
    '',
  ].join('\n');
  writeFileSync(join(paths.codexHome, 'config.toml'), `${base.trimEnd()}\n${required}`);
}

const codex = (args: string[]) =>
  spawn('codex', args, {
    cwd: paths.root,
    env: { ...process.env, CODEX_HOME: paths.codexHome },
    stdio: 'pipe',
    // Its own process group, so an interrupt can take down the shell children
    // too rather than leaving them holding the pipes.
    detached: true,
  });

/** Kill a whole process group, then insist. */
function halt(pid: number | undefined) {
  if (!pid) return;
  const signal = (name: NodeJS.Signals) => {
    try {
      process.kill(-pid, name);
    } catch {
      // Group already gone.
    }
  };
  signal('SIGTERM');
  setTimeout(() => signal('SIGKILL'), 5_000).unref();
}

/** True once Codex has usable credentials. It reports this on stderr, not stdout. */
export async function loginStatus(): Promise<boolean> {
  return new Promise((resolve) => {
    const child = codex(['login', 'status']);
    child.stdin.end();
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    child.on('close', (code) => resolve(code === 0 && /logged in/i.test(out) && !/not logged in/i.test(out)));
    child.on('error', () => resolve(false));
  });
}

/** Credentials go stale. Throwing them away is always safe — you can sign in again. */
export function logout() {
  try {
    rmSync(join(paths.codexHome, 'auth.json'));
  } catch {
    // Already gone.
  }
}

/** Anything that means "these credentials are dead", not "this turn went wrong". */
export const isAuthFailure = (error: string) =>
  /refresh token|log ?out and sign in|sign in again|unauthorized|401/i.test(error);

/**
 * Sign in from inside the container. Device auth prints a URL and a code; we
 * pass those lines through verbatim rather than parsing them, so a change in
 * Codex's wording can never lock you out of your own agent.
 */
export async function login(onLines: (lines: string[]) => void): Promise<boolean> {
  const apiKey = process.env.OPENAI_API_KEY;
  const child = codex(apiKey ? ['login', '--with-api-key'] : ['login', '--device-auth']);
  if (apiKey) child.stdin.end(apiKey);

  const relay = (chunk: Buffer) => {
    const lines = chunk
      .toString()
      .replace(/\x1b\[[0-9;]*m/g, '') // the dashboard does its own colouring
      .split('\n')
      .map((line) => line.trimEnd())
      .filter(Boolean);
    if (lines.length) onLines(lines);
  };
  child.stdout.on('data', relay);
  child.stderr.on('data', relay);

  return new Promise((resolve) => {
    child.on('close', (code) => resolve(code === 0));
    child.on('error', () => resolve(false));
  });
}

/**
 * Run one turn. `threadId` continues an existing conversation; omit it to
 * start a fresh one. Returns when Codex is done or the signal aborts.
 */
export function runTurn(
  prompt: string,
  threadId: string | null,
  handlers: TurnHandlers,
  signal: AbortSignal,
): Promise<TurnResult> {
  const flags = [
    '--json',
    '--skip-git-repo-check',
    '--dangerously-bypass-approvals-and-sandbox',
    ...(process.env.TEMPER_MODEL ? ['-m', process.env.TEMPER_MODEL] : []),
  ];
  const args = threadId ? ['exec', 'resume', threadId, ...flags, '-'] : ['exec', ...flags, '-'];

  // Re-rendered every turn rather than at boot, so editing agent/codex.toml on
  // the host — it is a live mount — takes effect on the next thing you say.
  writeCodexConfig();

  const child = codex(args);
  child.stdin.end(prompt);
  turn += 1;

  const result: TurnResult = { threadId, text: '', usage: null, error: null, errorKind: null };
  let stderr = '';
  let buffer = '';

  const onAbort = () => halt(child.pid);
  signal.addEventListener('abort', onAbort, { once: true });

  child.stdout.on('data', (chunk: Buffer) => {
    buffer += chunk.toString();
    let cut: number;
    while ((cut = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, cut).trim();
      buffer = buffer.slice(cut + 1);
      if (!line.startsWith('{')) continue;
      let event: any;
      try {
        event = JSON.parse(line);
      } catch {
        continue;
      }

      if (event.type === 'thread.started') result.threadId = event.thread_id;
      else if (event.type === 'turn.completed') result.usage = event.usage ?? null;
      else if (event.type === 'turn.failed' || event.type === 'error') {
        result.error = event.error?.message ?? event.message ?? 'turn failed';
        result.errorKind = 'event';
      } else if (event.type === 'item.started' || event.type === 'item.completed') {
        const item = event.item ?? {};
        if (item.type === 'agent_message' && event.type === 'item.completed' && item.text) {
          // A turn can speak more than once; the relay to phone and rooms
          // should carry all of it, not just the last line.
          result.text = result.text ? `${result.text}\n\n${item.text}` : item.text;
          handlers.onMessage(item.text);
        } else {
          const activity = describe(item);
          if (activity) handlers.onActivity(activity);
        }
      }
    }
  });

  child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));

  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', onAbort);
      if (signal.aborted) {
        result.error = 'interrupted';
        result.errorKind = 'interrupted';
      } else if (result.error === null && !result.text && stderr) {
        result.error = clip(stderr, 400);
        result.errorKind = 'stderr';
      }
      resolve(result);
    };

    child.on('error', (err) => {
      result.error ??= err.message;
      result.errorKind ??= 'spawn';
      finish();
    });
    // 'close' waits for every inherited pipe to shut, which a process the agent
    // backgrounded will hold open forever. 'exit' plus a beat to drain stdout
    // is the difference between a turn ending and the queue wedging for good.
    child.on('exit', () => setTimeout(finish, 250).unref());
    child.on('close', finish);
  });
}
