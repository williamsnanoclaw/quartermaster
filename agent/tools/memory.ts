import { defineTool, input } from './_kit.ts';

/**
 * Memory is markdown at .quartermaster/memory. These tools keep the index honest;
 * for anything they do not cover, use the shell — it is your folder.
 */

export const remember = defineTool<{ id: string; title?: string; body: string; tags?: string[] }>({
  name: 'remember',
  description:
    'Write or overwrite a memory note. Store things that will still matter next week: decisions and ' +
    'their reasons, how a person likes to be handled, what broke and why. Not transcripts, not things ' +
    'you can look up again. Reuse an id to revise a note rather than piling up near-duplicates.',
  input: input({
    id: { type: 'string', description: 'Stable slug, e.g. "billing-policy". Reuse it to update.' },
    body: { type: 'string', description: 'Markdown. Lead with the conclusion.' },
    title: { type: 'string', description: 'Short human title.', optional: true },
    tags: { type: 'array', items: 'string', description: 'A few lowercase tags.', optional: true },
  }),
  run: (args, ctx) => ctx.remember(args),
});

export const recall = defineTool<{ query: string }>({
  name: 'recall',
  description:
    'Search memory. Returns the closest notes with their full text. Check here before asking the ' +
    'human something they may have already told you.',
  input: input({ query: { type: 'string', description: 'Words you expect in the note.' } }),
  run: (args, ctx) => ctx.recall(args.query),
});

export const forget = defineTool<{ id: string }>({
  name: 'forget',
  description: 'Delete a memory note that is wrong or obsolete. Stale memory is worse than none.',
  input: input({ id: { type: 'string', description: 'The note id.' } }),
  run: (args, ctx) => ctx.forget(args.id),
});
