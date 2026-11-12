// 进度：1500ms 轮询 /api/m/jobs/:id，渲染最近 3 条进度；done/error/canceled 停止
const { request, buildUrl, saveMedia, formatTime, getCreditName } = require('../../utils/request')

const POLL_MS = 1500
const TERMINAL_STATES = { done: true, error: true, canceled: true }
const STATE_TEXT = {
  queued: '排队中',
  running: '生成中',
  done: '已完成',
  error: '生成失败',
  canceled: '已取消'
}

function pad2(n) {
  return n < 10 ? '0' + n : '' + n
}

Page({
  data: {
    id: '',
    loading: true,
    job: null,
    state: 'queued',
    stateText: '排队中',
    isTerminal: false,
    progressList: [],
    images: [],
    errorText: '',
    netHint: '',
    elapsedText: '0 秒',
    creditName: '算力',
    costText: '—',
    balanceText: '—',
    canceling: false,
    cancelRequested: false
  },

  onLoad(options) {
    const rawId = options && options.id ? options.id : ''
    let id = ''
    try {
      id = decodeURIComponent(rawId)
    } catch (err) {
      id = rawId
    }
    if (!id) {
      wx.showToast({ title: '缺少任务编号', icon: 'none' })
      setTimeout(() => {
        wx.navigateBack()
      }, 600)
      return
    }
    this._loadedAt = Date.now()
    this._pollErrors = 0
    this._lastTitle = ''
    this.setData({
      id: id,
      creditName: getCreditName()
    })
  },

  onShow() {
    if (!this.data.id) return
    if (!this.data.isTerminal) {
      this.startPolling()
    }
  },

  onHide() {
    this.stopPolling()
  },

  onUnload() {
    // 关键：离开页面必须清掉定时器，否则会在后台一直轮询。
    this.stopPolling()
  },

  startPolling() {
    this.stopPolling()
    this.poll()
    this._timer = setInterval(() => {
      this.poll()
    }, POLL_MS)
    this._tick = setInterval(() => {
      this.refreshElapsed()
    }, 1000)
  },

  stopPolling() {
    if (this._timer) {
      clearInterval(this._timer)
      this._timer = null
    }
    if (this._tick) {
      clearInterval(this._tick)
      this._tick = null
    }
  },

  poll() {
    if (!this.data.id || this._polling) return
    this._polling = true
    request({
      url: '/api/m/jobs/' + encodeURIComponent(this.data.id),
      showError: false
    })
      .then((res) => {
        this._polling = false
        this._pollErrors = 0
        if (this.data.netHint) this.setData({ netHint: '' })
        this.applyJob((res && res.job) || {})
      })
      .catch((err) => {
        this._polling = false
        if (err && err.statusCode === 401) {
          this.stopPolling()
          return
        }
        if (err && err.statusCode === 404) {
          this.stopPolling()
          this.setData({
            loading: false,
            state: 'error',
            stateText: '任务不存在',
            isTerminal: true,
            errorText: (err && err.error) || '任务不存在或已被清理'
          })
          return
        }
        this._pollErrors = (this._pollErrors || 0) + 1
        if (this._pollErrors >= 2 && !this.data.netHint) {
          this.setData({ netHint: '网络不稳定，正在自动重试…' })
        }
      })
  },

  applyJob(job) {
    const state = job.state || 'queued'
    const terminal = TERMINAL_STATES[state] === true
    const progress = Array.isArray(job.progress) ? job.progress : []
    const startIndex = Math.max(0, progress.length - 3)
    const progressList = progress.slice(-3).map((item, index) => ({
      key: 'p-' + (startIndex + index),
      text: item.text || '',
      timeText: formatTime(item.at)
    }))
    const images = (job.images || []).map((item) => ({
      file: item.file || '',
      url: item.url,
      fullUrl: buildUrl(item.url),
      timeText: formatTime(item.mtime)
    })).filter((item) => !!item.fullUrl)

    const creditName = this.data.creditName || '算力'
    const costValue = typeof job.cost === 'number' ? job.cost : '—'
    const balanceValue = typeof job.balance === 'number' ? job.balance : '—'

    this.setData({
      loading: false,
      job: job,
      state: state,
      stateText: STATE_TEXT[state] || state,
      isTerminal: terminal,
      progressList: progressList,
      images: images,
      errorText: job.error || '',
      costText: costValue + ' ' + creditName,
      balanceText: balanceValue + ' ' + creditName,
      netHint: ''
    })

    const title = STATE_TEXT[state] || '生成进度'
    if (title !== this._lastTitle) {
      this._lastTitle = title
      wx.setNavigationBarTitle({ title: title })
    }

    this.refreshElapsed()
    if (terminal) {
      this.stopPolling()
    }
  },

  refreshElapsed() {
    const job = this.data.job
    if (!job) return
    let start = job.createdAt || 0
    if (!start && job.progress && job.progress.length) {
      start = job.progress[0].at || 0
    }
    if (!start) start = this._loadedAt || 0
    if (!start) return
    const end = job.endedAt || Date.now()
    const seconds = Math.max(0, Math.floor((end - start) / 1000))
    const text = seconds < 60
      ? seconds + ' 秒'
      : Math.floor(seconds / 60) + ' 分 ' + pad2(seconds % 60) + ' 秒'
    if (text !== this.data.elapsedText) {
      this.setData({ elapsedText: text })
    }
  },

  cancelJob() {
    if (this.data.canceling || this.data.cancelRequested) return
    wx.showModal({
      title: '取消任务',
      content: '确定取消这个生成任务吗？',
      success: (res) => {
        if (!res.confirm) return
        this.setData({ canceling: true })
        request({
          url: '/api/m/jobs/' + encodeURIComponent(this.data.id) + '/cancel',
          method: 'POST'
        })
          .then(() => {
            // 契约 3.10：取消是真的停上游并回滚预扣，立刻查可能看到 done/error
            // 以及退回的余额，所以不本地写死 canceled，继续轮询以服务端状态为准。
            this.setData({ canceling: false, cancelRequested: true })
            wx.showToast({ title: '已提交取消，正在同步状态', icon: 'none' })
            this.poll()
          })
          .catch(() => {
            this.setData({ canceling: false })
          })
      }
    })
  },

  previewResult(e) {
    if (this._longPressAt && Date.now() - this._longPressAt < 800) return
    const index = Number(e.currentTarget.dataset.index)
    const item = this.data.images[index]
    if (!item || !item.fullUrl) return
    wx.previewImage({
      current: item.fullUrl,
      urls: this.data.images.map((row) => row.fullUrl)
    })
  },

  saveResult(e) {
    this._longPressAt = Date.now()
    const index = Number(e.currentTarget.dataset.index)
    const item = this.data.images[index]
    if (!item) return
    wx.showActionSheet({
      itemList: ['保存图片到相册'],
      success() {
        saveMedia(item.url, false)
      }
    })
  },

  goCreate() {
    wx.switchTab({ url: '/pages/create/create' })
  },

  goHome() {
    wx.switchTab({ url: '/pages/home/home' })
  },

  goGallery() {
    wx.switchTab({ url: '/pages/gallery/gallery' })
  }
})
