import type {
  ExtensionContext,
  InputEvent,
  InputEventResult,
} from "@earendil-works/pi-coding-agent";
import { buildTimestampSuffix } from "./format.ts";
import { settings } from "./config.ts";
import { SKIP } from "./state.ts";
import { lastUserMessageAt } from "./tree.ts";

/**
 * 斜杠命令不加后缀：pi 在 input hook 之后才展开技能与模板，后缀会污染
 * 技能名和 $ARGUMENTS。
 */
function isSlashCommand(text: string): boolean {
  return text.trimStart().startsWith("/");
}

/** `input` hook 主体：决定本次消息要不要注入时间戳。 */
export function handleInput(event: InputEvent, ctx: ExtensionContext): InputEventResult {
  const text = event.text;

  // 纯图片消息没有文本：不注入
  if (text.trim() === "") return SKIP;
  if (!settings.enabled) return SKIP;
  if (isSlashCommand(text)) return SKIP;

  const now = Date.now();
  const prev = lastUserMessageAt(ctx.sessionManager);
  if (prev !== null && now - prev < settings.gapMs) return SKIP;

  return { action: "transform", text: text + buildTimestampSuffix(now, prev) };
}
