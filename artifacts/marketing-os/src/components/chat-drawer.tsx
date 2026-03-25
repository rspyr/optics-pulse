import { useState, useEffect, useRef, useCallback } from "react";
import { MessageCircle, X, Send, Bookmark, BookmarkCheck, Trash2, Sparkles, ChevronRight, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { Renderer } from "@openuidev/react-lang";
import { shadcnChatLibrary } from "@/lib/shadcn-genui";

const API_BASE = import.meta.env.VITE_API_URL || "";

interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  timestamp: Date;
  isStreaming?: boolean;
}

interface SavedQuestion {
  id: number;
  question: string;
  createdAt: string;
}

export default function ChatDrawer({ tenantId }: { tenantId?: number }) {
  const [isOpen, setIsOpen] = useState(false);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [suggestions, setSuggestions] = useState<string[]>([]);
  const [savedQuestions, setSavedQuestions] = useState<SavedQuestion[]>([]);
  const [showSaved, setShowSaved] = useState(false);
  const [savedSet, setSavedSet] = useState<Set<string>>(new Set());
  const [statusMessage, setStatusMessage] = useState<string>("");
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const scrollToBottom = useCallback(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, []);

  useEffect(() => {
    if (messages.length > 0) scrollToBottom();
  }, [messages, scrollToBottom]);

  useEffect(() => {
    setSuggestions([]);
    setMessages([]);
  }, [tenantId]);

  useEffect(() => {
    if (isOpen && tenantId && suggestions.length === 0) {
      fetch(`${API_BASE}/api/chat/suggestions${tenantId ? `?tenantId=${tenantId}` : ""}`, { credentials: "include" })
        .then(r => r.json())
        .then(d => setSuggestions(d.suggestions || []))
        .catch(() => {});
    }
  }, [isOpen, tenantId, suggestions.length]);

  useEffect(() => {
    if (isOpen) {
      fetch(`${API_BASE}/api/chat/saved-questions${tenantId ? `?tenantId=${tenantId}` : ""}`, { credentials: "include" })
        .then(r => r.json())
        .then(d => {
          setSavedQuestions(d.questions || []);
          setSavedSet(new Set((d.questions || []).map((q: SavedQuestion) => q.question)));
        })
        .catch(() => {});
    }
  }, [isOpen, tenantId]);

  const askQuestion = useCallback(async (question: string) => {
    if (!question.trim() || isLoading) return;

    const userMsg: ChatMessage = {
      id: crypto.randomUUID(),
      role: "user",
      content: question.trim(),
      timestamp: new Date(),
    };
    const assistantId = crypto.randomUUID();
    setMessages(prev => [...prev, userMsg]);
    setInput("");
    setIsLoading(true);
    setStatusMessage("Understanding your question...");

    setMessages(prev => [...prev, {
      id: assistantId,
      role: "assistant",
      content: "",
      timestamp: new Date(),
      isStreaming: true,
    }]);

    try {
      const history = messages.map(m => ({ role: m.role, content: m.content }));
      const res = await fetch(`${API_BASE}/api/chat/ask`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ question: question.trim(), conversationHistory: history, stream: true, ...(tenantId ? { tenantId } : {}) }),
      });

      if (!res.ok) {
        throw new Error("Request failed");
      }

      const reader = res.body?.getReader();
      if (!reader) throw new Error("No reader");

      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          const jsonStr = line.slice(6).trim();
          if (!jsonStr) continue;

          try {
            const chunk = JSON.parse(jsonStr);

            if (chunk.type === "status") {
              setStatusMessage(chunk.content || "");
            } else if (chunk.type === "text") {
              setMessages(prev => prev.map(m =>
                m.id === assistantId
                  ? { ...m, content: m.content + (chunk.content || "") }
                  : m
              ));
              setStatusMessage("");
            } else if (chunk.type === "done") {
              setMessages(prev => prev.map(m =>
                m.id === assistantId
                  ? { ...m, isStreaming: false }
                  : m
              ));
            }
          } catch {}
        }
      }

      setMessages(prev => prev.map(m =>
        m.id === assistantId ? { ...m, isStreaming: false } : m
      ));
    } catch {
      setMessages(prev => {
        const filtered = prev.filter(m => m.id !== assistantId);
        return [...filtered, {
          id: crypto.randomUUID(),
          role: "assistant" as const,
          content: 'root = ResponseCard([msg])\nmsg = Text("Sorry, I had trouble connecting. Please try again.")',
          timestamp: new Date(),
        }];
      });
    } finally {
      setIsLoading(false);
      setStatusMessage("");
    }
  }, [isLoading, messages, tenantId]);

  const saveQuestion = useCallback(async (question: string) => {
    try {
      const res = await fetch(`${API_BASE}/api/chat/saved-questions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ question, ...(tenantId ? { tenantId } : {}) }),
      });
      const data = await res.json();
      if (data.question) {
        setSavedQuestions(prev => [data.question, ...prev]);
        setSavedSet(prev => new Set([...prev, question]));
      }
    } catch {}
  }, [tenantId]);

  const deleteSavedQuestion = useCallback(async (id: number, question: string) => {
    try {
      await fetch(`${API_BASE}/api/chat/saved-questions/${id}${tenantId ? `?tenantId=${tenantId}` : ""}`, {
        method: "DELETE",
        credentials: "include",
      });
      setSavedQuestions(prev => prev.filter(q => q.id !== id));
      setSavedSet(prev => {
        const next = new Set(prev);
        next.delete(question);
        return next;
      });
    } catch {}
  }, [tenantId]);

  return (
    <>
      <button
        onClick={() => setIsOpen(true)}
        className={cn(
          "fixed bottom-6 right-6 z-40 flex items-center gap-2 px-4 py-3 rounded-full shadow-2xl transition-all",
          "bg-gradient-to-r from-[#002D5E] to-[#F20505] text-white hover:scale-105",
          isOpen && "hidden"
        )}
      >
        <MessageCircle className="w-5 h-5" />
        <span className="text-sm font-medium">Ask Your Data</span>
      </button>

      <div className={cn(
        "fixed top-0 right-0 z-50 h-full w-full sm:w-[440px] bg-[#0A0F1F] border-l border-white/10 shadow-2xl flex flex-col transition-transform duration-300",
        isOpen ? "translate-x-0" : "translate-x-full"
      )}>
        <div className="flex items-center justify-between p-4 border-b border-white/10">
          <div className="flex items-center gap-2">
            <Sparkles className="w-5 h-5 text-primary" />
            <h2 className="font-display text-lg text-white">Ask Your Data</h2>
            <span className="text-[10px] px-1.5 py-0.5 bg-primary/20 text-primary rounded-full font-medium">AI</span>
          </div>
          <div className="flex items-center gap-1">
            <button
              onClick={() => setShowSaved(!showSaved)}
              className={cn(
                "p-2 rounded-lg transition-colors",
                showSaved ? "bg-primary/20 text-primary" : "text-muted-foreground hover:text-white"
              )}
              title="Saved Questions"
            >
              <Bookmark className="w-4 h-4" />
            </button>
            <button
              onClick={() => { setMessages([]); setShowSaved(false); }}
              className="p-2 text-muted-foreground hover:text-white rounded-lg transition-colors"
              title="Clear Conversation"
            >
              <Trash2 className="w-4 h-4" />
            </button>
            <button onClick={() => setIsOpen(false)} className="p-2 text-muted-foreground hover:text-white rounded-lg">
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>

        {showSaved ? (
          <div className="flex-1 overflow-y-auto p-4 space-y-2">
            <h3 className="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-3">Saved Questions</h3>
            {savedQuestions.length === 0 ? (
              <p className="text-sm text-muted-foreground">No saved questions yet. Click the bookmark icon on any question to save it.</p>
            ) : (
              savedQuestions.map(sq => (
                <div
                  key={sq.id}
                  className="flex items-center gap-2 p-3 bg-white/5 rounded-lg border border-white/5 hover:border-white/10 transition-colors group"
                >
                  <button
                    onClick={() => { setShowSaved(false); askQuestion(sq.question); }}
                    className="flex-1 text-left text-sm text-white/80 hover:text-white"
                  >
                    {sq.question}
                  </button>
                  <button
                    onClick={() => deleteSavedQuestion(sq.id, sq.question)}
                    className="opacity-0 group-hover:opacity-100 text-muted-foreground hover:text-red-400 transition-opacity"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </div>
              ))
            )}
          </div>
        ) : (
          <div className="flex-1 overflow-y-auto p-4 space-y-4">
            {!tenantId && messages.length === 0 && (
              <div className="text-center py-12">
                <Sparkles className="w-10 h-10 text-primary/30 mx-auto mb-3" />
                <h3 className="text-white font-medium mb-1">Select a client first</h3>
                <p className="text-sm text-muted-foreground">Navigate to a client page or select a client to start asking about their data.</p>
              </div>
            )}
            {tenantId && messages.length === 0 && (
              <div className="space-y-4">
                <div className="text-center py-8">
                  <Sparkles className="w-10 h-10 text-primary/30 mx-auto mb-3" />
                  <h3 className="text-white font-medium mb-1">Ask anything about your marketing data</h3>
                  <p className="text-sm text-muted-foreground">Powered by AI — ask any question and get insights with visualizations</p>
                </div>

                {suggestions.length > 0 && (
                  <div className="space-y-2">
                    <div className="text-[10px] uppercase tracking-wider text-muted-foreground font-medium">Suggested Questions</div>
                    {suggestions.map((s, i) => (
                      <button
                        key={i}
                        onClick={() => askQuestion(s)}
                        className="w-full flex items-center gap-2 p-3 bg-white/5 rounded-lg border border-white/5 hover:border-primary/30 hover:bg-white/[0.07] text-left text-sm text-white/80 hover:text-white transition-all group"
                      >
                        <ChevronRight className="w-4 h-4 text-primary/50 group-hover:text-primary shrink-0" />
                        <span>{s}</span>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}

            {messages.map(msg => (
              <div key={msg.id} className={cn("flex", msg.role === "user" ? "justify-end" : "justify-start")}>
                <div className={cn(
                  "max-w-[90%] rounded-xl px-4 py-3",
                  msg.role === "user"
                    ? "bg-primary/20 text-white"
                    : "bg-white/5 border border-white/5 text-white/80"
                )}>
                  {msg.role === "user" ? (
                    <div className="text-sm whitespace-pre-line leading-relaxed">{msg.content}</div>
                  ) : (
                    <>
                      {msg.isStreaming && !msg.content && statusMessage && (
                        <div className="flex items-center gap-2">
                          <Loader2 className="w-4 h-4 animate-spin text-primary" />
                          <span className="text-sm text-muted-foreground">{statusMessage}</span>
                        </div>
                      )}

                      {msg.content && (
                        <Renderer
                          response={msg.content}
                          library={shadcnChatLibrary}
                          isStreaming={msg.isStreaming}
                        />
                      )}

                      {msg.isStreaming && msg.content && (
                        <span className="inline-block w-1.5 h-4 bg-primary/60 animate-pulse ml-0.5 align-middle mt-2" />
                      )}
                    </>
                  )}

                  {msg.role === "user" && (
                    <div className="flex justify-end mt-1">
                      <button
                        onClick={() => savedSet.has(msg.content) ? undefined : saveQuestion(msg.content)}
                        className={cn(
                          "text-muted-foreground hover:text-primary transition-colors",
                          savedSet.has(msg.content) && "text-primary"
                        )}
                        title={savedSet.has(msg.content) ? "Saved" : "Save question"}
                      >
                        {savedSet.has(msg.content) ? <BookmarkCheck className="w-3.5 h-3.5" /> : <Bookmark className="w-3.5 h-3.5" />}
                      </button>
                    </div>
                  )}
                </div>
              </div>
            ))}

            <div ref={messagesEndRef} />
          </div>
        )}

        <div className="p-4 border-t border-white/10">
          <form
            onSubmit={(e) => { e.preventDefault(); askQuestion(input); }}
            className="flex items-center gap-2"
          >
            <input
              ref={inputRef}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder="Ask anything about your data..."
              className="flex-1 bg-white/5 border border-white/10 rounded-lg px-4 py-2.5 text-sm text-white placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-primary/50 focus:border-primary/30"
              disabled={isLoading || !tenantId}
            />
            <button
              type="submit"
              disabled={isLoading || !input.trim() || !tenantId}
              className={cn(
                "p-2.5 rounded-lg transition-all",
                input.trim() ? "bg-primary text-white hover:bg-primary/80" : "bg-white/5 text-muted-foreground"
              )}
            >
              <Send className="w-4 h-4" />
            </button>
          </form>
        </div>
      </div>

      {isOpen && (
        <div
          className="fixed inset-0 z-40 bg-black/30 sm:hidden"
          onClick={() => setIsOpen(false)}
        />
      )}
    </>
  );
}
