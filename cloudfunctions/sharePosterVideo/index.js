const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const cloud = require('wx-server-sdk');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();

function adminIdFor(openid) {
  return crypto.createHash('sha256').update(openid).digest('hex');
}

async function requireAdmin(openid) {
  const result = await db.collection('admins').doc(adminIdFor(openid)).get().catch(() => null);
  const admin = result && result.data;
  if (!admin || !admin.active || !['super_admin', 'owner'].includes(admin.role)) throw new Error('OWNER_FORBIDDEN');
}

function validFileID(value) {
  return typeof value === 'string' && /^cloud:\/\/[^\s]{1,500}$/.test(value);
}

exports.main = async (event = {}) => {
  const openid = cloud.getWXContext().OPENID;
  const kind = event.kind;
  const dayCount = event.dayCount == null ? 1 : Number(event.dayCount);
  if (!openid || !validFileID(event.fileID) || !['empty', 'booked'].includes(kind)
    || !Number.isInteger(dayCount) || dayCount < 1 || dayCount > 3
    || (kind === 'empty' && !validFileID(event.finalFileID))) {
    return { ok: false, message: '动态视频请求不正确。' };
  }
  let directory;
  try {
    await requireAdmin(openid);
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'xiuyavideo-'));
    const basePath = path.join(directory, 'base.png');
    const finalPath = path.join(directory, 'final.png');
    const outputPath = path.join(directory, 'share.mp4');
    const base = await cloud.downloadFile({ fileID: event.fileID });
    if (!base.fileContent || base.fileContent.length > 8 * 1024 * 1024) throw new Error('INVALID_VIDEO_INPUT');
    fs.writeFileSync(basePath, base.fileContent);
    if (kind === 'empty') {
      const ending = await cloud.downloadFile({ fileID: event.finalFileID });
      if (!ending.fileContent || ending.fileContent.length > 8 * 1024 * 1024) throw new Error('INVALID_VIDEO_INPUT');
      fs.writeFileSync(finalPath, ending.fileContent);
    }
    const ffmpegPath = require('@ffmpeg-installer/ffmpeg').path;
    const { renderVideo } = require('./render');
    await renderVideo(ffmpegPath, {
      basePath, finalPath, outputPath, kind, dayCount,
      angelPath: path.join(__dirname, 'assets', 'share-angel-flapping.gif'),
    });
    const uploaded = await cloud.uploadFile({
      cloudPath: `share-video-output/${crypto.randomUUID()}.mp4`,
      fileContent: fs.readFileSync(outputPath),
    });
    return { ok: true, fileID: uploaded.fileID };
  } catch (error) {
    console.error('sharePosterVideo failed', error);
    const detail = String(error && error.message || error);
    if (detail.includes('OWNER_FORBIDDEN')) return { ok: false, code: 'OWNER_FORBIDDEN', message: '当前微信没有店主权限。' };
    const code = /ffmpeg|spawn/i.test(detail) ? 'VIDEO_ENCODER_UNAVAILABLE'
      : /fileContent|downloadFile|INVALID_VIDEO_INPUT/i.test(detail) ? 'VIDEO_INPUT_UNAVAILABLE'
        : /uploadFile/i.test(detail) ? 'VIDEO_UPLOAD_FAILED' : 'VIDEO_RENDER_FAILED';
    const messages = {
      VIDEO_ENCODER_UNAVAILABLE: '视频生成暂时不可用，请稍后重试。',
      VIDEO_INPUT_UNAVAILABLE: '海报素材读取失败，请重新生成分享图后重试。',
      VIDEO_UPLOAD_FAILED: '视频保存到云端失败，请稍后重试。',
      VIDEO_RENDER_FAILED: '动态视频生成失败，请稍后重试。',
    };
    return { ok: false, code, message: messages[code] };
  } finally {
    if (directory) {
      for (const name of ['base.png', 'final.png', 'share.mp4']) {
        const file = path.join(directory, name);
        if (fs.existsSync(file)) fs.unlinkSync(file);
      }
      fs.rmdirSync(directory);
    }
  }
};
