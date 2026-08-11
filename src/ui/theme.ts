import type { State } from '../protocol.ts';

/** One place to change how the dashboard feels. */
export const color = {
  idle: 'gray',
  thinking: 'cyan',
  working: 'cyan',
  waiting: 'yellow',
  blocked: 'red',
  error: 'red',
  booting: 'gray',
} satisfies Record<State, string>;

export const label: Record<State, string> = {
  booting: 'starting',
  idle: 'idle',
  thinking: 'thinking',
  working: 'working',
  waiting: 'needs you',
  blocked: 'blocked',
  error: 'error',
};

export const GUTTER = 8;

/** "4m", "2h", "just now" — a duration a person reads without doing maths. */
export function since(from: number): string {
  const seconds = Math.max(0, Math.round((Date.now() - from) / 1000));
  if (seconds < 10) return 'now';
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
  if (seconds < 86_400) return `${Math.round(seconds / 3600)}h`;
  return `${Math.round(seconds / 86_400)}d`;
}

/** "in 42m" for a future timestamp. */
export function until(at: number): string {
  const seconds = Math.max(0, Math.round((at - Date.now()) / 1000));
  if (seconds < 60) return 'in <1m';
  if (seconds < 3600) return `in ${Math.round(seconds / 60)}m`;
  if (seconds < 86_400) return `in ${Math.round(seconds / 3600)}h`;
  return `in ${Math.round(seconds / 86_400)}d`;
}
