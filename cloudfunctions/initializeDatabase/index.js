const cloud = require('wx-server-sdk');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();
const SCHEMA_VERSION = 8;
const OWNER_SETUP_CODE_HASH = '8c2e15c102322c07862c2e6e304f8350aee0cc619047ddcb194b57c6fe8a3fa2';
const COLLECTIONS = [
  'services',
  'settings',
  'business_hours',
  'schedule_blocks',
  'customers',
  'appointments',
  'appointment_slots',
  'notification_jobs',
  'audit_logs',
  'idempotency_keys',
  'admins',
  'admin_requests',
  'appointment_events',
  'admin_invites',
];

const SERVICES = [
  {
    _id: 'basic-care',
    name: '芳香精油净润护理',
    description: '甄选多特瑞精油，融合清洁、滋养与芳香放松体验',
    durationMinutes: 60,
    bookingBlockMinutes: 150,
    active: true,
    sortOrder: 10,
  },
  {
    _id: 'anti-aging-sculpt',
    name: '手法提拉塑颜护理',
    description: '聚焦手法提拉与面部轮廓塑形',
    durationMinutes: 90,
    bookingBlockMinutes: 180,
    active: true,
    sortOrder: 20,
  },
];
const RETIRED_SERVICE_IDS = ['deep-clean', 'soothing-care'];

async function ensureCollection(name) {
  try {
    await db.createCollection(name);
    return { name, status: 'created' };
  } catch (error) {
    const message = String(error && (error.errMsg || error.message || error));
    if (/exist|exists|已存在|DATABASE_COLLECTION_EXIST/i.test(message)) {
      return { name, status: 'exists' };
    }
    throw error;
  }
}

async function upsertService(service, now) {
  const reference = db.collection('services').doc(service._id);
  const existing = await reference.get().catch(() => null);
  const { _id, ...data } = service;
  await reference.set({
    data: {
      ...data,
      createdAt: existing && existing.data ? existing.data.createdAt || now : now,
      updatedAt: now,
    },
  });
}

async function retireService(serviceId, now) {
  const reference = db.collection('services').doc(serviceId);
  const existing = await reference.get().catch(() => null);
  if (existing && existing.data) {
    await reference.update({ data: { active: false, updatedAt: now } });
  }
}

exports.main = async (event) => {
  if (!event || event.confirm !== 'INIT_XIUYA_V1') {
    return { ok: false, code: 'CONFIRMATION_REQUIRED', message: '初始化确认参数不正确。' };
  }

  const collections = [];
  for (const name of COLLECTIONS) {
    collections.push(await ensureCollection(name));
  }

  const now = db.serverDate();
  const systemReference = db.collection('settings').doc('system');
  const systemDocument = await systemReference.get().catch(() => null);
  const initialized = Boolean(systemDocument && systemDocument.data);
  const previousSchemaVersion = initialized ? Number(systemDocument.data.schemaVersion) || 0 : 0;
  if (!initialized) {
    await systemReference.set({
      data: {
        schemaVersion: SCHEMA_VERSION,
        brandName: '秀亚美容馆',
        ownerDisplayName: '白兰',
        timezone: 'Asia/Shanghai',
        slotMinutes: 30,
        bookingWindowDays: 30,
        reminderLeadMinutes: 120,
        customTimeStart: '09:00',
        customTimeEnd: '20:00',
        primaryResourceId: 'primary-room',
        ownerBindingStatus: 'pending',
        ownerSetupCodeHash: OWNER_SETUP_CODE_HASH,
        createdAt: now,
        updatedAt: now,
      },
    });
  } else if (previousSchemaVersion < SCHEMA_VERSION) {
    const migrationData = {
      schemaVersion: SCHEMA_VERSION,
      ownerDisplayName: '白兰',
      teacherName: '白兰',
      reminderLeadMinutes: 120,
      updatedAt: now,
    };
    if ((systemDocument.data.ownerBindingStatus || 'pending') === 'pending') {
      migrationData.ownerSetupCodeHash = OWNER_SETUP_CODE_HASH;
    }
    await systemReference.update({ data: migrationData });
  }

  for (const service of SERVICES) {
    await upsertService(service, now);
  }
  for (const serviceId of RETIRED_SERVICE_IDS) {
    await retireService(serviceId, now);
  }

  if (!initialized) {
    const defaultSlots = ['09:30', '12:00', '15:00', '18:00'];
    for (let weekday = 0; weekday <= 6; weekday += 1) {
      await db.collection('business_hours').doc(`weekday-${weekday}`).set({
        data: {
          weekday,
          enabled: true,
          openingSlots: defaultSlots,
          createdAt: now,
          updatedAt: now,
        },
      });
    }
  }

  return {
    ok: true,
    initialized: !initialized,
    migrated: initialized && previousSchemaVersion < SCHEMA_VERSION,
    previousSchemaVersion,
    schemaVersion: Math.max(previousSchemaVersion, SCHEMA_VERSION),
    collections,
  };
};
