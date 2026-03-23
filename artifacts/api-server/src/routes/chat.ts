import { Router, type IRouter } from "express";
import { db, savedQuestionsTable } from "@workspace/db";
import { eq, and, desc } from "drizzle-orm";
import { processQuestion, processQuestionStream, generateSuggestions, type ConversationTurn } from "../services/chat-analytics";

const router: IRouter = Router();

router.post("/chat/ask", async (req, res) => {
  const { question, conversationHistory, stream } = req.body as {
    question?: string;
    conversationHistory?: ConversationTurn[];
    stream?: boolean;
  };
  if (!question || typeof question !== "string" || question.trim().length === 0) {
    res.status(400).json({ error: "Question is required" });
    return;
  }

  if (!req.session.userId || !req.session.tenantId) {
    res.status(401).json({ error: "Authentication required" });
    return;
  }
  const tenantId = req.session.tenantId;
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
      res.write(`data: ${JSON.stringify({ type: "text", content: "An error occurred while processing your question." })}\n\n`);
      res.write(`data: ${JSON.stringify({ type: "done", done: true })}\n\n`);
    }
    res.end();
    return;
  }

  try {
    const result = await processQuestion(question.trim(), tenantId, history);
    res.json({ question: question.trim(), ...result });
  } catch (err) {
    console.error("[Chat] Error processing question:", err);
    res.status(500).json({ error: "Failed to process question" });
  }
});

router.get("/chat/suggestions", async (req, res) => {
  if (!req.session.userId || !req.session.tenantId) {
    res.status(401).json({ error: "Authentication required" });
    return;
  }
  const tenantId = req.session.tenantId;

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

  const tenantId = req.session.tenantId;
  if (!tenantId) {
    res.status(401).json({ error: "Not authenticated" });
    return;
  }
  const questions = await db.select()
    .from(savedQuestionsTable)
    .where(and(eq(savedQuestionsTable.userId, userId), eq(savedQuestionsTable.tenantId, tenantId)))
    .orderBy(desc(savedQuestionsTable.createdAt));

  res.json({ questions });
});

router.post("/chat/saved-questions", async (req, res) => {
  const { question } = req.body as { question?: string };
  if (!question || typeof question !== "string") {
    res.status(400).json({ error: "Question is required" });
    return;
  }

  const userId = req.session.userId;
  if (!userId) {
    res.status(401).json({ error: "Not authenticated" });
    return;
  }

  const tenantId = req.session.tenantId;
  if (!tenantId) {
    res.status(401).json({ error: "Not authenticated" });
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

  const tenantId = req.session.tenantId;
  if (!tenantId) {
    res.status(401).json({ error: "Not authenticated" });
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
