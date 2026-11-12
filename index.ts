import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { completeSubcommands, runTimestampCommand } from "./src/config.ts";
import { handleInput } from "./src/input.ts";
import { state } from "./src/state.ts";
import {
  inferLastMessageAt,
  readRestoredEditorText,
} from "./src/tree.ts";
import { stripTimestampSuffix } from "./src/format.ts";

/**
 * 给用户消息自动加上当前时间戳，让模型感知每条消息的时间。
 * 通过 pi 的 `input` hook 的 `transform` 动作实现，发生在 skill/template
 * 展开和 agent 处理之前。
 *
 * 只在距上一条消息超过阈值时才注入（感知跨时段长会话），连续快速
 * 问答零开销。恢复会话（/resume、/fork）、pi 重启或 `/tree` 换分支后，从当前
 * 分支最近一条用户消息的后缀把上次注入时刻读回来，时间账因此不断档；该后缀
 * 解析不出来时按"本次还没有上一条消息"处理。后缀形如
 * `[2026-10-16 Fri 12:25 UTC+8 | gap: 5m]`，gap 是距
 * 上一条消息的间隔；会话首条消息没有上一条，只写时间部分。
 *
 * 开关与阈值用 `/timestamp` 命令查看和修改，设置写入包根目录的 config.json
 * 并立即生效（无需 /reload）；也可手工编辑该文件：
 *
 *   <包根>/config.json
 *   {
 *     "enabled": true,
 *     "thresholdMinutes": 5
 *   }
 *
 * 配置缺失或字段无效时回退到默认值（enabled: true、thresholdMinutes: 5）。
 *
 * 代码组织：本文件只负责挂 hook 与命令，实现分布在 src/。src/config.ts 的位置
 * 依赖 `src/` 这一层，移动文件时需同步调整其中定位 config.json 的路径。
 */

export default function (pi: ExtensionAPI) {
  // 恢复会话（resume/fork）、重载、重启时进程内状态已清空：从当前分支最近
  // 一条带后缀的用户消息续上时间账；新会话分支为空，自然回退到 null
  pi.on("session_start", async (_event, ctx) => {
    state.restoredEditorText = null;
    state.pendingEditorText = null;
    state.lastMessageAt = inferLastMessageAt(ctx.sessionManager, null);
  });

  // /tree 跳转：用户在选择器里选中的条目才是回填来源。注意不能从 session_tree
  // 的 newLeafId 取——选中用户消息时 pi 会把叶子落到其 parent，用户消息本身
  // 不进入事件，只有 session_before_tree 的 preparation.targetId 是选中条目。
  pi.on("session_before_tree", async (event, ctx) => {
    const targetId = event.preparation.targetId;
    const restored = readRestoredEditorText(ctx.sessionManager, targetId);
    // 发送端兜底：记住回填原文，提交时据此剥除其中的旧后缀
    state.restoredEditorText = restored;
    // 回填端：pi 稍后会把原文写进编辑器，这里提前算好剥净的版本
    state.pendingEditorText = restored === null ? null : stripTimestampSuffix(restored);
  });

  pi.on("session_tree", async (event, ctx) => {
    // /tree 跳到树内另一分支时，从新分支末条带后缀的用户消息续上时间账
    if (event.newLeafId !== event.oldLeafId) {
      state.lastMessageAt = inferLastMessageAt(ctx.sessionManager, event.newLeafId);
    }

    // pi 只在编辑器为空时把 editorText 回填进输入框（见 interactive-mode 的
    // navigateTree 包装）。这里在回填之前抢先写入剥净文本，pi 随后看到编辑器非空
    // 便跳过自己的回填；编辑器里已有草稿时保持不动，避免覆盖用户输入。
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

  pi.on("input", async (event) => handleInput(event));
}
