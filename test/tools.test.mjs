import assert from 'node:assert';
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

console.log('\nall passed');
