import { defineTool, input, type Ctx } from './_kit.ts';

/**
 * The fleet, as it is right now rather than as you remember it.
 *
 * Every outbound message resolves its room here, on every call. A remembered
 * room id is the one failure this agent exists to not repeat: a room re-made in
 * the app leaves the old id pointing at nothing, and every post into it
 * succeeds at posting into the void.
 */

/**
 * `ctx.note` writes under `agent.<kind>`; `ctx.history` matches the kind
 * exactly (src/runtime/tools.ts). Write with the bare name, read with this.
 * Getting it wrong makes a whole subsystem write-only without a single error.
 */
export const noted = (kind: string) => `agent.${kind}`;

export type LiveRoom = { id: string; name: string; members?: Array<{ name?: string } | string> };

export const memberNames = (room: LiveRoom): string[] =>
  (room.members ?? []).map((m) => (typeof m === 'string' ? m : (m.name ?? ''))).filter(Boolean);

/** Name and members together — an agent may be either the room's name or in it. */
export const haystack = (room: LiveRoom) => [room.name, ...memberNames(room)].join(' ').toLowerCase();

/**
 * Whole-word match, not `includes`. A substring test makes "Bee" match
 * "Beekeeper", and any one-letter name match every room on the list — which
 * would post someone's work to the wrong agent and report success.
 */
export const mentions = (hay: string, needle: string) => {
  const clean = needle.trim().toLowerCase();
  if (!clean) return false;
  const escaped = clean.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^a-z0-9])${escaped}([^a-z0-9]|$)`, 'i').test(hay);
};

export const liveRooms = async (ctx: Ctx): Promise<LiveRoom[]> => ((await ctx.rooms.list()) ?? []) as LiveRoom[];

export const minutesSince = (at: string) => Math.round((Date.now() - new Date(at).getTime()) / 60_000);

/**
 * An empty room list is not evidence that there are no rooms. Agent Update
 * returns nothing at all when it is rate-limited, unreachable, or the token is
 * refused, so this sentence goes anywhere emptiness could be read as a finding.
 */
export const EMPTY_MEANS =
  'No rooms came back. That is either no rooms, or Agent Update being unreachable, rate-limited or ' +
  'refusing the token — those look identical from here. Check before reporting anything about an agent.';

/**
 * Find the one room that reaches an agent. Returns the rooms that do exist
 * when it can't, because that list is the repair — not an error to report.
 */
export async function resolveRoom(ctx: Ctx, agent: string) {
  const rooms = await liveRooms(ctx);
  const matches = rooms.filter((room) => mentions(haystack(room), agent));
  if (matches.length === 1) return { room: matches[0]!, rooms };
  const reason = !rooms.length
    ? EMPTY_MEANS
    : matches.length === 0
      ? `No room reaches "${agent}".`
      : `${matches.length} rooms match "${agent}" — too ambiguous to pick one.`;
  return { room: null, rooms, reason };
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

/** The most specific name that this room mentions — never the first that happens to fit. */
const forRoom = (room: LiveRoom, m: Map<string, { at: string; minutesAgo: number }>) => {
  const hay = haystack(room);
  let best: { name: string; at: string; minutesAgo: number } | null = null;
  for (const [name, value] of m) {
    if (!mentions(hay, name)) continue;
    if (!best || name.length > best.name.length) best = { name, ...value };
  }
  return best;
};

export const fleet = defineTool<Record<string, never>>({
  name: 'fleet',
  description:
    'The company of agents as it stands right now: every room that exists, who is in it, when you last ' +
    'sent each agent something and when it last actually said something to you. Rooms are read live; ' +
    'the timings come from your journal. Use this before reporting on anyone — and report the ages, not ' +
    'just the facts, because a fresh number and a three-day-old one read the same in a sentence. Room ids ' +
    'for `room_send` come from here.',
  input: input({}),
  run: async (_args, ctx) => {
    const [rooms, sent, heard] = await Promise.all([
      liveRooms(ctx),
      latestBy(ctx, noted('assignment'), 'agent'),
      latestBy(ctx, 'room.heard', 'from'),
    ]);

    return {
      checkedAt: new Date().toISOString(),
      rooms: rooms.map((room) => ({
        id: room.id,
        name: room.name,
        members: memberNames(room),
        lastSent: forRoom(room, sent),
        lastHeard: forRoom(room, heard),
      })),
      note: rooms.length ? undefined : EMPTY_MEANS,
    };
  },
});
