const cloud = require('wx-server-sdk');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();
const command = db.command;

function isDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  return parsed.getUTCFullYear() === year
    && parsed.getUTCMonth() === month - 1
    && parsed.getUTCDate() === day;
}

function parseShanghaiDateTime(date, time) {
  return new Date(`${date}T${time}:00+08:00`);
}

function isTime(value) {
  if (typeof value !== 'string' || !/^\d{2}:\d{2}$/.test(value)) return false;
  const [hour, minute] = value.split(':').map(Number);
  return hour >= 0 && hour <= 23 && minute >= 0 && minute <= 59;
}

function timeToMinutes(value) {
  const [hour, minute] = value.split(':').map(Number);
  return hour * 60 + minute;
}

function isBookingStartAllowed(startMinute, opensAt, latestStartAt) {
  return startMinute >= opensAt && startMinute <= latestStartAt;
}

function bookingBlockMinutesFor(service) {
  const durationMinutes = Math.max(1, Number(service.durationMinutes) || 0);
  const configuredBlockMinutes = Number(service.bookingBlockMinutes) || durationMinutes;
  return Math.max(durationMinutes, configuredBlockMinutes);
}

function slotKeys(date, time, durationMinutes, resourceId) {
  const start = parseShanghaiDateTime(date, time);
  const end = new Date(start.getTime() + durationMinutes * 60 * 1000);
  const slotSize = 30 * 60 * 1000;
  const firstSlot = Math.floor(start.getTime() / slotSize) * slotSize;
  const keys = [];
  for (let cursor = firstSlot; cursor < end.getTime(); cursor += slotSize) {
    const shanghai = new Date(cursor + 8 * 60 * 60 * 1000);
    const localDate = `${shanghai.getUTCFullYear()}-${String(shanghai.getUTCMonth() + 1).padStart(2, '0')}-${String(shanghai.getUTCDate()).padStart(2, '0')}`;
    const hour = String(shanghai.getUTCHours()).padStart(2, '0');
    const minute = String(shanghai.getUTCMinutes()).padStart(2, '0');
    keys.push(`${resourceId}__${localDate}__${hour}${minute}`);
  }
  return keys;
}

exports.main = async (event) => {
  const requestStartedAt = Date.now();
  const serviceId = typeof event.serviceId === 'string' ? event.serviceId : '';
  const date = typeof event.date === 'string' ? event.date : '';
  const customTime = typeof event.customTime === 'string' ? event.customTime : '';
  if (!serviceId || !isDate(date)) {
    return { ok: false, code: 'INVALID_INPUT', message: '护理项目或日期不正确。' };
  }

  try {
    const [year, month, day] = date.split('-').map(Number);
    const weekday = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
    const [serviceResult, settingsResult, hoursResult] = await Promise.all([
      db.collection('services').doc(serviceId).get(),
      db.collection('settings').doc('system').get(),
      db.collection('business_hours').doc(`weekday-${weekday}`).get(),
    ]);
    const service = serviceResult.data;
    const settings = settingsResult.data;
    if (!service || !service.active) {
      return { ok: false, code: 'SERVICE_UNAVAILABLE', message: '该护理项目暂不可预约。' };
    }

    const shanghaiNow = new Date(Date.now() + 8 * 60 * 60 * 1000);
    const todayValue = Date.UTC(shanghaiNow.getUTCFullYear(), shanghaiNow.getUTCMonth(), shanghaiNow.getUTCDate());
    const targetValue = Date.UTC(year, month - 1, day);
    const bookingWindowDays = Number(settings.bookingWindowDays) || 30;
    if (targetValue < todayValue || targetValue > todayValue + bookingWindowDays * 24 * 60 * 60 * 1000) {
      return { ok: false, code: 'DATE_OUT_OF_RANGE', message: `请选择未来${bookingWindowDays}天内的日期。` };
    }
    const hours = hoursResult.data;

    const resourceId = settings.primaryResourceId || 'primary-room';
    const bookingBlockMinutes = bookingBlockMinutesFor(service);
    const openingSlots = hours && Array.isArray(hours.openingSlots) ? hours.openingSlots : [];
    if (customTime && !isTime(customTime)) {
      return { ok: false, code: 'INVALID_TIME', message: '自定义时间格式不正确。' };
    }
    const candidateTimes = !hours || !hours.enabled ? [] : customTime ? [customTime] : openingSlots;
    const allKeys = [...new Set(candidateTimes.flatMap((time) => slotKeys(date, time, bookingBlockMinutes, resourceId)))];
    const candidates = candidateTimes.map((time) => {
      const startsAt = parseShanghaiDateTime(date, time);
      const reservedUntil = new Date(startsAt.getTime() + bookingBlockMinutes * 60 * 1000);
      const keys = slotKeys(date, time, bookingBlockMinutes, resourceId);
      const opensAt = timeToMinutes(settings.customTimeStart || '09:00');
      const closesAt = timeToMinutes(settings.customTimeEnd || '20:00');
      const startMinute = timeToMinutes(time);
      // customTimeEnd 表示最晚接收预约的开始时间，护理可以在该时间之后结束。
      const inBusinessHours = isBookingStartAllowed(startMinute, opensAt, closesAt);
      return { time, startsAt, reservedUntil, keys, inBusinessHours };
    });
    const dayStart = parseShanghaiDateTime(date, '00:00').toISOString();
    const dayEnd = new Date(Date.parse(dayStart) + 86400000).toISOString();
    const [lockResult, blockResults, dayBlocks] = await Promise.all([
      allKeys.length ? db.collection('appointment_slots').where({ _id: command.in(allKeys) }).limit(100).get() : Promise.resolve({ data: [] }),
      Promise.all(candidates.map(({ inBusinessHours, reservedUntil, startsAt }) => inBusinessHours
        ? db.collection('schedule_blocks').where({
          resourceId,
          active: command.neq(false),
          startsAt: command.lt(reservedUntil.toISOString()),
          endsAt: command.gt(startsAt.toISOString()),
        }).limit(1).get() : Promise.resolve({ data: [] }))),
      db.collection('schedule_blocks').where({ resourceId, active: command.neq(false), startsAt: command.lt(dayEnd), endsAt: command.gt(dayStart) })
        .orderBy('startsAt', 'asc').limit(100).get(),
    ]);
    const locked = new Set(lockResult.data.map((item) => item._id));
    const now = Date.now();
    const slots = candidates.map(({ time, startsAt, keys, inBusinessHours }, index) => {
      const isPast = startsAt.getTime() <= now;
      const isLocked = keys.some((key) => locked.has(key));
      const isBlocked = blockResults[index].data.length > 0;
      const available = inBusinessHours && !isPast && !isLocked && !isBlocked;
      const reason = !inBusinessHours
        ? '不在营业时间'
        : isPast
          ? '时间已过'
          : isBlocked
            ? (String(blockResults[index].data[0].note || '').trim().slice(0, 200) || '白兰偷懒,正在深度休息中~')
            : isLocked
              ? '已占用'
              : null;
      return { time, available, reason, blocked: isBlocked, custom: Boolean(customTime), bookingBlockMinutes };
    });

    const restNotices = dayBlocks.data.map(block => ({ startsAt: block.startsAt, endsAt: block.endsAt, message: String(block.note || '').trim().slice(0, 200) || '白兰偷懒,正在深度休息中~' }));
    return { ok: true, date, serviceId, slots, restNotices, serverMs: Date.now() - requestStartedAt };
  } catch (error) {
    console.error('getAvailability failed', error);
    return { ok: false, code: 'AVAILABILITY_FAILED', message: '暂时无法读取可预约时间。' };
  }
};
