# pi-timestamps

Append a timestamp to user messages in [pi](https://pi.dev/) so the model can tell how much time passed between turns.

**English** | [中文](README.zh.md)

[![npm version](https://img.shields.io/npm/v/@nighty90/pi-timestamps)](https://www.npmjs.com/package/@nighty90/pi-timestamps) [![license](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

## Install

### Requirements

- pi `>= 0.78.1`
- Node `>= 22.19.0`

### npm

```sh
pi install npm:@nighty90/pi-timestamps
```

### git

```sh
pi install git:github.com/nighty90/pi-timestamps
```

## Features

### Example

Every user message gets its send time appended, along with the gap since the previous user message.

```text
This is a reply from the user.

[2026-11-12 Thu 16:21 UTC+8 | gap: 29m]
```

When the time of the previous user message is unavailable — the first message of a new session, for instance — no gap is added.

```text
This is the first message of a new conversation.

[2026-11-12 Thu 16:59 UTC+8]
```

If less than the threshold has passed since the previous user message (5 minutes by default, configurable), no suffix is added at all.

```text
This message was sent at 17:00.
```

### Behavior

- Slash commands get no suffix, so skill names and template arguments still expand
- Image-only messages get no suffix but count for timing, so the next message's gap starts from them
- `/tree` strips the suffix from the text it restores into the editor
- After `/resume`, `/fork`, a restart, or a `/tree` branch switch, the gap continues from the previous user message recorded in the session

## Configuration

The switch and the threshold are managed by `/timestamp`. Changes take effect immediately and are written to `~/.pi/agent/extensions/pi-timestamps/config.json` (follows `PI_CODING_AGENT_DIR`).

| Input | Effect |
|---|---|
| `/timestamp` | Show the current switch and threshold, with the source of each (`config.json` or the default) |
| `/timestamp on` | Enable injection |
| `/timestamp off` | Disable injection |
| `/timestamp gap <n>` | Set the threshold in minutes; `0` injects on every message |

## Credits

The code was written by [pi](https://pi.dev/) driving `DeepSeek-V4.1-Flash-1017`.

- Human (nighty90): requirements and design decisions, trade-offs and rejections, code review, real-environment acceptance
- Model (DeepSeek): reading pi's source and extension API, implementation and refactoring, tests and comments

## License

MIT (see [LICENSE](LICENSE)).
