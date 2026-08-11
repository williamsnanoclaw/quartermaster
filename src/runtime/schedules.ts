import { renameSync, readFileSync, writeFileSync } from 'node:fs';
import { CronExpressionParser } from 'cron-parser';
import { paths } from './workspace.ts';

/**
 * Recurring work the agent writes for itself.
 *
 * These are timers, not cron daemons. They live and die with your terminal —
 * exactly like a loop you started and can see. Close the window and nothing
 * fires behind your back. Open it again and the agent is told, in plain words,
 * what it slept through; it decides whether catching up still makes sense.
 *
 * The agent has a shell and can edit schedules.json by hand, so nothing here
 * trusts the file: a broken entry is disabled and reported, never thrown.
 */
export type Schedule = {
  id: string;
  name: string;
  cron: string;
  prompt: string;
  enabled: boolean;
  tz: string;
  lastRun: string | null;
  nextRun: string | null;
};

let items: Schedule[] = [];
let overdue: string[] = [];

/** Write-then-rename, so a kill mid-write cannot leave a half file behind. */
function persist() {
  const temporary = `${paths.schedules}.tmp`;
  writeFileSync(temporary, JSON.stringify(items, null, 2));
  renameSync(temporary, paths.schedules);
}

function nextAfter(cron: string, tz: string, from = new Date()): string {
  return CronExpressionParser.parse(cron, { currentDate: from, tz }).next().toDate().toISOString();
}

export const schedules = {
  /** Returns problems worth telling the human about. Never throws. */
  load(): string[] {
    const problems: string[] = [];
    let raw: Schedule[] = [];
    try {
      raw = JSON.parse(readFileSync(paths.schedules, 'utf8'));
      if (!Array.isArray(raw)) throw new Error('not an array');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        // Keep the evidence. Overwriting it with [] would destroy the only
        // copy of work the agent set up for itself.
        try {
          renameSync(paths.schedules, `${paths.schedules}.broken`);
        } catch {
          // Nothing to preserve.
        }
        problems.push('schedules.json was unreadable — saved as schedules.json.broken and starting empty');
      }
      raw = [];
    }

    items = [];
    overdue = [];
    const now = Date.now();
    for (const item of raw) {
      try {
        if (item.enabled && item.nextRun && Date.parse(item.nextRun) < now) {
          overdue.push(`${item.name} (due ${item.nextRun})`);
        }
        items.push({ ...item, nextRun: item.enabled ? nextAfter(item.cron, item.tz) : null });
      } catch (error) {
        problems.push(`schedule "${item?.name ?? '?'}" is broken and has been disabled: ${String(error)}`);
        items.push({ ...item, enabled: false, nextRun: null });
      }
    }
    persist();
    return problems;
  },

  /** What came due while the terminal was closed. */
  missed: () => overdue,

  list: () => items,

  /** Validates the cron expression by parsing it; throws with a usable message. */
  upsert(input: { id?: string; name: string; cron: string; prompt: string; enabled?: boolean; tz?: string }): Schedule {
    const tz = input.tz ?? process.env.TEMPER_TZ ?? 'UTC';
    const nextRun = nextAfter(input.cron, tz);
    const id = input.id ?? input.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 40);
    const existing = items.find((s) => s.id === id);
    const schedule: Schedule = {
      id,
      name: input.name,
      cron: input.cron,
      prompt: input.prompt,
      enabled: input.enabled ?? true,
      tz,
      lastRun: existing?.lastRun ?? null,
      nextRun,
    };
    items = [...items.filter((s) => s.id !== id), schedule];
    persist();
    return schedule;
  },

  remove(id: string): boolean {
    const before = items.length;
    items = items.filter((s) => s.id !== id);
    persist();
    return items.length < before;
  },

  /** Schedules that should fire now. Advances each one past this firing. */
  due(now = Date.now()): Schedule[] {
    const ready = items.filter((s) => s.enabled && s.nextRun && Date.parse(s.nextRun) <= now);
    for (const item of ready) {
      item.lastRun = new Date(now).toISOString();
      try {
        item.nextRun = nextAfter(item.cron, item.tz, new Date(now + 1000));
      } catch {
        item.enabled = false;
        item.nextRun = null;
      }
    }
    if (ready.length) persist();
    return ready;
  },

  /** The soonest upcoming run, for the dashboard's "next:" hint. */
  upcoming(): { name: string; at: number } | null {
    const sorted = items
      .filter((s) => s.enabled && s.nextRun)
      .sort((a, b) => Date.parse(a.nextRun!) - Date.parse(b.nextRun!));
    const first = sorted[0];
    return first ? { name: first.name, at: Date.parse(first.nextRun!) } : null;
  },
};
