const { rangeFor, todayDate, weeksForMonth } = require('../../utils/history-range');
const { DEFAULT_REST_MESSAGE, decorateRestNotices, makeRestDraft } = require('../../utils/rest-notices');
const { addDays, shareDates, normalizeShareSchedule, shareRangeText } = require('../../utils/share-schedule');

const INITIAL_HISTORY_DATE = todayDate();
const SHARE_ANGEL_PATH = '/assets/share-angel-cream.png';

function roundedRect(ctx, x, y, width, height, radius) {
  const r = Math.min(radius, width / 2, height / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + width, y, x + width, y + height, r);
  ctx.arcTo(x + width, y + height, x, y + height, r);
  ctx.arcTo(x, y + height, x, y, r);
  ctx.arcTo(x, y, x + width, y, r);
  ctx.closePath();
}

function wrapTokens(ctx, tokens, maxWidth) {
  const lines = [];
  let current = '';
  tokens.forEach(token => {
    const candidate = current ? `${current}   ${token}` : token;
    if (!current || ctx.measureText(candidate).width <= maxWidth) current = candidate;
    else { lines.push(current); current = token; }
  });
  if (current) lines.push(current);
  return lines.length ? lines : ['当天暂无已预约时段'];
}

function posterLayout(ctx, schedule) {
  for (let fontSize = 42; fontSize >= 26; fontSize -= 2) {
    ctx.font = `600 ${fontSize}px sans-serif`;
    const cards = schedule.map(day => {
      const tokens = day.intervals.length ? day.intervals.map(item => item.label) : ['当天暂无已预约时段'];
      const lines = wrapTokens(ctx, tokens, 880);
      return { ...day, lines, height: 122 + lines.length * (fontSize + 22) };
    });
    const totalHeight = cards.reduce((sum, card) => sum + card.height, 0) + Math.max(0, cards.length - 1) * 24;
    if (totalHeight <= 1000) return { cards, fontSize };
  }
  throw new Error('预约时段较多，请缩短日期后分别生成分享图。');
}

function resolveCanvas(page) {
  return new Promise((resolve, reject) => {
    wx.createSelectorQuery().in(page).select('#shareCanvas').fields({ node: true, size: true }).exec(result => {
      const canvas = result && result[0] && result[0].node;
      if (canvas) resolve(canvas); else reject(new Error('分享画布暂时无法使用，请重新打开后再试。'));
    });
  });
}

function loadCanvasImage(canvas, src) {
  return new Promise((resolve, reject) => {
    wx.getImageInfo({
      src,
      success(info) {
        const image = canvas.createImage();
        image.onload = () => resolve(image);
        image.onerror = () => reject(new Error('小天使素材读取失败，请重新打开后再试。'));
        image.src = info.path;
      },
      fail: () => reject(new Error('小天使素材读取失败，请重新打开后再试。')),
    });
  });
}

Page({
  data: {
    loading: true,
    working: false,
    error: '',
    isAdmin: false,
    admin: null,
    ownerBindingStatus: 'pending',
    setupCode: '',
    inviteInput: '',
    inviteCode: '',
    inviteExpiresAt: '',
    inviteeDisplayName: '白兰',
    hasInviteToken: false,
    accessDenied: false,
    pending: [],
    confirmed: [],
    cancelled: [],
    admins: [],
    historyPreset: 'day',
    historyAnchorDate: INITIAL_HISTORY_DATE,
    historyStartDate: INITIAL_HISTORY_DATE,
    historyEndDate: INITIAL_HISTORY_DATE,
    historyRangeText: '',
    historyRecords: [],
    historyLoading: false,
    historyError: '',
    historyHasMore: false,
    historyStatusFilter: 'all',
    historyMonth: INITIAL_HISTORY_DATE.slice(0, 7),
    historyWeekMonth: INITIAL_HISTORY_DATE.slice(0, 7),
    historyWeeks: [],
    historyWeekIndex: 0,
    historyWeekLabel: '',
    historyNextOffset: 0,
    restExpanded: false, restLoading: false, restWorking: false, restReady: false,
    restBlocks: [], restHasMore: false, restError: '', restNote: '',
    restStartDate: '', restStartTime: '', restEndDate: '', restEndTime: '',
    shareExpanded: false, sharePreset: 'day', shareLoading: false, shareGenerating: false, shareReady: false,
    shareStartDate: INITIAL_HISTORY_DATE, shareEndDate: INITIAL_HISTORY_DATE, shareMaxEnd: addDays(INITIAL_HISTORY_DATE, 2),
    shareSchedule: [], shareRangeText: '', sharePosterPath: '', shareError: '',
    defaultRestMessage: DEFAULT_REST_MESSAGE, today: INITIAL_HISTORY_DATE,
  },

  onLoad(options) {
    this.enteredAt = Date.now();
    const today = todayDate();
    const data = { today, ...makeRestDraft(), historyAnchorDate: today, historyMonth: today.slice(0, 7), historyWeekMonth: today.slice(0, 7), historyStartDate: today, historyEndDate: today,
      shareStartDate: today, shareEndDate: today, shareMaxEnd: addDays(today, 2) };
    if (options && options.invite) {
      data.inviteInput = String(options.invite).toUpperCase();
      data.hasInviteToken = true;
    }
    if (Object.keys(data).length) this.setData(data);
    this.setWeekOptions(today.slice(0, 7), today);
  },

  onShareAppMessage(options = {}) {
    if (options.target && options.target.dataset && options.target.dataset.kind === 'schedule' && this.data.sharePosterPath) {
      return { title: '秀亚美容馆 · 预约小提醒', path: '/pages/home/index', imageUrl: this.data.sharePosterPath };
    }
    const query = this.data.inviteCode ? `?invite=${encodeURIComponent(this.data.inviteCode)}` : '';
    return {
      title: '秀亚美容馆共同店主邀请',
      path: `/pages/owner/index${query}`,
    };
  },

  onShow() {
    this.loadDashboard().then(() => {
      if (this.data.isAdmin) this.loadHistory();
      if (this.data.isAdmin && this.data.restExpanded) this.loadRestBlocks();
      if (this.data.isAdmin && this.data.shareExpanded) this.loadShareSchedule();
    });
  },

  onHide() {
    this.dashboardVersion = (this.dashboardVersion || 0) + 1;
    this.historyRequestVersion = (this.historyRequestVersion || 0) + 1;
    this.restVersion = (this.restVersion || 0) + 1;
    this.shareVersion = (this.shareVersion || 0) + 1;
    this.setData({ isAdmin: false, admin: null, pending: [], confirmed: [], cancelled: [], admins: [], historyRecords: [], historyLoading: false, restBlocks: [], restReady: false,
      shareSchedule: [], shareReady: false, shareLoading: false, shareGenerating: false, shareRangeText: '', sharePosterPath: '' });
  },

  onPullDownRefresh() {
    this.loadDashboard().then(() => Promise.all([
      this.loadHistory(),
      this.data.restExpanded ? this.loadRestBlocks() : Promise.resolve(),
      this.data.shareExpanded ? this.loadShareSchedule() : Promise.resolve(),
    ])).finally(() => wx.stopPullDownRefresh());
  },

  toggleRestPanel() {
    this.setData({ restExpanded: !this.data.restExpanded });
    if (this.data.restExpanded) this.loadRestBlocks();
  },

  toggleSharePanel() {
    const shareExpanded = !this.data.shareExpanded;
    this.setData({ shareExpanded });
    if (shareExpanded && !this.data.shareReady) this.loadShareSchedule();
  },

  resetShareResult(data = {}) {
    this.shareVersion = (this.shareVersion || 0) + 1;
    this.setData({ shareSchedule: [], shareReady: false, shareRangeText: '', sharePosterPath: '', shareError: '', ...data });
  },

  selectSharePreset(event) {
    const preset = event.currentTarget.dataset.preset;
    if (!['day', 'threeDays', 'custom'].includes(preset) || this.data.shareLoading || this.data.shareGenerating) return;
    const today = todayDate();
    if (preset === 'day') this.resetShareResult({ sharePreset: preset, shareStartDate: today, shareEndDate: today, shareMaxEnd: addDays(today, 2) });
    else if (preset === 'threeDays') this.resetShareResult({ sharePreset: preset, shareStartDate: today, shareEndDate: addDays(today, 2), shareMaxEnd: addDays(today, 2) });
    else this.resetShareResult({ sharePreset: preset, shareMaxEnd: addDays(this.data.shareStartDate, 2) });
  },

  changeShareDate(event) {
    if (this.data.shareLoading || this.data.shareGenerating) return;
    const field = event.currentTarget.dataset.field;
    if (!['shareStartDate', 'shareEndDate'].includes(field)) return;
    const value = String(event.detail.value || '');
    const next = { sharePreset: 'custom', [field]: value };
    if (field === 'shareStartDate') {
      next.shareMaxEnd = addDays(value, 2);
      if (this.data.shareEndDate < value || this.data.shareEndDate > next.shareMaxEnd) next.shareEndDate = value;
    }
    this.resetShareResult(next);
  },

  async loadShareSchedule() {
    if (!this.data.isAdmin) return false;
    try { shareDates(this.data.shareStartDate, this.data.shareEndDate); }
    catch (error) { this.setData({ shareReady: false, shareSchedule: [], sharePosterPath: '', shareError: error.message }); return false; }
    const version = this.shareVersion = (this.shareVersion || 0) + 1;
    this.setData({ shareLoading: true, shareReady: false, shareSchedule: [], shareRangeText: '', sharePosterPath: '', shareError: '' });
    try {
      const result = await this.call('ownerAppointments', { action: 'shareSchedule', startDate: this.data.shareStartDate, endDate: this.data.shareEndDate });
      if (version !== this.shareVersion || !this.data.isAdmin) return false;
      const schedule = normalizeShareSchedule(result.appointments, this.data.shareStartDate, this.data.shareEndDate);
      this.setData({ shareSchedule: schedule, shareRangeText: shareRangeText(this.data.shareStartDate, this.data.shareEndDate), shareReady: true });
      return true;
    } catch (error) {
      if (version === this.shareVersion) this.setData({ shareReady: false, shareSchedule: [], shareError: error.message });
      return false;
    } finally {
      if (version === this.shareVersion) this.setData({ shareLoading: false });
    }
  },

  drawSharePoster(canvas, angel) {
    canvas.width = 1080;
    canvas.height = 1600;
    const ctx = canvas.getContext('2d');
    const { cards, fontSize } = posterLayout(ctx, this.data.shareSchedule);
    ctx.clearRect(0, 0, 1080, 1600);
    ctx.fillStyle = '#fff6e4';
    ctx.fillRect(0, 0, 1080, 1600);
    ctx.fillStyle = '#f7dfb8';
    ctx.beginPath(); ctx.arc(980, 90, 150, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#f1cdd1';
    ctx.beginPath(); ctx.arc(75, 1510, 190, 0, Math.PI * 2); ctx.fill();
    ctx.drawImage(angel, 46, 50, 275, 275);

    ctx.fillStyle = '#70452f';
    ctx.font = '700 68px sans-serif';
    ctx.fillText('秀亚美容馆', 330, 132);
    ctx.fillStyle = '#a3634a';
    ctx.font = '600 44px sans-serif';
    ctx.fillText('叮咚！预约小提醒', 334, 205);
    ctx.fillStyle = '#7b6254';
    ctx.font = '32px sans-serif';
    ctx.fillText('请避开下面已被预约的时间，安排会更从容～', 334, 265);

    ctx.fillStyle = '#fffdfa';
    roundedRect(ctx, 70, 310, 940, 72, 30); ctx.fill();
    ctx.strokeStyle = '#e5cda7'; ctx.lineWidth = 3; ctx.stroke();
    ctx.fillStyle = '#7d5a43'; ctx.font = '600 31px sans-serif'; ctx.textAlign = 'center';
    ctx.fillText(this.data.shareRangeText, 540, 357);
    ctx.textAlign = 'left';

    let y = 405;
    cards.forEach(card => {
      ctx.fillStyle = '#fffdf8';
      roundedRect(ctx, 70, y, 940, card.height, 34); ctx.fill();
      ctx.strokeStyle = '#ead7b7'; ctx.lineWidth = 3; ctx.stroke();
      ctx.fillStyle = '#8b5d3f'; ctx.font = '700 38px sans-serif';
      ctx.fillText(card.label, 112, y + 62);
      ctx.fillStyle = '#d59b73';
      roundedRect(ctx, 820, y + 29, 140, 48, 24); ctx.fill();
      ctx.fillStyle = '#fff'; ctx.font = '600 25px sans-serif'; ctx.textAlign = 'center';
      ctx.fillText(card.intervals.length ? '已约时段' : '轻松可约', 890, y + 62);
      ctx.textAlign = 'left';
      ctx.fillStyle = card.intervals.length ? '#49392f' : '#87786e';
      ctx.font = `${card.intervals.length ? '700' : '500'} ${fontSize}px sans-serif`;
      card.lines.forEach((line, index) => ctx.fillText(line, 112, y + 122 + index * (fontSize + 22)));
      y += card.height + 24;
    });

    ctx.fillStyle = '#725948'; ctx.font = '600 28px sans-serif'; ctx.textAlign = 'center';
    ctx.fillText('时间已包含护理与整理缓冲，请以小程序实时可约时间为准', 540, 1510);
    ctx.fillStyle = '#ad8065'; ctx.font = '26px sans-serif';
    ctx.fillText('秀亚美容馆 · 让每一次相见都刚刚好', 540, 1554);
    ctx.textAlign = 'left';
  },

  async generateSharePoster() {
    if (!this.data.isAdmin || this.data.shareLoading || this.data.shareGenerating) return;
    if (!this.data.shareReady && !(await this.loadShareSchedule())) return;
    const version = this.shareVersion;
    this.setData({ shareGenerating: true, sharePosterPath: '', shareError: '' });
    try {
      const canvas = await resolveCanvas(this);
      const angel = await loadCanvasImage(canvas, SHARE_ANGEL_PATH);
      if (version !== this.shareVersion || !this.data.isAdmin) return;
      this.drawSharePoster(canvas, angel);
      const tempFilePath = await new Promise((resolve, reject) => wx.canvasToTempFilePath({
        canvas, width: 1080, height: 1600, destWidth: 1080, destHeight: 1600, fileType: 'png', quality: 1,
        success: result => resolve(result.tempFilePath), fail: reject,
      }));
      if (version !== this.shareVersion || !this.data.isAdmin) return;
      this.setData({ sharePosterPath: tempFilePath });
      wx.showToast({ title: '分享图已生成', icon: 'success' });
    } catch (error) {
      if (version === this.shareVersion) this.setData({ sharePosterPath: '', shareError: error.message || '分享图生成失败，请重试。' });
    } finally {
      if (version === this.shareVersion) this.setData({ shareGenerating: false });
    }
  },

  previewSharePoster() {
    if (this.data.sharePosterPath) wx.previewImage({ current: this.data.sharePosterPath, urls: [this.data.sharePosterPath] });
  },

  saveSharePoster() {
    if (!this.data.sharePosterPath) return;
    wx.saveImageToPhotosAlbum({
      filePath: this.data.sharePosterPath,
      success: () => wx.showToast({ title: '已保存到相册', icon: 'success' }),
      fail: error => {
        const denied = /auth deny|authorize:fail/i.test(String(error && error.errMsg));
        wx.showModal({
          title: denied ? '需要相册权限' : '保存没有成功',
          content: denied ? '请在设置中允许保存到相册，再回来重试。' : '请稍后重试，或先预览后长按保存。',
          confirmText: denied ? '打开设置' : '知道了', showCancel: denied,
          success: result => { if (denied && result.confirm) wx.openSetting(); },
        });
      },
    });
  },

  async loadRestBlocks() {
    if (!this.data.isAdmin) return;
    const version = this.restVersion = (this.restVersion || 0) + 1;
    this.setData({ restLoading: true, restError: '' });
    try {
      const result = await this.call('ownerAppointments', { action: 'restList' });
      if (version !== this.restVersion || !this.data.isAdmin) return;
      this.setData({ restBlocks: decorateRestNotices(result.blocks), restHasMore: result.hasMore === true, restReady: true });
    } catch (error) {
      if (version === this.restVersion) this.setData({ restReady: false, restBlocks: [], restError: error.message });
    } finally {
      if (version === this.restVersion) this.setData({ restLoading: false });
    }
  },

  updateRestField(event) {
    if (this.data.restWorking) return;
    const field = event.currentTarget.dataset.field;
    if (!['restStartDate', 'restStartTime', 'restEndDate', 'restEndTime', 'restNote'].includes(field)) return;
    this.setData({ [field]: String(event.detail.value).slice(0, field === 'restNote' ? 200 : 10), restError: '' });
    this.restRequestId = '';
  },

  async saveRest() {
    if (this.data.restWorking || !this.data.isAdmin || !this.data.restReady) return;
    const { restStartDate, restStartTime, restEndDate, restEndTime, restNote } = this.data;
    const start = Date.parse(`${restStartDate}T${restStartTime}:00+08:00`);
    const end = Date.parse(`${restEndDate}T${restEndTime}:00+08:00`);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start || end <= Date.now() || end - start > 31 * 86400000) {
      this.setData({ restError: '结束时间要晚于开始和当前时间，单段最多31天。' });
      return;
    }
    this.setData({ restWorking: true, restError: '' });
    const confirmed = await new Promise(resolve => wx.showModal({
      title: '安排这段休息？', content: `${restStartDate} ${restStartTime} 至 ${restEndDate} ${restEndTime}\n客人将看到：${restNote.trim() || DEFAULT_REST_MESSAGE}`,
      confirmText: '安排休息', confirmColor: '#26734f', success: result => resolve(result.confirm), fail: () => resolve(false),
    }));
    if (!confirmed) { this.setData({ restWorking: false }); return; }
    this.restRequestId = this.restRequestId || `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    try {
      await this.call('ownerAppointments', { action: 'restCreate', startDate: restStartDate, startTime: restStartTime, endDate: restEndDate, endTime: restEndTime, note: restNote.trim(), requestId: this.restRequestId });
      this.restRequestId = '';
      this.setData({ restNote: '' });
      wx.showToast({ title: '休息已安排', icon: 'success' });
      await this.loadRestBlocks();
    } catch (error) {
      this.setData({ restError: error.message });
    } finally { this.setData({ restWorking: false }); }
  },

  async cancelRest(event) {
    if (this.data.restWorking || !this.data.isAdmin) return;
    const block = this.data.restBlocks.find(item => item.id === event.currentTarget.dataset.id);
    if (!block) return;
    this.setData({ restWorking: true, restError: '' });
    const confirmed = await new Promise(resolve => wx.showModal({
      title: '恢复这段时间接单？', content: block.timeLabel,
      confirmText: '恢复接单', confirmColor: '#26734f', success: result => resolve(result.confirm), fail: () => resolve(false),
    }));
    if (!confirmed) { this.setData({ restWorking: false }); return; }
    try {
      await this.call('ownerAppointments', { action: 'restCancel', blockId: block.id });
      wx.showToast({ title: '已恢复接单', icon: 'success' });
      await this.loadRestBlocks();
    } catch (error) { this.setData({ restError: error.message }); }
    finally { this.setData({ restWorking: false }); }
  },

  async call(name, data) {
    const response = await wx.cloud.callFunction({ name, data });
    const result = response.result || {};
    if (!result.ok) {
      const action = String(data.action || '');
      if (result.code === 'UNKNOWN_ACTION' && action.startsWith('rest')) throw new Error('休息功能的云端接口尚未更新，更新后即可使用。');
      if (result.code === 'UNKNOWN_ACTION' && action === 'shareSchedule') throw new Error('预约分享的云端接口尚未更新，更新后即可使用。');
      throw new Error(result.message || '操作失败，请稍后重试');
    }
    return result;
  },

  async loadDashboard() {
    const version = this.dashboardVersion = (this.dashboardVersion || 0) + 1;
    this.setData({ loading: true, error: '' });
    try {
      const context = await this.call('ownerAppointments', { action: 'dashboard' });
      if (version !== this.dashboardVersion) return;
      const base = {
        isAdmin: context.isAdmin,
        admin: context.admin,
        ownerBindingStatus: context.ownerBindingStatus,
      };
      if (!context.isAdmin) {
        const accessDenied = context.ownerBindingStatus === 'bound' && !this.data.hasInviteToken;
        this.setData({ ...base, accessDenied, pending: [], confirmed: [], cancelled: [], admins: [] });
        if (accessDenied && !this.denialHandled) {
          this.denialHandled = true;
          wx.showModal({
            title: '当前微信没有店主权限',
            content: '店主预约台仅限创始人和受邀共同店主。',
            showCancel: false,
            success: () => wx.redirectTo({ url: '/pages/home/index' }),
          });
        }
        return;
      }

      this.setData({
        ...base,
        accessDenied: false,
        pending: context.pending || [],
        confirmed: context.confirmed || [],
        cancelled: context.cancelled || [],
        admins: context.admins || [],
      });
      this.dashboardReadyMs = Date.now() - this.enteredAt;
    } catch (error) {
      if (version === this.dashboardVersion) this.setData({ isAdmin: false, admin: null, pending: [], confirmed: [], cancelled: [], admins: [], historyRecords: [], error: error.message || '暂时无法打开店主预约台' });
    } finally {
      if (version === this.dashboardVersion) this.setData({ loading: false });
    }
  },

  updateField(event) {
    const field = event.currentTarget.dataset.field;
    if (!['setupCode', 'inviteInput', 'inviteeDisplayName'].includes(field) || this.data.working) return;
    this.setData({ [field]: event.detail.value, error: '' });
  },

  async claimPrimary() {
    if (this.data.working) return;
    this.setData({ working: true, error: '' });
    try {
      await this.call('ownerAccess', {
        action: 'claimPrimary',
        setupCode: this.data.setupCode,
      });
      wx.showToast({ title: '创始人已绑定', icon: 'success' });
      await this.loadDashboard();
    } catch (error) {
      this.setData({ error: error.message || '绑定失败' });
    } finally {
      this.setData({ working: false });
    }
  },

  async createInvite() {
    if (this.data.working) return;
    this.setData({ working: true, error: '' });
    try {
      const result = await this.call('ownerAccess', {
        action: 'createInvite',
        displayName: this.data.inviteeDisplayName.trim() || '白兰',
      });
      this.setData({
        inviteCode: result.inviteCode,
        inviteExpiresAt: result.expiresAt,
        inviteeDisplayName: result.displayName || this.data.inviteeDisplayName,
      });
      wx.setClipboardData({ data: result.inviteCode });
    } catch (error) {
      this.setData({ error: error.message || '邀请码生成失败' });
    } finally {
      this.setData({ working: false });
    }
  },

  copyInvite() {
    if (!this.data.inviteCode) return;
    wx.setClipboardData({ data: this.data.inviteCode });
  },

  async acceptInvite() {
    if (this.data.working) return;
    if (!this.data.inviteInput.trim()) {
      this.setData({ error: '请填写共同店主邀请码' });
      return;
    }
    this.setData({ working: true, error: '' });
    try {
      await this.call('ownerAccess', {
        action: 'acceptInvite',
        inviteCode: this.data.inviteInput.trim(),
      });
      wx.showToast({ title: '共同店主已启用', icon: 'success' });
      await this.loadDashboard();
    } catch (error) {
      this.setData({ error: error.message || '邀请码使用失败' });
    } finally {
      this.setData({ working: false });
    }
  },

  async toggleAdmin(event) {
    if (this.data.working) return;
    const active = event.currentTarget.dataset.active === true || event.currentTarget.dataset.active === 'true';
    this.setData({ working: true, error: '' });
    try {
      await this.call('ownerAccess', {
        action: 'setAdminActive',
        adminId: event.currentTarget.dataset.id,
        active,
      });
      wx.showToast({ title: active ? '权限已启用' : '权限已停用', icon: 'success' });
      await this.loadDashboard();
    } catch (error) {
      this.setData({ error: error.message || '权限修改失败' });
    } finally {
      this.setData({ working: false });
    }
  },

  selectHistoryPreset(event) {
    const preset = event.currentTarget.dataset.preset;
    if (!['day', 'week', 'month', 'custom'].includes(preset)) return;
    const today = todayDate();
    if (preset === 'week') this.setWeekOptions(today.slice(0, 7), today);
    if (preset === 'month') this.setData({ historyMonth: today.slice(0, 7) });
    this.setData({ historyPreset: preset, historyError: '' });
    this.loadHistory();
  },

  selectHistoryStatus(event) {
    const filter = event.currentTarget.dataset.filter;
    if (!['all', 'booked', 'cancelled'].includes(filter)) return;
    this.setData({ historyStatusFilter: filter });
    this.loadHistory();
  },

  setWeekOptions(month, preferredDate) {
    const weeks = weeksForMonth(month);
    let index = weeks.findIndex(week => week.startDate <= preferredDate && week.endDate >= preferredDate);
    if (index < 0) index = 0;
    this.setData({ historyWeekMonth: month, historyWeeks: weeks, historyWeekIndex: index, historyWeekLabel: weeks[index].label });
  },

  changeHistoryMonth(event) {
    const value = event.detail.value.slice(0, 7);
    if (this.data.historyPreset === 'week') this.setWeekOptions(value, todayDate());
    else this.setData({ historyMonth: value });
    this.loadHistory();
  },

  changeHistoryWeek(event) {
    const index = Number(event.detail.value);
    if (!this.data.historyWeeks[index]) return;
    this.setData({ historyWeekIndex: index, historyWeekLabel: this.data.historyWeeks[index].label });
    this.loadHistory();
  },

  changeHistoryDate(event) {
    const field = event.currentTarget.dataset.field;
    if (!['historyAnchorDate', 'historyStartDate', 'historyEndDate'].includes(field)) return;
    this.setData({ [field]: event.detail.value, historyError: '' });
    if (this.data.historyPreset === 'day') this.loadHistory();
  },

  loadMoreHistory() { return this.loadHistory({ append: true }); },

  async loadHistory(options = {}) {
    if (!this.data.isAdmin) return;
    const append = options.append === true;
    if (append && this.data.historyLoading) return;
    const version = this.historyRequestVersion = (this.historyRequestVersion || 0) + 1;
    let range;
    try {
      range = this.data.historyPreset === 'week'
        ? this.data.historyWeeks[this.data.historyWeekIndex]
        : rangeFor(
        this.data.historyPreset,
        this.data.historyPreset === 'month' ? `${this.data.historyMonth}-01` : this.data.historyAnchorDate,
        this.data.historyStartDate,
        this.data.historyEndDate,
      );
    } catch (error) {
      this.setData({ historyLoading: false, historyRecords: [], historyError: error.message || '查询日期不正确' });
      return;
    }
    this.setData({ historyLoading: true, historyError: '', ...(append ? {} : { historyRecords: [], historyHasMore: false }) });
    try {
      const result = await this.call('ownerAppointments', {
        action: 'query',
        startDate: range.startDate,
        endDate: range.endDate,
        statusFilter: this.data.historyStatusFilter,
        offset: append ? this.data.historyNextOffset : 0,
      });
      if (version !== this.historyRequestVersion) return;
      this.setData({
        historyStartDate: range.startDate,
        historyEndDate: range.endDate,
        historyRangeText: range.startDate === range.endDate
          ? range.startDate
          : `${range.startDate} 至 ${range.endDate}`,
        historyRecords: append ? [...this.data.historyRecords, ...(result.records || [])] : result.records || [],
        historyHasMore: result.hasMore === true,
        historyNextOffset: result.nextOffset || 0,
      });
    } catch (error) {
      if (version === this.historyRequestVersion) this.setData({ historyError: error.message || '预约记录查询失败' });
    } finally {
      if (version === this.historyRequestVersion) this.setData({ historyLoading: false });
    }
  },

  async confirmAppointment(event) {
    if (this.data.working) return;
    const appointmentId = event.currentTarget.dataset.id;
    const confirmed = await new Promise((resolve) => {
      wx.showModal({
        title: '接受这条预约？',
        content: '确认后，客人会看到“白兰已接受您的预约”。',
        confirmText: '接受预约',
        confirmColor: '#26734f',
        success: (result) => resolve(result.confirm),
        fail: () => resolve(false),
      });
    });
    if (!confirmed) return;
    this.setData({ working: true, error: '' });
    try {
      await this.call('ownerAppointments', { action: 'confirm', appointmentId });
      wx.showToast({ title: '预约已接受', icon: 'success' });
      await this.loadDashboard();
    } catch (error) {
      this.setData({ error: error.message || '确认预约失败' });
    } finally {
      this.setData({ working: false });
    }
  },

  async cancelAppointment(event) {
    if (this.data.working) return;
    const appointmentId = event.currentTarget.dataset.id;
    const confirmed = await new Promise((resolve) => {
      wx.showModal({
        title: '取消这条预约？',
        content: '取消后会立即释放这个时间，客人端将显示“已取消”。',
        confirmText: '确认取消',
        confirmColor: '#9b3b3b',
        success: (result) => resolve(result.confirm),
        fail: () => resolve(false),
      });
    });
    if (!confirmed) return;
    this.setData({ working: true, error: '' });
    try {
      const result = await this.call('ownerAppointments', { action: 'cancel', appointmentId });
      const cancelled = result.appointment;
      this.setData({
        pending: this.data.pending.filter((item) => item.id !== appointmentId),
        confirmed: this.data.confirmed.filter((item) => item.id !== appointmentId),
        cancelled: [cancelled, ...this.data.cancelled.filter((item) => item.id !== appointmentId)],
      });
      wx.showToast({ title: '预约已取消', icon: 'success' });
    } catch (error) {
      const message = error.message || '取消预约失败';
      this.setData({ error: message });
      wx.showModal({ title: '取消未成功', content: message, showCancel: false });
    } finally {
      this.setData({ working: false });
      this.loadDashboard();
    }
  },
});
