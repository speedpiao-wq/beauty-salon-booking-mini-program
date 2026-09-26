const crypto = require('crypto');
const cloud = require('wx-server-sdk');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();

function cleanText(value, maxLength) {
  return typeof value === 'string' ? value.trim().slice(0, maxLength) : '';
}

function customerIdFor(openid) {
  return crypto.createHash('sha256').update(openid).digest('hex').slice(0, 32);
}

function statusCopy(status, ownerDisplayName, completed = false) {
  if (completed) return '本次护理已完成';
  if (status === 'confirmed') return `${ownerDisplayName}已接受您的预约`;
  if (status === 'cancelled_by_customer') return '您已取消本次预约';
  if (status === 'cancelled_by_owner') return '本次预约已由店主取消';
  return `等待${ownerDisplayName}确认`;
}

function statusLabel(status, completed = false) {
  if (completed) return '已完成';
  if (status === 'confirmed') return '已确认';
  if (status === 'cancelled_by_customer' || status === 'cancelled_by_owner') return '已取消';
  return '待确认';
}

function canCustomerCancel(status) {
  return status === 'pending' || status === 'confirmed';
}

function isFutureAppointment(startsAt, nowMs = Date.now()) {
  return Number.isFinite(Date.parse(startsAt)) && Date.parse(startsAt) > nowMs;
}

function customerCancellationAllowed(status, startsAt, nowMs = Date.now()) {
  if (status === 'pending') return true;
  return status === 'confirmed' && isFutureAppointment(startsAt, nowMs);
}

function isCompletedAppointment(appointment, nowMs = Date.now()) {
  if (!appointment || appointment.status !== 'confirmed') return false;
  const startsAt = Date.parse(appointment.startsAt || '');
  const durationMinutes = Math.max(0, Number(appointment.durationMinutes) || 0);
  return Number.isFinite(startsAt) && startsAt + durationMinutes * 60 * 1000 <= nowMs;
}

function isCancelledAppointment(appointment) {
  return appointment && ['cancelled_by_customer', 'cancelled_by_owner'].includes(appointment.status);
}

function isRecentCancellation(appointment, nowMs = Date.now()) {
  const cancelledAt = Date.parse(appointment && appointment.cancelledAt ? appointment.cancelledAt : '');
  return Number.isFinite(cancelledAt) && cancelledAt + 24 * 60 * 60 * 1000 > nowMs;
}

function addHoursIso(isoText, hours) {
  return new Date(Date.parse(isoText) + hours * 60 * 60 * 1000).toISOString();
}

function publicAppointment(appointment, ownerDisplayName, options = {}) {
  const completed = isCompletedAppointment(appointment, options.nowMs);
  return {
    id: appointment._id,
    bookingCode: appointment.bookingCode,
    serviceName: appointment.serviceName,
    scheduledDate: appointment.scheduledDate,
    scheduledTime: appointment.scheduledTime,
    durationMinutes: appointment.durationMinutes,
    status: appointment.status,
    statusLabel: statusLabel(appointment.status, completed),
    statusCopy: statusCopy(appointment.status, appointment.confirmedByName || ownerDisplayName, completed),
    canCancel: canCustomerCancel(appointment.status)
      && customerCancellationAllowed(appointment.status, appointment.startsAt),
    canHide: options.view === 'current' && isCancelledAppointment(appointment),
    confirmedAt: appointment.confirmedAt || null,
    confirmedByName: appointment.confirmedByName || null,
    cancelledAt: appointment.cancelledAt || null,
    cancelledByType: appointment.cancelledByType || null,
    customerHiddenAt: appointment.customerHiddenAt || null,
    archivedAt: appointment.archivedAt || null,
    createdAt: appointment.createdAt,
  };
}

async function cancelPendingNotificationJobs(appointmentId, now) {
  const result = await db.collection('notification_jobs').where({ appointmentId }).limit(20).get();
  const pendingJobs = result.data.filter((job) => !['sent', 'cancelled'].includes(job.status));
  await Promise.all(pendingJobs.map((job) => db.collection('notification_jobs').doc(job._id).update({
    data: { status: 'cancelled', cancelledAt: now, updatedAt: now },
  })));
}

exports.main = async (event = {}) => {
  const openid = cloud.getWXContext().OPENID;
  if (!openid) return { ok: false, code: 'LOGIN_REQUIRED', message: '微信登录状态已失效。' };
  const action = cleanText(event.action, 30) || 'list';

  try {
    const customerId = customerIdFor(openid);

    if (action === 'cancel') {
      const appointmentId = cleanText(event.appointmentId, 80);
      if (!appointmentId) return { ok: false, code: 'INVALID_APPOINTMENT', message: '预约信息不正确。' };

      const result = await db.runTransaction(async (transaction) => {
        const appointmentResult = await transaction.collection('appointments').doc(appointmentId).get().catch(() => null);
        const appointment = appointmentResult && appointmentResult.data ? appointmentResult.data : null;
        if (!appointment) throw new Error('APPOINTMENT_NOT_FOUND');
        if (appointment.customerId !== customerId) throw new Error('CUSTOMER_FORBIDDEN');
        if (appointment.status === 'cancelled_by_customer' || appointment.status === 'cancelled_by_owner') return appointment;
        if (!canCustomerCancel(appointment.status)) throw new Error('APPOINTMENT_NOT_CANCELLABLE');
        if (!customerCancellationAllowed(appointment.status, appointment.startsAt)) throw new Error('APPOINTMENT_STARTED');

        const slotResult = await transaction.collection('appointment_slots').where({ appointmentId }).limit(100).get();
        const releasedSlotIds = slotResult.data.map((slot) => slot._id);
        const now = new Date().toISOString();
        await transaction.collection('appointments').doc(appointmentId).update({
          data: {
            status: 'cancelled_by_customer',
            cancelledAt: now,
            cancelledByType: 'customer',
            cancelledById: customerId,
            cancelledByName: appointment.customerName || '客人',
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
            toStatus: 'cancelled_by_customer',
            actorType: 'customer',
            actorId: customerId,
            actorDisplayName: appointment.customerName || '客人',
            createdAt: now,
          },
        });
        await transaction.collection('audit_logs').doc(crypto.randomUUID()).set({
          data: {
            entityType: 'appointment',
            entityId: appointmentId,
            action: 'cancelled_by_customer',
            actorType: 'customer',
            actorId: customerId,
            detail: { previousStatus: appointment.status, releasedSlotIds },
            createdAt: now,
          },
        });
        return {
          ...appointment,
          status: 'cancelled_by_customer',
          cancelledAt: now,
          cancelledByType: 'customer',
        };
      });

      const cancelledAt = result.cancelledAt || new Date().toISOString();
      await cancelPendingNotificationJobs(appointmentId, cancelledAt).catch((error) => {
        console.warn('cancel notification jobs failed', error);
      });
      const settingsResult = await db.collection('settings').doc('system').get();
      return { ok: true, appointment: publicAppointment(result, settingsResult.data.ownerDisplayName || '白兰') };
    }

    if (action === 'hideCancelled') {
      const appointmentId = cleanText(event.appointmentId, 80);
      if (!appointmentId) return { ok: false, code: 'INVALID_APPOINTMENT', message: '预约信息不正确。' };
      const now = new Date().toISOString();
      await db.runTransaction(async (transaction) => {
        const appointmentResult = await transaction.collection('appointments').doc(appointmentId).get().catch(() => null);
        const appointment = appointmentResult && appointmentResult.data ? appointmentResult.data : null;
        if (!appointment) throw new Error('APPOINTMENT_NOT_FOUND');
        if (appointment.customerId !== customerId) throw new Error('CUSTOMER_FORBIDDEN');
        if (!isCancelledAppointment(appointment)) throw new Error('APPOINTMENT_NOT_HIDABLE');
        await transaction.collection('appointments').doc(appointmentId).update({
          data: { customerHiddenAt: now, updatedAt: now },
        });
        await transaction.collection('audit_logs').doc(crypto.randomUUID()).set({
          data: {
            entityType: 'appointment',
            entityId: appointmentId,
            action: 'hidden_from_customer_current_list',
            actorType: 'customer',
            actorId: customerId,
            detail: { status: appointment.status },
            createdAt: now,
          },
        });
      });
      return { ok: true, appointmentId };
    }

    if (action !== 'list') return { ok: false, code: 'UNKNOWN_ACTION', message: '未知的预约操作。' };

    const view = cleanText(event.view, 20) === 'history' ? 'history' : 'current';

    const [settingsResult, appointmentsResult] = await Promise.all([
      db.collection('settings').doc('system').get(),
      db.collection('appointments').where({ customerId }).limit(100).get(),
    ]);
    const ownerDisplayName = settingsResult.data.ownerDisplayName || '白兰';
    const nowMs = Date.now();
    const appointments = appointmentsResult.data
      .sort((a, b) => String(b.startsAt || '').localeCompare(String(a.startsAt || '')))
      .filter((appointment) => {
        if (view === 'history') return isCancelledAppointment(appointment) || isCompletedAppointment(appointment, nowMs);
        if (isCancelledAppointment(appointment)) {
          return !appointment.customerHiddenAt && isRecentCancellation(appointment, nowMs);
        }
        return !isCompletedAppointment(appointment, nowMs);
      })
      .map((appointment) => publicAppointment(appointment, ownerDisplayName, { view, nowMs }));
    return { ok: true, ownerDisplayName, view, appointments };
  } catch (error) {
    const message = String(error && error.message ? error.message : error);
    console.error('getMyAppointments failed', error);
    if (/APPOINTMENT_NOT_FOUND/.test(message)) return { ok: false, code: 'APPOINTMENT_NOT_FOUND', message: '没有找到这条预约。' };
    if (/CUSTOMER_FORBIDDEN/.test(message)) return { ok: false, code: 'CUSTOMER_FORBIDDEN', message: '只能取消您自己的预约。' };
    if (/APPOINTMENT_STARTED/.test(message)) return { ok: false, code: 'APPOINTMENT_STARTED', message: '护理时间已经开始，无法在线取消，请联系店主。' };
    if (/APPOINTMENT_NOT_HIDABLE/.test(message)) return { ok: false, code: 'APPOINTMENT_NOT_HIDABLE', message: '只有已取消的预约记录可以从当前列表删除。' };
    if (/APPOINTMENT_NOT_CANCELLABLE/.test(message)) return { ok: false, code: 'APPOINTMENT_NOT_CANCELLABLE', message: '当前预约状态不能取消，请刷新后查看。' };
    return { ok: false, code: 'MY_APPOINTMENTS_FAILED', message: '暂时无法处理预约记录。' };
  }
};
