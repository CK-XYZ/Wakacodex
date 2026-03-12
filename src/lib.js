'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { version: VERSION } = require('../package.json');

const DEFAULT_HEARTBEAT_SECONDS = 120;
const DEFAULT_CLI_TIMEOUT_MS = 5000;
const DEFAULT_API_URL = 'https://api.wakatime.com/api/v1';
const WAKATIME_EXIT_SUCCESS = 0;
const WAKATIME_EXIT_API = 102;
const WAKATIME_EXIT_BACKOFF = 112;
const MAX_STATE_ENTRIES = 200;
const STATE_RETENTION_SECONDS = 60 * 60 * 24 * 30;
const STATE_FILE_NAME = 'wakacodex-state.json';
const SUPPORTED_EVENTS = new Set(['SessionStart', 'Stop']);

function parseHookInput(raw) {
  if (!raw || !raw.trim()) {
    return null;
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }

  if (!parsed || typeof parsed !== 'object') {
    return null;
  }

  if (!SUPPORTED_EVENTS.has(parsed.hook_event_name)) {
    return null;
  }

  if (typeof parsed.cwd !== 'string' || typeof parsed.session_id !== 'string') {
    return null;
  }

  return {
    cwd: parsed.cwd,
    hook_event_name: parsed.hook_event_name,
    model: typeof parsed.model === 'string' ? parsed.model : '',
    permission_mode:
      typeof parsed.permission_mode === 'string' ? parsed.permission_mode : '',
    session_id: parsed.session_id,
    source: typeof parsed.source === 'string' ? parsed.source : null,
    stop_hook_active: parsed.stop_hook_active === true,
    last_assistant_message:
      typeof parsed.last_assistant_message === 'string'
        ? parsed.last_assistant_message
        : null,
    transcript_path:
      typeof parsed.transcript_path === 'string' && parsed.transcript_path.trim()
        ? parsed.transcript_path
        : null,
  };
}

function getStateKey(input) {
  if (input.transcript_path) {
    return `transcript:${input.transcript_path}`;
  }
  return `session:${input.session_id}`;
}

function getHomeDirectory(env = process.env) {
  if (typeof env.HOME === 'string' && env.HOME.trim()) {
    return env.HOME.trim();
  }

  if (typeof env.USERPROFILE === 'string' && env.USERPROFILE.trim()) {
    return env.USERPROFILE.trim();
  }

  return os.homedir() || os.tmpdir();
}

function getStateFilePath(env = process.env) {
  if (typeof env.WAKATIME_HOME === 'string' && env.WAKATIME_HOME.trim()) {
    return path.join(env.WAKATIME_HOME.trim(), STATE_FILE_NAME);
  }

  return path.join(getHomeDirectory(env), '.wakatime', STATE_FILE_NAME);
}

function getWakaTimeConfigPath(env = process.env) {
  if (typeof env.WAKATIME_CONFIG === 'string' && env.WAKATIME_CONFIG.trim()) {
    return env.WAKATIME_CONFIG.trim();
  }

  if (typeof env.WAKATIME_CONFIG_FILE === 'string' && env.WAKATIME_CONFIG_FILE.trim()) {
    return env.WAKATIME_CONFIG_FILE.trim();
  }

  return path.join(getHomeDirectory(env), '.wakatime.cfg');
}

function loadState(filePath, reader = fs) {
  try {
    const raw = reader.readFileSync(filePath, 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') {
      return createEmptyState();
    }
    return {
      version: parsed.version === 1 ? 1 : 1,
      heartbeats:
        parsed.heartbeats && typeof parsed.heartbeats === 'object'
          ? parsed.heartbeats
          : {},
    };
  } catch {
    return createEmptyState();
  }
}

function createEmptyState() {
  return {
    version: 1,
    heartbeats: {},
  };
}

function shouldSendHeartbeat(state, input, nowSeconds, minHeartbeatSeconds) {
  const key = getStateKey(input);
  const previous = state.heartbeats[key];
  if (!previous || typeof previous.lastHeartbeatAt !== 'number') {
    return true;
  }

  return nowSeconds - previous.lastHeartbeatAt >= minHeartbeatSeconds;
}

function updateHeartbeatState(state, input, nowSeconds) {
  const next = {
    version: 1,
    heartbeats: {
      ...state.heartbeats,
      [getStateKey(input)]: {
        cwd: input.cwd,
        lastHeartbeatAt: nowSeconds,
        sessionId: input.session_id,
        transcriptPath: input.transcript_path,
      },
    },
  };

  return pruneState(next, nowSeconds);
}

function pruneState(state, nowSeconds) {
  const entries = Object.entries(state.heartbeats)
    .filter(([, value]) => {
      return (
        value &&
        typeof value === 'object' &&
        typeof value.lastHeartbeatAt === 'number' &&
        nowSeconds - value.lastHeartbeatAt <= STATE_RETENTION_SECONDS
      );
    })
    .sort(([, left], [, right]) => right.lastHeartbeatAt - left.lastHeartbeatAt)
    .slice(0, MAX_STATE_ENTRIES);

  return {
    version: 1,
    heartbeats: Object.fromEntries(entries),
  };
}

function saveState(filePath, state, writer = fs) {
  const directory = path.dirname(filePath);
  writer.mkdirSync(directory, { recursive: true });
  writer.writeFileSync(filePath, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
}

function buildHeartbeatArgs(input) {
  const entity = input.cwd || input.transcript_path || process.cwd();
  const args = [
    '--entity',
    entity,
    '--entity-type',
    'app',
    '--category',
    'ai coding',
    '--plugin',
    buildPluginName(),
  ];

  if (input.cwd) {
    args.push('--project-folder', input.cwd);
  }

  return args;
}

function buildDirectHeartbeat(input, nowSeconds) {
  const entity = input.cwd || input.transcript_path || process.cwd();
  return [
    {
      category: 'ai coding',
      entity,
      project: inferProjectName(entity),
      project_root_count: countPathSegments(entity),
      time: nowSeconds,
      type: 'app',
      user_agent: buildWakaTimeUserAgent(),
    },
  ];
}

function buildPluginName() {
  return `codex wakacodex/${VERSION}`;
}

function buildWakaTimeUserAgent() {
  return `wakatime/${VERSION} (${process.platform}-${os.release()}-${process.arch}) node/${process.versions.node} ${buildPluginName()}`;
}

function buildHooksConfig(command = 'wakacodex') {
  return {
    hooks: {
      SessionStart: [
        {
          matcher: '^(startup|resume|clear)$',
          hooks: [
            {
              type: 'command',
              command,
              timeout: 5,
            },
          ],
        },
      ],
      Stop: [
        {
          hooks: [
            {
              type: 'command',
              command,
              timeout: 5,
            },
          ],
        },
      ],
    },
  };
}

function resolveWakaTimeCli(env = process.env, exists = fs.existsSync, access = fs.accessSync) {
  const explicit = resolveExplicitCli(env.WAKATIME_CLI, exists, access);
  if (explicit) {
    return explicit;
  }

  const pathValue = typeof env.PATH === 'string' ? env.PATH : '';
  if (!pathValue) {
    return null;
  }

  const directories = pathValue.split(path.delimiter).filter(Boolean);
  const names = process.platform === 'win32'
    ? [
        'wakatime-cli.exe',
        'wakatime-cli.cmd',
        'wakatime-cli.bat',
        'wakatime-cli',
        'wakatime.exe',
        'wakatime.cmd',
        'wakatime.bat',
        'wakatime',
      ]
    : ['wakatime-cli', 'wakatime'];

  for (const directory of directories) {
    for (const name of names) {
      const candidate = path.join(directory, name);
      if (!exists(candidate)) {
        continue;
      }

      if (process.platform !== 'win32') {
        try {
          access(candidate, fs.constants.X_OK);
        } catch {
          continue;
        }
      }

      return candidate;
    }
  }

  return null;
}

function resolveExplicitCli(value, exists = fs.existsSync, access = fs.accessSync) {
  if (typeof value !== 'string' || !value.trim()) {
    return null;
  }

  const candidate = value.trim();
  if (!exists(candidate)) {
    return null;
  }

  if (process.platform !== 'win32') {
    try {
      access(candidate, fs.constants.X_OK);
    } catch {
      return null;
    }
  }

  return candidate;
}

function getHeartbeatIntervalSeconds(env = process.env) {
  return parsePositiveInteger(
    env.WAKATIME_CODEX_HEARTBEAT_SECONDS,
    DEFAULT_HEARTBEAT_SECONDS,
  );
}

function getCliTimeoutMs(env = process.env) {
  return parsePositiveInteger(env.WAKATIME_CODEX_CLI_TIMEOUT_MS, DEFAULT_CLI_TIMEOUT_MS);
}

function parsePositiveInteger(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  if (Number.isFinite(parsed) && parsed > 0) {
    return parsed;
  }
  return fallback;
}

function loadWakaTimeSettings(filePath, reader = fs) {
  try {
    const raw = reader.readFileSync(filePath, 'utf8');
    return parseIniSettings(raw);
  } catch {
    return {};
  }
}

function parseIniSettings(raw) {
  let currentSection = '';
  const settings = {};

  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith(';') || trimmed.startsWith('#')) {
      continue;
    }

    if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
      currentSection = trimmed.slice(1, -1).trim().toLowerCase();
      continue;
    }

    const separatorIndex = line.indexOf('=');
    if (separatorIndex === -1 || currentSection !== 'settings') {
      continue;
    }

    const key = line.slice(0, separatorIndex).trim().toLowerCase();
    const value = line.slice(separatorIndex + 1).trim();
    if (key) {
      settings[key] = value;
    }
  }

  return settings;
}

function normalizeApiUrl(value) {
  const apiUrl = (typeof value === 'string' && value.trim()) || DEFAULT_API_URL;
  return apiUrl.endsWith('/') ? apiUrl.slice(0, -1) : apiUrl;
}

function inferProjectName(entity) {
  const resolved = path.resolve(entity);
  const base = path.basename(resolved);
  if (base && base !== path.sep) {
    return base;
  }
  return resolved;
}

function countPathSegments(entity) {
  return path.resolve(entity).split(path.sep).filter(Boolean).length;
}

function getTransportPreference(env = process.env) {
  const value = typeof env.WAKATIME_CODEX_TRANSPORT === 'string'
    ? env.WAKATIME_CODEX_TRANSPORT.trim().toLowerCase()
    : 'auto';

  if (value === 'api' || value === 'cli' || value === 'auto') {
    return value;
  }

  return 'auto';
}

function shouldPersistStateAfterCli(status) {
  return (
    status === WAKATIME_EXIT_SUCCESS ||
    status === WAKATIME_EXIT_API ||
    status === WAKATIME_EXIT_BACKOFF
  );
}

function isDebugEnabled(env = process.env) {
  return env.WAKATIME_CODEX_DEBUG === '1';
}

module.exports = {
  VERSION,
  buildHeartbeatArgs,
  buildDirectHeartbeat,
  buildHooksConfig,
  buildPluginName,
  buildWakaTimeUserAgent,
  countPathSegments,
  createEmptyState,
  getCliTimeoutMs,
  getHeartbeatIntervalSeconds,
  getHomeDirectory,
  getStateFilePath,
  getStateKey,
  getTransportPreference,
  getWakaTimeConfigPath,
  inferProjectName,
  isDebugEnabled,
  loadState,
  loadWakaTimeSettings,
  normalizeApiUrl,
  parseHookInput,
  parseIniSettings,
  pruneState,
  resolveWakaTimeCli,
  saveState,
  shouldPersistStateAfterCli,
  shouldSendHeartbeat,
  updateHeartbeatState,
};
