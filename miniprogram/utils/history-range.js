const DAY_MS = 24 * 60 * 60 * 1000;

function parseDateParts(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value || ''));
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const stamp = Date.UTC(year, month - 1, day);
  const date = new Date(stamp);
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  return { year, month, day, stamp };
}

function formatStamp(stamp) {
  const date = new Date(stamp);
  const pad = (value) => String(value).padStart(2, '0');
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
}

function addDays(value, count) {
  const parts = parseDateParts(value);
  if (!parts) throw new Error('日期格式不正确');
  return formatStamp(parts.stamp + count * DAY_MS);
}

function todayDate(nowMs = Date.now()) {
  return formatStamp(nowMs + 8 * 60 * 60 * 1000);
}

function rangeFor(preset, anchorDate, customStartDate, customEndDate) {
  const anchor = parseDateParts(anchorDate);
  if (!anchor) throw new Error('请选择正确的查询日期');
  if (preset === 'day') return { startDate: anchorDate, endDate: anchorDate };
  if (preset === 'week') {
    const weekday = new Date(anchor.stamp).getUTCDay();
    const mondayOffset = (weekday + 6) % 7;
    const startDate = formatStamp(anchor.stamp - mondayOffset * DAY_MS);
    return { startDate, endDate: addDays(startDate, 6) };
  }
  if (preset === 'month') {
    const startDate = `${anchor.year}-${String(anchor.month).padStart(2, '0')}-01`;
    const endDate = formatStamp(Date.UTC(anchor.year, anchor.month, 0));
    return { startDate, endDate };
  }
  if (preset === 'custom') {
    const start = parseDateParts(customStartDate);
    const end = parseDateParts(customEndDate);
    if (!start || !end) throw new Error('请选择正确的开始和结束日期');
    if (end.stamp < start.stamp) throw new Error('结束日期不能早于开始日期');
    if (end.stamp - start.stamp > 366 * DAY_MS) throw new Error('单次最多查询一年');
    return { startDate: customStartDate, endDate: customEndDate };
  }
  throw new Error('查询方式不正确');
}

function weeksForMonth(month) {
  const first = parseDateParts(`${month}-01`);
  if (!first) throw new Error('请选择正确的月份');
  const last = rangeFor('month', `${month}-01`).endDate;
  let startDate = rangeFor('week', `${month}-01`).startDate;
  const weeks = [];
  const ordinal = ['第一周', '第二周', '第三周', '第四周', '第五周', '第六周'];
  const short = value => {
    const parts = parseDateParts(value);
    return `${parts.month}/${parts.day}`;
  };
  while (startDate <= last) {
    const endDate = addDays(startDate, 6);
    weeks.push({ startDate, endDate, label: `${short(startDate)}～${short(endDate)}（${ordinal[weeks.length]}）` });
    startDate = addDays(startDate, 7);
  }
  return weeks;
}

module.exports = { addDays, parseDateParts, rangeFor, todayDate, weeksForMonth };
