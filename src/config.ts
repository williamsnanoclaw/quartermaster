import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The manifest is the onboarding script. Every setting the agent needs is
 * declared once, with enough context that a person who has never seen this
 * project can get it. Add a field here and the wizard picks it up.
 */
export type Setting = {
  key: string;
  label: string;
  /** Why the agent needs it, in the human's terms. Shown before the prompt. */
  why: string;
  /** Click-by-click. Assume they have never opened this dashboard before. */
  how?: string[];
  url?: string;
  secret?: boolean;
  optional?: boolean;
  /**
   * A host folder, mounted into the container at /workspace/mounts/<mountAs>.
   * This is a deliberate hole in the sandbox: the agent's shell writes straight
   * through it to real files, and no tool gate can see that happen.
   */
  mountAs?: string;
  /** Mounts are read-only unless you say otherwise. Say otherwise on purpose. */
  writable?: boolean;
  /**
   * 'agent'   — passed into the container as an environment variable, where
   *             the agent's own shell can read it with `env`.
   * 'gated'   — held by the host, handed to a tool only inside a call you
   *             approved. Never in the container's environment.
   * 'runtime' — delivered to the supervisor over stdin. Used by the runtime
   *             itself, never exposed to tools or to the shell.
   */
  scope?: 'agent' | 'gated' | 'runtime';
  /** Prefilled in the wizard, and used when the value is left blank. */
  default?: string;
  /** Turns the prompt into a numbered pick list. */
  choices?: string[];
  /** Return true, or a sentence explaining what is wrong. */
  validate?: (value: string) => true | string;
};

export type Manifest = {
  /** Lowercase, no spaces. Names the image, the volume and the dashboard. */
  name: string;
  tagline: string;
  settings: Setting[];
};

// ------------------------------------------------------------------- .env io

const envPath = (root: string) => join(root, '.env');

export function readEnv(root: string): Record<string, string> {
  if (!existsSync(envPath(root))) return {};
  const env: Record<string, string> = {};
  for (const line of readFileSync(envPath(root), 'utf8').split('\n')) {
    const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
    if (!match) continue;
    env[match[1]!] = match[2]!.trim().replace(/^["'](.*)["']$/, '$1');
  }
  return env;
}

export function writeEnv(root: string, env: Record<string, string>) {
  const body = Object.entries(env)
    .filter(([, value]) => value !== '')
    .map(([key, value]) => `${key}=${/[\s#"']/.test(value) ? JSON.stringify(value) : value}`)
    .join('\n');
  writeFileSync(envPath(root), `${body}\n`, { mode: 0o600 });
}

/** Sort every configured value into how it reaches the container, if at all. */
export const split = (manifest: Manifest, env: Record<string, string>) => {
  const agent: Record<string, string> = {};
  const gated: Record<string, string> = {};
  const runtime: Record<string, string> = {};
  const buckets = { agent, gated, runtime };
  for (const setting of manifest.settings) {
    const value = env[setting.key] ?? setting.default ?? '';
    if (value) buckets[setting.scope ?? 'agent'][setting.key] = value;
  }
  return { agent, gated, runtime };
};

export const mounts = (manifest: Manifest, env: Record<string, string>) =>
  manifest.settings
    .filter((s) => s.mountAs && env[s.key])
    .map((s) => ({ host: env[s.key]!, as: s.mountAs!, readonly: s.writable !== true }));
