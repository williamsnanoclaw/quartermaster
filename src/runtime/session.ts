import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runTurn, type TurnHandlers, type TurnResult } from './codex.ts';
import { corrections } from './corrections.ts';
import { journal } from './journal.ts';
import { memory } from './memory.ts';
import { paths } from './workspace.ts';

/**
 * One long conversation, kept alive across weeks.
 *
 * Codex threads grow. Left alone, a month-old agent is a model drowning in its
 * own transcript — slower, more confused, more expensive, every turn. So an arc
 * has a ceiling: when it is reached, the agent writes a handoff note to memory
 * and we start a clean thread seeded with the note, the memory index, and its
 * objective. Nothing important is lost, because anything important was already
 * written down. That is why memory is a folder and not a scrollback.
 */
// Read at call time, not at import: settings can change under a running agent.
// The ceiling counts new content added to the thread — see `run` — so it is not
// comparable to the old one, which counted the same thread over and over. On a
// delegating workload this is roughly fifteen to twenty turns an arc, where the
// old number bought three.
const tokenCeiling = () => Number(process.env.TEMPER_ARC_TOKENS ?? 600_000);
const turnCeiling = () => Number(process.env.TEMPER_ARC_TURNS ?? 60);
const INDEX_LIMIT = 200;

/** Things the agent should be told at the start of its next turn, whenever that is. */
let pending: string[] = [];

export const session = {
  threadId: journal.get('thread') || null,
  turns: Number(journal.get('arc.turns') ?? 0),
  tokens: Number(journal.get('arc.tokens') ?? 0),

  /** Queue context for the next turn instead of burning a turn to deliver it. */
  note(text: string) {
    pending.push(text);
  },

  async run(prompt: string, handlers: TurnHandlers, signal: AbortSignal): Promise<TurnResult> {
    // Read, don't drain: a turn that fails must not swallow the one thing it
    // was supposed to tell the agent.
    // A copy, not an alias. Aliasing meant anything queued *during* the turn
    // was also in `carried`, so the filter below dropped it as delivered — a
    // standing order typed while the agent is working vanished silently.
    const carried = [...pending];
    const preface = [this.threadId ? '' : seed(), carried.join('\n')].filter(Boolean).join('\n\n');

    const result = await runTurn(preface ? `${preface}\n\n---\n\n${prompt}` : prompt, this.threadId, handlers, signal);

    if (result.threadId && result.threadId !== this.threadId) {
      this.threadId = result.threadId;
      journal.set('thread', result.threadId);
    }
    if (!result.error) pending = pending.filter((note) => !carried.includes(note));

    this.turns += 1;
    // What the thread grew by, not what the turn cost.
    //
    // `input_tokens` is summed over every model call inside the turn, so a turn
    // with ten tool calls reports ten replays of the same thread and reads as a
    // thread ten times the size. Taking the high-water mark of that number is
    // why arcs were rotating every third turn — 554k measured against a 220k
    // ceiling on a thread that was nothing like 554k long. The agent was losing
    // its memory for being busy, not for being old.
    //
    // New content is uncached exactly once and cached forever after, so
    // uncached input plus output is the part that stayed in the thread.
    const usage = result.usage;
    if (usage) {
      this.tokens += Math.max(0, usage.input_tokens - usage.cached_input_tokens) + usage.output_tokens;
    }
    journal.set('arc.turns', String(this.turns));
    journal.set('arc.tokens', String(this.tokens));
    journal.record('turn', { error: result.error, usage: result.usage, chars: result.text.length });
    return result;
  },

  worthRotating(): boolean {
    return this.tokens > tokenCeiling() || this.turns > turnCeiling();
  },

  /**
   * Ask the agent to summarise itself, keep the summary, drop the thread.
   * Cheaper than a compaction algorithm, and the agent knows what mattered.
   */
  async rotate(handlers: TurnHandlers, signal: AbortSignal) {
    const result = await this.run(
      'Wrap up this session arc. In under 300 words: what you are in the middle of, what you decided ' +
        'and why, what you are waiting on, and anything your next self would repeat a mistake without. ' +
        'Prose, no headings. Do not use tools.',
      handlers,
      signal,
    );

    // No summary means no continuity. Keeping the thread one more drain is far
    // better than starting fresh with a handoff note from two arcs ago.
    if (result.error || !result.text) {
      journal.record('arc.rotation-deferred', { error: result.error });
      return;
    }

    memory.write({ id: 'session-handoff', title: 'Where we left off', body: result.text, tags: ['handoff'] });
    journal.record('arc.rotated', { turns: this.turns, tokens: this.tokens });
    this.threadId = null;
    this.turns = 0;
    this.tokens = 0;
    journal.set('thread', '');
    journal.set('arc.turns', '0');
    journal.set('arc.tokens', '0');
    pending.push('Fresh thread. Your handoff note is memory/session-handoff.md — read it before acting.');
  },
};

/** Read the agent's own copy, from the read-only mount rather than the folder. */
const doc = (file: string) => {
  try {
    return readFileSync(join('/app/agent', file), 'utf8').trim();
  } catch {
    return '';
  }
};

/**
 * The opening context of a new arc.
 *
 * AGENTS.md and NORTH_STAR.md are put in here rather than left to load
 * themselves. Codex looks for a project doc starting at the working directory,
 * and that is now the human's folder — so it would find *their* AGENTS.md, if
 * they have one, and never ours. Reading them in is the only version of this
 * that does not depend on whose repo the agent was started in.
 */
function seed(): string {
  const notes = memory.index();
  const shown = notes.slice(0, INDEX_LIMIT);
  const handoff = memory.read('session-handoff');
  const northStar = doc('NORTH_STAR.md');
  const agents = doc('AGENTS.md');
  return [
    `Session started ${new Date().toISOString()} (${process.env.TEMPER_TZ ?? 'UTC'}).`,
    `Working directory is ${paths.root}, a real folder on the human's machine. Your own files are in ${paths.home}.`,
    northStar ? `# NORTH_STAR.md — why you exist\n\n${northStar}` : '',
    agents ? `# AGENTS.md — how you operate\n\n${agents}` : '',
    // Re-asserted on every arc, so compaction can never quietly repeal a rule.
    corrections.render(),
    notes.length
      ? `Memory (${notes.length} notes, \`cat memory/<id>.md\` to read one):\n` +
        shown.map((n) => `- ${n.id}: ${n.title}`).join('\n') +
        (notes.length > shown.length ? `\n- …and ${notes.length - shown.length} more in memory/INDEX.md` : '')
      : 'Memory is empty. Write notes as you learn things worth keeping.',
    handoff ? `Where you left off:\n${handoff.body}` : '',
  ]
    .filter(Boolean)
    .join('\n\n');
}
