// 我的：用户信息/余额、改密码、退出登录、服务端地址调试、版本号
const {
  request,
  getBaseUrl,
  normalizeBaseUrl,
  setCreditName,
  clearToken,
  BASE_URL_KEY,
  DEFAULT_BASE_URL
} = require('../../utils/request')

function firstChar(text) {
  return text ? text.charAt(0) : '跨'
}

Page({
  data: {
    loading: true,
    username: '',
    nickname: '',
    avatarText: '跨',
    roleNames: [],
    balance: 0,
    creditName: '算力',
    appVersion: '1.0.0',
    serverVersion: '—',
    baseUrl: '',
    baseUrlSaved: '',
    baseUrlDraft: '',
    baseUrlPending: false,
    oldPassword: '',
    newPassword: '',
    confirmPassword: '',
    pwdSubmitting: false
  },

  onShow() {
    let appVersion = '1.0.0'
    try {
      appVersion = getApp().globalData.version || '1.0.0'
    } catch (err) {
      appVersion = '1.0.0'
    }
    let saved = ''
    try {
      saved = wx.getStorageSync(BASE_URL_KEY) || ''
    } catch (err) {
      saved = ''
    }
    const baseUrl = getBaseUrl()
    this.setData({
      appVersion: appVersion,
      baseUrl: baseUrl,
      baseUrlSaved: saved,
      baseUrlDraft: saved || baseUrl,
      baseUrlPending: !!saved && normalizeBaseUrl(saved) !== baseUrl
    })
    this.loadProfile()
  },

  loadProfile() {
    this.setData({ loading: true })
    request({ url: '/api/m/bootstrap' })
      .then((boot) => {
        const me = boot.me || {}
        const user = me.user || {}
        const creditName = me.creditName || '算力'
        const username = user.username || ''
        const nickname = user.nickname || username
        setCreditName(creditName)
        this.setData({
          loading: false,
          username: username,
          nickname: nickname,
          avatarText: firstChar(nickname),
          roleNames: user.roleNames || [],
          balance: typeof me.balance === 'number' ? me.balance : 0,
          creditName: creditName,
          serverVersion: (boot.server && boot.server.version) || '—'
        })
      })
      .catch(() => {
        this.setData({ loading: false })
      })
  },

  onPwdInput(e) {
    const field = e.currentTarget.dataset.field
    const patch = {}
    patch[field] = e.detail.value
    this.setData(patch)
  },

  submitPassword() {
    if (this.data.pwdSubmitting) return
    const oldPassword = this.data.oldPassword || ''
    const newPassword = this.data.newPassword || ''
    const confirmPassword = this.data.confirmPassword || ''

    if (!oldPassword) {
      wx.showToast({ title: '请输入当前密码', icon: 'none' })
      return
    }
    if (!newPassword) {
      wx.showToast({ title: '请输入新密码', icon: 'none' })
      return
    }
    if (newPassword.length < 6) {
      wx.showToast({ title: '新密码至少 6 位', icon: 'none' })
      return
    }
    if (newPassword !== confirmPassword) {
      wx.showToast({ title: '两次新密码不一致', icon: 'none' })
      return
    }
    if (newPassword === oldPassword) {
      wx.showToast({ title: '新密码不能与当前密码相同', icon: 'none' })
      return
    }

    this.setData({ pwdSubmitting: true })
    request({
      url: '/api/m/auth/password',
      method: 'POST',
      data: { oldPassword: oldPassword, newPassword: newPassword },
      noAuthRedirect: true
    })
      .then((res) => {
        const kicked = res && typeof res.kicked === 'number' ? res.kicked : 0
        this.setData({
          pwdSubmitting: false,
          oldPassword: '',
          newPassword: '',
          confirmPassword: ''
        })
        wx.showModal({
          title: '密码已修改',
          content: kicked > 0
            ? '其他设备已下线（' + kicked + ' 台），本机保持登录。'
            : '其他设备已下线，本机保持登录。',
          showCancel: false
        })
      })
      .catch(() => {
        this.setData({ pwdSubmitting: false })
      })
  },

  logout() {
    wx.showModal({
      title: '退出登录',
      content: '确定退出当前账号吗？',
      success: (res) => {
        if (!res.confirm) return
        wx.showLoading({ title: '退出中', mask: true })
        request({
          url: '/api/m/auth/logout',
          method: 'POST',
          showError: false,
          noAuthRedirect: true
        })
          .catch(() => null)
          .then(() => {
            wx.hideLoading()
            clearToken()
            wx.reLaunch({ url: '/pages/login/login' })
          })
      }
    })
  },

  onBaseUrlInput(e) {
    this.setData({ baseUrlDraft: e.detail.value })
  },

  saveBaseUrl() {
    const raw = (this.data.baseUrlDraft || '').trim()
    if (!raw) {
      wx.showToast({ title: '请输入服务端地址', icon: 'none' })
      return
    }
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
    this.setData({
      baseUrlSaved: normalized,
      baseUrlDraft: normalized,
      baseUrlPending: normalized !== getBaseUrl()
    })
    wx.showModal({
      title: '已保存',
      content: '服务端地址已改为 ' + normalized + '，重启小程序后生效。',
      showCancel: false
    })
  },

  resetBaseUrl() {
    try {
      wx.removeStorageSync(BASE_URL_KEY)
    } catch (err) {
      // 忽略：storage 不可用时保持现状
    }
    this.setData({
      baseUrlSaved: '',
      baseUrlDraft: DEFAULT_BASE_URL,
      baseUrlPending: getBaseUrl() !== DEFAULT_BASE_URL
    })
    wx.showModal({
      title: '已恢复默认',
      content: '默认地址为 ' + DEFAULT_BASE_URL + '，重启小程序后生效。',
      showCancel: false
    })
  },

  goCreate() {
    wx.switchTab({ url: '/pages/create/create' })
  },

  goRecharge() {
    wx.navigateTo({ url: '/pages/recharge/recharge' })
  }
})
