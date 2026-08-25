import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { journal } from './journal.ts';
import { paths } from './workspace.ts';

/**
 * Standing orders from the human. "Always ship before polishing", not "yes do
 * that". A correction given in week one still binds in week nine, which is the
 * whole point of writing it here instead of saying it in chat.
 *
 * The journal is the authoritative copy, not the markdown file. The agent has a
 * shell and everything under /workspace is writable, so a file it could quietly
 * edit would be a rule it could quietly repeal. CORRECTIONS.md is a rendered
 * view, rewritten from the journal on every boot and every addition.
 *
 * Two different limits, on purpose:
 *   - the file keeps everything, so nothing the human said is ever lost
 *   - the block injected into context is capped, and says out loud when it has
 *     left something out, because silent truncation of a rule is the same
 *     failure as forgetting it
 */
const MAX_LENGTH = 280;
const MAX_INJECTED = 4_000;
const LOOKBACK = 500;

export type Correction = { at: string; text: string };

const all = (): Correction[] =>
  journal
    .recent(LOOKBACK, 'correction')
    .map((event) => ({ at: event.at.slice(0, 10), text: (event.data as { text: string }).text }));

export const corrections = {
  /** Newest first. */
  all,

  add(text: string): Correction {
    const clean = text.trim().replace(/\s+/g, ' ');
    if (!clean) throw new Error('a correction needs some text');
    if (clean.length > MAX_LENGTH) {
      throw new Error(
        `that's ${clean.length} characters. A correction is a standing order, not a briefing — keep it under ${MAX_LENGTH}.`,
      );
    }
    if (all().some((existing) => existing.text.toLowerCase() === clean.toLowerCase())) {
      throw new Error('you have already given that one');
    }
    journal.record('correction', { text: clean });
    corrections.publish();
    return { at: new Date().toISOString().slice(0, 10), text: clean };
  },

  /** Rewrite the readable copy from the journal, undoing any edits to it. */
  publish() {
    const list = all();
    const body = list.length
      ? list.map((c) => `- ${c.at} — ${c.text}`).join('\n')
      : '_None yet. The human adds these with `/correct <text>`._';
    writeFileSync(
      join(paths.home, 'CORRECTIONS.md'),
      `# Corrections\n\nStanding orders from the human, newest first. You cannot change this file —\n` +
        `it is rewritten from the journal. If one is wrong, say so; don't edit it.\n\n${body}\n`,
    );
  },

  /**
   * The block that goes into the agent's context, newest first and bounded.
   * Returns null when there is nothing to say.
   */
  render(): string | null {
    const list = all();
    if (!list.length) return null;

    const lines: string[] = [];
    let used = 0;
    let hidden = 0;
    for (const correction of list) {
      const line = `- ${correction.at} — ${correction.text}`;
      if (used + line.length > MAX_INJECTED) hidden += 1;
      else {
        lines.push(line);
        used += line.length + 1;
      }
    }

    return [
      'Standing orders from the human. These outrank anything you decide for yourself:',
      ...lines,
      hidden ? `(${hidden} older corrections not shown — all of them are in CORRECTIONS.md.)` : '',
    ]
      .filter(Boolean)
      .join('\n');
  },
};
