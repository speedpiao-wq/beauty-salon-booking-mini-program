const { pad, hoursForPeriod, to24Hour, makeInitialSelection, makeDates } = require('../../utils/appointment-time');
const { getCatalog, saveCatalog } = require('../../utils/catalog-cache');
const { decorateRestNotices } = require('../../utils/rest-notices');
function makeRequestId() { return `${Date.now()}-${Math.random().toString(36).slice(2, 12)}`; }

Page({
  data: {
    step: 1, loading: true, loadingSlots: false, submitting: false, checkingNext: false,
    services: [], selectedServiceId: '', selectedService: null,
    dates: [], selectedDate: '', selectedDateLabel: '',
    periods: ['上午', '下午'], hours: hoursForPeriod(1),
    minutes: Array.from({ length: 60 }, (_, i) => pad(i)),
    periodIndex: 1, hourIndex: 1, hourInput: '14', minuteIndex: 0, minuteInput: '00',
    selectedTime: '', displayTime: '下午 14:00',
    selectorOpen: false, selectorField: '', selectorTitle: '', selectorOptions: [],
    selectorSelectedValue: '', selectorScrollIntoView: '',
    timeStatus: 'idle', availabilityMessage: '正在读取预约信息…',
    customerName: '', contact: '', note: '', notifyResult: true, notifyReminder: true,
    requestId: '', error: '', result: null,
    restNotices: [],
  },
  onLoad(options) {
    this.enteredAt = Date.now();
    this.availabilityVersion = 0;
    this.unloaded = false;
    const dates = makeDates();
    const { dayOffset, ...timeParts } = makeInitialSelection();
    const date = dates[dayOffset];
    this.setData({
      dates, selectedServiceId: options.serviceId || '', selectedDate: date.value,
      selectedDateLabel: date.label, ...timeParts, requestId: makeRequestId(),
    });
    this.refreshDisplayTime();
    this.loadCatalog();
  },
  onUnload() { this.unloaded = true; this.availabilityVersion += 1; },
  refreshDisplayTime() {
    const { periods, periodIndex, hours, hourIndex, minuteIndex } = this.data;
    this.setData({ displayTime: `${periods[periodIndex]} ${hours[hourIndex]}:${pad(minuteIndex)}` });
  },
  async loadCatalog() {
    const cached = getCatalog();
    if (cached) {
      this.applyCatalog(cached);
      return this.checkAvailability();
    }
    this.setData({ loading: true });
    try {
      const response = await wx.cloud.callFunction({ name: 'getBootstrap' });
      if (this.unloaded) return;
      const result = response.result || {};
      if (!result.ok || !Array.isArray(result.services) || !result.services.length)
        throw new Error(result.message || '暂时无法读取护理项目，请返回重试');
      saveCatalog(result.services);
      this.applyCatalog(result.services);
      await this.checkAvailability();
    } catch (error) {
      if (!this.unloaded) this.setData({ loading: false, error: error.message || '暂时无法读取预约信息' });
    }
  },
  applyCatalog(services) {
    const selectedService = services.find(item => item._id === this.data.selectedServiceId) || services[0];
    this.setData({ services, selectedServiceId: selectedService._id, selectedService, loading: false });
    this.catalogReadyMs = Date.now() - this.enteredAt;
  },
  async checkAvailability() {
    if (!this.data.selectedService || this.unloaded) return false;
    const version = ++this.availabilityVersion;
    const { selectedServiceId, selectedDate, periodIndex, hourIndex, minuteIndex } = this.data;
    const time = to24Hour(periodIndex, hourIndex, minuteIndex);
    this.setData({ loadingSlots: true, selectedTime: '', restNotices: [], timeStatus: 'checking', availabilityMessage: '正在检查这个时间…' });
    try {
      const response = await wx.cloud.callFunction({
        name: 'getAvailability', data: { serviceId: selectedServiceId, date: selectedDate, customTime: time },
      });
      if (this.unloaded || version !== this.availabilityVersion) return false;
      const result = response.result || {};
      if (!result.ok) throw new Error(result.message || '暂时无法检查时间，请重新选择后重试');
      const slot = (result.slots || []).find(item => item.time === time);
      const available = Boolean(slot && slot.available);
      this.setData({
        restNotices: decorateRestNotices(result.restNotices),
        selectedTime: available ? time : '', timeStatus: available ? 'available' : 'unavailable',
        availabilityMessage: available ? '这个时间可以预约' : ((slot && slot.reason) || '当天暂停预约，请选择其他日期'),
      });
      if (this.firstAvailabilityMs === undefined) this.firstAvailabilityMs = Date.now() - this.enteredAt;
      return available;
    } catch (error) {
      if (!this.unloaded && version === this.availabilityVersion)
        this.setData({ timeStatus: 'error', availabilityMessage: error.message || '网络繁忙，请重新选择后重试' });
      return false;
    } finally {
      if (!this.unloaded && version === this.availabilityVersion) this.setData({ loadingSlots: false });
    }
  },
  selectDate(event) {
    if (this.data.checkingNext || this.data.submitting) return;
    const date = this.data.dates.find(item => item.value === event.currentTarget.dataset.value);
    if (!date) return;
    this.setData({ selectedDate: date.value, selectedDateLabel: date.label, error: '' });
    return this.checkAvailability();
  },
  openTimeSelector(event) {
    if (this.data.checkingNext || this.data.submitting) return;
    const field = event.currentTarget.dataset.field;
    let title = '';
    let values = [];
    let selectedValue = '';
    if (field === 'period') {
      title = '选择上午或下午';
      values = this.data.periods;
      selectedValue = String(this.data.periodIndex);
    } else if (field === 'hour') {
      title = '选择到店小时';
      values = this.data.hours;
      selectedValue = this.data.hours[this.data.hourIndex];
    } else if (field === 'minute') {
      title = '选择到店分钟';
      values = this.data.minutes;
      selectedValue = pad(this.data.minuteIndex);
    } else return;
    const selectorOptions = values.map((value, index) => ({
      value: field === 'period' ? String(index) : String(value),
      label: field === 'period' ? value : `${value}${field === 'hour' ? ' 时' : ' 分'}`,
    }));
    this.setData({
      selectorOpen: true,
      selectorField: field,
      selectorTitle: title,
      selectorOptions,
      selectorSelectedValue: selectedValue,
      selectorScrollIntoView: `selector-${selectedValue}`,
    });
  },
  closeTimeSelector() {
    this.setData({ selectorOpen: false, selectorField: '', selectorOptions: [] });
  },
  preventTouchMove() {},
  selectTimeOption(event) {
    if (this.data.checkingNext || this.data.submitting) return;
    const field = this.data.selectorField;
    const value = String(event.currentTarget.dataset.value);
    if (field === 'period') {
      const periodIndex = Number(value);
      if (!Number.isInteger(periodIndex) || periodIndex < 0 || periodIndex > 1) return;
      const hours = hoursForPeriod(periodIndex);
      this.setData({ periodIndex, hours, hourIndex: 0, hourInput: hours[0] });
    } else if (field === 'hour') {
      const hourIndex = this.data.hours.indexOf(value);
      if (hourIndex < 0) return;
      this.setData({ hourIndex, hourInput: value });
    } else if (field === 'minute') {
      const minuteIndex = Number(value);
      if (!Number.isInteger(minuteIndex) || minuteIndex < 0 || minuteIndex > 59) return;
      this.setData({ minuteIndex, minuteInput: pad(minuteIndex) });
    } else return;
    this.closeTimeSelector();
    this.refreshDisplayTime();
    return this.checkAvailability();
  },
  updateTimeInput(event) {
    if (this.data.checkingNext || this.data.submitting) return;
    const field = event.currentTarget.dataset.field;
    if (!['hourInput', 'minuteInput'].includes(field)) return;
    const value = String(event.detail.value || '').replace(/\D/g, '').slice(0, 2);
    this.setData({
      [field]: value,
      selectedTime: '',
      timeStatus: 'idle',
      availabilityMessage: '输入完成后将自动检查',
      error: '',
    });
  },
  commitTimeInput() {
    if (this.data.checkingNext || this.data.submitting) return;
    const hour = Number(this.data.hourInput);
    const minute = Number(this.data.minuteInput);
    if (!this.data.hourInput || !Number.isInteger(hour) || hour < 9 || hour > 20) {
      this.setData({
        selectedTime: '', timeStatus: 'unavailable',
        availabilityMessage: '小时请输入09—20之间的数字',
      });
      return;
    }
    if (!this.data.minuteInput || !Number.isInteger(minute) || minute < 0 || minute > 59) {
      this.setData({
        selectedTime: '', timeStatus: 'unavailable',
        availabilityMessage: '分钟请输入00—59之间的数字',
      });
      return;
    }
    const periodIndex = hour <= 12 ? 0 : 1;
    const hours = hoursForPeriod(periodIndex);
    const hourInput = pad(hour);
    const hourIndex = hours.indexOf(hourInput);
    this.setData({
      periodIndex,
      hours,
      hourIndex,
      hourInput,
      minuteIndex: minute,
      minuteInput: pad(minute),
      error: '',
    });
    this.refreshDisplayTime();
    return this.checkAvailability();
  },
  async nextStep() {
    if (this.data.checkingNext || this.data.loadingSlots || this.data.timeStatus !== 'available') return;
    this.setData({ checkingNext: true, error: '' });
    try {
      // 再检查一次，避免停留页面过久后继续使用旧的可约状态。
      if (await this.checkAvailability()) {
        this.setData({ step: 2 });
        wx.pageScrollTo({ scrollTop: 0, duration: 0 });
      }
    } finally { if (!this.unloaded) this.setData({ checkingNext: false }); }
  },
  previousStep() {
    if (this.data.submitting) return;
    this.setData({ step: 1, error: '' });
    wx.pageScrollTo({ scrollTop: 0, duration: 0 });
    return this.checkAvailability();
  },
  updateField(event) {
    const field = event.currentTarget.dataset.field;
    if (!this.data.submitting && ['customerName', 'contact', 'note'].includes(field))
      this.setData({ [field]: event.detail.value, error: '' });
  },
  updateSwitch(event) {
    const field = event.currentTarget.dataset.field;
    if (!this.data.submitting && ['notifyResult', 'notifyReminder'].includes(field))
      this.setData({ [field]: event.detail.value });
  },
  async submitBooking() {
    if (this.data.submitting || this.data.result) return;
    if (!this.data.selectedTime) { this.setData({ step: 1, error: '请先选择一个可预约时间' }); return; }
    if (!this.data.customerName.trim()) { this.setData({ error: '请填写预约称呼' }); return; }
    this.setData({ submitting: true, error: '' });
    try {
      const response = await wx.cloud.callFunction({
        name: 'createBooking',
        data: {
          requestId: this.data.requestId, serviceId: this.data.selectedServiceId,
          date: this.data.selectedDate, time: this.data.selectedTime,
          customerName: this.data.customerName.trim(), contact: this.data.contact.trim(), note: this.data.note.trim(),
          notifyResult: this.data.notifyResult, notifyReminder: this.data.notifyReminder,
        },
      });
      const result = response.result || {};
      if (!result.ok) {
        if (['SLOT_TAKEN', 'TIME_UNAVAILABLE', 'DATE_OUT_OF_RANGE', 'SCHEDULE_BLOCKED'].includes(result.code)) {
          this.setData({ step: 1 });
          await this.checkAvailability();
          if (result.code === 'SCHEDULE_BLOCKED') wx.showModal({ title: '白兰的休息提醒', content: result.message, showCancel: false });
          wx.pageScrollTo({ scrollTop: 0, duration: 0 });
        }
        throw new Error(result.message || '预约暂时未能保存');
      }
      this.setData({ result: result.appointment });
      wx.pageScrollTo({ scrollTop: 0, duration: 0 });
    } catch (error) {
      // 请求结果不明时保留输入、请求编号和错误信息，重试不会重复建单。
      if (!this.unloaded) this.setData({ error: error.message || '网络繁忙，请保留本页重试' });
    } finally { if (!this.unloaded) this.setData({ submitting: false }); }
  },
  backHome() { wx.navigateBack(); },
  openMyBookings() { wx.redirectTo({ url: '/pages/my-bookings/index' }); },
});
