// AWS S3 client. Region-derived endpoints + signed-fetch wrapper +
// minimal XML helpers. Always uses virtual-host style (the AWS
// recommendation post-2020).

import { signRequest } from "./sigv4.js";

const SERVICE = "s3";

// ── auth ──────────────────────────────────────────────────────────────
export function loadAwsAuth(ctx, configName = "aws-s3", regionOverride) {
  const cfg = ctx?.config?.[configName];
  if (!cfg) {
    throw new Error(
      `AWS S3 config "${configName}" not found in workspace. ` +
      `Add a generic config on the Configurations page with accessKeyId, secretAccessKey, region.`,
    );
  }
  const region          = String(regionOverride || cfg.region || "us-east-1");
  const accessKeyId     = String(cfg.accessKeyId     || "");
  const secretAccessKey = String(cfg.secretAccessKey || "");
  const sessionToken    = cfg.sessionToken   ? String(cfg.sessionToken)   : null;
  const customEndpoint  = cfg.customEndpoint ? String(cfg.customEndpoint).replace(/\/+$/, "") : null;

  if (!accessKeyId || !secretAccessKey) {
    throw new Error(
      `AWS S3 config "${configName}" is missing accessKeyId / secretAccessKey.`,
    );
  }
  return { region, accessKeyId, secretAccessKey, sessionToken, customEndpoint };
}

// ── endpoint derivation ───────────────────────────────────────────────
// AWS S3 endpoint patterns:
//   • us-east-1:        https://s3.amazonaws.com         (legacy, still works)
//                       or https://s3.us-east-1.amazonaws.com (recommended)
//   • other regions:    https://s3.<region>.amazonaws.com
//   • China:            https://s3.<region>.amazonaws.com.cn
//   • GovCloud:         https://s3.<region>.amazonaws.com   (us-gov-west-1, us-gov-east-1)
//
// When a customEndpoint is set (VPC interface endpoint, S3 Transfer
// Acceleration host, AWS PrivateLink, etc.) we use it verbatim.
export function endpointForRegion(auth) {
  if (auth.customEndpoint) return auth.customEndpoint;
  const suffix = auth.region.startsWith("cn-") ? "amazonaws.com.cn" : "amazonaws.com";
  // Use the regional form even for us-east-1 (consistent SigV4 region).
  return `https://s3.${auth.region}.${suffix}`;
}

// ── URL building ──────────────────────────────────────────────────────
// Always virtual-host style. AWS recommends this for new code and
// transfer-accelerated endpoints (s3-accelerate.amazonaws.com) require
// it.
export function buildUrl(auth, { bucket, key, query }) {
  const base = new URL(endpointForRegion(auth));
  if (bucket) {
    // Virtual-host: bucket goes onto the hostname.
    base.hostname = `${bucket}.${base.hostname}`;
    base.pathname = key ? `/${encodeKey(key)}` : "/";
  } else if (key) {
    base.pathname = `/${encodeKey(key)}`;
  }
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (v == null) continue;
      base.searchParams.set(k, String(v));
    }
  }
  return base.toString();
}

function encodeKey(key) {
  return String(key).split("/").map(seg => encodeURIComponent(seg)).join("/");
}

// ── tagging serialization ─────────────────────────────────────────────
// x-amz-tagging is a single header containing URL-encoded query string
// pairs: "key1=value1&key2=value2".
export function encodeTags(tags) {
  if (!tags || typeof tags !== "object") return null;
  const parts = [];
  for (const [k, v] of Object.entries(tags)) {
    parts.push(`${encodeURIComponent(k)}=${encodeURIComponent(String(v ?? ""))}`);
  }
  return parts.length ? parts.join("&") : null;
}

// ── fetch + sign ──────────────────────────────────────────────────────
export async function s3Fetch(auth, { method, url, headers = {}, body = null }, timeoutMs = 30000, signal) {
  const ac    = new AbortController();
  const timer = setTimeout(
    () => ac.abort(new Error(`AWS S3 request timed out after ${timeoutMs}ms`)),
    timeoutMs,
  );
  const onUpstream = () => ac.abort(signal?.reason);
  if (signal) {
    if (signal.aborted) ac.abort(signal.reason);
    else signal.addEventListener("abort", onUpstream, { once: true });
  }

  let bodyBuf;
  if (body == null)               bodyBuf = Buffer.alloc(0);
  else if (Buffer.isBuffer(body)) bodyBuf = body;
  else                             bodyBuf = Buffer.from(String(body));

  const signed = signRequest({
    method, url, headers, body: bodyBuf,
    region:          auth.region,
    service:         SERVICE,
    accessKeyId:     auth.accessKeyId,
    secretAccessKey: auth.secretAccessKey,
    sessionToken:    auth.sessionToken,
  });

  try {
    const res = await fetch(url, {
      method,
      headers: signed,
      body:    method === "GET" || method === "HEAD" ? undefined : bodyBuf,
      signal:  ac.signal,
    });
    const ab  = await res.arrayBuffer();
    const buf = Buffer.from(ab);

    if (!res.ok) {
      const text = buf.toString("utf8");
      const err  = parseS3Error(text) || { Code: `HTTP_${res.status}`, Message: text.slice(0, 500) };
      const e = new Error(`AWS S3 ${method} ${url} failed: ${err.Code}: ${err.Message}`);
      e.status = res.status;
      e.code   = err.Code;
      e.body   = err;
      throw e;
    }

    const hdrs = {};
    for (const [k, v] of res.headers) hdrs[k.toLowerCase()] = v;
    return { status: res.status, headers: hdrs, body: buf };
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener?.("abort", onUpstream);
  }
}

// ── tiny XML helpers ──────────────────────────────────────────────────
const TEXT_RE = (tag) => new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, "i");
const ALL_RE  = (tag) => new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, "gi");

export function xmlText(xml, tag, dflt = null) {
  const m = TEXT_RE(tag).exec(xml || "");
  return m ? decodeXmlEntities(m[1].trim()) : dflt;
}
export function xmlAll(xml, tag) {
  const out = [];
  const re  = ALL_RE(tag);
  let m;
  while ((m = re.exec(xml || ""))) out.push(m[1]);
  return out;
}
function decodeXmlEntities(s) {
  return s.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'");
}
function parseS3Error(xml) {
  if (!xml || !xml.includes("<Error>")) return null;
  return {
    Code:      xmlText(xml, "Code",      "Unknown"),
    Message:   xmlText(xml, "Message",   ""),
    Resource:  xmlText(xml, "Resource",  null),
    RequestId: xmlText(xml, "RequestId", null),
  };
}
