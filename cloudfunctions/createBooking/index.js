const crypto = require('crypto');
const cloud = require('wx-server-sdk');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();
const command = db.command;

function text(value, maxLength) {
  return typeof value === 'string' ? value.trim().slice(0, maxLength) : '';
}

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

function slotRows(date, time, durationMinutes, resourceId) {
  const start = parseShanghaiDateTime(date, time);
  const end = new Date(start.getTime() + durationMinutes * 60 * 1000);
  const slotSize = 30 * 60 * 1000;
  const firstSlot = Math.floor(start.getTime() / slotSize) * slotSize;
  const rows = [];
  for (let cursor = firstSlot; cursor < end.getTime(); cursor += slotSize) {
    const slotStart = new Date(cursor);
    const shanghai = new Date(slotStart.getTime() + 8 * 60 * 60 * 1000);
    const localDate = `${shanghai.getUTCFullYear()}-${String(shanghai.getUTCMonth() + 1).padStart(2, '0')}-${String(shanghai.getUTCDate()).padStart(2, '0')}`;
    const hour = String(shanghai.getUTCHours()).padStart(2, '0');
    const minute = String(shanghai.getUTCMinutes()).padStart(2, '0');
    rows.push({
      _id: `${resourceId}__${localDate}__${hour}${minute}`,
      slotStart: slotStart.toISOString(),
    });
  }
  return rows;
}

function publicAppointment(appointment) {
  return {
    id: appointment._id,
    bookingCode: appointment.bookingCode,
    serviceName: appointment.serviceName,
    scheduledDate: appointment.scheduledDate,
    scheduledTime: appointment.scheduledTime,
    durationMinutes: appointment.durationMinutes,
    bookingBlockMinutes: appointment.bookingBlockMinutes,
    status: appointment.status,
  };
}

exports.main = async (event) => {
  const wxContext = cloud.getWXContext();
  const openid = wxContext.OPENID;
  if (!openid) return { ok: false, code: 'LOGIN_REQUIRED', message: '微信登录状态已失效，请重新进入小程序。' };

  const requestId = text(event.requestId, 80);
  const serviceId = text(event.serviceId, 80);
  const date = text(event.date, 10);
  const time = text(event.time, 5);
  const customerName = text(event.customerName, 40);
  const contact = text(event.contact, 80);
  const note = text(event.note, 400);
  if (!requestId || !serviceId || !isDate(date) || !isTime(time) || !customerName) {
    return { ok: false, code: 'INVALID_INPUT', message: '请完整填写护理项目、日期、时间和预约称呼。' };
  }

  const idempotencyId = crypto.createHash('sha256').update(`${openid}:${requestId}`).digest('hex');
  try {
    const result = await db.runTransaction(async (transaction) => {
      const previous = await transaction.collection('idempotency_keys').doc(idempotencyId).get().catch(() => null);
      if (previous && previous.data && previous.data.appointmentId) {
        const existing = await transaction.collection('appointments').doc(previous.data.appointmentId).get();
        return existing.data;
      }

      const serviceResult = await transaction.collection('services').doc(serviceId).get();
      const settingsResult = await transaction.collection('settings').doc('system').get();
      const service = serviceResult.data;
      const settings = settingsResult.data;
      if (!service || !service.active) throw new Error('SERVICE_UNAVAILABLE');

      const [year, month, day] = date.split('-').map(Number);
      const shanghaiNow = new Date(Date.now() + 8 * 60 * 60 * 1000);
      const todayValue = Date.UTC(shanghaiNow.getUTCFullYear(), shanghaiNow.getUTCMonth(), shanghaiNow.getUTCDate());
      const targetValue = Date.UTC(year, month - 1, day);
      const bookingWindowDays = Number(settings.bookingWindowDays) || 30;
      if (targetValue < todayValue || targetValue > todayValue + bookingWindowDays * 24 * 60 * 60 * 1000) {
        throw new Error('DATE_OUT_OF_RANGE');
      }
      const weekday = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
      const hoursResult = await transaction.collection('business_hours').doc(`weekday-${weekday}`).get();
      const openingSlots = hoursResult.data && hoursResult.data.enabled ? hoursResult.data.openingSlots : [];
      if (!hoursResult.data || !hoursResult.data.enabled) throw new Error('TIME_UNAVAILABLE');

      const startsAt = parseShanghaiDateTime(date, time);
      const endsAt = new Date(startsAt.getTime() + service.durationMinutes * 60 * 1000);
      const bookingBlockMinutes = bookingBlockMinutesFor(service);
      const reservedUntil = new Date(startsAt.getTime() + bookingBlockMinutes * 60 * 1000);
      const opensAt = timeToMinutes(settings.customTimeStart || '09:00');
      const closesAt = timeToMinutes(settings.customTimeEnd || '20:00');
      const startMinute = timeToMinutes(time);
      // customTimeEnd 表示最晚接收预约的开始时间，护理可以在该时间之后结束。
      if (!isBookingStartAllowed(startMinute, opensAt, closesAt)) {
        throw new Error('TIME_UNAVAILABLE');
      }
      if (startsAt.getTime() <= Date.now()) throw new Error('TIME_UNAVAILABLE');

      const resourceId = settings.primaryResourceId || 'primary-room';
      const slots = slotRows(date, time, bookingBlockMinutes, resourceId);
      const slotIds = slots.map((slot) => slot._id);
      const locksResult = await transaction.collection('appointment_slots')
        .where({ _id: command.in(slotIds) })
        .limit(100)
        .get();
      const blocksResult = await transaction.collection('schedule_blocks').where({
        resourceId,
        active: command.neq(false),
        startsAt: command.lt(reservedUntil.toISOString()),
        endsAt: command.gt(startsAt.toISOString()),
      }).limit(1).get();
      if (blocksResult.data.length) {
        const error = new Error('SCHEDULE_BLOCKED');
        error.publicMessage = text(blocksResult.data[0].note, 200) || '白兰偷懒,正在深度休息中~';
        throw error;
      }
      if (locksResult.data.length) throw new Error('SLOT_TAKEN');

      const appointmentId = crypto.randomUUID();
      const bookingCode = `XY${date.replaceAll('-', '')}${crypto.randomBytes(4).toString('hex').toUpperCase()}`;
      const now = new Date().toISOString();
      const customerId = crypto.createHash('sha256').update(openid).digest('hex').slice(0, 32);
      const existingCustomer = await transaction.collection('customers').doc(customerId).get().catch(() => null);
      await transaction.collection('settings').doc('system').update({ data: { calendarRevision: command.inc(1) } });
      await transaction.collection('customers').doc(customerId).set({
        data: {
          displayName: customerName,
          contact,
          wechatOpenid: openid,
          externalId: existingCustomer && existingCustomer.data ? existingCustomer.data.externalId || null : null,
          createdAt: existingCustomer && existingCustomer.data ? existingCustomer.data.createdAt || now : now,
          updatedAt: now,
        },
      });

      const appointment = {
        _id: appointmentId,
        bookingCode,
        customerId,
        customerOpenid: openid,
        customerName,
        contact,
        serviceId,
        serviceName: service.name,
        durationMinutes: service.durationMinutes,
        bookingBlockMinutes,
        resourceId,
        scheduledDate: date,
        scheduledTime: time,
        timeSource: Array.isArray(openingSlots) && openingSlots.includes(time) ? 'preset' : 'custom',
        startsAt: startsAt.toISOString(),
        endsAt: endsAt.toISOString(),
        reservedUntil: reservedUntil.toISOString(),
        status: 'pending',
        source: 'wechat_miniprogram',
        note,
        notifyResult: event.notifyResult === true,
        notifyReminder: event.notifyReminder === true,
        externalId: null,
        syncStatus: 'not_required',
        createdAt: now,
        updatedAt: now,
      };
      const { _id, ...appointmentData } = appointment;
      await transaction.collection('appointments').doc(appointmentId).set({ data: appointmentData });

      for (const slot of slots) {
        await transaction.collection('appointment_slots').doc(slot._id).set({
          data: {
            appointmentId,
            resourceId,
            slotStart: slot.slotStart,
            createdAt: now,
          },
        });
      }

      await transaction.collection('audit_logs').doc(crypto.randomUUID()).set({
        data: {
          entityType: 'appointment',
          entityId: appointmentId,
          action: 'created',
          actorType: 'customer',
          actorId: customerId,
          detail: { source: 'wechat_miniprogram', slotIds, bookingBlockMinutes, reservedUntil: reservedUntil.toISOString() },
          createdAt: now,
        },
      });
      await transaction.collection('idempotency_keys').doc(idempotencyId).set({
        data: { appointmentId, createdAt: now },
      });

      return appointment;
    });

    return { ok: true, appointment: publicAppointment(result) };
  } catch (error) {
    const message = String(error && error.message ? error.message : error);
    console.error('createBooking failed', error);
    if (/SCHEDULE_BLOCKED/.test(message)) {
      return { ok: false, code: 'SCHEDULE_BLOCKED', message: error.publicMessage || '白兰偷懒,正在深度休息中~' };
    }
    if (/SLOT_TAKEN|transaction.*conflict/i.test(message)) {
      return { ok: false, code: 'SLOT_TAKEN', message: '这个时间刚刚被预约，请选择其他时间。' };
    }
    if (/SERVICE_UNAVAILABLE/.test(message)) {
      return { ok: false, code: 'SERVICE_UNAVAILABLE', message: '该护理项目暂不可预约。' };
    }
    if (/TIME_UNAVAILABLE/.test(message)) {
      return { ok: false, code: 'TIME_UNAVAILABLE', message: '该时间暂不可预约，请重新选择。' };
    }
    if (/DATE_OUT_OF_RANGE/.test(message)) {
      return { ok: false, code: 'DATE_OUT_OF_RANGE', message: '预约日期超出当前开放范围。' };
    }
    return { ok: false, code: 'CREATE_FAILED', message: '预约暂时未能保存，请稍后重试。' };
  }
};
