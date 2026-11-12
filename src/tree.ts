import { parseSuffixTimestamp, stripTimestampSuffix } from "./format.ts";
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

/** /tree 回填只需区分用户消息与自定义消息，其余类型不参与。 */
export type EditorRestoreEntry =
  | { type?: string; message?: { role?: string; content?: unknown }; content?: unknown }
  | undefined;

/** 条目是用户消息时返回其文本，否则 null（只认 type: "message" 与 role: "user"）。 */
function entryUserText(entry: EditorRestoreEntry): string | null {
  if (!entry) return null;
  if (entry.type !== "message" || entry.message?.role !== "user") return null;
  return contentToText(entry.message.content);
}

/** `/tree` 回填的文本来源：用户消息取 `message.content`，自定义消息取 `content`。 */
function entryRestoreText(entry: EditorRestoreEntry): string | null {
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
  sessionManager: { getEntry(id: string): EditorRestoreEntry },
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
 * 从分支上最近一条用户消息的后缀推断上次注入时刻；解析不出来返回 null，
 * 不往前找更早的消息。
 */
export function inferLastMessageAt(
  sessionManager: { getBranch(fromId?: string): EditorRestoreEntry[] },
  fromId: string | null,
): number | null {
  const branch = sessionManager.getBranch(fromId ?? undefined);
  for (let index = branch.length - 1; index >= 0; index -= 1) {
    // assistant / toolResult / 各类记录条目没有用户文本，跳过它们
    const text = entryUserText(branch[index]);
    if (text === null) continue;
    return parseSuffixTimestamp(text);
  }
  return null;
}
