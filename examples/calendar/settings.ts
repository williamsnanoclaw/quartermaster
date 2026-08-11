import type { Setting } from '../../src/config.ts';

/** Same Google client as the email example; the scope is what differs. */
export const settings: Setting[] = [
  {
    key: 'GOOGLE_CLIENT_ID',
    label: 'Google OAuth client id',
    why: 'Lets the agent read and edit your calendar as you.',
    how: [
      'console.cloud.google.com → new project',
      'APIs & Services → Library → enable Google Calendar API',
      'Credentials → Create credentials → OAuth client ID → Desktop app',
    ],
    url: 'https://console.cloud.google.com/apis/credentials',
    scope: 'gated',
  },
  {
    key: 'GOOGLE_CLIENT_SECRET',
    label: 'Google OAuth client secret',
    why: 'The other half of that client.',
    secret: true,
    scope: 'gated',
  },
  {
    key: 'GOOGLE_REFRESH_TOKEN',
    label: 'Google refresh token',
    why: 'Proof you granted access. Google shows it once.',
    how: [
      'developers.google.com/oauthplayground',
      'Gear icon → use your own OAuth credentials',
      'Select scope https://www.googleapis.com/auth/calendar',
      'Authorise, exchange the code, copy the refresh token',
    ],
    url: 'https://developers.google.com/oauthplayground',
    secret: true,
    scope: 'gated',
  },
  {
    key: 'WORK_HOURS',
    label: 'Working hours',
    why: 'The agent will not propose anything outside these unless you tell it to.',
    default: '09:00-18:00',
    optional: true,
  },
];
