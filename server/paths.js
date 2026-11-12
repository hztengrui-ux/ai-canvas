// 数据根目录统一入口
//
// 默认是用户目录下的 ~/.ai-canvas。
// 但做自动化测试时，直接往真实数据目录写会有两个问题：
//   1. 测试会污染真实账本（跑一次余额就变了）
//   2. 某些受限运行环境不允许进程写用户目录（EPERM）
// 所以留一个 AI_CANVAS_HOME 覆盖开关：测试 / 多实例部署时指到别处即可，
// 一行环境变量，不用改代码。
import os from "node:os";
import path from "node:path";

export const HOME = process.env.AI_CANVAS_HOME
  ? path.resolve(process.env.AI_CANVAS_HOME)
  : path.join(os.homedir(), ".ai-canvas");

export function dataFile(...parts) {
  return path.join(HOME, ...parts);
}
