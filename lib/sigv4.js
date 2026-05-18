// AWS Signature Version 4 — minimal implementation supporting both
// header-based auth (Authorization header) and query-string auth
// (presigned URLs).
//
// Spec: https://docs.aws.amazon.com/general/latest/gr/sigv4_signing.html
// Validated against AWS's published S3 test vector
// ("Example: GET Object" — examplebucket/test.txt).
//
// Built with node:crypto — no external deps.

import crypto from "node:crypto";

const ALGO       = "AWS4-HMAC-SHA256";
const TERMINATOR = "aws4_request";
const SERVICE    = "s3";

const sha256Hex = (data) =>
  crypto.createHash("sha256").update(data).digest("hex");
const hmac = (key, data) =>
  crypto.createHmac("sha256", key).update(data).digest();

// RFC 3986 URI encoding. encodeURIComponent already does most of this;
// patch up the characters it leaves alone but the spec says to escape.
function uriEncode(str) {
  return encodeURIComponent(str)
    .replace(/!/g,  "%21")
    .replace(/\*/g, "%2A")
    .replace(/'/g,  "%27")
    .replace(/\(/g, "%28")
    .replace(/\)/g, "%29");
}

function canonicalUri(pathname) {
  if (!pathname || pathname === "/") return "/";
  return pathname
    .split("/")
    .map(seg => uriEncode(decodeURIComponent(seg)))
    .join("/");
}

function canonicalQuery(searchParams) {
  if (!searchParams) return "";
  const entries = [];
  for (const [k, v] of searchParams) entries.push([k, v]);
  entries.sort((a, b) => a[0] === b[0] ? (a[1] < b[1] ? -1 : 1) : (a[0] < b[0] ? -1 : 1));
  return entries.map(([k, v]) => `${uriEncode(k)}=${uriEncode(v ?? "")}`).join("&");
}

function canonicalHeaders(headers) {
  const lower = {};
  for (const [k, v] of Object.entries(headers)) {
    if (v == null) continue;
    lower[k.toLowerCase()] = String(v).trim().replace(/\s+/g, " ");
  }
  const keys = Object.keys(lower).sort();
  const canonical = keys.map(k => `${k}:${lower[k]}\n`).join("");
  const signed    = keys.join(";");
  return { canonical, signed };
}

function derivSigningKey(secretAccessKey, dateStamp, region, service) {
  const kDate    = hmac(`AWS4${secretAccessKey}`, dateStamp);
  const kRegion  = hmac(kDate, region);
  const kService = hmac(kRegion, service);
  return hmac(kService, TERMINATOR);
}

function amzTimestamp(d) {
  return d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

// ── header-based signing ──────────────────────────────────────────────
// Returns headers to send (caller headers + Authorization + amz-date +
// content-sha256, plus security-token if STS).
export function signRequest({
  method, url, headers = {}, body = "",
  region, service = SERVICE,
  accessKeyId, secretAccessKey, sessionToken = null,
  nowMs,
}) {
  const u   = new URL(url);
  const now = new Date(nowMs ?? Date.now());
  const amzDate   = amzTimestamp(now);
  const dateStamp = amzDate.slice(0, 8);

  const payloadHash = sha256Hex(body || "");

  const signedHeaders = {
    ...headers,
    host:                   u.host,
    "x-amz-date":           amzDate,
    "x-amz-content-sha256": payloadHash,
  };
  if (sessionToken) signedHeaders["x-amz-security-token"] = sessionToken;

  const { canonical: canonHeaders, signed: signedHeaderList } = canonicalHeaders(signedHeaders);

  const canonicalRequest = [
    method.toUpperCase(),
    canonicalUri(u.pathname),
    canonicalQuery(u.searchParams),
    canonHeaders,
    signedHeaderList,
    payloadHash,
  ].join("\n");

  const credentialScope = `${dateStamp}/${region}/${service}/${TERMINATOR}`;
  const stringToSign = [ALGO, amzDate, credentialScope, sha256Hex(canonicalRequest)].join("\n");

  const kSigning  = derivSigningKey(secretAccessKey, dateStamp, region, service);
  const signature = hmac(kSigning, stringToSign).toString("hex");

  const authorization = [
    `${ALGO} Credential=${accessKeyId}/${credentialScope}`,
    `SignedHeaders=${signedHeaderList}`,
    `Signature=${signature}`,
  ].join(", ");

  return { ...signedHeaders, Authorization: authorization };
}

// ── presigned URL signing ─────────────────────────────────────────────
// Returns a URL with X-Amz-* query params baked in. The caller can use
// it from a browser / curl / IoT device without holding the secret.
//
// Notes:
//   • For presigned URLs, x-amz-content-sha256 is the literal string
//     "UNSIGNED-PAYLOAD" (S3 special-cases this).
//   • Only `host` is in SignedHeaders by default. If you need to enforce
//     specific headers at request time, add them to `headers`.
//   • Max expiry is 7 days (604800s) for SigV4.
export function presignUrl({
  method = "GET", url, headers = {}, expiresIn = 900,
  region, service = SERVICE,
  accessKeyId, secretAccessKey, sessionToken = null,
  nowMs,
}) {
  if (expiresIn < 1 || expiresIn > 604800) {
    throw new Error(`presignUrl: expiresIn must be 1..604800 (got ${expiresIn})`);
  }
  const u   = new URL(url);
  const now = new Date(nowMs ?? Date.now());
  const amzDate   = amzTimestamp(now);
  const dateStamp = amzDate.slice(0, 8);
  const credentialScope = `${dateStamp}/${region}/${service}/${TERMINATOR}`;

  // Sign at minimum `host` (every request has it). Extra headers can be
  // forced via `headers`.
  const signedHeaders = { ...headers, host: u.host };
  const { canonical: canonHeaders, signed: signedHeaderList } = canonicalHeaders(signedHeaders);

  // Add the X-Amz-* query parameters BEFORE building the canonical
  // query string (they participate in the signature).
  u.searchParams.set("X-Amz-Algorithm",     ALGO);
  u.searchParams.set("X-Amz-Credential",    `${accessKeyId}/${credentialScope}`);
  u.searchParams.set("X-Amz-Date",          amzDate);
  u.searchParams.set("X-Amz-Expires",       String(expiresIn));
  u.searchParams.set("X-Amz-SignedHeaders", signedHeaderList);
  if (sessionToken) u.searchParams.set("X-Amz-Security-Token", sessionToken);

  const canonicalRequest = [
    method.toUpperCase(),
    canonicalUri(u.pathname),
    canonicalQuery(u.searchParams),
    canonHeaders,
    signedHeaderList,
    "UNSIGNED-PAYLOAD",
  ].join("\n");

  const stringToSign = [ALGO, amzDate, credentialScope, sha256Hex(canonicalRequest)].join("\n");
  const kSigning     = derivSigningKey(secretAccessKey, dateStamp, region, service);
  const signature    = hmac(kSigning, stringToSign).toString("hex");

  u.searchParams.set("X-Amz-Signature", signature);
  return u.toString();
}
