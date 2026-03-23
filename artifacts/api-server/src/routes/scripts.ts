import { Router, type IRouter } from "express";
import { db, scriptsTable, scriptVersionsTable, changeLogsTable } from "@workspace/db";
import { eq, and, desc, count } from "drizzle-orm";
import { requireRole } from "../middleware/auth";

const router: IRouter = Router();

const DEFAULT_SCRIPTS = [
  { type: "call", name: "Google Ads", sourceFilter: "Google Ads", stageFilter: null, content: "Hi [NAME], this is [REP] from [COMPANY]. I see you were looking into [INTEREST] — we have availability this week. Would you like to schedule a free estimate?" },
  { type: "call", name: "Meta Leads", sourceFilter: "Meta Leads", stageFilter: null, content: "Hey [NAME]! Thanks for filling out our form on Facebook. I'd love to help you with your [INTEREST] needs. Do you have a moment to chat about scheduling?" },
  { type: "call", name: "CallRail", sourceFilter: "CallRail", stageFilter: null, content: "Hi [NAME], I'm returning your call about [INTEREST]. We'd love to get you on the schedule. What times work best for you this week?" },
  { type: "call", name: "Organic Search", sourceFilter: "Organic Search", stageFilter: null, content: "Hello [NAME], this is [REP] with [COMPANY]. You visited our website about [INTEREST] — we're running a special this month. Can I tell you about it?" },
  { type: "call", name: "Direct", sourceFilter: "Direct", stageFilter: null, content: "Hi [NAME], thank you for reaching out! I'd love to help you with [INTEREST]. Let me find the best time for an estimate." },
  { type: "call", name: "Referral", sourceFilter: "Referral", stageFilter: null, content: "Hi [NAME]! You were referred to us for [INTEREST]. We'd love to take care of you. When would be a good time for a technician to come out?" },
  { type: "text", name: "Follow-up Text", sourceFilter: null, stageFilter: null, content: "Hi [NAME]! This is [REP] from [COMPANY]. Just following up on your [INTEREST] inquiry. Would you like to schedule a free estimate? Reply YES and I'll get you on the calendar!" },
  { type: "text", name: "Same-Day Availability", sourceFilter: null, stageFilter: null, content: "Hey [NAME], we have same-day availability for [INTEREST] estimates. Want me to reserve a spot for you today?" },
  { type: "voicemail", name: "Google Ads VM", sourceFilter: "Google Ads", stageFilter: null, content: "Hi [NAME], this is [REP] with [COMPANY]. I'm calling about your [INTEREST] inquiry. We have great availability this week for a free estimate. Please call us back at your earliest convenience. Again, this is [REP] at [COMPANY]. Have a great day!" },
  { type: "voicemail", name: "Meta Leads VM", sourceFilter: "Meta Leads", stageFilter: null, content: "Hey [NAME], this is [REP] from [COMPANY]. You filled out a form about [INTEREST] and I wanted to reach out personally. We'd love to help — call us back when you get a chance and we'll get you scheduled. Thanks!" },
  { type: "voicemail", name: "CallRail VM", sourceFilter: "CallRail", stageFilter: null, content: "Hi [NAME], [REP] here from [COMPANY], returning your call about [INTEREST]. Sorry I missed you — please give us a ring back and we'll take care of you. Talk soon!" },
  { type: "voicemail", name: "Default VM", sourceFilter: null, stageFilter: null, content: "Hi [NAME], this is [REP] with [COMPANY] calling about your [INTEREST] inquiry. We'd love to schedule a free estimate at your convenience. Please call us back when you get this. Thank you!" },
  { type: "email", name: "Follow-up Email", sourceFilter: null, stageFilter: null, content: "Hi [NAME],\n\nThank you for your interest in [INTEREST]. I'd love to help you schedule a free estimate at your convenience.\n\nWe have availability this week and our team is ready to assist. Simply reply to this email or call us to get started.\n\nBest regards,\n[REP]\n[COMPANY]" },
  { type: "text", name: "3 Month Re-engagement", sourceFilter: null, stageFilter: "re-engage-3mo", content: "Hi [NAME], it's [REP] from [COMPANY]. It's been a few months since we last connected about [INTEREST]. We have some great seasonal specials running — would you like to hear about them?" },
  { type: "text", name: "6 Month Re-engagement", sourceFilter: null, stageFilter: "re-engage-6mo", content: "Hey [NAME]! [REP] here from [COMPANY]. It's been about 6 months since your [INTEREST] inquiry. Just checking in — are you still looking for help? We'd love to get you taken care of!" },
  { type: "text", name: "9 Month Re-engagement", sourceFilter: null, stageFilter: "re-engage-9mo", content: "Hi [NAME], this is [REP] from [COMPANY]. It's been a while since we chatted about [INTEREST]. I wanted to reach out one more time — we have some end-of-season deals that might interest you. Let me know!" },
];

async function seedDefaultScripts(tenantId: number, userId: number | null) {
  const [existing] = await db.select({ count: count() }).from(scriptsTable)
    .where(eq(scriptsTable.tenantId, tenantId));

  if (existing.count > 0) return;

  for (const s of DEFAULT_SCRIPTS) {
    await db.insert(scriptsTable).values({
      tenantId,
      type: s.type,
      name: s.name,
      sourceFilter: s.sourceFilter,
      stageFilter: s.stageFilter,
      content: s.content,
      version: 1,
      isActive: true,
      createdBy: userId,
    });
  }
}

function resolveTenantId(req: import("express").Request): number | null {
  const sessionTid = req.session.tenantId;
  if (sessionTid) return sessionTid;
  const role = req.session.userRole;
  if ((role === "super_admin" || role === "agency_user") && req.query.tenantId) {
    const parsed = parseInt(req.query.tenantId as string);
    if (!isNaN(parsed)) return parsed;
  }
  return null;
}

router.get("/scripts", async (req, res) => {
  const tenantId = resolveTenantId(req);
  if (!tenantId) { res.status(400).json({ error: "No tenant — select a client or pass ?tenantId=" }); return; }

  await seedDefaultScripts(tenantId, req.session.userId ?? null);

  const type = req.query.type as string | undefined;
  const conds = [eq(scriptsTable.tenantId, tenantId)];
  if (type) conds.push(eq(scriptsTable.type, type));

  const scripts = await db.select().from(scriptsTable)
    .where(and(...conds))
    .orderBy(scriptsTable.type, scriptsTable.name);

  res.json(scripts);
});

router.get("/scripts/:id", async (req, res) => {
  const id = parseInt(req.params.id);
  const tenantId = resolveTenantId(req);
  if (!tenantId) { res.status(400).json({ error: "No tenant" }); return; }

  const [script] = await db.select().from(scriptsTable)
    .where(and(eq(scriptsTable.id, id), eq(scriptsTable.tenantId, tenantId)));

  if (!script) { res.status(404).json({ error: "Script not found" }); return; }
  res.json(script);
});

router.get("/scripts/:id/versions", async (req, res) => {
  const id = parseInt(req.params.id);
  const tenantId = resolveTenantId(req);
  if (!tenantId) { res.status(400).json({ error: "No tenant" }); return; }

  const [script] = await db.select().from(scriptsTable)
    .where(and(eq(scriptsTable.id, id), eq(scriptsTable.tenantId, tenantId)));
  if (!script) { res.status(404).json({ error: "Script not found" }); return; }

  const versions = await db.select().from(scriptVersionsTable)
    .where(eq(scriptVersionsTable.scriptId, id))
    .orderBy(desc(scriptVersionsTable.version));

  res.json(versions);
});

router.post("/scripts", requireRole("super_admin", "agency_user", "client_admin"), async (req, res) => {
  const tenantId = resolveTenantId(req);
  if (!tenantId) { res.status(400).json({ error: "No tenant" }); return; }

  const VALID_TYPES = ["call", "voicemail", "text", "email", "objection", "closing", "follow-up", "re-engagement"];
  const { type, name, sourceFilter, stageFilter, content } = req.body;
  if (!type || !name || !content) {
    res.status(400).json({ error: "type, name, and content are required" });
    return;
  }
  if (!VALID_TYPES.includes(type)) {
    res.status(400).json({ error: `Invalid type. Must be one of: ${VALID_TYPES.join(", ")}` });
    return;
  }

  const [script] = await db.insert(scriptsTable).values({
    tenantId,
    type,
    name,
    sourceFilter: sourceFilter || null,
    stageFilter: stageFilter || null,
    content,
    version: 1,
    isActive: true,
    createdBy: req.session.userId ?? null,
  }).returning();

  await db.insert(changeLogsTable).values({
    tenantId,
    date: new Date().toISOString().split("T")[0],
    title: `New ${type} script: "${name}"`,
    description: `Created new ${type} script "${name}"${sourceFilter ? ` for ${sourceFilter} leads` : ""}${stageFilter ? ` (stage: ${stageFilter})` : ""}.`,
    category: "scripts",
  });

  res.status(201).json(script);
});

router.put("/scripts/:id", requireRole("super_admin", "agency_user", "client_admin"), async (req, res) => {
  const id = parseInt(req.params.id);
  const tenantId = resolveTenantId(req);
  if (!tenantId) { res.status(400).json({ error: "No tenant" }); return; }

  const [existing] = await db.select().from(scriptsTable)
    .where(and(eq(scriptsTable.id, id), eq(scriptsTable.tenantId, tenantId)));

  if (!existing) { res.status(404).json({ error: "Script not found" }); return; }

  const { name, sourceFilter, stageFilter, content, isActive } = req.body;

  await db.insert(scriptVersionsTable).values({
    scriptId: existing.id,
    version: existing.version,
    content: existing.content,
    name: existing.name,
    sourceFilter: existing.sourceFilter,
    stageFilter: existing.stageFilter,
    editedBy: req.session.userId ?? null,
  });

  const changes: string[] = [];
  if (name && name !== existing.name) changes.push(`name: "${existing.name}" → "${name}"`);
  if (content && content !== existing.content) {
    const oldSnip = existing.content.substring(0, 50);
    const newSnip = content.substring(0, 50);
    changes.push(`content updated (was: "${oldSnip}…")`);
  }
  if (sourceFilter !== undefined && sourceFilter !== existing.sourceFilter) changes.push(`source filter: "${existing.sourceFilter || "any"}" → "${sourceFilter || "any"}"`);
  if (stageFilter !== undefined && stageFilter !== existing.stageFilter) changes.push(`stage filter: "${existing.stageFilter || "any"}" → "${stageFilter || "any"}"`);
  if (isActive !== undefined && isActive !== existing.isActive) changes.push(isActive ? "reactivated" : "deactivated");

  const newVersion = existing.version + 1;
  const updates: Record<string, unknown> = { version: newVersion, updatedAt: new Date() };
  if (name !== undefined) updates.name = name;
  if (content !== undefined) updates.content = content;
  if (sourceFilter !== undefined) updates.sourceFilter = sourceFilter || null;
  if (stageFilter !== undefined) updates.stageFilter = stageFilter || null;
  if (isActive !== undefined) updates.isActive = isActive;

  const [updated] = await db.update(scriptsTable).set(updates)
    .where(eq(scriptsTable.id, id)).returning();

  if (changes.length > 0) {
    await db.insert(changeLogsTable).values({
      tenantId,
      date: new Date().toISOString().split("T")[0],
      title: `${existing.type} script updated: "${updated.name}" (v${newVersion})`,
      description: `Changes to ${existing.type} script "${existing.name}": ${changes.join("; ")}.`,
      category: "scripts",
    });
  }

  res.json(updated);
});

router.put("/scripts/:id/revert/:versionId", requireRole("super_admin", "agency_user", "client_admin"), async (req, res) => {
  const id = parseInt(req.params.id);
  const versionId = parseInt(req.params.versionId);
  const tenantId = resolveTenantId(req);
  if (!tenantId) { res.status(400).json({ error: "No tenant" }); return; }

  const [existing] = await db.select().from(scriptsTable)
    .where(and(eq(scriptsTable.id, id), eq(scriptsTable.tenantId, tenantId)));
  if (!existing) { res.status(404).json({ error: "Script not found" }); return; }

  const [targetVersion] = await db.select().from(scriptVersionsTable)
    .where(and(eq(scriptVersionsTable.id, versionId), eq(scriptVersionsTable.scriptId, id)));
  if (!targetVersion) { res.status(404).json({ error: "Version not found" }); return; }

  await db.insert(scriptVersionsTable).values({
    scriptId: existing.id,
    version: existing.version,
    content: existing.content,
    name: existing.name,
    sourceFilter: existing.sourceFilter,
    stageFilter: existing.stageFilter,
    editedBy: req.session.userId ?? null,
  });

  const newVersion = existing.version + 1;
  const [updated] = await db.update(scriptsTable).set({
    content: targetVersion.content,
    name: targetVersion.name,
    sourceFilter: targetVersion.sourceFilter,
    stageFilter: targetVersion.stageFilter,
    version: newVersion,
    updatedAt: new Date(),
  }).where(eq(scriptsTable.id, id)).returning();

  await db.insert(changeLogsTable).values({
    tenantId,
    date: new Date().toISOString().split("T")[0],
    title: `${existing.type} script reverted: "${updated.name}" (v${newVersion})`,
    description: `Reverted ${existing.type} script "${existing.name}" to version ${targetVersion.version}.`,
    category: "scripts",
  });

  res.json(updated);
});

router.delete("/scripts/:id", requireRole("super_admin", "agency_user", "client_admin"), async (req, res) => {
  const id = parseInt(req.params.id);
  const tenantId = resolveTenantId(req);
  if (!tenantId) { res.status(400).json({ error: "No tenant" }); return; }

  const [script] = await db.select().from(scriptsTable)
    .where(and(eq(scriptsTable.id, id), eq(scriptsTable.tenantId, tenantId)));
  if (!script) { res.status(404).json({ error: "Script not found" }); return; }

  await db.delete(scriptVersionsTable).where(eq(scriptVersionsTable.scriptId, id));
  await db.delete(scriptsTable).where(eq(scriptsTable.id, id));

  await db.insert(changeLogsTable).values({
    tenantId,
    date: new Date().toISOString().split("T")[0],
    title: `${script.type} script deleted: "${script.name}"`,
    description: `Deleted ${script.type} script "${script.name}" (was version ${script.version}).`,
    category: "scripts",
  });

  res.json({ success: true });
});

export default router;
