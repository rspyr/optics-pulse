import { useState, useEffect } from "react";
import { useAuth } from "@/components/auth-context";

const REMEMBER_KEY = "mos_remember_credentials";

export default function Login() {
  const { login } = useAuth();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [rememberMe, setRememberMe] = useState(false);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    document.title = "Optics";
    const link = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
    if (link) {
      link.href = "/optics-logo.png";
      link.type = "image/png";
    }
  }, []);

  useEffect(() => {
    try {
      const stored = localStorage.getItem(REMEMBER_KEY);
      if (stored) {
        const { email: savedEmail, password: savedPassword } = JSON.parse(stored);
        if (savedEmail) setEmail(savedEmail);
        if (savedPassword) setPassword(savedPassword);
        setRememberMe(true);
      }
    } catch {}
  }, []);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setLoading(true);
    try {
      await login(email, password);
      if (rememberMe) {
        localStorage.setItem(REMEMBER_KEY, JSON.stringify({ email, password }));
      } else {
        localStorage.removeItem(REMEMBER_KEY);
      }
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Login failed");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-background flex items-center justify-center px-4">
      <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_top_right,_var(--tw-gradient-stops))] from-secondary/20 via-background to-background pointer-events-none" />

      <div className="relative z-10 w-full max-w-md">
        <div className="flex flex-col items-center mb-8">
          <div className="flex items-center gap-3 mb-2">
            <img src="/optics-logo.png" alt="Optics" className="w-12 h-12" />
            <span className="font-display text-3xl tracking-widest text-white mt-1">OPTICS</span>
          </div>
          <div className="flex items-center gap-2 mb-4">
            <span className="text-muted-foreground text-base font-medium">+</span>
            <img src="/pulse-logo.png" alt="Pulse" className="w-5 h-5" />
            <span className="font-display text-base tracking-widest text-white">PULSE</span>
          </div>
          <p className="text-muted-foreground text-sm font-sub tracking-wide">HVAC LAUNCH ATTRIBUTION PLATFORM</p>
        </div>

        <div className="bg-card/50 backdrop-blur-xl border border-white/5 rounded-xl p-8 shadow-2xl">
          <h2 className="font-display text-xl text-white mb-6">Sign In</h2>

          <form onSubmit={handleSubmit} className="space-y-5">
            {error && (
              <div className="bg-red-500/10 border border-red-500/20 text-red-400 px-4 py-3 rounded-lg text-sm">
                {error}
              </div>
            )}

            <div>
              <label className="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-2 block">
                Email
              </label>
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className="w-full bg-background/50 border border-white/10 rounded-lg px-4 py-3 text-white text-sm focus:outline-none focus:ring-2 focus:ring-primary/50 focus:border-primary/30 transition-all"
                placeholder="Enter email"
                required
              />
            </div>

            <div>
              <label className="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-2 block">
                Password
              </label>
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="w-full bg-background/50 border border-white/10 rounded-lg px-4 py-3 text-white text-sm focus:outline-none focus:ring-2 focus:ring-primary/50 focus:border-primary/30 transition-all"
                placeholder="Enter password"
                required
              />
            </div>

            <label className="flex items-center gap-2 cursor-pointer select-none">
              <input
                type="checkbox"
                checked={rememberMe}
                onChange={(e) => {
                  setRememberMe(e.target.checked);
                  if (!e.target.checked) {
                    localStorage.removeItem(REMEMBER_KEY);
                  }
                }}
                className="w-4 h-4 rounded border-white/20 bg-background/50 text-primary focus:ring-primary/50 focus:ring-offset-0 accent-primary"
              />
              <span className="text-sm text-muted-foreground">Remember me</span>
            </label>

            <button
              type="submit"
              disabled={loading}
              className="w-full bg-primary hover:bg-primary/90 disabled:opacity-50 text-white font-medium py-3 rounded-lg transition-all shadow-[0_0_15px_rgba(242,5,5,0.3)] hover:shadow-[0_0_25px_rgba(242,5,5,0.5)]"
            >
              {loading ? "Signing in..." : "Sign In"}
            </button>
          </form>

        </div>
      </div>
    </div>
  );
}
