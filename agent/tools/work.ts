import { defineTool, input, type Ctx } from './_kit.ts';
import { minutesSince, resolveRoom } from './fleet.ts';

/**
 * Work handed to another agent, and kept track of until it is actually done.
 *
 * The point of this file: "I asked Librarian" is not the job. The job is
 * knowing, an hour later, that Librarian never answered — and that the human
 * asked for this on purpose and is still waiting. So every request opens an
 * assignment that stays open until something closes it.
 *
 * State lives in the journal rather than a file, because the journal is
 * append-only and survives session compaction. An assignment is the fold of its
 * events, replayed oldest-first. Nothing here is remembered in the model's
 * context; a fresh session after a rotation sees exactly what a long-running
 * one does.
 */

/**
 * `ctx.history` clamps to 200 (src/runtime/tools.ts). Asking for more would be
 * a number that quietly means something else, so this is the real ceiling — and
 * the fold says out loud when it hits it. An assignment that scrolled out of
 * the window is one the agent stops chasing without ever knowing it existed,
 * which is the exact failure this whole file is here to prevent.
 */
const LOOKBACK = 200;

type Entry = { at: string; data: Record<string, any> };

type Assignment = {
  id: string;
  agent: string;
  room: string;
  roomId: string;
  request: string;
  /** What you believed a reasonable reply time was, when you asked. */
  expectMinutes: number | null;
  openedAt: string;
  /** The last time you sent something about this. Chasing resets it. */
  lastSentAt: string;
  /** The last time you recorded hearing anything back. */
  heardAt: string | null;
  chases: number;
  heard: string[];
  closed: { at: string; outcome: string; done: boolean } | null;
};

async function load(ctx: Ctx) {
  const events = ((await ctx.history(LOOKBACK, 'assignment')) ?? []) as Entry[];
  const byId = new Map<string, Assignment>();
  /** Events for an assignment whose `opened` has scrolled out of the window. */
  let orphaned = 0;

  // History is newest first; a fold has to replay in the order things happened.
  for (const event of [...events].reverse()) {
    const data = event.data ?? {};
    const id = data.id as string | undefined;
    if (!id) continue;

    if (data.event === 'opened') {
      byId.set(id, {
        id,
        agent: data.agent,
        room: data.room,
        roomId: data.roomId,
        request: data.request,
        expectMinutes: data.expectMinutes ?? null,
        openedAt: event.at,
        lastSentAt: event.at,
        heardAt: null,
        chases: 0,
        heard: [],
        closed: null,
      });
      continue;
    }

    const assignment = byId.get(id);
    if (!assignment) {
      orphaned += 1; // opened before the window; there is no record left to fold onto
      continue;
    }
    if (data.event === 'followed_up') {
      assignment.chases += 1;
      assignment.lastSentAt = event.at;
      // The room can move under us. Keep the newest binding that worked.
      if (data.roomId) {
        assignment.room = data.room;
        assignment.roomId = data.roomId;
      }
    } else if (data.event === 'heard') {
      assignment.heard.push(data.text);
      assignment.heardAt = event.at;
    } else if (data.event === 'closed') {
      assignment.closed = { at: event.at, outcome: data.outcome, done: !!data.done };
    }
  }

  return { list: [...byId.values()], saturated: events.length >= LOOKBACK, orphaned };
}

/** Ages attached to everything, because an age is the difference between an observation and a guess. */
const view = (a: Assignment) => ({
  id: a.id,
  agent: a.agent,
  room: a.room,
  request: a.request,
  openedMinutesAgo: minutesSince(a.openedAt),
  silentForMinutes: minutesSince(a.heardAt ?? a.lastSentAt),
  heardAnything: a.heard.length > 0,
  heard: a.heard,
  chases: a.chases,
  expectMinutes: a.expectMinutes,
  // Only ever true when you said what to expect. Without that this is silence
  // of an unknown duration, which is not the same as being late.
  overdue: !a.closed && a.expectMinutes !== null && minutesSince(a.lastSentAt) > a.expectMinutes,
  closed: a.closed,
});

const open = (list: Assignment[]) => list.filter((a) => !a.closed);

/** Shared failure shape: say which ids are live rather than just refusing. */
const noSuchAssignment = (id: string, list: Assignment[]) => ({
  ok: false,
  reason: `No open assignment "${id}".`,
  open: open(list).map((a) => ({ id: a.id, agent: a.agent, request: a.request })),
});

export const delegate = defineTool<{ agent: string; request: string; expect_within_minutes?: number }>({
  name: 'delegate',
  description:
    'Hand a piece of work to one of the agents and start tracking it. Finds their room live, posts the ' +
    'request, and opens an assignment that stays open until you close it. This is how everything reaches ' +
    'another agent — including plain questions, because a question nobody answered is the thing you are ' +
    'here to notice. It does not wait for a reply and neither do you: tell the human you have asked, then ' +
    'carry on. The reply arrives later as room traffic and wakes you.',
  input: input({
    agent: {
      type: 'string',
      description: 'The agent by name, e.g. "Librarian". Matched against room names and members.',
    },
    request: { type: 'string', description: 'What you want done, in one or two sentences. The human reads this room.' },
    expect_within_minutes: {
      type: 'number',
      description:
        'How long a reply should reasonably take for this agent and this kind of work — from what you know ' +
        'its normal is, not a guess. Past this, the assignment reads as overdue. Leave it out if you do not know.',
      optional: true,
    },
  }),
  run: async (args, ctx) => {
    const found = await resolveRoom(ctx, args.agent);
    if (!found.room) {
      await ctx.note('assignment.unresolved', { agent: args.agent, reason: found.reason });
      return {
        ok: false,
        reason: found.reason,
        rooms: found.rooms.map((room) => ({ id: room.id, name: room.name })),
      };
    }

    const id = crypto.randomUUID().slice(0, 8);
    await ctx.rooms.send(found.room.id, args.request);
    await ctx.note('assignment', {
      event: 'opened',
      id,
      agent: args.agent,
      room: found.room.name,
      roomId: found.room.id,
      request: args.request,
      expectMinutes: args.expect_within_minutes ?? null,
    });
    return { ok: true, id, agent: args.agent, room: found.room.name, at: new Date().toISOString() };
  },
});

export const followUp = defineTool<{ id: string; message: string }>({
  name: 'follow_up',
  description:
    'Say something else on an open assignment — answer a question the agent asked you, add what it needs, ' +
    'or chase it because it has gone quiet. Re-finds the room live, so a room re-made in the app repairs ' +
    'itself here. Chasing an agent that is merely slow is noise; know its normal before you nudge.',
  input: input({
    id: { type: 'string', description: 'Assignment id from `delegate` or `assignments`.' },
    message: { type: 'string', description: 'What to say. Short — the human reads this room too.' },
  }),
  run: async (args, ctx) => {
    const { list } = await load(ctx);
    const assignment = list.find((a) => a.id === args.id);
    if (!assignment || assignment.closed) return noSuchAssignment(args.id, list);

    // The agent, not the stored id, is the durable handle on a room.
    const found = await resolveRoom(ctx, assignment.agent);
    if (!found.room) {
      return { ok: false, reason: found.reason, rooms: found.rooms.map((room) => ({ id: room.id, name: room.name })) };
    }

    await ctx.rooms.send(found.room.id, args.message);
    await ctx.note('assignment', {
      event: 'followed_up',
      id: args.id,
      room: found.room.name,
      roomId: found.room.id,
      message: args.message,
      // Worth saying out loud in the report: the binding had moved.
      rebound: found.room.id !== assignment.roomId ? assignment.roomId : undefined,
    });
    return {
      ok: true,
      id: args.id,
      room: found.room.name,
      reboundFrom: found.room.id !== assignment.roomId ? assignment.roomId : undefined,
    };
  },
});

export const heard = defineTool<{ id: string; what_they_said: string }>({
  name: 'heard',
  description:
    'Record what an agent actually said on an assignment, in its words, when its reply does not finish the ' +
    'job. This is what makes silence measurable and what a future you — after the session has been ' +
    'compacted — will read instead of guessing. Recording is not closing: if the work is done, close it.',
  input: input({
    id: { type: 'string', description: 'Assignment id.' },
    what_they_said: {
      type: 'string',
      description: 'Their reply, or the substance of it. Do not paraphrase it into good news.',
    },
  }),
  run: async (args, ctx) => {
    const { list } = await load(ctx);
    const assignment = list.find((a) => a.id === args.id);
    if (!assignment || assignment.closed) return noSuchAssignment(args.id, list);
    await ctx.note('assignment', { event: 'heard', id: args.id, text: args.what_they_said });
    return { ok: true, id: args.id, recorded: true };
  },
});

export const closeAssignment = defineTool<{ id: string; outcome: string; done: boolean }>({
  name: 'close_assignment',
  description:
    'Close an assignment. `done: true` only when the agent said the work is finished — not when it said it ' +
    'would start, and not because enough time has passed. `done: false` closes it as abandoned or ' +
    'superseded, and the outcome is what you would tell the human if they asked why nothing happened.',
  input: input({
    id: { type: 'string', description: 'Assignment id.' },
    outcome: { type: 'string', description: 'One line: what actually happened. This is the record.' },
    done: { type: 'boolean', description: 'True only if the work was actually completed.' },
  }),
  run: async (args, ctx) => {
    const { list } = await load(ctx);
    const assignment = list.find((a) => a.id === args.id);
    if (!assignment || assignment.closed) return noSuchAssignment(args.id, list);
    await ctx.note('assignment', { event: 'closed', id: args.id, outcome: args.outcome, done: args.done });
    return { ok: true, id: args.id, closed: true, done: args.done };
  },
});

export const assignments = defineTool<{ include_closed?: boolean }>({
  name: 'assignments',
  description:
    'Everything you have handed to another agent and not yet closed: what was asked, how long ago, whether ' +
    'anything has come back, and which are overdue. Check this when an agent posts in a room, when the ' +
    'human asks where something is, and on every sweep — an open assignment nobody is watching is the ' +
    'failure this agent exists to prevent.',
  input: input({
    include_closed: {
      type: 'boolean',
      description: 'Also return closed ones, newest first. Default false.',
      optional: true,
    },
  }),
  run: async (args, ctx) => {
    const { list, saturated, orphaned } = await load(ctx);
    const live = open(list).map(view);
    return {
      checkedAt: new Date().toISOString(),
      open: live,
      overdue: live.filter((a) => a.overdue).map((a) => a.id),
      neverAnsweredCount: live.filter((a) => !a.heardAnything).length,
      closed: args.include_closed ? list.filter((a) => a.closed).map(view) : undefined,
      // Saying this out loud matters more than the list itself: a short list
      // read as "nothing outstanding" is how a dropped request stays dropped.
      incomplete: saturated || orphaned > 0 || undefined,
      incompleteWhy:
        saturated || orphaned > 0
          ? `This list is not everything. The journal window holds ${LOOKBACK} assignment events and it is full` +
            (orphaned ? `, and ${orphaned} event(s) belong to assignments older than it` : '') +
            '. Older open assignments are missing here. Close what is finished so the window clears, and ' +
            'search `history` before telling him nothing is outstanding.'
          : undefined,
    };
  },
});
