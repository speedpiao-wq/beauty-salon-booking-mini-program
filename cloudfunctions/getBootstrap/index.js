const cloud = require('wx-server-sdk');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();
const command = db.command;

exports.main = async (event = {}) => {
  try {
    if (event.action === 'restNotices') {
      const settingsResult = await db.collection('settings').doc('system').get();
      const settings = settingsResult.data || {};
      const now = Date.now();
      const result = await db.collection('schedule_blocks').where({
        resourceId: settings.primaryResourceId || 'primary-room', active: command.neq(false),
        endsAt: command.gt(new Date(now).toISOString()),
        startsAt: command.lt(new Date(now + 31 * 86400000).toISOString()),
      }).orderBy('startsAt', 'asc').limit(100).get();
      return { ok: true, restNotices: result.data.map(block => ({
        startsAt: block.startsAt, endsAt: block.endsAt,
        message: String(block.note || '').trim().slice(0, 200) || '白兰偷懒,正在深度休息中~',
      })) };
    }
    const [settingsResult, servicesResult] = await Promise.all([
      db.collection('settings').doc('system').get(),
      db.collection('services')
        .where({ active: command.eq(true) })
        .orderBy('sortOrder', 'asc')
        .limit(50)
        .get(),
    ]);

    const settings = settingsResult.data || {};
    return {
      ok: true,
      system: {
        schemaVersion: Number(settings.schemaVersion) || 0,
        brandName: settings.brandName || '秀亚美容馆',
        ownerDisplayName: settings.ownerDisplayName || settings.teacherName || '白兰',
        timezone: settings.timezone || 'Asia/Shanghai',
        slotMinutes: settings.slotMinutes || 30,
        bookingWindowDays: settings.bookingWindowDays || 30,
        reminderLeadMinutes: Math.min(120, Math.max(60, Number(settings.reminderLeadMinutes) || 120)),
      },
      services: servicesResult.data.map((service) => ({
        _id: service._id,
        name: service.name,
        description: service.description || '',
        durationMinutes: service.durationMinutes,
        bookingBlockMinutes: Math.max(
          Number(service.durationMinutes) || 0,
          Number(service.bookingBlockMinutes) || Number(service.durationMinutes) || 0,
        ),
      })),
    };
  } catch (error) {
    console.error('getBootstrap failed', error);
    return {
      ok: false,
      code: 'DATABASE_NOT_READY',
      message: '云数据库尚未初始化或暂时不可用。',
    };
  }
};
