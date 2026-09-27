const test = require('node:test');
const assert = require('node:assert/strict');
const { motionAt } = require('../cloudfunctions/sharePosterVideo/render');

test('both stories start at the original upper-left icon and move towards distinct, intended targets', () => {
  const emptyStart = motionAt(0, 'empty');
  const bookedStart = motionAt(0, 'booked');
  assert.deepEqual([emptyStart.left, emptyStart.top, emptyStart.width], [22, 24, 40]);
  assert.deepEqual([bookedStart.left, bookedStart.top, bookedStart.width], [22, 24, 29]);

  const emptyEnd = motionAt(120, 'empty');
  const bookedEnd = motionAt(120, 'booked');
  assert.deepEqual([emptyEnd.left, emptyEnd.top, emptyEnd.width], [208, 555, 125]);
  assert.deepEqual([bookedEnd.left, bookedEnd.top, bookedEnd.width], [67, 343, 107]);
  assert.ok(bookedEnd.top > 200, 'booked angel must land beside the B-layout appointment times');
  assert.ok(bookedEnd.left < 80, 'booked angel stays in the B-layout board margin');
  assert.ok(bookedEnd.width < emptyEnd.width, 'booked angel remains smaller than the empty-day angel');

  const multiDayBookedEnd = motionAt(120, 'booked', 3);
  const multiDayEmptyEnd = motionAt(120, 'empty', 3);
  assert.deepEqual([multiDayBookedEnd.left, multiDayBookedEnd.top, multiDayBookedEnd.width], [46, 300, 70]);
  assert.deepEqual([multiDayEmptyEnd.left, multiDayEmptyEnd.top, multiDayEmptyEnd.width], [230, 613, 81]);
});

test('booked angel taps the board twice after landing', () => {
  assert.equal(motionAt(76, 'booked').knock, 0);
  assert.ok(motionAt(87, 'booked').knock > 0);
  assert.equal(motionAt(92, 'booked').knock, 0);
  assert.ok(motionAt(100, 'booked').knock > 0);
  assert.equal(motionAt(106, 'booked').knock, 0);
});
