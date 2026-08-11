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
    room_id: { type: 'string', description: 'Room id from `rooms`.' },
    text: { type: 'string', description: 'What to say. Same brevity as everywhere else.' },
  }),
  run: async (args, ctx) => {
    await ctx.rooms.send(args.room_id, args.text);
    return 'posted';
  },
});
