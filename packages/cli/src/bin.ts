#!/usr/bin/env node
import { run } from './cli.js';
import { loadDotEnv } from './env.js';

loadDotEnv();
run(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (e) => {
    process.stderr.write(`${e instanceof Error ? e.stack ?? e.message : String(e)}\n`);
    process.exitCode = 1;
  },
);
