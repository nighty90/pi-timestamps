import { stripTimestampSuffix } from "./format.ts";
import { state } from "./state.ts";

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

/** 会话条目的最小形状：回填读文本、推断读时间，其余字段不关心。 */
export type SessionEntryLike =
  | {
      type?: string;
      timestamp?: string;
      message?: { role?: string; content?: unknown };
      content?: unknown;
    }
  | undefined;

/** `/tree` 回填的文本来源：用户消息取 `message.content`，自定义消息取 `content`。 */
function entryRestoreText(entry: SessionEntryLike): string | null {
  if (!entry) return null;
  if (entry.type === "message" && entry.message?.role === "user") {
    return contentToText(entry.message.content);
  }
  if (entry.type === "custom_message") {
    return contentToText(entry.content);
  }
  return null;
}

/**
 * 取出 /tree 选中条目在回填时写入编辑器的文本。回填端与发送端都要用它，
 * 发送端用于定位并剥除回填文本里的后缀。
 */
export function readRestoredEditorText(
  sessionManager: { getEntry(id: string): SessionEntryLike },
  targetId: string | null,
): string | null {
  if (!targetId) return null;
  return entryRestoreText(sessionManager.getEntry(targetId));
}

/** 剥除回填文本带来的后缀：先按回填原文前缀替换，再兜底剥一次末尾残留。 */
export function stripRestoredSuffixes(rawText: string): string {
  const restored = state.restoredEditorText;
  state.restoredEditorText = null;

  let text = rawText;
  if (restored !== null && text.startsWith(restored)) {
    const strippedRestored = stripTimestampSuffix(restored);
    if (strippedRestored !== restored) {
      text = strippedRestored + text.slice(restored.length);
    }
  }
  return stripTimestampSuffix(text);
}

/**
 * 分支上最近一条用户消息的落盘时刻（毫秒）。会话恢复与 /tree 换分支后叶子已经
 * 指向目标条目，故不需要外部传入 id；没有用户消息返回 null。
 */
export function lastUserMessageAt(session: {
  getLeafId(): string | null;
  getBranch(fromId?: string): SessionEntryLike[];
}): number | null {
  const branch = session.getBranch(session.getLeafId() ?? undefined);
  for (let index = branch.length - 1; index >= 0; index -= 1) {
    const entry = branch[index];
    // assistant / toolResult / 各类记录条目不是用户消息，跳过它们
    if (entry?.type !== "message" || entry.message?.role !== "user") continue;
    const at = Date.parse(entry.timestamp ?? "");
    return Number.isNaN(at) ? null : at;
  }
  return null;
}
