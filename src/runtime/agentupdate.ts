import { journal } from './journal.ts';

/**
 * Agent Update (https://tryagentupdate.com) is how the agent reaches you when
 * you are not looking at the terminal: a line on your lock screen, a question
 * with tappable answers, a room where several agents and you can talk.
 *
 * It is optional. Without a token everything below no-ops and the agent simply
 * lives in your terminal instead.
 */
const BASE = process.env.AGENT_UPDATE_BASE ?? 'https://api.tryagentupdate.com';
const CURSOR = 'agentupdate.cursor';

export type Inbound = {
  id: string;
  role: 'user' | 'agent';
  body: string;
  from: string | null;
  room: { id: string; name: string } | null;
};

export type Room = { id: string; name: string };

/** Collections come back either bare or wrapped depending on the endpoint. */
const list = (result: any, key: string): any[] =>
  Array.isArray(result) ? result : Array.isArray(result?.[key]) ? result[key] : [];

/** whoami has moved shape before; take the name from wherever it is. */
export const nameOf = (whoami: any): string | null => whoami?.agent?.name ?? whoami?.name ?? null;

/** Their limit is 8000 characters a message. Leaves room for nothing clever. */
const LIMIT = 7_800;

/**
 * Split a long answer rather than shorten it. Truncating at 8000 loses the end
 * of a list silently, and silence at the end of a list is indistinguishable
 * from an agent that stopped early — which is the thing this runtime exists to
 * make impossible. Breaks where the text already breaks.
 */
export function chunks(text: string): string[] {
  if (text.length <= LIMIT) return [text];
  const parts: string[] = [];
  let rest = text;
  while (rest.length > LIMIT) {
    const window = rest.slice(0, LIMIT);
    // In preference order, not whichever lies furthest right — a space is nearly
    // always to the right of a paragraph break, so taking the maximum split "9."
    // from item nine's text and left the number stranded at the end of a message.
    const at =
      [window.lastIndexOf('\n\n'), window.lastIndexOf('\n'), window.lastIndexOf(' ')].find(
        (seam) => seam > LIMIT / 2,
      ) ?? LIMIT;
    parts.push(rest.slice(0, at).trim());
    rest = rest.slice(at).trim();
  }
  if (rest) parts.push(rest);
  return parts;
}

export class AgentUpdate {
  readonly enabled: boolean;
  private token: string;
  private backoffUntil = 0;

  constructor(token: string | undefined) {
    this.token = token ?? '';
    this.enabled = this.token.length > 0;
  }

  private async call(path: string, init: RequestInit = {}): Promise<any> {
    if (!this.enabled || Date.now() < this.backoffUntil) return null;
    try {
      const response = await fetch(`${BASE}${path}`, {
        ...init,
        headers: {
          Authorization: `Bearer ${this.token}`,
          'Content-Type': 'application/json',
          ...init.headers,
        },
        signal: AbortSignal.timeout(75_000),
      });
      if (response.status === 429 || response.status >= 500) {
        // Their limit is 60 messages/min. Backing off is cheaper than retrying.
        this.backoffUntil = Date.now() + 60_000;
        journal.record('agentupdate.backoff', { status: response.status });
        return null;
      }
      if (!response.ok) {
        journal.record('agentupdate.error', { path, status: response.status });
        return null;
      }
      return await response.json();
    } catch (error) {
      journal.record('agentupdate.error', { path, error: String(error) });
      return null;
    }
  }

  whoami = () => this.call('/v1/agent/whoami');

  /**
   * Outbound, and it does not give up quietly.
   *
   * `call` fails fast while a backoff is armed, which is right for polling — no
   * sense hammering a limit we are already over. It is wrong for an answer the
   * human is waiting on: one throttled poll would delete it, and he would see an
   * agent that said nothing. So this waits the backoff out instead. The nonce is
   * made once and reused, so a retry after a lost response is not a second copy.
   */
  private async deliver(path: string, body: Record<string, unknown>): Promise<any> {
    if (!this.enabled) return null;
    const payload = JSON.stringify({ ...body, nonce: crypto.randomUUID() });
    for (let attempt = 0; attempt < 4; attempt++) {
      const wait = this.backoffUntil - Date.now();
      if (wait > 0) await new Promise((resolve) => setTimeout(resolve, Math.min(wait, 65_000)));
      const result = await this.call(path, { method: 'POST', body: payload });
      if (result) return result;
      // No backoff armed means they refused it on the merits. Trying again with
      // the same body just spends another round trip on the same answer.
      if (Date.now() >= this.backoffUntil) return null;
    }
    return null;
  }

  /** False means it did not land, and somebody upstream has to say so. */
  send = async (text: string): Promise<boolean> => {
    for (const part of chunks(text)) {
      if (!(await this.deliver('/v1/agent/messages', { text: part }))) return false;
    }
    return this.enabled;
  };

  /**
   * Posts a question with tappable options. Returns its message id.
   *
   * Not chunked: the options ride on one message, and splitting would leave the
   * taps attached to a fragment. A question too long to fit is the agent's bug.
   */
  async ask(question: string, options?: string[]): Promise<string | null> {
    const result = await this.deliver('/v1/agent/messages', {
      text: question.slice(0, 8000),
      kind: 'question',
      ...(options?.length ? { options: options.slice(0, 6).map((o) => o.slice(0, 48)) } : {}),
    });
    return result?.id ?? null;
  }

  /** Long-poll a single question. Resolves to the answer text, or null on timeout. */
  async answer(messageId: string, waitSeconds = 55): Promise<string | null> {
    const result = await this.call(`/v1/agent/messages/${messageId}/answer?wait=${waitSeconds}`);
    return result?.answered ? (result.answer as string) : null;
  }

  rooms = async (): Promise<Room[]> => list(await this.call('/v1/agent/rooms'), 'rooms');

  sendRoom = async (roomId: string, text: string): Promise<boolean> => {
    for (const part of chunks(text)) {
      if (!(await this.deliver(`/v1/agent/rooms/${roomId}/messages`, { text: part }))) return false;
    }
    return this.enabled;
  };

  /**
   * Everything new since the stored cursor, oldest first. The caller decides
   * what to act on and calls `seen()` per message, so the cursor only advances
   * past work that actually happened — a crash mid-turn replays it.
   */
  async poll(): Promise<Inbound[]> {
    const after = journal.get(CURSOR);
    const result = await this.call(`/v1/agent/messages?limit=50${after ? `&after=${after}` : ''}`);
    return list(result, 'messages').map((m: any) => ({
      id: m.id,
      role: m.role === 'user' ? 'user' : 'agent',
      body: m.body ?? '',
      from: m.from?.name ?? null,
      room: m.room ? { id: m.room.id, name: m.room.name } : null,
    }));
  }

  seen(messageId: string) {
    journal.set(CURSOR, messageId);
  }
}
