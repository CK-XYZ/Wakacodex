'use strict';

const fs = require('node:fs');
const https = require('node:https');
const { spawnSync } = require('node:child_process');

const {
  buildHeartbeatArgs,
  buildDirectHeartbeat,
  buildHooksConfig,
  getCliTimeoutMs,
  getHeartbeatIntervalSeconds,
  getStateFilePath,
  getTransportPreference,
  getWakaTimeConfigPath,
  isDebugEnabled,
  loadState,
  loadWakaTimeSettings,
  normalizeApiUrl,
  parseHookInput,
  resolveWakaTimeCli,
  saveState,
  shouldPersistStateAfterCli,
  shouldSendHeartbeat,
  updateHeartbeatState,
} = require('./lib');

async function main(argv = process.argv) {
  const command = argv[2];
  if (command === 'print-hooks') {
    process.stdout.write(`${JSON.stringify(buildHooksConfig(), null, 2)}\n`);
    return 0;
  }

  if (command === '--help' || command === '-h' || command === 'help') {
    process.stdout.write(helpText());
    return 0;
  }

  const input = parseHookInput(readStdin());
  if (!input) {
    debug('No supported Codex hook payload on stdin, exiting.');
    return 0;
  }

  const wakatimeCli = resolveWakaTimeCli();
  if (!wakatimeCli) {
    debug('wakatime-cli was not found in PATH, exiting without sending a heartbeat.');
    return 0;
  }

  const nowSeconds = Math.floor(Date.now() / 1000);
  const interval = getHeartbeatIntervalSeconds();
  const stateFile = getStateFilePath();
  const state = loadState(stateFile);
  const transport = getTransportPreference();

  if (!shouldSendHeartbeat(state, input, nowSeconds, interval)) {
    debug(`Heartbeat skipped because ${interval}s has not elapsed yet.`);
    return 0;
  }

  const sent = await sendHeartbeat({
    input,
    nowSeconds,
    transport,
  });

  if (!sent) {
    return 0;
  }

  saveState(stateFile, updateHeartbeatState(state, input, nowSeconds), fs);
  return 0;
}

async function sendHeartbeat({ input, nowSeconds, transport }) {
  if (transport === 'api') {
    return sendHeartbeatViaApi(input, nowSeconds);
  }

  if (transport === 'cli') {
    return sendHeartbeatViaCli(input);
  }

  const sentViaApi = await sendHeartbeatViaApi(input, nowSeconds);
  if (sentViaApi) {
    return true;
  }

  return sendHeartbeatViaCli(input);
}

async function sendHeartbeatViaApi(input, nowSeconds) {
  const configPath = getWakaTimeConfigPath();
  const settings = loadWakaTimeSettings(configPath);
  const apiKey = settings.api_key;
  if (!apiKey) {
    debug(`No api_key found in ${configPath}.`);
    return false;
  }

  const apiBaseUrl = normalizeApiUrl(settings.api_url);
  const url = new URL(`${apiBaseUrl}/users/current/heartbeats.bulk`);
  const body = JSON.stringify(buildDirectHeartbeat(input, nowSeconds));

  try {
    const response = await requestJson(url, {
      family: 4,
      method: 'POST',
      timeout: getCliTimeoutMs(),
      headers: {
        Accept: 'application/json',
        Authorization: `Basic ${Buffer.from(`${apiKey}:`).toString('base64')}`,
        'Content-Length': Buffer.byteLength(body),
        'Content-Type': 'application/json',
        'User-Agent': buildDirectHeartbeat(input, nowSeconds)[0].user_agent,
      },
    }, body);

    if (response.statusCode === 201 || response.statusCode === 202) {
      return true;
    }

    debug(
      `direct api heartbeat failed with ${response.statusCode}: ${truncate(response.body, 300)}`,
    );
    return false;
  } catch (error) {
    debug(`direct api heartbeat failed: ${error.message}`);
    return false;
  }
}

function sendHeartbeatViaCli(input) {
  const wakatimeCli = resolveWakaTimeCli();
  if (!wakatimeCli) {
    debug('wakatime-cli was not found in PATH, exiting without sending a heartbeat.');
    return false;
  }

  const result = spawnSync(wakatimeCli, buildHeartbeatArgs(input), {
    encoding: 'utf8',
    timeout: getCliTimeoutMs(),
    windowsHide: true,
  });

  if (result.error) {
    debug(`wakatime-cli failed: ${result.error.message}`);
    return false;
  }

  if (
    typeof result.status === 'number' &&
    !shouldPersistStateAfterCli(result.status)
  ) {
    debug(
      `wakatime-cli exited with ${result.status}${
        result.stderr ? `: ${result.stderr.trim()}` : ''
      }`,
    );
    return false;
  }

  if (result.stderr && result.stderr.trim()) {
    debug(result.stderr.trim());
  }

  return true;
}

function helpText() {
  return [
    'wakacodex',
    '',
    'Minimal WakaTime hook for Codex CLI.',
    '',
    'Usage:',
    '  wakacodex             Read a Codex hook payload from stdin and send a heartbeat.',
    '  wakacodex print-hooks Print a minimal hooks.json snippet for Codex.',
    '',
    'Environment:',
    '  WAKATIME_CODEX_TRANSPORT       auto, api, or cli (default: auto).',
    '  WAKATIME_CLI                    Absolute path to wakatime-cli.',
    '  WAKATIME_CONFIG                 Absolute path to your wakatime config file.',
    '  WAKATIME_CODEX_HEARTBEAT_SECONDS  Minimum seconds between heartbeats (default: 120).',
    '  WAKATIME_CODEX_CLI_TIMEOUT_MS     Timeout for wakatime-cli (default: 5000).',
    '  WAKATIME_CODEX_DEBUG=1            Print debug logs to stderr.',
    '',
  ].join('\n');
}

function requestJson(url, options, body) {
  return new Promise((resolve, reject) => {
    const request = https.request(url, options, (response) => {
      let responseBody = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => {
        responseBody += chunk;
      });
      response.on('end', () => {
        resolve({
          body: responseBody,
          statusCode: response.statusCode || 0,
        });
      });
    });

    request.on('error', reject);
    request.setTimeout(options.timeout, () => {
      request.destroy(new Error(`request timed out after ${options.timeout}ms`));
    });
    request.end(body);
  });
}

function truncate(value, maxLength) {
  if (value.length <= maxLength) {
    return value;
  }
  return `${value.slice(0, maxLength)}...`;
}

function readStdin() {
  try {
    return fs.readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

function debug(message) {
  if (!isDebugEnabled()) {
    return;
  }
  process.stderr.write(`[wakacodex] ${message}\n`);
}

module.exports = {
  helpText,
  main,
  requestJson,
  readStdin,
  sendHeartbeatViaApi,
  sendHeartbeatViaCli,
};
