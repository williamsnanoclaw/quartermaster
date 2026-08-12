import type { Manifest } from '../src/config.ts';

/**
 * Everything this agent needs to exist, and how a human gets it.
 *
 * This drives onboarding. Add a setting here and `temper` will walk the next
 * person through finding it — so write `why` and `how` for someone who has
 * never seen the service before, not for yourself.
 *
 * Settings are only ever shown to the human. If the *agent* needs to know
 * something — that a folder is an Obsidian vault, that a key exists — say it in
 * NORTH_STAR.md too. Nothing here reaches the model.
 */
export const manifest: Manifest = {
  name: 'quartermaster',
  tagline: 'manages and observes your company of agents',

  settings: [
    {
      key: 'TEMPER_NAME',
      label: 'Agent name',
      why: 'Shown on the dashboard and in group chats. Give it a name you would use out loud.',
      default: 'quartermaster',
      optional: true,
    },
    {
      key: 'AGENT_UPDATE_TOKEN',
      label: 'Agent Update token',
      why: 'Not optional for this agent. The group chats are the only way it reaches your other agents — without a token it cannot ask any of them anything, and managing a fleet it cannot talk to is not a job. It is also how it reaches you when you are away from the terminal.',
      how: [
        'Install Agent Update on iPhone and sign in',
        'Tap + → New agent, name it whatever you named this one',
        'Copy the token it shows you (starts with au_live_)',
      ],
      url: 'https://tryagentupdate.com/docs/quickstart',
      secret: true,
      // Only the supervisor uses this. Keeping it out of the container's
      // environment means the agent's own shell cannot read the token that
      // speaks to you as the agent.
      scope: 'runtime',
      validate: (value) => value.startsWith('au_live_') || 'Agent Update tokens start with au_live_',
    },
    {
      key: 'TEMPER_CODEX_LOGIN',
      label: 'How to sign in to Codex',
      why: 'Device code opens a link, you paste a code, and the agent gets its own session — pick this. Reusing your local login is instant, but Codex rotates refresh tokens, so your machine and your agent will keep signing each other out.',
      choices: ['device', 'reuse'],
      default: 'device',
      optional: true,
    },
    {
      key: 'TEMPER_TZ',
      label: 'Timezone',
      why: "Schedules are written in your local time, not the container's. It also decides when the quiet hours in NORTH_STAR.md start.",
      default: 'America/New_York',
      optional: true,
    },
    {
      key: 'TEMPER_MODEL',
      label: 'Codex model',
      why: 'Leave blank to use the model in agent/codex.toml. Set it to override without a rebuild.',
      optional: true,
    },
    {
      key: 'OPENAI_API_KEY',
      label: 'OpenAI API key',
      why: 'Only if you want to bill the API instead of your ChatGPT plan. Leave blank to sign in with ChatGPT, which is what most people want.',
      secret: true,
      optional: true,
    },

    {
      key: 'FLEET_DIR',
      label: 'Where your agents live',
      why: "The folder holding your other agents' installs — for you that is your home folder, or a folder above them. Mounted read-only at /workspace/mounts/fleet so Quartermaster can read their logs, configs and source when it is working out why one has gone quiet. Read-only on purpose: it diagnoses and hands you the command, it does not reach into another agent and change it. Leave blank and it can only find out things by asking them in the group chats.",
      how: [
        'Pick the folder your agent repos sit in (e.g. /Users/you)',
        'Narrow it if you would rather it saw less — a folder holding only the agents is better',
      ],
      mountAs: 'fleet',
      optional: true,
    },
  ],
};
