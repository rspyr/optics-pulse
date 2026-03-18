import { useState } from "react";
import { useAuth } from "@/components/auth-context";

export default function Login() {
  const { login } = useAuth();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setLoading(true);
    try {
      await login(email, password);
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
        <div className="text-center mb-8">
          <div className="inline-flex items-center gap-3 mb-6">
            <div className="w-12 h-12 rounded-xl bg-primary flex items-center justify-center shadow-[0_0_25px_rgba(242,5,5,0.5)]">
              <span className="font-display text-white text-2xl leading-none pt-1">M</span>
            </div>
            <span className="font-display text-3xl tracking-widest text-white mt-1">MARKETING OS</span>
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
                placeholder="admin@hvaclaunch.com"
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

            <button
              type="submit"
              disabled={loading}
              className="w-full bg-primary hover:bg-primary/90 disabled:opacity-50 text-white font-medium py-3 rounded-lg transition-all shadow-[0_0_15px_rgba(242,5,5,0.3)] hover:shadow-[0_0_25px_rgba(242,5,5,0.5)]"
            >
              {loading ? "Signing in..." : "Sign In"}
            </button>
          </form>

          <div className="mt-6 pt-6 border-t border-white/5">
            <p className="text-muted-foreground text-xs text-center">
              Demo accounts: admin@hvaclaunch.com / brandon@apexhvac.com
            </p>
            <p className="text-muted-foreground text-xs text-center mt-1">
              Password: demo1234
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
