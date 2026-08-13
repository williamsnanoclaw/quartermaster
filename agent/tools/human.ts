import type { State } from '../../src/protocol.ts';
import { defineTool, input } from './_kit.ts';

/** The only three ways the agent is allowed to touch the human's attention. */

export const ask = defineTool<{ question: string; options?: string[] }>({
  name: 'ask',
  description:
    'Ask the human a question and wait for the answer. Use this before anything that affects them, ' +
    'and whenever a guess would be expensive to get wrong. It reaches their terminal and lands on ' +
    'their phone as a question with tappable answers — so this, not a sentence ending in "Approve?", ' +
    'is how you ask permission. Asking in a plain message means nothing to tap and no answer coming. ' +
    'One question, one sentence. If they are away for an hour it comes back saying nobody answered — ' +
    'that is not a yes; work around it and leave the question open.',
  input: input({
    question: { type: 'string', description: 'The question. Short. No preamble.' },
    options: {
      type: 'array',
      items: 'string',
      description:
        'Up to 6 tappable answers, 48 characters each. Always give them for a yes/no or an approval — ' +
        'that is the difference between one tap and them having to type.',
      optional: true,
    },
  }),
  run: (args, ctx) => ctx.ask(args.question, args.options),
});

export const notify = defineTool<{ text: string }>({
  name: 'notify',
  description:
    'Send the human one line on their phone when they did not ask you anything — a scheduled job ' +
    'that found something worth waking them for, or work that finished long after they stopped ' +
    "watching. You do not need it in a turn they started, or in one a peer agent's reply woke you " +
    'for: everything you say already goes back to wherever they are, the moment you say it, so ' +
    'calling this as well sends it twice. It carries one line, so it can say that an answer exists ' +
    'but never the answer — if you are announcing a result, send the result instead. Every call is ' +
    'a buzz on a lock screen, and one that says "on it" or "step two done" spends their attention ' +
    'and returns nothing. If you would not wake them for it, do not send it.',
  input: input({ text: { type: 'string', description: 'One sentence. It lands on a lock screen.' } }),
  run: async (args, ctx) =>
    (await ctx.notify(args.text))
      ? 'sent'
      : 'NOT sent — his phone did not accept it. Say it in your reply instead, and tell him it failed.',
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
