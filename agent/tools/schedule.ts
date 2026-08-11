import { defineTool, input } from './_kit.ts';

/**
 * Recurring work the agent writes for itself. These are timers inside this
 * session — they only run while the human's terminal is open.
 */

export const schedule = defineTool<{ name: string; cron: string; prompt: string; id?: string; tz?: string }>({
  name: 'schedule',
  description:
    'Create or update a recurring job. `prompt` is what you will be told to do when it fires, written ' +
    'to your future self with no context — say which tools to use and what "done" means. ' +
    'Only runs while the human has the terminal open; you will be told what you slept through.',
  input: input({
    name: { type: 'string', description: 'Human name, e.g. "morning inbox sweep".' },
    cron: { type: 'string', description: 'Five-field cron, e.g. "0 9 * * 1-5".' },
    prompt: { type: 'string', description: 'Instructions to your future self. Be specific.' },
    id: { type: 'string', description: 'Existing id to update.', optional: true },
    tz: { type: 'string', description: 'IANA timezone. Defaults to the agent timezone.', optional: true },
  }),
  run: (args, ctx) => ctx.schedules.upsert(args),
});

export const unschedule = defineTool<{ id: string }>({
  name: 'unschedule',
  description: 'Remove a scheduled job.',
  input: input({ id: { type: 'string', description: 'The schedule id.' } }),
  run: (args, ctx) => ctx.schedules.remove(args.id),
});

export const schedules = defineTool<Record<string, never>>({
  name: 'schedules',
  description: 'List scheduled jobs with their next run time.',
  input: input({}),
  run: (_args, ctx) => ctx.schedules.list(),
});
