import type { InputEvent, InputEventResult } from "@earendil-works/pi-coding-agent";
import { buildTimestampSuffix } from "./format.ts";
import { settings } from "./config.ts";
import { SKIP, state } from "./state.ts";
import { stripRestoredSuffixes } from "./tree.ts";

/**
 * 斜杠命令不加后缀：pi 在 input hook 之后才展开技能与模板，后缀会污染
 * 技能名和 $ARGUMENTS。
 */
function isSlashCommand(text: string): boolean {
  return text.trimStart().startsWith("/");
}

/** `input` hook 主体：决定本次消息要不要注入时间戳，并推进时间账。 */
export function handleInput(event: InputEvent): InputEventResult {
  const text = stripRestoredSuffixes(event.text);

  // 纯图片消息没有文本：不注入，也不推进时间账
  if (text.trim() === "") return SKIP;

  // 时间账无条件推进，因此关开关、发斜杠命令都不会让下一条消息的间隔失真
  const now = Date.now();
  const prev = state.lastMessageAt;
  state.lastMessageAt = now;

  if (!settings.enabled) return SKIP;
  if (isSlashCommand(text)) return SKIP;
  if (prev !== null && now - prev < settings.gapMs) return SKIP;

  return { action: "transform", text: text + buildTimestampSuffix(now, prev) };
}
