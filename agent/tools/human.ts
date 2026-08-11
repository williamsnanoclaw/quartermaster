import type { State } from '../../src/protocol.ts';
import { defineTool, input } from './_kit.ts';

/** The only three ways the agent is allowed to touch the human's attention. */

export const ask = defineTool<{ question: string; options?: string[] }>({
  name: 'ask',
  description:
    'Ask the human a question and wait for the answer. Use this before anything that affects them, ' +
    'and whenever a guess would be expensive to get wrong. Reaches their terminal and their phone. ' +
    'One question, one sentence. If they are away for an hour it comes back saying nobody answered — ' +
    'that is not a yes; work around it and leave the question open.',
  input: input({
    question: { type: 'string', description: 'The question. Short. No preamble.' },
    options: {
      type: 'array',
      items: 'string',
      description: 'Up to 6 tappable answers, 48 characters each. Offer them when the answer is a choice.',
      optional: true,
    },
  }),
  run: (args, ctx) => ctx.ask(args.question, args.options),
});

export const notify = defineTool<{ text: string }>({
  name: 'notify',
  description:
    'Send the human one line, no reply expected. For things worth interrupting them over. ' +
    'If it can wait for the next time they look at the terminal, do not use this.',
  input: input({ text: { type: 'string', description: 'One sentence. It lands on a lock screen.' } }),
  run: async (args, ctx) => {
    await ctx.notify(args.text);
    return 'sent';
  },
});

export const status = defineTool<{ state?: State; detail?: string; metrics?: Record<string, string> }>({
  name: 'status',
  description:
    'Set what the dashboard shows. Call it when you start something, when the picture changes, ' +
    'and when you finish. `detail` is one short line about what you are doing right now. ' +
    '`metrics` is whatever numbers matter for this agent — you decide the keys.',
  input: input({
    state: {
      type: 'string',
      enum: ['idle', 'thinking', 'working', 'waiting', 'blocked', 'error'],
      description: 'Coarse state.',
      optional: true,
    },
    detail: { type: 'string', description: 'One line. "triaging 12 unread", not a paragraph.', optional: true },
    metrics: { type: 'object', description: 'Flat string map, e.g. {"unread":"12","drafted":"3"}.', optional: true },
  }),
  run: async (args, ctx) => {
    await ctx.status(args);
    return 'ok';
  },
});
