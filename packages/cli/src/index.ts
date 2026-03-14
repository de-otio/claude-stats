#!/usr/bin/env node
import { buildCli } from "./cli/index.js";

const program = await buildCli();
await program.parseAsync(process.argv);
