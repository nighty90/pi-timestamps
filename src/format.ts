// ── 时间格式化 ──────────────────────────────────────────────────────────

/** getDay() 返回 0(周日)~6，映射到英文缩写。 */
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function pad(n: number): string {
  return n.toString().padStart(2, "0");
}

/** 格式化时区为 UTC 偏移：UTC+8 / UTC-5 / UTC+5:30。 */
function formatTimezoneOffset(d: Date): string {
  const offsetMinutes = d.getTimezoneOffset(); // UTC - 本地，中国返回 -480
  const sign = offsetMinutes <= 0 ? "+" : "-";
  const abs = Math.abs(offsetMinutes);
  const hours = Math.floor(abs / 60);
  const minutes = abs % 60;
  const mins = minutes > 0 ? `:${pad(minutes)}` : "";
  return `UTC${sign}${hours}${mins}`;
}

function formatTimestamp(d: Date): string {
  const weekday = WEEKDAYS[d.getDay()];
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${weekday} ${pad(d.getHours())}:${pad(d.getMinutes())} ` +
    formatTimezoneOffset(d)
  );
}

/** 把毫秒间隔格式化成紧凑短格式：42s / 5m / 3h15m / 2d5h。 */
export function formatElapsed(ms: number): string {
  let seconds = Math.max(0, Math.floor(ms / 1000));
  const days = Math.floor(seconds / 86400);
  seconds %= 86400;
  const hours = Math.floor(seconds / 3600);
  seconds %= 3600;
  const minutes = Math.floor(seconds / 60);
  seconds %= 60;

  const parts: string[] = [];
  if (days > 0) parts.push(`${days}d`);
  if (hours > 0) parts.push(`${hours}h`);
  if (minutes > 0) parts.push(`${minutes}m`);
  if (parts.length === 0) parts.push(`${seconds}s`);
  return parts.join("");
}

// ── 时间戳后缀 ──────────────────────────────────────────────────────────

/**
 * 注入到消息末尾的时间戳后缀，两种形状：
 *   首条消息  `[2026-10-16 Fri 12:25 UTC+8]`
 *   后续消息  `[2026-10-16 Fri 12:25 UTC+8 | gap: 5m]`
 * 旧版 `[Time: … | Since last: …]` 不再生成，也不再剥除。
 */
const TIMESTAMP_SUFFIX_RE =
  /\s*\[\d{4}-\d{2}-\d{2} [A-Z][a-z]{2} \d{2}:\d{2} UTC[+-]\d{1,2}(?::\d{2})?(?: \| gap: [^\]\n]+)?\]\s*$/;

/** 剥离文本末尾由本插件注入的时间戳后缀；嵌套多层时一并剥离。 */
export function stripTimestampSuffix(text: string): string {
  let result = text;
  for (;;) {
    const next = result.replace(TIMESTAMP_SUFFIX_RE, "").trimEnd();
    if (next === result || next.length === 0) return next;
    result = next;
  }
}

/** 组装注入后缀；prev 为 null 表示会话首条消息，此时不写 gap 段。 */
export function buildTimestampSuffix(now: number, prev: number | null): string {
  const time = formatTimestamp(new Date(now));
  if (prev === null) return `\n\n[${time}]`;
  return `\n\n[${time} | gap: ${formatElapsed(now - prev)}]`;
}

/**
 * 从消息末尾的后缀 `[2026-11-12 Thu 15:52 UTC+8 | gap: 5m]` 解析出注入时刻
 * （毫秒）。首条消息没有 gap 段，照样解析；旧版 `[Time: …]` 不认。
 * 解析不到返回 null。
 */
export function parseSuffixTimestamp(text: string): number | null {
  const block = /\n*\[([^\]\n]*)\]\s*$/.exec(text);
  if (!block) return null;
  const fields =
    /^(\d{4})-(\d{2})-(\d{2}) [A-Z][a-z]{2} (\d{2}):(\d{2}) UTC([+-])(\d{1,2})(?::(\d{2}))?/.exec(
      block[1],
    );
  if (!fields) return null;

  const [year, month, day, hour, minute] = fields.slice(1, 6).map(Number);
  const sign = fields[6] === "+" ? 1 : -1;
  const offsetMinutes = sign * (Number(fields[7]) * 60 + Number(fields[8] ?? 0));
  // 后缀里写的是本地时间，减去时区偏移得到 UTC 时刻
  return Date.UTC(year, month - 1, day, hour, minute) - offsetMinutes * 60_000;
}
