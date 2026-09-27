const { rangeFor, todayDate, weeksForMonth } = require('../../utils/history-range');
const { DEFAULT_REST_MESSAGE, decorateRestNotices, makeRestDraft } = require('../../utils/rest-notices');
const { addDays, shareDates, normalizeShareSchedule, shareRangeText, shareVideoKind } = require('../../utils/share-schedule');
const { loadCanvasImage } = require('../../utils/canvas-image');

const INITIAL_HISTORY_DATE = todayDate();
const SHARE_ANGEL_PATH = '/assets/share-angel-cream.png';
const SHARE_ANGEL_SPEAKING_PATH = '/assets/share-angel-cream-speaking-compact.png';

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

function posterLayout(ctx, schedule) {
  if (schedule.length === 1) {
    const day = schedule[0];
    const count = day.intervals.length;
    const rowStep = count > 1 ? Math.min(118, Math.floor(512 / (count - 1))) : 118;
    let fontSize = Math.min(60, rowStep - 10);
    while (fontSize > 30) {
      ctx.font = `700 ${fontSize}px sans-serif`;
      if (day.intervals.every(item => ctx.measureText(item.label).width <= 560)) break;
      fontSize -= 2;
    }
    const height = Math.max(544, 338 + Math.max(0, count - 1) * rowStep);
    if (fontSize < 30 || height > 850) throw new Error('预约时段较多，请缩短日期后分别生成分享图。');
    return {
      cards: [{ ...day, height, rowStep }],
      fontSize,
      rowStep,
      singleDay: true,
      cardGap: 0,
    };
  }

  const cardGap = 24;
  const maxTotalHeight = 900;
  const maxCardHeight = (maxTotalHeight - cardGap * (schedule.length - 1)) / schedule.length;
  const maxIntervals = Math.max(0, ...schedule.map(day => day.intervals.length));
  const rowStep = maxIntervals
    ? Math.min(56, Math.floor((maxCardHeight - 92) / maxIntervals))
    : 56;
  let fontSize = Math.min(44, rowStep - 8);
  while (fontSize > 30) {
    ctx.font = `700 ${fontSize}px sans-serif`;
    if (schedule.every(day => day.intervals.every(item => ctx.measureText(item.label).width <= 820))) break;
    fontSize -= 2;
  }
  if (fontSize < 30 || rowStep < 38) throw new Error('预约时段较多，请缩短日期后分别生成分享图。');

  const cards = schedule.map(day => ({
    ...day,
    rowStep,
    height: day.intervals.length ? 92 + day.intervals.length * rowStep : 204,
  }));
  const totalHeight = cards.reduce((sum, card) => sum + card.height, 0) + cardGap * (cards.length - 1);
  if (totalHeight > maxTotalHeight) throw new Error('预约时段较多，请缩短日期后分别生成分享图。');
  return { cards, fontSize, rowStep, singleDay: false, cardGap };
}

function resolveCanvas(page) {
  return new Promise((resolve, reject) => {
    wx.createSelectorQuery().in(page).select('#shareCanvas').fields({ node: true, size: true }).exec(result => {
      const canvas = result && result[0] && result[0].node;
      if (canvas) resolve(canvas); else reject(new Error('分享画布暂时无法使用，请重新打开后再试。'));
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
    shareAnimationText: '', shareAnimationPlaying: false, shareVideoBasePath: '', shareVideoPath: '', shareVideoKind: '', shareVideoWorking: false,
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
    if (this.shareAnimationTimer != null) clearTimeout(this.shareAnimationTimer);
    this.shareAnimationTimer = null;
    this.setData({ isAdmin: false, admin: null, pending: [], confirmed: [], cancelled: [], admins: [], historyRecords: [], historyLoading: false, restBlocks: [], restReady: false,
      shareSchedule: [], shareReady: false, shareLoading: false, shareGenerating: false, shareRangeText: '', sharePosterPath: '', shareAnimationText: '', shareAnimationPlaying: false, shareVideoBasePath: '', shareVideoPath: '', shareVideoKind: '', shareVideoWorking: false });
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
    if (this.shareAnimationTimer != null) clearTimeout(this.shareAnimationTimer);
    this.shareAnimationTimer = null;
    this.setData({ shareSchedule: [], shareReady: false, shareRangeText: '', sharePosterPath: '', shareError: '', shareAnimationText: '', shareAnimationPlaying: false, shareVideoBasePath: '', shareVideoPath: '', shareVideoKind: '', ...data });
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
    if (this.shareAnimationTimer != null) clearTimeout(this.shareAnimationTimer);
    this.shareAnimationTimer = null;
    try { shareDates(this.data.shareStartDate, this.data.shareEndDate); }
    catch (error) { this.setData({ shareReady: false, shareSchedule: [], sharePosterPath: '', shareError: error.message }); return false; }
    const version = this.shareVersion = (this.shareVersion || 0) + 1;
    this.setData({ shareLoading: true, shareReady: false, shareSchedule: [], shareRangeText: '', sharePosterPath: '', shareError: '', shareAnimationText: '', shareAnimationPlaying: false, shareVideoBasePath: '', shareVideoPath: '', shareVideoKind: '' });
    try {
      const result = await this.call('ownerAppointments', { action: 'shareSchedule', startDate: this.data.shareStartDate, endDate: this.data.shareEndDate });
      if (version !== this.shareVersion || !this.data.isAdmin) return false;
      const schedule = normalizeShareSchedule(result.appointments, this.data.shareStartDate, this.data.shareEndDate, result.dayAvailability);
      this.setData({ shareSchedule: schedule, shareRangeText: shareRangeText(this.data.shareStartDate, this.data.shareEndDate), shareReady: true });
      return true;
    } catch (error) {
      if (version === this.shareVersion) this.setData({ shareReady: false, shareSchedule: [], shareError: error.message });
      return false;
    } finally {
      if (version === this.shareVersion) this.setData({ shareLoading: false });
    }
  },

  drawSharePoster(canvas, angel, speakingAngel, speechText = '', motionBase = false) {
    canvas.width = 1080;
    canvas.height = 1600;
    const ctx = canvas.getContext('2d');
    const schedule = this.data.shareSchedule || [];
    const booked = shareVideoKind(schedule) === 'booked';
    const { cards, fontSize, rowStep, singleDay, cardGap } = posterLayout(ctx, schedule);
    ctx.clearRect(0, 0, 1080, 1600);
    const background = typeof ctx.createLinearGradient === 'function'
      ? ctx.createLinearGradient(0, 0, 0, 1600) : null;
    if (background && background.addColorStop) {
      background.addColorStop(0, '#fffaf1');
      background.addColorStop(1, '#f8eee1');
    }
    ctx.fillStyle = background || '#fff6e4';
    ctx.fillRect(0, 0, 1080, 1600);
    ctx.globalAlpha = 0.38;
    ctx.fillStyle = '#f7dfb8';
    ctx.beginPath(); ctx.arc(980, 90, 150, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#f1cdd1';
    ctx.beginPath(); ctx.arc(75, 1510, 190, 0, Math.PI * 2); ctx.fill();
    ctx.globalAlpha = 1;

    ctx.fillStyle = '#70452f';
    ctx.font = '700 70px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('秀亚美容馆', 540, 88);
    ctx.fillStyle = '#a3634a';
    ctx.font = '600 30px sans-serif';
    ctx.fillText('叮咚！预约小提醒', 540, 190);
    ctx.strokeStyle = '#dfb875';
    ctx.lineWidth = 4;
    ctx.beginPath(); ctx.moveTo(452, 262); ctx.lineTo(628, 262); ctx.stroke();
    ctx.fillStyle = '#786758';
    ctx.font = '32px sans-serif';
    ctx.fillText('看看已约时段，再挑个合适时间～', 540, 320);

    ctx.fillStyle = '#fffdfa';
    roundedRect(ctx, 72, 422, 936, 104, 32); ctx.fill();
    ctx.strokeStyle = '#e8d4b6'; ctx.lineWidth = 3; ctx.stroke();
    ctx.fillStyle = '#70462f';
    ctx.font = '700 48px sans-serif';
    ctx.fillText(this.data.shareRangeText, 540, 474);

    const cardLeft = 72;
    const cardWidth = 936;
    let y = 554;
    cards.forEach((card, cardIndex) => {
      ctx.fillStyle = '#fffdf9';
      roundedRect(ctx, cardLeft, y, cardWidth, card.height, singleDay ? 38 : 32); ctx.fill();
      ctx.strokeStyle = '#e8d4b6'; ctx.lineWidth = 3; ctx.stroke();
      const statusText = card.intervals.length ? '已约时段'
        : card.allDayAvailable ? '全天可约'
          : card.hasAvailableTime ? '有空档' : '看实时安排';
      const badgeWidth = statusText === '全天可约' ? 176 : 148;
      ctx.fillStyle = card.intervals.length || !card.allDayAvailable ? '#e1b78e' : '#4b9b7c';
      roundedRect(ctx, 958 - badgeWidth, y + (singleDay ? 60 : 22), badgeWidth, singleDay ? 60 : 50, 28); ctx.fill();
      ctx.fillStyle = '#fff';
      ctx.font = '700 30px sans-serif';
      ctx.fillText(statusText, 958 - badgeWidth / 2, y + (singleDay ? 90 : 47));

      if (singleDay) {
        ctx.textAlign = 'left';
        ctx.fillStyle = '#70452f';
        ctx.font = '700 46px sans-serif';
        ctx.fillText(card.intervals.length ? '已确认预约'
          : card.date === todayDate() ? '今日可预约' : '预约空档提醒', 376, y + 62);
        ctx.strokeStyle = '#e2c79f'; ctx.lineWidth = 2;
        ctx.beginPath(); ctx.moveTo(376, y + 146); ctx.lineTo(942, y + 146); ctx.stroke();
        if (card.intervals.length) {
          ctx.fillStyle = '#63432f';
          ctx.font = '700 ' + fontSize + 'px sans-serif';
          card.intervals.forEach((item, index) => ctx.fillText(item.label, 376, y + 190 + index * rowStep));
          const lastLine = y + 190 + (card.intervals.length - 1) * rowStep;
          const divider = Math.max(y + 422, lastLine + 114);
          ctx.strokeStyle = '#e8d4b6';
          ctx.beginPath(); ctx.moveTo(376, divider); ctx.lineTo(942, divider); ctx.stroke();
          ctx.fillStyle = '#8c634c';
          ctx.font = '700 34px sans-serif';
          ctx.fillText('其他空档欢迎预约', 376, divider + 40);
        } else {
          const message = card.allDayAvailable ? '全天都可以约～'
            : card.hasAvailableTime ? (card.date === todayDate() ? '今天还有空档可约～' : '这天还有空档可约～')
              : '请打开小程序查看可约时段';
          let messageSize = card.allDayAvailable ? 60 : 52;
          while (messageSize > 36) {
            ctx.font = '700 ' + messageSize + 'px sans-serif';
            if (ctx.measureText(message).width <= 820) break;
            messageSize -= 2;
          }
          ctx.fillStyle = card.allDayAvailable ? '#246a53' : '#8c634c';
          ctx.font = '700 ' + messageSize + 'px sans-serif';
          ctx.textAlign = 'center';
          ctx.fillText(message, 540, y + 268);
          ctx.fillStyle = '#9a806a';
          ctx.font = '30px sans-serif';
          ctx.fillText('具体空档以小程序实时查询为准', 540, y + 352);
          ctx.textAlign = 'left';
        }
        if (!motionBase && card.intervals.length && angel) {
          const angelWidth = 214;
          ctx.drawImage(angel, 134, y + 132, angelWidth, angelWidth * angel.height / angel.width);
        }
      } else {
        ctx.textAlign = 'left';
        ctx.fillStyle = '#70452f';
        ctx.font = '700 40px sans-serif';
        ctx.fillText(card.label, 112, y + 47);
        ctx.strokeStyle = '#e2c79f'; ctx.lineWidth = 2;
        ctx.beginPath(); ctx.moveTo(112, y + 82); ctx.lineTo(968, y + 82); ctx.stroke();
        if (card.intervals.length) {
          ctx.fillStyle = '#63432f';
          ctx.font = '700 ' + fontSize + 'px sans-serif';
          card.intervals.forEach((item, index) => ctx.fillText(item.label, 376, y + 116 + index * rowStep));
        } else {
          const message = card.allDayAvailable ? '全天都可以约～'
            : card.hasAvailableTime ? '还有空档可约～' : '请查看实时可约时段';
          ctx.fillStyle = card.allDayAvailable ? '#246a53' : '#8c634c';
          ctx.font = '700 42px sans-serif';
          ctx.fillText(message, 376, y + 128);
        }
        if (!motionBase && booked && cardIndex === 0 && angel) {
          const angelWidth = 140;
          ctx.drawImage(angel, 92, y + 46, angelWidth, angelWidth * angel.height / angel.width);
        }
      }
      y += card.height + cardGap;
    });

    const bodyBottom = y - cardGap;
    if (!singleDay && bodyBottom < 1350 && (booked || !speechText)) {
      ctx.fillStyle = '#826a57';
      ctx.font = '34px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('期待与你在秀亚美容馆相见～', 540, bodyBottom + 54);
    }

    if (!motionBase && !booked && speechText && speakingAngel) {
      const availableHeight = Math.max(120, 1460 - bodyBottom - 52);
      const angelWidth = Math.max(100, Math.min(250, availableHeight * speakingAngel.width / speakingAngel.height));
      const angelHeight = angelWidth * speakingAngel.height / speakingAngel.width;
      const angelY = bodyBottom + 12;
      ctx.drawImage(speakingAngel, (1080 - angelWidth) / 2, angelY, angelWidth, angelHeight);
      const bubbleTop = angelY + angelHeight - 48;
      ctx.fillStyle = '#fffdfa';
      roundedRect(ctx, 180, bubbleTop, 720, 88, 36); ctx.fill();
      ctx.strokeStyle = '#ead7b7'; ctx.lineWidth = 3; ctx.stroke();
      ctx.fillStyle = '#70452f';
      let speechSize = 42;
      while (speechSize > 30) {
        ctx.font = '700 ' + speechSize + 'px sans-serif';
        if (ctx.measureText(speechText).width <= 660) break;
        speechSize -= 2;
      }
      ctx.font = '700 ' + speechSize + 'px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(speechText, 540, bubbleTop + 46);
    }

    if (singleDay && booked && bodyBottom < 1350) {
      ctx.fillStyle = '#826a57';
      ctx.font = '34px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('期待与你在秀亚美容馆相见～', 540, bodyBottom + 82);
    }
    ctx.fillStyle = '#725948'; ctx.font = '700 36px sans-serif'; ctx.textAlign = 'center';
    ctx.fillText('空档以小程序实时显示为准', 540, 1500);
    ctx.fillStyle = '#ad8065'; ctx.font = '600 32px sans-serif';
    ctx.fillText('秀亚美容馆 · 护理与整理时间已包含', 540, 1550);
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
  },

  async generateSharePoster() {
    if (!this.data.isAdmin || this.data.shareLoading || this.data.shareGenerating) return;
    if (!this.data.shareReady && !(await this.loadShareSchedule())) return;
    const version = this.shareVersion;
    const videoKind = shareVideoKind(this.data.shareSchedule);
    const emptyDays = videoKind === 'empty' ? this.data.shareSchedule : [];
    const hasAvailableDay = emptyDays.some(day => day.allDayAvailable || day.hasAvailableTime);
    const speechText = videoKind !== 'empty' ? ''
      : emptyDays.length === 1
        ? (hasAvailableDay
          ? `${emptyDays[0].date === todayDate() ? '今天' : '这天'}还有空档，等你来变美～`
          : `${emptyDays[0].date === todayDate() ? '今天' : '这天'}暂时没有可约时段～`)
        : (hasAvailableDay ? '这几天还有空档，等你来变美～' : '打开小程序看看可约时段～');
    if (this.shareAnimationTimer != null) clearTimeout(this.shareAnimationTimer);
    this.shareAnimationTimer = null;
    this.setData({ shareGenerating: true, sharePosterPath: '', shareError: '', shareAnimationText: '', shareAnimationPlaying: false, shareVideoBasePath: '', shareVideoPath: '', shareVideoKind: '' });
    try {
      const canvas = await resolveCanvas(this);
      const angel = await loadCanvasImage(canvas, SHARE_ANGEL_PATH);
      let speakingAngel = null;
      if (speechText) {
        try { speakingAngel = await loadCanvasImage(canvas, SHARE_ANGEL_SPEAKING_PATH); }
        catch (_) { speakingAngel = null; }
      }
      if (version !== this.shareVersion || !this.data.isAdmin) return;
      const finalSpeechText = speakingAngel ? speechText : '';
      this.drawSharePoster(canvas, angel, speakingAngel, finalSpeechText);
      const tempFilePath = await new Promise((resolve, reject) => wx.canvasToTempFilePath({
        canvas, width: 1080, height: 1600, destWidth: 1080, destHeight: 1600, fileType: 'png', quality: 1,
        success: result => resolve(result.tempFilePath), fail: reject,
      }));
      this.drawSharePoster(canvas, angel, speakingAngel, finalSpeechText, true);
      const videoBasePath = await new Promise((resolve, reject) => wx.canvasToTempFilePath({
        canvas, width: 1080, height: 1600, destWidth: 1080, destHeight: 1600, fileType: 'png', quality: 1,
        success: result => resolve(result.tempFilePath), fail: reject,
      }));
      if (version !== this.shareVersion || !this.data.isAdmin) return;
      this.setData({ sharePosterPath: tempFilePath, shareVideoBasePath: videoBasePath, shareVideoKind: videoKind, shareAnimationText: finalSpeechText, shareAnimationPlaying: Boolean(finalSpeechText) }, () => {
        if (finalSpeechText) this.scheduleShareAnimationFinish();
      });
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

  replayShareAnimation() {
    if (!this.data.sharePosterPath || !this.data.shareAnimationText) return;
    if (this.shareAnimationTimer != null) clearTimeout(this.shareAnimationTimer);
    this.shareAnimationTimer = null;
    this.setData({ shareAnimationPlaying: false }, () => {
      this.setData({ shareAnimationPlaying: true }, () => this.scheduleShareAnimationFinish());
    });
  },

  scheduleShareAnimationFinish() {
    if (this.shareAnimationTimer != null) clearTimeout(this.shareAnimationTimer);
    this.shareAnimationTimer = null;
    this.shareAnimationTimer = setTimeout(() => {
      this.shareAnimationTimer = null;
      if (this.data.shareAnimationPlaying) this.setData({ shareAnimationPlaying: false });
    }, 5400);
  },

  async saveShareVideo() {
    if (!this.data.isAdmin || !this.data.shareVideoBasePath || !this.data.shareVideoKind || this.data.shareVideoWorking) return;
    const version = this.shareVersion;
    this.setData({ shareVideoWorking: true, shareError: '' });
    let uploadedFileID = '';
    let finalFileID = '';
    let videoFileID = '';
    try {
      let filePath = this.data.shareVideoPath;
      if (!filePath) {
        const cloudPath = `share-video-input/${Date.now()}-${Math.random().toString(36).slice(2)}.png`;
        const uploaded = await wx.cloud.uploadFile({ cloudPath, filePath: this.data.shareVideoBasePath });
        uploadedFileID = uploaded.fileID;
        const kind = this.data.shareVideoKind;
        if (kind === 'empty') {
          const finalUpload = await wx.cloud.uploadFile({ cloudPath: cloudPath.replace('input/', 'input/final-'), filePath: this.data.sharePosterPath });
          finalFileID = finalUpload.fileID;
        }
        const dayCount = this.data.shareSchedule.length;
        const rendered = await this.call('sharePosterVideo', {
          fileID: uploadedFileID, finalFileID, kind,
          dayCount: Math.max(1, Math.min(3, dayCount)),
        });
        videoFileID = rendered.fileID;
        if (version !== this.shareVersion || !this.data.isAdmin) return;
        const downloaded = await wx.cloud.downloadFile({ fileID: videoFileID });
        filePath = downloaded.tempFilePath;
        if (!filePath) throw new Error('动态视频下载失败，请重试。');
        this.setData({ shareVideoPath: filePath });
      }
      await new Promise((resolve, reject) => wx.saveVideoToPhotosAlbum({ filePath, success: resolve, fail: reject }));
      wx.showToast({ title: '动态视频已保存', icon: 'success' });
    } catch (error) {
      const message = String(error && (error.errMsg || error.message) || error);
      const denied = /auth deny|authorize:fail|auth denied/i.test(message);
      if (denied) wx.showModal({ title: '需要相册权限', content: '请允许保存视频到相册，再回来重试。', confirmText: '打开设置', success: result => { if (result.confirm) wx.openSetting(); } });
      else this.setData({ shareError: /FunctionName|FUNCTION_NOT_FOUND|不存在/i.test(message)
        ? '动态视频云端接口尚未部署，请先更新云函数。' : `动态视频保存失败：${message}` });
    } finally {
      const fileList = [uploadedFileID, finalFileID, videoFileID].filter(Boolean);
      if (fileList.length) wx.cloud.deleteFile({ fileList }).catch(() => {});
      this.setData({ shareVideoWorking: false });
    }
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
