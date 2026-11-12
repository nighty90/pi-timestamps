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

/**
 * 条目是用户消息时返回其文本内容，否则返回 null。只认 `type: "message"` 且
 * `role: "user"` 的条目——助手消息、工具结果、各类记录条目、以及扩展注入的
 * custom_message 都不是用户输入。
 */
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
 * /tree 跳转到用户消息时，pi 会把该消息原文回填到输入框（见 navigateTree 的
 * editorText）。原文末尾带旧时间戳，需要在两个环节处理：
 *
 * 1. 回填端（正常路径）：session_tree 早于 pi 写编辑器，这里抢先写入剥净文本，
 *    用户看到的编辑器内容就是干净的。
 * 2. 发送端（兜底）：若回填未被劫持（例如 pi 改了时序），记住回填原文，提交时用
 *    startsWith 定位并替换那一段，用户在其后继续打字也不受影响。
 */
export function readRestoredEditorText(
  sessionManager: { getEntry(id: string): EditorRestoreEntry },
  targetId: string | null,
): string | null {
  if (!targetId) return null;
  return entryRestoreText(sessionManager.getEntry(targetId));
}

/**
 * 发送前剥掉回填带来的旧后缀，返回最终待发送文本。
 * 兜底路径下旧后缀不一定在末尾（用户可能在回填文本后继续打字），故按记住的
 * 回填原文前缀定位并只替换那一段；随后再兜底剥一次整条消息末尾的残留后缀
 * （例如直接粘贴了带后缀的旧消息）。
 */
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
 * 从分支上最近一条用户消息的后缀推断上次注入时刻。恢复会话、重载、/tree 换
 * 分支后进程内状态已失效，用后缀把时间账续上。
 *
 * 只看最近一条用户消息：它的后缀解析不出来（斜杠命令、纯图片、旧格式）就返回
 * null，行为回退到"本次还没有上一条消息"，不再往前找更早的消息。
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
