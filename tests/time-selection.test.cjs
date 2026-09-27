const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const base = path.resolve(__dirname, '../miniprogram');
function loadUtility(name = 'appointment-time') {
  const scope = { module: {exports: {}}, Date };
  vm.runInNewContext(fs.readFileSync(path.join(base, `utils/${name}.js`), 'utf8'), scope);
  return scope.module.exports;
}
function loadHistoryRangeUtility() {
  const scope = { module: {exports: {}}, Date };
  vm.runInNewContext(fs.readFileSync(path.join(base, 'utils/history-range.js'), 'utf8'), scope);
  return scope.module.exports;
}
function pageHarness() {
  let page;
  const requests = [];
  const scope = {
    require: name => name.endsWith('catalog-cache') ? { getCatalog: () => null, saveCatalog() {} } : name.endsWith('rest-notices') ? loadUtility('rest-notices') : loadUtility(), Page: config => { page = config; },
    wx: { cloud: { callFunction: args => new Promise(resolve => requests.push({args, resolve})) }, pageScrollTo() {} },
  };
  vm.runInNewContext(fs.readFileSync(path.join(base, 'pages/booking/index.js'), 'utf8'), scope);
  page.data = JSON.parse(JSON.stringify(page.data));
  page.setData = data => Object.assign(page.data, data);
  page.availabilityVersion = 0;
  page.unloaded = false;
  Object.assign(page.data, {selectedService:{_id:'basic-care'},selectedServiceId:'basic-care',selectedDate:'2026-09-11',requestId:'test-request'});
  return {page, requests};
}
function homePageHarness() {
  let page;
  const scope = {
    Page: config => { page = config; },
    require: () => ({ saveCatalog() {} }),
    wx: {
      cloud: { callFunction() {} },
      stopPullDownRefresh() {},
      showModal() {},
      navigateTo() {},
    },
    console,
  };
  vm.runInNewContext(fs.readFileSync(path.join(base, 'pages/home/index.js'), 'utf8'), scope);
  return page;
}
function loadCloudFunction(relativePath) {
  const scope = {
    exports: {},
    console,
    Date,
    require: name => {
      if (name === 'crypto') return require('node:crypto');
      if (name === 'wx-server-sdk') {
        return {
          DYNAMIC_CURRENT_ENV: 'test',
          init() {},
          database: () => ({command: {}}),
        };
      }
      throw new Error(`Unexpected dependency: ${name}`);
    },
  };
  vm.runInNewContext(fs.readFileSync(path.resolve(__dirname, relativePath), 'utf8'), scope);
  return scope;
}
test('morning offers 09-12 and afternoon offers 13-20 in 24-hour time', () => {
  const {hoursForPeriod,to24Hour} = loadUtility();
  assert.deepEqual([...hoursForPeriod(0)],['09','10','11','12']);
  assert.deepEqual([...hoursForPeriod(1)],['13','14','15','16','17','18','19','20']);
  assert.equal(to24Hour(0,0,0),'09:00');
  assert.equal(to24Hour(0,3,59),'12:59');
  assert.equal(to24Hour(1,0,0),'13:00');
  assert.equal(to24Hour(1,1,10),'14:10');
});
test('Beijing date boundary and next whole hour always start at minute 00', () => {
  const {makeDates,makeInitialSelection,to24Hour} = loadUtility();
  const now = Date.parse('2026-09-10T16:01:00Z');
  assert.equal(makeDates(now)[0].value,'2026-09-11');
  const late = makeInitialSelection(Date.parse('2026-09-10T11:10:00Z'));
  assert.equal(late.dayOffset,1);
  assert.equal(late.minuteIndex,0);
  assert.equal(to24Hour(late.periodIndex,late.hourIndex,late.minuteIndex),'09:00');
});
test('out-of-order availability responses cannot restore an older selected time', async () => {
  const {page, requests} = pageHarness();
  const first = page.checkAvailability();
  page.data.minuteIndex = 10;
  const second = page.checkAvailability();
  requests[1].resolve({result:{ok:true,slots:[{time:'14:10',available:true}]}});
  await second;
  requests[0].resolve({result:{ok:true,slots:[{time:'14:00',available:false,reason:'已占用'}]}});
  await first;
  assert.equal(page.data.selectedTime,'14:10');
  assert.equal(page.data.timeStatus,'available');
  assert.equal(page.data.loadingSlots,false);
});
test('unavailable time disables selection and next step; no create request is sent', async () => {
  const {page, requests} = pageHarness();
  const check = page.checkAvailability();
  requests[0].resolve({result:{ok:true,slots:[{time:'14:00',available:false,reason:'已占用'}]}});
  await check;
  assert.equal(page.data.selectedTime,'');
  await page.nextStep();
  assert.equal(page.data.step,1);
  assert.equal(requests.length,1);
});
test('booking error stays visible and retry preserves the same request ID', async () => {
  const {page, requests} = pageHarness();
  Object.assign(page.data,{step:2,selectedTime:'14:10',customerName:'界面测试'});
  const submit = page.submitBooking();
  requests[0].resolve({result:{ok:false,code:'CREATE_FAILED',message:'暂时未能保存'}});
  await submit;
  assert.equal(page.data.step,2);
  assert.equal(page.data.error,'暂时未能保存');
  const retry = page.submitBooking();
  assert.equal(requests[1].args.data.requestId,requests[0].args.data.requestId);
  requests[1].resolve({result:{ok:true,appointment:{bookingCode:'TEST_ONLY'}}});
  await retry;
  assert.equal(page.data.result.bookingCode,'TEST_ONLY');
});
test('direct numeric input normalizes digits and switches the period automatically', async () => {
  const {page, requests} = pageHarness();
  page.updateTimeInput({currentTarget:{dataset:{field:'hourInput'}},detail:{value:'9'}});
  page.updateTimeInput({currentTarget:{dataset:{field:'minuteInput'}},detail:{value:'5'}});
  const check = page.commitTimeInput();
  assert.equal(requests[0].args.data.customTime,'09:05');
  requests[0].resolve({result:{ok:true,slots:[{time:'09:05',available:true}]}});
  await check;
  assert.equal(page.data.periodIndex,0);
  assert.equal(page.data.hourInput,'09');
  assert.equal(page.data.minuteInput,'05');
  assert.equal(page.data.displayTime,'上午 09:05');
});
test('hour selector follows the selected morning or afternoon range', () => {
  const {page} = pageHarness();
  page.data.periodIndex = 0;
  page.data.hours = ['09','10','11','12'];
  page.data.hourIndex = 0;
  page.openTimeSelector({currentTarget:{dataset:{field:'hour'}}});
  assert.deepEqual(page.data.selectorOptions.map(item => item.value),['09','10','11','12']);
  assert.equal(page.data.selectorOptions[0].label,'09 时');
});
test('20:00 is the inclusive latest booking start time in query and submit validation', () => {
  for (const relativePath of [
    '../cloudfunctions/getAvailability/index.js',
    '../cloudfunctions/createBooking/index.js',
  ]) {
    const scope = loadCloudFunction(relativePath);
    assert.equal(scope.isBookingStartAllowed(9 * 60, 9 * 60, 20 * 60), true);
    assert.equal(scope.isBookingStartAllowed(20 * 60, 9 * 60, 20 * 60), true);
    assert.equal(scope.isBookingStartAllowed(20 * 60 + 1, 9 * 60, 20 * 60), false);
  }
});
test('customer catalog contains the two requested services and separate reservation blocks', () => {
  const page = homePageHarness();
  const catalog = page.data.services.map(service => ({
      id: service._id,
      name: service.name,
      duration: service.durationMinutes,
      block: service.bookingBlockMinutes,
    }));
  assert.deepEqual(
    JSON.parse(JSON.stringify(catalog)),
    [
      {id: 'basic-care', name: '芳香精油净润护理', duration: 60, block: 150},
      {id: 'anti-aging-sculpt', name: '手法提拉塑颜护理', duration: 90, block: 180},
    ],
  );
});
test('arrival reminder defaults to two hours and stays within the requested one-to-two-hour window', () => {
  const scope = loadCloudFunction('../cloudfunctions/ownerAppointments/index.js');
  assert.equal(scope.reminderLeadMinutesFor({}), 120);
  assert.equal(scope.reminderLeadMinutesFor({reminderLeadMinutes: 90}), 90);
  assert.equal(scope.reminderLeadMinutesFor({reminderLeadMinutes: 30}), 60);
  assert.equal(scope.reminderLeadMinutesFor({reminderLeadMinutes: 180}), 120);
  assert.equal(
    scope.reminderScheduledFor('2026-09-18T06:00:00.000Z', 120, Date.parse('2026-09-18T00:00:00.000Z')),
    '2026-09-18T04:00:00.000Z',
  );
  assert.equal(
    scope.reminderScheduledFor('2026-09-18T06:00:00.000Z', 120, Date.parse('2026-09-18T05:30:00.000Z')),
    '2026-09-18T05:30:00.000Z',
  );
});
test('customer status copy reflects the owner confirmation state', () => {
  const scope = loadCloudFunction('../cloudfunctions/getMyAppointments/index.js');
  assert.equal(scope.statusCopy('pending', '白兰'), '等待白兰确认');
  assert.equal(scope.statusCopy('confirmed', '白兰'), '白兰已接受您的预约');
  assert.equal(scope.statusLabel('confirmed'), '已确认');
  assert.equal(scope.statusLabel('cancelled_by_owner'), '已取消');
  assert.equal(scope.statusCopy('cancelled_by_customer', '白兰'), '您已取消本次预约');
  assert.equal(scope.statusCopy('cancelled_by_owner', '白兰'), '本次预约已由店主取消');
});
test('pending appointments remain cancellable after their time while confirmed past appointments stay protected', () => {
  const customer = loadCloudFunction('../cloudfunctions/getMyAppointments/index.js');
  const owner = loadCloudFunction('../cloudfunctions/ownerAppointments/index.js');
  assert.equal(customer.canCustomerCancel('pending'), true);
  assert.equal(customer.canCustomerCancel('confirmed'), true);
  assert.equal(customer.canCustomerCancel('cancelled_by_customer'), false);
  assert.equal(owner.canOwnerCancel('confirmed'), true);
  assert.equal(owner.canOwnerCancel('pending'), true);
  assert.equal(owner.canOwnerCancel('cancelled_by_owner'), false);
  assert.equal(owner.ownerCancellationAllowed('pending', '2026-09-18T06:00:00.000Z', Date.parse('2026-09-18T08:00:00.000Z')), true);
  assert.equal(owner.ownerCancellationAllowed('confirmed', '2026-09-18T06:00:00.000Z', Date.parse('2026-09-18T08:00:00.000Z')), false);
  assert.equal(customer.customerCancellationAllowed('pending', '2026-09-18T06:00:00.000Z', Date.parse('2026-09-18T08:00:00.000Z')), true);
  assert.equal(customer.customerCancellationAllowed('confirmed', '2026-09-18T06:00:00.000Z', Date.parse('2026-09-18T08:00:00.000Z')), false);
  assert.equal(customer.isFutureAppointment('2026-09-18T06:00:00.000Z', Date.parse('2026-09-18T05:59:59.000Z')), true);
  assert.equal(owner.isFutureAppointment('2026-09-18T06:00:00.000Z', Date.parse('2026-09-18T06:00:00.000Z')), false);
});
test('cancellation releases appointment slots and is exposed in both UIs', () => {
  const customerSource = fs.readFileSync(path.resolve(__dirname, '../cloudfunctions/getMyAppointments/index.js'), 'utf8');
  const ownerSource = fs.readFileSync(path.resolve(__dirname, '../cloudfunctions/ownerAppointments/index.js'), 'utf8');
  const customerWxml = fs.readFileSync(path.join(base, 'pages/my-bookings/index.wxml'), 'utf8');
  const ownerWxml = fs.readFileSync(path.join(base, 'pages/owner/index.wxml'), 'utf8');
  assert.match(customerSource, /appointment_slots[\s\S]*releasedSlotIds[\s\S]*\.remove\(\)/);
  assert.match(ownerSource, /appointment_slots[\s\S]*releasedSlotIds[\s\S]*\.remove\(\)/);
  assert.match(customerWxml, /swipe-cancel-button/);
  assert.match(customerWxml, /向左滑动/);
  assert.match(customerWxml, /删除记录/);
  assert.match(customerWxml, /历史记录/);
  assert.equal((ownerWxml.match(/bindtap="cancelAppointment"/g) || []).length, 2);
  assert.match(ownerWxml, /已取消预约/);
});
test('home displays the current mini program version', () => {
  const page = homePageHarness();
  const homeWxml = fs.readFileSync(path.join(base, 'pages/home/index.wxml'), 'utf8');
  assert.equal(page.data.appVersion, '0.1.11-dev');
  assert.match(homeWxml, /版本 v\{\{appVersion\}\}/);
});
test('appointment history date ranges cover day, Monday-to-Sunday week, month and custom dates', () => {
  const {rangeFor} = loadHistoryRangeUtility();
  assert.deepEqual(JSON.parse(JSON.stringify(rangeFor('day', '2026-09-14'))), {startDate:'2026-09-14',endDate:'2026-09-14'});
  assert.deepEqual(JSON.parse(JSON.stringify(rangeFor('week', '2026-09-17'))), {startDate:'2026-09-14',endDate:'2026-09-20'});
  assert.deepEqual(JSON.parse(JSON.stringify(rangeFor('month', '2026-09-17'))), {startDate:'2026-09-01',endDate:'2026-09-30'});
  assert.deepEqual(JSON.parse(JSON.stringify(rangeFor('custom', '2026-09-17', '2026-08-01', '2026-09-14'))), {startDate:'2026-08-01',endDate:'2026-09-14'});
  assert.throws(() => rangeFor('custom', '2026-09-17', '2026-09-14', '2026-08-01'), /结束日期/);
});
test('owner history query labels cancelled, completed and overdue pending appointments', () => {
  const owner = loadCloudFunction('../cloudfunctions/ownerAppointments/index.js');
  const now = Date.parse('2026-09-18T08:00:00.000Z');
  assert.equal(owner.historyStatusLabel({status:'cancelled_by_owner'}, now), '已取消');
  assert.equal(owner.historyStatusLabel({status:'confirmed',startsAt:'2026-09-18T06:00:00.000Z',durationMinutes:60}, now), '已完成');
  assert.equal(owner.historyStatusLabel({status:'pending',startsAt:'2026-09-18T06:00:00.000Z'}, now), '过期待确认');
  assert.deepEqual(
    JSON.parse(JSON.stringify(owner.queryRange('2026-09-01', '2026-09-30'))),
    {startIso:'2026-08-31T16:00:00.000Z',endExclusiveIso:'2026-09-30T16:00:00.000Z'},
  );
});
test('cancelled records become archive candidates after 24 hours without deleting history', () => {
  const archive = loadCloudFunction('../cloudfunctions/archiveCancelledAppointments/index.js');
  const cancelledAt = '2026-09-17T08:00:00.000Z';
  assert.equal(archive.shouldArchive({status:'cancelled_by_owner',cancelledAt}, Date.parse('2026-09-18T07:59:59.000Z')), false);
  assert.equal(archive.shouldArchive({status:'cancelled_by_owner',cancelledAt}, Date.parse('2026-09-18T08:00:00.000Z')), true);
  assert.equal(archive.shouldArchive({status:'cancelled_by_owner',cancelledAt,archivedAt:'2026-09-18T08:00:00.000Z'}, Date.parse('2026-09-19T08:00:00.000Z')), false);
});
test('customer history recognizes successful past appointments and keeps cancelled records queryable', () => {
  const customer = loadCloudFunction('../cloudfunctions/getMyAppointments/index.js');
  const now = Date.parse('2026-09-18T08:00:00.000Z');
  assert.equal(customer.isCompletedAppointment({status:'confirmed',startsAt:'2026-09-18T06:00:00.000Z',durationMinutes:60}, now), true);
  assert.equal(customer.isCancelledAppointment({status:'cancelled_by_customer'}), true);
  assert.equal(customer.isRecentCancellation({cancelledAt:'2026-09-17T08:00:00.000Z'}, now), false);
});
test('co-owner invite codes are hashed before storage', () => {
  const scope = loadCloudFunction('../cloudfunctions/ownerAccess/index.js');
  const hash = scope.inviteCodeHash('XY-1234ABCD');
  assert.match(hash, /^[a-f0-9]{64}$/);
  assert.notEqual(hash, 'XY-1234ABCD');
  assert.equal(scope.inviteCodeHash('XY-1234ABCD'), hash);
});
test('owner console data and invite creation require explicit admin roles', () => {
  const accessSource = fs.readFileSync(path.resolve(__dirname, '../cloudfunctions/ownerAccess/index.js'), 'utf8');
  const appointmentsSource = fs.readFileSync(path.resolve(__dirname, '../cloudfunctions/ownerAppointments/index.js'), 'utf8');
  const ownerWxml = fs.readFileSync(path.join(base, 'pages/owner/index.wxml'), 'utf8');
  assert.match(accessSource, /if \(action === 'createInvite'\)[\s\S]{0,180}requireSuperAdmin\(openid\)/);
  assert.match(accessSource, /\['requestAccess', 'listRequests', 'approveRequest'\][\s\S]{0,220}INVITE_REQUIRED/);
  assert.match(appointmentsSource, /\['super_admin', 'owner'\]\.includes\(result\.data\.role\)/);
  assert.match(ownerWxml, /wx:if="{{admin\.role === 'super_admin'}}" class="invite-card"/);
  assert.match(ownerWxml, /wx:elif="{{hasInviteToken}}" class="setup-card"/);
  assert.match(ownerWxml, /当前微信没有店主权限/);
  assert.doesNotMatch(ownerWxml, /申请共同店主权限/);
});
test('home keeps the documented long-press owner console shortcut', () => {
  const homeWxml = fs.readFileSync(path.join(base, 'pages/home/index.wxml'), 'utf8');
  assert.match(homeWxml, /bindlongpress="openOwner"/);
  assert.doesNotMatch(homeWxml, /owner-entry-link/);
});
test('customer appointment status supports manual and automatic refresh', () => {
  const pageJs = fs.readFileSync(path.join(base, 'pages/my-bookings/index.js'), 'utf8');
  const pageWxml = fs.readFileSync(path.join(base, 'pages/my-bookings/index.wxml'), 'utf8');
  assert.match(pageJs, /setInterval\([\s\S]*10000\)/);
  assert.match(pageJs, /refreshStatus\(\)/);
  assert.match(pageWxml, /bindtap="refreshStatus"/);
  assert.match(pageWxml, /每10秒自动更新/);
});
test('availability and booking use the configured cleanup block but never shorten service time', () => {
  for (const relativePath of [
    '../cloudfunctions/getAvailability/index.js',
    '../cloudfunctions/createBooking/index.js',
  ]) {
    const scope = loadCloudFunction(relativePath);
    assert.equal(scope.bookingBlockMinutesFor({durationMinutes: 60, bookingBlockMinutes: 150}), 150);
    assert.equal(scope.bookingBlockMinutesFor({durationMinutes: 90, bookingBlockMinutes: 180}), 180);
    assert.equal(scope.bookingBlockMinutesFor({durationMinutes: 90, bookingBlockMinutes: 60}), 90);
    assert.equal(scope.bookingBlockMinutesFor({durationMinutes: 60}), 60);
  }
});
