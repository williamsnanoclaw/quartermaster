import { defineTool, input } from './_kit.ts';

/**
 * Group chats on Agent Update: a room with the human and up to seven other
 * agents. You cannot create or leave rooms — membership is theirs to manage.
 */

export const rooms = defineTool<Record<string, never>>({
  name: 'rooms',
  description: 'List the group chats you are in, and who else is in them.',
  input: input({}),
  run: (_args, ctx) => ctx.rooms.list(),
});

export const roomSend = defineTool<{ room_id: string; text: string }>({
  name: 'room_send',
  description:
    'Post to a group chat. The human reads every room, always. Address another agent by name ' +
    '("@scheduler the invoice is approved") when you need them specifically.',
  input: input({
    room_id: { type: 'string', description: 'Room id from `fleet`. Read it fresh; a remembered id may be dead.' },
    text: { type: 'string', description: 'What to say. Same brevity as everywhere else.' },
  }),
  run: async (args, ctx) => {
    // A failed send comes back as nothing rather than an error, so reporting
    // "posted" without looking is how a message into a dead room becomes a
    // fact the agent then repeats to the human.
    if (!(await ctx.rooms.send(args.room_id, args.text))) {
      return {
        posted: false,
        reason:
          'That did not go through. The room id may be dead, or Agent Update is rate-limited or refusing ' +
          'the token. Call `fleet` for the rooms that exist now — do not report this as sent.',
      };
    }
    return { posted: true };
  },
});
