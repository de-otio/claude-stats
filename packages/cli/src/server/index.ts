/**
 * Minimal HTTP server using Node's built-in node:http module.
 * No external dependencies required.
 */
import http from "node:http";
import { URL } from "node:url";
import type { Store } from "../store/index.js";
import { buildDashboard } from "../dashboard/index.js";
import type { ReportOptions } from "../reporter/index.js";
import { loadConfig, saveConfig, getPlanConfig, type Config } from "../config.js";

function parseOpts(url: URL): ReportOptions {
  const p = url.searchParams;
  return {
    period: (p.get("period") ?? undefined) as ReportOptions["period"],
    projectPath: p.get("project") ?? undefined,
    repoUrl: p.get("repo") ?? undefined,
    entrypoint: p.get("entrypoint") ?? undefined,
    timezone: p.get("timezone") ?? undefined,
    includeCI: p.get("includeCI") === "true",
  };
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

function sendHtml(res: http.ServerResponse, status: number, body: string): void {
  res.writeHead(status, {
    "Content-Type": "text/html; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}

async function tryRenderDashboard(data: unknown): Promise<string> {
  try {
    const mod = await import("./template.js") as { renderDashboard: (data: unknown) => string };
    return mod.renderDashboard(data);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return `<!DOCTYPE html><html><body><p>Render error: ${msg}</p><pre>${JSON.stringify(data, null, 2)}</pre></body></html>`;
  }
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    req.on("error", reject);
  });
}

export function startServer(port: number, store: Store): http.Server {
  const server = http.createServer((req, res) => {
    void (async () => {
      try {
        const baseUrl = `http://localhost`;
        const url = new URL(req.url ?? "/", baseUrl);
        const pathname = url.pathname;

        if (req.method === "GET" && pathname === "/") {
          const opts = parseOpts(url);
          const planCfg = getPlanConfig(loadConfig());
          if (planCfg && !opts.planFee) opts.planFee = planCfg.monthlyFee;
          if (planCfg && !opts.planType) opts.planType = planCfg.type;
          const data = buildDashboard(store, opts);
          const html = await tryRenderDashboard(data);
          sendHtml(res, 200, html);
          return;
        }

        if (req.method === "GET" && pathname === "/api/dashboard") {
          const opts = parseOpts(url);
          const data = buildDashboard(store, opts);
          sendJson(res, 200, data);
          return;
        }

        if (req.method === "GET" && pathname === "/api/status") {
          const status = store.getStatus();
          sendJson(res, 200, status);
          return;
        }

        if (req.method === "GET" && pathname === "/api/config") {
          sendJson(res, 200, loadConfig());
          return;
        }

        if (req.method === "POST" && pathname === "/api/config") {
          const body = await readBody(req);
          const incoming = JSON.parse(body) as Config;
          const current = loadConfig();
          // Deep merge nested objects so partial updates don't drop sibling keys
          const merged: Config = {
            ...current,
            ...incoming,
            plan: incoming.plan !== undefined
              ? { ...current.plan, ...incoming.plan }
              : current.plan,
            costThresholds: incoming.costThresholds !== undefined
              ? { ...current.costThresholds, ...incoming.costThresholds }
              : current.costThresholds,
          };
          saveConfig(merged);
          sendJson(res, 200, { ok: true, config: merged });
          return;
        }

        sendJson(res, 404, { error: "not found" });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        try {
          sendJson(res, 500, { error: msg });
        } catch {
          // Response already partially written; nothing more we can do
        }
      }
    })();
  });

  server.listen(port);
  return server;
}
