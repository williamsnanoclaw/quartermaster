import assert from 'node:assert';
import { mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Runtime modules open the journal at import time, against a path that only
// exists inside the container. Point them at scratch so a test can import one
// without a Docker daemon in the way. Must run before any of them load.
const scratch = mkdtempSync(join(tmpdir(), 'temper-test-'));
mkdirSync(join(scratch, '.quartermaster'), { recursive: true });
process.env.TEMPER_WORKSPACE = scratch;

const D = new URL('../dist/agent/tools', import.meta.url).href;
const { fleet } = await import(`${D}/fleet.js`);
const { assignments, closeAssignment, delegate, followUp, heard } = await import(`${D}/work.js`);

const ago = (m) => new Date(Date.now() - m * 60_000).toISOString();

/**
 * Journal-backed fake. Two things here are not decoration, they are the test:
 *
 *   - `note` writes `agent.<kind>` and `history` matches the kind exactly,
 *     because that is what src/runtime/tools.ts does. A fake that stored the
 *     bare kind made an entirely write-only subsystem pass every test.
 *   - `send` returns a truthy body on success and null on failure, because
 *     Agent Update reports a dead room by returning nothing at all.
 */
const makeCtx = (rooms = ROOMS) => {
  const events = [];
  const posted = [];
  const ctx = {
    events,
    posted,
    /** Flip to null to make every send fail the way a dead room does. */
    sendResult: { ok: true },
    /** A runtime-written event: journal.record, no prefix (e.g. room.heard). */
    at: (minutesAgo, kind, data) => events.push({ at: ago(minutesAgo), kind, data }),
    /** A tool-written event: ctx.note, which prefixes. */
    noted: (minutesAgo, kind, data) => events.push({ at: ago(minutesAgo), kind: `agent.${kind}`, data }),
    rooms: {
      list: async () => rooms,
      send: async (id, text) => {
        posted.push({ id, text });
        return ctx.sendResult;
      },
    },
    note: async (kind, data) => events.push({ at: new Date().toISOString(), kind: `agent.${kind}`, data }),
    history: async (limit, kind) =>
      events
        .filter((e) => !kind || e.kind === kind)
        .slice(-limit)
        .reverse(),
  };
  return ctx;
};

const ROOMS = [
  { id: 'r1', name: 'William & Librarian' },
  { id: 'r2', name: 'ops', members: [{ name: 'My Busy Bee' }, { name: 'William' }] },
];

// 1. delegate posts and opens an assignment that shows up as open
{
  const ctx = makeCtx();
  const out = await delegate.run({ agent: 'Librarian', request: 'check my email', expect_within_minutes: 60 }, ctx);
  assert.equal(out.ok, true);
  assert.deepEqual(ctx.posted, [{ id: 'r1', text: 'check my email' }]);

  const list = await assignments.run({}, ctx);
  assert.equal(list.open.length, 1);
  assert.equal(list.open[0].id, out.id);
  assert.equal(list.open[0].agent, 'Librarian');
  assert.equal(list.open[0].heardAnything, false);
  assert.equal(list.open[0].overdue, false);
  console.log('ok  delegate opens a tracked assignment and posts it');
}

// 2. unresolvable agent opens nothing — a dropped request must not look tracked
{
  const ctx = makeCtx();
  const out = await delegate.run({ agent: 'Scheduler', request: 'do a thing' }, ctx);
  assert.equal(out.ok, false);
  assert.equal(ctx.posted.length, 0);
  assert.equal((await assignments.run({}, ctx)).open.length, 0);
  console.log('ok  unresolved agent: nothing posted, nothing left looking tracked');
}

// 3. the fold replays oldest-first even though history is newest-first
{
  const ctx = makeCtx();
  const { id } = await delegate.run({ agent: 'Librarian', request: 'check my email' }, ctx);
  await heard.run({ id, what_they_said: 'starting now' }, ctx);
  await heard.run({ id, what_they_said: '12 unread, 2 need you' }, ctx);
  const list = await assignments.run({}, ctx);
  assert.deepEqual(list.open[0].heard, ['starting now', '12 unread, 2 need you'], 'replies must keep their order');
  assert.equal(list.open[0].heardAnything, true);
  console.log('ok  fold replays in the order things happened');
}

// 4. closing removes it from open; done is recorded
{
  const ctx = makeCtx();
  const { id } = await delegate.run({ agent: 'Librarian', request: 'check my email' }, ctx);
  await closeAssignment.run({ id, outcome: 'triaged, 2 escalated', done: true }, ctx);
  const list = await assignments.run({ include_closed: true }, ctx);
  assert.equal(list.open.length, 0);
  assert.equal(list.closed.length, 1);
  assert.equal(list.closed[0].closed.done, true);
  console.log('ok  close_assignment closes it and keeps the outcome');
}

// 5. acting on an id that isn't open hands back what is, rather than just failing
{
  const ctx = makeCtx();
  const { id } = await delegate.run({ agent: 'Librarian', request: 'check my email' }, ctx);
  const out = await followUp.run({ id: 'nope', message: 'hi' }, ctx);
  assert.equal(out.ok, false);
  assert.equal(out.open[0].id, id);
  assert.equal(ctx.posted.length, 1, 'nothing extra posted');
  console.log('ok  unknown id returns the open assignments to work from');
}

// 6. a room re-made in the app repairs itself on follow_up
{
  const ctx = makeCtx();
  const { id } = await delegate.run({ agent: 'Librarian', request: 'check my email' }, ctx);
  ctx.rooms.list = async () => [{ id: 'r1-NEW', name: 'William & Librarian' }]; // re-made room, new id
  const out = await followUp.run({ id, message: 'any update?' }, ctx);
  assert.equal(out.ok, true);
  assert.equal(out.reboundFrom, 'r1', 'the stale binding is reported, not silently swallowed');
  assert.equal(ctx.posted.at(-1).id, 'r1-NEW', 'posted to the room that exists now');
  console.log('ok  stale room id repairs itself and says so');
}

// 7. overdue needs an expectation; silence alone is not lateness
{
  const ctx = makeCtx();
  ctx.noted(90, 'assignment', { event: 'opened', id: 'a1', agent: 'Librarian', room: 'r', roomId: 'r1', request: 'x', expectMinutes: 60 });
  ctx.noted(90, 'assignment', { event: 'opened', id: 'a2', agent: 'Librarian', room: 'r', roomId: 'r1', request: 'y', expectMinutes: null });
  const list = await assignments.run({}, ctx);
  const a1 = list.open.find((a) => a.id === 'a1');
  const a2 = list.open.find((a) => a.id === 'a2');
  assert.equal(a1.overdue, true);
  assert.equal(a2.overdue, false, 'no expectation means unknown, not fine — and not late either');
  assert.deepEqual(list.overdue, ['a1']);
  assert.ok(a1.openedMinutesAgo >= 89);
  console.log('ok  overdue only when you said what to expect');
}

// 8. chasing must NOT clear overdue — otherwise nudging a dead agent makes it
//    look healthier the more you nudge, and it never reads as late at all
{
  const ctx = makeCtx();
  ctx.noted(90, 'assignment', { event: 'opened', id: 'a1', agent: 'Librarian', room: 'r', roomId: 'r1', request: 'x', expectMinutes: 60 });
  ctx.noted(5, 'assignment', { event: 'followed_up', id: 'a1', agent: 'Librarian', room: 'William & Librarian', roomId: 'r1' });
  const list = await assignments.run({}, ctx);
  assert.equal(list.open[0].overdue, true, 'their silence is 90m; our chase 5m ago does not answer for them');
  assert.ok(list.open[0].silentForMinutes >= 89, 'silence is measured from them, not from us');
  assert.equal(list.open[0].chases, 1);
  assert.ok(list.open[0].lastChasedMinutesAgo <= 6, 'but the agent can still see it just chased');
  console.log('ok  a chase does not launder a dead agent into a healthy one');
}

// 8b. hearing from them is what stops the silence clock
{
  const ctx = makeCtx();
  ctx.noted(90, 'assignment', { event: 'opened', id: 'a1', agent: 'Librarian', room: 'r', roomId: 'r1', request: 'x', expectMinutes: 60 });
  ctx.noted(2, 'assignment', { event: 'heard', id: 'a1', text: 'on it' });
  const list = await assignments.run({}, ctx);
  assert.equal(list.open[0].overdue, false);
  assert.ok(list.open[0].silentForMinutes <= 3);
  console.log('ok  hearing from them stops the silence clock');
}

// 9. events whose assignment predates the lookback window are skipped, not fatal
{
  const ctx = makeCtx();
  ctx.noted(10, 'assignment', { event: 'heard', id: 'ancient', text: 'orphan' });
  const list = await assignments.run({}, ctx);
  assert.equal(list.open.length, 0);
  console.log('ok  orphaned events do not crash the fold');
}

// 9b. a full journal window is reported, never read as "nothing outstanding"
{
  const ctx = makeCtx();
  for (let i = 0; i < 200; i += 1) ctx.noted(30, 'assignment', { event: 'heard', id: `old-${i}`, text: 'x' });
  const list = await assignments.run({}, ctx);
  assert.equal(list.open.length, 0);
  assert.equal(list.incomplete, true, 'an empty list off a saturated window must not read as clean');
  assert.match(list.incompleteWhy, /not everything/);
  console.log('ok  a truncated view says so instead of looking empty');
}

// 9c. a small window stays silent — the warning has to mean something
{
  const ctx = makeCtx();
  await delegate.run({ agent: 'Librarian', request: 'check my email' }, ctx);
  const list = await assignments.run({}, ctx);
  assert.equal(list.incomplete, undefined);
  console.log('ok  no false alarm when the window is not full');
}

// 9d. a send that never landed must not become a tracked assignment
{
  const ctx = makeCtx();
  ctx.sendResult = null; // Agent Update reports a dead room by returning nothing
  const out = await delegate.run({ agent: 'Librarian', request: 'check my email' }, ctx);
  assert.equal(out.ok, false);
  assert.match(out.reason, /did not go through/);
  const list = await assignments.run({}, ctx);
  assert.equal(list.open.length, 0, 'an undelivered request must not look asked-for');
  console.log('ok  an undelivered send is not reported as sent');
}

// 9e. a failed chase leaves the assignment untouched rather than logging a chase
{
  const ctx = makeCtx();
  const { id } = await delegate.run({ agent: 'Librarian', request: 'check my email' }, ctx);
  ctx.sendResult = null;
  const out = await followUp.run({ id, message: 'any update?' }, ctx);
  assert.equal(out.ok, false);
  const list = await assignments.run({}, ctx);
  assert.equal(list.open[0].chases, 0, 'a chase that never arrived is not a chase');
  console.log('ok  a failed follow_up does not record itself as delivered');
}

// 9f. names match on word boundaries, so work never lands on the wrong agent
{
  const ctx = makeCtx([
    { id: 'r1', name: 'William & Bee' },
    { id: 'r2', name: 'William & Beekeeper' },
  ]);
  const exact = await delegate.run({ agent: 'Bee', request: 'x' }, ctx);
  assert.equal(exact.ok, true);
  assert.equal(exact.room, 'William & Bee', 'Bee must not also match Beekeeper');
  const ambiguous = await delegate.run({ agent: 'William', request: 'y' }, ctx);
  assert.equal(ambiguous.ok, false, 'a name in every room is too ambiguous to post to');
  console.log('ok  agent names match whole words, and ambiguity refuses to guess');
}

// 10. fleet reports live rooms with ages attached
{
  const ctx = makeCtx();
  ctx.noted(14, 'assignment', { event: 'opened', id: 'a1', agent: 'Librarian', room: 'r', roomId: 'r1', request: 'x' });
  ctx.at(65, 'room.heard', { from: 'Librarian' });
  const out = await fleet.run({}, ctx);
  const lib = out.rooms.find((r) => r.id === 'r1');
  assert.equal(lib.lastSent.minutesAgo, 14);
  assert.equal(lib.lastHeard.minutesAgo, 65);
  assert.equal(out.rooms.find((r) => r.id === 'r2').lastSent, null);
  console.log('ok  fleet: live rooms, ages attached, unknown stays null');
}

// 11. no rooms is flagged rather than reported as a healthy empty fleet
{
  const out = await fleet.run({}, makeCtx([]));
  assert.match(out.note, /No rooms/);
  console.log('ok  empty fleet is flagged, not reported as fine');
}

// 12. a failed turn is sorted into what to do about it, not just reported.
//     The capacity string is Codex's own, verbatim — a turn died on it in
//     production and took the human's message with it.
{
  const R = new URL('../dist/src/runtime', import.meta.url).href;
  const { isAuthFailure, isCapacity, isTransient } = await import(`${R}/codex.js`);
  const capacity = 'Selected model is at capacity. Please try a different model.';

  assert.equal(isCapacity(capacity), true);
  assert.equal(isTransient(capacity), false, 'capacity must not be retried on the same model');
  assert.equal(isAuthFailure(capacity), false);
  assert.equal(isCapacity('no such file or directory'), false);

  assert.equal(isTransient('request timed out'), true);
  assert.equal(isTransient('upstream returned 503'), true);
  assert.equal(isTransient('the model declined to answer'), false, 'a real refusal is not a blip');
  assert.equal(isAuthFailure('401 unauthorized'), true);
  console.log('ok  a full model, a stale token and a blip are told apart');
}

// 13. stepping aside actually moves, and moves back if the other one is full too
{
  const R = new URL('../dist/src/runtime', import.meta.url).href;
  delete process.env.TEMPER_MODEL; // no /app/agent/codex.toml out here; the pair decides
  const { model } = await import(`${R}/codex.js`);

  assert.equal(model.current(), 'gpt-5.6-terra', 'terra is the one it prefers');
  assert.deepEqual(model.stepAside(), { from: 'gpt-5.6-terra', to: 'gpt-5.6-luna' });
  assert.equal(model.current(), 'gpt-5.6-luna', 'the step has to stick, or the next turn is full again');
  assert.deepEqual(model.stepAside(), { from: 'gpt-5.6-luna', to: 'gpt-5.6-terra' });
  assert.ok(!model.current().includes('sol'), 'sol is not one of the two');
  console.log('ok  a full model steps to the other one and stays there');
}

// 14. a long answer is split, not shortened — the bug that ate a 16-item list
{
  const R = new URL('../dist/src/runtime', import.meta.url).href;
  const { chunks } = await import(`${R}/agentupdate.js`);

  assert.deepEqual(chunks('short'), ['short'], 'anything that fits is left alone');

  const items = Array.from({ length: 16 }, (_, i) => `${i + 1}. ${'x'.repeat(900)}`);
  const parts = chunks(items.join('\n\n'));

  assert.ok(parts.length > 1, 'a 14k answer has to become more than one message');
  for (const part of parts) assert.ok(part.length <= 7_800, 'no part may exceed what the API takes');
  for (let n = 1; n <= 16; n++) {
    const hits = parts.filter((p) => p.includes(`\n${n}. `) || p.startsWith(`${n}. `)).length;
    assert.equal(hits, 1, `item ${n} must survive exactly once — truncation lost the tail of the list`);
  }
  console.log('ok  a long answer is split across messages, and no item is lost');
}

// 15. the newest message renders even when it is taller than the screen
{
  const U = new URL('../dist/src/ui', import.meta.url).href;
  const { fit } = await import(`${U}/app.js`);

  const msg = (id, text) => ({ key: id, kind: 'msg', msg: { id, role: 'agent', text, source: 'terminal', at: 0 } });
  const tall = msg('long', Array.from({ length: 40 }, (_, i) => `${i + 1}. a line of the answer`).join('\n'));

  const shown = fit([msg('a', 'earlier'), tall], 72, 12);
  assert.ok(shown.length > 0, 'a reply taller than the budget used to render an empty screen');
  assert.equal(shown[shown.length - 1].msg.text.includes('40. a line of the answer'), true, 'keep the tail');
  assert.ok(/earlier line/.test(shown[shown.length - 1].msg.text), 'and say how much is hidden');

  const small = fit([msg('a', 'one'), msg('b', 'two')], 72, 12);
  assert.deepEqual(small.map((e) => e.key), ['a', 'b'], 'entries that fit are untouched');
  console.log('ok  a reply too tall for the terminal is trimmed, never blanked');
}

// the dashboard never sends Ink looking for the terminal size
{
  const U = new URL('../dist/src/ui', import.meta.url).href;
  const { pinSize } = await import(`${U}/app.js`);

  // Ink calls getWindowSize(stdout) on every render. When the stream cannot
  // answer, terminal-size opens /dev/tty and never closes it, so a dashboard
  // that redraws once a second leaks a file descriptor a second until the host
  // hits the heap limit — and the container goes down with the host.
  for (const blank of [{}, { columns: 0, rows: 0 }, { columns: undefined, rows: undefined }]) {
    const stream = pinSize(blank);
    assert.ok(stream.columns > 0, 'a stream with no width must be given one');
    assert.ok(stream.rows > 0, 'a stream with no height must be given one');
  }

  const real = pinSize({ columns: 143, rows: 47 });
  assert.deepEqual([real.columns, real.rows], [143, 47], 'a terminal that knows its own size is left alone');
  console.log('ok  the terminal always reports a size, so Ink never goes hunting for one');
}

// the CLI must decide which React it gets before React is loaded
{
  const cli = readFileSync(new URL('../dist/src/cli.js', import.meta.url), 'utf8');
  assert.ok(/process\.env\.NODE_ENV \?\?=/.test(cli), 'the NODE_ENV guard is gone');

  // Static imports are hoisted, so they run before the guard whatever order
  // they are written in. React's development build reports every render to the
  // Performance Track, Node buffers those entries for the life of the process,
  // and a dashboard that redraws once a second then dies of the heap limit
  // about 35 hours in — twice, in production. Anything that reaches React has
  // to be imported where it is used, not at the top of the file.
  const hoisted = [...cli.matchAll(/^import\s[^\n]*?from\s*['"]([^'"]+)['"]/gm)].map((m) => m[1]);
  for (const spec of hoisted) {
    assert.ok(
      !/^(ink|react)(\/|$)/.test(spec) && !/(ui\/app|onboarding)/.test(spec),
      `${spec} is imported at the top of cli.js, so React loads before NODE_ENV is set`,
    );
  }
  console.log('ok  React is not loaded before the CLI decides which build it wants');
}

console.log('\nall passed');
