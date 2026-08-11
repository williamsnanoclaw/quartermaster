import type { Setting } from '../../src/config.ts';

/** All gated: the container never holds the keys to someone's mailbox. */
export const settings: Setting[] = [
  {
    key: 'GOOGLE_CLIENT_ID',
    label: 'Google OAuth client id',
    why: 'Lets the agent talk to Gmail as you. You make a client once; it is free.',
    how: [
      'console.cloud.google.com → new project',
      'APIs & Services → Library → enable Gmail API',
      'Credentials → Create credentials → OAuth client ID → Desktop app',
      'Copy the client ID',
    ],
    url: 'https://console.cloud.google.com/apis/credentials',
    scope: 'gated',
  },
  {
    key: 'GOOGLE_CLIENT_SECRET',
    label: 'Google OAuth client secret',
    why: 'The other half of the client you just made.',
    secret: true,
    scope: 'gated',
  },
  {
    key: 'GOOGLE_REFRESH_TOKEN',
    label: 'Google refresh token',
    why: 'Proof you granted this client access to your mail. Google only shows it once, so paste it somewhere safe too.',
    how: [
      'Go to developers.google.com/oauthplayground',
      'Gear icon → tick "Use your own OAuth credentials" → paste the id and secret',
      'Select the Gmail API v1 scope https://mail.google.com/',
      'Authorise, then "Exchange authorization code for tokens"',
      'Copy the refresh token',
    ],
    url: 'https://developers.google.com/oauthplayground',
    secret: true,
    scope: 'gated',
  },
];
