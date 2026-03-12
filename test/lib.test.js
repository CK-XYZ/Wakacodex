'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { version: VERSION } = require('../package.json');

const {
  buildHeartbeatArgs,
  buildDirectHeartbeat,
  buildHooksConfig,
  buildWakaTimeUserAgent,
  countPathSegments,
  getStateFilePath,
  getStateKey,
  getTransportPreference,
  getWakaTimeConfigPath,
  inferProjectName,
  loadWakaTimeSettings,
  normalizeApiUrl,
  parseHookInput,
  parseIniSettings,
  resolveWakaTimeCli,
  shouldPersistStateAfterCli,
  shouldSendHeartbeat,
  updateHeartbeatState,
} = require('../src/lib');

test('parseHookInput accepts SessionStart payloads', () => {
  const input = parseHookInput(
    JSON.stringify({
      cwd: '/tmp/project',
      hook_event_name: 'SessionStart',
      model: 'gpt-5-codex',
      permission_mode: 'workspace-write',
      session_id: 'session-1',
      source: 'startup',
      transcript_path: '/tmp/transcript.jsonl',
    }),
  );

  assert.deepEqual(input, {
    cwd: '/tmp/project',
    hook_event_name: 'SessionStart',
    model: 'gpt-5-codex',
    permission_mode: 'workspace-write',
    session_id: 'session-1',
    source: 'startup',
    stop_hook_active: false,
    last_assistant_message: null,
    transcript_path: '/tmp/transcript.jsonl',
  });
});

test('parseHookInput rejects unsupported events', () => {
  const input = parseHookInput(
    JSON.stringify({
      cwd: '/tmp/project',
      hook_event_name: 'Notification',
      session_id: 'session-1',
    }),
  );

  assert.equal(input, null);
});

test('getStateKey prefers transcript path', () => {
  assert.equal(
    getStateKey({
      session_id: 'session-1',
      transcript_path: '/tmp/transcript.jsonl',
    }),
    'transcript:/tmp/transcript.jsonl',
  );
});

test('shouldSendHeartbeat rate limits repeated events', () => {
  const state = { version: 1, heartbeats: {} };
  const input = {
    cwd: '/tmp/project',
    session_id: 'session-1',
    transcript_path: '/tmp/transcript.jsonl',
  };

  assert.equal(shouldSendHeartbeat(state, input, 1000, 120), true);

  const updated = updateHeartbeatState(state, input, 1000);
  assert.equal(shouldSendHeartbeat(updated, input, 1050, 120), false);
  assert.equal(shouldSendHeartbeat(updated, input, 1121, 120), true);
});

test('buildHeartbeatArgs uses app entity and project folder', () => {
  const args = buildHeartbeatArgs({
    cwd: '/tmp/project',
    session_id: 'session-1',
    transcript_path: '/tmp/transcript.jsonl',
  });

  assert.deepEqual(args, [
    '--entity',
    '/tmp/project',
    '--entity-type',
    'app',
    '--category',
    'ai coding',
    '--plugin',
    `codex wakacodex/${VERSION}`,
    '--project-folder',
    '/tmp/project',
  ]);
});

test('buildHooksConfig stays minimal and silent', () => {
  assert.deepEqual(buildHooksConfig(), {
    hooks: {
      SessionStart: [
        {
          matcher: '^(startup|resume|clear)$',
          hooks: [
            {
              type: 'command',
              command: 'wakacodex',
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
              command: 'wakacodex',
              timeout: 5,
            },
          ],
        },
      ],
    },
  });
});

test('buildDirectHeartbeat matches WakaTime bulk payload shape', () => {
  const [heartbeat] = buildDirectHeartbeat(
    {
      cwd: '/tmp/project',
      session_id: 'session-1',
      transcript_path: null,
    },
    1234,
  );

  assert.equal(heartbeat.entity, '/tmp/project');
  assert.equal(heartbeat.type, 'app');
  assert.equal(heartbeat.category, 'ai coding');
  assert.equal(heartbeat.project, 'project');
  assert.equal(heartbeat.project_root_count, countPathSegments('/tmp/project'));
  assert.equal(heartbeat.time, 1234);
  assert.match(
    heartbeat.user_agent,
    new RegExp(`^wakatime/${VERSION.replaceAll('.', '\\.')} `),
  );
});

test('resolveWakaTimeCli respects explicit env path', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wakacodex-'));
  const binary = path.join(tempDir, process.platform === 'win32' ? 'wakatime-cli.cmd' : 'wakatime-cli');
  fs.writeFileSync(binary, '');
  if (process.platform !== 'win32') {
    fs.chmodSync(binary, 0o755);
  }

  const resolved = resolveWakaTimeCli({ WAKATIME_CLI: binary, PATH: '' });
  assert.equal(resolved, binary);
});

test('getStateFilePath respects WAKATIME_HOME directly', () => {
  assert.equal(
    getStateFilePath({ WAKATIME_HOME: '/tmp/wakatime-home' }),
    path.join('/tmp/wakatime-home', 'wakacodex-state.json'),
  );
});

test('shouldPersistStateAfterCli accepts offline and backoff exits', () => {
  assert.equal(shouldPersistStateAfterCli(0), true);
  assert.equal(shouldPersistStateAfterCli(102), true);
  assert.equal(shouldPersistStateAfterCli(112), true);
  assert.equal(shouldPersistStateAfterCli(104), false);
  assert.equal(shouldPersistStateAfterCli(1), false);
});

test('parseIniSettings reads the settings section', () => {
  assert.deepEqual(
    parseIniSettings('[settings]\napi_key = waka_123\napi_url = https://example.com/api/v1/\n'),
    {
      api_key: 'waka_123',
      api_url: 'https://example.com/api/v1/',
    },
  );
});

test('loadWakaTimeSettings reads from config path', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wakacodex-'));
  const config = path.join(tempDir, '.wakatime.cfg');
  fs.writeFileSync(config, '[settings]\napi_key = waka_123\n');

  assert.deepEqual(loadWakaTimeSettings(config), { api_key: 'waka_123' });
});

test('transport preference defaults to auto', () => {
  assert.equal(getTransportPreference({}), 'auto');
  assert.equal(getTransportPreference({ WAKATIME_CODEX_TRANSPORT: 'api' }), 'api');
  assert.equal(getTransportPreference({ WAKATIME_CODEX_TRANSPORT: 'cli' }), 'cli');
});

test('config path can be overridden', () => {
  assert.equal(getWakaTimeConfigPath({ WAKATIME_CONFIG: '/tmp/custom.cfg' }), '/tmp/custom.cfg');
});

test('api url normalization removes trailing slash', () => {
  assert.equal(normalizeApiUrl('https://example.com/api/v1/'), 'https://example.com/api/v1');
});

test('project helpers infer project metadata', () => {
  assert.equal(inferProjectName('/tmp/project'), 'project');
  assert.equal(countPathSegments('/tmp/project'), 2);
  assert.match(
    buildWakaTimeUserAgent(),
    new RegExp(`^wakatime/${VERSION.replaceAll('.', '\\.')} `),
  );
});
