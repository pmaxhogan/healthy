/**
Paired phones: the `devices` table (worker/migrations/0016_health_connect.sql).

A device is a source of Health Connect records, not a health system. Its row
holds what the ingest route needs to authenticate it -- the digest of its
bearer token, never the token -- and what the Phone page shows about it.

The name the owner gave the phone is sealed and padded like every other
short, human-chosen value. Everything else in the clear is bookkeeping: this
app's own id, instants, the companion app's version string.
*/

import { hashDeviceToken, mintDeviceToken } from "../../hc/device-token.ts";
import { newId } from "../../lib/ids.ts";
import { all, one, run } from "../client.ts";
import { aadFor, open, openOrNull, seal, sealShort } from "../crypto.ts";

import type { Device, DeviceAuthRow, MintedDevice } from "../../hc/device.ts";
import type { Ctx } from "../client.ts";

interface DeviceRow {
  id: string;
  name_enc: string;
  token_hash: string;
  created_at: number;
  rotated_at: number | null;
  revoked_at: number | null;
  last_seen_at: number | null;
  last_upload_at: number | null;
  app_version: string | null;
  sync_state_enc: string | null;
  rate_window_start: number;
  rate_window_count: number;
}

/** The longest app version string kept. It is the phone's own claim, so it is bounded. */
const MAX_APP_VERSION_LENGTH = 64;

const nameAad = (id: string): string => aadFor("devices", "name_enc", id);
const syncStateAad = (id: string): string => aadFor("devices", "sync_state_enc", id);

export function makeDevicesRepo(ctx: Ctx) {
  const toDevice = async (row: DeviceRow): Promise<Device> => ({
    id: row.id,
    name: await open(ctx.env, row.name_enc, nameAad(row.id)),
    createdAt: row.created_at,
    rotatedAt: row.rotated_at,
    revokedAt: row.revoked_at,
    lastSeenAt: row.last_seen_at,
    lastUploadAt: row.last_upload_at,
    appVersion: row.app_version,
  });

  const readRow = (id: string): Promise<DeviceRow | null> =>
    one<DeviceRow>(ctx.db.prepare("SELECT * FROM devices WHERE id = ?").bind(id));

  return {
    /** Pair a new phone: a row, and the one copy of its token. */
    async mint(name: string): Promise<MintedDevice> {
      const id = newId();
      const token = mintDeviceToken(id);
      const nameEnc = await sealShort(ctx.env, name, nameAad(id));
      const tokenHash = await hashDeviceToken(token);
      await run(
        ctx.db
          .prepare("INSERT INTO devices (id, name_enc, token_hash, created_at) VALUES (?, ?, ?, ?)")
          .bind(id, nameEnc, tokenHash, ctx.now()),
      );
      const row = await readRow(id);
      if (row === null) throw new Error("device row vanished after insert");
      return { device: await toDevice(row), token };
    },

    /**
    Replace a device's token. The old one stops working with this statement;
    a revoked device stays revoked (pairing again is `mint`).
    */
    async rotate(id: string): Promise<MintedDevice | null> {
      const token = mintDeviceToken(id);
      const { changes } = await run(
        ctx.db
          .prepare(
            "UPDATE devices SET token_hash = ?, rotated_at = ? WHERE id = ? AND revoked_at IS NULL",
          )
          .bind(await hashDeviceToken(token), ctx.now(), id),
      );
      if (changes === 0) return null;
      const row = await readRow(id);
      return row === null ? null : { device: await toDevice(row), token };
    },

    /** Stop accepting uploads from a device. Its data stays. Idempotent. */
    async revoke(id: string): Promise<boolean> {
      const { changes } = await run(
        ctx.db
          .prepare("UPDATE devices SET revoked_at = coalesce(revoked_at, ?) WHERE id = ?")
          .bind(ctx.now(), id),
      );
      return changes > 0;
    },

    async rename(id: string, name: string): Promise<boolean> {
      const nameEnc = await sealShort(ctx.env, name, nameAad(id));
      const { changes } = await run(
        ctx.db.prepare("UPDATE devices SET name_enc = ? WHERE id = ?").bind(nameEnc, id),
      );
      return changes > 0;
    },

    async get(id: string): Promise<Device | null> {
      const row = await readRow(id);
      return row === null ? null : toDevice(row);
    },

    async list(): Promise<Device[]> {
      const rows = await all<DeviceRow>(ctx.db.prepare("SELECT * FROM devices ORDER BY id"));
      return Promise.all(rows.map((row) => toDevice(row)));
    },

    /** The authentication read: one row by primary key, no decryption. */
    async authRow(id: string): Promise<DeviceAuthRow | null> {
      const row = await one<Pick<DeviceRow, "id" | "token_hash" | "revoked_at">>(
        ctx.db.prepare("SELECT id, token_hash, revoked_at FROM devices WHERE id = ?").bind(id),
      );
      return row === null
        ? null
        : { id: row.id, tokenHash: row.token_hash, revokedAt: row.revoked_at };
    },

    /**
    Count one authenticated request against the device's fixed window and
    return the count inside it. One statement, so two concurrent uploads
    cannot both read a stale count. Also stamps `last_seen_at`.
    */
    async bumpRate(id: string, windowSeconds: number): Promise<number> {
      const at = ctx.now();
      const row = await one<{ rate_window_count: number }>(
        ctx.db
          .prepare(
            `UPDATE devices SET
               rate_window_count = CASE WHEN rate_window_start + ? <= ? THEN 1 ELSE rate_window_count + 1 END,
               rate_window_start = CASE WHEN rate_window_start + ? <= ? THEN ? ELSE rate_window_start END,
               last_seen_at = ?
             WHERE id = ?
             RETURNING rate_window_count`,
          )
          .bind(windowSeconds, at, windowSeconds, at, at, at, id),
      );
      return row?.rate_window_count ?? 1;
    },

    /** Record an accepted upload: when, from which app version, and the phone's own sync report. */
    async recordUpload(
      id: string,
      upload: { appVersion: string | null; syncStateJson: string | null },
    ): Promise<void> {
      const at = ctx.now();
      const appVersion = upload.appVersion?.slice(0, MAX_APP_VERSION_LENGTH) ?? null;
      const sealed =
        upload.syncStateJson === null
          ? null
          : await seal(ctx.env, upload.syncStateJson, syncStateAad(id));
      await run(
        ctx.db
          .prepare(
            `UPDATE devices SET
               last_upload_at = ?,
               app_version = coalesce(?, app_version),
               sync_state_enc = coalesce(?, sync_state_enc)
             WHERE id = ?`,
          )
          .bind(at, appVersion, sealed, id),
      );
    },

    /** The phone's last sync report, as the JSON it sent. Null before the first one. */
    async syncStateJson(id: string): Promise<string | null> {
      const row = await one<Pick<DeviceRow, "sync_state_enc">>(
        ctx.db.prepare("SELECT sync_state_enc FROM devices WHERE id = ?").bind(id),
      );
      return row === null ? null : openOrNull(ctx.env, row.sync_state_enc, syncStateAad(id));
    },

    /**
    Remove the device row. Every Health Connect table hangs off it with
    `ON DELETE CASCADE`, but a phone's history is millions of rows, so the
    caller (the wipe in `worker/src/hc/`) empties those tables in slices
    first and calls this last.
    */
    async delete(id: string): Promise<boolean> {
      const { changes } = await run(ctx.db.prepare("DELETE FROM devices WHERE id = ?").bind(id));
      return changes > 0;
    },
  };
}
