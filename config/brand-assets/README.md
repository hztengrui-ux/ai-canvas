# 品牌专属资产（OEM 图标待补）

这个目录放**每个品牌自己的**打包资产。当前目录下没有任何图 —— 因为 OEM 方还没提供，
这里只留说明，**不放占位图、也不拿跨多多的图改名冒充**。

## 期望的目录结构

```
config/brand-assets/
  oem-a/icon.ico     ← X.MULO 的安装包图标（256×256，含 16/32/48/64/128/256 多尺寸）
  oem-b/icon.ico     ← 晶灵服装AI 的安装包图标
```

## 生效方式（不需要改代码）

`config/brand-resolver.cjs` 的 `resolveBrandIcon()` 会先找
`config/brand-assets/<BRAND>/icon.ico`，找到就用它作为 `win.icon` 与 `nsis.installerIcon`；
找不到就回退 `build/icon.ico`，并在打包日志里打印一行
`[brand] 品牌 xx 未提供专属图标（...），回退 build/icon.ico`。

也就是说：**把 ico 丢进对应目录，下次打包自动生效**；日志里那行警告消失 = 图标已就位。

## 运行期 mark（界面里的 logo）

界面用的方形 mark 走 `config/brand.json` 的 `logo` 字段（URL 路径，文件在 `public/brand/`）。
oem-a / oem-b 的 `logo` 当前**故意留空**，服务端 `server/brand.js` 会回退到
`/brand/logo-mark.png`（跨多多默认 mark）。这是「如实回退」，不是白标已完成。

补齐步骤：

1. 把 OEM 方形 mark 放到 `public/brand/<key>-logo-mark.png`（建议 512×512 透明 PNG）
2. 在 `config/brand.json` 对应品牌里把 `logo` 填成 `/brand/<key>-logo-mark.png`
3. 删掉该品牌的 `logoPending` 与 `logoNote`

## 当前状态（如实记录）

| 品牌 | 安装包图标 | 界面 mark |
| --- | --- | --- |
| kuaduoduo | ✅ build/icon.ico | ✅ /brand/logo-mark.png |
| oem-a (X.MULO) | ❌ 待补，回退 build/icon.ico | ❌ 待补，回退 /brand/logo-mark.png |
| oem-b (晶灵服装AI) | ❌ 待补，回退 build/icon.ico | ❌ 待补，回退 /brand/logo-mark.png |
