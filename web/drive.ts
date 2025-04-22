import { DriveManager } from "flydrive";
import { FSDriver } from "flydrive/drivers/fs";
import { S3Driver } from "flydrive/drivers/s3";

const DRIVE_DISK = Deno.env.get("DRIVE_DISK");
if (DRIVE_DISK == null) {
  throw new Error("Missing DRIVE_DISK environment variable.");
} else if (DRIVE_DISK !== "fs" && DRIVE_DISK !== "s3") {
  throw new Error("Invalid DRIVE_DISK environment variable; must be fs or s3.");
}

const ORIGIN = Deno.env.get("ORIGIN");
if (ORIGIN == null) {
  throw new Error("Missing ORIGIN environment variable.");
}

export const drive = new DriveManager({
  default: DRIVE_DISK,
  services: {
    fs() {
      const FS_LOCATION = Deno.env.get("FS_LOCATION");
      if (FS_LOCATION == null) {
        throw new Error("Missing FS_LOCATION environment variable.");
      }
      return new FSDriver({
        location: new URL(FS_LOCATION, import.meta.url),
        visibility: "public",
        urlBuilder: {
          generateURL(key: string) {
            const url = new URL(`/media/${key}`, ORIGIN);
            return Promise.resolve(url.href);
          },
          generateSignedURL(key: string) {
            const url = new URL(`/media/${key}`, ORIGIN);
            return Promise.resolve(url.href);
          },
        },
      });
    },
    s3() {
      const AWS_ACCESS_KEY_ID = Deno.env.get("AWS_ACCESS_KEY_ID");
      if (AWS_ACCESS_KEY_ID == null) {
        throw new Error("Missing AWS_ACCESS_KEY_ID environment variable.");
      }
      const AWS_SECRET_ACCESS_KEY = Deno.env.get("AWS_SECRET_ACCESS_KEY");
      if (AWS_SECRET_ACCESS_KEY == null) {
        throw new Error("Missing AWS_SECRET_ACCESS_KEY environment variable.");
      }
      const AWS_REGION = Deno.env.get("AWS_REGION");
      if (AWS_REGION == null) {
        throw new Error("Missing AWS_REGION environment variable.");
      }
      const S3_BUCKET = Deno.env.get("S3_BUCKET");
      if (S3_BUCKET == null) {
        throw new Error("Missing S3_BUCKET environment variable.");
      }
      const S3_ENDPOINT = Deno.env.get("S3_ENDPOINT");
      const S3_CDN_URL = Deno.env.get("S3_CDN_URL");
      return new S3Driver({
        credentials: {
          accessKeyId: AWS_ACCESS_KEY_ID,
          secretAccessKey: AWS_SECRET_ACCESS_KEY,
        },
        endpoint: S3_ENDPOINT,
        cdnUrl: S3_CDN_URL,
        region: AWS_REGION,
        bucket: S3_BUCKET,
        visibility: "public",
      });
    },
  },
});
