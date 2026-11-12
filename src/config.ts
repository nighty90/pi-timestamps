import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

const DEFAULT_THRESHOLD_MINUTES = 5;
const CONFIG_FILE_NAME = "config.json";
const USAGE = "usage: /timestamp | /timestamp on | /timestamp off | /timestamp gap <minutes>";

/** 包根目录：本文件在 `<包根>/src/`，从自身文件 URL 上溯两级。 */
function getPackageDir(): string {
  return dirname(dirname(fileURLToPath(import.meta.url)));
}

/** config.json 的绝对路径（包根目录下）。 */
function getConfigPath(): string {
  return join(getPackageDir(), CONFIG_FILE_NAME);
}

/** 读 config.json 原始对象；文件缺失、解析失败或不是对象时返回 null。 */
function readConfigFile(): Record<string, unknown> | null {
  const configPath = getConfigPath();
  if (!existsSync(configPath)) return null;
  try {
    const parsed: unknown = JSON.parse(readFileSync(configPath, "utf8"));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** 文件里的 enabled：是合法布尔值才返回，否则 null（视为未配置）。 */
function fileEnabled(raw: Record<string, unknown> | null): boolean | null {
  const value = raw?.enabled;
  return typeof value === "boolean" ? value : null;
}

/** 分钟数合法：非负整数（0 表示每条消息都注入）。 */
export function isValidMinutes(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

/** 文件里的 thresholdMinutes：是合法分钟数才返回，否则 null（视为未配置）。 */
function fileThresholdMinutes(raw: Record<string, unknown> | null): number | null {
  const value = raw?.thresholdMinutes;
  return isValidMinutes(value) ? value : null;
}

/** 把补丁合并进 config.json（保留文件里的其它字段），写入失败返回 false。 */
function saveConfig(patch: Record<string, unknown>): boolean {
  const merged = { ...(readConfigFile() ?? {}), ...patch };
  try {
    writeFileSync(getConfigPath(), `${JSON.stringify(merged, null, 2)}\n`, "utf8");
    return true;
  } catch {
    return false;
  }
}

/** 生效中的配置；模块级 `let` 无法被其他模块改写，故集中成一个对象。 */
export const settings: {
  /** 注入开关：/timestamp on|off，或 config.json 的 enabled 字段。 */
  enabled: boolean;
  /** 注入阈值（毫秒）：/timestamp gap <n>，或 config.json 的 thresholdMinutes 字段。 */
  gapMs: number;
} = (() => {
  const raw = readConfigFile();
  return {
    enabled: fileEnabled(raw) ?? true,
    gapMs: (fileThresholdMinutes(raw) ?? DEFAULT_THRESHOLD_MINUTES) * 60 * 1000,
  };
})();

/** 阈值可读形式：分钟，0 表示每条都注入。 */
export function formatGap(): string {
  return settings.gapMs === 0 ? "0 (every message)" : `${settings.gapMs / 60000}m`;
}

/** `/timestamp` 无参数时展示的配置摘要，标注每个值的来源。 */
export function formatConfigSummary(): string {
  const raw = readConfigFile();
  const source = (fromFile: boolean) => (fromFile ? CONFIG_FILE_NAME : "default");
  const onOff = settings.enabled ? "on" : "off";
  return [
    `timestamp: ${onOff}  (${source(fileEnabled(raw) !== null)})`,
    `gap: ${formatGap()}  (${source(fileThresholdMinutes(raw) !== null)})`,
  ].join("\n");
}

/** 子命令表，同时用于参数补全提示。 */
const SUBCOMMANDS = [
  { value: "on", description: "Enable timestamp injection" },
  { value: "off", description: "Disable timestamp injection" },
  { value: "gap", description: "Set the threshold in minutes, 0 = every message" },
] as const;

/** 补全子命令：只补第一段参数，`gap 10` 这类已带参数的后缀不再提示。 */
export function completeSubcommands(
  argumentPrefix: string,
): Array<{ value: string; label: string; description: string }> | null {
  const normalized = argumentPrefix.trim().toLowerCase();
  if (normalized.includes(" ") || argumentPrefix.endsWith(" ")) return null;
  const matches = SUBCOMMANDS.filter((item) => item.value.startsWith(normalized)).map((item) => ({
    value: item.value,
    label: item.value,
    description: item.description,
  }));
  return matches.length > 0 ? matches : null;
}

/** 提示设置结果；写入失败时说明只改了内存（本次运行仍生效）。 */
function notifySaved(ctx: ExtensionCommandContext, message: string, saved: boolean): void {
  const detail = saved ? message : `${message}\n无法写入 ${CONFIG_FILE_NAME}，仅在本次运行生效`;
  ctx.ui.notify(detail, saved ? "info" : "warning");
}

/** `/timestamp` 命令主体：无参数展示配置，其余按子命令处理。 */
export async function runTimestampCommand(
  args: string,
  ctx: ExtensionCommandContext,
): Promise<void> {
  const [sub, ...rest] = args.trim().split(/\s+/).filter(Boolean);

  if (sub === undefined) {
    ctx.ui.notify(formatConfigSummary(), "info");
    return;
  }

  if ((sub === "on" || sub === "off") && rest.length === 0) {
    settings.enabled = sub === "on";
    notifySaved(ctx, `timestamp: ${sub}`, saveConfig({ enabled: settings.enabled }));
    return;
  }

  if (sub === "gap" && rest.length === 1) {
    const minutes = Number(rest[0]);
    if (!isValidMinutes(minutes)) {
      ctx.ui.notify(`invalid minutes: "${rest[0]}"\n${USAGE}`, "warning");
      return;
    }
    settings.gapMs = minutes * 60 * 1000;
    notifySaved(ctx, `gap: ${formatGap()}`, saveConfig({ thresholdMinutes: minutes }));
    return;
  }

  ctx.ui.notify(USAGE, "warning");
}
