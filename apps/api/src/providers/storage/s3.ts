/**
 * S3-compatible object storage, signed with SigV4 by hand.
 *
 * For operators who already run MinIO, Garage, or a cloud bucket, or who deploy
 * more than one application server and need shared storage. Optional: the
 * filesystem implementation is the default and is sufficient for a single box.
 *
 * Objects are written private. There is no ACL argument and no public-read path
 * in this file, because the correct value is never anything else for the content
 * it holds.
 */

import { createHash, createHmac } from "node:crypto";
import { type Storage, type StoredObject } from "./index.ts";

export interface S3Options {
  endpoint: string;
  bucket: string;
  accessKey: string;
  secretKey: string;
  region: string;
  /** Path-style addressing, which MinIO and most self-hosted servers require. */
  forcePathStyle?: boolean;
}

export class S3Storage implements Storage {
  readonly name = "s3";
  private readonly options: S3Options;

  constructor(options: S3Options) {
    this.options = { forcePathStyle: true, ...options };
  }

  async put(key: string, body: Buffer, contentType: string): Promise<StoredObject> {
    const response = await this.request("PUT", key, body, {
      "content-type": contentType,
      // Encrypted at rest where the server supports it. Ignored harmlessly where
      // it does not.
      "x-amz-server-side-encryption": "AES256",
    });
    if (!response.ok) {
      throw new Error(`S3 PUT failed with ${response.status}: ${await response.text()}`);
    }
    return { key, contentType, sizeBytes: body.length };
  }

  async get(key: string): Promise<{ body: Buffer; contentType: string } | null> {
    const response = await this.request("GET", key, null, {});
    if (response.status === 404) return null;
    if (!response.ok) throw new Error(`S3 GET failed with ${response.status}`);
    return {
      body: Buffer.from(await response.arrayBuffer()),
      contentType: response.headers.get("content-type") ?? "application/octet-stream",
    };
  }

  async delete(key: string): Promise<void> {
    await this.request("DELETE", key, null, {});
  }

  private async request(
    method: string,
    key: string,
    body: Buffer | null,
    extraHeaders: Record<string, string>,
  ): Promise<Response> {
    const url = new URL(
      this.options.forcePathStyle
        ? `${this.options.endpoint}/${this.options.bucket}/${key}`
        : `${this.options.endpoint}/${key}`,
    );

    const now = new Date();
    const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, "");
    const dateStamp = amzDate.slice(0, 8);
    const payloadHash = createHash("sha256").update(body ?? Buffer.alloc(0)).digest("hex");

    const headers: Record<string, string> = {
      host: url.host,
      "x-amz-content-sha256": payloadHash,
      "x-amz-date": amzDate,
      ...extraHeaders,
    };

    const signedHeaderNames = Object.keys(headers).map((h) => h.toLowerCase()).sort();
    const canonicalHeaders = signedHeaderNames
      .map((name) => `${name}:${String(headers[Object.keys(headers).find((k) => k.toLowerCase() === name)!]).trim()}\n`)
      .join("");
    const signedHeaders = signedHeaderNames.join(";");

    const canonicalRequest = [
      method,
      url.pathname.split("/").map(encodeURIComponent).join("/").replace(/%2F/g, "/"),
      url.searchParams.toString(),
      canonicalHeaders,
      signedHeaders,
      payloadHash,
    ].join("\n");

    const scope = `${dateStamp}/${this.options.region}/s3/aws4_request`;
    const stringToSign = [
      "AWS4-HMAC-SHA256",
      amzDate,
      scope,
      createHash("sha256").update(canonicalRequest).digest("hex"),
    ].join("\n");

    const signature = createHmac(
      "sha256",
      ["aws4_request", "s3", this.options.region, dateStamp].reduceRight(
        (key, part) => createHmac("sha256", key).update(part).digest(),
        Buffer.from(`AWS4${this.options.secretKey}`, "utf8") as Buffer,
      ),
    )
      .update(stringToSign)
      .digest("hex");

    headers.authorization =
      `AWS4-HMAC-SHA256 Credential=${this.options.accessKey}/${scope}, ` +
      `SignedHeaders=${signedHeaders}, Signature=${signature}`;

    return fetch(url, { method, headers, body: body ?? undefined });
  }
}
