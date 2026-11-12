// 首页：问候 + 余额 + 正在生成 + 最近 6 张 + 快捷入口
const { request, buildUrl, setCreditName, formatTime } = require('../../utils/request')

const STATE_TEXT = {
  queued: '排队中',
  running: '生成中',
  done: '已完成',
  error: '生成失败',
  canceled: '已取消'
}

const KIND_TEXT = {
  image: '图片任务',
  video: '视频任务'
}

function greetingByHour(hour) {
  if (hour < 6) return '凌晨好'
  if (hour < 11) return '早上好'
  if (hour < 14) return '中午好'
  if (hour < 18) return '下午好'
  return '晚上好'
}

function firstChar(text) {
  return text ? text.charAt(0) : '跨'
}

Page({
  data: {
    greeting: '你好',
    nickname: '',
    avatarText: '跨',
    roleText: '',
    brandName: '跨多多 AI 创作台',
    balance: 0,
    creditName: '算力',
    unitCost: 0,
    stats: { outputsTotal: 0, todayCount: 0 },
    tasks: [],
    recent: [],
    loading: true,
    error: ''
  },

  onLoad() {
    this.setData({
      greeting: greetingByHour(new Date().getHours())
    })
  },

  onShow() {
    this.load()
  },

  onPullDownRefresh() {
    this.load(true)
  },

  load(fromPull) {
    if (this._loading) {
      if (fromPull) wx.stopPullDownRefresh()
      return
    }
    this._loading = true
    const finish = () => {
      this._loading = false
      if (fromPull) wx.stopPullDownRefresh()
    }

    Promise.all([
      request({ url: '/api/m/bootstrap' }),
      request({ url: '/api/m/home' })
    ])
      .then((results) => {
        const boot = results[0] || {}
        const home = results[1] || {}
        const me = boot.me || {}
        const user = me.user || {}
        const brand = boot.brand || {}
        const creditName = home.creditName || me.creditName || '算力'
        const nickname = user.nickname || user.username || '朋友'
        const recent = (home.recent || []).slice(0, 6).map((item, index) => ({
          key: item.file || 'recent-' + index,
          file: item.file,
          url: item.url,
          fullUrl: buildUrl(item.url),
          isVideo: item.isVideo === true,
          promptText: item.prompt || ''
        }))

        setCreditName(creditName)
        this.setData({
          nickname: nickname,
          avatarText: firstChar(nickname),
          roleText: (user.roleNames || []).join(' / '),
          brandName: brand.appName || '跨多多 AI 创作台',
          balance: typeof home.balance === 'number' ? home.balance : (me.balance || 0),
          creditName: creditName,
          unitCost: (boot.costs && boot.costs.image) || 0,
          stats: {
            outputsTotal: (home.stats && home.stats.outputsTotal) || 0,
            todayCount: (home.stats && home.stats.todayCount) || 0
          },
          recent: recent,
          error: '',
          loading: false
        })

        if (home.activeTasks > 0) {
          return request({ url: '/api/m/tasks', showError: false }).catch(() => null)
        }
        return null
      })
      .then((tasksRes) => {
        if (!tasksRes) return
        const rows = (tasksRes.rows || []).map((row) => ({
          id: row.id,
          kind: row.kind,
          kindText: KIND_TEXT[row.kind] || '任务',
          state: row.state,
          stateText: STATE_TEXT[row.state] || row.state || '',
          timeText: formatTime(row.startedAt)
        }))
        this.setData({ tasks: rows })
      })
      .catch((err) => {
        this.setData({
          loading: false,
          error: (err && err.error) || '加载失败，请下拉刷新'
        })
      })
      .then(finish)
  },

  goCreate() {
    wx.switchTab({ url: '/pages/create/create' })
  },

  goGallery() {
    wx.switchTab({ url: '/pages/gallery/gallery' })
  },

  goRecharge() {
    wx.navigateTo({ url: '/pages/recharge/recharge' })
  },

  openJob(e) {
    const id = e.currentTarget.dataset.id
    if (!id) return
    wx.navigateTo({ url: '/pages/job/job?id=' + encodeURIComponent(id) })
  },

  previewRecent(e) {
    const index = Number(e.currentTarget.dataset.index)
    const item = this.data.recent[index]
    if (!item || !item.fullUrl) return
    if (item.isVideo) {
      if (wx.previewMedia) {
        wx.previewMedia({ sources: [{ url: item.fullUrl, type: 'video' }], current: 0 })
      } else {
        wx.showToast({ title: '当前微信版本不支持视频预览', icon: 'none' })
      }
      return
    }
    const urls = this.data.recent
      .filter((row) => !row.isVideo && row.fullUrl)
      .map((row) => row.fullUrl)
    wx.previewImage({ current: item.fullUrl, urls: urls })
  },

  retry() {
    this.setData({ loading: true, error: '' })
    this.load()
  }
})
