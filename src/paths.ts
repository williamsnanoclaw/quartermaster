import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { basename, dirname, join, parse, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { manifest } from '../agent/manifest.ts';

/**
 * Two roots, and confusing them is the bug this file exists to prevent.
 *
 * The *install* is the checkout this CLI was built from: the Docker build
 * context, and the template `init` copies. It is shared by every folder.
 *
 * The *project* is wherever the human typed the command, and it is the whole
 * of the agent's world — its job, its credentials, its memory and its working
 * files all live inside it. Run the command somewhere else and you get a
 * different agent, not the same one looking at a different folder.
 */
export const install = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

export const project = process.cwd();

/**
 * The one directory the agent owns, named after the agent. Delete it and it is
 * factory-new, without touching a file the human wrote. It tracks
 * `manifest.name` rather than being a literal so that renaming the agent does
 * not leave the old name's directory sitting in every project it ever ran in.
 */
export const stateDir = `.${manifest.name}`;
export const state = join(project, stateDir);
export const agentDir = join(state, 'agent');
export const envFile = join(state, '.env');
export const authFile = join(state, '.codex', 'auth.json');

/**
 * Distinct per folder, so two projects run side by side without sharing a
 * journal, and docker.ts's "already running" guard comes to mean this folder
 * rather than this machine. The basename is there so `docker ps` is readable;
 * the hash is what actually keeps two folders of the same name apart.
 */
export const container = (name: string) => {
  const label = basename(project)
    .replace(/[^a-zA-Z0-9_.-]/g, '-')
    .slice(0, 24);
  return `${name}-${label}-${createHash('sha256').update(project).digest('hex').slice(0, 8)}`;
};

/**
 * The project is mounted writable, which makes the folder the sandbox
 * boundary. Some folders are far too big to be one: your home directory hands
 * over every SSH key, browser profile and stray .env you own. Name the folder
 * and refuse rather than explaining the risk in a paragraph nobody reads.
 */
export function tooWide(): string | null {
  const home = homedir();
  if (project === parse(project).root) return 'the filesystem root';
  if (project === home) return 'your home folder';
  if (project === dirname(home)) return `${dirname(home)}, which holds every account on this machine`;
  return null;
}
