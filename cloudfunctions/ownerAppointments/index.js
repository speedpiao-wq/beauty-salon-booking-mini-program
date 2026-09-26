const crypto = require('crypto');
const cloud = require('wx-server-sdk');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();

function cleanText(value, maxLength) {
  return typeof value === 'string' ? value.trim().slice(0, maxLength) : '';
}

function adminIdFor(openid) {
  return crypto.createHash('sha256').update(openid).digest('hex');
}

function reminderLeadMinutesFor(settings) {
  const configured = Number(settings && settings.reminderLeadMinutes);
  if (!Number.isFinite(configured)) return 120;
  return Math.min(120, Math.max(60, Math.round(configured)));
}

function reminderScheduledFor(startsAt, leadMinutes, nowMs = Date.now()) {
  const preferredTime = new Date(startsAt).getTime() - leadMinutes * 60 * 1000;
  return new Date(Math.max(preferredTime, nowMs)).toISOString();
}

function canOwnerCancel(status) {
  return status === 'pending' || status === 'confirmed';
}

function isFutureAppointment(startsAt, nowMs = Date.now()) {
  return Number.isFinite(Date.parse(startsAt)) && Date.parse(startsAt) > nowMs;
}

function ownerCancellationAllowed(status, startsAt, nowMs = Date.now()) {
  if (status === 'pending') return true;
  return status === 'confirmed' && isFutureAppointment(startsAt, nowMs);
}

function addHoursIso(isoText, hours) {
  return new Date(Date.parse(isoText) + hours * 60 * 60 * 1000).toISOString();
}

function formatBeijingDate(timestamp) {
  const date = new Date(timestamp + 8 * 60 * 60 * 1000);
  const pad = (value) => String(value).padStart(2, '0');
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
}

function queryRange(startDate, endDate) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(startDate) || !/^\d{4}-\d{2}-\d{2}$/.test(endDate)) {
    throw new Error('INVALID_HISTORY_RANGE');
  }
  const startMs = Date.parse(`${startDate}T00:00:00+08:00`);
  const endMs = Date.parse(`${endDate}T00:00:00+08:00`);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)
    || formatBeijingDate(startMs) !== startDate || formatBeijingDate(endMs) !== endDate
    || endMs < startMs || endMs - startMs > 366 * 24 * 60 * 60 * 1000) {
    throw new Error('INVALID_HISTORY_RANGE');
  }
  return {
    startIso: new Date(startMs).toISOString(),
    endExclusiveIso: new Date(endMs + 24 * 60 * 60 * 1000).toISOString(),
  };
}

function shareRange(startDate, endDate) {
  let range;
  try { range = queryRange(startDate, endDate); } catch (_) { throw new Error('INVALID_SHARE_RANGE'); }
  const startMs = Date.parse(`${startDate}T00:00:00+08:00`);
  const endMs = Date.parse(`${endDate}T00:00:00+08:00`);
  if (endMs - startMs > 2 * 24 * 60 * 60 * 1000) throw new Error('INVALID_SHARE_RANGE');
  return range;
}

function historyStatusLabel(appointment, nowMs = Date.now()) {
  if (appointment.status === 'cancelled_by_customer' || appointment.status === 'cancelled_by_owner') return '已取消';
  if (appointment.status === 'confirmed') {
    const serviceEndMs = Date.parse(appointment.startsAt) + Math.max(0, Number(appointment.durationMinutes) || 0) * 60 * 1000;
    return Number.isFinite(serviceEndMs) && serviceEndMs <= nowMs ? '已完成' : '已确认';
  }
  if (appointment.status === 'pending' && Date.parse(appointment.startsAt) <= nowMs) return '过期待确认';
  return '待确认';
}

async function cancelPendingNotificationJobs(appointmentId, now) {
  const result = await db.collection('notification_jobs').where({ appointmentId }).limit(20).get();
  const pendingJobs = result.data.filter((job) => !['sent', 'cancelled'].includes(job.status));
  await Promise.all(pendingJobs.map((job) => db.collection('notification_jobs').doc(job._id).update({
    data: { status: 'cancelled', cancelledAt: now, updatedAt: now },
  })));
}

async function requireAdmin(openid, database = db) {
  const adminId = adminIdFor(openid);
  const result = await database.collection('admins').doc(adminId).get().catch(() => null);
  if (!result || !result.data || !result.data.active || !['super_admin', 'owner'].includes(result.data.role)) {
    throw new Error('OWNER_FORBIDDEN');
  }
  return result.data;
}

function publicAppointment(appointment) {
  return {
    id: appointment._id,
    bookingCode: appointment.bookingCode,
    customerName: appointment.customerName,
    contact: appointment.contact || '',
    note: appointment.note || '',
    serviceName: appointment.serviceName,
    scheduledDate: appointment.scheduledDate,
    scheduledTime: appointment.scheduledTime,
    durationMinutes: appointment.durationMinutes,
    bookingBlockMinutes: appointment.bookingBlockMinutes,
    startsAt: appointment.startsAt,
    reservedUntil: appointment.reservedUntil,
    status: appointment.status,
    notifyResult: appointment.notifyResult === true,
    notifyReminder: appointment.notifyReminder === true,
    confirmedAt: appointment.confirmedAt || null,
    confirmedByName: appointment.confirmedByName || null,
    cancelledAt: appointment.cancelledAt || null,
    cancelledByType: appointment.cancelledByType || null,
    cancelledByName: appointment.cancelledByName || null,
    archivedAt: appointment.archivedAt || null,
    createdAt: appointment.createdAt,
  };
}

function publicAdmin(admin) {
  return { id: admin._id, displayName: admin.displayName || '店主', role: admin.role, active: admin.active === true };
}

function historyStatuses(filter) {
  if (filter === 'booked') return ['pending', 'confirmed'];
  if (filter === 'cancelled') return ['cancelled_by_customer', 'cancelled_by_owner'];
  if (filter === 'all') return null;
  throw new Error('INVALID_HISTORY_FILTER');
}

const DEFAULT_REST_MESSAGE = '白兰偷懒,正在深度休息中~';

function restRange(event, now = Date.now()) {
  const startDate = cleanText(event.startDate, 10);
  const endDate = cleanText(event.endDate, 10);
  const startTime = cleanText(event.startTime, 5);
  const endTime = cleanText(event.endTime, 5);
  const validTime = value => /^([01]\d|2[0-3]):[0-5]\d$/.test(value);
  try { queryRange(startDate, endDate); } catch (_) { throw new Error('INVALID_REST_RANGE'); }
  const start = Date.parse(`${startDate}T${startTime}:00+08:00`);
  const end = Date.parse(`${endDate}T${endTime}:00+08:00`);
  if (!validTime(startTime) || !validTime(endTime) || !Number.isFinite(start) || !Number.isFinite(end)
    || end <= start || end <= now || startDate < formatBeijingDate(now)
    || start > now + 366 * 86400000 || end - start > 31 * 86400000) throw new Error('INVALID_REST_RANGE');
  return { startsAt: new Date(start).toISOString(), endsAt: new Date(end).toISOString() };
}

function restSummary(block) {
  return {
    id: block._id, startsAt: block.startsAt, endsAt: block.endsAt,
    note: cleanText(block.note, 200), message: cleanText(block.note, 200) || DEFAULT_REST_MESSAGE,
  };
}

async function listRestBlocks() {
  const settings = await db.collection('settings').doc('system').get();
  const result = await db.collection('schedule_blocks').where({
    resourceId: settings.data.primaryResourceId || 'primary-room',
    active: db.command.neq(false), endsAt: db.command.gt(new Date().toISOString()),
  }).orderBy('startsAt', 'asc').limit(101).get();
  return { ok: true, blocks: result.data.slice(0, 100).map(restSummary), hasMore: result.data.length > 100 };
}

exports.main = async (event = {}) => {
  const requestStartedAt = Date.now();
  const openid = cloud.getWXContext().OPENID;
  if (!openid) return { ok: false, code: 'LOGIN_REQUIRED', message: '微信登录状态已失效。' };
  const action = cleanText(event.action, 30) || 'list';

  try {
    if (action === 'restList') {
      await requireAdmin(openid);
      return await listRestBlocks();
    }

    if (action === 'restCreate') {
      // Authority and the calendar revision are checked inside the same transaction as the block.
      const block = await db.runTransaction(async transaction => {
        const admin = await requireAdmin(openid, transaction);
        const range = restRange(event);
        const requestId = cleanText(event.requestId, 80);
        if (!requestId) throw new Error('INVALID_REST_REQUEST');
        const blockId = crypto.createHash('sha256').update(`rest:${openid}:${requestId}`).digest('hex');
        const previous = await transaction.collection('schedule_blocks').doc(blockId).get().catch(() => null);
        if (previous && previous.data) return previous.data;
        const settings = await transaction.collection('settings').doc('system').get();
        const resourceId = settings.data.primaryResourceId || 'primary-room';
        const conflicts = await transaction.collection('appointments').where({
          resourceId, status: db.command.in(['pending', 'confirmed']),
          startsAt: db.command.lt(range.endsAt), reservedUntil: db.command.gt(range.startsAt),
        }).limit(1).get();
        if (conflicts.data.length) throw new Error('REST_APPOINTMENT_CONFLICT');
        const overlap = await transaction.collection('schedule_blocks').where({
          resourceId, active: db.command.neq(false),
          startsAt: db.command.lt(range.endsAt), endsAt: db.command.gt(range.startsAt),
        }).limit(1).get();
        if (overlap.data.length) throw new Error('REST_BLOCK_CONFLICT');
        const now = new Date().toISOString();
        const data = { ...range, resourceId, active: true, note: cleanText(event.note, 200), createdBy: admin._id, createdAt: now, updatedAt: now };
        // createBooking writes this same document, serializing a new booking against a new rest period.
        await transaction.collection('settings').doc('system').update({ data: { calendarRevision: db.command.inc(1) } });
        await transaction.collection('schedule_blocks').doc(blockId).set({ data });
        await transaction.collection('audit_logs').doc(crypto.randomUUID()).set({ data: {
          entityType: 'schedule_block', entityId: blockId, action: 'rest_created',
          actorType: 'admin', actorId: admin._id, detail: { ...range, note: data.note }, createdAt: now,
        } });
        return { _id: blockId, ...data };
      });
      return { ok: true, block: restSummary(block) };
    }

    if (action === 'restCancel') {
      await db.runTransaction(async transaction => {
        const admin = await requireAdmin(openid, transaction);
        const blockId = cleanText(event.blockId, 80);
        if (!blockId) throw new Error('REST_NOT_FOUND');
        const result = await transaction.collection('schedule_blocks').doc(blockId).get().catch(() => null);
        if (!result || !result.data) throw new Error('REST_NOT_FOUND');
        if (result.data.active === false) return;
        const now = new Date().toISOString();
        await transaction.collection('settings').doc('system').update({ data: { calendarRevision: db.command.inc(1) } });
        await transaction.collection('schedule_blocks').doc(blockId).update({ data: { active: false, cancelledAt: now, cancelledBy: admin._id, updatedAt: now } });
        await transaction.collection('audit_logs').doc(crypto.randomUUID()).set({ data: {
          entityType: 'schedule_block', entityId: blockId, action: 'rest_cancelled', actorType: 'admin', actorId: admin._id, createdAt: now,
        } });
      });
      return { ok: true };
    }

    if (action === 'shareSchedule') {
      await requireAdmin(openid);
      const startDate = cleanText(event.startDate, 10);
      const endDate = cleanText(event.endDate, 10);
      const range = shareRange(startDate, endDate);
      const result = await db.collection('appointments').where({
        status: 'confirmed',
        startsAt: db.command.gte(range.startIso).and(db.command.lt(range.endExclusiveIso)),
      }).orderBy('startsAt', 'asc').limit(101).get();
      if (result.data.length > 100) throw new Error('SHARE_SCHEDULE_TOO_LARGE');
      return {
        ok: true,
        startDate,
        endDate,
        appointments: result.data.map(item => ({
          scheduledDate: cleanText(item.scheduledDate, 10) || formatBeijingDate(Date.parse(item.startsAt)),
          startsAt: item.startsAt,
          reservedUntil: item.reservedUntil || item.endsAt,
        })),
      };
    }

    if (action === 'summary') {
      let admin;
      try { admin = await requireAdmin(openid); } catch (error) {
        if (error.message === 'OWNER_FORBIDDEN') return { ok: true, isAdmin: false, appointments: [] };
        throw error;
      }
      const result = await db.collection('appointments')
        .where({ status: 'confirmed', startsAt: db.command.gte(new Date().toISOString()) })
        .orderBy('startsAt', 'asc').limit(6).get();
      return {
        ok: true, isAdmin: true, role: admin.role,
        appointments: result.data.slice(0, 5).map(item => ({
          id: item._id, customerName: item.customerName,
          scheduledDate: item.scheduledDate, scheduledTime: item.scheduledTime,
        })),
        hasMore: result.data.length > 5, serverMs: Date.now() - requestStartedAt,
      };
    }

    if (action === 'list' || action === 'dashboard') {
      let admin;
      try { admin = await requireAdmin(openid); } catch (error) {
        if (action !== 'dashboard' || error.message !== 'OWNER_FORBIDDEN') throw error;
        const settings = await db.collection('settings').doc('system').get();
        return { ok: true, isAdmin: false, admin: null, ownerBindingStatus: settings.data.ownerBindingStatus || 'pending', pending: [], confirmed: [], cancelled: [], admins: [] };
      }
      const from = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
      const [result, adminsResult] = await Promise.all([
        db.collection('appointments').where({ startsAt: db.command.gte(from) }).orderBy('startsAt', 'asc').limit(100).get(),
        action === 'dashboard' && admin.role === 'super_admin'
          ? db.collection('admins').limit(50).get() : Promise.resolve({ data: [] }),
      ]);
      const appointments = result.data.map(publicAppointment);
      const recentCancellationCutoff = Date.now() - 24 * 60 * 60 * 1000;
      return {
        ok: true,
        isAdmin: true, ownerBindingStatus: 'bound',
        admin: publicAdmin(admin),
        admins: adminsResult.data.map(publicAdmin),
        serverMs: Date.now() - requestStartedAt,
        pending: appointments.filter((item) => item.status === 'pending'),
        confirmed: appointments.filter((item) => item.status === 'confirmed'),
        cancelled: appointments.filter((item) => ['cancelled_by_customer', 'cancelled_by_owner'].includes(item.status)
          && Date.parse(item.cancelledAt || '') > recentCancellationCutoff),
      };
    }

    if (action === 'query') {
      await requireAdmin(openid);
      const startDate = cleanText(event.startDate, 10);
      const endDate = cleanText(event.endDate, 10);
      const range = queryRange(startDate, endDate);
      const command = db.command;
      const filter = cleanText(event.statusFilter, 20) || 'all';
      const statuses = historyStatuses(filter);
      const offset = Number(event.offset || 0);
      if (!Number.isInteger(offset) || offset < 0 || offset > 100000) throw new Error('INVALID_HISTORY_RANGE');
      const where = { startsAt: command.gte(range.startIso).and(command.lt(range.endExclusiveIso)) };
      if (statuses) where.status = command.in(statuses);
      const result = await db.collection('appointments')
        .where(where)
        .orderBy('startsAt', 'desc').orderBy('_id', 'desc')
        .skip(offset).limit(51)
        .get();
      const records = result.data.slice(0, 50)
        .map((appointment) => ({
          ...publicAppointment(appointment),
          historyStatusLabel: historyStatusLabel(appointment),
        }));
      return { ok: true, startDate, endDate, statusFilter: filter, records, hasMore: result.data.length > 50, nextOffset: offset + records.length };
    }

    if (action === 'confirm') {
      const appointmentId = cleanText(event.appointmentId, 80);
      if (!appointmentId) return { ok: false, code: 'INVALID_APPOINTMENT', message: '预约信息不正确。' };
      const result = await db.runTransaction(async (transaction) => {
        const admin = await requireAdmin(openid, transaction);
        const appointmentResult = await transaction.collection('appointments').doc(appointmentId).get();
        const appointment = appointmentResult.data;
        if (!appointment) throw new Error('APPOINTMENT_NOT_FOUND');
        if (appointment.status === 'confirmed') return appointment;
        if (appointment.status !== 'pending') throw new Error('APPOINTMENT_NOT_PENDING');

        const needsNotifications = appointment.notifyResult === true || appointment.notifyReminder === true;
        const settingsResult = needsNotifications
          ? await transaction.collection('settings').doc('system').get()
          : { data: {} };
        const settings = settingsResult.data || {};

        const now = new Date().toISOString();
        const confirmedByName = admin.role === 'super_admin'
          ? '创始人'
          : (admin.displayName || '共同店主');
        await transaction.collection('appointments').doc(appointmentId).update({
          data: {
            status: 'confirmed',
            confirmedAt: now,
            confirmedByAdminId: admin._id,
            confirmedByName,
            updatedAt: now,
          },
        });
        await transaction.collection('appointment_events').doc(crypto.randomUUID()).set({
          data: {
            appointmentId,
            fromStatus: 'pending',
            toStatus: 'confirmed',
            actorType: 'admin',
            actorId: admin._id,
            actorDisplayName: confirmedByName,
            createdAt: now,
          },
        });
        await transaction.collection('audit_logs').doc(crypto.randomUUID()).set({
          data: {
            entityType: 'appointment',
            entityId: appointmentId,
            action: 'confirmed',
            actorType: 'admin',
            actorId: admin._id,
            detail: { confirmedByName, previousStatus: 'pending' },
            createdAt: now,
          },
        });
        if (needsNotifications) {
          if (appointment.notifyResult === true) {
            const templateId = settings.confirmationTemplateId || '';
            await transaction.collection('notification_jobs').doc(`${appointmentId}__booking_confirmed`).set({
              data: {
                appointmentId,
                customerOpenid: appointment.customerOpenid,
                kind: 'booking_confirmed',
                scheduledFor: now,
                status: templateId ? 'ready' : 'waiting_wechat_template',
                templateId: templateId || null,
                attempts: 0,
                sentAt: null,
                lastError: null,
                createdAt: now,
              },
            });
          }
          if (appointment.notifyReminder === true) {
            const templateId = settings.reminderTemplateId || '';
            const leadMinutes = reminderLeadMinutesFor(settings);
            await transaction.collection('notification_jobs').doc(`${appointmentId}__arrival_reminder`).set({
              data: {
                appointmentId,
                customerOpenid: appointment.customerOpenid,
                kind: 'arrival_reminder',
                scheduledFor: reminderScheduledFor(appointment.startsAt, leadMinutes),
                leadMinutes,
                status: templateId ? 'ready' : 'waiting_wechat_template',
                templateId: templateId || null,
                attempts: 0,
                sentAt: null,
                lastError: null,
                createdAt: now,
              },
            });
          }
        }
        return { ...appointment, status: 'confirmed', confirmedAt: now, confirmedByName };
      });
      return { ok: true, appointment: publicAppointment(result) };
    }

    if (action === 'cancel') {
      const appointmentId = cleanText(event.appointmentId, 80);
      if (!appointmentId) return { ok: false, code: 'INVALID_APPOINTMENT', message: '预约信息不正确。' };
      const result = await db.runTransaction(async (transaction) => {
        const admin = await requireAdmin(openid, transaction);
        const appointmentResult = await transaction.collection('appointments').doc(appointmentId).get().catch(() => null);
        const appointment = appointmentResult && appointmentResult.data ? appointmentResult.data : null;
        if (!appointment) throw new Error('APPOINTMENT_NOT_FOUND');
        if (appointment.status === 'cancelled_by_customer' || appointment.status === 'cancelled_by_owner') return appointment;
        if (!canOwnerCancel(appointment.status)) throw new Error('APPOINTMENT_NOT_CANCELLABLE');
        if (!ownerCancellationAllowed(appointment.status, appointment.startsAt)) throw new Error('APPOINTMENT_STARTED');

        const slotResult = await transaction.collection('appointment_slots').where({ appointmentId }).limit(100).get();
        const releasedSlotIds = slotResult.data.map((slot) => slot._id);
        const now = new Date().toISOString();
        const cancelledByName = admin.role === 'super_admin'
          ? '创始人'
          : (admin.displayName || '共同店主');
        await transaction.collection('appointments').doc(appointmentId).update({
          data: {
            status: 'cancelled_by_owner',
            cancelledAt: now,
            cancelledByType: 'admin',
            cancelledById: admin._id,
            cancelledByName,
            archiveAfter: addHoursIso(now, 24),
            updatedAt: now,
          },
        });
        for (const slotId of releasedSlotIds) {
          await transaction.collection('appointment_slots').doc(slotId).remove();
        }
        await transaction.collection('appointment_events').doc(crypto.randomUUID()).set({
          data: {
            appointmentId,
            fromStatus: appointment.status,
            toStatus: 'cancelled_by_owner',
            actorType: 'admin',
            actorId: admin._id,
            actorDisplayName: cancelledByName,
            createdAt: now,
          },
        });
        await transaction.collection('audit_logs').doc(crypto.randomUUID()).set({
          data: {
            entityType: 'appointment',
            entityId: appointmentId,
            action: 'cancelled_by_owner',
            actorType: 'admin',
            actorId: admin._id,
            detail: { previousStatus: appointment.status, cancelledByName, releasedSlotIds },
            createdAt: now,
          },
        });
        return {
          ...appointment,
          status: 'cancelled_by_owner',
          cancelledAt: now,
          cancelledByType: 'admin',
          cancelledByName,
        };
      });

      const cancelledAt = result.cancelledAt || new Date().toISOString();
      await cancelPendingNotificationJobs(appointmentId, cancelledAt).catch((error) => {
        console.warn('cancel notification jobs failed', error);
      });
      return { ok: true, appointment: publicAppointment(result) };
    }

    return { ok: false, code: 'UNKNOWN_ACTION', message: '未知的预约管理操作。' };
  } catch (error) {
    const message = String(error && error.message ? error.message : error);
    console.error('ownerAppointments failed', error);
    if (/OWNER_FORBIDDEN/.test(message)) return { ok: false, code: 'OWNER_FORBIDDEN', message: '当前微信没有店主权限。' };
    if (/INVALID_REST_RANGE|INVALID_REST_REQUEST/.test(message)) return { ok: false, code: 'INVALID_REST_RANGE', message: '请选择今天起的有效休息时段，结束须晚于开始，单段最多31天。' };
    if (/REST_APPOINTMENT_CONFLICT/.test(message)) return { ok: false, code: 'REST_APPOINTMENT_CONFLICT', message: '这个时段已有待确认或已接受的预约（含整理时间），请先与客人协调或选择其他时段。' };
    if (/REST_BLOCK_CONFLICT/.test(message)) return { ok: false, code: 'REST_BLOCK_CONFLICT', message: '这个时段已有休息安排，可先恢复接单后重新设置。' };
    if (/REST_NOT_FOUND/.test(message)) return { ok: false, code: 'REST_NOT_FOUND', message: '这条休息安排不存在，请刷新。' };
    if (/INVALID_SHARE_RANGE/.test(message)) return { ok: false, code: 'INVALID_SHARE_RANGE', message: '一次可分享1—3天，请重新选择日期。' };
    if (/SHARE_SCHEDULE_TOO_LARGE/.test(message)) return { ok: false, code: 'SHARE_SCHEDULE_TOO_LARGE', message: '这个日期范围的预约较多，请缩短日期后分别生成分享图。' };
    if (/transaction.*conflict/i.test(message)) return { ok: false, code: 'CALENDAR_CHANGED', message: '预约安排刚刚有更新，请刷新后重试。' };
    if (/APPOINTMENT_NOT_FOUND/.test(message)) return { ok: false, code: 'APPOINTMENT_NOT_FOUND', message: '没有找到这条预约。' };
    if (/APPOINTMENT_NOT_PENDING/.test(message)) return { ok: false, code: 'APPOINTMENT_NOT_PENDING', message: '这条预约已被处理，请刷新后查看。' };
    if (/APPOINTMENT_STARTED/.test(message)) return { ok: false, code: 'APPOINTMENT_STARTED', message: '护理时间已经开始，不能再取消这条预约。' };
    if (/APPOINTMENT_NOT_CANCELLABLE/.test(message)) return { ok: false, code: 'APPOINTMENT_NOT_CANCELLABLE', message: '当前预约状态不能取消，请刷新后查看。' };
    if (/INVALID_HISTORY_RANGE/.test(message)) return { ok: false, code: 'INVALID_HISTORY_RANGE', message: '查询日期不正确，单次最多查询一年。' };
    if (/INVALID_HISTORY_FILTER/.test(message)) return { ok: false, code: 'INVALID_HISTORY_FILTER', message: '请选择全部、已预约或已取消。' };
    return { ok: false, code: 'OWNER_APPOINTMENTS_FAILED', message: '暂时无法读取或确认预约。' };
  }
};
