import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { completeSubcommands, runTimestampCommand } from "./src/config.ts";
import { handleInput } from "./src/input.ts";
import { state } from "./src/state.ts";
import { readRestoredEditorText } from "./src/tree.ts";
import { stripTimestampSuffix } from "./src/format.ts";

/**
 * 给用户消息末尾追加 `[时间 | gap: …]` 后缀，让模型感知每条消息的时间。
 * 开关与阈值用 `/timestamp` 命令管理，设置写入 agent 目录下的
 * extensions/pi-timestamps/config.json。
 */

export default function (pi: ExtensionAPI) {
  // 选中条目只在 preparation.targetId 里，session_tree 的 newLeafId 会落到它的 parent
  pi.on("session_before_tree", async (event, ctx) => {
    const targetId = event.preparation.targetId;
    const restored = readRestoredEditorText(ctx.sessionManager, targetId);
    // pi 稍后会把原文写进编辑器，这里提前算好剥净的版本
    state.pendingEditorText = restored === null ? null : stripTimestampSuffix(restored);
  });

  pi.on("session_tree", async (_event, ctx) => {
    // pi 只在编辑器为空时回填：抢先写入剥净文本，已有草稿则保持不动
    const clean = state.pendingEditorText;
    state.pendingEditorText = null;
    if (ctx.mode !== "tui" || clean === null || clean.trim() === "") return;
    if (ctx.ui.getEditorText().trim() !== "") return;
    ctx.ui.setEditorText(clean);
  });

  // 配置命令：查看开关与阈值，修改后写入 config.json 并立即生效
  pi.registerCommand("timestamp", {
    description: "Show or change timestamp injection settings",
    getArgumentCompletions: completeSubcommands,
    handler: runTimestampCommand,
  });

  pi.on("input", async (event, ctx) => handleInput(event, ctx));
}
