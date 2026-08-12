import { defineTool, input, type Ctx } from './_kit.ts';

/**
 * The fleet, as it is right now rather than as you remember it.
 *
 * Every outbound message resolves its room here, on every call. A remembered
 * room id is the one failure this agent exists to not repeat: a room re-made in
 * the app leaves the old id pointing at nothing, and every post into it
 * succeeds at posting into the void.
 */

export type LiveRoom = { id: string; name: string; members?: Array<{ name?: string } | string> };

export const memberNames = (room: LiveRoom): string[] =>
  (room.members ?? []).map((m) => (typeof m === 'string' ? m : (m.name ?? ''))).filter(Boolean);

/** Name and members together — an agent may be either the room's name or in it. */
export const haystack = (room: LiveRoom) => [room.name, ...memberNames(room)].join(' ').toLowerCase();

export const liveRooms = async (ctx: Ctx): Promise<LiveRoom[]> => ((await ctx.rooms.list()) ?? []) as LiveRoom[];

export const minutesSince = (at: string) => Math.round((Date.now() - new Date(at).getTime()) / 60_000);

/**
 * Find the one room that reaches an agent. Returns the rooms that do exist
 * when it can't, because that list is the repair — not an error to report.
 */
export async function resolveRoom(ctx: Ctx, agent: string) {
  const rooms = await liveRooms(ctx);
  const needle = agent.trim().toLowerCase();
  const matches = rooms.filter((room) => haystack(room).includes(needle));
  if (matches.length === 1) return { room: matches[0]!, rooms };
  return {
    room: null,
    rooms,
    reason: matches.length === 0 ? `No room reaches "${agent}".` : `${matches.length} rooms match "${agent}".`,
  };
}

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
    'sent each agent something and when it last actually said something to you. Rooms are read live; ' +
    'the timings come from your journal. Use this before reporting on anyone — and report the ages, not ' +
    'just the facts, because a fresh number and a three-day-old one read the same in a sentence.',
  input: input({}),
  run: async (_args, ctx) => {
    const [rooms, sent, heard] = await Promise.all([
      liveRooms(ctx),
      latestBy(ctx, 'assignment', 'agent'),
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
        return { id: room.id, name: room.name, members, lastSent: find(sent), lastHeard: find(heard) };
      }),
      note: rooms.length ? undefined : 'No rooms. Either none are set up, or the Agent Update token is not working.',
    };
  },
});
