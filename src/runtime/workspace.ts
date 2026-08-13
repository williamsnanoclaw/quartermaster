import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Two directories, not one.
 *
 * `root` is the human's folder, bind-mounted straight off their machine. It is
 * the agent's working directory and the whole of what it can touch — there is
 * no sandbox inside the sandbox, so everything here is real.
 *
 * `home` is the agent's own corner of it. Memory, journal, schedules and
 * credentials live there rather than loose in the folder, for two reasons: an
 * agent working in a real project should not bury it in its own files, and a
 * project with its own AGENTS.md must never have it overwritten by ours.
 */
const root = process.env.TEMPER_WORKSPACE ?? '/workspace';
// Set by the host, which names it after the agent. The fallback only matters
// for a bare `docker run` with no host in front of it.
const home = join(root, process.env.TEMPER_STATE ?? '.quartermaster');

export const paths = {
  root,
  home,
  agent: join(home, 'agent'),
  codexHome: join(home, '.codex'),
  memory: join(home, 'memory'),
  files: join(home, 'files'),
  mounts: join(home, 'mounts'),
  journal: join(home, 'journal.db'),
  schedules: join(home, 'schedules.json'),
  state: join(home, 'state.json'),
  socket: '/tmp/temper.sock',
};

export function ensureWorkspace() {
  for (const dir of [paths.codexHome, paths.memory, paths.files, paths.mounts]) {
    mkdirSync(dir, { recursive: true });
  }
}
