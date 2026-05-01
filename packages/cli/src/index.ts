#!/usr/bin/env node

// MCP server uses stdio for JSON-RPC — must start before anything writes to stdout
if (process.argv[2] === "mcp") {
  const { startMcpServer } = await import("./mcp/index.js");
  await startMcpServer();
} else {
  const { buildCli } = await import("./cli/index.js");
  const program = await buildCli();
  await program.parseAsync(process.argv);
}
