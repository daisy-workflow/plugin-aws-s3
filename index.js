// aws-s3 — AWS-specific S3 from a workflow. The action is selected
// per-node via the `operation` input. Mirrors n8n's AWS S3 node.
//
// Wire it up:
//   1. `docker compose -f docker-compose.yml -f docker-compose.plugins.yml \
//          --profile aws-s3 up -d`
//      `npm run install-plugin -- --endpoint http://daisy-aws-s3:8080`
//   2. Create a workspace `generic` config named "aws-s3" with:
//        accessKeyId, secretAccessKey, region   (+ optional sessionToken, customEndpoint)
//   3. Use the node in any workflow.
//
// For non-AWS S3-compatible providers (Wasabi, MinIO, R2, B2…) use the
// generic `s3` plugin instead — it accepts an arbitrary endpoint and
// supports forcePathStyle.

import { servePlugin } from "@daisy-workflow/plugin-sdk";
import fs from "node:fs";

import { loadAwsAuth } from "./lib/client.js";
import { OPERATIONS }  from "./lib/actions.js";

const manifest = JSON.parse(
  fs.readFileSync(new URL("./manifest.json", import.meta.url), "utf8"),
);

servePlugin({
  manifest,
  async execute(input, ctx) {
    const { operation, config = "aws-s3" } = input || {};
    if (!operation) throw new Error("`operation` is required (see manifest enum for valid values)");

    const handler = OPERATIONS[operation];
    if (!handler) {
      throw new Error(
        `unknown operation "${operation}". Valid: ${Object.keys(OPERATIONS).join(", ")}`,
      );
    }

    const auth = loadAwsAuth(ctx, config, input?.region);
    const { status, result, url } = await handler(auth, input, ctx?.signal);

    return {
      ok:        true,
      operation,
      status,
      result,
      url,
    };
  },
  async readyz() { return true; },
});
