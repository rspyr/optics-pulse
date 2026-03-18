import { PremiumCard, GradientHeading } from "@/components/ui-helpers";

export default function Settings() {
  return (
    <div className="space-y-6 max-w-4xl">
      <header>
        <GradientHeading className="text-3xl md:text-4xl mb-2">Settings</GradientHeading>
        <p className="font-sub text-muted-foreground text-sm tracking-wide">SYSTEM CONFIGURATION</p>
      </header>

      <PremiumCard>
        <h3 className="text-xl font-display text-white mb-6">API Integrations</h3>
        <form className="space-y-5" onSubmit={(e) => e.preventDefault()}>
          <div className="space-y-2">
            <label className="text-sm font-medium text-gray-300">ServiceTitan Tenant ID</label>
            <input 
              type="text" 
              className="w-full bg-background border border-white/10 text-white rounded-lg px-4 py-3 focus:outline-none focus:border-primary focus:ring-1 focus:ring-primary transition-all"
              placeholder="e.g. 123456"
            />
          </div>
          <div className="space-y-2">
            <label className="text-sm font-medium text-gray-300">ServiceTitan API Key (Encrypted at rest)</label>
            <input 
              type="password" 
              className="w-full bg-background border border-white/10 text-white rounded-lg px-4 py-3 focus:outline-none focus:border-primary focus:ring-1 focus:ring-primary transition-all"
              placeholder="••••••••••••••••••••••••"
            />
          </div>
          <button className="bg-primary hover:bg-primary/90 text-white font-medium px-6 py-3 rounded-lg transition-all mt-4">
            Save Configuration
          </button>
        </form>
      </PremiumCard>

      <PremiumCard>
        <h3 className="text-xl font-display text-white mb-2">Capture Script</h3>
        <p className="text-sm text-muted-foreground mb-6">Install this script in the &lt;head&gt; of your website to enable GCLID capture and cookie storage.</p>
        
        <div className="bg-background border border-white/10 rounded-lg p-4 font-mono text-sm text-emerald-400 overflow-x-auto relative group">
          <pre>{`<script src="https://api.marketingos.app/tracker.js" data-tenant="1"></script>`}</pre>
          <button className="absolute top-2 right-2 bg-white/10 hover:bg-white/20 text-white px-3 py-1 rounded text-xs opacity-0 group-hover:opacity-100 transition-opacity">
            Copy
          </button>
        </div>
      </PremiumCard>
    </div>
  );
}
