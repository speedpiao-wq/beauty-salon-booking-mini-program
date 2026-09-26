Page({
  data: {
    loading: true,
    appointments: [],
    ownerDisplayName: '白兰',
    error: '',
    lastUpdatedText: '',
    workingAppointmentId: '',
    viewMode: 'current',
    swipeOpenId: '',
  },

  onShow() {
    this.pageVisible = true;
    this.loadAppointments();
    this.startAutoRefresh();
  },

  onHide() {
    this.stopAutoRefresh();
  },

  onUnload() {
    this.pageVisible = false;
    this.stopAutoRefresh();
  },

  onPullDownRefresh() {
    this.loadAppointments().finally(() => wx.stopPullDownRefresh());
  },

  startAutoRefresh() {
    this.stopAutoRefresh();
    this.refreshTimer = setInterval(() => {
      if (this.pageVisible) this.loadAppointments({ silent: true });
    }, 10000);
  },

  stopAutoRefresh() {
    if (!this.refreshTimer) return;
    clearInterval(this.refreshTimer);
    this.refreshTimer = null;
  },

  formatUpdatedTime(date = new Date()) {
    const pad = (value) => String(value).padStart(2, '0');
    return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
  },

  async loadAppointments(options = {}) {
    if (this.requestInFlight) {
      this.reloadAfterCurrentRequest = true;
      return;
    }
    const silent = options.silent === true;
    const requestedView = this.data.viewMode;
    this.requestInFlight = true;
    if (!silent) this.setData({ loading: true, error: '' });
    try {
      const response = await wx.cloud.callFunction({
        name: 'getMyAppointments',
        data: { action: 'list', view: requestedView },
      });
      const result = response.result || {};
      if (!result.ok) throw new Error(result.message || '暂时无法读取预约记录');
      if (this.data.viewMode !== requestedView) return;
      this.setData({
        appointments: Array.isArray(result.appointments) ? result.appointments : [],
        ownerDisplayName: result.ownerDisplayName || '白兰',
        lastUpdatedText: this.formatUpdatedTime(),
        error: '',
      });
    } catch (error) {
      this.setData({ error: error.message || '网络繁忙，请稍后重试' });
    } finally {
      this.requestInFlight = false;
      if (!silent) this.setData({ loading: false });
      if (this.reloadAfterCurrentRequest) {
        this.reloadAfterCurrentRequest = false;
        this.loadAppointments();
      }
    }
  },

  refreshStatus() {
    this.loadAppointments();
  },

  switchView(event) {
    const viewMode = event.currentTarget.dataset.view;
    if (!['current', 'history'].includes(viewMode) || viewMode === this.data.viewMode) return;
    this.setData({ viewMode, appointments: [], swipeOpenId: '', error: '' });
    this.loadAppointments();
  },

  startSwipe(event) {
    if (this.data.workingAppointmentId || !event.touches || !event.touches.length) return;
    const point = event.touches[0];
    this.swipeStart = { x: point.clientX, y: point.clientY };
  },

  endSwipe(event) {
    const appointmentId = event.currentTarget.dataset.id;
    const actionable = event.currentTarget.dataset.actionable === true
      || event.currentTarget.dataset.actionable === 'true';
    const point = event.changedTouches && event.changedTouches[0];
    if (!this.swipeStart || !point) return;
    const deltaX = point.clientX - this.swipeStart.x;
    const deltaY = point.clientY - this.swipeStart.y;
    this.swipeStart = null;
    if (Math.abs(deltaX) < 36 || Math.abs(deltaX) <= Math.abs(deltaY)) return;
    if (deltaX < 0 && actionable) {
      this.setData({ swipeOpenId: appointmentId });
    } else if (deltaX > 0 || this.data.swipeOpenId === appointmentId) {
      this.setData({ swipeOpenId: '' });
    }
  },

  closeSwipe() {
    if (this.data.swipeOpenId) this.setData({ swipeOpenId: '' });
  },

  async cancelAppointment(event) {
    const appointmentId = event.currentTarget.dataset.id;
    if (!appointmentId || this.data.workingAppointmentId) return;
    const confirmed = await new Promise((resolve) => {
      wx.showModal({
        title: '取消这条预约？',
        content: '取消后会立即释放这个预约时间，其他客人可以重新选择。',
        confirmText: '确认取消',
        confirmColor: '#9b3b3b',
        success: (result) => resolve(result.confirm),
        fail: () => resolve(false),
      });
    });
    if (!confirmed) return;

    this.setData({ workingAppointmentId: appointmentId, swipeOpenId: '', error: '' });
    try {
      const response = await wx.cloud.callFunction({
        name: 'getMyAppointments',
        data: { action: 'cancel', appointmentId },
      });
      const result = response.result || {};
      if (!result.ok) throw new Error(result.message || '暂时无法取消预约');
      const updated = result.appointment;
      this.setData({
        appointments: this.data.appointments.map((item) => (item.id === appointmentId
          ? { ...updated, canHide: this.data.viewMode === 'current' }
          : item)),
        lastUpdatedText: this.formatUpdatedTime(),
      });
      wx.showToast({ title: '预约已取消', icon: 'success' });
    } catch (error) {
      this.setData({ error: error.message || '取消失败，请稍后重试' });
    } finally {
      this.setData({ workingAppointmentId: '' });
      this.loadAppointments({ silent: true });
    }
  },

  async hideCancelled(event) {
    const appointmentId = event.currentTarget.dataset.id;
    if (!appointmentId || this.data.workingAppointmentId) return;
    const confirmed = await new Promise((resolve) => {
      wx.showModal({
        title: '删除这条记录？',
        content: '只会从“当前预约”中移除，仍可在“历史记录”里查询，不会破坏店主审计记录。',
        confirmText: '删除记录',
        confirmColor: '#9b3b3b',
        success: (result) => resolve(result.confirm),
        fail: () => resolve(false),
      });
    });
    if (!confirmed) return;
    this.setData({ workingAppointmentId: appointmentId, swipeOpenId: '', error: '' });
    try {
      const response = await wx.cloud.callFunction({
        name: 'getMyAppointments',
        data: { action: 'hideCancelled', appointmentId },
      });
      const result = response.result || {};
      if (!result.ok) throw new Error(result.message || '暂时无法删除记录');
      this.setData({
        appointments: this.data.appointments.filter((item) => item.id !== appointmentId),
        lastUpdatedText: this.formatUpdatedTime(),
      });
      wx.showToast({ title: '已从当前列表删除', icon: 'success' });
    } catch (error) {
      const message = error.message || '删除失败，请稍后重试';
      this.setData({ error: message });
      wx.showModal({ title: '删除未成功', content: message, showCancel: false });
    } finally {
      this.setData({ workingAppointmentId: '' });
    }
  },

  backHome() {
    wx.navigateBack();
  },
});
