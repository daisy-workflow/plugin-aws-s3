// Operation handlers for the aws-s3 plugin. Same shape as the generic
// s3 plugin, plus AWS-specific extras: storage class, server-side
// encryption (KMS), object tags, requester pays, presigned URLs, and
// bucket location.

import { buildUrl, s3Fetch, xmlText, xmlAll, encodeTags, endpointForRegion } from "./client.js";
import { presignUrl } from "./sigv4.js";

// ── shared header helpers ─────────────────────────────────────────────
// Apply optional AWS-specific upload headers to a header bag.
function applyUploadExtras(headers, input) {
  const { acl, storageClass, serverSideEncryption, ssekmsKeyId, tags, requesterPays, metadata } = input || {};
  if (acl)                  headers["x-amz-acl"]                                = acl;
  if (storageClass)         headers["x-amz-storage-class"]                      = storageClass;
  if (serverSideEncryption) headers["x-amz-server-side-encryption"]             = serverSideEncryption;
  if (ssekmsKeyId)          headers["x-amz-server-side-encryption-aws-kms-key-id"] = ssekmsKeyId;
  if (requesterPays === true) headers["x-amz-request-payer"]                    = "requester";
  const tagging = encodeTags(tags);
  if (tagging)              headers["x-amz-tagging"]                            = tagging;
  if (metadata && typeof metadata === "object") {
    for (const [k, v] of Object.entries(metadata)) {
      headers[`x-amz-meta-${k.toLowerCase()}`] = String(v);
    }
  }
}

// ── bucket.getAll ─────────────────────────────────────────────────────
export async function bucketGetAll(auth, input, signal) {
  const { timeoutMs = 30000 } = input || {};
  const url = buildUrl(auth, {});
  const { status, body } = await s3Fetch(auth, { method: "GET", url }, timeoutMs, signal);
  const xml = body.toString("utf8");
  const buckets = xmlAll(xml, "Bucket").map(b => ({
    name:         xmlText(b, "Name"),
    creationDate: xmlText(b, "CreationDate"),
  }));
  return {
    status,
    result: { owner: { id: xmlText(xml, "ID"), displayName: xmlText(xml, "DisplayName") }, buckets, count: buckets.length },
    url,
  };
}

// ── bucket.create ─────────────────────────────────────────────────────
export async function bucketCreate(auth, input, signal) {
  const { bucket, acl, timeoutMs = 30000 } = input || {};
  if (!bucket) throw new Error("operation=bucket.create requires bucket");

  let body = "";
  if (auth.region && auth.region !== "us-east-1") {
    body =
      `<?xml version="1.0" encoding="UTF-8"?>` +
      `<CreateBucketConfiguration xmlns="http://s3.amazonaws.com/doc/2006-03-01/">` +
        `<LocationConstraint>${auth.region}</LocationConstraint>` +
      `</CreateBucketConfiguration>`;
  }
  const headers = { "Content-Type": "application/xml" };
  if (acl) headers["x-amz-acl"] = acl;

  const url = buildUrl(auth, { bucket });
  const { status } = await s3Fetch(auth, { method: "PUT", url, headers, body }, timeoutMs, signal);
  return { status, result: { bucket, created: true, region: auth.region }, url };
}

// ── bucket.delete ─────────────────────────────────────────────────────
export async function bucketDelete(auth, input, signal) {
  const { bucket, timeoutMs = 30000 } = input || {};
  if (!bucket) throw new Error("operation=bucket.delete requires bucket");
  const url = buildUrl(auth, { bucket });
  const { status } = await s3Fetch(auth, { method: "DELETE", url }, timeoutMs, signal);
  return { status, result: { bucket, deleted: true }, url };
}

// ── bucket.search ─────────────────────────────────────────────────────
export async function bucketSearch(auth, input, signal) {
  return fileGetAll(auth, input, signal);
}

// ── bucket.location ───────────────────────────────────────────────────
// GET /<bucket>?location  → LocationConstraint
// AWS quirk: us-east-1 returns an empty <LocationConstraint/>.
export async function bucketLocation(auth, input, signal) {
  const { bucket, timeoutMs = 30000 } = input || {};
  if (!bucket) throw new Error("operation=bucket.location requires bucket");
  const url = buildUrl(auth, { bucket, query: { location: "" } });
  const { status, body } = await s3Fetch(auth, { method: "GET", url }, timeoutMs, signal);
  const xml = body.toString("utf8");
  const loc = xmlText(xml, "LocationConstraint", "") || "us-east-1";
  return { status, result: { bucket, location: loc }, url };
}

// ── file.getAll ───────────────────────────────────────────────────────
export async function fileGetAll(auth, input, signal) {
  const { bucket, prefix, maxKeys = 1000, continuationToken, requesterPays, timeoutMs = 30000 } = input || {};
  if (!bucket) throw new Error("operation=file.getAll requires bucket");

  const query = { "list-type": "2", "max-keys": String(Math.min(1000, Math.max(1, Number(maxKeys) || 1000))) };
  if (prefix)            query.prefix              = prefix;
  if (continuationToken) query["continuation-token"] = continuationToken;

  const headers = {};
  if (requesterPays === true) headers["x-amz-request-payer"] = "requester";

  const url = buildUrl(auth, { bucket, query });
  const { status, body } = await s3Fetch(auth, { method: "GET", url, headers }, timeoutMs, signal);
  const xml = body.toString("utf8");

  const objects = xmlAll(xml, "Contents").map(c => ({
    key:          xmlText(c, "Key"),
    lastModified: xmlText(c, "LastModified"),
    etag:         (xmlText(c, "ETag") || "").replace(/^"|"$/g, ""),
    size:         Number(xmlText(c, "Size") || 0),
    storageClass: xmlText(c, "StorageClass"),
  }));

  return {
    status,
    result: {
      bucket,
      prefix:                prefix || null,
      isTruncated:           xmlText(xml, "IsTruncated") === "true",
      nextContinuationToken: xmlText(xml, "NextContinuationToken"),
      keyCount:              Number(xmlText(xml, "KeyCount") || objects.length),
      objects,
    },
    url,
  };
}

// ── file.head ─────────────────────────────────────────────────────────
// Fetch only metadata (HEAD, no body). Useful to test existence /
// inspect storage class / SSE without paying transfer.
export async function fileHead(auth, input, signal) {
  const { bucket, key, requesterPays, timeoutMs = 30000 } = input || {};
  if (!bucket) throw new Error("operation=file.head requires bucket");
  if (!key)    throw new Error("operation=file.head requires key");

  const headers = {};
  if (requesterPays === true) headers["x-amz-request-payer"] = "requester";

  const url = buildUrl(auth, { bucket, key });
  const { status, headers: h } = await s3Fetch(auth, { method: "HEAD", url, headers }, timeoutMs, signal);
  return {
    status,
    result: {
      bucket, key,
      contentType:          h["content-type"]                  || null,
      contentLength:        Number(h["content-length"]         || 0),
      etag:                 (h.etag || "").replace(/^"|"$/g, ""),
      lastModified:         h["last-modified"]                 || null,
      versionId:            h["x-amz-version-id"]              || null,
      storageClass:         h["x-amz-storage-class"]           || "STANDARD",
      serverSideEncryption: h["x-amz-server-side-encryption"]  || null,
      ssekmsKeyId:          h["x-amz-server-side-encryption-aws-kms-key-id"] || null,
      metadata: Object.fromEntries(
        Object.entries(h).filter(([k]) => k.startsWith("x-amz-meta-")).map(([k, v]) => [k.replace("x-amz-meta-", ""), v]),
      ),
    },
    url,
  };
}

// ── file.upload ───────────────────────────────────────────────────────
export async function fileUpload(auth, input, signal) {
  const { bucket, key, body = "", bodyEncoding = "utf8", contentType, timeoutMs = 60000 } = input || {};
  if (!bucket) throw new Error("operation=file.upload requires bucket");
  if (!key)    throw new Error("operation=file.upload requires key");

  const buf = bodyEncoding === "base64"
    ? Buffer.from(String(body), "base64")
    : Buffer.from(String(body), "utf8");

  const headers = {
    "Content-Type":   contentType || (bodyEncoding === "base64" ? "application/octet-stream" : "text/plain; charset=utf-8"),
    "Content-Length": String(buf.length),
  };
  applyUploadExtras(headers, input);

  const url = buildUrl(auth, { bucket, key });
  const { status, headers: rHdrs } = await s3Fetch(
    auth, { method: "PUT", url, headers, body: buf }, timeoutMs, signal,
  );
  return {
    status,
    result: {
      bucket, key,
      size:                 buf.length,
      etag:                 (rHdrs.etag || "").replace(/^"|"$/g, ""),
      versionId:            rHdrs["x-amz-version-id"]             || null,
      serverSideEncryption: rHdrs["x-amz-server-side-encryption"] || null,
      ssekmsKeyId:          rHdrs["x-amz-server-side-encryption-aws-kms-key-id"] || null,
    },
    url,
  };
}

// ── file.download ─────────────────────────────────────────────────────
export async function fileDownload(auth, input, signal) {
  const { bucket, key, responseEncoding = "base64", requesterPays, timeoutMs = 60000 } = input || {};
  if (!bucket) throw new Error("operation=file.download requires bucket");
  if (!key)    throw new Error("operation=file.download requires key");

  const headers = {};
  if (requesterPays === true) headers["x-amz-request-payer"] = "requester";

  const url = buildUrl(auth, { bucket, key });
  const { status, headers: h, body } = await s3Fetch(auth, { method: "GET", url, headers }, timeoutMs, signal);

  const data = responseEncoding === "utf8" ? body.toString("utf8") : body.toString("base64");
  return {
    status,
    result: {
      bucket, key,
      contentType:   h["content-type"]   || null,
      contentLength: Number(h["content-length"] || body.length),
      etag:          (h.etag || "").replace(/^"|"$/g, ""),
      lastModified:  h["last-modified"]  || null,
      versionId:     h["x-amz-version-id"] || null,
      encoding:      responseEncoding,
      data,
    },
    url,
  };
}

// ── file.copy ─────────────────────────────────────────────────────────
export async function fileCopy(auth, input, signal) {
  const { bucket, key, copySource, timeoutMs = 30000 } = input || {};
  if (!bucket)     throw new Error("operation=file.copy requires bucket");
  if (!key)        throw new Error("operation=file.copy requires key (destination)");
  if (!copySource) throw new Error("operation=file.copy requires copySource ('srcBucket/srcKey')");

  const url = buildUrl(auth, { bucket, key });
  const headers = {
    "x-amz-copy-source": "/" + String(copySource).split("/").map((s, i) => i === 0 ? encodeURIComponent(s) : s).join("/"),
  };
  // Copy also accepts the AWS-specific extras for the destination object.
  applyUploadExtras(headers, input);

  const { status, body } = await s3Fetch(auth, { method: "PUT", url, headers }, timeoutMs, signal);
  const xml = body.toString("utf8");
  return {
    status,
    result: {
      bucket, key, copySource,
      etag:         (xmlText(xml, "ETag") || "").replace(/^"|"$/g, ""),
      lastModified: xmlText(xml, "LastModified"),
    },
    url,
  };
}

// ── file.delete ───────────────────────────────────────────────────────
export async function fileDelete(auth, input, signal) {
  const { bucket, key, timeoutMs = 30000 } = input || {};
  if (!bucket) throw new Error("operation=file.delete requires bucket");
  if (!key)    throw new Error("operation=file.delete requires key");
  const url = buildUrl(auth, { bucket, key });
  const { status, headers } = await s3Fetch(auth, { method: "DELETE", url }, timeoutMs, signal);
  return { status, result: { bucket, key, deleted: true, versionId: headers["x-amz-version-id"] || null }, url };
}

// ── file.presignedUrl ─────────────────────────────────────────────────
// Generate a presigned URL that a browser / curl / IoT device can use
// without holding AWS credentials. No HTTP call is made — this is pure
// crypto.
export async function filePresignedUrl(auth, input, _signal) {
  const { bucket, key, presignedMethod = "GET", presignedExpiresIn = 900 } = input || {};
  if (!bucket) throw new Error("operation=file.presignedUrl requires bucket");
  if (!key)    throw new Error("operation=file.presignedUrl requires key");

  const url = buildUrl(auth, { bucket, key });
  const signed = presignUrl({
    method:          presignedMethod,
    url,
    region:          auth.region,
    accessKeyId:     auth.accessKeyId,
    secretAccessKey: auth.secretAccessKey,
    sessionToken:    auth.sessionToken,
    expiresIn:       presignedExpiresIn,
  });
  const expiresAt = new Date(Date.now() + presignedExpiresIn * 1000).toISOString();

  return {
    status: 200,
    result: {
      bucket, key,
      method:    presignedMethod,
      expiresIn: presignedExpiresIn,
      expiresAt,
      url:       signed,
    },
    url: signed,
  };
}

// ── folder.create ─────────────────────────────────────────────────────
export async function folderCreate(auth, input, signal) {
  const { bucket, folderName, timeoutMs = 30000 } = input || {};
  if (!bucket)     throw new Error("operation=folder.create requires bucket");
  if (!folderName) throw new Error("operation=folder.create requires folderName");

  const key = String(folderName).replace(/\/+$/, "") + "/";
  const headers = { "Content-Type": "application/x-directory", "Content-Length": "0" };
  applyUploadExtras(headers, input);

  const url = buildUrl(auth, { bucket, key });
  const { status } = await s3Fetch(auth, { method: "PUT", url, headers, body: "" }, timeoutMs, signal);
  return { status, result: { bucket, folder: key, created: true }, url };
}

// ── folder.getAll ─────────────────────────────────────────────────────
export async function folderGetAll(auth, input, signal) {
  const { bucket, prefix, delimiter = "/", timeoutMs = 30000 } = input || {};
  if (!bucket) throw new Error("operation=folder.getAll requires bucket");

  const query = { "list-type": "2", delimiter };
  if (prefix) query.prefix = prefix;

  const url = buildUrl(auth, { bucket, query });
  const { status, body } = await s3Fetch(auth, { method: "GET", url }, timeoutMs, signal);
  const xml = body.toString("utf8");
  const folders = xmlAll(xml, "CommonPrefixes").map(p => xmlText(p, "Prefix"));
  return {
    status,
    result: { bucket, prefix: prefix || null, delimiter, folders, count: folders.length },
    url,
  };
}

// ── folder.delete ─────────────────────────────────────────────────────
export async function folderDelete(auth, input, signal) {
  const { bucket, prefix, timeoutMs = 60000 } = input || {};
  if (!bucket) throw new Error("operation=folder.delete requires bucket");
  if (!prefix) throw new Error("operation=folder.delete requires prefix (folder path)");

  const normPrefix = String(prefix).endsWith("/") ? prefix : prefix + "/";
  let token = null;
  let totalDeleted = 0;
  let totalErrors  = 0;

  do {
    const listUrl = buildUrl(auth, {
      bucket,
      query: { "list-type": "2", prefix: normPrefix, "max-keys": "1000", ...(token ? { "continuation-token": token } : {}) },
    });
    const { body: listBody } = await s3Fetch(auth, { method: "GET", url: listUrl }, timeoutMs, signal);
    const listXml = listBody.toString("utf8");
    const keys = xmlAll(listXml, "Contents").map(c => xmlText(c, "Key")).filter(Boolean);
    token = xmlText(listXml, "IsTruncated") === "true" ? xmlText(listXml, "NextContinuationToken") : null;
    if (keys.length === 0) break;

    const deleteXml =
      `<?xml version="1.0" encoding="UTF-8"?>` +
      `<Delete xmlns="http://s3.amazonaws.com/doc/2006-03-01/">` +
        keys.map(k => `<Object><Key>${escapeXml(k)}</Key></Object>`).join("") +
        `<Quiet>false</Quiet>` +
      `</Delete>`;
    const md5 = await md5Base64(deleteXml);

    const delUrl = buildUrl(auth, { bucket, query: { delete: "" } });
    const { body: delBody } = await s3Fetch(
      auth,
      { method: "POST", url: delUrl, headers: { "Content-Type": "application/xml", "Content-MD5": md5 }, body: deleteXml },
      timeoutMs, signal,
    );
    const delResXml = delBody.toString("utf8");
    totalDeleted += xmlAll(delResXml, "Deleted").length;
    totalErrors  += xmlAll(delResXml, "Error").length;
  } while (token);

  return { status: 200, result: { bucket, prefix: normPrefix, deleted: totalDeleted, errors: totalErrors }, url: buildUrl(auth, { bucket }) };
}

async function md5Base64(text) {
  const { createHash } = await import("node:crypto");
  return createHash("md5").update(text).digest("base64");
}
function escapeXml(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

// Operation → handler map. Single source of truth used by index.js.
export const OPERATIONS = {
  "bucket.getAll":     bucketGetAll,
  "bucket.create":     bucketCreate,
  "bucket.delete":     bucketDelete,
  "bucket.search":     bucketSearch,
  "bucket.location":   bucketLocation,
  "file.getAll":       fileGetAll,
  "file.head":         fileHead,
  "file.upload":       fileUpload,
  "file.download":     fileDownload,
  "file.copy":         fileCopy,
  "file.delete":       fileDelete,
  "file.presignedUrl": filePresignedUrl,
  "folder.create":     folderCreate,
  "folder.getAll":     folderGetAll,
  "folder.delete":     folderDelete,
};

// re-export for the verify step / smoke tests
export { endpointForRegion };
