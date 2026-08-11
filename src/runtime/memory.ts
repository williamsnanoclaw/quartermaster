import { closeSync, openSync, readFileSync, readSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { paths } from './workspace.ts';

/**
 * Memory is a folder of markdown files. That is the whole design.
 *
 * No embeddings, no vector store, no retrieval magic. The agent has a shell, so
 * it can `grep` its own memory, rewrite a note, merge two, or throw one away —
 * the same way you would. These functions exist to keep INDEX.md honest and to
 * give the model a cheap first hop; they are a convenience, not a cage.
 */
export type Note = {
  id: string;
  title: string;
  tags: string[];
  updated: string;
  body: string;
};

/** A note is a thought, not a database. Anything larger belongs in files/. */
const MAX_BODY = 256 * 1024;
const HEAD_BYTES = 1024;

function slug(id: string): string {
  const clean = id.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'note';
  // Truncation is where two different ids silently become one file. Keep them
  // apart with a stable fingerprint of the original.
  return clean.length <= 60 ? clean : `${clean.slice(0, 52)}-${createHash('sha1').update(id).digest('hex').slice(0, 7)}`;
}

const file = (id: string) => join(paths.memory, `${slug(id)}.md`);

function parse(id: string, raw: string): Note {
  const match = /^---\n([\s\S]*?)\n---\n?/.exec(raw);
  const head = match?.[1] ?? '';
  const field = (name: string) => new RegExp(`^${name}:\\s*(.*)$`, 'm').exec(head)?.[1]?.trim() ?? '';
  return {
    id,
    title: field('title') || id,
    tags: field('tags').split(',').map((t) => t.trim()).filter(Boolean),
    updated: field('updated'),
    body: raw.slice(match?.[0].length ?? 0).trim(),
  };
}

const names = () => readdirSync(paths.memory).filter((name) => name.endsWith('.md') && name !== 'INDEX.md');

/** Frontmatter only. The index must not depend on reading every note in full. */
function head(name: string): Note {
  const handle = openSync(join(paths.memory, name), 'r');
  try {
    const buffer = Buffer.alloc(HEAD_BYTES);
    const read = readSync(handle, buffer, 0, HEAD_BYTES, 0);
    return { ...parse(name.replace(/\.md$/, ''), buffer.subarray(0, read).toString()), body: '' };
  } finally {
    closeSync(handle);
  }
}

/** How many times `term` occurs, without building a copy of the corpus per term. */
function occurrences(haystack: string, term: string): number {
  let count = 0;
  for (let at = haystack.indexOf(term); at !== -1; at = haystack.indexOf(term, at + term.length)) count += 1;
  return count;
}

export const memory = {
  write(input: { id: string; title?: string; body: string; tags?: string[] }): Note {
    if (input.body.length > MAX_BODY) {
      throw new Error(`that note is ${Math.round(input.body.length / 1024)}KB. Memory is for conclusions — put the bulk in files/ and note where it is.`);
    }
    const id = slug(input.id);
    const note: Note = {
      id,
      title: input.title ?? id,
      tags: input.tags ?? [],
      updated: new Date().toISOString(),
      body: input.body.trim(),
    };
    const frontmatter = `---\ntitle: ${note.title}\ntags: ${note.tags.join(', ')}\nupdated: ${note.updated}\n---\n\n`;
    const temporary = `${file(id)}.tmp`;
    writeFileSync(temporary, frontmatter + note.body + '\n');
    renameSync(temporary, file(id));
    memory.reindex();
    return note;
  },

  read(id: string): Note | null {
    try {
      return parse(slug(id), readFileSync(file(id), 'utf8'));
    } catch {
      return null;
    }
  },

  /** Titles and tags only — cheap. Use `read` for a body. */
  index: (): Note[] => names().map(head).sort((a, b) => b.updated.localeCompare(a.updated)),

  list: (): Note[] =>
    names()
      .map((name) => parse(name.replace(/\.md$/, ''), readFileSync(join(paths.memory, name), 'utf8')))
      .sort((a, b) => b.updated.localeCompare(a.updated)),

  /** Term-frequency scoring over title, tags and body. Good enough, and debuggable. */
  search(query: string, limit = 8): Note[] {
    const terms = query.toLowerCase().split(/\W+/).filter((t) => t.length > 2);
    if (!terms.length) return memory.list().slice(0, limit);
    return memory
      .list()
      .map((note) => {
        const haystack = `${note.title} ${note.tags.join(' ')} ${note.body}`.toLowerCase();
        return { note, score: terms.reduce((sum, term) => sum + occurrences(haystack, term), 0) };
      })
      .filter((hit) => hit.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map((hit) => hit.note);
  },

  forget(id: string): boolean {
    try {
      rmSync(file(id));
      memory.reindex();
      return true;
    } catch {
      return false;
    }
  },

  /** A table of contents the agent reads at the start of every session arc. */
  reindex() {
    const notes = memory.index();
    const lines = notes.map((n) => `- \`${n.id}\` — **${n.title}**${n.tags.length ? ` _(${n.tags.join(', ')})_` : ''}`);
    writeFileSync(
      join(paths.memory, 'INDEX.md'),
      `# Memory\n\n${notes.length} notes. Read one with \`cat memory/<id>.md\`.\n\n${lines.join('\n')}\n`,
    );
  },
};
