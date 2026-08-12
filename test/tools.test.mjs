import assert from 'node:assert';
const D = new URL('../dist/agent/tools', import.meta.url).href;
const { fleet } = await import(`${D}/fleet.js`);
const { assignments, closeAssignment, delegate, followUp, heard } = await import(`${D}/work.js`);

const ago = (m) => new Date(Date.now() - m * 60_000).toISOString();

/** Journal-backed fake: note() appends, history() returns newest-first, like the real one. */
const makeCtx = (rooms = ROOMS) => {
  const events = [];
  const posted = [];
  return {
    events,
    posted,
    at: (minutesAgo, kind, data) => events.push({ at: ago(minutesAgo), kind, data }),
    rooms: { list: async () => rooms, send: async (id, text) => posted.push({ id, text }) },
    note: async (kind, data) => events.push({ at: new Date().toISOString(), kind, data }),
    history: async (limit, kind) =>
      events
        .filter((e) => !kind || e.kind === kind)
        .slice(-limit)
        .reverse(),
  };
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
  ctx.at(90, 'assignment', { event: 'opened', id: 'a1', agent: 'Librarian', room: 'r', roomId: 'r1', request: 'x', expectMinutes: 60 });
  ctx.at(90, 'assignment', { event: 'opened', id: 'a2', agent: 'Librarian', room: 'r', roomId: 'r1', request: 'y', expectMinutes: null });
  const list = await assignments.run({}, ctx);
  const a1 = list.open.find((a) => a.id === 'a1');
  const a2 = list.open.find((a) => a.id === 'a2');
  assert.equal(a1.overdue, true);
  assert.equal(a2.overdue, false, 'no expectation means unknown, not fine — and not late either');
  assert.deepEqual(list.overdue, ['a1']);
  assert.ok(a1.openedMinutesAgo >= 89);
  console.log('ok  overdue only when you said what to expect');
}

// 8. chasing resets the clock it is measured against
{
  const ctx = makeCtx();
  ctx.at(90, 'assignment', { event: 'opened', id: 'a1', agent: 'Librarian', room: 'r', roomId: 'r1', request: 'x', expectMinutes: 60 });
  ctx.at(5, 'assignment', { event: 'followed_up', id: 'a1', room: 'William & Librarian', roomId: 'r1' });
  const list = await assignments.run({}, ctx);
  assert.equal(list.open[0].overdue, false, 'just chased, so not overdue again yet');
  assert.equal(list.open[0].chases, 1);
  console.log('ok  a chase resets the overdue clock');
}

// 9. events whose assignment predates the lookback window are skipped, not fatal
{
  const ctx = makeCtx();
  ctx.at(10, 'assignment', { event: 'heard', id: 'ancient', text: 'orphan' });
  const list = await assignments.run({}, ctx);
  assert.equal(list.open.length, 0);
  console.log('ok  orphaned events do not crash the fold');
}

// 10. fleet reports live rooms with ages attached
{
  const ctx = makeCtx();
  ctx.at(14, 'assignment', { event: 'opened', id: 'a1', agent: 'Librarian', room: 'r', roomId: 'r1', request: 'x' });
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
