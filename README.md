# aws-s3 plugin for Daisy-workflow

One Daisy node that talks to **AWS S3 specifically** — with full
support for AWS-only features: storage classes, server-side encryption,
KMS, object tags, requester pays, and presigned URLs. Mirrors n8n's
[AWS S3 node](https://docs.n8n.io/integrations/builtin/app-nodes/n8n-nodes-base.awss3/).


[![Docker Hub](https://img.shields.io/badge/Docker%20Hub-Image-blue?logo=docker)](https://hub.docker.com/r/yourusername/yourimage)

> Need Wasabi, MinIO, Cloudflare R2, DigitalOcean Spaces, Backblaze B2,
> or another S3-compatible provider? Use the **generic `s3` plugin**
> instead — it accepts an arbitrary endpoint and `forcePathStyle`.

The action is selected per-node via the **operation** dropdown.

## Operations

| operation | What it does |
|---|---|
| `bucket.getAll`     | List all buckets the credential has access to. |
| `bucket.create`     | Create a new bucket. Sends `LocationConstraint` when region ≠ us-east-1. |
| `bucket.delete`     | Delete a bucket (bucket must be empty). |
| `bucket.search`     | List objects in a bucket matching a `prefix`. |
| `bucket.location`   | Get the bucket's region (`?location` API). |
| `file.getAll`       | List objects with optional `prefix` + pagination. |
| `file.head`         | Get object metadata only (no body) — content-type, size, storage class, SSE config, user metadata. |
| `file.upload`       | PUT an object. Supports `storageClass`, `serverSideEncryption`, `ssekmsKeyId`, `tags`, `acl`, `requesterPays`. |
| `file.download`     | GET an object. Body returned as `base64` (default) or `utf8`. |
| `file.copy`         | Copy with optional destination SSE / storage class / tags. |
| `file.delete`       | Delete an object. |
| `file.presignedUrl` | Generate a time-limited URL that anyone can use to GET (or PUT) the object — no API call, pure crypto. |
| `folder.create`     | Create a "folder" placeholder (empty object with key ending in `/`). |
| `folder.getAll`     | List "folders" using `delimiter` (default `/`) → CommonPrefixes. |
| `folder.delete`     | Recursively delete everything under a prefix via bulk MultiObjectDelete. |

## Configure auth

Create one **generic** config on the **Configurations** page (default
name `aws-s3`):

| Key               | Example                                       | Notes                                              |
|-------------------|-----------------------------------------------|----------------------------------------------------|
| `accessKeyId`     | `AKIA…`                                       | IAM user or role access key                        |
| `secretAccessKey` | `…`                                           |                                                    |
| `region`          | `us-east-1` / `eu-central-1` / `ap-south-1`   | Drives the endpoint and the SigV4 signing region   |
| `sessionToken`    | `…`                                           | Optional — STS / AssumeRole / EC2 instance role    |
| `customEndpoint`  | `https://bucket.vpce-….s3.us-east-1.vpce.amazonaws.com` | Optional — VPC interface endpoint, S3 Transfer Acceleration host, AWS GovCloud, AWS China |

The endpoint is auto-derived from the region. `cn-*` regions
automatically use `amazonaws.com.cn`. Override with `customEndpoint`
for transfer acceleration (`s3-accelerate.amazonaws.com`),
VPC interface endpoints, or air-gapped AWS partitions.

A node can override the config name per-call via the `config` input
and the region per-call via the `region` input.

## AWS-specific upload extras

| Input | Sent as | Notes |
|---|---|---|
| `storageClass` | `x-amz-storage-class` | `STANDARD` / `INTELLIGENT_TIERING` / `STANDARD_IA` / `ONEZONE_IA` / `GLACIER` / `DEEP_ARCHIVE` / `GLACIER_IR` / `REDUCED_REDUNDANCY` |
| `serverSideEncryption` | `x-amz-server-side-encryption` | `AES256` / `aws:kms` / `aws:kms:dsse` |
| `ssekmsKeyId` | `x-amz-server-side-encryption-aws-kms-key-id` | KMS key ID or ARN when using `aws:kms*` |
| `tags` | `x-amz-tagging` | Object → URL-encoded query string: `{env:'prod', team:'data'}` → `env=prod&team=data` |
| `acl` | `x-amz-acl` | Note: many AWS accounts disable ACLs ("Object Ownership = Bucket owner enforced"); the header is then rejected |
| `requesterPays` | `x-amz-request-payer: requester` | Required when reading from a Requester-Pays bucket |
| `metadata` | `x-amz-meta-<key>` | Custom user metadata; one header per key |

`file.copy` accepts the same extras for the destination object.

## Presigned URLs

```jsonc
// input
{
  "operation":           "file.presignedUrl",
  "bucket":              "uploads",
  "key":                 "users/42/avatar.png",
  "presignedMethod":     "PUT",          // GET (default) or PUT
  "presignedExpiresIn":  3600            // seconds; max 604800 (7 days)
}

// result
{
  "bucket":    "uploads",
  "key":       "users/42/avatar.png",
  "method":    "PUT",
  "expiresIn": 3600,
  "expiresAt": "2026-05-18T09:30:00.000Z",
  "url":       "https://uploads.s3.us-east-1.amazonaws.com/users/42/avatar.png?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=…&X-Amz-Signature=…"
}
```

No HTTP call is made — pure crypto. Hand this URL to a browser or curl
to upload / download without exposing the AWS credentials.

## Install

```bash
docker compose -f docker-compose.yml -f docker-compose.plugins.yml \
  --profile aws-s3 up -d

npm run install-plugin -- --endpoint http://daisy-aws-s3:8080
```

## Output envelope

```json
{
  "ok":        true,
  "operation": "file.upload",
  "status":    200,
  "result":    { "bucket": "logs", "key": "2026/05/event.json", "size": 412, "etag": "ab12…", "serverSideEncryption": "AES256" },
  "url":       "https://logs.s3.us-east-1.amazonaws.com/2026/05/event.json"
}
```

Operation-specific `result` shapes are documented inline in
`lib/actions.js`. Highlights:

- `bucket.getAll`   → `{ owner, buckets: [{ name, creationDate }], count }`
- `bucket.location` → `{ bucket, location }` (always real region; us-east-1 is normalized from the empty `<LocationConstraint/>` AWS returns)
- `file.head`       → `{ bucket, key, contentType, contentLength, etag, lastModified, versionId, storageClass, serverSideEncryption, ssekmsKeyId, metadata }`
- `file.download`   → `{ bucket, key, contentType, contentLength, etag, lastModified, encoding, data }`
- `file.presignedUrl` → see above

## Auth model — why hand-rolled SigV4?

Both header-based signing and query-string presigning are implemented in
`lib/sigv4.js` (~200 lines, zero deps, validated against AWS's
canonical S3 test vector). Keeps the container tiny and the dependency
surface to exactly one package (the Daisy plugin SDK).

If you need features that go beyond what this plugin offers — multipart
upload for >5GB files, S3 Select, batch operations, event subscriptions,
inventory configs — drop in `@aws-sdk/client-s3` and add a new
operation that uses it.

## Files

```
plugins-external/aws-s3/
├── manifest.json
├── index.js
├── lib/
│   ├── sigv4.js         # signRequest() + presignUrl(), no deps
│   ├── client.js        # auth + endpoint derivation + signed fetch
│   └── actions.js       # one async handler per operation
├── package.json
├── Dockerfile
├── publish-docker.sh
└── README.md
```

## Publish the image

```bash
docker login
./publish-docker.sh
```

Env overrides: `IMAGE=foo/bar`, `PLATFORMS=linux/amd64`, `PUSH=0`, `NO_LATEST=1`.
