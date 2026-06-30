import express, { Router } from "express";
import { WAHAClient } from "./waha-client";
import { WhitelistStore } from "./whitelist-store";
import { SettingsStore } from "./settings-store";
import { SenderStatsStore } from "./sender-stats-store";

export type AdminDeps = {
  waha: WAHAClient;
  whitelist: WhitelistStore;
  settings: SettingsStore;
  senderStats: SenderStatsStore;
};

/**
 * Admin/proxy router for the WhatsApp dashboard. Proxies WAHA session control
 * (so the API key stays server-side) and exposes the whitelist/settings/stats.
 * No auth — consistent with the rest of the app (intended to sit behind a VPN).
 */
export function createAdminRouter(deps: AdminDeps): Router {
  const router = express.Router();

  const wrap =
    (fn: (req: express.Request, res: express.Response) => Promise<unknown>) =>
    async (req: express.Request, res: express.Response) => {
      try {
        await fn(req, res);
      } catch (err: any) {
        res.status(502).json({ error: err?.message || String(err) });
      }
    };

  // --- Session / connection ---
  router.get(
    "/status",
    wrap(async (_req, res) => res.json(await deps.waha.getSessionStatus())),
  );
  router.get(
    "/qr",
    wrap(async (_req, res) => {
      const qr = await deps.waha.getQR();
      if (!qr) {
        res.status(204).end();
        return;
      }
      res.json(qr);
    }),
  );
  router.post(
    "/session/restart",
    wrap(async (_req, res) => {
      await deps.waha.restart();
      res.json({ ok: true });
    }),
  );
  router.post(
    "/session/logout",
    wrap(async (_req, res) => {
      await deps.waha.logout();
      res.json({ ok: true });
    }),
  );

  // --- Whitelist ---
  router.get("/whitelist", (_req, res) => res.json({ numbers: deps.whitelist.list() }));
  router.put("/whitelist", (req, res) => {
    const numbers = Array.isArray(req.body?.numbers) ? req.body.numbers : [];
    res.json({ numbers: deps.whitelist.replace(numbers) });
  });

  // --- Settings ---
  router.get("/settings", (_req, res) => res.json(deps.settings.get()));
  router.put("/settings", (req, res) => res.json(deps.settings.set(req.body || {})));

  // --- Usage stats ---
  router.get("/stats", (_req, res) => res.json(deps.senderStats.get()));

  return router;
}
