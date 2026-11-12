// 凭据保险箱自测（分文件加密后端）
// 运行：AI_CANVAS_VAULT=file node server/__vault.test.mjs
// 注意：必须带 AI_CANVAS_VAULT=file，否则本机若装了系统凭据管理器会走那条路径。
import fs from "node:fs";
import path from "node:path";
import * as vault from "./vault.js";
import { dataFile } from "./paths.js";

let pass = 0;
let fail = 0;
function check(name, cond, extra = "") {
  if (cond) {
    pass++;
    console.log(`  ✅ ${name}${extra ? "  " + extra : ""}`);
  } else {
    fail++;
    console.log(`  ❌ ${name}${extra ? "  " + extra : ""}`);
  }
}

console.log("\n=== 凭据保险箱（每条密钥一个 .enc）===");
if (vault.vaultBackend() !== "file") {
  console.error("  ❌ 未强制文件后端：请用 AI_CANVAS_VAULT=file 运行本测试");
  process.exit(1);
}

const NAME_A = "provider.wanxiang.apiKey";
const NAME_B = `provider.test.apiKey-${Date.now().toString(36)}`;

vault.setSecret(NAME_A, "sk-wanxiang-abcdef");
vault.setSecret(NAME_B, "sk-test-123456");
check("两条密钥各自读回一致", vault.getSecret(NAME_A) === "sk-wanxiang-abcdef" && vault.getSecret(NAME_B) === "sk-test-123456");
check("改一条不影响另一条", (() => {
  vault.setSecret(NAME_B, "sk-test-654321");
  return vault.getSecret(NAME_B) === "sk-test-654321" && vault.getSecret(NAME_A) === "sk-wanxiang-abcdef";
})());

const dir = dataFile("secrets");
const files = fs.readdirSync(dir).filter((f) => f.endsWith(".enc"));
check("一条密钥一个文件（不是一个大 JSON）", files.length >= 2, files.join(","));
check("文件名保留可读的点分结构", files.includes("provider.wanxiang.apiKey.enc"), files.join(","));

const raw = JSON.parse(fs.readFileSync(path.join(dir, "provider.wanxiang.apiKey.enc"), "utf8"));
check("文件内不含明文", !JSON.stringify(raw).includes("sk-wanxiang-abcdef"));
check("AES-256-GCM 四要素齐全", Boolean(raw.iv && raw.tag && raw.data && raw.alg === "aes-256-gcm"), Object.keys(raw).join(","));
check("记录条目名与更新时间", raw.name === NAME_A && Number(raw.updatedAt) > 0);
check("清单里能查到条目", vault.listSecrets().includes("provider.wanxiang.apiKey"));
check("自检通过", vault.selfTest().ok === true, JSON.stringify(vault.selfTest()));

// 旧版单文件迁移
const legacyPath = dataFile("secrets.enc.json");
const legacyName = `provider.legacy.apiKey-${Date.now().toString(36)}`;
// 手工构造一份旧格式（用当前机器密钥加密）。
// 旧版保险箱把「所有条目」作为一个 JSON 对象整体加密，所以这里先把
// { 条目名: 值 } 这个 map 存成一条临时密钥，借它的 iv/tag/data 拼出旧文件，
// 再删掉新结构里的同名条目，重新加载模块触发迁移。
vault.setSecret(legacyName, JSON.stringify({ [legacyName]: "sk-legacy-999" }));
const srcFile = path.join(dir, `${legacyName.replace(/[^A-Za-z0-9._-]/g, "_")}.enc`);
const src = JSON.parse(fs.readFileSync(srcFile, "utf8"));
fs.writeFileSync(
  legacyPath,
  JSON.stringify({ v: 1, alg: "aes-256-gcm", iv: src.iv, tag: src.tag, data: src.data }, null, 2)
);
fs.unlinkSync(srcFile);
check("删掉新结构后读不到（模拟待迁移）", vault.getSecret(legacyName) === "");
// 迁移逻辑在模块加载时跑一次，这里重新 import 触发
const migrated = await import(`./vault.js?reload=${Date.now()}`);
check("启动时自动迁回", migrated.getSecret(legacyName) === "sk-legacy-999");
check("旧文件被改名保留（可回滚）", fs.readdirSync(dataFile(".")).some((f) => f.startsWith("secrets.enc.json.migrated-")));

vault.deleteSecret(NAME_A);
vault.deleteSecret(NAME_B);
migrated.deleteSecret(legacyName);
check("删除后读不到", vault.getSecret(NAME_A) === "" && vault.getSecret(NAME_B) === "");

console.log(`\n  通过 ${pass} / 失败 ${fail}\n`);
process.exit(fail ? 1 : 0);
