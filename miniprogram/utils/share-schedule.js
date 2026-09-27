const DAY_MS = 24 * 60 * 60 * 1000;

function dateValue(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return NaN;
  const [year, month, day] = value.split('-').map(Number);
  const result = Date.UTC(year, month - 1, day);
  const parsed = new Date(result);
  return parsed.getUTCFullYear() === year && parsed.getUTCMonth() === month - 1 && parsed.getUTCDate() === day ? result : NaN;
}

function dateText(value) {
  const date = new Date(value);
  const pad = number => String(number).padStart(2, '0');
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
}

function addDays(value, days) {
  const parsed = dateValue(value);
  if (!Number.isFinite(parsed)) throw new Error('请选择正确的分享日期');
  return dateText(parsed + days * DAY_MS);
}

function shareDates(startDate, endDate) {
  const start = dateValue(startDate);
  const end = dateValue(endDate);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start || end - start > 2 * DAY_MS) {
    throw new Error('一次可分享1—3天，请重新选择日期');
  }
  const result = [];
  for (let cursor = start; cursor <= end; cursor += DAY_MS) result.push(dateText(cursor));
  return result;
}

function beijingParts(isoText) {
  const timestamp = Date.parse(isoText);
  if (!Number.isFinite(timestamp)) return null;
  const date = new Date(timestamp + 8 * 60 * 60 * 1000);
  const pad = number => String(number).padStart(2, '0');
  return {
    date: `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`,
    time: `${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}`,
    timestamp,
  };
}

function dateLabel(value) {
  const [, month, day] = value.split('-');
  const weekday = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][new Date(`${value}T00:00:00+08:00`).getDay()];
  return `${Number(month)}月${Number(day)}日 · ${weekday}`;
}

function normalizeShareSchedule(items = [], startDate, endDate, dayAvailability = []) {
  const dates = shareDates(startDate, endDate);
  const grouped = new Map(dates.map(date => [date, []]));
  const availabilityByDate = new Map((Array.isArray(dayAvailability) ? dayAvailability : [])
    .filter(item => item && dates.includes(item.date))
    .map(item => [item.date, item]));
  for (const item of Array.isArray(items) ? items : []) {
    const start = beijingParts(item.startsAt);
    const end = beijingParts(item.reservedUntil || item.endsAt);
    if (!start || !end || end.timestamp <= start.timestamp || start.date !== end.date || !grouped.has(start.date)) continue;
    grouped.get(start.date).push({ start: start.time, end: end.time, startMs: start.timestamp, endMs: end.timestamp });
  }
  return dates.map(date => {
    const merged = [];
    grouped.get(date).sort((a, b) => a.startMs - b.startMs).forEach(interval => {
      const previous = merged[merged.length - 1];
      if (previous && interval.startMs <= previous.endMs) {
        if (interval.endMs > previous.endMs) {
          previous.endMs = interval.endMs;
          previous.end = interval.end;
          previous.label = `${previous.start}—${previous.end}`;
        }
      } else {
        merged.push({ ...interval, label: `${interval.start}—${interval.end}` });
      }
    });
    const availability = availabilityByDate.get(date) || {};
    const allDayAvailable = merged.length === 0 && availability.allDayAvailable === true;
    const hasAvailableTime = merged.length === 0 && availability.hasAvailableTime === true;
    const emptyMessage = allDayAvailable
      ? '全天都可以约～'
      : hasAvailableTime
        ? '今天剩余时段可约，具体时间以小程序实时查询为准'
        : '当天暂无已确认预约，请查看小程序实时可约时间';
    return {
      date, label: dateLabel(date),
      intervals: merged.map(({ start, end, label }) => ({ start, end, label })),
      allDayAvailable, hasAvailableTime, emptyMessage,
    };
  });
}

function shareRangeText(startDate, endDate) {
  shareDates(startDate, endDate);
  return startDate === endDate ? dateLabel(startDate) : `${dateLabel(startDate)} 至 ${dateLabel(endDate)}`;
}

module.exports = { addDays, shareDates, normalizeShareSchedule, shareRangeText, beijingParts };
