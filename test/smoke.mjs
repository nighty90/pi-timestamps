// 冒烟测试：用 pi 自带的 jiti loader 加载 index.ts，注入 fake pi / fake ctx，
// 直接调用命令 handler 与 input hook，检查配置读写、参数补全与注入行为。
// 用法：node test/smoke.mjs
//
// 说明：config.json 由 src/config.ts 按 pi 的 agent 目录定位，所以这里把
// index.ts 与 src/ 整棵复制进 test/.sandbox/，并把 PI_CODING_AGENT_DIR 指向
// test/.sandbox/agent，让配置落在沙箱内，不会碰到真实使用的配置文件。

import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const testDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = dirname(testDir);
const sandboxDir = join(testDir, ".sandbox");
const sandboxAgentDir = join(sandboxDir, "agent");
const sandboxFile = join(sandboxDir, "index.ts");
const configPath = join(sandboxAgentDir, "extensions", "pi-timestamps", "config.json");
process.env.PI_CODING_AGENT_DIR = sandboxAgentDir;
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
  if (pendingConfig !== null) {
    mkdirSync(dirname(configPath), { recursive: true });
    writeFileSync(configPath, pendingConfig, "utf8");
  }
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

// ── 模拟会话 ────────────────────────────────────────────────────────────
// pi 在 input hook 之后才把用户消息落盘，这里用同样的顺序维护假分支。

let entrySeq = 0;

function userEntry(content, at = Date.now()) {
  return {
    type: "message",
    timestamp: new Date(at).toISOString(),
    message: { role: "user", content },
  };
}

function makeSession(entries = [], leafId = null) {
  let leaf = leafId;
  for (const entry of entries) entry.id ??= `e${(entrySeq += 1)}`;
  return {
    getLeafId: () => leaf ?? entries.at(-1)?.id ?? null,
    // 假会话是线性的：getBranch(fromId) 就是端点及其之前的全部条目
    getBranch: (fromId) => {
      const end = fromId === undefined ? entries.length - 1 : entries.findIndex((e) => e.id === fromId);
      return end < 0 ? [] : entries.slice(0, end + 1);
    },
    getEntry: (id) => entries.find((entry) => entry.id === id),
    switchLeaf: (id) => {
      leaf = id;
    },
    push(entry) {
      const stored = { id: `e${(entrySeq += 1)}`, ...entry };
      entries.push(stored);
      return stored;
    },
  };
}

/** input hook 的 ctx：会话记录来自假 session。 */
function inputCtx(session) {
  return {
    mode: "plain",
    sessionManager: session,
    ui: { getEditorText: () => "", setEditorText: () => {} },
  };
}

/** 发送一条消息：hook 返回后按 pi 的顺序把消息落盘。 */
async function send(handlers, session, text) {
  const result = await handlers.input({ type: "input", text }, inputCtx(session));
  session.push(userEntry(result.action === "transform" ? result.text : text));
  return result;
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

// ── 2b. 配置落在 agent 目录的扩展子目录：自动建目录、原子写不留临时文件 ──
writeConfig(null);
{
  check("配置路径在 agent 目录内", configPath.startsWith(sandboxAgentDir), true);
  await runCommand("gap 9");
  check("目录不存在时写入自动建目录", existsSync(configPath), true);
  check("写入内容为合法配置", JSON.parse(readFileSync(configPath, "utf8")), {
    thresholdMinutes: 9,
  });
  check("写入后无残留临时文件", existsSync(`${configPath}.tmp`), false);
}

// ── 3. 注入行为：off / gap 0 / 阈值 / 斜杠命令 ──────────────────────────
writeConfig('{"enabled":false,"thresholdMinutes":5}');
{
  const { handlers } = await loadPlugin();
  check("off 时不注入", await send(handlers, makeSession(), "第一条"), {
    action: "continue",
  });
}

writeConfig('{"enabled":true,"thresholdMinutes":0}');
{
  const { handlers } = await loadPlugin();
  const session = makeSession();
  const first = await send(handlers, session, "第一条");
  check("gap 0 首条为 transform", first.action, "transform");
  check(
    "首条只有时间、没有 gap 段",
    /^第一条\n\n\[\d{4}-\d{2}-\d{2} [A-Z][a-z]{2} \d{2}:\d{2} UTC[+-]\d{1,2}(?::\d{2})?\]$/.test(
      first.text,
    ),
    true,
  );
  const second = await send(handlers, session, "第二条");
  check("gap 0 时每条都注入", second.action, "transform");
  check("后续消息带 gap 段", /\| gap: 0s\]$/.test(second.text), true);
}

writeConfig('{"enabled":true,"thresholdMinutes":5}');
{
  const { handlers } = await loadPlugin();
  const session = makeSession();
  await send(handlers, session, "第一条");
  check("未超阈值不注入", await send(handlers, session, "第二条"), {
    action: "continue",
  });
  check(
    "斜杠命令不注入",
    await handlers.input({ type: "input", text: "/skill:foo" }, inputCtx(session)),
    { action: "continue" },
  );
  check(
    "带前导空格的斜杠命令不注入",
    await handlers.input({ type: "input", text: "   /template a" }, inputCtx(session)),
    { action: "continue" },
  );
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


// ── 5. /tree 回填：剥净后缀 ───────────────────────────────────────────
const GAP_SUFFIX = "\n\n[2026-10-16 Fri 12:25 UTC+8 | gap: 5m]";
const FIRST_SUFFIX = "\n\n[2026-10-16 Fri 12:25 UTC+8]";
const FOREIGN_SUFFIX = "\n\n[2026-10-16 Fri 12:25]";
const restoredText = `早期消息${GAP_SUFFIX}`;

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
        ({ type: "custom_message", content: `自定义早期消息${GAP_SUFFIX}` }),
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
  const sent = await send(handlers, makeSession(), `${restoredText}补充一句`);
  check("兜底剥掉回填带来的后缀", sent.text.startsWith("早期消息补充一句\n\n[2026-"), true);
  check("兜底只保留一处时间戳", sent.text.split("\n\n[").length - 1, 1);
}

{
  // 直接粘贴带后缀的已发消息
  const { handlers } = await loadPlugin();
  const sent = await send(handlers, makeSession(), `粘贴的已发消息${GAP_SUFFIX}`);
  check("粘贴已发消息时剥掉尾部后缀", sent.text.startsWith("粘贴的已发消息\n\n[2026-"), true);
  check("粘贴已发消息后时间戳不重复", sent.text.split("\n\n[").length - 1, 1);
}

{
  // 认不出的方括号后缀按原样保留，本插件的后缀另行追加
  const { handlers } = await loadPlugin();
  const sent = await send(handlers, makeSession(), `历史消息${FOREIGN_SUFFIX}`);
  check("认不出的后缀保留", sent.text.startsWith("历史消息\n\n[2026-10-16 Fri 12:25]"), true);
  check("认不出的正文保留且追加后缀", sent.text.split("\n\n[").length - 1, 2);
}

// ── 6. 上一条消息时间：读会话条目的 timestamp ───────────────────────────
writeConfig('{"enabled":true,"thresholdMinutes":0}');

{
  // resume：分支末条用户消息在 90 分钟前，gap 应续上而不是从零开始
  const { handlers } = await loadPlugin();
  const session = makeSession([userEntry("旧消息", Date.now() - 90 * 60_000)]);
  const sent = await send(handlers, session, "继续");
  check("resume 后从条目时间续上 gap", /\| gap: 1h30m\]$/.test(sent.text), true);
}

{
  // 叶子通常是助手/工具条目：跳过它们，取最近一条用户消息
  const { handlers } = await loadPlugin();
  const session = makeSession([
    userEntry("旧消息", Date.now() - 90 * 60_000),
    {
      type: "message",
      timestamp: new Date().toISOString(),
      message: { role: "assistant", content: "回答" },
    },
    {
      type: "message",
      timestamp: new Date().toISOString(),
      message: { role: "toolResult", content: "结果" },
    },
    { type: "custom_message", timestamp: new Date().toISOString(), content: "自定义消息" },
  ]);
  const sent = await send(handlers, session, "继续");
  check("跳过助手、工具与自定义消息取用户消息", /\| gap: 1h30m\]$/.test(sent.text), true);
}

{
  // 分支上没有用户消息：按首条消息处理，不写 gap 段
  const { handlers } = await loadPlugin();
  const sent = await send(handlers, makeSession(), "继续");
  check(
    "没有用户消息时用首条格式",
    /^继续\n\n\[\d{4}-\d{2}-\d{2} [A-Z][a-z]{2} \d{2}:\d{2} UTC[+-]\d{1,2}(?::\d{2})?\]$/.test(
      sent.text,
    ),
    true,
  );
}

{
  // 斜杠命令不注入，也不推进时间账：下一条仍从更早的用户消息算
  const { handlers } = await loadPlugin();
  const session = makeSession([userEntry("更早的消息", Date.now() - 90 * 60_000)]);
  check(
    "斜杠命令返回 continue",
    await handlers.input({ type: "input", text: "/timestamp" }, inputCtx(session)),
    { action: "continue" },
  );
  const sent = await send(handlers, session, "继续");
  check("斜杠命令后仍从更早的消息算 gap", /\| gap: 1h30m\]$/.test(sent.text), true);
}

{
  // /tree 跳到旧分支：叶子换了，gap 从新叶子所在分支的末条用户消息算起
  const { handlers } = await loadPlugin();
  const session = makeSession([
    userEntry("旧分支的消息", Date.now() - 90 * 60_000),
    userEntry("新分支的消息", Date.now() - 60_000),
  ]);
  const [older] = session.getBranch();
  session.switchLeaf(older.id);
  const sent = await send(handlers, session, "继续");
  check("/tree 换叶子后从新叶子续上 gap", /\| gap: 1h30m\]$/.test(sent.text), true);
}

console.log(failures === 0 ? "\n全部通过" : `\n${failures} 项失败`);
process.exit(failures === 0 ? 0 : 1);
