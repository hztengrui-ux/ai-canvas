// 看图：两列瀑布网格 + 下拉刷新 + 触底加载（offset 分页）+ 时间/项目筛选 + 全屏预览/保存
const { request, buildUrl, saveMedia, formatTime, getCreditName } = require('../../utils/request')

const PAGE_SIZE = 24

// 时间筛选：只传 from（含），不传 to。「今天」用设备本地 0 点，不用 UTC。
const TIME_OPTIONS = [
  { id: 'all', label: '全部', offsetDays: -1 },
  { id: 'today', label: '今天', offsetDays: 0 },
  { id: '7d', label: '近 7 天', offsetDays: 6 },
  { id: '30d', label: '近 30 天', offsetDays: 29 }
]

function startOfLocalDay(offsetDays) {
  const date = new Date()
  date.setHours(0, 0, 0, 0)
  if (offsetDays > 0) date.setDate(date.getDate() - offsetDays)
  return date.getTime()
}

function timeFromOf(id) {
  for (let i = 0; i < TIME_OPTIONS.length; i++) {
    if (TIME_OPTIONS[i].id === id) {
      const offsetDays = TIME_OPTIONS[i].offsetDays
      return offsetDays < 0 ? 0 : startOfLocalDay(offsetDays)
    }
  }
  return 0
}

function normalizeRow(row, index) {
  const cost = typeof row.cost === 'number' ? row.cost : 0
  return {
    key: row.file || 'row-' + index,
    file: row.file || '',
    url: row.url || '',
    fullUrl: buildUrl(row.url),
    isVideo: row.isVideo === true,
    cost: cost,
    costText: cost ? cost + ' ' + getCreditName() : '',
    owner: row.owner || '',
    promptText: row.prompt || '未记录提示词',
    projectId: row.projectId || '',
    projectName: row.projectName || '',
    timeText: formatTime(row.mtime)
  }
}

// 两列瀑布：按下标奇偶分列，图片用 widthFix 保持原始比例。
function splitColumns(rows) {
  const colA = []
  const colB = []
  rows.forEach((row, index) => {
    if (index % 2 === 0) {
      colA.push(row)
    } else {
      colB.push(row)
    }
  })
  return { colA: colA, colB: colB }
}

// filters.projects 是「未筛选全量」的统计，只用来渲染 chip 数量，不参与二次过滤。
// 顺序固定：全部 → 未归属（project=__none）→ 各项目。
function buildProjectOptions(filters) {
  const list = (filters && filters.projects) || []
  const options = [{ value: '', label: '全部', count: 0, showCount: false }]
  let unassignedCount = 0
  const named = []

  list.forEach((item) => {
    if (!item) return
    const count = typeof item.count === 'number' ? item.count : 0
    if (!item.id) {
      unassignedCount += count
      return
    }
    const id = String(item.id)
    named.push({
      value: id,
      label: item.name || ('项目 · ' + id.slice(-4)),
      count: count,
      showCount: true
    })
  })

  options.push({
    value: '__none',
    label: '未归属',
    count: unassignedCount,
    showCount: true
  })
  return options.concat(named)
}

Page({
  data: {
    rows: [],
    colA: [],
    colB: [],
    total: 0,
    hasMore: true,
    loading: true,
    initialized: false,
    error: '',
    timeOptions: TIME_OPTIONS,
    timeId: 'all',
    timeFrom: 0,
    projectOptions: [],
    projectValue: '',
    emptyText: '还没有生成过作品'
  },

  onShow() {
    this.loadFirst()
  },

  onPullDownRefresh() {
    this.loadFirst(true)
  },

  onReachBottom() {
    this.loadMore()
  },

  outputsUrl(offset) {
    const parts = ['offset=' + offset, 'limit=' + PAGE_SIZE]
    if (this.data.timeFrom) parts.push('from=' + this.data.timeFrom)
    if (this.data.projectValue) {
      parts.push('project=' + encodeURIComponent(this.data.projectValue))
    }
    return '/api/m/outputs?' + parts.join('&')
  },

  emptyTextFor(projectValue, timeId) {
    if (projectValue === '__none') {
      return timeId === 'all' ? '未归属项目里还没有图' : '未归属项目在这个时间段还没有图'
    }
    if (projectValue) {
      return timeId === 'all' ? '这个项目还没有图' : '这个项目在这个时间段还没有图'
    }
    if (timeId !== 'all') return '这个时间段还没有图'
    return '还没有生成过作品'
  },

  loadFirst(fromPull) {
    // 每次筛选变化都会换 seq，旧请求回来时直接丢弃，避免串数据。
    const seq = (this._seq || 0) + 1
    this._seq = seq
    this.setData({ loading: true, error: '' })
    const finish = () => {
      if (fromPull) wx.stopPullDownRefresh()
    }

    request({ url: this.outputsUrl(0) })
      .then((res) => {
        if (seq !== this._seq) return
        const rows = (res.rows || []).map(normalizeRow)
        const cols = splitColumns(rows)
        this.setData({
          rows: rows,
          colA: cols.colA,
          colB: cols.colB,
          total: typeof res.total === 'number' ? res.total : rows.length,
          hasMore: res.hasMore === true,
          projectOptions: buildProjectOptions(res.filters),
          emptyText: this.emptyTextFor(this.data.projectValue, this.data.timeId),
          loading: false,
          initialized: true,
          error: ''
        })
      })
      .catch((err) => {
        if (seq !== this._seq) return
        this.setData({
          loading: false,
          initialized: true,
          error: (err && err.error) || '加载失败，请下拉刷新'
        })
      })
      .then(finish)
  },

  loadMore() {
    if (this.data.loading || !this.data.initialized || !this.data.hasMore) return
    const seq = this._seq
    this.setData({ loading: true })

    request({ url: this.outputsUrl(this.data.rows.length) })
      .then((res) => {
        if (seq !== this._seq) return
        const more = (res.rows || []).map(normalizeRow)
        const rows = this.data.rows.concat(more)
        const cols = splitColumns(rows)
        this.setData({
          rows: rows,
          colA: cols.colA,
          colB: cols.colB,
          total: typeof res.total === 'number' ? res.total : rows.length,
          hasMore: res.hasMore === true,
          projectOptions: buildProjectOptions(res.filters),
          loading: false
        })
      })
      .catch(() => {
        if (seq !== this._seq) return
        this.setData({ loading: false })
      })
  },

  onTime(e) {
    const id = e.currentTarget.dataset.id
    if (!id || id === this.data.timeId) return
    this.setData({
      timeId: id,
      timeFrom: timeFromOf(id),
      rows: [],
      colA: [],
      colB: [],
      total: 0,
      hasMore: true,
      emptyText: this.emptyTextFor(this.data.projectValue, id)
    })
    this.loadFirst()
  },

  onProject(e) {
    const value = e.currentTarget.dataset.value || ''
    if (value === this.data.projectValue) return
    this.setData({
      projectValue: value,
      rows: [],
      colA: [],
      colB: [],
      total: 0,
      hasMore: true,
      emptyText: this.emptyTextFor(value, this.data.timeId)
    })
    this.loadFirst()
  },

  resetFilters() {
    this.setData({
      timeId: 'all',
      timeFrom: 0,
      projectValue: '',
      rows: [],
      colA: [],
      colB: [],
      total: 0,
      hasMore: true,
      emptyText: this.emptyTextFor('', 'all')
    })
    this.loadFirst()
  },

  onRefreshTap() {
    this.loadFirst()
  },

  findByUrl(url) {
    for (let i = 0; i < this.data.rows.length; i++) {
      if (this.data.rows[i].url === url) return this.data.rows[i]
    }
    return null
  },

  onItemTap(e) {
    // 长按触发保存菜单后，WebView 仍可能补发一次 tap，这里拦掉。
    if (this._longPressAt && Date.now() - this._longPressAt < 800) return
    const url = e.currentTarget.dataset.url
    const item = this.findByUrl(url)
    if (!item || !item.fullUrl) return
    if (item.isVideo) {
      this.previewVideo(item)
      return
    }
    // 把当页所有图片的完整 URL 一起传给 previewImage，实现左右滑。
    const urls = this.data.rows
      .filter((row) => !row.isVideo && row.fullUrl)
      .map((row) => row.fullUrl)
    wx.previewImage({ current: item.fullUrl, urls: urls })
  },

  previewVideo(item) {
    if (wx.previewMedia) {
      wx.previewMedia({ sources: [{ url: item.fullUrl, type: 'video' }], current: 0 })
    } else {
      wx.showToast({ title: '当前微信版本不支持视频预览', icon: 'none' })
    }
  },

  onItemLongPress(e) {
    this._longPressAt = Date.now()
    const url = e.currentTarget.dataset.url
    const videoFlag = e.currentTarget.dataset.video
    const isVideo = videoFlag === true || videoFlag === 'true'
    const item = this.findByUrl(url)
    if (!item || !item.fullUrl) return
    wx.showActionSheet({
      itemList: [isVideo ? '保存视频到相册' : '保存图片到相册'],
      success() {
        saveMedia(item.url, isVideo)
      }
    })
  },

  goCreate() {
    wx.switchTab({ url: '/pages/create/create' })
  }
})
