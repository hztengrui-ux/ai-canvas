// 素材分类：前端唯一真源。
//
// ⚠️ 2026-10-14 修复（上传分类三套口径）：
// 之前同一件事有三种写法，且其中一种是**非法的**：
//   - 节点内上传：uploadMaterial(f, "other")
//   - 画布拖入：  uploadMaterial(f, opts.category || "uploads")   ← "uploads" 根本不在白名单里
//   - 素材库：    uploadMaterial(f, cat.id)（用服务端下发的 id，是对的）
//
// 为什么 "uploads" 是硬故障而不是小瑕疵：
// 服务端 server/materials.js:57 用 CAT_IDS 白名单校验分类，不在集合里直接返回 null，
// 于是 /materials/uploads/xxx.png 这种 URL 永远解析不出磁盘路径
// → 画布上生成的产品/参考节点里图片是**坏的**（外部拖入图片这条链路直接不可用）。
//
// 真源在服务端 server/config.js:10 MATERIAL_CATEGORIES。
// 这里必须与它保持一致；scripts/run-tests 的第三轮验收会做交叉断言，改错会红。
export const MATERIAL_CATEGORIES = [
  { id: "clothing", label: "服装" },
  { id: "model", label: "模特" },
  { id: "scene", label: "场景" },
  { id: "props", label: "道具" },
  { id: "other", label: "其他" }
];

export const MATERIAL_CATEGORY_IDS = MATERIAL_CATEGORIES.map((c) => c.id);

/** 兜底分类：宁可进「其他」，也不要造一个非法分类把图片搞坏 */
export const DEFAULT_MATERIAL_CATEGORY = "other";

export function isValidMaterialCategory(id) {
  return MATERIAL_CATEGORY_IDS.includes(String(id || ""));
}

/** 统一入口：拿到合法分类，非法/缺失一律回退到 other */
export function normalizeMaterialCategory(id) {
  return isValidMaterialCategory(id) ? String(id) : DEFAULT_MATERIAL_CATEGORY;
}

/**
 * 各节点上传时的默认归类（语义上尽量贴切，便于用户在素材库里找回来）。
 * 用户可以传 opts.category 覆盖。
 */
export const NODE_UPLOAD_CATEGORY = {
  product: "props",   // 产品图 / 服装图 / 模特图，都算创作素材
  style: "scene",     // 风格参考多半是场景/氛围图
  reference: "props", // 多模态参考
  result: "other"     // 结果图回流进素材库
};
