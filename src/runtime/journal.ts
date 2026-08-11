import { DatabaseSync } from 'node:sqlite';
import { paths } from './workspace.ts';

/**
 * Append-only history plus a tiny key/value store.
 *
 * Two tables, no migrations, no ORM. This is the thing that has to survive
 * weeks of uptime and hard kills, so it stays boring: WAL mode, one INSERT per
 * event, nothing ever updated in place. When you want to know what the agent
 * did last Tuesday, it is one SELECT away.
 */
export type Event = {
  id: number;
  at: string;
  kind: string;
  data: unknown;
};

const db = new DatabaseSync(paths.journal);
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA synchronous = NORMAL;
  CREATE TABLE IF NOT EXISTS events (
    id   INTEGER PRIMARY KEY AUTOINCREMENT,
    at   TEXT NOT NULL,
    kind TEXT NOT NULL,
    data TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS events_kind ON events (kind, id);
  CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);
`);

const insert = db.prepare('INSERT INTO events (at, kind, data) VALUES (?, ?, ?)');
const recent = db.prepare('SELECT * FROM events ORDER BY id DESC LIMIT ?');
const recentOf = db.prepare('SELECT * FROM events WHERE kind = ? ORDER BY id DESC LIMIT ?');
const readKv = db.prepare('SELECT value FROM kv WHERE key = ?');
const writeKv = db.prepare('INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
const countAll = db.prepare('SELECT COUNT(*) AS n FROM events');

const hydrate = (row: Record<string, unknown>): Event => ({
  id: row.id as number,
  at: row.at as string,
  kind: row.kind as string,
  data: JSON.parse(row.data as string),
});

export const journal = {
  record(kind: string, data: unknown = {}) {
    insert.run(new Date().toISOString(), kind, JSON.stringify(data));
  },

  /** Newest first. Pass a kind to filter. */
  recent(limit = 50, kind?: string): Event[] {
    const rows = kind ? recentOf.all(kind, limit) : recent.all(limit);
    return rows.map(hydrate);
  },

  count(): number {
    return (countAll.get() as { n: number }).n;
  },

  get(key: string): string | undefined {
    const row = readKv.get(key) as { value: string } | undefined;
    return row?.value;
  },

  set(key: string, value: string) {
    writeKv.run(key, value);
  },

  /**
   * Called on a timer. Truncates the WAL and drops the oldest events so that a
   * month of uptime cannot fill the volume — which, on this codebase, would
   * turn every subsequent write into a crash.
   */
  compact(keep = Number(process.env.TEMPER_JOURNAL_KEEP ?? 200_000)) {
    db.prepare('DELETE FROM events WHERE id <= (SELECT MAX(id) FROM events) - ?').run(keep);
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  },
};
