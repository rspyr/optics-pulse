import { Router, type IRouter } from "express";
import { db, usersTable, tenantsTable, userLoginSessionsTable } from "@workspace/db";
import { eq, and, isNull } from "drizzle-orm";
import bcrypt from "bcryptjs";
import { requireAuth } from "../middleware/auth";

const router: IRouter = Router();

router.post("/auth/login", async (req, res) => {
  try {
    const { email, password } = req.body as { email: string; password: string };
    if (!email || !password) {
      res.status(400).json({ error: "Email and password required" });
      return;
    }

    const [user] = await db.select().from(usersTable)
      .where(and(eq(usersTable.email, email.toLowerCase()), eq(usersTable.isActive, true)));

    if (!user) {
      res.status(401).json({ error: "Invalid credentials" });
      return;
    }

    const valid = await bcrypt.compare(password, user.passwordHash);
    if (!valid) {
      res.status(401).json({ error: "Invalid credentials" });
      return;
    }

    let tenantName: string | null = null;
    let leaderboardConfig: { visible: boolean; displayMode: string } | null = null;
    if (user.tenantId) {
      const [tenant] = await db.select().from(tenantsTable).where(eq(tenantsTable.id, user.tenantId));
      tenantName = tenant?.name || null;
      if (tenant?.leaderboardConfig) {
        const lbRaw = tenant.leaderboardConfig as Record<string, unknown>;
        leaderboardConfig = {
          visible: Boolean(lbRaw.visible),
          displayMode: lbRaw.displayMode === "named" ? "named" : "anonymized",
        };
      }
    }

    req.session.userId = user.id;
    req.session.userRole = user.role;
    req.session.tenantId = user.tenantId;

    req.session.save(async () => {
      if (user.role === "client_user") {
        try {
          await db.insert(userLoginSessionsTable).values({
            userId: user.id,
            tenantId: user.tenantId,
            sessionKey: req.sessionID,
            loginAt: new Date(),
          });
        } catch (err) {
          console.error("[Auth] Failed to record login session:", err);
        }
      }

      res.json({
        id: user.id,
        email: user.email,
        name: user.name,
        role: user.role,
        tenantId: user.tenantId,
        tenantName,
        leaderboardConfig,
      });
    });
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : "Login failed";
    res.status(500).json({ error: msg });
  }
});

router.post("/auth/logout", async (req, res) => {
  const userId = req.session.userId;
  const userRole = req.session.userRole;

  if (userId && userRole === "client_user") {
    try {
      const sessionKey = req.sessionID;
      if (sessionKey) {
        await db.update(userLoginSessionsTable)
          .set({ logoutAt: new Date() })
          .where(and(
            eq(userLoginSessionsTable.sessionKey, sessionKey),
            isNull(userLoginSessionsTable.logoutAt),
          ));
      }
    } catch (err) {
      console.error("[Auth] Failed to close login session:", err);
    }
  }

  req.session.destroy((err) => {
    if (err) {
      res.status(500).json({ error: "Logout failed" });
      return;
    }
    res.clearCookie("mos.sid");
    res.json({ success: true });
  });
});

router.get("/auth/me", async (req, res) => {
  if (!req.session.userId) {
    res.status(401).json({ error: "Not authenticated" });
    return;
  }

  const [user] = await db.select().from(usersTable).where(eq(usersTable.id, req.session.userId));
  if (!user || !user.isActive) {
    req.session.destroy(() => {});
    res.status(401).json({ error: "User not found" });
    return;
  }

  let tenantName: string | null = null;
  let leaderboardConfig: { visible: boolean; displayMode: string } | null = null;
  if (user.tenantId) {
    const [tenant] = await db.select().from(tenantsTable).where(eq(tenantsTable.id, user.tenantId));
    tenantName = tenant?.name || null;
    if (tenant?.leaderboardConfig) {
      const lbRaw = tenant.leaderboardConfig as Record<string, unknown>;
      leaderboardConfig = {
        visible: Boolean(lbRaw.visible),
        displayMode: lbRaw.displayMode === "named" ? "named" : "anonymized",
      };
    }
  }

  res.json({
    id: user.id,
    email: user.email,
    name: user.name,
    role: user.role,
    tenantId: user.tenantId,
    tenantName,
    leaderboardConfig,
  });
});

router.post("/auth/change-password", requireAuth, async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body as { currentPassword: string; newPassword: string };
    if (!currentPassword || !newPassword) {
      res.status(400).json({ error: "Current password and new password are required" });
      return;
    }
    if (newPassword.length < 6) {
      res.status(400).json({ error: "New password must be at least 6 characters" });
      return;
    }

    const [user] = await db.select().from(usersTable).where(eq(usersTable.id, req.session.userId!));
    if (!user) {
      res.status(404).json({ error: "User not found" });
      return;
    }

    const valid = await bcrypt.compare(currentPassword, user.passwordHash);
    if (!valid) {
      res.status(401).json({ error: "Current password is incorrect" });
      return;
    }

    const passwordHash = await bcrypt.hash(newPassword, 10);
    await db.update(usersTable).set({ passwordHash, updatedAt: new Date() }).where(eq(usersTable.id, user.id));

    res.json({ success: true });
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : "Failed to change password";
    res.status(500).json({ error: msg });
  }
});

export default router;
