#!/usr/bin/env node

/**
 * Entry point for the queuectl CLI.
 * This file only bootstraps the CLI program — all logic lives in src/.
 */

'use strict';

const { createProgram } = require('../src/cli/program');

const program = createProgram();
program.parse(process.argv);
