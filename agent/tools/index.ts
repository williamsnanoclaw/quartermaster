import type { Tool } from './_kit.ts';
import { ask, notify, status } from './human.ts';
import { forget, recall, remember } from './memory.ts';
import { history } from './history.ts';
import { schedule, schedules, unschedule } from './schedule.ts';
import { roomSend, rooms } from './rooms.ts';
import { postWebhook } from './example.ts';

/**
 * Every tool the agent can call, in the order it will read them.
 *
 * Add yours to this list. Keep the list short — a model with twelve sharp
 * tools outperforms one with forty vague ones, and the shell already covers
 * most of what you would be tempted to wrap.
 */
export const tools: Tool[] = [
  ask,
  notify,
  status,
  remember,
  recall,
  forget,
  history,
  schedule,
  unschedule,
  schedules,
  rooms,
  roomSend,
  postWebhook,
];
