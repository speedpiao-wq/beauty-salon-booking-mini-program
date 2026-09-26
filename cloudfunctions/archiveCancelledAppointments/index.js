const crypto = require('crypto');
const cloud = require('wx-server-sdk');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();
const ARCHIVE_AFTER_MS = 24 * 60 * 60 * 1000;
const CANCELLED_STATUSES = ['cancelled_by_customer', 'cancelled_by_owner'];

function adminIdFor(openid) {
  return crypto.createHash('sha256').update(openid).digest('hex');
}

function shouldArchive(appointment, nowMs = Date.now()) {
  if (!appointment || appointment.archivedAt || !CANCELLED_STATUSES.includes(appointment.status)) return false;
  const cancelledAt = Date.parse(appointment.cancelledAt || '');
  return Number.isFinite(cancelledAt) && cancelledAt + ARCHIVE_AFTER_MS <= nowMs;
}

async function requireAdmin(openid) {
  const result = await db.collection('admins').doc(adminIdFor(openid)).get().catch(() => null);
  if (!result || !result.data || !result.data.active || !['super_admin', 'owner'].includes(result.data.role)) {
    throw new Error('OWNER_FORBIDDEN');
  }
}

async function readAppointments(maxRecords = 500) {
  const records = [];
  for (let offset = 0; offset < maxRecords; offset += 100) {
    const result = await db.collection('appointments').skip(offset).limit(100).get();
    records.push(...result.data);
    if (result.data.length < 100) break;
  }
  return records;
}

async function readScheduledCandidates(nowIso) {
  const result = await db.collection('appointments')
    .where({ archiveAfter: db.command.lte(nowIso) })
    .limit(100)
    .get();
  return result.data;
}

exports.main = async (event = {}) => {
  const context = cloud.getWXContext();
  const isTimer = !context.OPENID && event.Type === 'Timer';
  const dryRun = event.dryRun === true;
  try {
    if (!isTimer) {
      if (!dryRun || !context.OPENID) throw new Error('ARCHIVE_FORBIDDEN');
      await requireAdmin(context.OPENID);
    }

    const nowMs = Date.now();
    const now = new Date(nowMs).toISOString();
    const [appointments, scheduledCandidates] = await Promise.all([
      readAppointments(),
      readScheduledCandidates(now),
    ]);
    const byId = new Map();
    for (const appointment of [...appointments, ...scheduledCandidates]) byId.set(appointment._id, appointment);
    const due = [...byId.values()].filter((appointment) => shouldArchive(appointment, nowMs));
    if (!dryRun) {
      for (const appointment of due) {
        await db.collection('appointments').doc(appointment._id).update({
          data: {
            archivedAt: now,
            archiveAfter: null,
            archiveReason: 'cancelled_24h',
            updatedAt: now,
          },
        });
        await db.collection('audit_logs').doc(crypto.randomUUID()).set({
          data: {
            entityType: 'appointment',
            entityId: appointment._id,
            action: 'archived_cancelled_appointment',
            actorType: 'system',
            actorId: 'archiveCancelledAppointments',
            detail: { status: appointment.status, cancelledAt: appointment.cancelledAt },
            createdAt: now,
          },
        });
      }
    }
    return {
      ok: true,
      dryRun,
      scanned: byId.size,
      scheduledCandidates: scheduledCandidates.length,
      due: due.length,
      archived: dryRun ? 0 : due.length,
    };
  } catch (error) {
    const message = String(error && error.message ? error.message : error);
    console.error('archiveCancelledAppointments failed', error);
    if (/OWNER_FORBIDDEN|ARCHIVE_FORBIDDEN/.test(message)) {
      return { ok: false, code: 'ARCHIVE_FORBIDDEN', message: '当前微信没有执行归档检查的权限。' };
    }
    return { ok: false, code: 'ARCHIVE_FAILED', message: '取消预约自动归档暂时失败。' };
  }
};
