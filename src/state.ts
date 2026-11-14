import type { InputEventResult } from "@earendil-works/pi-coding-agent";

/** 跨 hook 共享的状态；模块级 `let` 无法被其他模块改写，故集中成一个对象。 */
export const state: {
  /** /tree 回填时 pi 即将写入编辑器的文本，已剥净时间戳；null 表示本次跳转不回填。 */
  pendingEditorText: string | null;
} = {
  pendingEditorText: null,
};

/** 本插件对所有"不注入"分支返回同一个动作。 */
export const SKIP: InputEventResult = { action: "continue" };
