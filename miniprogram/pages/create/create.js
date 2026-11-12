// 出图：技能/模型、提示词、张数、参考图上传、提交任务
const { request, buildUrl, setCreditName } = require('../../utils/request')

const MAX_REFS = 3
const N_LIST = [1, 2, 3, 4]

/**
 * 技能 → 提示词模板。
 *
 * 为什么是模板而不是"提交 skillId"：电脑端的技能是「铺一张画布」用的
 * （选素材节点 → 拼提示词链 → 落执行节点），手机上没有画布，提交一个 skillId
 * 服务端也无从执行。所以手机端把技能降级成**起始提示词**，用户点一下就有个能改的草稿，
 * 比一个点了没反应的按钮诚实得多。
 */
const SKILL_PROMPTS = {
  'outfit-swap': '把图中这件毛衫换到模特身上，保持面料纹理与印花位置不变，自然光棚拍，白底',
  'outfit-style': '同款毛衫换一种风格拍摄：柔和自然光、浅灰背景，突出针织纹理',
  'outfit-pose': '同款毛衫换一个姿势展示，模特正面站立，双手自然下垂，白底棚拍',
  'txt2img': '杏色圆领毛衫，胸前小面积抽象印花，柔和自然光，针织纹理清晰',
  'img2img': '参考这张图的构图与色调，重新生成一张同风格的商品图',
  'white-bg': '商品白底图：主体居中，纯白背景，边缘干净，无投影，电商主图规格',
  'detail-page': '提炼这张图的 3 个卖点，生成电商详情页分段图，中文排版，简洁专业',
  'model-gen': '生成一位欧美模特，浅色背景，自然妆容，适合毛衫商品拍摄',
  'pose-split': '同一件毛衫的多个姿势展示，统一光线与背景，便于对比',
  'img2video': '让画面里的模特缓慢转身，镜头轻微推进，保持商品细节清晰',
  'cutout': '把主体从背景中抠出来，输出透明背景 PNG，边缘干净无毛刺',
  'upscale': '保持原图内容不变，提升清晰度与细节，输出高清版本',
  'inpaint': '只修改我圈定的区域，其余部分保持完全不变',
  'prompt-preset': '甜酷风毛衫，街拍视角，自然光，浅景深'
}

// 契约 3.7：按真实图片类型发 content-type，服务端据此决定落地扩展名。
function pickMime(filePath) {
  const match = /\.([a-zA-Z0-9]+)$/.exec(filePath || '')
  const ext = match ? match[1].toLowerCase() : ''
  if (ext === 'png') return 'image/png'
  if (ext === 'webp') return 'image/webp'
  if (ext === 'gif') return 'image/gif'
  if (ext === 'bmp') return 'image/bmp'
  if (ext === 'heic' || ext === 'heif') return 'image/heic'
  return 'image/jpeg'
}

Page({
  data: {
    loading: true,
    loadError: '',
    skills: [],
    models: [],
    skillId: '',
    skillLabel: '',
    skillDesc: '',
    modelId: '',
    prompt: '',
    n: 1,
    nList: N_LIST,
    refs: [],
    uploading: false,
    submitting: false,
    balance: 0,
    creditName: '算力',
    unitCost: 0,
    costText: '—'
  },

  onShow() {
    this.loadBootstrap()
  },

  loadBootstrap() {
    this.setData({ loading: true, loadError: '' })
    request({ url: '/api/m/bootstrap' })
      .then((boot) => {
        const me = boot.me || {}
        const costs = boot.costs || {}
        const creditName = me.creditName || '算力'
        const skills = (boot.skills || []).map((s) => ({
          id: s.id,
          label: s.label,
          desc: s.desc || '',
          available: s.available !== false
        }))
        const allModels = (boot.models || []).map((m) => ({
          id: m.id,
          label: m.label,
          kind: m.kind || 'image'
        }))
        let models = allModels.filter((m) => m.kind === 'image')
        if (!models.length) models = allModels.slice()

        const availableSkill = skills.filter((s) => s.available)[0]
        const skillId = this.data.skillId && skills.some((s) => s.id === this.data.skillId)
          ? this.data.skillId
          : (availableSkill ? availableSkill.id : (skills[0] ? skills[0].id : ''))
        const modelId = this.data.modelId && models.some((m) => m.id === this.data.modelId)
          ? this.data.modelId
          : (models[0] ? models[0].id : '')
        const skill = skills.filter((s) => s.id === skillId)[0]

        setCreditName(creditName)
        this.setData({
          loading: false,
          skills: skills,
          models: models,
          skillId: skillId,
          skillDesc: skill ? skill.desc : '',
          modelId: modelId,
          creditName: creditName,
          unitCost: typeof costs.image === 'number' ? costs.image : 0,
          balance: typeof me.balance === 'number' ? me.balance : 0
        })
        this.updateCost()
      })
      .catch((err) => {
        this.setData({
          loading: false,
          loadError: (err && err.error) || '读取可用能力失败'
        })
      })
  },

  updateCost() {
    const unit = this.data.unitCost || 0
    const total = unit * (this.data.n || 1)
    this.setData({
      costText: unit ? total + ' ' + this.data.creditName : '—'
    })
  },

  onSkill(e) {
    const id = e.currentTarget.dataset.id
    const skill = this.data.skills.filter((s) => s.id === id)[0]
    if (!skill) return
    if (!skill.available) {
      wx.showToast({ title: '该技能暂不可用', icon: 'none' })
      return
    }
    // 手机端 v1 没有「技能」这个提交字段（电脑端技能是铺画布用的，链路完全不同）。
    // 与其让用户点了个没反应的按钮，不如把技能变成**提示词模板**：
    //   提示词为空 → 套一版该技能的起始描述，用户接着改；
    //   已有内容 → 绝不覆盖，只在下面提示一句。
    const tpl = SKILL_PROMPTS[id] || ''
    const patch = { skillId: id, skillLabel: skill.label || '', skillDesc: skill.desc || '' }
    if (tpl && !String(this.data.prompt || '').trim()) {
      patch.prompt = tpl
      patch.skillDesc = skill.desc || ''
    } else if (tpl) {
      patch.skillDesc = (skill.desc || '') + '（已套模板，提示词已有内容不覆盖）'
    }
    this.setData(patch)
    if (tpl && !String(this.data.prompt || '').trim()) {
      wx.showToast({ title: '已套用「' + (skill.label || '技能') + '」模板', icon: 'none' })
    }
  },

  onModel(e) {
    this.setData({ modelId: e.currentTarget.dataset.id })
  },

  onPrompt(e) {
    this.setData({ prompt: e.detail.value })
  },

  onCount(e) {
    const n = Number(e.currentTarget.dataset.n)
    if (!n || n < 1 || n > 4) return
    this.setData({ n: n })
    this.updateCost()
  },

  chooseRef() {
    if (this.data.uploading) {
      wx.showToast({ title: '参考图上传中，请稍候', icon: 'none' })
      return
    }
    const left = MAX_REFS - this.data.refs.length
    if (left <= 0) {
      wx.showToast({ title: '最多 3 张参考图', icon: 'none' })
      return
    }
    const onPicked = (paths) => {
      const list = (paths || []).filter((p) => !!p)
      if (!list.length) return
      this.uploadSequential(list, 0, [])
    }

    if (wx.chooseMedia) {
      wx.chooseMedia({
        count: left,
        mediaType: ['image'],
        sourceType: ['album', 'camera'],
        sizeType: ['compressed'],
        success(res) {
          const files = (res.tempFiles || []).filter((f) => f && f.tempFilePath)
          onPicked(files.map((f) => f.tempFilePath))
        }
      })
      return
    }

    wx.chooseImage({
      count: left,
      sizeType: ['compressed'],
      sourceType: ['album', 'camera'],
      success(res) {
        onPicked(res.tempFilePaths || [])
      }
    })
  },

  readFileBuffer(filePath) {
    return new Promise((resolve, reject) => {
      wx.getFileSystemManager().readFile({
        filePath: filePath,
        success: (res) => resolve(res.data),
        fail: reject
      })
    })
  },

  uploadOne(filePath) {
    return this.readFileBuffer(filePath).then((buffer) => request({
      url: '/api/m/upload',
      method: 'POST',
      data: buffer,
      header: { 'Content-Type': pickMime(filePath) },
      timeout: 60000
    }))
  },

  uploadSequential(paths, index, uploaded) {
    if (index === 0) {
      this.setData({ uploading: true })
    }
    if (index >= paths.length) {
      const refs = this.data.refs.concat(uploaded).slice(0, MAX_REFS)
      this.setData({ refs: refs, uploading: false })
      if (uploaded.length) {
        wx.showToast({ title: '已添加 ' + uploaded.length + ' 张参考图', icon: 'none' })
      } else {
        wx.showToast({ title: '参考图上传失败', icon: 'none' })
      }
      return
    }
    this.uploadOne(paths[index])
      .then((res) => {
        if (res && res.url) {
          uploaded.push({ url: res.url, fullUrl: buildUrl(res.url) })
        }
        this.uploadSequential(paths, index + 1, uploaded)
      })
      .catch(() => {
        this.uploadSequential(paths, index + 1, uploaded)
      })
  },

  previewRef(e) {
    const url = e.currentTarget.dataset.url
    const refs = this.data.refs
    const current = refs.filter((r) => r.url === url)[0]
    if (!current) return
    wx.previewImage({
      current: current.fullUrl,
      urls: refs.map((r) => r.fullUrl)
    })
  },

  removeRef(e) {
    const url = e.currentTarget.dataset.url
    this.setData({
      refs: this.data.refs.filter((r) => r.url !== url)
    })
  },

  submit() {
    if (this.data.submitting) return
    const prompt = (this.data.prompt || '').trim()
    if (!prompt) {
      wx.showToast({ title: '请先填写提示词', icon: 'none' })
      return
    }
    if (this.data.uploading) {
      wx.showToast({ title: '参考图上传中，请稍候', icon: 'none' })
      return
    }
    const unit = this.data.unitCost || 0
    const cost = unit * (this.data.n || 1)
    if (unit && this.data.balance < cost) {
      wx.showModal({
        title: '算力不足',
        content: '本次需要 ' + cost + ' ' + this.data.creditName + '，当前余额 ' + this.data.balance + '。',
        confirmText: '去充值',
        cancelText: '取消',
        success: (res) => {
          if (res.confirm) wx.navigateTo({ url: '/pages/recharge/recharge' })
        }
      })
      return
    }

    const payload = {
      prompt: prompt,
      n: this.data.n
    }
    if (this.data.modelId) payload.model = this.data.modelId
    if (this.data.refs.length) {
      payload.referenceUrls = this.data.refs.map((r) => r.url)
    }
    // 技能不进生成参数（手机端没有画布可铺），但记进 remark：
    // 这样在电脑端的血缘/审计里能看出「这条是手机上按什么技能起的」，复现时不会两眼一抹黑。
    if (this.data.skillLabel) payload.remark = '手机端 · ' + this.data.skillLabel

    this.setData({ submitting: true })
    request({ url: '/api/m/jobs', method: 'POST', data: payload })
      .then((res) => {
        const job = (res && res.job) || {}
        if (!job.id) {
          throw { error: '服务端未返回任务编号' }
        }
        wx.redirectTo({
          url: '/pages/job/job?id=' + encodeURIComponent(job.id),
          fail: () => {
            this.setData({ submitting: false })
            wx.showToast({ title: '打开进度页失败', icon: 'none' })
          }
        })
      })
      .catch(() => {
        this.setData({ submitting: false })
      })
  }
})
