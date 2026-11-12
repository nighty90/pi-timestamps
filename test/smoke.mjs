// 冒烟测试：用 pi 自带的 jiti loader 加载 index.ts，注入 fake pi / fake ctx，
// 直接调用命令 handler 与 input hook，检查配置读写、参数补全与注入行为。
// 用法：node test/smoke.mjs
//
// 说明：config.json 由 src/config.ts 按「自身文件上溯两级」定位，所以这里把
// index.ts 与 src/ 整棵复制进 test/.sandbox/，配置随之落在 test/.sandbox/config.json，
// 不会碰到仓库根目录里真实使用的 config.json。

import { cpSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const testDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = dirname(testDir);
const sandboxDir = join(testDir, ".sandbox");
const sandboxFile = join(sandboxDir, "index.ts");
const configPath = join(sandboxDir, "config.json");
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

/**
 * 指定接下来加载时沙箱里的 config.json 内容。真正的落盘发生在 loadPlugin()
 * 重建沙箱之后——沙箱目录每次都会被整个删掉重来，提前写会被一并删除。
 * null 表示写成空文件（等价于未配置，读不到有效字段）。
 */
let pendingConfig = null;
function writeConfig(content) {
  pendingConfig = content === null ? "" : content;
}

/** 每次都重新加载插件：模块级状态（settings / state）随之重置。 */
async function loadPlugin() {
  rmSync(sandboxDir, { recursive: true, force: true });
  cpSync(join(repoRoot, "index.ts"), sandboxFile, { recursive: true });
  cpSync(join(repoRoot, "src"), join(sandboxDir, "src"), { recursive: true });
  if (pendingConfig !== null) writeFileSync(configPath, pendingConfig, "utf8");
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
  handlers.session_start({ reason: "new" }, historyCtx([]));
  check("off 时不注入", await handlers.input({ type: "input", text: "第一条" }), {
    action: "continue",
  });
}

writeConfig('{"enabled":true,"thresholdMinutes":0}');
{
  const { handlers } = await loadPlugin();
  handlers.session_start({ reason: "new" }, historyCtx([]));
  const first = await handlers.input({ type: "input", text: "第一条" });
  check("gap 0 首条为 transform", first.action, "transform");
  check(
    "首条只有时间、没有 gap 段",
    /^第一条\n\n\[\d{4}-\d{2}-\d{2} [A-Z][a-z]{2} \d{2}:\d{2} UTC[+-]\d{1,2}(?::\d{2})?\]$/.test(
      first.text,
    ),
    true,
  );
  const second = await handlers.input({ type: "input", text: "第二条" });
  check("gap 0 时每条都注入", second.action, "transform");
  check("后续消息带 gap 段", /\| gap: 0s\]$/.test(second.text), true);
}

writeConfig('{"enabled":true,"thresholdMinutes":5}');
{
  const { handlers } = await loadPlugin();
  handlers.session_start({ reason: "new" }, historyCtx([]));
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
const NEW_SUFFIX = "\n\n[2026-10-16 Fri 12:25 UTC+8 | gap: 5m]";
const FIRST_SUFFIX = "\n\n[2026-10-16 Fri 12:25 UTC+8]";
const LEGACY_SUFFIX = "\n\n[Time: 2026-10-16 Fri 12:25 UTC+8 | Since last: 5m]";
const restoredText = `早期消息${NEW_SUFFIX}`;

writeConfig('{"enabled":true,"thresholdMinutes":0}');
{
  const { handlers } = await loadPlugin();
  const editor = { text: "", writes: [] };
  const ctx = {
    mode: "tui",
    sessionManager: {
      getBranch: () => [],
      getEntry: (id) =>
        id === "u1" ? { type: "message", message: { role: "user", content: restoredText } } : undefined,
    },
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

  editor.writes.length = 0;
  // 自定义消息条目同样会被 pi 回填，也要剥净
  const customCtx = {
    mode: "tui",
    sessionManager: {
      getBranch: () => [],
      getEntry: () =>
        ({ type: "custom_message", content: `自定义早期消息${NEW_SUFFIX}` }),
    },
    ui: {
      getEditorText: () => "",
      setEditorText: (value) => {
        editor.writes.push(value);
      },
    },
  };
  await handlers.session_before_tree({ preparation: { targetId: "c1" } }, customCtx);
  await handlers.session_tree({ newLeafId: "c1", oldLeafId: "x" }, customCtx);
  check("自定义消息回填也剥净", editor.writes, ["自定义早期消息"]);

  // 编辑器里已有草稿：不覆盖
  editor.text = "草稿";
  editor.writes.length = 0;
  await handlers.session_before_tree({ preparation: { targetId: "u1" } }, ctx);
  await handlers.session_tree({ newLeafId: "u1", oldLeafId: "x" }, ctx);
  check("编辑器非空时不回填", editor.writes, []);
  editor.text = "";
}

{
  // 会话首条消息的后缀（只有时间，无 gap 段）同样要剥掉
  const { handlers } = await loadPlugin();
  const editor = { text: "", writes: [] };
  const ctx = {
    mode: "tui",
    sessionManager: {
      getBranch: () => [],
      getEntry: () =>
        ({ type: "message", message: { role: "user", content: `首条消息${FIRST_SUFFIX}` } }),
    },
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
  check("首条消息的无 gap 后缀也剥掉", editor.writes, ["首条消息"]);
}

{
  // 发送端兜底：回填未被劫持时，用户在回填文本后继续打字
  const { handlers } = await loadPlugin();
  const ctx = {
    mode: "plain",
    sessionManager: {
      getBranch: () => [],
      getEntry: () => ({ type: "message", message: { role: "user", content: restoredText } }),
    },
    ui: { getEditorText: () => "", setEditorText: () => {} },
  };
  await handlers.session_before_tree({ preparation: { targetId: "u1" } }, ctx);
  await handlers.session_tree({ newLeafId: "u1", oldLeafId: "x" }, ctx);
  const sent = await handlers.input({ type: "input", text: `${restoredText}补充一句` });
  check("兜底剥掉回填带来的旧后缀", sent.text.startsWith("早期消息补充一句\n\n[2026-"), true);
  check("兜底只保留一处时间戳", sent.text.split("\n\n[").length - 1, 1);
}

{
  // 直接粘贴带后缀的旧文本
  const { handlers } = await loadPlugin();
  handlers.session_start({ reason: "new" }, historyCtx([]));
  const sent = await handlers.input({ type: "input", text: `粘贴的旧消息${NEW_SUFFIX}` });
  check("粘贴旧消息时剥掉尾部后缀", sent.text.startsWith("粘贴的旧消息\n\n[2026-"), true);
  check("粘贴旧消息后时间戳不重复", sent.text.split("\n\n[").length - 1, 1);
}

{
  // 旧版 [Time: …] 后缀按设计不再剥除：保留原文，新后缀另行追加
  const { handlers } = await loadPlugin();
  handlers.session_start({ reason: "new" }, historyCtx([]));
  const sent = await handlers.input({ type: "input", text: `历史消息${LEGACY_SUFFIX}` });
  check("旧格式后缀保留", sent.text.startsWith("历史消息\n\n[Time: 2026-10-16"), true);
  check("旧格式正文保留且追加新后缀", sent.text.split("\n\n[").length - 1, 2);
}

// ── 6. 历史时间推断：从后缀续上时间账 ───────────────────────────────────
// 用插件同款格式渲染任意时区的后缀，作为分支里的历史消息
function renderSuffix(epochMs, offsetMinutes) {
  const pad = (n) => String(n).padStart(2, "0");
  const weekdays = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const local = new Date(epochMs + offsetMinutes * 60_000);
  const hours = Math.trunc(Math.abs(offsetMinutes) / 60);
  const minutes = Math.abs(offsetMinutes) % 60;
  const tz = `${offsetMinutes < 0 ? "-" : "+"}${hours}${minutes > 0 ? `:${pad(minutes)}` : ""}`;
  const time =
    `${local.getUTCFullYear()}-${pad(local.getUTCMonth() + 1)}-${pad(local.getUTCDate())} ` +
    `${weekdays[local.getUTCDay()]} ${pad(local.getUTCHours())}:${pad(local.getUTCMinutes())} UTC${tz}`;
  return `\n\n[${time} | gap: 5m]`;
}

function userEntry(content) {
  return { type: "message", message: { role: "user", content } };
}

function historyCtx(branch) {
  return {
    mode: "plain",
    sessionManager: {
      getBranch: () => branch,
      getEntry: (id) => branch.find((entry) => entry.id === id),
    },
    ui: { getEditorText: () => "", setEditorText: () => {} },
  };
}

writeConfig('{"enabled":true,"thresholdMinutes":0}');
{
  // resume 后：上一条消息 90 分钟前，gap 应续上而不是从零开始
  const { handlers } = await loadPlugin();
  const branch = [userEntry(`旧消息${renderSuffix(Date.now() - 90 * 60_000, 480)}`)];
  await handlers.session_start({ reason: "resume" }, historyCtx(branch));
  const sent = await handlers.input({ type: "input", text: "继续" });
  check("resume 后从后缀续上 gap", /\| gap: 1h30m\]$/.test(sent.text), true);
}


{
  // 时区换算：UTC-9 与 UTC+5:30 也要算出同样的 90 分钟
  for (const offsetMinutes of [-540, 330]) {
    const { handlers } = await loadPlugin();
    const branch = [userEntry(`旧消息${renderSuffix(Date.now() - 90 * 60_000, offsetMinutes)}`)];
    await handlers.session_start({ reason: "resume" }, historyCtx(branch));
    const sent = await handlers.input({ type: "input", text: "继续" });
    check(`时区 ${offsetMinutes} 分钟偏移解析正确`, /\| gap: 1h30m\]$/.test(sent.text), true);
  }
}

{
  // 分支上没有可解析的后缀：回退到"本次没有上一条消息"（首条格式，无 gap 段）
  const { handlers } = await loadPlugin();
  const branch = [userEntry("没有后缀的旧消息")];
  await handlers.session_start({ reason: "resume" }, historyCtx(branch));
  const sent = await handlers.input({ type: "input", text: "继续" });
  check("无后缀时回退为首条格式", /^继续\n\n\[\d{4}-\d{2}-\d{2} [A-Z][a-z]{2} \d{2}:\d{2} UTC[+-]\d{1,2}(?::\d{2})?\]$/.test(sent.text), true);
}

{
  // 最近一条用户消息没有后缀时不再往前找：回退成不带 gap 段
  const { handlers } = await loadPlugin();
  const branch = [
    userEntry(`更早的消息${renderSuffix(Date.now() - 90 * 60_000, 480)}`),
    userEntry("/skill:foo"),
  ];
  await handlers.session_start({ reason: "resume" }, historyCtx(branch));
  const sent = await handlers.input({ type: "input", text: "继续" });
  check("最近一条用户消息无后缀时不回退着找", /\| gap: /.test(sent.text), false);
}

{
  // /tree 换分支后同样续上时间账
  const { handlers } = await loadPlugin();
  const branch = [userEntry(`分支消息${renderSuffix(Date.now() - 90 * 60_000, 480)}`)];
  await handlers.session_tree({ newLeafId: "u1", oldLeafId: "x" }, historyCtx(branch));
  const sent = await handlers.input({ type: "input", text: "继续" });
  check("/tree 换分支后从后缀续上 gap", /\| gap: 1h30m\]$/.test(sent.text), true);
}

{
  // 叶子通常是助手/工具消息：跳过它们，取最近一条用户消息的后缀
  const { handlers } = await loadPlugin();
  const branch = [
    userEntry(`旧消息${renderSuffix(Date.now() - 90 * 60_000, 480)}`),
    { type: "message", message: { role: "assistant", content: "回答" } },
    { type: "message", message: { role: "toolResult", content: "结果" } },
  ];
  await handlers.session_start({ reason: "resume" }, historyCtx(branch));
  const sent = await handlers.input({ type: "input", text: "继续" });
  check("跳过助手与工具条目取用户消息", /\| gap: 1h30m\]$/.test(sent.text), true);
}

{
  // 只看用户消息：自定义消息带后缀也不算数，最近一条用户消息没后缀就回退
  const { handlers } = await loadPlugin();
  const branch = [
    userEntry("没有后缀的用户消息"),
    { type: "custom_message", content: `自定义消息${renderSuffix(Date.now() - 90 * 60_000, 480)}` },
  ];
  await handlers.session_start({ reason: "resume" }, historyCtx(branch));
  const sent = await handlers.input({ type: "input", text: "继续" });
  check("自定义消息不参与时间推断", /\| gap: /.test(sent.text), false);
}
console.log(failures === 0 ? "\n全部通过" : `\n${failures} 项失败`);
process.exit(failures === 0 ? 0 : 1);
