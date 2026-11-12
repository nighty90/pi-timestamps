import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/**
 * 给用户消息自动加上当前时间戳，让模型感知每条消息的时间。
 * 通过 pi 的 `input` hook 的 `transform` 动作实现，发生在 skill/template
 * 展开和 agent 处理之前。
 *
 * 只在距上一条消息超过阈值时才注入（感知跨时段长会话），连续快速
 * 问答零开销。切换会话（/new、/resume、/fork）或 pi 重启时重置上次
 * 注入时间，因此首条消息显示 start of run。阈值用 config.json 配置：
 *
 *   ~/.pi/agent/extensions/pi-timestamps/config.json
 *   {
 *     "thresholdMinutes": 5
 *   }
 *
 * 配置缺失或字段无效时回退到默认值。
 */

/** getDay() 返回 0(周日)~6，映射到英文缩写。 */
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function pad(n: number): string {
  return n.toString().padStart(2, "0");
}

/** 格式化时区为 UTC 偏移：UTC+8 / UTC-5 / UTC+5:30。 */
function formatTimezoneOffset(d: Date): string {
  const offsetMinutes = d.getTimezoneOffset(); // UTC - 本地，中国返回 -480
  const sign = offsetMinutes <= 0 ? "+" : "-";
  const abs = Math.abs(offsetMinutes);
  const hours = Math.floor(abs / 60);
  const minutes = abs % 60;
  const mins = minutes > 0 ? `:${pad(minutes)}` : "";
  return `UTC${sign}${hours}${mins}`;
}

function formatTimestamp(d: Date): string {
  const weekday = WEEKDAYS[d.getDay()];
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${weekday} ${pad(d.getHours())}:${pad(d.getMinutes())} ` +
    formatTimezoneOffset(d)
  );
}

/** 把毫秒间隔格式化成紧凑短格式：42s / 5m / 3h15m / 2d5h。 */
function formatElapsed(ms: number): string {
  let seconds = Math.max(0, Math.floor(ms / 1000));
  const days = Math.floor(seconds / 86400);
  seconds %= 86400;
  const hours = Math.floor(seconds / 3600);
  seconds %= 3600;
  const minutes = Math.floor(seconds / 60);
  seconds %= 60;

  const parts: string[] = [];
  if (days > 0) parts.push(`${days}d`);
  if (hours > 0) parts.push(`${hours}h`);
  if (minutes > 0) parts.push(`${minutes}m`);
  if (parts.length === 0) parts.push(`${seconds}s`);
  return parts.join("");
}

/** 注入到消息末尾的时间戳后缀，形如
 * `[Time: 2026-10-16 Fri 12:25 UTC+8 | Since last: 5m]`。 */
const TIMESTAMP_SUFFIX_RE = /\s*\[Time: [^\]\n]*\]\s*$/;

/** 剥离文本末尾由本插件注入的时间戳后缀；嵌套多层时一并剥离。 */
function stripTimestampSuffix(text: string): string {
  let result = text;
  for (;;) {
    const next = result.replace(TIMESTAMP_SUFFIX_RE, "").trimEnd();
    if (next === result || next.length === 0) return next;
    result = next;
  }
}

/** 把消息 content 转成 pi 回填编辑器时的文本形式：文本块直接拼接。 */
function contentToText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter(
      (block): block is { type: string; text: string } =>
        typeof block === "object" &&
        block !== null &&
        (block as { type?: unknown }).type === "text" &&
        typeof (block as { text?: unknown }).text === "string",
    )
    .map((block) => block.text)
    .join("");
}

/**
 * /tree 跳转到用户消息时，pi 会把该消息原文回填到输入框（见 navigateTree 的
 * editorText）。原文末尾带旧时间戳，需要在两个环节处理：
 *
 * 1. 回填端（正常路径）：session_tree 早于 pi 写编辑器，这里抢先写入剥净文本，
 *    用户看到的编辑器内容就是干净的。
 * 2. 发送端（兜底）：若回填未被劫持（例如 pi 改了时序），记住回填原文，提交时用
 *    startsWith 定位并替换那一段，用户在其后继续打字也不受影响。
 */
function readRestoredEditorText(
  sessionManager: { getEntry(id: string): unknown },
  targetId: string | null,
): string | null {
  if (!targetId) return null;
  const entry = sessionManager.getEntry(targetId) as
    | { type?: string; message?: { role?: string; content?: unknown }; content?: unknown }
    | undefined;
  if (!entry) return null;
  if (entry.type === "message" && entry.message?.role === "user") {
    return contentToText(entry.message.content);
  }
  if (entry.type === "custom_message") {
    return contentToText(entry.content);
  }
  return null;
}

const EXTENSION_ID = "pi-timestamps";
const DEFAULT_THRESHOLD_MINUTES = 5;

/** 上一条消息的毫秒时间戳；进程内状态，pi 重启后重置为 null，因此重启后的首条消息会显示 start of run。 */
let lastMessageAt: number | null = null;

/** /tree 回填时 pi 即将写入编辑器的文本，已剥净时间戳；null 表示本次跳转不回填。 */
let pendingEditorText: string | null = null;

/** /tree 回填到编辑器的原文（含旧时间戳）；null 表示下一条输入不是回填内容。 */
let restoredEditorText: string | null = null;

/** 读取 config.json 里的阈值（毫秒），无效时回退默认。 */
function loadThresholdMs(): number {
  const configPath = join(getAgentDir(), "extensions", EXTENSION_ID, "config.json");
  const fallback = DEFAULT_THRESHOLD_MINUTES * 60 * 1000;
  try {
    if (!existsSync(configPath)) return fallback;
    const raw = JSON.parse(readFileSync(configPath, "utf8")) as {
      thresholdMinutes?: unknown;
    };
    const minutes = raw.thresholdMinutes;
    if (typeof minutes !== "number" || !Number.isFinite(minutes) || minutes < 0) {
      return fallback;
    }
    return minutes * 60 * 1000;
  } catch {
    return fallback;
  }
}

const THRESHOLD_MS = loadThresholdMs();

export default function (pi: ExtensionAPI) {
  // 切换到另一个会话（/new、/resume、/fork）时重置
  pi.on("session_start", async (event) => {
    if (event.reason === "new" || event.reason === "resume" || event.reason === "fork") {
      lastMessageAt = null;
      restoredEditorText = null;
      pendingEditorText = null;
    }
  });

  // /tree 跳转：用户在选择器里选中的条目才是回填来源。注意不能从 session_tree
  // 的 newLeafId 取——选中用户消息时 pi 会把叶子落到其 parent，用户消息本身
  // 不进入事件，只有 session_before_tree 的 preparation.targetId 是选中条目。
  pi.on("session_before_tree", async (event, ctx) => {
    const targetId = event.preparation.targetId;
    const restored = readRestoredEditorText(ctx.sessionManager, targetId);
    // 发送端兜底：记住回填原文，提交时据此剥除其中的旧后缀
    restoredEditorText = restored;
    // 回填端：pi 稍后会把原文写进编辑器，这里提前算好剥净的版本
    pendingEditorText = restored === null ? null : stripTimestampSuffix(restored);
  });

  pi.on("session_tree", async (event, ctx) => {
    // /tree 跳到树内另一分支时重置：新分支的首条消息应视为新的起点
    if (event.newLeafId !== event.oldLeafId) {
      lastMessageAt = null;
    }

    // pi 只在编辑器为空时把 editorText 回填进输入框（见 interactive-mode 的
    // navigateTree 包装）。这里在回填之前抢先写入剥净文本，pi 随后看到编辑器非空
    // 便跳过自己的回填；编辑器里已有草稿时保持不动，避免覆盖用户输入。
    const clean = pendingEditorText;
    pendingEditorText = null;
    if (ctx.mode !== "tui" || clean === null || clean.trim() === "") return;
    if (ctx.ui.getEditorText().trim() !== "") return;
    ctx.ui.setEditorText(clean);
  });

  pi.on("input", async (event) => {
    // 兜底路径：正常已由 session_tree 抢先把干净文本写进编辑器，这里只在回填未被
    // 劫持时生效——记住的回填原文带旧时间戳，用户在回填文本后面继续打字后旧后缀就不
    // 在末尾，无法按后缀匹配剥离，故用 startsWith 定位并只替换那一段。
    let text = event.text;
    const restored = restoredEditorText;
    restoredEditorText = null;
    if (restored !== null && text.startsWith(restored)) {
      const strippedRestored = stripTimestampSuffix(restored);
      if (strippedRestored !== restored) {
        text = strippedRestored + text.slice(restored.length);
      }
    }
    // 兜底：整条消息末尾残留的后缀（例如直接粘贴带后缀的旧消息）。
    text = stripTimestampSuffix(text);

    // 跳过纯图片消息（无文本）
    if (!text || !text.trim()) {
      return { action: "continue" };
    }

    // 记录上一条消息的时间并更新
    const now = Date.now();
    const prev = lastMessageAt;
    lastMessageAt = now;

    // 斜杠命令不能加后缀：pi 在 input hook 之后才展开 /skill: 与 prompt template，
    // 而 _expandSkillCommand 用 indexOf(" ") 切技能名，后缀里的空格会把技能名切成
    // "foo\n\n[Time:"，查不到技能便原样放行。prompt template 的正则同样会把后缀
    // 当作参数污染 $ARGUMENTS。时间账照记，只是不注入。
    if (text.trimStart().startsWith("/")) {
      return { action: "continue" };
    }

    // 跳过间隔小于阈值的消息
    if (prev !== null && now - prev < THRESHOLD_MS) {
      return { action: "continue" };
    }

    let sinceLast: string;
    if (prev === null) {
      sinceLast = "start of run";
    } else {
      sinceLast = formatElapsed(now - prev);
    }
    const timestamp = `\n\n[Time: ${formatTimestamp(new Date())} | Since last: ${sinceLast}]`;

    return {
      action: "transform",
      text: text + timestamp,
    };
  });
}
