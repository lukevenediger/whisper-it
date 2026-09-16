import express, { Router } from "express";
import { TelegramWhitelistStore, normalizeTelegramId } from "./whitelist-store";
import { PrefsStore } from "./prefs-store";
import { SenderStatsStore } from "../lib/sender-stats-store";
import type { PollerStatus } from "./poller";
import type { TgUser } from "./types";

export type AdminStatus = {
  bot: TgUser | null;
  polling: PollerStatus | null;
  queue: { running: boolean; pending: number };
};

export type AdminDeps = {
  whitelist: TelegramWhitelistStore;
  prefs: PrefsStore;
  senderStats: SenderStatsStore;
  status: () => AdminStatus;
};

/**
 * Admin router for the Telegram dashboard: bot/polling status, the user-id
 * whitelist, global defaults, per-user overrides and usage stats.
 * No auth — consistent with the rest of the app (intended to sit behind a VPN).
 */
export function createAdminRouter(deps: AdminDeps): Router {
  const router = express.Router();

  router.get("/status", (_req, res) => res.json(deps.status()));

  router.get("/whitelist", (_req, res) => res.json({ ids: deps.whitelist.list() }));
  router.put("/whitelist", (req, res) => {
    const ids = Array.isArray(req.body?.ids) ? req.body.ids : [];
    res.json({ ids: deps.whitelist.replace(ids) });
  });

  router.get("/settings", (_req, res) => res.json(deps.prefs.getDefaults()));
  router.put("/settings", (req, res) => res.json(deps.prefs.setDefaults(req.body || {})));

  router.get("/users", (_req, res) => res.json({ users: deps.prefs.listUsers() }));
  router.delete("/users/:id", (req, res) => {
    const id = normalizeTelegramId(req.params.id);
    if (id === null) {
      res.status(400).json({ error: "invalid user id" });
      return;
    }
    deps.prefs.clearUser(id);
    res.json({ ok: true });
  });

  router.get("/stats", (_req, res) => res.json(deps.senderStats.get()));

  return router;
}
