/**
 * Minimal HTTP server using Node's built-in node:http module.
 * No external dependencies required.
 *
 * Security model (see Track A of security overhaul):
 *  - Caller is responsible for binding to 127.0.0.1 only (see CLI `serve` command).
 *  - We enforce a Host-header allowlist to defeat DNS-rebinding attacks.
 *  - Mutating routes (POST /api/config) require a bearer token generated at
 *    startup. The token is delivered to the SPA via an HttpOnly=false,
 *    SameSite=Strict cookie set when the user fetches GET /. Because the
 *    cookie is SameSite=Strict and scoped to the loopback origin, a malicious
 *    cross-origin page cannot cause the browser to attach it, and a DNS-
 *    rebound page served from a different origin cannot read it. Legitimate
 *    same-origin SPA requests carry the cookie automatically.
 */
import http from "node:http";
import crypto from "node:crypto";
import { URL } from "node:url";
import type { Store } from "../store/index.js";
import { buildDashboard } from "../dashboard/index.js";
import type { ReportOptions } from "../reporter/index.js";
import { loadConfig, saveConfig, getPlanConfig, mergeConfig, buildAccountsForConfig, redactConfigForHttp } from "../config.js";
import { readClaudeAccount } from "../account.js";
import { t } from "../i18n.js";

const AUTH_COOKIE_NAME = "claude_stats_token";

export interface StartServerOptions {
  /**
   * Pre-generated auth token (32-byte hex). If omitted a fresh one is
   * generated. Callers that want to display or persist the token should
   * generate it themselves and pass it in.
   */
  token?: string;
}

export interface StartServerResult {
  server: http.Server;
  token: string;
}

function parseOpts(url: URL): ReportOptions {
  const p = url.searchParams;
  // Empty string means "all accounts" — treat as undefined so the dashboard
  // doesn't try to filter by an empty UUID.
  const account = p.get("account");
  return {
    period: (p.get("period") ?? undefined) as ReportOptions["period"],
    projectPath: p.get("project") ?? undefined,
    repoUrl: p.get("repo") ?? undefined,
    accountUuid: account && account.length > 0 ? account : undefined,
    entrypoint: p.get("entrypoint") ?? undefined,
    timezone: p.get("timezone") ?? undefined,
    includeCI: p.get("includeCI") === "true",
  };
}

function sendJson(res: http.ServerResponse, status: number, body: unknown, extraHeaders?: http.OutgoingHttpHeaders): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(payload),
    ...extraHeaders,
  });
  res.end(payload);
}

function sendHtml(res: http.ServerResponse, status: number, body: string, extraHeaders?: http.OutgoingHttpHeaders): void {
  res.writeHead(status, {
    "Content-Type": "text/html; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    // Defense-in-depth alongside output escaping: the dashboard ships inline
    // scripts/styles (so 'unsafe-inline' is required), but constrain network
    // egress to same-origin so an injected handler can't exfiltrate to a remote.
    "Content-Security-Policy":
      "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'self'",
    ...extraHeaders,
  });
  res.end(body);
}

async function tryRenderDashboard(data: unknown): Promise<string> {
  try {
    const mod = await import("./template.js") as {
      renderDashboard: (data: unknown, t?: (key: string, options?: Record<string, unknown>) => string) => string;
    };
    return mod.renderDashboard(data, t);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return `<!DOCTYPE html><html><body><p>Render error: ${msg}</p><pre>${JSON.stringify(data, null, 2)}</pre></body></html>`;
  }
}

/** Max accepted request body. Config payloads are a few KB; cap well above that. */
const MAX_BODY_BYTES = 64 * 1024;

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error("payload too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    req.on("error", reject);
  });
}

/**
 * Validate that the Host header points at loopback. Rejects DNS-rebinding
 * attempts. Accepts: localhost, 127.0.0.1, [::1] — with or without an explicit
 * port. A missing Host header is rejected.
 */
function isHostAllowed(hostHeader: string | undefined): boolean {
  if (!hostHeader) return false;
  // Strip optional port. IPv6 hosts are bracketed: [::1]:9120
  let host: string;
  if (hostHeader.startsWith("[")) {
    const end = hostHeader.indexOf("]");
    if (end === -1) return false;
    host = hostHeader.slice(1, end).toLowerCase();
  } else {
    const colon = hostHeader.lastIndexOf(":");
    host = (colon === -1 ? hostHeader : hostHeader.slice(0, colon)).toLowerCase();
  }
  return host === "localhost" || host === "127.0.0.1" || host === "::1";
}

function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    const k = part.slice(0, eq).trim();
    const v = part.slice(eq + 1).trim();
    if (k) out[k] = decodeURIComponent(v);
  }
  return out;
}

/**
 * Constant-time comparison. Returns false if lengths differ without leaking
 * the length comparison via a timing side-channel on the byte compare.
 */
function safeEqual(a: string, b: string): boolean {
  const aBuf = Buffer.from(a, "utf-8");
  const bBuf = Buffer.from(b, "utf-8");
  if (aBuf.length !== bBuf.length) {
    // Still call timingSafeEqual on equal-length buffers to keep the code
    // path uniform. The length mismatch itself is unavoidable to surface.
    crypto.timingSafeEqual(aBuf, aBuf);
    return false;
  }
  return crypto.timingSafeEqual(aBuf, bBuf);
}

function extractToken(req: http.IncomingMessage): string | null {
  const auth = req.headers["authorization"];
  if (typeof auth === "string" && auth.startsWith("Bearer ")) {
    return auth.slice("Bearer ".length).trim();
  }
  const custom = req.headers["x-claude-stats-token"];
  if (typeof custom === "string" && custom.length > 0) return custom;
  const cookies = parseCookies(req.headers["cookie"]);
  const c = cookies[AUTH_COOKIE_NAME];
  return typeof c === "string" && c.length > 0 ? c : null;
}

/**
 * Create the dashboard HTTP server. The returned server is NOT listening; the
 * caller must invoke `server.listen(port, "127.0.0.1", ...)`. This keeps the
 * bind address correct-by-construction at the call site.
 */
export function startServer(_port: number, store: Store, opts: StartServerOptions = {}): StartServerResult {
  const token = opts.token ?? crypto.randomBytes(32).toString("hex");

  const server = http.createServer((req, res) => {
    void (async () => {
      try {
        if (!isHostAllowed(req.headers.host)) {
          sendJson(res, 403, { error: "forbidden host" });
          return;
        }

        const baseUrl = `http://localhost`;
        const url = new URL(req.url ?? "/", baseUrl);
        const pathname = url.pathname;

        if (req.method === "GET" && pathname === "/") {
          const opts = parseOpts(url);
          const cfg = loadConfig();
          const planCfg = getPlanConfig(cfg);
          if (planCfg && !opts.planFee) opts.planFee = planCfg.monthlyFee;
          if (planCfg && !opts.planType) opts.planType = planCfg.type;
          if (!opts.accountFees) opts.accountFees = cfg.accountFees;
          const data = buildDashboard(store, opts);
          const { attachCostPerTask } = await import("../dashboard/index.js");
          await attachCostPerTask(store, data, opts);
          const html = await tryRenderDashboard(data);
          // Set auth cookie so SPA can authenticate subsequent mutating
          // requests. SameSite=Strict prevents CSRF; Path=/ so same-origin
          // fetch carries it automatically. Not HttpOnly because we want to
          // allow the SPA to also send it as a header if needed.
          const cookie = `${AUTH_COOKIE_NAME}=${token}; Path=/; SameSite=Strict; Max-Age=86400`;
          sendHtml(res, 200, html, { "Set-Cookie": cookie });
          return;
        }

        if (req.method === "GET" && pathname === "/api/dashboard") {
          const opts = parseOpts(url);
          if (!opts.accountFees) opts.accountFees = loadConfig().accountFees;
          const data = buildDashboard(store, opts);
          const { attachCostPerTask } = await import("../dashboard/index.js");
          await attachCostPerTask(store, data, opts);
          sendJson(res, 200, data);
          return;
        }

        if (req.method === "GET" && pathname === "/api/status") {
          const status = store.getStatus();
          sendJson(res, 200, status);
          return;
        }

        if (req.method === "GET" && pathname === "/api/config") {
          // Unauthenticated, localhost-only. Strip secrets (llmJudge.apiKey) and
          // do NOT include account email here (PII on an unauth endpoint).
          const accounts = buildAccountsForConfig(store.listAccounts(), readClaudeAccount(), false);
          sendJson(res, 200, { ...redactConfigForHttp(loadConfig()), accounts });
          return;
        }

        if (req.method === "POST" && pathname === "/api/config") {
          const supplied = extractToken(req);
          if (supplied === null || !safeEqual(supplied, token)) {
            sendJson(res, 401, { error: "unauthorized" });
            return;
          }
          let body: string;
          try {
            body = await readBody(req);
          } catch {
            sendJson(res, 413, { error: "payload too large" });
            return;
          }
          // mergeConfig allow-lists keys, shallow-merges siblings, and validates
          // accountFees (prototype-safe, bounded). Never spread raw input.
          const merged = mergeConfig(loadConfig(), JSON.parse(body));
          saveConfig(merged);
          sendJson(res, 200, { ok: true, config: redactConfigForHttp(merged) });
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

  // NOTE: We intentionally do NOT call server.listen() here. The caller must
  // bind to 127.0.0.1 explicitly. See packages/cli/src/cli/index.ts `serve`.
  return { server, token };
}
