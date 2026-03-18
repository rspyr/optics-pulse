import { Router, type IRouter } from "express";
import { db, usersTable, tenantsTable } from "@workspace/db";
import { eq, and } from "drizzle-orm";
import bcrypt from "bcryptjs";

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
    if (user.tenantId) {
      const [tenant] = await db.select().from(tenantsTable).where(eq(tenantsTable.id, user.tenantId));
      tenantName = tenant?.name || null;
    }

    req.session.userId = user.id;
    req.session.userRole = user.role;
    req.session.save(() => {
      res.json({
        id: user.id,
        email: user.email,
        name: user.name,
        role: user.role,
        tenantId: user.tenantId,
        tenantName,
      });
    });
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : "Login failed";
    res.status(500).json({ error: msg });
  }
});

router.post("/auth/logout", (req, res) => {
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
  if (user.tenantId) {
    const [tenant] = await db.select().from(tenantsTable).where(eq(tenantsTable.id, user.tenantId));
    tenantName = tenant?.name || null;
  }

  res.json({
    id: user.id,
    email: user.email,
    name: user.name,
    role: user.role,
    tenantId: user.tenantId,
    tenantName,
  });
});

export default router;
