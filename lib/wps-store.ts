import type { Sealed } from "./wps-crypto.ts";

export type Connection = {
  user_id: string; connection_id: string; token_cipher: string; token_iv: string;
  connected_at: number; expires_at: number | null; expired: number; verified_at: number | null;
};
export type AuthAttempt = {
  user_id: string; attempt_id: string; code_cipher: string; code_iv: string;
  created_at: number; expires_at: number; last_poll_at: number;
  lease_id: string | null; lease_until: number;
};

export class WpsStore {
  constructor(private readonly db: D1Database) {}

  getConnection(actor: string): Promise<Connection | null> {
    return this.db.prepare("SELECT * FROM wps_connections WHERE user_id = ?").bind(actor).first<Connection>();
  }

  getAttempt(actor: string): Promise<AuthAttempt | null> {
    return this.db.prepare("SELECT * FROM wps_auth_attempts WHERE user_id = ?").bind(actor).first<AuthAttempt>();
  }

  async putAttempt(actor: string, id: string, code: Sealed, now: number, expiresAt: number) {
    await this.db.prepare(`INSERT INTO wps_auth_attempts
      (user_id, attempt_id, code_cipher, code_iv, created_at, expires_at, last_poll_at, lease_until)
      VALUES (?, ?, ?, ?, ?, ?, 0, 0)
      ON CONFLICT(user_id) DO UPDATE SET attempt_id=excluded.attempt_id,
      code_cipher=excluded.code_cipher, code_iv=excluded.code_iv, created_at=excluded.created_at,
      expires_at=excluded.expires_at, last_poll_at=0, lease_id=NULL, lease_until=0`)
      .bind(actor, id, code.cipher, code.iv, now, expiresAt).run();
  }

  async claimAttempt(actor: string, id: string, lease: string, now: number, leaseMs = 30_000): Promise<boolean> {
    const result = await this.db.prepare(`UPDATE wps_auth_attempts SET lease_id=?, lease_until=?, last_poll_at=?
      WHERE user_id=? AND attempt_id=? AND expires_at>? AND lease_until<=? AND last_poll_at<=?`)
      .bind(lease, now + leaseMs, now, actor, id, now, now, now - 2_000).run();
    return result.meta.changes === 1;
  }

  async releaseAttempt(actor: string, id: string, lease: string) {
    await this.db.prepare(`UPDATE wps_auth_attempts SET lease_id=NULL, lease_until=0
      WHERE user_id=? AND attempt_id=? AND lease_id=?`).bind(actor, id, lease).run();
  }

  async removeAttempt(actor: string, id: string) {
    await this.db.prepare("DELETE FROM wps_auth_attempts WHERE user_id=? AND attempt_id=?").bind(actor, id).run();
  }

  // Both statements run in one D1 transaction. Disconnect/reconnect during an
  // in-flight exchange invalidates the SELECT, so a stale poll cannot restore a token.
  async completeAttempt(actor: string, id: string, lease: string, token: Sealed,
    now: number, expiresAt: number | null): Promise<boolean> {
    const results = await this.db.batch([
      this.db.prepare(`INSERT INTO wps_connections
        (user_id, connection_id, token_cipher, token_iv, connected_at, expires_at, expired, verified_at)
        SELECT user_id, attempt_id, ?, ?, ?, ?, 0, NULL FROM wps_auth_attempts
        WHERE user_id=? AND attempt_id=? AND lease_id=? AND expires_at>? AND lease_until>?
        ON CONFLICT(user_id) DO UPDATE SET connection_id=excluded.connection_id,
        token_cipher=excluded.token_cipher, token_iv=excluded.token_iv, connected_at=excluded.connected_at,
        expires_at=excluded.expires_at, expired=0, verified_at=NULL`)
        .bind(token.cipher, token.iv, now, expiresAt, actor, id, lease, now, now),
      this.db.prepare("DELETE FROM wps_auth_attempts WHERE user_id=? AND attempt_id=? AND lease_id=?")
        .bind(actor, id, lease),
    ]);
    return results[0].meta.changes === 1;
  }

  async markExpired(actor: string, connectionId: string) {
    await this.db.prepare("UPDATE wps_connections SET expired=1 WHERE user_id=? AND connection_id=?")
      .bind(actor, connectionId).run();
  }

  async markVerified(actor: string, connectionId: string, now: number) {
    await this.db.prepare("UPDATE wps_connections SET verified_at=? WHERE user_id=? AND connection_id=?")
      .bind(now, actor, connectionId).run();
  }

  async disconnect(actor: string) {
    await this.db.batch([
      this.db.prepare("DELETE FROM wps_connections WHERE user_id=?").bind(actor),
      this.db.prepare("DELETE FROM wps_auth_attempts WHERE user_id=?").bind(actor),
    ]);
  }
}
