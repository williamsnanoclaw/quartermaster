import { connect, createServer } from 'node:net';
import { unlinkSync } from 'node:fs';
import { paths } from './workspace.ts';

/**
 * A unix socket between the tool server and the supervisor: one JSON request
 * per line, one JSON reply back.
 *
 * It carries only `tools.list` and `tools.call`. That matters — the tool server
 * runs as the same user as the agent's shell, so anything reachable here is
 * reachable by the agent directly. Since calling a tool through this socket is
 * exactly as gated as calling it through the model, the socket confers nothing.
 * Keep it that way: do not add a handler here that skips the gate.
 */
type Call = { id: string; method: string; params: unknown };
type Reply = { id: string; ok: boolean; value?: unknown; error?: string };

export type Handlers = Record<string, (params: any) => Promise<unknown>>;

/** Split a socket stream into whole lines, dropping anything unparseable. */
function lines(onLine: (line: string) => void) {
  let buffer = '';
  return (chunk: Buffer) => {
    buffer += chunk.toString();
    let cut: number;
    while ((cut = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, cut).trim();
      buffer = buffer.slice(cut + 1);
      if (line) onLine(line);
    }
  };
}

export function serve(handlers: Handlers) {
  try {
    unlinkSync(paths.socket);
  } catch {
    // No stale socket to clear.
  }

  const server = createServer((socket) => {
    // Dispatched, not awaited: a tool blocked on a human must not stall the
    // tool next to it in the same TCP chunk.
    const dispatch = async (call: Call) => {
      const handler = handlers[call.method];
      let reply: Reply;
      if (!handler) reply = { id: call.id, ok: false, error: `no such method: ${call.method}` };
      else {
        try {
          reply = { id: call.id, ok: true, value: await handler(call.params) };
        } catch (error) {
          reply = { id: call.id, ok: false, error: error instanceof Error ? error.message : String(error) };
        }
      }
      if (socket.writable) socket.write(`${JSON.stringify(reply)}\n`);
    };

    socket.on(
      'data',
      lines((line) => {
        try {
          void dispatch(JSON.parse(line) as Call);
        } catch {
          // Not our protocol. Dropping it is correct.
        }
      }),
    );
    socket.on('error', () => socket.destroy());
  });

  server.on('error', (error) => process.stderr.write(`bus: ${error.message}\n`));
  server.listen(paths.socket);
  return server;
}

export function client() {
  const pending = new Map<string, (reply: Reply) => void>();
  const socket = connect(paths.socket);
  socket.setNoDelay(true);

  const failAll = (message: string) => {
    for (const [id, resolve] of pending) resolve({ id, ok: false, error: message });
    pending.clear();
  };
  socket.on('error', (error) => failAll(error.message));
  socket.on('close', () => failAll('the supervisor closed the connection'));
  socket.on(
    'data',
    lines((line) => {
      try {
        const reply = JSON.parse(line) as Reply;
        pending.get(reply.id)?.(reply);
        pending.delete(reply.id);
      } catch {
        // Ignore anything that isn't a reply.
      }
    }),
  );

  return {
    /** Tool calls block here while a human decides. That is intentional. */
    call<T = unknown>(method: string, params: unknown = {}): Promise<T> {
      const id = crypto.randomUUID();
      return new Promise<T>((resolve, reject) => {
        pending.set(id, (reply) =>
          reply.ok ? resolve(reply.value as T) : reject(new Error(reply.error ?? 'call failed')),
        );
        socket.write(`${JSON.stringify({ id, method, params } satisfies Call)}\n`);
      });
    },
  };
}
