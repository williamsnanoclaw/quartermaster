// The wire between your terminal (host) and the agent (container).
// One JSON object per line, both directions, over the container's stdio.
//
// This is also the lifeline: when your terminal closes, stdin closes, and the
// runtime exits. No daemon, no orphans, no agent running behind your back.

export type State =
  | 'booting'
  | 'idle'
  | 'thinking'
  | 'working'
  | 'waiting' // waiting on you
  | 'blocked' // stuck, needs a decision or a credential
  | 'error';

/**
 * What the dashboard shows. Deliberately loose: `detail` and `metrics` are
 * whatever your agent decides matters. A triage agent puts "12 unread" here;
 * a trading agent puts its position. Set it with the `status` tool.
 */
export type Status = {
  state: State;
  detail: string;
  metrics: Record<string, string>;
  since: number;
  next?: { name: string; at: number } | null;
};

export type Activity = {
  id: string;
  kind: 'command' | 'file' | 'tool' | 'search' | 'think' | 'note';
  text: string;
  status: 'running' | 'ok' | 'failed';
};

export type Source = 'terminal' | 'phone' | 'room' | 'schedule' | 'system';

export type Msg = {
  id: string;
  role: 'you' | 'agent' | 'system';
  text: string;
  source: Source;
  at: number;
};

export type ToHost =
  | { k: 'ready'; name: string }
  | { k: 'status'; status: Status }
  | { k: 'msg'; msg: Msg }
  | { k: 'activity'; activity: Activity }
  | { k: 'ask'; id: string; question: string; options?: string[]; effect?: string }
  | { k: 'resolved'; id: string } // an ask was answered elsewhere (your phone)
  | { k: 'login'; lines: string[] } // device-auth output, passed through verbatim
  | { k: 'notice'; level: 'info' | 'warn' | 'error'; text: string };

export type ToAgent =
  /**
   * Always first. Carries everything we refuse to put in the container's
   * environment, because the agent's own shell can read `env`: your Codex
   * credentials, the token that speaks to your phone, and any secret marked
   * `gated` in the manifest. These live in the supervisor's memory only.
   */
  | {
      k: 'hello';
      authJson?: string;
      agentUpdateToken?: string;
      secrets?: Record<string, string>;
      tz?: string;
    }
  /**
   * Settings changed on disk. Sent whenever .env or agent/ changes, so a model
   * swap or a new credential lands on the next turn instead of on a restart.
   */
  | { k: 'config'; env: Record<string, string>; secrets: Record<string, string>; agentUpdateToken?: string }
  | { k: 'say'; text: string }
  /** A standing order. Outlives every session arc. */
  | { k: 'correct'; text: string }
  | { k: 'answer'; id: string; value: string }
  | { k: 'interrupt' }
  | { k: 'ping' };

/** Split a byte stream into whole JSON lines. Tolerates partial chunks. */
export function lineReader<T>(onValue: (value: T) => void) {
  let buffer = '';
  return (chunk: Buffer | string) => {
    buffer += chunk.toString();
    let cut: number;
    while ((cut = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, cut).trim();
      buffer = buffer.slice(cut + 1);
      if (!line) continue;
      try {
        onValue(JSON.parse(line) as T);
      } catch {
        // Not our protocol (a stray log line). Dropping it is correct.
      }
    }
  };
}

export const encode = (value: unknown) => `${JSON.stringify(value)}\n`;
