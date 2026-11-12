// 跨多多 AI 创作台 · 小程序请求层
// 统一做四件事：
//   1. 相对地址拼成完整地址（wx.previewImage / image 组件只认完整 URL）
//   2. 自动带 X-AI-Canvas-Token
//   3. 非 2xx 用 wx.showToast 出服务端返回的 error 中文文案
//   4. 401 / LOGIN_REQUIRED 清 token 并 wx.reLaunch 到登录页

const DEFAULT_BASE_URL = 'http://127.0.0.1:5199'
const TOKEN_KEY = 'ac_token'
const BASE_URL_KEY = 'ac_base_url'
const CREDIT_NAME_KEY = 'ac_credit_name'

let redirecting = false

function normalizeBaseUrl(value) {
  if (!value || typeof value !== 'string') return ''
  return value.trim().replace(/\/+$/, '')
}

function getBaseUrl() {
  let fromApp = ''
  try {
    const app = getApp()
    if (app && app.globalData) fromApp = app.globalData.baseUrl
  } catch (err) {
    fromApp = ''
  }
  let fromStorage = ''
  try {
    fromStorage = wx.getStorageSync(BASE_URL_KEY) || ''
  } catch (err) {
    fromStorage = ''
  }
  return normalizeBaseUrl(fromApp) || normalizeBaseUrl(fromStorage) || DEFAULT_BASE_URL
}

// 相对 url（/outputs/x.png）→ 完整 url；已经是 http(s) 的原样返回。
function buildUrl(url) {
  if (!url || typeof url !== 'string') return ''
  if (/^https?:\/\//i.test(url)) return url
  const base = getBaseUrl()
  return base + (url.charAt(0) === '/' ? url : '/' + url)
}

function getToken() {
  try {
    return wx.getStorageSync(TOKEN_KEY) || ''
  } catch (err) {
    return ''
  }
}

function setToken(token) {
  try {
    if (token) {
      wx.setStorageSync(TOKEN_KEY, token)
    } else {
      wx.removeStorageSync(TOKEN_KEY)
    }
  } catch (err) {
    // storage 不可用时静默失败，下一次请求会重新触发登录
  }
}

function clearToken() {
  setToken('')
}

function getCreditName() {
  try {
    return wx.getStorageSync(CREDIT_NAME_KEY) || '算力'
  } catch (err) {
    return '算力'
  }
}

function setCreditName(name) {
  try {
    if (name) wx.setStorageSync(CREDIT_NAME_KEY, name)
  } catch (err) {
    // 忽略：仅用于显示
  }
}

// 登录态失效：清 token + 回到登录页。避免在登录页自身反复 reLaunch。
function toLogin() {
  clearToken()
  if (redirecting) return
  let currentRoute = ''
  try {
    const pages = getCurrentPages()
    if (pages.length) currentRoute = pages[pages.length - 1].route || ''
  } catch (err) {
    currentRoute = ''
  }
  if (currentRoute === 'pages/login/login') return
  redirecting = true
  wx.reLaunch({
    url: '/pages/login/login',
    complete() {
      setTimeout(function () {
        redirecting = false
      }, 800)
    }
  })
}

/**
 * @param {object} options
 *   url         相对或完整地址
 *   method      默认 GET
 *   data        请求体
 *   header      额外请求头（会覆盖默认 Content-Type）
 *   showError   false 时不弹错误 toast（登录页 / 轮询用）
 *   noAuthRedirect true 时 401 不跳登录（登录、改密、退出）
 *   timeout     毫秒，默认 20000
 */
function request(options) {
  const opts = options || {}
  const showError = opts.showError !== false
  const noAuthRedirect = opts.noAuthRedirect === true
  const header = Object.assign({ 'Content-Type': 'application/json' }, opts.header || {})
  const token = getToken()
  if (token) header['X-AI-Canvas-Token'] = token

  return new Promise(function (resolve, reject) {
    wx.request({
      url: buildUrl(opts.url),
      method: opts.method || 'GET',
      data: opts.data === undefined ? undefined : opts.data,
      header: header,
      timeout: opts.timeout || 20000,
      dataType: 'json',
      success(res) {
        const status = res.statusCode
        const body = res.data
        const code = body && body.code ? body.code : ''

        if (!noAuthRedirect && (status === 401 || code === 'LOGIN_REQUIRED')) {
          toLogin()
          reject({
            statusCode: status,
            code: code || 'LOGIN_REQUIRED',
            error: (body && body.error) || '登录已过期，请重新登录',
            silent: true
          })
          return
        }

        if (status >= 200 && status < 300) {
          resolve(body)
          return
        }

        const message = (body && body.error) || '请求失败（' + status + '）'
        if (showError) {
          wx.showToast({ title: message, icon: 'none', duration: 2500 })
        }
        reject({
          statusCode: status,
          code: code,
          error: message,
          data: body
        })
      },
      fail(err) {
        const message = '网络连接失败，请检查服务端地址'
        if (showError) {
          wx.showToast({ title: message, icon: 'none', duration: 2500 })
        }
        reject({
          statusCode: 0,
          code: 'NETWORK',
          error: message,
          detail: err
        })
      }
    })
  })
}

// 保存图片/视频到相册：先下载，再授权保存；拒绝授权时引导去设置页。
function saveMedia(url, isVideo) {
  const full = buildUrl(url)
  if (!full) return
  wx.showLoading({ title: '保存中', mask: true })
  wx.downloadFile({
    url: full,
    success(res) {
      if (res.statusCode !== 200) {
        wx.hideLoading()
        wx.showToast({ title: '下载失败', icon: 'none' })
        return
      }
      const saver = isVideo ? wx.saveVideoToPhotosAlbum : wx.saveImageToPhotosAlbum
      saver({
        filePath: res.tempFilePath,
        success() {
          wx.hideLoading()
          wx.showToast({ title: '已保存到相册', icon: 'none' })
        },
        fail(err) {
          wx.hideLoading()
          const msg = (err && err.errMsg) || ''
          if (msg.indexOf('auth deny') >= 0 || msg.indexOf('auth denied') >= 0 || msg.indexOf('authorize') >= 0) {
            wx.showModal({
              title: '需要相册权限',
              content: '请在设置中允许「保存到相册」后重试。',
              confirmText: '去设置',
              success(r) {
                if (r.confirm) wx.openSetting()
              }
            })
          } else if (msg.indexOf('cancel') < 0) {
            wx.showToast({ title: '保存失败', icon: 'none' })
          }
        }
      })
    },
    fail() {
      wx.hideLoading()
      wx.showToast({ title: '下载失败', icon: 'none' })
    }
  })
}

function pad2(n) {
  return n < 10 ? '0' + n : '' + n
}

// epoch 毫秒 → 2026-10-18 09:30
function formatTime(ms) {
  if (!ms || typeof ms !== 'number') return ''
  const d = new Date(ms)
  if (isNaN(d.getTime())) return ''
  return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()) +
    ' ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes())
}

module.exports = {
  DEFAULT_BASE_URL: DEFAULT_BASE_URL,
  TOKEN_KEY: TOKEN_KEY,
  BASE_URL_KEY: BASE_URL_KEY,
  CREDIT_NAME_KEY: CREDIT_NAME_KEY,
  request: request,
  buildUrl: buildUrl,
  getBaseUrl: getBaseUrl,
  normalizeBaseUrl: normalizeBaseUrl,
  getToken: getToken,
  setToken: setToken,
  clearToken: clearToken,
  getCreditName: getCreditName,
  setCreditName: setCreditName,
  saveMedia: saveMedia,
  formatTime: formatTime
}
