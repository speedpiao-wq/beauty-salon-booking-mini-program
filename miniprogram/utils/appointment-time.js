function pad(value) { return String(value).padStart(2, '0'); }

function hoursForPeriod(periodIndex) {
  const start = periodIndex === 0 ? 9 : 13;
  const end = periodIndex === 0 ? 12 : 20;
  return Array.from({ length: end - start + 1 }, (_, index) => pad(start + index));
}

function to24Hour(periodIndex, hourIndex, minuteIndex) {
  const hours = hoursForPeriod(periodIndex);
  const hour = hours[hourIndex] || hours[0];
  return `${pad(hour)}:${pad(minuteIndex)}`;
}

function makeInitialSelection(now = Date.now()) {
  const local = new Date(now + 8 * 60 * 60 * 1000);
  let hour = Math.max(9, local.getUTCHours() + 1);
  const dayOffset = hour > 18 ? 1 : 0;
  if (dayOffset) hour = 9;
  const periodIndex = hour <= 12 ? 0 : 1;
  const hours = hoursForPeriod(periodIndex);
  const hourIndex = Math.max(0, hours.indexOf(pad(hour)));
  return {
    periodIndex,
    hours,
    hourIndex,
    hourInput: hours[hourIndex],
    minuteIndex: 0,
    minuteInput: '00',
    dayOffset,
  };
}

function makeDates(now = Date.now()) {
  const local = new Date(now + 8 * 60 * 60 * 1000);
  const midnight = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate());
  const weekdays = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
  return Array.from({ length: 7 }, (_, index) => {
    const date = new Date(midnight + index * 86400000);
    return {
      value: `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`,
      label: `${date.getUTCMonth() + 1}月${date.getUTCDate()}日`,
      day: date.getUTCDate(), weekday: index === 0 ? '今天' : weekdays[date.getUTCDay()],
    };
  });
}

module.exports = { pad, hoursForPeriod, to24Hour, makeInitialSelection, makeDates };
