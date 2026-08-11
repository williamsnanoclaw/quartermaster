# Temper

Quenching makes steel hard. It also makes it brittle — hard enough to shatter
the first time something real hits it. Tempering is the second step, the one
that gives up a little hardness for the toughness to survive actual use.

This is a starting point for agents that have to survive actual use.

## What it is

One command opens a dashboard in your terminal with an agent living in it. The
agent runs in a container, thinks with Codex on your ChatGPT plan, keeps its
memory in a folder of markdown, writes its own recurring jobs, and can reach
your phone when it needs a decision. Close the terminal and it's gone.

It isn't a chatbot with automations bolted on. It has a shell, the web, and no
permission prompts inside its own box — because the box is the boundary. The
constraint is on where it can go, not on what it's allowed to think. That's the
difference between an agent that can actually organise your notes or work
through a billing dispute, and one that can only fill in a form.

## Start

```sh
git clone https://github.com/wdorman-tech/Temper my-agent
cd my-agent
npm install        # also builds
npm start          # or `npm link` once, then just `temper`, from anywhere
```

First run walks you through every setting one screen at a time, and tells you
where to get each one. Then it builds the container and signs you into Codex.

To make it *your* agent: point Claude Code at the repo. It'll interview you,
write the north star, and build the tools. See [CLAUDE.md](CLAUDE.md).

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

The screen belongs to the agent you built, not to this project — its name is
the header, and the second line is whatever it decided you should know. It
writes that itself, every time the picture changes. A triage agent puts unread
counts there; a trading agent puts its position. Nothing in the UI assumes what
your agent is for.

## What's in the box

**Codex, on your plan.** `codex login` inside the container, device code, done.
No API key needed and no per-token bill. The Codex CLI runs the agent loop, so
you get its tools, its shell, and its threads for free.

**Memory that's just files.** `/workspace/memory/*.md`, with an index. The agent
greps its own notes, rewrites them, throws them out. You can read every one of
them with `cat`. No embeddings, nothing to reindex, nothing to corrupt.

**Schedules it writes itself.** "Check email at 4pm on weekdays" becomes a cron
entry the agent created and can change. They're timers in your session — when
your terminal is closed, nothing runs. On the next start it's told what it
slept through and decides what's still worth doing.

**Tools as files.** Drop a file in `agent/tools/`, export it, restart. Anything
marked `effect: 'write'` stops and asks you before it runs, with a one-line
preview of what's about to happen.

**Your phone.** [Agent Update](https://tryagentupdate.com) is the way out of the
terminal — a line on your lock screen, a question with tappable answers, group
chats where several of your agents and you can talk in one room. Terminal and
phone are the same conversation; answer wherever you are. Optional, but the
agent is much less useful without it.

**A journal.** Every message, shell command, tool call, approval and schedule
run, appended to SQLite. The agent can read its own with the `history` tool, so
"what did you do last Tuesday, and did you already try this?" is a question it
can answer honestly rather than guess at.

## Where the lines are

Worth being precise about, because most agent frameworks aren't.

**Hard boundary — the container.** The agent gets a volume and nothing else.
Your filesystem isn't there. Delete the volume and the agent is factory-new.
The runtime itself is root-owned and read-only to the agent, so the code that
enforces the rules isn't code the agent can edit. This boundary holds even if
the model actively tries to get out.

**The one hole you open yourself — mounts.** A host folder you name during setup
appears at `/workspace/mounts/<name>`. Mounts are read-only unless you set
`writable: true`. If you do make one writable, understand what you've done: the
agent's shell writes straight through to your real files and **no gate sees it**.
`AGENTS.md` instructs it to ask first, and that's an instruction, not a lock.
Mount a copy, or a folder you'd survive losing.

**Soft boundary — the effect gate.** Tools that reach the outside world ask you
first, with a one-line preview. Tools run inside the supervisor, not in the tool
server, so a shell that talks to the control socket gains nothing — it can
invoke a tool, and that tool still has to clear you. What it can't do is call a
tool's *effect* without the prompt. What it can still do is skip tools entirely
and use `curl`. It's a good fence, not a wall.

**Gated credentials.** Settings marked `scope: 'gated'` never enter the
container's environment. The host holds them and hands one to a tool only
inside a call you approved, once per tool per session. `env` inside the sandbox
shows nothing.

The honest summary: the container is what stops an agent going wrong from
hurting you. Everything else raises the cost of a mistake.

## Built to run for weeks

Long-running agents don't usually crash. They rot — the thread fills up, the
model gets slower and stranger, and one day it does something odd.

So a session has a ceiling — 220k tokens or 60 turns, whichever comes first
(`TEMPER_ARC_TOKENS`, `TEMPER_ARC_TURNS`). When it's reached, the agent writes a
handoff note to memory and starts a clean thread seeded with that note, its
memory index and its north star. Nothing important is lost because anything
important was already written down. That's why memory is a folder and not a
scrollback.

Turns run one at a time, queued, so it's never racing itself. Writes are
atomic, the journal is append-only and self-pruning, and a crash says what
happened instead of vanishing.

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

Two things at once. Tempering is what turns brittle steel into steel that
holds — which is the entire problem with agents meant to run for weeks. And
temper is disposition: this one's is short, direct, and unbothered. Both halves
are what you're building on.

MIT.
