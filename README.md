# Wakacodex

Minimal WakaTime integration for Codex using the experimental `SessionStart` and `Stop` hooks added in Codex `0.114.0`.

This package deliberately stays quiet:

- no stdout/stderr on success
- no Codex hook status messages by default
- no auto-install of `wakatime-cli`
- no writes into your repo or Codex transcript files

Instead it sends app-level heartbeats for the current Codex workspace and keeps a small rate-limit state file in `~/.wakatime/wakacodex-state.json`.

## Requirements

- Codex CLI `0.114.0` or newer
- Bun `1.3+` for the documented install flow
- Node.js `18+` or Bun for running the hook command
- your WakaTime API key in `~/.wakatime.cfg`

Example `~/.wakatime.cfg`:

```ini
[settings]
api_key = waka_123
```

## Install

Install the hook command:

```bash
bun add --global wakacodex
```

`wakatime-cli` is optional. When available, it is used as a fallback transport. The package prefers a direct HTTPS heartbeat first, which avoids some WSL/Go IPv6 issues seen with `wakatime-cli`.

Enable experimental Codex hooks by editing `~/.codex/config.toml`:

```toml
[features]
codex_hooks = true
```

Then add `~/.codex/hooks.json`:

```json
{
  "hooks": {
    "SessionStart": [
      {
        "matcher": "^(startup|resume|clear)$",
        "hooks": [
          {
            "type": "command",
            "command": "wakacodex",
            "timeout": 5
          }
        ]
      }
    ],
    "Stop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "wakacodex",
            "timeout": 5
          }
        ]
      }
    ]
  }
}
```

You can print the same snippet with:

```bash
wakacodex print-hooks
```

## Behavior

- `SessionStart` sends a heartbeat when Codex starts, resumes, or clears a session.
- `Stop` sends follow-up heartbeats while you keep working.
- Heartbeats are rate-limited to once every `120` seconds per Codex session by default.
- The WakaTime entity is the current workspace directory, sent as entity type `app`.
- The plugin string is `codex wakacodex/<version>`.
- If `wakatime-cli` queues activity offline because the API is temporarily unreachable or rate limited, the plugin still advances its local rate-limit state to avoid noisy repeated retries from every hook.

This keeps the integration low-noise and avoids pretending we have file-level data that the current Codex hook payload does not expose.

## Environment

- `WAKATIME_CLI`
  Use an explicit path to `wakatime-cli`.
- `WAKATIME_CONFIG`
  Use an explicit path to `~/.wakatime.cfg`.
- `WAKATIME_CONFIG_FILE`
  Alternate env var for an explicit WakaTime config path.
- `WAKATIME_CODEX_TRANSPORT`
  `auto`, `api`, or `cli`. Default: `auto`.
- `WAKATIME_CODEX_HEARTBEAT_SECONDS`
  Override the minimum seconds between heartbeats. Default: `120`.
- `WAKATIME_CODEX_CLI_TIMEOUT_MS`
  Timeout for `wakatime-cli`. Default: `5000`.
- `WAKATIME_CODEX_DEBUG=1`
  Print debug logs to stderr.

## Development

Run the tests:

```bash
bun test
```

## Notes

The hook configuration above is based on the Codex hooks engine introduced by OpenAI in PR `#13276` and released in Codex `rust-v0.114.0`. The feature flag and `hooks.json` shape were taken from the upstream Codex source for that release line.

This package currently tracks Codex activity at the workspace/app level because the `SessionStart` and `Stop` hook payloads do not include file-edit details.
