const DEFAULT_REST_MESSAGE = '白兰偷懒,正在深度休息中~';

function beijingDateTime(value) {
  const date = new Date(Date.parse(value) + 8 * 3600000);
  if (!Number.isFinite(date.getTime())) return '';
  const pad = n => String(n).padStart(2, '0');
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())} ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}`;
}

function decorateRestNotices(items = [], now = Date.now()) {
  return items.filter(item => Date.parse(item.endsAt) > now).map(item => ({
    ...item,
    message: String(item.message || item.note || '').trim() || DEFAULT_REST_MESSAGE,
    timeLabel: `${beijingDateTime(item.startsAt)} 至 ${beijingDateTime(item.endsAt)}`,
    stateLabel: Date.parse(item.startsAt) <= now ? '休息中' : '休息预告',
  }));
}

function makeRestDraft(now = Date.now()) {
  const start = Math.ceil((now + 60000) / 60000) * 60000;
  const from = beijingDateTime(new Date(start).toISOString());
  const to = beijingDateTime(new Date(start + 3600000).toISOString());
  return { restStartDate: from.slice(0, 10), restStartTime: from.slice(11), restEndDate: to.slice(0, 10), restEndTime: to.slice(11) };
}

module.exports = { DEFAULT_REST_MESSAGE, beijingDateTime, decorateRestNotices, makeRestDraft };
