import { Router, type IRouter } from "express";
import { db, savedQuestionsTable, tenantsTable } from "@workspace/db";
import { eq, and, desc } from "drizzle-orm";
import { processQuestionStream, generateSuggestions, type ConversationTurn } from "../services/chat-analytics";

const router: IRouter = Router();

async function resolveTenantId(req: { session: { userRole?: string; tenantId?: number | null; userId?: number } }, queryOrBodyTenantId?: number | string | null): Promise<number | null> {
  const role = req.session.userRole;
  const sessionTenantId = req.session.tenantId;
  const isAgency = role === "super_admin" || role === "agency_user";

  if (sessionTenantId) return sessionTenantId;

  if (isAgency && queryOrBodyTenantId) {
    const parsed = Number(queryOrBodyTenantId);
    if (!isNaN(parsed) && parsed > 0) {
      const [tenant] = await db.select({ id: tenantsTable.id }).from(tenantsTable).where(eq(tenantsTable.id, parsed)).limit(1);
      if (tenant) return parsed;
      return null;
    }
  }

  return null;
}

router.post("/chat/ask", async (req, res) => {
  const { question, conversationHistory, stream, tenantId: bodyTenantId } = req.body as {
    question?: string;
    conversationHistory?: ConversationTurn[];
    stream?: boolean;
    tenantId?: number;
  };
  if (!question || typeof question !== "string" || question.trim().length === 0) {
    res.status(400).json({ error: "Question is required" });
    return;
  }

  if (!req.session.userId) {
    res.status(401).json({ error: "Authentication required" });
    return;
  }

  const tenantId = await resolveTenantId(req, bodyTenantId);
  if (!tenantId) {
    res.status(400).json({ error: "Tenant context required. Please select a client." });
    return;
  }

  const history = Array.isArray(conversationHistory) ? conversationHistory.slice(-10) : [];

  if (stream) {
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders();

    try {
      await processQuestionStream(
        question.trim(),
        tenantId,
        history,
        (chunk) => {
          res.write(`data: ${JSON.stringify(chunk)}\n\n`);
        }
      );
    } catch (err) {
      console.error("[Chat] Stream error:", err);
      res.write(`data: ${JSON.stringify({ type: "text", content: 'root = ResponseCard([msg])\nmsg = Text("An error occurred while processing your question.")' })}\n\n`);
      res.write(`data: ${JSON.stringify({ type: "done", done: true })}\n\n`);
    }
    res.end();
    return;
  }

  try {
    let uiContent = "";
    await processQuestionStream(
      question.trim(),
      tenantId,
      history,
      (chunk) => {
        if (chunk.type === "text" && chunk.content) {
          uiContent += chunk.content;
        }
      }
    );
    res.json({ question: question.trim(), uiContent });
  } catch (err) {
    console.error("[Chat] Error processing question:", err);
    res.status(500).json({ error: "Failed to process question" });
  }
});

router.get("/chat/suggestions", async (req, res) => {
  if (!req.session.userId) {
    res.status(401).json({ error: "Authentication required" });
    return;
  }

  const tenantId = await resolveTenantId(req, req.query.tenantId as string | undefined);
  if (!tenantId) {
    res.json({ suggestions: ["How am I performing this month?", "What's my cost per lead?", "Show all campaigns"] });
    return;
  }

  try {
    const suggestions = await generateSuggestions(tenantId);
    res.json({ suggestions });
  } catch (err) {
    console.error("[Chat] Error generating suggestions:", err);
    res.json({ suggestions: ["How am I performing this month?", "What's my cost per lead?", "Show all campaigns"] });
  }
});

router.get("/chat/saved-questions", async (req, res) => {
  const userId = req.session.userId;
  if (!userId) {
    res.status(401).json({ error: "Not authenticated" });
    return;
  }

  const tenantId = await resolveTenantId(req, req.query.tenantId as string | undefined);
  if (!tenantId) {
    res.json({ questions: [] });
    return;
  }

  const questions = await db.select()
    .from(savedQuestionsTable)
    .where(and(eq(savedQuestionsTable.userId, userId), eq(savedQuestionsTable.tenantId, tenantId)))
    .orderBy(desc(savedQuestionsTable.createdAt));

  res.json({ questions });
});

router.post("/chat/saved-questions", async (req, res) => {
  const { question, tenantId: bodyTenantId } = req.body as { question?: string; tenantId?: number };
  if (!question || typeof question !== "string") {
    res.status(400).json({ error: "Question is required" });
    return;
  }

  const userId = req.session.userId;
  if (!userId) {
    res.status(401).json({ error: "Not authenticated" });
    return;
  }

  const tenantId = await resolveTenantId(req, bodyTenantId);
  if (!tenantId) {
    res.status(400).json({ error: "Tenant context required" });
    return;
  }

  const [saved] = await db.insert(savedQuestionsTable).values({
    userId,
    tenantId,
    question: question.trim(),
  }).returning();

  res.json({ question: saved });
});

router.delete("/chat/saved-questions/:id", async (req, res) => {
  const id = Number(req.params.id);
  const userId = req.session.userId;
  if (!userId) {
    res.status(401).json({ error: "Not authenticated" });
    return;
  }

  const tenantId = await resolveTenantId(req, req.query.tenantId as string | undefined);
  if (!tenantId) {
    res.status(400).json({ error: "Tenant context required" });
    return;
  }

  await db.delete(savedQuestionsTable).where(
    and(
      eq(savedQuestionsTable.id, id),
      eq(savedQuestionsTable.userId, userId),
      eq(savedQuestionsTable.tenantId, tenantId),
    ),
  );

  res.json({ success: true });
});

export default router;
