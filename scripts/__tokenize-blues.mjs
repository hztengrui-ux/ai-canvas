// 把散落在样式里的硬编码蓝色改成主题 token（这样 Prism 主题换成绿色时，这些地方自动跟着变）
//
// 为什么不用粗暴的全文替换：
//   `--primary: #2563EB;` 这类**定义**不能替换成 var(--primary) —— 那会变成自引用，变量解析失败、整片样式变默认色。
//   所以逐行判断：命中"变量定义行"就跳过。
import fs from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
const FILES = ["src/style.css", "src/account.css", "src/admin.css"];

// 值 = 目标 token
const MAP = [
  ["#2563EB", "var(--primary)"],
  ["#3B82F6", "var(--primary-hover)"],
  ["#1D4ED8", "var(--primary-pressed)"],
  ["#60A5FA", "var(--primary-hover)"]
];

// 这些行本身是 token 定义，跳过
const DEF_RE = /^\s*--(primary|primary-hover|primary-pressed|brand|brand-light|brand-soft|link|info)\s*:/;

let totalChanged = 0;
for (const rel of FILES) {
  const file = path.join(ROOT, rel);
  if (!fs.existsSync(file)) {
    console.log(`  跳过（不存在）：${rel}`);
    continue;
  }
  const lines = fs.readFileSync(file, "utf8").split("\n");
  let changed = 0;
  const out = lines.map((line) => {
    if (DEF_RE.test(line)) return line; // token 定义行不动
    let next = line;
    for (const [hex, token] of MAP) {
      const re = new RegExp(hex.replace("#", "#"), "gi");
      if (re.test(next)) {
        next = next.replace(new RegExp(hex, "gi"), token);
        changed += 1;
      }
    }
    return next;
  });
  if (changed) {
    fs.writeFileSync(file, out.join("\n"), "utf8");
    console.log(`  ${rel}: 替换 ${changed} 处`);
    totalChanged += changed;
  } else {
    console.log(`  ${rel}: 无需替换`);
  }
}
console.log(`共替换 ${totalChanged} 处硬编码蓝色 → 主题 token`);
