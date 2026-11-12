/**
 * 端口派生自测（Sprint 0 ④）
 * --------------------------------------------------------------------------
 * 为什么值得单独测：
 *   Host 校验（security.js）只认「允许的本机端口」。端口派生一旦算错，
 *   服务会把自己的请求判成 BAD_HOST 拦掉 —— 现象是 Electron 永远等不到
 *   「服务就绪」，而日志里只有一行 403，排查成本极高。
 *   所以这里把「品牌 → 端口」的映射、确定性、以及与白名单的一致性全部钉死。
 *
 * 纯逻辑测试，不依赖服务端，也不需要浏览器。
 */
import { derivePorts, allowedLocalPorts, BRAND_PORT_OFFSETS, BACKEND_PORT_BASE, MEDIA_PORT_BASE, normalizeBrandKey } from "./ports.js";

let pass = 0;
let fail = 0;
function check(name, cond, extra = "") {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    console.log(`  ✗ ${name}${extra ? ` — ${extra}` : ""}`);
  }
}

console.log("\n[1] 已知品牌 → 端口固定且互不冲突");
{
  const a = derivePorts("aichange");
  const j = derivePorts("jingling");
  const x = derivePorts("xmulo");

  check("aichange 后端 5181（保持现网默认，老用户无感）", a.backend === 5181, `got ${a.backend}`);
  check("aichange 媒体 5281", a.media === 5281, `got ${a.media}`);
  check("jingling 后端 5182", j.backend === 5182, `got ${j.backend}`);
  check("jingling 媒体 5282", j.media === 5282, `got ${j.media}`);
  check("xmulo 后端 5183", x.backend === 5183, `got ${x.backend}`);
  check("xmulo 媒体 5283", x.media === 5283, `got ${x.media}`);

  const backends = [a.backend, j.backend, x.backend];
  check("三个品牌后端端口互不相同", new Set(backends).size === 3, backends.join(","));
  check(
    "每个品牌后端 ≠ 媒体",
    [a, j, x].every((p) => p.backend !== p.media)
  );
  check("偏移表与基址自洽", BACKEND_PORT_BASE === 5181 && MEDIA_PORT_BASE === 5281);
  check(
    "偏移量与 BRAND_PORT_OFFSETS 一致",
    BRAND_PORT_OFFSETS.aichange === 0 && BRAND_PORT_OFFSETS.jingling === 1 && BRAND_PORT_OFFSETS.xmulo === 2
  );
}

console.log("\n[2] 品牌名归一化");
{
  check("大写 + 空白归一化", derivePorts("  JINGLING ").backend === 5182, `got ${derivePorts("  JINGLING ").backend}`);
  check("空值回落 aichange", derivePorts("").backend === 5181);
  check("undefined 回落 aichange", derivePorts(undefined).backend === 5181);
  check("normalizeBrandKey 处理 null", normalizeBrandKey(null) === "aichange");
}

console.log("\n[3] 未知品牌：确定性派生，不撞已知区段");
{
  const one = derivePorts("oem-a");
  const two = derivePorts("oem-a");
  check("同品牌两次派生结果一致", one.backend === two.backend && one.media === two.media);
  check(
    "落在兜底区段 5191..5230",
    one.backend >= 5191 && one.backend <= 5230,
    `got ${one.backend}`
  );
  check("媒体端口同样落在 5291..5330", one.media >= 5291 && one.media <= 5330, `got ${one.media}`);
  check(
    "不与三个已知品牌冲突",
    ![5181, 5182, 5183].includes(one.backend),
    `got ${one.backend}`
  );
  check("未知品牌同样后端 ≠ 媒体", one.backend !== one.media);
  check("返回里带 brand 字段", one.brand === "oem-a", one.brand);
}

console.log("\n[4] Host 白名单包含「实际会监听的端口」");
{
  const before = { port: process.env.PORT, allowed: process.env.AI_CANVAS_ALLOWED_PORTS, media: process.env.AI_CANVAS_MEDIA_PORT };
  try {
    delete process.env.PORT;
    delete process.env.AI_CANVAS_MEDIA_PORT;
    delete process.env.AI_CANVAS_ALLOWED_PORTS;
    process.env.BRAND = "jingling";

    const ports = allowedLocalPorts();
    check("含前端开发端口 5180", ports.has("5180"));
    check("含品牌派生后端端口 5182", ports.has("5182"), [...ports].join(","));
    check("含品牌派生媒体端口 5282", ports.has("5282"), [...ports].join(","));

    process.env.PORT = "5999";
    check("PORT 环境变量（桌面端动态端口 / 测试随机端口）被纳入", allowedLocalPorts().has("5999"));

    process.env.AI_CANVAS_MEDIA_PORT = "5888";
    check("AI_CANVAS_MEDIA_PORT 被纳入", allowedLocalPorts().has("5888"));

    process.env.AI_CANVAS_ALLOWED_PORTS = "6000,6001";
    const custom = allowedLocalPorts();
    check("AI_CANVAS_ALLOWED_PORTS 显式列表被纳入", custom.has("6000") && custom.has("6001"));
    check("显式列表不会把派生端口挤掉", custom.has("5182"), [...custom].join(","));
  } finally {
    if (before.port === undefined) delete process.env.PORT;
    else process.env.PORT = before.port;
    if (before.allowed === undefined) delete process.env.AI_CANVAS_ALLOWED_PORTS;
    else process.env.AI_CANVAS_ALLOWED_PORTS = before.allowed;
    if (before.media === undefined) delete process.env.AI_CANVAS_MEDIA_PORT;
    else process.env.AI_CANVAS_MEDIA_PORT = before.media;
    delete process.env.BRAND;
  }
}

console.log(`\n端口派生：${pass} 项通过，${fail} 项失败\n`);
process.exit(fail ? 1 : 0);
