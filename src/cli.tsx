#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { createInterface } from 'node:readline/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { render } from 'ink';
import { manifest } from '../agent/manifest.ts';
import { mounts, readEnv, split } from './config.ts';
import { ensureImage, has, localCodexAuth, start } from './docker.ts';
import { onboard } from './onboarding.tsx';
import { encode, lineReader, type ToAgent, type ToHost } from './protocol.ts';
import { Dashboard, type Bridge } from './ui/app.tsx';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const name = manifest.name;

const HELP = `
  temper — ${manifest.tagline}

  temper           start the agent (this is the one you want)
  temper setup     walk through every setting again
  temper login     forget the Codex login and sign in fresh
  temper build     rebuild the container image
  temper reset     delete the agent's workspace — memory, journal, schedules

  The agent runs in Docker and lives as long as this terminal does.
`;

const [command = 'up'] = process.argv.slice(2);

switch (command) {
  case 'help':
  case '--help':
  case '-h':
    console.log(HELP);
    break;
  case 'build':
    await ensureImage(root, name, { force: true });
    console.log('image ready');
    break;
  case 'login':
    spawnSync('docker', ['run', '--rm', '--entrypoint', 'rm', '-v', `temper-${name}:/workspace`, await ensureImage(root, name), '-f', '/workspace/.codex/auth.json'], { stdio: 'inherit' });
    console.log('signed out. run `temper` to sign in again.');
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

async function reset() {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await rl.question(`This deletes ${name}'s memory, journal and schedules. Type the agent's name to confirm: `);
  rl.close();
  if (answer.trim() !== name) return console.log('left alone.');
  spawnSync('docker', ['rm', '-f', `temper-${name}`], { stdio: 'ignore' });
  spawnSync('docker', ['volume', 'rm', `temper-${name}`], { stdio: 'inherit' });
  console.log('gone.');
}

async function up(reconfigure: boolean) {
  if (!has('docker')) {
    console.error('Docker is not installed, and the agent only runs in Docker.\nGet it: https://docs.docker.com/get-docker/');
    process.exit(1);
  }
  if (spawnSync('docker', ['info'], { stdio: 'ignore' }).status !== 0) {
    console.error('Docker is installed but not running. Start Docker Desktop and try again.');
    process.exit(1);
  }

  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const stored = readEnv(root);
  const withDefaults = { TEMPER_TZ: timezone, ...stored };
  const env = await onboard(root, manifest, stored, reconfigure || !stored.TEMPER_ONBOARDED);
  const settings: Record<string, string> = { ...withDefaults, ...env };

  const tag = await ensureImage(root, name);
  const { agent, gated, runtime } = split(manifest, settings);
  const child = start({ root, name, tag, env: agent, mounts: mounts(manifest, settings) });

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
  child.stdout?.on('data', lineReader<ToHost>((message) => listeners.forEach((l) => l(message))));

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

  child.on('close', (code) => {
    clearInterval(heartbeat);
    app.unmount();
    restore();
    if (code) console.error(`\nthe agent stopped (exit ${code})\n${stderr.trim()}`);
    process.exit(code ?? 0);
  });

  await app.waitUntilExit();
  clearInterval(heartbeat);
  child.stdin?.end();
}
