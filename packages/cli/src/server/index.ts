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
import type { DashboardData } from "../dashboard/index.js";
import type { ReportOptions } from "../reporter/index.js";
import { loadConfig, saveConfig, mergeConfig, buildAccountsForConfig, redactConfigForHttp, ticketProjectKeys } from "../config.js";
import { reextractTicketLinks } from "../repair/ticket-links.js";
import { readClaudeAccount } from "../account.js";
import {
  BackupActionError,
  confirmRecoveryKeySaved,
  disableBackup,
  enrollExistingBackup,
  getBackupStatus,
  setupBackup,
  type MakeKeyStore,
} from "../ux/backup-settings.js";
import { createFileKeyStore } from "../crypto/keystore-file.js";
import { t } from "../i18n.js";
import { escapeHtml } from "./utils.js";

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
  // The domain views' local filters (gui-redesign/02 §2.5). Empty string means
  // "cleared", so it must become undefined rather than being passed through as
  // a filter on the empty key — `?ticket=` would otherwise narrow to sessions
  // attributed to the ticket named "", i.e. none, and render a page of zeroes.
  const blankToUndefined = (v: string | null): string | undefined =>
    v !== null && v.length > 0 ? v : undefined;
  return {
    period: (p.get("period") ?? undefined) as ReportOptions["period"],
    since: p.get("since") ?? undefined,
    until: p.get("until") ?? undefined,
    projectPath: blankToUndefined(p.get("project")),
    ticket: blankToUndefined(p.get("ticket")),
    taskClass: blankToUndefined(p.get("taskClass")),
    repoUrl: p.get("repo") ?? undefined,
    accountUuid: account && account.length > 0 ? account : undefined,
    entrypoint: p.get("entrypoint") ?? undefined,
    timezone: p.get("timezone") ?? undefined,
    // Tri-state: an ABSENT param must be undefined (not false) so it inherits
    // buildDashboard's new default (includeCI ?? true). A bare `=== "true"`
    // would yield false when absent, half-flipping the served dashboard (deleted
    // included but CI excluded) and breaking the Σ byAccount == headline
    // invariant exactly on the HTTP path.
    includeCI: (() => {
      const ci = p.get("includeCI");
      return ci === "true" ? true : ci === "false" ? false : undefined;
    })(),
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
    // sec#2: HTML-escape both the error message and the JSON payload so that
    // attacker-controlled string values (e.g., a session title containing
    // </pre><script>…</script>) cannot break out of the <pre> block.
    const safeMsg = escapeHtml(msg);
    const safeJson = escapeHtml(JSON.stringify(data, null, 2));
    return `<!DOCTYPE html><html><body><p>Render error: ${safeMsg}</p><pre>${safeJson}</pre></body></html>`;
  }
}

/**
 * Strip PII and raw rate-limit/billing/seat fields from dashboard data before
 * sending it on the unauthenticated HTTP path (GET / and GET /api/dashboard).
 *
 * Specifically:
 *  - availableAccounts[].emailAddress → null  (sec#1 email leak)
 *  - planUtilization.byAccount[].emailAddress → null  (sec#1)
 *  - availableAccounts[].subscriptionType, rateLimitTier, billingType,
 *    seatTier are NOT present on DashboardData (those live in AccountRecord).
 *    The raw `subscriptionType` field on availableAccounts is kept since it is
 *    derived data already present in the template's account selector label;
 *    raw rate-limit / billing / seat fields are not present here.
 *
 * The VS Code panel path (panel.ts) is authenticated and keeps full data.
 */
export function redactDashboardForHttp(data: DashboardData): DashboardData {
  return {
    ...data,
    availableAccounts: data.availableAccounts.map((a) => ({
      ...a,
      emailAddress: null,
    })),
    planUtilization: data.planUtilization
      ? {
          ...data.planUtilization,
          byAccount: data.planUtilization.byAccount.map((ba) => ({
            ...ba,
            emailAddress: null,
          })),
        }
      : null,
  };
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
 * The served dashboard's keystore: the headless `0600`-file fallback, sealed
 * under the recovery secret in play for the action (see `crypto/keystore-file.ts`
 * for the security trade-off vs an OS keychain — F6).
 */
const makeServerKeyStore: MakeKeyStore = (recoverySecret) => createFileKeyStore({ recoverySecret });

/**
 * `/api/backup/*` — the Settings tab's Backup & Sync section (browser host).
 * Thin JSON adapters over `ux/backup-settings.ts`; the VS Code panel drives
 * the SAME actions over webview messages. Caller has already authenticated.
 */
async function handleBackupRoute(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  pathname: string,
): Promise<void> {
  const action = pathname.slice("/api/backup/".length);

  if (req.method === "GET" && action === "status") {
    sendJson(res, 200, getBackupStatus());
    return;
  }

  if (req.method !== "POST") {
    sendJson(res, 404, { error: "not found" });
    return;
  }

  let raw: string;
  try {
    raw = await readBody(req);
  } catch {
    sendJson(res, 413, { error: "payload too large" });
    return;
  }
  let body: Record<string, unknown> = {};
  try {
    if (raw.length > 0) body = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    sendJson(res, 400, { error: "invalid json" });
    return;
  }

  try {
    switch (action) {
      case "setup": {
        const mode = body.mode === "plaintext" ? "plaintext" : "encrypted";
        const result = await setupBackup({
          target: body.target as string,
          mode,
          makeKeyStore: makeServerKeyStore,
        });
        // The recovery key crosses loopback ONCE here (same trust plane as the
        // auth token) and is never persisted or logged server-side.
        sendJson(res, 200, { ok: true, ...result });
        return;
      }
      case "enroll": {
        await enrollExistingBackup({
          target: body.target as string,
          recoveryKey: typeof body.recoveryKey === "string" ? body.recoveryKey : "",
          makeKeyStore: makeServerKeyStore,
        });
        sendJson(res, 200, { ok: true });
        return;
      }
      case "confirm-key": {
        confirmRecoveryKeySaved();
        sendJson(res, 200, { ok: true });
        return;
      }
      case "disable": {
        disableBackup();
        sendJson(res, 200, { ok: true });
        return;
      }
      default:
        sendJson(res, 404, { error: "not found" });
        return;
    }
  } catch (err) {
    if (err instanceof BackupActionError) {
      // The code is the contract; the client maps it to localized copy.
      sendJson(res, 400, { error: err.code });
      return;
    }
    throw err;
  }
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
          // Per-account subscriptions are the source of truth: buildDashboard
          // sums each in-scope account's fee (from accountFees, by type) for the
          // headline plan fee and budget. We deliberately do NOT seed a single
          // global planFee/planType here — that would override the per-account
          // split when two accounts hold different plans.
          if (!opts.accountFees) opts.accountFees = cfg.accountFees;
          const data = buildDashboard(store, opts);
          const { attachCostPerTask, attachInsights, attachTicketAttribution } = await import("../dashboard/index.js");
          await attachCostPerTask(store, data, opts);
          attachInsights(store, data, opts, cfg);
          attachTicketAttribution(store, data);
          // sec#1 / sec#8: strip email and raw tier/billing/seat from unauth path.
          const html = await tryRenderDashboard(redactDashboardForHttp(data));
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
          const apiCfg = loadConfig();
          if (!opts.accountFees) opts.accountFees = apiCfg.accountFees;
          const data = buildDashboard(store, opts);
          const { attachCostPerTask, attachInsights, attachTicketAttribution } = await import("../dashboard/index.js");
          await attachCostPerTask(store, data, opts);
          attachInsights(store, data, opts, apiCfg);
          attachTicketAttribution(store, data);
          // sec#1 / sec#8: strip email and raw tier/billing/seat from unauth path.
          sendJson(res, 200, redactDashboardForHttp(data));
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
          // Pass listAccountsFull() so buildAccountsForConfig can derive a richer
          // planLabel from the tier/subscription data in the accounts table.
          const accounts = buildAccountsForConfig(
            store.listAccounts(),
            readClaudeAccount(),
            false,
            store.listAccountsFull(),
          );
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

        if (req.method === "POST" && pathname === "/api/tickets/reextract") {
          // Token-gated like POST /api/config, and for a stronger reason: this
          // one DELETES rows. The same origin/cookie rules apply — see the
          // security model at the top of this file.
          const supplied = extractToken(req);
          if (supplied === null || !safeEqual(supplied, token)) {
            sendJson(res, 401, { error: "unauthorized" });
            return;
          }
          let dryRun = false;
          try {
            const body = await readBody(req);
            // An unparseable or absent body means "no options", not "run the
            // destructive variant" — the default has to be the safe one.
            dryRun = body.length > 0 ? JSON.parse(body).dryRun === true : false;
          } catch {
            sendJson(res, 400, { error: "bad request" });
            return;
          }
          // Reads the allowlist at call time rather than taking it from the
          // request: the client just saved it through POST /api/config, and the
          // config file is the authority on what is configured. A key sent in
          // this body would let the two disagree — and would let an attacker who
          // got past the token rewrite attribution without touching the config.
          const summary = reextractTicketLinks(
            store,
            { dryRun, allowlist: ticketProjectKeys(loadConfig()) },
            Date.now,
          );
          sendJson(res, 200, summary);
          return;
        }

        if (pathname.startsWith("/api/backup/")) {
          // Every backup route — including the GET — is token-gated: status
          // reveals filesystem layout (cloud roots under $HOME), setup returns
          // a recovery key, and the rest mutate config/manifest. The SPA holds
          // the token via the SameSite=Strict cookie set on GET /.
          const supplied = extractToken(req);
          if (supplied === null || !safeEqual(supplied, token)) {
            sendJson(res, 401, { error: "unauthorized" });
            return;
          }
          await handleBackupRoute(req, res, pathname);
          return;
        }

        sendJson(res, 404, { error: "not found" });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        try {
          // periodRange (invoked from buildDashboard) throws RangeError for a
          // malformed/invalid since/until pair (missing partner, unparsable
          // calendar date, since after until). Surface that as a client error
          // (400) rather than a 500 — the request, not the server, is at fault
          // — and fail closed: no dashboard is rendered/returned for it.
          if (err instanceof RangeError) {
            sendJson(res, 400, { error: msg });
          } else {
            sendJson(res, 500, { error: msg });
          }
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
