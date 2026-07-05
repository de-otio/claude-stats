/**
 * Canonical, deterministic (de)serialization for the shard bundle wire form.
 *
 * Everything that gets SIGNED must serialize to the SAME bytes on every machine
 * and every run, or a signature written by one device fails to verify on
 * another. So JSON is emitted with object keys sorted lexicographically and no
 * incidental whitespace — a stable canonical form. `Uint8Array` fields (public
 * keys, wrapped DEKs, salts, signatures, ciphertext) are carried as base64
 * strings; the explicit per-type wire DTOs in `shard.ts` / `manifest.ts` do that
 * mapping so this module only ever sees JSON-safe values.
 *
 * Pure functional core: no IO, no clock, no randomness.
 */

/** base64-encode raw bytes (Node `Buffer`; core runs under Node in CLI + ext). */
export function toBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64");
}

/** Decode a base64 string back to raw bytes. */
export function fromBase64(s: string): Uint8Array {
  return new Uint8Array(Buffer.from(s, "base64"));
}

/** URL-safe base64 (no padding) — for opaque STORED path components (F4). */
export function toBase64Url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}

/** Decode a URL-safe base64 (no padding) string back to raw bytes. */
export function fromBase64Url(s: string): Uint8Array {
  return new Uint8Array(Buffer.from(s, "base64url"));
}

const UTF8 = new TextEncoder();
const UTF8_DEC = new TextDecoder("utf-8", { fatal: false });

/** UTF-8 encode a string. */
export function utf8Encode(s: string): Uint8Array {
  return UTF8.encode(s);
}

/** UTF-8 decode bytes to a string. */
export function utf8Decode(bytes: Uint8Array): string {
  return UTF8_DEC.decode(bytes);
}

/**
 * Deterministic JSON: object keys sorted, arrays preserved in order, no extra
 * whitespace. Rejects non-finite numbers (they would serialize to `null` and
 * silently corrupt a signed payload). `undefined` object properties are dropped
 * exactly as `JSON.stringify` would, so callers must not depend on them.
 */
export function canonicalStringify(value: unknown): string {
  return encode(value);
}

function encode(value: unknown): string {
  if (value === null) return "null";
  const t = typeof value;
  if (t === "number") {
    if (!Number.isFinite(value as number)) {
      throw new Error("canonicalStringify: non-finite number is not serializable");
    }
    return JSON.stringify(value);
  }
  if (t === "string" || t === "boolean") return JSON.stringify(value);
  if (t === "bigint") {
    throw new Error("canonicalStringify: bigint is not serializable");
  }
  if (Array.isArray(value)) {
    return `[${value.map((v) => encode(v === undefined ? null : v)).join(",")}]`;
  }
  if (t === "object") {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj).filter((k) => obj[k] !== undefined).sort();
    const parts = keys.map((k) => `${JSON.stringify(k)}:${encode(obj[k])}`);
    return `{${parts.join(",")}}`;
  }
  // undefined / function / symbol at the top level.
  throw new Error(`canonicalStringify: unsupported value of type ${t}`);
}

/** Canonical-JSON serialize `value` to UTF-8 bytes (the SIGNED representation). */
export function serializeJson(value: unknown): Uint8Array {
  return utf8Encode(canonicalStringify(value));
}

/** Parse UTF-8 JSON bytes back to a value. Throws on malformed input. */
export function deserializeJson<T>(bytes: Uint8Array): T {
  return JSON.parse(utf8Decode(bytes)) as T;
}
