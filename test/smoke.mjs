// 冒烟测试：用 pi 自带的 jiti loader 加载 index.ts，注入 fake pi / fake ctx，
// 直接调用命令 handler 与 input hook，检查配置读写、参数补全与注入行为。
// 用法：node test/smoke.mjs
//
// 说明：插件目录 = 被加载文件的目录，所以这里把 index.ts 复制成
// test/.sandbox-index.ts 再加载，配置文件随之落在 test/config.json，
// 不会碰到仓库根目录里真实使用的 config.json。

import { copyFileSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const testDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = dirname(testDir);
const sandboxFile = join(testDir, ".sandbox-index.ts");
const configPath = join(testDir, "config.json");
const jitiLoaderPath = join(
  repoRoot,
  "node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/jiti-loader.js",
);

let failures = 0;

/** 对比实际值与期望值（用 JSON 序列化后的字符串比较）。 */
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${ok ? "" : `\n  got: ${JSON.stringify(actual)}`}`);
  if (!ok) failures += 1;
}

/** 写测试用配置文件；null 写成空文件（等价于未配置，读不到有效字段）。 */
function writeConfig(content) {
  writeFileSync(configPath, content === null ? "" : content, "utf8");
}

/** 每次都重新加载插件：模块级状态（enabled/gapMs/lastMessageAt）随之重置。 */
async function loadPlugin() {
  copyFileSync(join(repoRoot, "index.ts"), sandboxFile);
  const { createJiti } = await import(jitiLoaderPath);
  const jiti = createJiti(import.meta.url, { moduleCache: false });
  const factory = await jiti.import(sandboxFile, { default: true });
  const handlers = {};
  const commands = {};
  factory({
    on: (name, fn) => {
      handlers[name] = fn;
    },
    registerCommand: (name, options) => {
      commands[name] = options;
    },
  });
  return { handlers, commands };
}

const noted = [];
const ctx = { mode: "tui", ui: { notify: (message, type) => noted.push([type, message]) } };

/** 调用 /timestamp 命令并返回最后一次通知的 [type, message]。 */
async function runCommand(args) {
  const { commands } = await loadPlugin();
  noted.length = 0;
  await commands.timestamp.handler(args, ctx);
  return noted.at(-1);
}

// ── 1. 配置文件缺失/为空：默认值展示与参数校验 ──────────────────────────
writeConfig(null);
{
  const [type, message] = await runCommand("");
  check("无 config 时摘要", [type, message], ["info", "timestamp: on  (default)\ngap: 5m  (default)"]);
  check("gap 无参数报用法", (await runCommand("gap"))[0], "warning");
  check("gap 负数报错", (await runCommand("gap -1"))[1].startsWith('invalid minutes: "-1"'), true);
  check("gap 小数报错", (await runCommand("gap 2.5"))[1].startsWith('invalid minutes: "2.5"'), true);
  check("未知子命令报用法", (await runCommand("foo"))[0], "warning");
  check("多余参数报用法", (await runCommand("on extra"))[0], "warning");
}

// ── 2. 读取既有配置、写回并保留未知字段 ─────────────────────────────────
writeConfig('{"foo":1,"thresholdMinutes":3,"enabled":false}');
{
  const [type, message] = await runCommand("");
  check("读取既有 config", [type, message], [
    "info",
    "timestamp: off  (config.json)\ngap: 3m  (config.json)",
  ]);

  await runCommand("gap 7");
  check("写回保留未知字段", JSON.parse(readFileSync(configPath, "utf8")), {
    foo: 1,
    thresholdMinutes: 7,
    enabled: false,
  });

  await runCommand("on");
  check("on 写回 enabled", JSON.parse(readFileSync(configPath, "utf8")).enabled, true);
}

// ── 3. 注入行为：off / gap 0 / 阈值 / 斜杠命令 ──────────────────────────
writeConfig('{"enabled":false,"thresholdMinutes":5}');
{
  const { handlers } = await loadPlugin();
  handlers.session_start({ reason: "new" });
  check("off 时不注入", await handlers.input({ type: "input", text: "第一条" }), {
    action: "continue",
  });
}

writeConfig('{"enabled":true,"thresholdMinutes":0}');
{
  const { handlers } = await loadPlugin();
  handlers.session_start({ reason: "new" });
  const first = await handlers.input({ type: "input", text: "第一条" });
  check("gap 0 首条为 transform", first.action, "transform");
  check("首条 Since last 为 start of run", first.text.includes("Since last: start of run"), true);
  check("gap 0 时每条都注入", (await handlers.input({ type: "input", text: "第二条" })).action, "transform");
}

writeConfig('{"enabled":true,"thresholdMinutes":5}');
{
  const { handlers } = await loadPlugin();
  handlers.session_start({ reason: "new" });
  await handlers.input({ type: "input", text: "第一条" });
  check("未超阈值不注入", await handlers.input({ type: "input", text: "第二条" }), {
    action: "continue",
  });
  check("斜杠命令不注入", await handlers.input({ type: "input", text: "/skill:foo" }), {
    action: "continue",
  });
  check("带前导空格的斜杠命令不注入", await handlers.input({ type: "input", text: "   /template a" }), {
    action: "continue",
  });
}

// ── 4. 参数补全 ────────────────────────────────────────────────────────
{
  const { commands } = await loadPlugin();
  const complete = commands.timestamp.getArgumentCompletions;
  check("补全空前缀", complete("").map((item) => item.value), ["on", "off", "gap"]);
  check("补全 g", complete("g").map((item) => item.value), ["gap"]);
  check("补全已有参数时不再提示", complete("gap "), null);
  check("补全无匹配", complete("x"), null);
}


// ── 5. /tree 回填：剥净旧后缀 ───────────────────────────────────────────
const OLD_SUFFIX = "\n\n[Time: 2026-10-16 Fri 12:25 UTC+8 | Since last: 5m]";
const restoredText = `早期消息${OLD_SUFFIX}`;

writeConfig('{"enabled":true,"thresholdMinutes":0}');
{
  const { handlers } = await loadPlugin();
  const editor = { text: "", writes: [] };
  const ctx = {
    mode: "tui",
    sessionManager: { getEntry: (id) => (id === "u1" ? { type: "message", message: { role: "user", content: restoredText } } : undefined) },
    ui: {
      getEditorText: () => editor.text,
      setEditorText: (value) => {
        editor.text = value;
        editor.writes.push(value);
      },
    },
  };

  await handlers.session_before_tree({ preparation: { targetId: "u1" } }, ctx);
  await handlers.session_tree({ newLeafId: "u1", oldLeafId: "x" }, ctx);
  check("回填端写入剥净文本", editor.writes, ["早期消息"]);

  // 编辑器里已有草稿：不覆盖
  editor.text = "草稿";
  editor.writes.length = 0;
  await handlers.session_before_tree({ preparation: { targetId: "u1" } }, ctx);
  await handlers.session_tree({ newLeafId: "u1", oldLeafId: "x" }, ctx);
  check("编辑器非空时不回填", editor.writes, []);
  editor.text = "";
}

{
  // 发送端兜底：回填未被劫持时，用户在回填文本后继续打字
  const { handlers } = await loadPlugin();
  const ctx = {
    mode: "plain",
    sessionManager: { getEntry: () => ({ type: "message", message: { role: "user", content: restoredText } }) },
    ui: { getEditorText: () => "", setEditorText: () => {} },
  };
  await handlers.session_before_tree({ preparation: { targetId: "u1" } }, ctx);
  await handlers.session_tree({ newLeafId: "u1", oldLeafId: "x" }, ctx);
  const sent = await handlers.input({ type: "input", text: `${restoredText}补充一句` });
  check("兜底剥掉回填带来的旧后缀", sent.text.startsWith("早期消息补充一句\n\n[Time: "), true);
  check("兜底只保留一处时间戳", sent.text.split("[Time: ").length - 1, 1);
}

{
  // 直接粘贴带后缀的旧文本
  const { handlers } = await loadPlugin();
  handlers.session_start({ reason: "new" });
  const sent = await handlers.input({ type: "input", text: `粘贴的旧消息${OLD_SUFFIX}` });
  check("粘贴旧消息时剥掉尾部后缀", sent.text.startsWith("粘贴的旧消息\n\n[Time: "), true);
  check("粘贴旧消息后时间戳不重复", sent.text.split("[Time: ").length - 1, 1);
}
console.log(failures === 0 ? "\n全部通过" : `\n${failures} 项失败`);
process.exit(failures === 0 ? 0 : 1);
