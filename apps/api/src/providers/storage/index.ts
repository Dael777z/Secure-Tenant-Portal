/**
 * Object storage for maintenance photos.
 *
 * These are photographs of the inside of somebody's home, often taken because
 * something is broken and sometimes showing more of a private space than the
 * resident thought about before pressing send. Two rules follow from that and
 * are enforced by every implementation:
 *
 *   Objects are never publicly readable. Access is always a short-lived,
 *   signed grant issued to a specific request by a caller the API has already
 *   authorized, never a URL that works for anyone who has it.
 *
 *   Keys are unguessable. A key derived from a work-order number would let
 *   anyone who knows one enumerate the rest.
 */

export interface StoredObject {
  key: string;
  contentType: string;
  sizeBytes: number;
}

export interface Storage {
  readonly name: string;
  put(key: string, body: Buffer, contentType: string): Promise<StoredObject>;
  get(key: string): Promise<{ body: Buffer; contentType: string } | null>;
  delete(key: string): Promise<void>;
}

export const ALLOWED_IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp", "image/heic"] as const;
export const MAX_PHOTO_BYTES = 15 * 1024 * 1024;

/**
 * Identify a file by its leading bytes rather than by what the client said it
 * is. A `content-type` header is a claim, and accepting the claim is how an
 * HTML file with an image extension ends up being served back to a browser.
 */
export function sniffImageType(body: Buffer): string | null {
  if (body.length < 12) return null;
  if (body[0] === 0xff && body[1] === 0xd8 && body[2] === 0xff) return "image/jpeg";
  if (body.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return "image/png";
  }
  if (body.subarray(0, 4).toString("ascii") === "RIFF" && body.subarray(8, 12).toString("ascii") === "WEBP") {
    return "image/webp";
  }
  const brand = body.subarray(4, 8).toString("ascii");
  if (brand === "ftyp") {
    const subtype = body.subarray(8, 12).toString("ascii");
    if (["heic", "heix", "hevc", "mif1", "heim"].includes(subtype)) return "image/heic";
  }
  return null;
}
