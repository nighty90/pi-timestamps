import type { InputEventResult } from "@earendil-works/pi-coding-agent";

/** 跨 hook 共享的状态；模块级 `let` 无法被其他模块改写，故集中成一个对象。 */
export const state: {
  /** 上一条消息的毫秒时间戳；会话恢复时从历史消息后缀推断，推断不到为 null。 */
  lastMessageAt: number | null;
  /** /tree 回填时 pi 即将写入编辑器的文本，已剥净时间戳；null 表示本次跳转不回填。 */
  pendingEditorText: string | null;
  /** /tree 回填到编辑器的原文（可能含后缀）；null 表示下一条输入不是回填内容。 */
  restoredEditorText: string | null;
} = {
  lastMessageAt: null,
  pendingEditorText: null,
  restoredEditorText: null,
};

/** 本插件对所有"不注入"分支返回同一个动作。 */
export const SKIP: InputEventResult = { action: "continue" };
