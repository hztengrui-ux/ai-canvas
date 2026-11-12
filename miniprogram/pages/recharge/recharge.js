// 充值：套餐 / 沙箱模拟支付 / 真实模式引导到电脑端 / 最近订单
const { request, setCreditName, formatTime } = require('../../utils/request')

// 订单状态以服务端为准：pending | paid | cancelled
// （server/credits.js createOrder 写的是 "pending"，别按直觉写成 created ——
//  写错不会报错，只会让「待支付」标签和取消按钮永远不出现。）
const ORDER_STATUS_TEXT = {
  pending: '待支付',
  paid: '已支付',
  cancelled: '已取消'
}

const ORDER_STATUS_CLASS = {
  pending: 'warn',
  paid: 'success',
  cancelled: 'muted'
}

function normalizeOrder(order) {
  const item = order || {}
  const credits = typeof item.credits === 'number' ? item.credits : 0
  const bonus = typeof item.bonus === 'number' ? item.bonus : 0
  const status = item.status || 'pending'
  return {
    id: item.id || '',
    planId: item.planId || '',
    planLabel: item.planLabel || '充值套餐',
    price: typeof item.price === 'number' ? item.price : 0,
    priceText: String(typeof item.price === 'number' ? item.price : 0),
    credits: credits,
    bonus: bonus,
    total: credits + bonus,
    status: status,
    statusText: ORDER_STATUS_TEXT[status] || status,
    statusClass: ORDER_STATUS_CLASS[status] || 'muted',
    createdAtText: formatTime(item.createdAt),
    paidAtText: formatTime(item.paidAt)
  }
}

Page({
  data: {
    // 首次加载失败时保持 false，让整页显示「加载失败 + 重试」
    initialized: false,
    error: '',
    balance: 0,
    creditName: '算力',
    plans: [],
    status: { mode: '', sandbox: false, hint: '' },
    noticeText: '',
    serverHint: '',
    orders: [],
    selectedPlanId: '',
    selectedSummary: '请选择套餐',
    selectedTotalText: '到账 —',
    payButtonText: '请选择套餐',
    currentOrder: null,
    creating: false,
    paying: false,
    simulating: false,
    cancelingId: '',
    payError: '',
    payMessage: ''
  },

  onShow() {
    this.load()
  },

  onPullDownRefresh() {
    this.load(true)
  },

  reload() {
    this.load()
  },

  load(fromPull) {
    if (this._loading) {
      if (fromPull) wx.stopPullDownRefresh()
      return
    }
    this._loading = true
    this.setData({ error: '' })
    const finish = () => {
      this._loading = false
      if (fromPull) wx.stopPullDownRefresh()
    }

    request({ url: '/api/m/recharge' })
      .then((res) => {
        const status = res.status || {}
        const sandbox = status.sandbox === true
        const creditName = res.creditName || this.data.creditName || '算力'
        setCreditName(creditName)

        const plans = (res.plans || []).map((plan) => {
          const credits = typeof plan.credits === 'number' ? plan.credits : 0
          const bonus = typeof plan.bonus === 'number' ? plan.bonus : 0
          const total = typeof plan.total === 'number' ? plan.total : credits + bonus
          const price = typeof plan.price === 'number' ? plan.price : 0
          return {
            id: plan.id || '',
            label: plan.label || '充值套餐',
            price: price,
            priceText: String(price),
            credits: credits,
            bonus: bonus,
            total: total,
            bonusText: bonus > 0 ? credits + ' + 赠送 ' + bonus : credits + ' 算力',
            hot: plan.hot === true
          }
        })

        const orders = (res.orders || []).slice(0, 10).map(normalizeOrder)

        // 套餐可能已下架：保留仍存在的选中项，否则清空。
        let selectedPlan = null
        const selectedPlanId = this.data.selectedPlanId
        for (let i = 0; i < plans.length; i++) {
          if (plans[i].id === selectedPlanId) selectedPlan = plans[i]
        }
        const nextSelectedId = selectedPlan ? selectedPlanId : ''

        // 待支付面板只跟「仍是 pending」的订单，已支付/已取消则收起。
        let currentOrder = null
        if (this.data.currentOrder) {
          for (let i = 0; i < orders.length; i++) {
            if (orders[i].id === this.data.currentOrder.id && orders[i].status === 'pending') {
              currentOrder = orders[i]
            }
          }
        }

        const patch = {
          initialized: true,
          error: '',
          balance: typeof res.balance === 'number' ? res.balance : this.data.balance,
          creditName: creditName,
          plans: plans,
          orders: orders,
          status: {
            mode: status.mode || '',
            sandbox: sandbox,
            hint: status.hint || ''
          },
          serverHint: status.hint || '',
          noticeText: sandbox
            ? '当前为沙箱模式：小程序内没有真实商户号，点「模拟支付」即刻到账，不会产生真实扣款。'
            : '小程序内真实支付需接入微信商户号（JSAPI 下单）；当前版本请到电脑端完成支付。',
          selectedPlanId: nextSelectedId,
          currentOrder: currentOrder
        }
        const selection = this.selectionPatch(selectedPlan, creditName)
        patch.selectedSummary = selection.selectedSummary
        patch.selectedTotalText = selection.selectedTotalText
        patch.payButtonText = selection.payButtonText
        this.setData(patch)
      })
      .catch((err) => {
        this.setData({
          initialized: this.data.initialized,
          error: (err && err.error) || '充值信息加载失败'
        })
      })
      .then(finish)
  },

  selectionPatch(plan, creditName) {
    if (!plan) {
      return {
        selectedSummary: '请选择套餐',
        selectedTotalText: '到账 —',
        payButtonText: '请选择套餐'
      }
    }
    return {
      selectedSummary: plan.label + ' · ¥' + plan.priceText,
      selectedTotalText: '到账 ' + plan.total + ' ' + (creditName || this.data.creditName),
      payButtonText: '立即充值 ¥' + plan.priceText
    }
  },

  onSelectPlan(e) {
    const id = e.currentTarget.dataset.id
    let plan = null
    for (let i = 0; i < this.data.plans.length; i++) {
      if (this.data.plans[i].id === id) plan = this.data.plans[i]
    }
    if (!plan || plan.id === this.data.selectedPlanId) return
    const patch = {
      selectedPlanId: plan.id,
      currentOrder: null,
      payError: '',
      payMessage: ''
    }
    const selection = this.selectionPatch(plan, this.data.creditName)
    patch.selectedSummary = selection.selectedSummary
    patch.selectedTotalText = selection.selectedTotalText
    patch.payButtonText = selection.payButtonText
    this.setData(patch)
  },

  createOrder() {
    if (this.data.creating) return
    let plan = null
    for (let i = 0; i < this.data.plans.length; i++) {
      if (this.data.plans[i].id === this.data.selectedPlanId) plan = this.data.plans[i]
    }
    if (!plan) {
      wx.showToast({ title: '请先选择套餐', icon: 'none' })
      return
    }

    this.setData({ creating: true, payError: '', payMessage: '' })
    request({
      url: '/api/m/recharge/orders',
      method: 'POST',
      data: { planId: plan.id }
    })
      .then((res) => {
        const order = normalizeOrder(res.order)
        this.setData({
          creating: false,
          currentOrder: order,
          orders: [order].concat(this.data.orders).slice(0, 10)
        })
        wx.pageScrollTo({ scrollTop: 0, duration: 200 })
        // 真实模式：立刻尝试发起支付，服务端会返回明确的「请到电脑端支付」错误。
        if (!this.data.status.sandbox) {
          this.callPay(order)
        }
      })
      .catch(() => {
        this.setData({ creating: false })
      })
  },

  callPay(order) {
    const target = order || this.data.currentOrder
    if (!target || this.data.paying) return
    this.setData({ paying: true, payError: '', payMessage: '' })
    request({
      url: '/api/m/recharge/orders/' + encodeURIComponent(target.id) + '/pay',
      method: 'POST'
    })
      .then((res) => {
        this.setData({ paying: false })
        if (res && res.hint) this.setData({ payMessage: res.hint })
      })
      .catch((err) => {
        // 统一错误提示已经在 request.js 里弹过；这里保留原文供对账，不吞掉。
        this.setData({
          paying: false,
          payError: (err && err.error) || '发起支付失败，请到电脑端完成支付'
        })
      })
  },

  retryPay() {
    this.callPay(this.data.currentOrder)
  },

  simulatePaid() {
    const order = this.data.currentOrder
    if (!order || this.data.simulating) return
    this.setData({ simulating: true, payError: '', payMessage: '' })
    request({
      url: '/api/m/recharge/orders/' + encodeURIComponent(order.id) + '/simulate-paid',
      method: 'POST'
    })
      .then((res) => {
        this.setData({
          simulating: false,
          currentOrder: null,
          balance: typeof res.balance === 'number' ? res.balance : this.data.balance
        })
        wx.showToast({ title: '已到账', icon: 'success' })
        this.load()
      })
      .catch(() => {
        this.setData({ simulating: false })
      })
  },

  cancelOrder(e) {
    let id = ''
    if (e && e.currentTarget && e.currentTarget.dataset) {
      id = e.currentTarget.dataset.id || ''
    }
    if (!id && this.data.currentOrder) id = this.data.currentOrder.id
    if (!id || this.data.cancelingId) return

    wx.showModal({
      title: '取消订单',
      content: '确定取消这个待支付订单吗？',
      success: (res) => {
        if (!res.confirm) return
        this.setData({ cancelingId: id })
        request({
          url: '/api/m/recharge/orders/' + encodeURIComponent(id) + '/cancel',
          method: 'POST'
        })
          .then(() => {
            const stillCurrent = this.data.currentOrder && this.data.currentOrder.id === id
            this.setData({
              cancelingId: '',
              currentOrder: stillCurrent ? null : this.data.currentOrder,
              payError: '',
              payMessage: ''
            })
            wx.showToast({ title: '已取消', icon: 'none' })
            this.load()
          })
          .catch(() => {
            this.setData({ cancelingId: '' })
          })
      }
    })
  },

  cancelCurrentOrder() {
    this.cancelOrder(null)
  },

  refreshOrders() {
    this.load()
  }
})
