#!/usr/bin/env node

'use strict';

const { main } = require('../src/cli');

main(process.argv).then(
  (code) => {
    process.exitCode = code;
  },
  (error) => {
    if (process.env.WAKATIME_CODEX_DEBUG === '1') {
      const message = error && error.stack ? error.stack : String(error);
      process.stderr.write(`${message}\n`);
    }
    process.exitCode = 1;
  },
);
