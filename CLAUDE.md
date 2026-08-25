# Working on this repo

You are configuring an agent someone is going to trust with real work. The
runtime is finished. Your job is to make it *this person's* agent.

## Start here, before you write anything

Ask them what they want the agent to do. Not "what features" — what job.
Keep asking until you could do the job yourself:

- What does it actually do, in one sentence?
- What does a good day look like? A bad one?
- What must it never do without asking? Be specific — names, amounts, systems.
- What does it need access to, and where do those credentials come from?
- When should it act on its own, and when should it wait?
- What does it need to know that isn't written down anywhere?

Then write `agent/NORTH_STAR.md`. That file is the only thing standing between
this agent and a bad judgement call at 3am with nobody watching. Vague north
star, vague agent. Show them the draft and get it wrong out loud before you get
it wrong in production.

Do not start building tools before the north star exists.

## The map

```
agent/               yours — this is the agent, and the template `init` copies
  NORTH_STAR.md      what it's for. write this first.
  AGENTS.md          how it behaves. edit for this job, keep the voice.
  manifest.ts        every setting, and how a human gets it. drives onboarding.
  codex.toml         model and reasoning effort.
  tools/             what it can do. add files here.
    _kit.ts          defineTool, input(), and the Ctx a tool is handed.

examples/            three complete agents — email triage, calendar, business
                     ops. Read one before designing tools; they show the shape.

src/                 the runtime. read it, rarely change it.
  cli.tsx            host entry: preflight, scaffold, onboarding, container
  paths.ts           install vs project, and the per-folder container id.
                     every path decision lives here — start here.
  config.ts          the Setting/Manifest types — the full field list for
                     manifest.ts lives here
  docker.ts          container lifecycle — the sandbox boundary
  onboarding.tsx     the first-run wizard
  protocol.ts        the host ↔ container wire format
  ui/app.tsx         the dashboard
  ui/theme.ts        dashboard colours, keyed off State
  runtime/           runs inside the container
    main.ts          supervisor: turn queue, the human channel, lifecycle
    tools.ts         where tools run, and where the effect gate lives
    codex.ts         spawns Codex, parses its event stream
    session.ts       thread lifecycle, compaction, and the arc seed
    memory.ts        markdown notes
    corrections.ts   standing orders — journal-authoritative, agent can't edit
    schedules.ts     recurring work
    journal.ts       sqlite history
    workspace.ts     every path inside the container. the other half of paths.ts
    agentupdate.ts   phone + group chats
    bus.ts           socket between the tool server and the supervisor
    mcp.ts           the tool server Codex spawns. a pipe, nothing more.
```

## The agent is scoped to one folder

`quartermaster` runs in whatever directory you launched it from. That folder is
bind-mounted at `/workspace`, **writable**, and it is the only thing the agent
can reach. Everything the agent owns — its job, its `.env`, its Codex login,
memory, journal, schedules — lives in `.quartermaster/` inside it.

```
~/some-project/            ← /workspace. theirs. the agent writes here.
  .quartermaster/          ← the agent. delete it and the folder is clean.
    agent/                 a copy of this repo's agent/, mounted read-only
    .env                   this folder's settings and secrets
    .codex/                this folder's login — its own, not shared
    memory/ files/ journal.db schedules.json
    .gitignore             ignores itself except agent/
```

Consequences worth holding on to:

- **A folder is an agent.** Two folders are two agents: separate memory,
  separate token, separate Codex login, running at the same time if you like.
  Nothing is shared but the Docker image.
- **First run scaffolds.** `quartermaster` in a bare folder asks once, copies
  `agent/`, then runs the wizard. `quartermaster init` does the copy alone.
  `src/paths.ts:tooWide` refuses `$HOME`, `/` and `/Users` outright — a
  writable mount that wide is not a sandbox.
- **Never write agent files to `/workspace` itself.** The human's folder may
  have its own `AGENTS.md`. Everything the runtime writes goes under
  `paths.home`, never `paths.root`. `paths.root` is theirs.
- **`agent/` here is a template.** Editing it changes what *new* folders get,
  not what existing ones run. Existing ones have their own copy.

**One thing that will bite you.** `manifest.ts` is shown to the *human*, during
setup. Nothing in it reaches the model. If the agent needs to know a setting
exists — that the folder it runs in is an Obsidian vault, that there's a Stripe key —
say so in `NORTH_STAR.md`.

## Adding a tool

Most things do not need a tool. The agent has a shell, `curl`, `python3`, `git`
and web search inside its container — wrapping those in tools makes it dumber,
not safer. Write a tool when there is a credential to hold, an effect to gate,
or an API worth making legible.

```ts
// agent/tools/invoices.ts
import { defineTool, input } from './_kit.ts';

export const sendInvoice = defineTool<{ client: string; amount: number }>({
  name: 'send_invoice',
  description: 'Send an invoice. Amounts are in dollars.',
  effect: 'write',                                    // asks the human first
  input: input({
    client: { type: 'string', description: 'Client id from the ledger.' },
    amount: { type: 'number', description: 'Dollars, not cents.' },
  }),
  preview: (args) => `invoice ${args.client} for $${args.amount}`,
  run: async (args, ctx) => {
    const key = await ctx.secret('STRIPE_KEY');       // must exist in manifest.ts
    // ...                                            // with scope: 'gated'
    return 'sent';
  },
});
```

Then export it from `agent/tools/index.ts`. Restart — no rebuild, `agent/` is
mounted into the container.

Rules that matter:
- `effect: 'write'` for anything that leaves the container. Get this wrong and
  the agent will do something irreversible on someone's behalf.
- `preview` should read like a sentence the human can approve or refuse at a
  glance. `"invoice acme for $4,200"`, not `"send_invoice {...}"`.
- Descriptions are prompts. Write them for a smart colleague in a hurry.
- Secrets go through `ctx.secret()`, never `process.env`.

## Adding a setting

Put it in `agent/manifest.ts`; the full field list is the `Setting` type in
`src/config.ts`. Write `why` and `how` for someone who has never seen that
service — the wizard is the only documentation most people will read.

- `scope: 'gated'` for a credential the container should not hold.
- `scope: 'runtime'` for something only the supervisor uses.
- `mountAs` shares an *extra* host folder, on top of the working folder the
  agent already has. Read-only unless you add `writable: true`. Reach for it
  rarely: the answer to "the agent needs to see X" is usually to run it in a
  folder that contains X.

Answers are stored per folder in `<project>/.quartermaster/.env`, so the same
setting can differ between two agents. A newly added required setting is
prompted for on the next start — `onboarding.tsx` asks only for what is blank.

## Testing your changes

```
npm run check         # types
npm run build         # host CLI
npm test              # the tool suite
```

Then, from a scratch folder — not this repo:

```
mkdir /tmp/try && cd /tmp/try
quartermaster          # scaffolds, asks, then runs
quartermaster reset    # deletes /tmp/try/.quartermaster
```

(`npm link` once in the repo and it's on your PATH. Running `npm start` from
the repo root scaffolds an agent *into the repo* — fine, it's gitignored, but
it is not the same agent as one in a real folder.)

Watch the dashboard while it works. If the status line goes stale or says
nothing useful, the problem is your `AGENTS.md`, not the UI.

## Renaming the agent

`TEMPER_NAME` is what it's called — set it in `.env`, that's all you need.

`manifest.name` is the *installation* id: it names the Docker image, prefixes
the container, and names the agent's directory (`.quartermaster/`) via
`paths.stateDir`. Change it and existing folders keep their old directory —
the new name simply won't find them. `mv .oldname .newname` inside each folder
that matters; there are no Docker volumes to chase any more.

## House style

- Short files, plain functions, no classes unless there is state to own.
- Comments explain *why*. The code already says what.
- No new dependencies without a real reason. There are four.
- Match the voice in `AGENTS.md` — terse, direct, not chirpy. That voice is a
  product decision, not a default. Do not make the agent friendlier.

## Do not

- Do not add approval prompts inside the container. The sandbox is the boundary;
  a second layer of asking just trains people to click yes.
- Do not put secrets in the image or in `agent/`.
- Do not make the agent chatty. Long messages are a bug.
- Do not build a daemon. This agent lives and dies with the terminal, on purpose.
