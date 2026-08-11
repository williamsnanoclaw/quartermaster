import { type Ctx, defineTool, input } from '../../agent/tools/_kit.ts';

/**
 * Gmail, four ways. Reading is free; anything that changes the mailbox asks.
 *
 * Note there is no "summarise" tool and no "decide if urgent" tool. Those are
 * the agent's job, and it is better at them than any code you would write here.
 */
const API = 'https://gmail.googleapis.com/gmail/v1/users/me';

/** Google access tokens last an hour, so we trade the refresh token each time. */
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
  const text = await response.text(); // batchModify comes back 204 with no body
  if (!response.ok) throw new Error(`gmail ${response.status}: ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : {};
};

export const searchInbox = defineTool<{ query: string; limit?: number }>({
  name: 'search_inbox',
  description:
    'Search the mailbox with Gmail query syntax (is:unread, from:, newer_than:3d, has:attachment). ' +
    'Returns ids and subjects — use read_thread for the body.',
  input: input({
    query: { type: 'string', description: 'Gmail search query.' },
    limit: { type: 'number', description: 'Default 25.', optional: true },
  }),
  run: async (args, ctx) => {
    const list = await call(ctx, `/messages?q=${encodeURIComponent(args.query)}&maxResults=${args.limit ?? 25}`);
    const ids: string[] = (list.messages ?? []).map((m: { id: string }) => m.id);
    return Promise.all(
      ids.map(async (id) => {
        const message = await call(ctx, `/messages/${id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date`);
        const header = (name: string) =>
          message.payload?.headers?.find((h: { name: string }) => h.name === name)?.value ?? '';
        return { id, threadId: message.threadId, from: header('From'), subject: header('Subject'), snippet: message.snippet };
      }),
    );
  },
});

export const readThread = defineTool<{ thread_id: string }>({
  name: 'read_thread',
  description: 'Read a whole thread, oldest message first, so you can see how a conversation actually went.',
  input: input({ thread_id: { type: 'string', description: 'threadId from search_inbox.' } }),
  run: async (args, ctx) => {
    const thread = await call(ctx, `/threads/${args.thread_id}?format=full`);
    return (thread.messages ?? []).map((message: any) => ({
      from: message.payload?.headers?.find((h: { name: string }) => h.name === 'From')?.value,
      date: message.payload?.headers?.find((h: { name: string }) => h.name === 'Date')?.value,
      text: decode(message.payload),
    }));
  },
});

export const draftReply = defineTool<{ thread_id: string; to: string; subject: string; body: string }>({
  name: 'draft_reply',
  description:
    'Save a reply as a draft. Not gated — a draft reaches nobody. Draft freely, then ask once whether ' +
    'to send. Match how they write: check recent sent mail before you invent a voice.',
  input: input({
    thread_id: { type: 'string', description: 'Thread to reply into.' },
    to: { type: 'string', description: 'Recipient address.' },
    subject: { type: 'string', description: 'Usually "Re: ..." from the thread.' },
    body: { type: 'string', description: 'Plain text.' },
  }),
  run: async (args, ctx) => {
    const raw = Buffer.from(`To: ${args.to}\r\nSubject: ${args.subject}\r\n\r\n${args.body}`)
      .toString('base64url');
    const draft = await call(ctx, '/drafts', {
      method: 'POST',
      body: JSON.stringify({ message: { raw, threadId: args.thread_id } }),
    });
    return { draftId: draft.id, review: 'https://mail.google.com/mail/u/0/#drafts' };
  },
});

export const sendDraft = defineTool<{ draft_id: string; to: string; summary: string }>({
  name: 'send_draft',
  description: 'Send a draft. This reaches a person and cannot be undone, so it always asks first.',
  effect: 'write',
  input: input({
    draft_id: { type: 'string', description: 'From draft_reply.' },
    to: { type: 'string', description: 'Who receives it.' },
    summary: { type: 'string', description: 'One line of what the reply says. Shown in the approval.' },
  }),
  preview: (args) => `send to ${args.to} — ${args.summary}`,
  run: async (args, ctx) => call(ctx, '/drafts/send', { method: 'POST', body: JSON.stringify({ id: args.draft_id }) }),
});

export const archive = defineTool<{ ids: string[]; why: string }>({
  name: 'archive',
  description:
    'Move messages out of the inbox. Reversible, but it changes what they see, so it asks. ' +
    'Batch them — one approval for thirty messages beats thirty approvals.',
  effect: 'write',
  input: input({
    ids: { type: 'array', items: 'string', description: 'Message ids.' },
    why: { type: 'string', description: 'The rule you applied, e.g. "newsletters older than a week".' },
  }),
  preview: (args) => `archive ${args.ids.length} messages — ${args.why}`,
  run: async (args, ctx) => {
    await call(ctx, '/messages/batchModify', {
      method: 'POST',
      body: JSON.stringify({ ids: args.ids, removeLabelIds: ['INBOX'] }),
    });
    return `archived ${args.ids.length}`;
  },
});

/** Gmail nests bodies in parts; take the first text/plain we find. */
function decode(part: any): string {
  if (part?.mimeType === 'text/plain' && part.body?.data) {
    return Buffer.from(part.body.data, 'base64url').toString('utf8').slice(0, 8000);
  }
  for (const child of part?.parts ?? []) {
    const found = decode(child);
    if (found) return found;
  }
  return '';
}
