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

  send = (text: string) =>
    this.call('/v1/agent/messages', {
      method: 'POST',
      body: JSON.stringify({ text: text.slice(0, 8000), nonce: crypto.randomUUID() }),
    });

  /** Posts a question with tappable options. Returns its message id. */
  async ask(question: string, options?: string[]): Promise<string | null> {
    const result = await this.call('/v1/agent/messages', {
      method: 'POST',
      body: JSON.stringify({
        text: question.slice(0, 8000),
        kind: 'question',
        nonce: crypto.randomUUID(),
        ...(options?.length ? { options: options.slice(0, 6).map((o) => o.slice(0, 48)) } : {}),
      }),
    });
    return result?.id ?? null;
  }

  /** Long-poll a single question. Resolves to the answer text, or null on timeout. */
  async answer(messageId: string, waitSeconds = 55): Promise<string | null> {
    const result = await this.call(`/v1/agent/messages/${messageId}/answer?wait=${waitSeconds}`);
    return result?.answered ? (result.answer as string) : null;
  }

  rooms = async (): Promise<Room[]> => list(await this.call('/v1/agent/rooms'), 'rooms');

  sendRoom = (roomId: string, text: string) =>
    this.call(`/v1/agent/rooms/${roomId}/messages`, {
      method: 'POST',
      body: JSON.stringify({ text: text.slice(0, 8000), nonce: crypto.randomUUID() }),
    });

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
