#!/usr/bin/env node
import { buildCli } from "./cli/index.js";

const program = buildCli();
await program.parseAsync(process.argv);
