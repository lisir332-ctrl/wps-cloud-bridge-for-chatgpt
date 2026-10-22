declare namespace Cloudflare {
  interface Env {
    DB?: D1Database;
    BUCKET?: R2Bucket;
    WPS_ENCRYPTION_KEY?: string;
    SITE_ORIGIN?: string;
  }
}
