# pi-timestamps

给 [pi](https://pi.dev/) 的用户消息加时间戳，让模型知道两轮对话之间隔了多久。

[English](README.md) | **中文**

[![npm version](https://img.shields.io/npm/v/@nighty90/pi-timestamps)](https://www.npmjs.com/package/@nighty90/pi-timestamps) [![license](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

## 安装

### 插件依赖

- pi `>= 0.78.1`
- Node `>= 22.19.0`

### npm 安装

```sh
pi install npm:@nighty90/pi-timestamps
```

### git 安装

```sh
pi install git:github.com/nighty90/pi-timestamps
```

## 功能

### 示例

每条用户消息末尾会追加消息的发送时刻，以及距离上一条用户消息的间隔。

```text
这是一条用户回复。

[2026-11-12 Thu 16:21 UTC+8 | gap: 29m]
```

若无法获取上一条用户消息的时间戳，例如当前为新会话的第一条消息，则不带间隔信息。

```text
这是新对话里的第一条消息。

[2026-11-12 Thu 16:59 UTC+8]
```

若距上一条用户消息没到阈值（默认 5 分钟，可配置）则整条跳过，不加后缀。

```text
这是 17:00 发送的消息。
```

### 行为

- 斜杠命令不加后缀，避免干扰技能名与模板参数的展开
- 纯图片消息不加后缀，但参与计时（下一条消息的间隔从它算起）
- `/tree` 跳回历史消息时，自动从回填到编辑框的文本中剥离后缀
- `/resume`、`/fork`、进程重启、`/tree` 换分支之后，会从会话记录里上一条用户消息的时间续算间隔

## 配置

开关与阈值由 `/timestamp` 命令管理，改动立即生效，写入配置文件 `~/.pi/agent/extensions/pi-timestamps/config.json`（跟随环境变量 `PI_CODING_AGENT_DIR`）。

| 输入 | 作用 |
|---|---|
| `/timestamp` | 显示当前开关与阈值，并标注各自的来源（`config.json` 或默认值） |
| `/timestamp on` | 开关注入 |
| `/timestamp off` | 关闭注入 |
| `/timestamp gap <n>` | 设置阈值，单位分钟；`0` 表示每条消息都注入 |

## 致谢

代码由 [pi](https://pi.dev/) 驱动 `DeepSeek-V4.1-Flash-1017` 编写。

- 人类（nighty90）负责：需求与设计决策、方向取舍与否决项、代码审阅、真实环境验收
- 模型（DeepSeek）负责：查阅 pi 源码与扩展 API、实现与重构、测试与注释维护

## 许可

MIT（见 [LICENSE](LICENSE)）。
