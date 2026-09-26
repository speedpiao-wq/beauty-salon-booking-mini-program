const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const { createHarness, root } = require('./helpers/cloud-harness.cjs');
const DEFAULT = '白兰偷懒,正在深度休息中~';
const day = new Date(Date.now() + 8 * 3600000 + 86400000).toISOString().slice(0, 10);
const nextDay = new Date(Date.parse(`${day}T00:00:00Z`) + 86400000).toISOString().slice(0, 10);
const iso = (time, date = day) => new Date(`${date}T${time}:00+08:00`).toISOString();
const id = openid => crypto.createHash('sha256').update(openid).digest('hex');
function fixtures(extra = {}) { return {
  admins: [{ _id: id('founder'), role: 'super_admin', active: true }, { _id: id('coowner'), role: 'owner', active: true }],
  settings: [{ _id: 'system', primaryResourceId: 'room', bookingWindowDays: 30 }],
  services: [{ _id: 's', name: '护理', active: true, durationMinutes: 60, bookingBlockMinutes: 150 }],
  business_hours: Array.from({ length: 7 }, (_, i) => ({ _id: `weekday-${i}`, enabled: true, openingSlots: ['09:00', '12:00', '20:00'] })),
  schedule_blocks: [], appointments: [], appointment_slots: [], ...extra,
}; }
const rest = (extra = {}) => ({ action: 'restCreate', requestId: 'rest-1', startDate: day, startTime: '10:00', endDate: day, endTime: '12:00', ...extra });
const booking = (extra = {}) => ({ requestId: 'booking-1', serviceId: 's', date: day, time: '09:00', customerName: '本地测试', ...extra });
const block = (extra = {}) => ({ _id: 'rest-old', resourceId: 'room', startsAt: iso('10:00'), endsAt: iso('12:00'), active: true, note: '', createdBy: 'PRIVATE_ADMIN', ...extra });

test('all rest actions reject non-owners, inactive admins and missing login without reading appointments', async () => {
  for (const openid of ['stranger', 'inactive', '']) {
    const h = createHarness(fixtures({ admins: [{ _id: id('inactive'), role: 'owner', active: false }] }));
    for (const action of ['restList', 'restCreate', 'restCancel']) {
      const result = await h.function('ownerAppointments', openid)({ ...rest(), action, blockId: 'rest-old' });
      assert.equal(result.code, openid ? 'OWNER_FORBIDDEN' : 'LOGIN_REQUIRED');
    }
    assert.equal(h.reads.includes('appointments'), false);
    assert.equal(h.data().schedule_blocks.length, 0);
  }
});

test('both owner roles can create, retry idempotently, list and soft-cancel a rest period', async () => {
  for (const actor of ['founder', 'coowner']) {
    const h = createHarness(fixtures()), main = h.function('ownerAppointments', actor);
    const created = await main(rest()); assert.equal(created.ok, true); assert.equal(created.block.message, DEFAULT);
    const retry = await main(rest()); assert.equal(retry.block.id, created.block.id);
    assert.equal(h.data().schedule_blocks.length, 1); assert.equal(h.data().audit_logs.length, 1);
    assert.equal((await main({ action: 'restList' })).blocks.length, 1);
    assert.equal((await main({ action: 'restCancel', blockId: created.block.id })).ok, true);
    await main({ action: 'restCancel', blockId: created.block.id });
    assert.equal(h.data().schedule_blocks.length, 1); assert.equal(h.data().schedule_blocks[0].active, false);
    assert.equal(h.data().audit_logs.length, 2); assert.equal((await main({ action: 'restList' })).blocks.length, 0);
    assert.equal(h.data().settings[0].calendarRevision, 2);
  }
});

test('invalid dates, reversed/equal times, oversized periods and missing request IDs do not write', async () => {
  const h = createHarness(fixtures()), main = h.function('ownerAppointments');
  for (const change of [{ startDate: '2027-02-30' }, { startTime: '24:00' }, { endTime: '10:00' }, { endTime: '09:59' }, { endDate: '2030-01-01' }, { requestId: '' }]) {
    assert.equal((await main(rest(change))).code, 'INVALID_REST_RANGE');
  }
  assert.equal(h.data().schedule_blocks.length, 0); assert.equal(h.data().settings[0].calendarRevision, undefined);
});

test('pending and confirmed reservations protect the full cleanup occupation; cancelled records do not', async () => {
  for (const status of ['pending', 'confirmed', 'cancelled_by_customer', 'cancelled_by_owner']) {
    const h = createHarness(fixtures({ appointments: [{ _id: 'existing', resourceId: 'room', status, startsAt: iso('09:00'), endsAt: iso('10:00'), reservedUntil: iso('11:30') }] }));
    const result = await h.function('ownerAppointments')(rest({ startTime: '10:30' }));
    assert.equal(result.ok, status.startsWith('cancelled_'));
    if (!result.ok) { assert.equal(result.code, 'REST_APPOINTMENT_CONFLICT'); assert.equal(h.data().schedule_blocks.length, 0); }
    assert.equal(h.data().appointments[0].status, status);
  }
});

test('overlapping rest is refused but adjacent rest boundaries are allowed', async () => {
  const h = createHarness(fixtures({ schedule_blocks: [block()] })), main = h.function('ownerAppointments');
  assert.equal((await main(rest())).code, 'REST_BLOCK_CONFLICT');
  assert.equal((await main(rest({ startTime: '12:00', endTime: '13:00' }))).ok, true);
});

test('availability and final submit return the exact default/custom public message and no booking', async () => {
  for (const note of ['', '  白兰去充电啦，下午见～  ']) {
    const h = createHarness(fixtures({ schedule_blocks: [block({ note })] }));
    const availability = await h.function('getAvailability')({ serviceId: 's', date: day, customTime: '09:00' });
    assert.equal(availability.slots[0].available, false); assert.equal(availability.slots[0].reason, note.trim() || DEFAULT);
    const result = await h.function('createBooking', 'customer')(booking());
    assert.equal(result.code, 'SCHEDULE_BLOCKED'); assert.equal(result.message, note.trim() || DEFAULT);
    assert.equal(h.data().appointments.length, 0); assert.equal(h.data().appointment_slots.length, 0);
  }
});

test('rest end/start boundaries are half-open, cleanup overlap blocks, inactive blocks do not', async () => {
  for (const [entry, time, allowed] of [
    [block(), '12:00', true], [block({ startsAt: iso('11:30') }), '09:00', true],
    [block({ startsAt: iso('11:29') }), '09:00', false], [block({ active: false }), '09:00', true],
  ]) {
    const h = createHarness(fixtures({ schedule_blocks: [entry] }));
    const availability = await h.function('getAvailability')({ serviceId: 's', date: day, customTime: time });
    const result = await h.function('createBooking', 'customer')(booking({ time }));
    assert.equal(availability.slots[0].available, allowed); assert.equal(result.ok, allowed);
  }
});

test('cross-midnight blocks cover cleanup after the inclusive 20:00 latest start', async () => {
  const h = createHarness(fixtures({ schedule_blocks: [block({ startsAt: iso('21:00'), endsAt: iso('09:00', nextDay) })] }));
  assert.equal((await h.function('createBooking', 'customer')(booking({ time: '20:00' }))).code, 'SCHEDULE_BLOCKED');
  const next = await h.function('getAvailability')({ serviceId: 's', date: nextDay, customTime: '09:00' });
  assert.equal(next.slots[0].available, true);
});

test('public notices whitelist time/message fields, exclude cancelled/expired blocks and survive a closed weekday', async () => {
  const h = createHarness(fixtures({ schedule_blocks: [block(), block({ _id: 'inactive', active: false }), block({ _id: 'expired', endsAt: new Date(0).toISOString() })],
    business_hours: Array.from({ length: 7 }, (_, i) => ({ _id: `weekday-${i}`, enabled: false })) }));
  const publicResult = await h.function('getBootstrap', 'customer')({ action: 'restNotices' });
  assert.equal(publicResult.restNotices.length, 1);
  assert.deepEqual(Object.keys(publicResult.restNotices[0]).sort(), ['endsAt', 'message', 'startsAt']);
  assert.equal(JSON.stringify(publicResult).includes('PRIVATE_ADMIN'), false);
  const availability = await h.function('getAvailability')({ serviceId: 's', date: day });
  assert.equal(availability.slots.length, 0); assert.equal(availability.restNotices.length, 1);
});

test('a failing audit write rolls back the rest block and shared revision', async () => {
  const h = createHarness(fixtures(), { failCollection: 'audit_logs' });
  assert.equal((await h.function('ownerAppointments')(rest())).ok, false);
  assert.equal(h.data().schedule_blocks.length, 0); assert.equal(h.data().settings[0].calendarRevision, undefined);
});

test('simultaneous booking and rest cannot both commit under per-document conflict/retry', async () => {
  for (const order of ['rest-first', 'booking-first']) {
    const h = createHarness(fixtures());
    const owner = h.function('ownerAppointments'), customer = h.function('createBooking', 'customer');
    const results = await Promise.all(order === 'rest-first' ? [owner(rest()), customer(booking())] : [customer(booking()), owner(rest())]);
    assert.equal(results.filter(result => result.ok).length, 1);
    assert.ok(h.stats.conflicts >= 1, 'a shared document write must force a retry');
    assert.equal(h.data().appointments.length + h.data().schedule_blocks.length, 1);
  }
});

function loadUtility(name) {
  const scope = { module: { exports: {} }, Date };
  vm.runInNewContext(fs.readFileSync(path.join(root, 'miniprogram/utils', `${name}.js`), 'utf8'), scope);
  return scope.module.exports;
}
function pageHarness(name) {
  let page; const requests = [], modals = [];
  const scope = { Date, console, Page(config) { page = config; }, require(dependency) { return loadUtility(path.basename(dependency)); },
    wx: { cloud: { callFunction(args) { return new Promise(resolve => requests.push({ args, resolve })); } },
      pageScrollTo() {}, showToast() {}, showModal(args) { modals.push(args); args.success?.({ confirm: true }); } } };
  vm.runInNewContext(fs.readFileSync(path.join(root, 'miniprogram/pages', name, 'index.js'), 'utf8'), scope);
  page.data = JSON.parse(JSON.stringify(page.data)); page.setData = data => Object.assign(page.data, data);
  return { page, requests, modals };
}
test('stale owner rest responses after hiding never restore private management state', async () => {
  const { page, requests } = pageHarness('owner'); page.setData({ isAdmin: true });
  const pending = page.loadRestBlocks(); page.onHide();
  requests[0].resolve({ result: { ok: true, blocks: [{ ...block(), id: 'old' }] } }); await pending;
  assert.equal(page.data.restBlocks.length, 0); assert.equal(page.data.restReady, false);
});

test('a new rest created while customer is on submit screen returns to time selection and displays the remark', async () => {
  const { page, requests, modals } = pageHarness('booking');
  page.availabilityVersion = 0; page.unloaded = false;
  page.setData({ step: 2, selectedService: { _id: 's' }, selectedServiceId: 's', selectedDate: day, selectedTime: '09:00', customerName: '本地测试', requestId: 'id' });
  const pending = page.submitBooking();
  requests[0].resolve({ result: { ok: false, code: 'SCHEDULE_BLOCKED', message: '休息一下，明天见～' } });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(requests[1].args.name, 'getAvailability');
  requests[1].resolve({ result: { ok: true, restNotices: [{ ...block(), message: '休息一下，明天见～' }], slots: [{ time: '09:00', available: false, reason: '休息一下，明天见～' }] } });
  await pending;
  assert.equal(page.data.step, 1); assert.equal(page.data.selectedTime, '');
  assert.equal(modals[0].content, '休息一下，明天见～'); assert.equal(page.data.submitting, false);
});

test('notice formatting uses Beijing dates, default text and filters expired ranges', () => {
  const utility = loadUtility('rest-notices');
  assert.equal(utility.beijingDateTime('2026-09-15T16:00:00Z'), '2026-09-16 00:00');
  assert.equal(utility.decorateRestNotices([{ startsAt: iso('10:00'), endsAt: iso('12:00') }])[0].message, DEFAULT);
  assert.equal(utility.decorateRestNotices([{ startsAt: iso('10:00'), endsAt: iso('12:00') }], Date.parse(iso('12:00'))).length, 0);
});
