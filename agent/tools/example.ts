import { defineTool, input } from './_kit.ts';

/**
 * A template. Copy it, rename it, delete this one.
 *
 * It shows the three things a real tool usually needs:
 *   effect: 'write'  — this leaves the sandbox, so the human is asked first
 *   preview()        — what they see in that prompt; be specific, not generic
 *   ctx.secret()     — a credential the container never holds in its env
 */
export const postWebhook = defineTool<{ url: string; body: string }>({
  name: 'post_webhook',
  description: 'POST a JSON body to a webhook. Example tool — replace with something this agent actually needs.',
  effect: 'write',
  input: input({
    url: { type: 'string', description: 'Destination URL.' },
    body: { type: 'string', description: 'JSON body as a string.' },
  }),
  // Never truncate silently — the human is approving what this line says.
  preview: (args) =>
    args.body.length > 200
      ? `POST ${args.url} — ${args.body.slice(0, 200)}… (${args.body.length} chars)`
      : `POST ${args.url} — ${args.body}`,
  run: async (args, ctx) => {
    // Not wrapped in a catch: if the human declines the credential, the tool
    // fails. Sending the request anyway, unauthenticated, is not a fallback.
    const token = await ctx.secret('WEBHOOK_TOKEN');
    const response = await fetch(args.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: args.body,
    });
    await ctx.note('webhook.post', { url: args.url, status: response.status });
    return { status: response.status, body: (await response.text()).slice(0, 2000) };
  },
});
