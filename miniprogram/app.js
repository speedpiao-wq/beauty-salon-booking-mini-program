const CLOUD_ENV_ID = 'cloud1-d4gcqndo0762715da';

App({
  globalData: {
    cloudEnvId: CLOUD_ENV_ID,
    cloudReady: false,
  },

  onLaunch() {
    if (!wx.cloud) {
      console.error('当前基础库不支持云开发，请升级微信开发者工具或基础库。');
      return;
    }

    wx.cloud.init({
      env: CLOUD_ENV_ID,
      traceUser: true,
    });
    this.globalData.cloudReady = true;
  },
});
