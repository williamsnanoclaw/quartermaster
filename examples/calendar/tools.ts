import { type Ctx, defineTool, input } from '../../agent/tools/_kit.ts';

/**
 * Google Calendar. Reading a calendar is harmless; changing one is not, because
 * every change sends mail to other people.
 */
const API = 'https://www.googleapis.com/calendar/v3';

async function token(ctx: Ctx): Promise<string> {
  const response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: await ctx.secret('GOOGLE_CLIENT_ID'),
      client_secret: await ctx.secret('GOOGLE_CLIENT_SECRET'),
      refresh_token: await ctx.secret('GOOGLE_REFRESH_TOKEN'),
      grant_type: 'refresh_token',
    }),
  });
  const body = (await response.json()) as { access_token?: string };
  if (!response.ok || !body.access_token) throw new Error(`Google refused the refresh token: ${JSON.stringify(body)}`);
  return body.access_token;
}

const call = async (ctx: Ctx, path: string, init?: RequestInit) => {
  const response = await fetch(`${API}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${await token(ctx)}`, 'Content-Type': 'application/json', ...init?.headers },
  });
  const text = await response.text(); // deletes come back 204 with no body
  if (!response.ok) throw new Error(`calendar ${response.status}: ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : {};
};

export const agenda = defineTool<{ from: string; to: string; calendar?: string }>({
  name: 'agenda',
  description:
    'List events in a window. Times are RFC3339 (2026-08-12T09:00:00-04:00). ' +
    'Read this before proposing anything — double-booking is the one unforgivable sin.',
  input: input({
    from: { type: 'string', description: 'Start of the window, RFC3339.' },
    to: { type: 'string', description: 'End of the window, RFC3339.' },
    calendar: { type: 'string', description: 'Calendar id. Default "primary".', optional: true },
  }),
  run: async (args, ctx) => {
    const query = new URLSearchParams({ timeMin: args.from, timeMax: args.to, singleEvents: 'true', orderBy: 'startTime' });
    const body = await call(ctx, `/calendars/${encodeURIComponent(args.calendar ?? 'primary')}/events?${query}`);
    return (body.items ?? []).map((event: any) => ({
      id: event.id,
      title: event.summary,
      start: event.start?.dateTime ?? event.start?.date,
      end: event.end?.dateTime ?? event.end?.date,
      attendees: (event.attendees ?? []).map((a: any) => a.email),
      status: event.status,
    }));
  },
});

export const book = defineTool<{ title: string; start: string; end: string; attendees?: string[]; notes?: string }>({
  name: 'book',
  description:
    'Create an event. If it has attendees, they get an invitation immediately — that is why it asks. ' +
    'Check the agenda first, and propose times in their working hours.',
  effect: 'write',
  input: input({
    title: { type: 'string', description: 'What it is, as the attendees will read it.' },
    start: { type: 'string', description: 'RFC3339.' },
    end: { type: 'string', description: 'RFC3339.' },
    attendees: { type: 'array', items: 'string', description: 'Email addresses. Omit for a personal block.', optional: true },
    notes: { type: 'string', description: 'Description body.', optional: true },
  }),
  preview: (args) =>
    `book "${args.title}" ${args.start} → ${args.end}` +
    (args.attendees?.length ? ` and invite ${args.attendees.join(', ')}` : ' (no invites)'),
  run: async (args, ctx) =>
    call(ctx, '/calendars/primary/events?sendUpdates=all', {
      method: 'POST',
      body: JSON.stringify({
        summary: args.title,
        description: args.notes,
        start: { dateTime: args.start },
        end: { dateTime: args.end },
        attendees: (args.attendees ?? []).map((email) => ({ email })),
      }),
    }),
});

export const cancel = defineTool<{ event_id: string; title: string; why: string }>({
  name: 'cancel',
  description: 'Cancel an event. Everyone invited is told. Always asks.',
  effect: 'write',
  input: input({
    event_id: { type: 'string', description: 'From agenda.' },
    title: { type: 'string', description: 'Event title, for the approval prompt.' },
    why: { type: 'string', description: 'Reason, in case they want it in the note.' },
  }),
  preview: (args) => `cancel "${args.title}" — ${args.why}`,
  run: async (args, ctx) => {
    await call(ctx, `/calendars/primary/events/${args.event_id}?sendUpdates=all`, { method: 'DELETE' });
    return 'cancelled';
  },
});
