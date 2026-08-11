# Temper

Temper is a starting point for building your own agent — one that lives in your
terminal, does real work for weeks at a time, and can't wreck your machine while
it does. Clone it, tell Claude Code what you want the agent to do, and you get
an inbox triager, a calendar manager, or something quietly running your
business. Memory, schedules, custom tools, a sandbox, and a line to your phone
are already built; you supply the job.

It isn't a chatbot with automations bolted on. Inside its container the agent
has a full shell, the web, and no permission prompts, because the container is
the boundary — the constraint is on where it can go, not on what it's allowed to
think. That's the difference between an agent that can work through a billing
dispute and one that can only fill in a form.

## Start

```sh
git clone https://github.com/wdorman-tech/Temper my-agent
cd my-agent
npm install        # also builds
npm start          # or `npm link` once, then just `temper`, from anywhere
```

First run walks you through every setting one screen at a time and tells you
where to get each one. Then it builds the container and signs you into Codex.

To make it *yours*: point Claude Code at the repo. It'll interview you, write
the north star, and build the tools. See [CLAUDE.md](CLAUDE.md).

## What you see

```
 warden                                              ● working · 4m
   drafting 3 replies  ·  unread 12  ·  next: inbox sweep in 42m

   you     anything urgent from legal?
   warden  two. contract redline due friday, and a W-9 request.
           want me to draft both?
   ·       searched gmail: from:legal newer_than:3d
   ·       wrote memory/legal-thread.md

 ╭ needs you ─────────────────────────────────────────────────╮
 │ Send the redline reply to Dana?                            │
 │ 1 Allow once   2 Allow all session   3 No                  │
 ╰────────────────────────────────────────────────────────────╯

 › ▮
   enter send · esc interrupt · ctrl-c quit
```

The screen belongs to the agent you built, not to this project. Its name is the
header, and the second line is whatever it decided you should know — it writes
that itself, every time the picture changes. A triage agent puts unread counts
there; a trading agent puts its position. Nothing in the UI assumes what your
agent is for.

## What's in the box

**Codex, on your plan.** Device-code login inside the container. No API key, no
per-token bill. The Codex CLI runs the agent loop, so you get its tools, its
shell and its threads for free.

**Memory that's just files.** `/workspace/memory/*.md`, with an index. The agent
greps its own notes, rewrites them, throws them out. You can read every one with
`cat`. No embeddings, nothing to reindex, nothing to corrupt.

**Schedules it writes itself.** "Check email at 4pm on weekdays" becomes a cron
entry the agent created and can change. They're timers in your session — when
your terminal is closed, nothing runs. On the next start it's told what it slept
through and decides what's still worth doing.

**Tools as files.** Drop a file in `agent/tools/`, export it, restart. Anything
marked `effect: 'write'` stops and asks first, with a one-line preview of what's
about to happen.

**Your phone.** [Agent Update](https://tryagentupdate.com) is the way out of the
terminal — a line on your lock screen, a question with tappable answers, group
chats where several of your agents and you talk in one room. Terminal and phone
are the same conversation; answer wherever you are.

**A journal.** Every message, shell command, tool call, approval and schedule
run, appended to SQLite. The agent reads its own with the `history` tool, so
"what did you do last Tuesday?" is a question it answers rather than guesses at.

## Where the lines are

Worth being precise about, because most agent frameworks aren't.

**Hard boundary — the container.** The agent gets a volume and nothing else.
Your filesystem isn't there. Delete the volume and it's factory-new. The runtime
is root-owned and read-only to the agent, so the code enforcing the rules isn't
code the agent can edit. This holds even if the model actively tries to get out.

**The one hole you open yourself — mounts.** A host folder you name during setup
appears at `/workspace/mounts/<name>`, read-only unless you set
`writable: true`. If you make one writable, know what you've done: the agent's
shell writes straight through to your real files and **no gate sees it**. Mount
a copy, or a folder you'd survive losing.

**Soft boundary — the effect gate.** Tools that reach the outside world ask
first. They run inside the supervisor rather than the tool server, so a shell
that talks to the control socket gains nothing — it can invoke a tool, and that
tool still has to clear you. What it can still do is skip tools entirely and use
`curl`. A good fence, not a wall.

**Gated credentials.** Settings marked `scope: 'gated'` never enter the
container's environment. The host holds them and releases one to a tool only
inside a call you approved. `env` inside the sandbox shows nothing.

The honest summary: the container is what stops a wrong agent from hurting you.
Everything else raises the cost of a mistake.

## Built to run for weeks

Long-running agents don't usually crash. They rot — the thread fills up, the
model gets slower and stranger, and one day it does something odd.

So a session has a ceiling: 220k tokens or 60 turns, whichever comes first
(`TEMPER_ARC_TOKENS`, `TEMPER_ARC_TURNS`). At the ceiling the agent writes a
handoff note to memory and starts a clean thread seeded with that note, its
memory index and its north star. Nothing important is lost, because anything
important was already written down. That's why memory is a folder and not a
scrollback.

Turns run one at a time, queued, so it never races itself. Writes are atomic,
the journal is append-only and self-pruning, and a crash says what happened
instead of wedging.

## Commands

```
npm start              start the agent — the one you want
npm start -- setup     walk through every setting again
npm start -- login     forget the Codex login and sign in fresh
npm start -- build     rebuild the container image
npm start -- reset     delete the workspace: memory, journal, schedules
```

`npm link` once and these are just `temper`, `temper setup`, and so on.

## Requirements

Docker, Node 24+, and either a ChatGPT plan with Codex or an OpenAI API key.
macOS, Linux, or Windows with Docker Desktop. Clone it — this is a template you
edit, not a dependency you install.

## The name

Tempering is what turns brittle steel into steel that holds, which is the whole
problem with agents meant to run for weeks. Temper is also disposition: this
one's is short, direct and unbothered.

MIT.
