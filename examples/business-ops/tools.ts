import { type Ctx, defineTool, input } from '../../agent/tools/_kit.ts';

/**
 * Money. Reads are open; anything that moves a dollar asks, every time, with
 * the amount in the prompt. Note there is no payout tool — some things should
 * stay a human typing into a dashboard.
 */
const API = 'https://api.stripe.com/v1';

const call = async (ctx: Ctx, path: string, init?: RequestInit): Promise<any> => {
  const response = await fetch(`${API}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${await ctx.secret('STRIPE_KEY')}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      ...init?.headers,
    },
  });
  const body = (await response.json()) as any;
  if (!response.ok) throw new Error(`stripe ${response.status}: ${body.error?.message ?? ''}`);
  return body;
};

const dollars = (cents: number) => `$${(cents / 100).toLocaleString('en-US', { maximumFractionDigits: 2 })}`;

export const revenue = defineTool<{ days: number }>({
  name: 'revenue',
  description:
    'Successful charges over the last N days, with the daily breakdown. Use it before you claim ' +
    'anything about how the business is doing.',
  input: input({ days: { type: 'number', description: 'How far back to look.' } }),
  run: async (args, ctx) => {
    const since = Math.floor(Date.now() / 1000) - args.days * 86_400;
    const body = await call(ctx, `/charges?limit=100&created[gte]=${since}`);
    const paid = (body.data ?? []).filter((charge: any) => charge.paid && !charge.refunded);
    const byDay: Record<string, number> = {};
    for (const charge of paid) {
      const day = new Date(charge.created * 1000).toISOString().slice(0, 10);
      byDay[day] = (byDay[day] ?? 0) + charge.amount;
    }
    const total = paid.reduce((sum: number, charge: any) => sum + charge.amount, 0);
    return {
      total: dollars(total),
      charges: paid.length,
      truncated: body.has_more === true,
      byDay: Object.fromEntries(Object.entries(byDay).map(([day, cents]) => [day, dollars(cents)])),
    };
  },
});

export const customer = defineTool<{ email: string }>({
  name: 'customer',
  description: 'Everything about one customer: subscriptions, recent charges, whether anything failed.',
  input: input({ email: { type: 'string', description: 'Their billing email.' } }),
  run: async (args, ctx) => {
    const found = await call(ctx, `/customers?email=${encodeURIComponent(args.email)}&limit=1`);
    const record = found.data?.[0];
    if (!record) return `no customer with that email`;
    const [subs, charges] = await Promise.all([
      call(ctx, `/subscriptions?customer=${record.id}&status=all&limit=10`),
      call(ctx, `/charges?customer=${record.id}&limit=10`),
    ]);
    return {
      id: record.id,
      created: new Date(record.created * 1000).toISOString().slice(0, 10),
      subscriptions: (subs.data ?? []).map((s: any) => ({ id: s.id, status: s.status, plan: s.items?.data?.[0]?.price?.nickname })),
      charges: (charges.data ?? []).map((c: any) => ({ id: c.id, amount: dollars(c.amount), paid: c.paid, refunded: c.refunded })),
    };
  },
});

export const refund = defineTool<{ charge_id: string; amount_cents: number; who: string; why: string }>({
  name: 'refund',
  description:
    'Refund a charge, fully or partly. Always asks, and the human sees the amount and the reason. ' +
    'Check the policy in memory before you propose one.',
  effect: 'write',
  input: input({
    charge_id: { type: 'string', description: 'Charge id from `customer`.' },
    amount_cents: { type: 'number', description: 'Cents. The full charge amount for a full refund.' },
    who: { type: 'string', description: 'Customer email, for the approval prompt.' },
    why: { type: 'string', description: 'One line. This goes in the journal.' },
  }),
  preview: (args) => `refund ${dollars(args.amount_cents)} to ${args.who} — ${args.why}`,
  run: async (args, ctx) => {
    const result = await call(ctx, '/refunds', {
      method: 'POST',
      body: new URLSearchParams({ charge: args.charge_id, amount: String(args.amount_cents) }),
    });
    await ctx.note('refund', { charge: args.charge_id, amount: args.amount_cents, why: args.why });
    return { id: result.id, status: result.status, amount: dollars(result.amount) };
  },
});
