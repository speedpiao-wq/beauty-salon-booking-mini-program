const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const { createHarness, root } = require('./helpers/cloud-harness.cjs');

const day = '2026-10-01';
const day2 = '2026-10-02';
const day3 = '2026-10-03';
const iso = (date, time) => new Date(`${date}T${time}:00+08:00`).toISOString();
const id = openid => crypto.createHash('sha256').update(openid).digest('hex');
const appointment = (extra = {}) => ({
  _id: 'a1', status: 'confirmed', scheduledDate: day,
  startsAt: iso(day, '09:00'), endsAt: iso(day, '10:00'), reservedUntil: iso(day, '11:30'),
  customerName: '不应返回的姓名', contact: '13800000000', note: '不应返回的备注',
  customerOpenid: 'private-openid', serviceId: 'private-service', ...extra,
});
function fixtures(extra = {}) {
  return {
    admins: [
      { _id: id('founder'), role: 'super_admin', active: true },
      { _id: id('coowner'), role: 'owner', active: true },
      { _id: id('inactive'), role: 'owner', active: false },
    ],
    appointments: [],
    settings: [{ _id: 'system', primaryResourceId: 'room', customTimeStart: '09:00', customTimeEnd: '20:00' }],
    business_hours: Array.from({ length: 7 }, (_, weekday) => ({
      _id: 'weekday-' + weekday, weekday, enabled: true, openingSlots: ['09:30', '12:00', '15:00', '18:00'],
    })),
    schedule_blocks: [],
    ...extra,
  };
}

function loadUtility(name) {
  const scope = { module: { exports: {} }, Date };
  vm.runInNewContext(fs.readFileSync(path.join(root, 'miniprogram/utils', `${name}.js`), 'utf8'), scope);
  return scope.module.exports;
}

function plain(value) { return JSON.parse(JSON.stringify(value)); }

test('share date validation accepts exactly one to three strict calendar days', () => {
  const utility = loadUtility('share-schedule');
  assert.deepEqual(plain(utility.shareDates(day, day)), [day]);
  assert.deepEqual(plain(utility.shareDates(day, day2)), [day, day2]);
  assert.deepEqual(plain(utility.shareDates(day, day3)), [day, day2, day3]);
  for (const range of [[day, '2026-10-04'], [day2, day], ['2026-02-30', day], ['2026/10/01', day]]) {
    assert.throws(() => utility.shareDates(...range), /一次可分享1—3天/);
  }
  assert.equal(utility.addDays('2028-02-28', 1), '2028-02-29');
});

test('share normalization uses Beijing time, full reserved intervals and merges overlap or adjacency', () => {
  const utility = loadUtility('share-schedule');
  const result = plain(utility.normalizeShareSchedule([
    appointment({ _id: 'late', startsAt: iso(day, '11:00'), endsAt: iso(day, '12:00'), reservedUntil: iso(day, '13:00') }),
    appointment({ _id: 'early', startsAt: iso(day, '09:00'), endsAt: iso(day, '09:30'), reservedUntil: iso(day, '11:00') }),
    appointment({ _id: 'overlap', startsAt: iso(day, '12:30'), endsAt: iso(day, '13:00'), reservedUntil: iso(day, '14:30') }),
    appointment({ _id: 'next', scheduledDate: day2, startsAt: iso(day2, '15:00'), endsAt: iso(day2, '16:00'), reservedUntil: '' }),
  ], day, day3));
  assert.deepEqual(result.map(item => item.date), [day, day2, day3]);
  assert.deepEqual(result[0].intervals, [{ start: '09:00', end: '14:30', label: '09:00—14:30' }]);
  assert.deepEqual(result[1].intervals, [{ start: '15:00', end: '16:00', label: '15:00—16:00' }]);
  assert.deepEqual(result[2].intervals, []);
  assert.deepEqual(plain(utility.beijingParts('2026-09-30T16:30:00.000Z')), { date: day, time: '00:30', timestamp: 1790785800000 });
});

test('invalid and cross-date schedule intervals are ignored without removing empty dates', () => {
  const utility = loadUtility('share-schedule');
  const result = plain(utility.normalizeShareSchedule([
    { startsAt: 'bad', reservedUntil: iso(day, '11:00') },
    { startsAt: iso(day, '12:00'), reservedUntil: iso(day, '11:00') },
    { startsAt: iso(day, '23:30'), reservedUntil: iso(day2, '00:30') },
  ], day, day2));
  assert.deepEqual(result.map(item => item.intervals), [[], []]);
});

test('an empty day displays the explicit all-day booking message only when the cloud confirms it', () => {
  const utility = loadUtility('share-schedule');
  const open = plain(utility.normalizeShareSchedule([], day, day, [
    { date: day, allDayAvailable: true, hasAvailableTime: true },
  ]));
  assert.equal(open[0].emptyMessage, '全天都可以约～');
  assert.equal(open[0].allDayAvailable, true);

  const uncertain = plain(utility.normalizeShareSchedule([], day, day));
  assert.equal(uncertain[0].allDayAvailable, false);
  assert.match(uncertain[0].emptyMessage, /实时可约时间/);
});

test('share endpoint rejects missing, ordinary and inactive accounts before reading appointments', async () => {
  for (const openid of ['', 'stranger', 'inactive']) {
    const h = createHarness(fixtures({ appointments: [appointment()] }));
    const result = await h.function('ownerAppointments', openid)({ action: 'shareSchedule', startDate: day, endDate: day });
    assert.equal(result.code, openid ? 'OWNER_FORBIDDEN' : 'LOGIN_REQUIRED');
    assert.equal(h.reads.includes('appointments'), false);
  }
});

test('both owner roles receive confirmed occupied times only through a privacy whitelist', async () => {
  for (const openid of ['founder', 'coowner']) {
    const h = createHarness(fixtures({ appointments: [
      appointment(),
      appointment({ _id: 'fallback', startsAt: iso(day, '14:00'), endsAt: iso(day, '15:00'), reservedUntil: '' }),
      appointment({ _id: 'pending', status: 'pending', startsAt: iso(day, '16:00'), reservedUntil: iso(day, '17:00') }),
      appointment({ _id: 'cancelled', status: 'cancelled_by_customer', startsAt: iso(day, '18:00'), reservedUntil: iso(day, '19:00') }),
    ] }));
    const result = await h.function('ownerAppointments', openid)({ action: 'shareSchedule', startDate: day, endDate: day });
    assert.equal(result.ok, true);
    assert.equal(result.appointments.length, 2);
    assert.deepEqual(Object.keys(result.appointments[0]).sort(), ['reservedUntil', 'scheduledDate', 'startsAt']);
    assert.equal(result.appointments[0].reservedUntil, iso(day, '11:30'));
    assert.equal(result.appointments[1].reservedUntil, iso(day, '15:00'));
    assert.equal(JSON.stringify(result).includes('不应返回'), false);
    assert.equal(JSON.stringify(result).includes('private-'), false);
  }
});

test('an empty future day is shareable and is explicitly marked available all day', async () => {
  const futureDate = new Date(Date.now() + 8 * 60 * 60 * 1000 + 5 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const result = await createHarness(fixtures()).function('ownerAppointments')({
    action: 'shareSchedule', startDate: futureDate, endDate: futureDate,
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.appointments, []);
  assert.deepEqual(plain(result.dayAvailability), [{ date: futureDate, allDayAvailable: true, hasAvailableTime: true }]);
});

test('an empty day is not marked all-day available if it has a pending booking, rest block, or closed hours', async () => {
  const futureDate = new Date(Date.now() + 8 * 60 * 60 * 1000 + 5 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const startsAt = iso(futureDate, '10:00');
  const pending = await createHarness(fixtures({ appointments: [
    appointment({ status: 'pending', scheduledDate: futureDate, startsAt }),
  ] })).function('ownerAppointments')({ action: 'shareSchedule', startDate: futureDate, endDate: futureDate });
  assert.equal(pending.dayAvailability[0].allDayAvailable, false);

  const blocked = await createHarness(fixtures({ schedule_blocks: [{
    _id: 'rest', resourceId: 'room', active: true, startsAt: iso(futureDate, '12:00'), endsAt: iso(futureDate, '14:00'),
  }] })).function('ownerAppointments')({ action: 'shareSchedule', startDate: futureDate, endDate: futureDate });
  assert.equal(blocked.dayAvailability[0].allDayAvailable, false);

  const dateParts = futureDate.split('-').map(Number);
  const weekday = new Date(Date.UTC(dateParts[0], dateParts[1] - 1, dateParts[2])).getUTCDay();
  const hours = fixtures().business_hours.map(item => item.weekday === weekday ? { ...item, enabled: false } : item);
  const closed = await createHarness(fixtures({ business_hours: hours })).function('ownerAppointments')({
    action: 'shareSchedule', startDate: futureDate, endDate: futureDate,
  });
  assert.equal(closed.dayAvailability[0].allDayAvailable, false);
});

test('share endpoint enforces the three-day and one-hundred-record boundaries', async () => {
  const h = createHarness(fixtures({ appointments: Array.from({ length: 101 }, (_, index) => appointment({ _id: `a${index}`, startsAt: iso(day, '09:00') })) }));
  const main = h.function('ownerAppointments');
  assert.equal((await main({ action: 'shareSchedule', startDate: day, endDate: '2026-10-04' })).code, 'INVALID_SHARE_RANGE');
  assert.equal((await main({ action: 'shareSchedule', startDate: day2, endDate: day })).code, 'INVALID_SHARE_RANGE');
  assert.equal((await main({ action: 'shareSchedule', startDate: day, endDate: day })).code, 'SHARE_SCHEDULE_TOO_LARGE');
  const exact = createHarness(fixtures({ appointments: Array.from({ length: 100 }, (_, index) => appointment({ _id: `b${index}`, startsAt: iso(day, '09:00') })) }));
  assert.equal((await exact.function('ownerAppointments')({ action: 'shareSchedule', startDate: day, endDate: day })).appointments.length, 100);
});

function pageHarness() {
  let page;
  const requests = [];
  const previews = [];
  const scope = {
    Date, console,
    Page(config) { page = config; },
    require(dependency) { return loadUtility(path.basename(dependency)); },
    wx: {
      cloud: { callFunction(args) { return new Promise(resolve => requests.push({ args, resolve })); } },
      pageScrollTo() {}, showToast() {}, showModal() {}, stopPullDownRefresh() {},
      previewImage(options) { previews.push(options); },
    },
  };
  vm.runInNewContext(fs.readFileSync(path.join(root, 'miniprogram/pages/owner/index.js'), 'utf8'), scope);
  page.data = plain(page.data);
  page.setData = data => Object.assign(page.data, data);
  return { page, requests, previews };
}

test('share presets set safe ranges and changing a date clears an old poster', () => {
  const { page } = pageHarness();
  page.setData({ sharePosterPath: '/tmp/old.png', shareReady: true, shareSchedule: [{ date: day }] });
  page.selectSharePreset({ currentTarget: { dataset: { preset: 'threeDays' } } });
  const utility = loadUtility('share-schedule');
  assert.equal(page.data.shareEndDate, utility.addDays(page.data.shareStartDate, 2));
  assert.equal(page.data.sharePosterPath, '');
  assert.equal(page.data.shareReady, false);
  page.changeShareDate({ currentTarget: { dataset: { field: 'shareStartDate' } }, detail: { value: day } });
  assert.equal(page.data.sharePreset, 'custom');
  assert.equal(page.data.shareMaxEnd, day3);
});

test('a hidden owner page ignores a late share response and clears its temporary poster', async () => {
  const { page, requests } = pageHarness();
  page.setData({ isAdmin: true, shareStartDate: day, shareEndDate: day, sharePosterPath: '/tmp/private.png' });
  const pending = page.loadShareSchedule();
  page.onHide();
  requests[0].resolve({ result: { ok: true, appointments: [appointment()] } });
  await pending;
  assert.equal(page.data.shareReady, false);
  assert.equal(page.data.shareSchedule.length, 0);
  assert.equal(page.data.sharePosterPath, '');
});

test('schedule sharing uses the poster and customer home while invite sharing remains unchanged', () => {
  const { page } = pageHarness();
  page.setData({ inviteCode: 'XY-ABC', sharePosterPath: '/tmp/poster.png' });
  assert.deepEqual(plain(page.onShareAppMessage({ target: { dataset: { kind: 'schedule' } } })), {
    title: '秀亚美容馆 · 预约小提醒', path: '/pages/home/index', imageUrl: '/tmp/poster.png',
  });
  assert.deepEqual(plain(page.onShareAppMessage()), { title: '秀亚美容馆共同店主邀请', path: '/pages/owner/index?invite=XY-ABC' });
});

test('the owner share panel accepts an empty day and displays its all-day availability', async () => {
  const { page, requests } = pageHarness();
  page.setData({ isAdmin: true, shareStartDate: day, shareEndDate: day });
  const pending = page.loadShareSchedule();
  requests[0].resolve({ result: { ok: true, appointments: [], dayAvailability: [
    { date: day, allDayAvailable: true, hasAvailableTime: true },
  ] } });
  assert.equal(await pending, true);
  assert.equal(page.data.shareSchedule[0].emptyMessage, '全天都可以约～');
});

test('the generated cream poster emphasizes the all-day message when no appointments exist', () => {
  const { page } = pageHarness();
  const text = [];
  const context = {
    measureText(value) { return { width: String(value).length * 18 }; },
    clearRect() {}, fillRect() {}, beginPath() {}, arc() {}, fill() {}, stroke() {}, drawImage() {},
    moveTo() {}, arcTo() {}, closePath() {},
    fillText(value) { text.push(value); },
  };
  page.setData({
    shareRangeText: '10月1日 · 周四',
    shareSchedule: [{
      date: day, label: '10月1日 · 周四', intervals: [],
      allDayAvailable: true, hasAvailableTime: true, emptyMessage: '全天都可以约～',
    }],
  });
  page.drawSharePoster({ getContext: () => context }, {});
  assert.ok(text.includes('全天都可以约～'));
  assert.ok(text.includes('全天可约'));
});

test('the poster shortens a future empty-day availability note without hiding its meaning', () => {
  const { page } = pageHarness();
  const text = [];
  const context = {
    measureText(value) { return { width: String(value).length * 18 }; },
    clearRect() {}, fillRect() {}, beginPath() {}, arc() {}, fill() {}, stroke() {}, drawImage() {},
    moveTo() {}, arcTo() {}, closePath() {},
    fillText(value) { text.push(value); },
  };
  page.setData({
    shareRangeText: '9月27日 · 周日',
    shareSchedule: [{
      date: day, label: '9月27日 · 周日', intervals: [],
      allDayAvailable: false, hasAvailableTime: true,
      emptyMessage: '今天剩余时段可约，具体时间以小程序实时查询为准',
    }],
  });
  page.drawSharePoster({ getContext: () => context }, {});
  assert.ok(text.includes('这天还有空档可约～'));
  assert.ok(text.includes('空档以小程序实时显示为准'));
  assert.ok(!text.includes('今天剩余时段可约，具体时间以小程序实时查询为准'));
});

test('generated cream poster has clickable image and button preview handlers', () => {
  const { page, previews } = pageHarness();
  page.data.sharePosterPath = '/tmp/cream-poster.png';
  page.previewSharePoster();
  assert.deepEqual(plain(previews), [{ current: '/tmp/cream-poster.png', urls: ['/tmp/cream-poster.png'] }]);
  const wxml = fs.readFileSync(path.join(root, 'miniprogram/pages/owner/index.wxml'), 'utf8');
  const wxss = fs.readFileSync(path.join(root, 'miniprogram/pages/owner/index.wxss'), 'utf8');
  assert.ok(wxml.includes('class="share-poster-stage"'));
  assert.ok(wxml.includes('class="share-motion-flight"'));
  assert.ok(wxml.includes('class="share-motion-original" src="/assets/share-angel-cream.png"'));
  assert.ok(wxml.includes('class="share-motion-expression" src="/assets/share-angel-wink-closeup.png"'));
  assert.ok(wxml.includes('重播小天使动效'));
  assert.ok(wxss.includes('@keyframes shareAngelFlyIn'));
  assert.ok(wxss.includes('animation: shareAngelFlyIn 4.2s'));
  assert.ok(wxss.includes('left: 30%; top: 36.5%; width: 40%; height: 27%'));
  assert.ok(fs.existsSync(path.join(root, 'miniprogram/assets/share-angel-cream-speaking-compact.png')));
  assert.ok(fs.statSync(path.join(root, 'miniprogram/assets/share-angel-cream-speaking-compact.png')).size < 350 * 1024);
  assert.ok(fs.statSync(path.join(root, 'miniprogram/assets/share-angel-wink-closeup.png')).size < 200 * 1024);
  assert.match(wxml, /class=\"share-poster\"[^>]*bindtap=\"previewSharePoster\"/);
  assert.match(wxml, /class=\"mini-action secondary\" bindtap=\"previewSharePoster\">预览静态海报/);
});

test('owner share panel shows the approved booked-day GIF before a poster is generated', () => {
  const wxml = fs.readFileSync(path.join(root, 'miniprogram/pages/owner/index.wxml'), 'utf8');
  const previewIndex = wxml.indexOf('src=\"/assets/share-angel-booked-demo.gif\"');
  const posterResultIndex = wxml.indexOf('class=\"share-poster-result\"');
  assert.ok(previewIndex >= 0 && previewIndex < posterResultIndex);
  assert.ok(wxml.includes('已有预约 · 定稿动效'));
  assert.ok(wxml.includes('图中时段为演示内容'));
  assert.ok(wxml.includes('读取所选日期的真实预约时段'));
  assert.ok(wxml.includes('转发、保存到相册和发朋友圈使用的是静态海报 PNG'));
  assert.ok(wxml.includes('class=\"share-motion-original\" src=\"/assets/share-angel-cream.png\"'));
  assert.ok(wxml.includes('class=\"share-motion-flapping\" src=\"/assets/share-angel-flapping.gif\"'));
  const wxss = fs.readFileSync(path.join(root, 'miniprogram/pages/owner/index.wxss'), 'utf8');
  assert.ok(wxss.includes('.share-booked-demo-gif { display: block; width: 100%; height: auto; }'));
  const js = fs.readFileSync(path.join(root, 'miniprogram/pages/owner/index.js'), 'utf8');
  assert.ok(js.includes("'/assets/share-angel-cream-speaking-compact.png'"));
  assert.ok(js.includes('}, 4400);'), 'the poster animation overlay remains mounted through the final close-up');
  const gif = fs.readFileSync(path.join(root, 'miniprogram/assets/share-angel-flapping.gif'));
  assert.equal(gif.subarray(0, 6).toString('ascii'), 'GIF89a');
  assert.ok(gif.length < 400 * 1024, 'keep the animated preview small enough for the Mini Program package');
  const bookedDemo = fs.readFileSync(path.join(root, 'miniprogram/assets/share-angel-booked-demo.gif'));
  assert.equal(bookedDemo.subarray(0, 6).toString('ascii'), 'GIF89a');
  assert.ok(bookedDemo.length < 450 * 1024, 'keep the approved booked-day demo within the package budget');
});

test('the package excludes the unused full-resolution speaking source image', () => {
  const config = JSON.parse(fs.readFileSync(path.join(root, 'project.config.json'), 'utf8'));
  assert.ok(config.packOptions.ignore.some(item => item.type === 'file'
    && item.value === 'assets/share-angel-cream-speaking.png'));
});

test('Canvas 2D loads the bundled angel directly from its mini-program path', async () => {
  const { loadCanvasImage } = loadUtility('canvas-image');
  const image = { src: '', onload: null, onerror: null };
  const pending = loadCanvasImage({ createImage: () => image }, '/assets/share-angel-cream.png');
  assert.equal(image.src, '/assets/share-angel-cream.png');
  image.onload();
  assert.equal(await pending, image);
});

test('Canvas 2D reports a readable error when the bundled angel cannot load', async () => {
  const { loadCanvasImage } = loadUtility('canvas-image');
  const image = { src: '', onload: null, onerror: null };
  const pending = loadCanvasImage({ createImage: () => image }, '/assets/share-angel-cream.png');
  image.onerror();
  await assert.rejects(pending, /小天使素材读取失败/);
});

test('an old cloud function returns a clear share-interface update message', async () => {
  const { page, requests } = pageHarness();
  const pending = page.call('ownerAppointments', { action: 'shareSchedule' });
  requests[0].resolve({ result: { ok: false, code: 'UNKNOWN_ACTION', message: 'unknown' } });
  await assert.rejects(pending, /预约分享的云端接口尚未更新/);
});
