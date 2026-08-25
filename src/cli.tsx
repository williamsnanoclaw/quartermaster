#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, rmSync, watch, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { render } from 'ink';
import { manifest } from '../agent/manifest.ts';
import { mounts, readEnv, split } from './config.ts';
import { ensureImage, has, localCodexAuth, start } from './docker.ts';
import { onboard } from './onboarding.tsx';
import {
  agentDir,
  authFile,
  container as containerFor,
  envFile,
  install,
  project,
  state,
  stateDir,
  tooWide,
} from './paths.ts';
import { encode, lineReader, type ToAgent, type ToHost } from './protocol.ts';
import { Dashboard, type Bridge } from './ui/app.tsx';

const name = manifest.name;

/** The command they type. Kept in step with `bin` in package.json. */
const cli = manifest.name;

/** This folder's container. A different folder is a different agent. */
const container = containerFor(name);

const HELP = `
  ${cli} — ${manifest.tagline}

  ${cli}           start the agent in this folder (this is the one you want)
  ${cli} init      set this folder up without starting it
  ${cli} setup     walk through this folder's settings again
  ${cli} login     forget this folder's Codex login and sign in fresh
  ${cli} build     rebuild the container image
  ${cli} reset     delete this folder's agent — memory, journal, schedules, login

  The agent is scoped to the folder you run it in. It works there, and
  everything it owns lives in ${stateDir}/ inside it. Run it somewhere else
  and you get a different agent, with its own job and its own memory.
`;

const [command = 'up'] = process.argv.slice(2);

switch (command) {
  case 'help':
  case '--help':
  case '-h':
    console.log(HELP);
    break;
  case 'build':
    await ensureImage(install, name, { force: true });
    console.log('image ready');
    break;
  case 'init':
    if (existsSync(agentDir)) console.log(`${project} already has an agent. \`${cli}\` starts it.`);
    else {
      guardWideOpen();
      scaffold();
      console.log(`created ${state}\n\nedit ${stateDir}/agent/NORTH_STAR.md, then run \`${cli}\`.`);
    }
    break;
  case 'login':
    // No container needed any more: the login is a file in this folder.
    if (!existsSync(authFile)) console.log(`no Codex login stored for ${project}.`);
    else {
      rmSync(authFile);
      console.log(`signed out. run \`${cli}\` to sign in again.`);
    }
    break;
  case 'reset':
    await reset();
    break;
  case 'setup':
    await up(true);
    break;
  case 'up':
    await up(false);
    break;
  default:
    console.log(HELP);
    process.exitCode = 1;
}

/**
 * A folder gets its own copy of the job, not a pointer at a shared one. Two
 * projects drift apart on purpose; editing one agent's north star must never
 * change another's.
 */
function scaffold() {
  mkdirSync(state, { recursive: true });
  cpSync(join(install, 'agent'), agentDir, { recursive: true });
  // A live Codex refresh token is about to sit in this directory. Ignore it
  // from the inside, so it is covered whatever the surrounding project has —
  // or doesn't have — in its own .gitignore. The job definition is config
  // worth versioning, so that part stays visible to git.
  writeFileSync(
    join(state, '.gitignore'),
    [
      '# Written by ' + cli + ". The agent's credentials and state live here.",
      '*',
      '!.gitignore',
      '!agent/',
      '!agent/**',
      '',
    ].join('\n'),
  );
}

function guardWideOpen() {
  const wide = tooWide();
  if (!wide) return;
  console.error(
    `Refusing to set up an agent in ${wide}.\n\n` +
      `The agent gets this folder read-write, so the folder is the sandbox boundary.\n` +
      `Make a folder for the work and run \`${cli}\` inside it.`,
  );
  process.exit(1);
}

async function confirm(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await rl.question(question);
  rl.close();
  // readline leaves stdin paused with a read still marked in flight, and in
  // that state attaching a 'readable' listener does not restart the tty — Ink
  // mounts after this, hears nothing, and the wizard sits there dead. resume()
  // restarts it; unref() keeps a question nobody follows with a UI (`reset`)
  // from holding the process open. Ink refs stdin itself when it takes over.
  process.stdin.resume();
  process.stdin.unref();
  return answer.trim();
}

async function reset() {
  if (!existsSync(state)) return console.log(`no agent in ${project}.`);
  const label = basename(project);
  const answer = await confirm(
    `This deletes ${state} — memory, journal, schedules and this folder's Codex login.\nType ${label} to confirm: `,
  );
  if (answer !== label) return console.log('left alone.');
  spawnSync('docker', ['rm', '-f', container], { stdio: 'ignore' });
  rmSync(state, { recursive: true, force: true });
  console.log('gone.');
}

async function up(reconfigure: boolean) {
  if (!has('docker')) {
    console.error(
      'Docker is not installed, and the agent only runs in Docker.\nGet it: https://docs.docker.com/get-docker/',
    );
    process.exit(1);
  }
  if (spawnSync('docker', ['info'], { stdio: 'ignore' }).status !== 0) {
    console.error('Docker is installed but not running. Start Docker Desktop and try again.');
    process.exit(1);
  }

  guardWideOpen();

  // First run here. Ask before writing into a directory they may have only
  // been passing through — this is the one command that creates files.
  if (!existsSync(agentDir)) {
    const answer = await confirm(`No agent set up in ${project}. Create one? [y/N] `);
    if (!/^y(es)?$/i.test(answer)) return console.log(`nothing created. \`${cli} init\` when you want one.`);
    scaffold();
    console.log(`created ${state}`);
  }

  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const stored = readEnv(state);
  const withDefaults = { TEMPER_TZ: timezone, ...stored };
  // Unconfigured is its own state: `init` leaves a folder scaffolded but with
  // no .env, and an interrupted wizard leaves one half-written. Either way the
  // next start picks up where it stopped instead of starting the agent blind.
  const env = await onboard(state, manifest, stored, reconfigure || !stored.TEMPER_ONBOARDED);
  const settings: Record<string, string> = { ...withDefaults, ...env };

  const tag = await ensureImage(install, name);
  const { agent, gated, runtime } = split(manifest, settings);
  const child = start({
    project,
    agentDir,
    stateDir,
    container,
    tag,
    env: agent,
    mounts: mounts(manifest, settings),
  });

  // Full-screen, and give the terminal back exactly as we found it.
  process.stdout.write('\x1b[?1049h');
  const restore = () => process.stdout.write('\x1b[?1049l');
  process.on('exit', restore);

  const listeners = new Set<(message: ToHost) => void>();
  const bridge: Bridge = {
    send: (message: ToAgent) => child.stdin?.write(encode(message)),
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  child.stdout?.on(
    'data',
    lineReader<ToHost>((message) => listeners.forEach((l) => l(message))),
  );

  // Container stderr is not protocol; keep the tail so a crash is explainable.
  let stderr = '';
  child.stderr?.on('data', (chunk) => (stderr = (stderr + chunk).slice(-4000)));

  const app = render(<Dashboard bridge={bridge} name={settings.TEMPER_NAME ?? name} />, { exitOnCtrlC: false });

  const reuseLogin = settings.TEMPER_CODEX_LOGIN === 'reuse' && !settings.OPENAI_API_KEY;
  bridge.send({
    k: 'hello',
    tz: settings.TEMPER_TZ ?? timezone,
    secrets: gated,
    agentUpdateToken: runtime.AGENT_UPDATE_TOKEN,
    ...(reuseLogin ? { authJson: localCodexAuth() ?? undefined } : {}),
  });

  const heartbeat = setInterval(() => bridge.send({ k: 'ping' }), 10_000);

  // Edit this folder's .env or its agent/ and the change reaches the running
  // agent. Debounced because editors write a file two or three times per save.
  let pending: NodeJS.Timeout | undefined;
  const reload = () => {
    clearTimeout(pending);
    pending = setTimeout(() => {
      const latest = { ...withDefaults, ...readEnv(state) };
      const parts = split(manifest, latest);
      bridge.send({
        k: 'config',
        env: parts.agent,
        secrets: parts.gated,
        agentUpdateToken: parts.runtime.AGENT_UPDATE_TOKEN,
      });
    }, 300);
  };
  // A missing .env or a filesystem that can't watch recursively is not worth
  // refusing to start over; you just lose live reload.
  const observe = (path: string, recursive = false) => {
    try {
      return watch(path, { recursive }, reload);
    } catch {
      return null;
    }
  };
  const watchers = [observe(envFile), observe(agentDir, true)].filter((w) => w !== null);

  const shutdown = () => {
    clearInterval(heartbeat);
    clearTimeout(pending);
    for (const watcher of watchers) watcher.close();
  };

  child.on('close', (code) => {
    shutdown();
    app.unmount();
    restore();
    if (code) console.error(`\nthe agent stopped (exit ${code})\n${stderr.trim()}`);
    process.exit(code ?? 0);
  });

  await app.waitUntilExit();
  shutdown();
  child.stdin?.end();
}
