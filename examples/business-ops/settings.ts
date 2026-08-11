import type { Setting } from '../../src/config.ts';

export const settings: Setting[] = [
  {
    key: 'STRIPE_KEY',
    label: 'Stripe secret key',
    why: 'Read revenue and issue refunds. Gated — the container never holds it, and the agent has to ask you before it is released, once per session.',
    how: [
      'dashboard.stripe.com → Developers → API keys',
      'Create a restricted key, not the live secret key',
      'Grant: Charges read, Customers read, Subscriptions read, Refunds write',
      'Copy it — Stripe shows it once',
    ],
    url: 'https://dashboard.stripe.com/apikeys',
    secret: true,
    scope: 'gated',
  },
  {
    key: 'REFUND_CEILING',
    label: 'Refund ceiling (dollars)',
    why: 'Written into the north star as a hard limit. The agent still asks below it; above it, it should not propose one at all.',
    default: '200',
    optional: true,
  },
];
