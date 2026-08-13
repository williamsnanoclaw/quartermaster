import type { Ctx, Tool } from '../../agent/tools/_kit.ts';
import { tools } from '../../agent/tools/index.ts';
import type { State, Status } from '../protocol.ts';
import { journal } from './journal.ts';
import { memory } from './memory.ts';
import { schedules } from './schedules.ts';

/**
 * Where tools actually run, and where the effect gate lives.
 *
 * This is inside the supervisor on purpose. The tool server is a separate
 * process spawned by Codex, running as the same user as the agent's shell — so
 * anything the tool server could do, the shell could do by talking to it. By
 * keeping capabilities here and exposing only `list` and `call` over the
 * socket, a shell that connects to it gains exactly nothing the model didn't
 * already have: it can invoke a tool, and that tool still has to clear a human.
 *
 * `ctx` is built per call and handed only to `run`, so a credential can only be
 * fetched from inside a tool invocation the human approved.
 */
export type Deps = {
  /** Resolves to null when the human never answered. Never a default answer. */
  ask: (question: string, options?: string[]) => Promise<string | null>;
  /** False when the message did not land. The agent is told, never reassured. */
  notify: (text: string) => Promise<boolean>;
  status: (patch: Partial<Pick<Status, 'detail' | 'metrics'>> & { state?: State }) => void;
  rooms: { list: () => Promise<unknown>; send: (roomId: string, text: string) => Promise<unknown> };
  /** Held in memory by the supervisor; never in the container's environment. */
  secrets: Map<string, string>;
};

export type Listed = { name: string; description: string; inputSchema: unknown };

export function toolHost(deps: Deps) {
  const duplicates = tools.map((t) => t.name).filter((name, i, all) => all.indexOf(name) !== i);
  if (duplicates.length) throw new Error(`two tools share a name: ${duplicates.join(', ')}`);

  // Keyed by tool for "allow all session", and by tool+secret for credentials.
  const allowed = new Set<string>();

  const preview = (tool: Tool, args: Record<string, unknown>) => {
    const custom = tool.preview?.(args);
    if (custom) return custom;
    const json = JSON.stringify(args) ?? '{}';
    return json.length > 160 ? `${tool.name} ${json.slice(0, 160)}… (${json.length} chars)` : `${tool.name} ${json}`;
  };

  const contextFor = (tool: Tool): Ctx => ({
    // A question is the one place silence can be reported rather than refused —
    // the agent is told to route around it instead of stalling until morning.
    ask: async (question, options) =>
      (await deps.ask(question, options)) ??
      'No answer — they have been away for an hour. Do not wait on this. Do whatever the answer ' +
        'does not change, and leave the question for them.',
    notify: deps.notify,
    status: async (patch) => deps.status(patch),
    remember: async (note) => memory.write(note),
    recall: async (query) => memory.search(query),
    forget: async (id) => memory.forget(id),
    history: async (limit, kind) => journal.recent(Math.min(limit, 200), kind),
    schedules: {
      list: async () => schedules.list(),
      // Push status after either change so the dashboard's "next:" is right
      // the moment the agent sets a schedule, not whenever it next speaks.
      upsert: async (input) => {
        const created = schedules.upsert(input);
        deps.status({});
        return created;
      },
      remove: async (id) => {
        const removed = schedules.remove(id);
        deps.status({});
        return removed;
      },
    },
    rooms: deps.rooms,
    note: async (kind, data) => journal.record(`agent.${kind}`, data),

    async secret(name) {
      const value = deps.secrets.get(name);
      if (value === undefined) {
        throw new Error(`no secret named ${name}. Add it to agent/manifest.ts with scope: 'gated'.`);
      }
      const key = `${tool.name}:${name}`;
      if (!allowed.has(key)) {
        const answer = await deps.ask(`Let ${tool.name} use the ${name} credential this session?`, ['Yes', 'No']);
        if (answer === null) throw new Error(`nobody answered, so ${name} stays sealed. Try again when they are back.`);
        if (!/^y/i.test(answer)) throw new Error(`the human declined ${name} to ${tool.name}`);
        allowed.add(key);
      }
      journal.record('secret.used', { tool: tool.name, name });
      return value;
    },
  });

  return {
    list: (): Listed[] =>
      tools.map((tool) => ({ name: tool.name, description: tool.description, inputSchema: tool.input })),

    async call(name: string, args: Record<string, unknown>): Promise<{ text: string; failed: boolean }> {
      const tool = tools.find((t) => t.name === name);
      if (!tool) return { text: `no such tool: ${name}`, failed: true };

      if (tool.effect === 'write' && !allowed.has(tool.name)) {
        const line = preview(tool, args);
        const options = tool.repeatable ? ['Allow once', 'Allow all session', 'No'] : ['Allow once', 'No'];
        const answer = await deps.ask(line, options);
        // Silence is a refusal here, always. An agent that acts on an unanswered
        // approval has turned "ask first" into "ask, then do it anyway".
        if (answer === null) {
          journal.record('unapproved', { tool: name, preview: line });
          return {
            text: 'Nobody answered, so this did not run. Do not retry it until they are back and say yes.',
            failed: true,
          };
        }
        if (!/allow/i.test(answer)) {
          journal.record('declined', { tool: name, preview: line, answer });
          return { text: 'the human declined. Do not retry without a new instruction from them.', failed: true };
        }
        if (/session/i.test(answer)) allowed.add(tool.name);
        journal.record('approved', { tool: name, preview: line, answer });
      }

      try {
        const result = await tool.run(args, contextFor(tool));
        journal.record('tool', { tool: name, args });
        return { text: typeof result === 'string' ? result : JSON.stringify(result, null, 2), failed: false };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        journal.record('tool.failed', { tool: name, args, error: message });
        return { text: message, failed: true };
      }
    },
  };
}
