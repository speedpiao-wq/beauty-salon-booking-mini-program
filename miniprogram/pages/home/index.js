const { saveCatalog } = require('../../utils/catalog-cache');
const { decorateRestNotices } = require('../../utils/rest-notices');
const FALLBACK_SERVICES = [
  {
    _id: 'basic-care',
    name: '芳香精油净润护理',
    description: '甄选多特瑞精油，融合清洁、滋养与芳香放松体验',
    durationMinutes: 60,
    bookingBlockMinutes: 150,
  },
  {
    _id: 'anti-aging-sculpt',
    name: '手法提拉塑颜护理',
    description: '聚焦手法提拉与面部轮廓塑形',
    durationMinutes: 90,
    bookingBlockMinutes: 180,
  },
];
const REQUIRED_SCHEMA_VERSION = 8;
const APP_VERSION = '0.1.7-dev';

Page({
  data: {
    appVersion: APP_VERSION,
    loading: true,
    cloudConnected: false,
    connectionText: '正在连接云环境',
    services: FALLBACK_SERVICES,
    selectedServiceId: 'basic-care',
    isOwner: false,
    ownerAppointments: [],
    ownerSummaryError: '',
    ownerSummaryMore: false,
    restNotices: [], restNoticeError: '',
  },

  onLoad() {
    this.loadBootstrap();
  },

  onShow() {
    this.homeVisible = true;
    this.loadOwnerSummary();
    this.loadRestNotices();
    clearInterval(this.ownerRefreshTimer);
    this.ownerRefreshTimer = setInterval(() => { this.loadOwnerSummary(); this.loadRestNotices(); }, 30000);
  },

  onHide() {
    this.homeVisible = false;
    this.restNoticeVersion = (this.restNoticeVersion || 0) + 1;
    clearInterval(this.ownerRefreshTimer);
    this.setData({ isOwner: false, ownerAppointments: [] });
  },

  onUnload() { this.onHide(); },

  async loadOwnerSummary() {
    if (this.ownerSummaryInFlight) return;
    this.ownerSummaryInFlight = true;
    try {
      const response = await wx.cloud.callFunction({ name: 'ownerAppointments', data: { action: 'summary' } });
      const result = response.result || {};
      if (!result.ok) throw new Error(result.message || '预约摘要更新失败');
      if (!this.homeVisible) return;
      this.setData({
        isOwner: result.isAdmin === true,
        ownerAppointments: result.isAdmin ? result.appointments || [] : [],
        ownerSummaryMore: result.hasMore === true,
        ownerSummaryError: '',
      });
    } catch (error) {
      if (this.homeVisible) this.setData({ isOwner: false, ownerAppointments: [], ownerSummaryError: '' });
      console.warn('预约摘要读取失败', error);
    } finally { this.ownerSummaryInFlight = false; }
  },

  onPullDownRefresh() {
    Promise.all([this.loadBootstrap(), this.loadOwnerSummary(), this.loadRestNotices()]).finally(() => wx.stopPullDownRefresh());
  },

  async loadRestNotices() {
    const version = this.restNoticeVersion = (this.restNoticeVersion || 0) + 1;
    try {
      const response = await wx.cloud.callFunction({ name: 'getBootstrap', data: { action: 'restNotices' } });
      if (!this.homeVisible || version !== this.restNoticeVersion) return;
      const result = response.result || {};
      if (!result.ok) throw new Error('休息安排暂未更新，请以选时结果为准');
      this.setData({ restNotices: decorateRestNotices(result.restNotices), restNoticeError: '' });
    } catch (error) {
      if (this.homeVisible && version === this.restNoticeVersion) this.setData({ restNotices: [], restNoticeError: '休息安排暂未更新，请以选时结果为准' });
    }
  },

  async loadBootstrap() {
    this.setData({ loading: true, connectionText: '正在连接云环境' });
    try {
      let response = await wx.cloud.callFunction({ name: 'getBootstrap' });
      let result = response.result || {};
      const requiresInitialization = (!result.ok && result.code === 'DATABASE_NOT_READY')
        || (result.ok && Number(result.system && result.system.schemaVersion) < REQUIRED_SCHEMA_VERSION);
      if (requiresInitialization) {
        const initialization = await wx.cloud.callFunction({
          name: 'initializeDatabase',
          data: { confirm: 'INIT_XIUYA_V1' },
        });
        if (!initialization.result || !initialization.result.ok) {
          throw new Error('云数据库初始化失败');
        }
        response = await wx.cloud.callFunction({ name: 'getBootstrap' });
        result = response.result || {};
      }
      if (!result.ok) throw new Error(result.message || '云端数据尚未初始化');

      const services = Array.isArray(result.services) && result.services.length
        ? result.services
        : FALLBACK_SERVICES;
      saveCatalog(services);
      this.setData({
        services,
        selectedServiceId: services[0]._id,
        cloudConnected: true,
        connectionText: '云环境已连接',
      });
    } catch (error) {
      console.warn('读取云端初始化信息失败', error);
      this.setData({
        services: FALLBACK_SERVICES,
        cloudConnected: false,
        connectionText: '当前为本地预览',
      });
    } finally {
      this.setData({ loading: false });
    }
  },

  selectService(event) {
    this.setData({ selectedServiceId: event.currentTarget.dataset.id });
  },

  startBooking() {
    if (!this.data.cloudConnected) {
      wx.showModal({
        title: '云端尚未连接',
        content: '请先部署初始化函数和 getBootstrap 云函数，再继续预约功能测试。',
        showCancel: false,
      });
      return;
    }

    wx.navigateTo({
      url: `/pages/booking/index?serviceId=${encodeURIComponent(this.data.selectedServiceId)}`,
    });
  },

  openMyBookings() {
    wx.navigateTo({ url: '/pages/my-bookings/index' });
  },

  openOwner() {
    wx.navigateTo({ url: '/pages/owner/index' });
  },
});
