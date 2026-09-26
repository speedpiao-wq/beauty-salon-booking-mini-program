const crypto = require('crypto');
const cloud = require('wx-server-sdk');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();
const command = db.command;

function cleanText(value, maxLength) {
  return typeof value === 'string' ? value.trim().slice(0, maxLength) : '';
}

function adminIdFor(openid) {
  return crypto.createHash('sha256').update(openid).digest('hex');
}

function setupCodeHash(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function inviteCodeHash(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

async function getAdmin(openid) {
  const adminId = adminIdFor(openid);
  const result = await db.collection('admins').doc(adminId).get().catch(() => null);
  return result && result.data && result.data.active ? result.data : null;
}

async function requireSuperAdmin(openid) {
  const admin = await getAdmin(openid);
  if (!admin || admin.role !== 'super_admin') throw new Error('OWNER_FORBIDDEN');
  return admin;
}

function publicAdmin(admin) {
  return {
    id: admin._id,
    displayName: admin.displayName || '店主',
    role: admin.role,
    active: admin.active === true,
    createdAt: admin.createdAt || null,
    updatedAt: admin.updatedAt || null,
  };
}

exports.main = async (event = {}) => {
  const openid = cloud.getWXContext().OPENID;
  if (!openid) return { ok: false, code: 'LOGIN_REQUIRED', message: '微信登录状态已失效。' };
  const action = cleanText(event.action, 30) || 'context';
  const currentAdminId = adminIdFor(openid);

  try {
    if (action === 'context') {
      const [settingsResult, adminResult] = await Promise.all([
        db.collection('settings').doc('system').get(),
        db.collection('admins').doc(currentAdminId).get().catch(() => null),
      ]);
      const admin = adminResult && adminResult.data && adminResult.data.active ? adminResult.data : null;
      return {
        ok: true,
        isAdmin: Boolean(admin),
        admin: admin ? publicAdmin(admin) : null,
        ownerBindingStatus: settingsResult.data.ownerBindingStatus || 'pending',
      };
    }

    if (action === 'claimPrimary') {
      const setupCode = cleanText(event.setupCode, 64).toUpperCase();
      const displayName = '创始人';
      if (!setupCode) return { ok: false, code: 'SETUP_CODE_REQUIRED', message: '请输入首位店主绑定码。' };

      const result = await db.runTransaction(async (transaction) => {
        const settingsResult = await transaction.collection('settings').doc('system').get();
        const settings = settingsResult.data;
        if (settings.ownerBindingStatus !== 'pending') throw new Error('OWNER_ALREADY_BOUND');
        if (!settings.ownerSetupCodeHash || setupCodeHash(setupCode) !== settings.ownerSetupCodeHash) {
          throw new Error('INVALID_SETUP_CODE');
        }
        const now = new Date().toISOString();
        await transaction.collection('admins').doc(currentAdminId).set({
          data: {
            displayName,
            role: 'super_admin',
            active: true,
            createdAt: now,
            updatedAt: now,
          },
        });
        await transaction.collection('settings').doc('system').update({
          data: {
            ownerBindingStatus: 'bound',
            primaryAdminId: currentAdminId,
            ownerSetupCodeHash: command.remove(),
            updatedAt: now,
          },
        });
        await transaction.collection('audit_logs').doc(crypto.randomUUID()).set({
          data: {
            entityType: 'admin',
            entityId: currentAdminId,
            action: 'primary_owner_claimed',
            actorType: 'admin',
            actorId: currentAdminId,
            detail: { displayName, role: 'super_admin' },
            createdAt: now,
          },
        });
        return { displayName };
      });
      return { ok: true, isAdmin: true, role: 'super_admin', displayName: result.displayName };
    }

    if (['requestAccess', 'listRequests', 'approveRequest'].includes(action)) {
      return {
        ok: false,
        code: 'INVITE_REQUIRED',
        message: '共同店主只能使用创始人生成的一次性邀请码加入。',
      };
    }

    if (action === 'createInvite') {
      const currentAdmin = await requireSuperAdmin(openid);
      const inviteeDisplayName = cleanText(event.displayName, 20) || '共同店主';
      const inviteCode = `XY-${crypto.randomBytes(4).toString('hex').toUpperCase()}`;
      const codeHash = inviteCodeHash(inviteCode);
      const inviteId = `invite-${codeHash}`;
      const now = new Date();
      const expiresAt = new Date(now.getTime() + 24 * 60 * 60 * 1000).toISOString();
      await db.collection('admin_invites').doc(inviteId).set({
        data: {
          codeHash,
          role: 'owner',
          status: 'active',
          createdBy: currentAdmin._id,
          createdByName: '创始人',
          inviteeDisplayName,
          createdAt: now.toISOString(),
          expiresAt,
          consumedAt: null,
          consumedBy: null,
        },
      });
      await db.collection('audit_logs').doc(crypto.randomUUID()).set({
        data: {
          entityType: 'admin_invite',
          entityId: inviteId,
          action: 'owner_invite_created',
          actorType: 'admin',
          actorId: currentAdmin._id,
          detail: { role: 'owner', displayName: inviteeDisplayName, expiresAt },
          createdAt: now.toISOString(),
        },
      });
      return { ok: true, inviteCode, displayName: inviteeDisplayName, expiresAt };
    }

    if (action === 'acceptInvite') {
      const existingAdmin = await getAdmin(openid);
      if (existingAdmin) return { ok: true, alreadyAdmin: true, admin: publicAdmin(existingAdmin) };
      const inviteCode = cleanText(event.inviteCode, 40).toUpperCase();
      const requestedDisplayName = cleanText(event.displayName, 20);
      if (!inviteCode) {
        return { ok: false, code: 'INVITE_INPUT_REQUIRED', message: '请填写共同店主邀请码。' };
      }
      const inviteId = `invite-${inviteCodeHash(inviteCode)}`;
      const inviteResult = await db.collection('admin_invites').doc(inviteId).get().catch(() => null);
      const invite = inviteResult && inviteResult.data ? inviteResult.data : null;
      if (!invite) throw new Error('INVITE_INVALID');
      if (Date.parse(invite.expiresAt) <= Date.now()) throw new Error('INVITE_EXPIRED');

      const result = await db.runTransaction(async (transaction) => {
        const latestResult = await transaction.collection('admin_invites').doc(invite._id).get();
        const latest = latestResult.data;
        if (!latest || latest.status !== 'active') throw new Error('INVITE_INVALID');
        if (Date.parse(latest.expiresAt) <= Date.now()) throw new Error('INVITE_EXPIRED');
        const displayName = cleanText(latest.inviteeDisplayName, 20) || requestedDisplayName || '共同店主';
        const now = new Date().toISOString();
        await transaction.collection('admins').doc(currentAdminId).set({
          data: {
            displayName,
            role: 'owner',
            active: true,
            approvedBy: latest.createdBy,
            createdAt: now,
            updatedAt: now,
          },
        });
        await transaction.collection('admin_invites').doc(invite._id).update({
          data: {
            status: 'consumed',
            consumedAt: now,
            consumedBy: currentAdminId,
          },
        });
        await transaction.collection('audit_logs').doc(crypto.randomUUID()).set({
          data: {
            entityType: 'admin',
            entityId: currentAdminId,
            action: 'owner_invite_accepted',
            actorType: 'admin',
            actorId: currentAdminId,
            detail: { displayName, role: 'owner', approvedBy: latest.createdBy },
            createdAt: now,
          },
        });
        return { displayName };
      });
      return { ok: true, isAdmin: true, role: 'owner', displayName: result.displayName };
    }

    if (action === 'normalizeFounderName') {
      const currentAdmin = await requireSuperAdmin(openid);
      if (currentAdmin.displayName === '创始人') {
        return { ok: true, displayName: '创始人', unchanged: true };
      }
      const now = new Date().toISOString();
      await db.collection('admins').doc(currentAdminId).update({
        data: { displayName: '创始人', updatedAt: now },
      });
      await db.collection('audit_logs').doc(crypto.randomUUID()).set({
        data: {
          entityType: 'admin',
          entityId: currentAdminId,
          action: 'founder_display_name_normalized',
          actorType: 'admin',
          actorId: currentAdminId,
          detail: { previousDisplayName: currentAdmin.displayName || '', displayName: '创始人' },
          createdAt: now,
        },
      });
      return { ok: true, displayName: '创始人' };
    }

    if (action === 'listAdmins') {
      await requireSuperAdmin(openid);
      const result = await db.collection('admins').limit(50).get();
      return { ok: true, admins: result.data.map(publicAdmin) };
    }

    if (action === 'setAdminActive') {
      await requireSuperAdmin(openid);
      const targetAdminId = cleanText(event.adminId, 80);
      const active = event.active === true;
      const targetResult = await db.collection('admins').doc(targetAdminId).get();
      const target = targetResult.data;
      if (!target) throw new Error('ADMIN_NOT_FOUND');
      if (target.role === 'super_admin' && !active) throw new Error('CANNOT_DISABLE_PRIMARY');
      const now = new Date().toISOString();
      await db.collection('admins').doc(targetAdminId).update({ data: { active, updatedAt: now } });
      await db.collection('audit_logs').doc(crypto.randomUUID()).set({
        data: {
          entityType: 'admin',
          entityId: targetAdminId,
          action: active ? 'owner_access_enabled' : 'owner_access_disabled',
          actorType: 'admin',
          actorId: currentAdminId,
          detail: { displayName: target.displayName || '共同店主' },
          createdAt: now,
        },
      });
      return { ok: true, active };
    }

    return { ok: false, code: 'UNKNOWN_ACTION', message: '未知的店主权限操作。' };
  } catch (error) {
    const message = String(error && error.message ? error.message : error);
    console.error('ownerAccess failed', error);
    if (/OWNER_FORBIDDEN/.test(message)) return { ok: false, code: 'OWNER_FORBIDDEN', message: '当前微信没有管理权限。' };
    if (/OWNER_ALREADY_BOUND/.test(message)) return { ok: false, code: 'OWNER_ALREADY_BOUND', message: '首位店主已经绑定。' };
    if (/INVALID_SETUP_CODE/.test(message)) return { ok: false, code: 'INVALID_SETUP_CODE', message: '绑定码不正确。' };
    if (/INVITE_EXPIRED/.test(message)) return { ok: false, code: 'INVITE_EXPIRED', message: '邀请码已过期，请让创始人重新生成。' };
    if (/INVITE_INVALID/.test(message)) return { ok: false, code: 'INVITE_INVALID', message: '邀请码不正确或已经使用。' };
    if (/CANNOT_DISABLE_PRIMARY/.test(message)) return { ok: false, code: 'CANNOT_DISABLE_PRIMARY', message: '不能停用主店主账号。' };
    if (/ADMIN_NOT_FOUND/.test(message)) return { ok: false, code: 'ADMIN_NOT_FOUND', message: '没有找到该店主账号。' };
    return { ok: false, code: 'OWNER_ACCESS_FAILED', message: '暂时无法处理店主权限，请稍后重试。' };
  }
};
