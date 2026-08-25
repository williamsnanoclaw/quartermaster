import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The agent runs in a container or it does not run.
 *
 * Not because containers are fashionable, but because it is the only line in
 * this project the model cannot argue its way past. Everything else — tool
 * gates, instructions, approvals — is a promise. This is a wall.
 */

export const has = (command: string) =>
  spawnSync(command, ['--version'], { stdio: 'ignore', shell: false }).status === 0;

/**
 * Rebuilds only when something baked into the image changed. `agent/` is not
 * hashed because it is mounted, not copied — editing a tool only needs a
 * restart. Everything else here is copied, so it has to invalidate the tag.
 */
function tagFor(root: string, name: string) {
  const hash = createHash('sha256');
  const walk = (path: string, prefix = '') => {
    for (const entry of readdirSync(path, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const child = join(path, entry.name);
      if (entry.isDirectory()) walk(child, `${prefix}${entry.name}/`);
      else hash.update(`${prefix}${entry.name}`).update(readFileSync(child));
    }
  };
  for (const file of ['Dockerfile', 'package.json', 'package-lock.json']) {
    try {
      hash.update(readFileSync(join(root, file)));
    } catch {
      if (file !== 'package-lock.json') throw new Error(`${root} has no ${file} — this checkout is incomplete`);
    }
  }
  hash.update(readFileSync(join(root, 'src', 'protocol.ts')));
  walk(join(root, 'src', 'runtime'));
  return `temper/${name}:${hash.digest('hex').slice(0, 12)}`;
}

const run = (args: string[]) => spawnSync('docker', args, { encoding: 'utf8' });

export async function ensureImage(root: string, name: string, opts: { force?: boolean } = {}): Promise<string> {
  const tag = tagFor(root, name);
  if (!opts.force && run(['image', 'inspect', tag]).status === 0) return tag;

  process.stdout.write(`building ${tag} — first run takes a couple of minutes\n\n`);
  const build = spawn('docker', ['build', '-t', tag, '.'], { cwd: root, stdio: 'inherit' });
  const code = await new Promise<number>((resolve) => build.on('close', (c) => resolve(c ?? 1)));
  if (code !== 0) throw new Error('docker build failed');
  return tag;
}

export type Launch = {
  /** The human's folder. Becomes /workspace, writable. */
  project: string;
  /** <project>/<stateDir>/agent — this folder's job definition. */
  agentDir: string;
  /** The agent's own directory, relative to the project. `.quartermaster`. */
  stateDir: string;
  container: string;
  tag: string;
  env: Record<string, string>;
  mounts: Array<{ host: string; as: string; readonly: boolean }>;
};

/**
 * `--rm -i` is the whole lifecycle story: the container's stdin is this
 * process's pipe, so when your terminal dies, stdin closes, the runtime exits,
 * and Docker removes the container. Nothing survives you.
 */
export function start({ project, agentDir, stateDir, container, tag, env, mounts }: Launch): ChildProcess {
  if (run(['ps', '-q', '-f', `name=^${container}$`]).stdout.trim()) {
    throw new Error(`This folder's agent is already running in another terminal. Close that one first.`);
  }
  run(['rm', '-f', container]);

  const args = [
    'run',
    '--rm',
    '-i',
    '--init',
    '--name',
    container,
    // A runaway agent should exhaust its own container, not the machine.
    '--memory',
    process.env.TEMPER_MEMORY ?? '4g',
    '--pids-limit',
    '512',
    // Nothing inside can gain privileges it wasn't started with, even via setuid.
    '--security-opt',
    'no-new-privileges',
    // The folder is the workspace. Not a named volume: "everything it owns
    // lives in that folder" is the point, and a volume would hide the agent's
    // memory and journal somewhere only `docker volume` can reach them.
    '-v',
    `${project}:/workspace`,
    // The job definition, mounted twice. /app/agent is where the runtime reads
    // it. The second is a read-only lid over the same files inside the
    // writable project mount: the agent can read its own north star and cannot
    // quietly rewrite it between one boot and the next.
    '-v',
    `${agentDir}:/app/agent:ro`,
    '-v',
    `${agentDir}:/workspace/${stateDir}/agent:ro`,
    // The runtime hangs every one of its paths off this, so the host stays the
    // single source of truth for where the agent's own directory is.
    '-e',
    `TEMPER_STATE=${stateDir}`,
  ];
  for (const mount of mounts) {
    args.push('-v', `${mount.host}:/workspace/${stateDir}/mounts/${mount.as}${mount.readonly ? ':ro' : ''}`);
  }
  for (const [key, value] of Object.entries(env)) {
    args.push('-e', `${key}=${value}`);
  }
  args.push(tag);

  const child = spawn('docker', args, { stdio: ['pipe', 'pipe', 'pipe'] });

  const stop = () => {
    child.kill('SIGTERM');
    spawn('docker', ['rm', '-f', container], { stdio: 'ignore', detached: true }).unref();
  };
  process.on('exit', stop);
  process.on('SIGINT', () => process.exit(0));
  process.on('SIGTERM', () => process.exit(0));
  process.on('SIGHUP', () => process.exit(0));

  return child;
}

/** Your local Codex login, if you have one, so the agent doesn't ask again. */
export function localCodexAuth(): string | null {
  const home = process.env.CODEX_HOME ?? join(process.env.HOME ?? process.env.USERPROFILE ?? '', '.codex');
  try {
    return readFileSync(join(home, 'auth.json'), 'utf8');
  } catch {
    return null;
  }
}
