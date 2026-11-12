// 跨多多 AI 创作台 · 手机端入口
// 服务端就是电脑端自带的本机服务：默认 http://127.0.0.1:5199；
// 手机联调时在「我的」页改成电脑的局域网 IP（写入 storage，重启小程序生效）。

const DEFAULT_BASE_URL = 'http://127.0.0.1:5199'

App({
  globalData: {
    baseUrl: DEFAULT_BASE_URL,
    version: '1.0.0'
  },

  onLaunch() {
    let saved = ''
    try {
      saved = wx.getStorageSync('ac_base_url') || ''
    } catch (err) {
      saved = ''
    }
    if (saved && typeof saved === 'string') {
      this.globalData.baseUrl = saved.trim().replace(/\/+$/, '')
    }
  }
})
