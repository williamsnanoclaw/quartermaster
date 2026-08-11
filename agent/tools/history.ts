import { defineTool, input } from './_kit.ts';

export const history = defineTool<{ limit?: number; kind?: string }>({
  name: 'history',
  description:
    'Your own record: messages, tool calls, shell commands, approvals, schedule runs, newest first. ' +
    'Use it when the human asks what you did, when you need to know whether you already tried ' +
    'something, or before repeating an action that might not be safe to repeat. ' +
    'Kinds include: message, did, tool, approved, declined, ask, answered, turn, schedule.fired.',
  input: input({
    limit: { type: 'number', description: 'How many entries. Default 50, max 200.', optional: true },
    kind: { type: 'string', description: 'Filter to one kind.', optional: true },
  }),
  run: (args, ctx) => ctx.history(args.limit ?? 50, args.kind),
});
