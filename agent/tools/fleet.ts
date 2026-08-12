import { defineTool, input, type Ctx } from './_kit.ts';

/**
 * The fleet, as it is right now rather than as you remember it.
 *
 * Both tools resolve an agent to a room by asking Agent Update every single
 * time. A remembered room id is the one failure this agent exists to not
 * repeat: a room re-made in the app leaves the old id pointing at nothing, and
 * every post into it succeeds at posting into the void.
 */

type LiveRoom = { id: string; name: string; members?: Array<{ name?: string } | string> };

const memberNames = (room: LiveRoom): string[] =>
  (room.members ?? []).map((m) => (typeof m === 'string' ? m : (m.name ?? ''))).filter(Boolean);

/** Name and members together — an agent may be either the room's name or in it. */
const haystack = (room: LiveRoom) => [room.name, ...memberNames(room)].join(' ').toLowerCase();

const live = async (ctx: Ctx): Promise<LiveRoom[]> => ((await ctx.rooms.list()) ?? []) as LiveRoom[];

const minutesSince = (at: string) => Math.round((Date.now() - new Date(at).getTime()) / 60_000);

type Event = { at: string; data: { from?: string; agent?: string; room?: string } };

/** Newest event per agent, keyed by the lowercased name we filed it under. */
async function latestBy(ctx: Ctx, kind: string, key: 'from' | 'agent') {
  const events = ((await ctx.history(200, kind)) ?? []) as Event[];
  const seen = new Map<string, { at: string; minutesAgo: number; room?: string }>();
  for (const event of events) {
    const who = event.data?.[key];
    if (!who || seen.has(who.toLowerCase())) continue; // history is newest first
    seen.set(who.toLowerCase(), { at: event.at, minutesAgo: minutesSince(event.at), room: event.data.room });
  }
  return seen;
}

export const fleet = defineTool<Record<string, never>>({
  name: 'fleet',
  description:
    'The company of agents as it stands right now: every room that exists, who is in it, when you last ' +
    'asked each agent something and when it last actually said something to you. Rooms are read live; ' +
    'the timings come from your journal. Use this before reporting on anyone — and report the ages, not ' +
    'just the facts, because a fresh number and a three-day-old one read the same in a sentence.',
  run: async (_args, ctx) => {
    const [rooms, asked, heard] = await Promise.all([
      live(ctx),
      latestBy(ctx, 'fleet.asked', 'agent'),
      latestBy(ctx, 'room.heard', 'from'),
    ]);

    return {
      checkedAt: new Date().toISOString(),
      rooms: rooms.map((room) => {
        const members = memberNames(room);
        const hay = haystack(room);
        const find = (m: Map<string, { at: string; minutesAgo: number }>) => {
          for (const [name, value] of m) if (hay.includes(name)) return { name, ...value };
          return null;
        };
        return { id: room.id, name: room.name, members, lastAsked: find(asked), lastHeard: find(heard) };
      }),
      // Everything above is live except the timings, which are the past.
      note: rooms.length ? undefined : 'No rooms. Either none are set up, or the Agent Update token is not working.',
    };
  },
  input: input({}),
});

export const askAgent = defineTool<{ agent: string; question: string }>({
  name: 'ask_agent',
  description:
    'Ask one of the other agents something, by name. Finds its room live, posts, and records that you ' +
    'asked so silence has a duration attached to it. This does not wait for a reply and you must not ' +
    'either — the answer arrives later as room traffic and wakes you. Tell the human you have asked, ' +
    'then carry on. If no room matches, you get the rooms that do exist, which is your repair.',
  input: input({
    agent: {
      type: 'string',
      description: 'The agent by name, e.g. "Librarian". Matched against room names and members.',
    },
    question: { type: 'string', description: 'One question, short. It lands in a room the human reads.' },
  }),
  run: async (args, ctx) => {
    const rooms = await live(ctx);
    const needle = args.agent.trim().toLowerCase();
    const matches = rooms.filter((room) => haystack(room).includes(needle));

    if (matches.length !== 1) {
      // Not an error to swallow: the model is expected to look at this and fix
      // the binding itself, then say that it did.
      await ctx.note('fleet.unresolved', { agent: args.agent, matched: matches.length });
      return {
        posted: false,
        reason:
          matches.length === 0 ? `No room matches "${args.agent}".` : `${matches.length} rooms match "${args.agent}".`,
        rooms: rooms.map((room) => ({ id: room.id, name: room.name, members: memberNames(room) })),
      };
    }

    const room = matches[0]!;
    await ctx.rooms.send(room.id, args.question);
    await ctx.note('fleet.asked', { agent: args.agent, room: room.name, roomId: room.id, question: args.question });
    return { posted: true, room: room.name, roomId: room.id, at: new Date().toISOString() };
  },
});
