// 登录页：账号 / 密码 + 自动登录（storage 里有 token 就跳首页）
const {
  request,
  setToken,
  getToken,
  getBaseUrl,
  normalizeBaseUrl,
  BASE_URL_KEY
} = require('../../utils/request')

Page({
  data: {
    username: '',
    password: '',
    loading: false,
    error: '',
    baseUrl: ''
  },

  onLoad() {
    this.setData({ baseUrl: getBaseUrl() })
    if (getToken()) {
      wx.switchTab({ url: '/pages/home/home' })
    }
  },

  onShow() {
    this.setData({ baseUrl: getBaseUrl() })
  },

  onInput(e) {
    const field = e.currentTarget.dataset.field
    const patch = {}
    patch[field] = e.detail.value
    patch.error = ''
    this.setData(patch)
  },

  // 登录前也能改地址：真机连不上 127.0.0.1 时先改这里。
  onServerTap() {
    const current = this.data.baseUrl
    wx.showModal({
      title: '服务端地址',
      editable: true,
      placeholderText: current,
      confirmText: '保存',
      success: (res) => {
        if (!res.confirm) return
        const raw = (res.content || '').trim()
        if (!raw) return
        if (!/^https?:\/\//i.test(raw)) {
          wx.showToast({ title: '地址需以 http:// 或 https:// 开头', icon: 'none' })
          return
        }
        const normalized = normalizeBaseUrl(raw)
        try {
          wx.setStorageSync(BASE_URL_KEY, normalized)
        } catch (err) {
          wx.showToast({ title: '保存失败', icon: 'none' })
          return
        }
        try {
          getApp().globalData.baseUrl = normalized
        } catch (err) {
          // 忽略：storage 已写入，重启后同样生效
        }
        this.setData({ baseUrl: normalized })
        wx.showToast({ title: '已保存', icon: 'none' })
      }
    })
  },

  submit() {
    if (this.data.loading) return
    const username = (this.data.username || '').trim()
    const password = this.data.password || ''
    if (!username) {
      this.setData({ error: '请输入账号' })
      return
    }
    if (!password) {
      this.setData({ error: '请输入密码' })
      return
    }

    this.setData({ loading: true, error: '' })
    request({
      url: '/api/m/auth/login',
      method: 'POST',
      data: { username: username, password: password },
      showError: false,
      noAuthRedirect: true
    })
      .then((res) => {
        if (!res || !res.token) {
          throw { error: '登录响应缺少 token，请检查服务端版本' }
        }
        setToken(res.token)
        this.setData({ loading: false })
        wx.switchTab({ url: '/pages/home/home' })
      })
      .catch((err) => {
        this.setData({
          loading: false,
          error: (err && err.error) || '登录失败，请重试'
        })
      })
  }
})
