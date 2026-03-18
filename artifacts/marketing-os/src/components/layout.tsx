import React from "react";
import { Link, useLocation } from "wouter";
import { 
  LayoutDashboard, 
  Users, 
  Building2, 
  Shield, 
  Link as LinkIcon, 
  Settings,
  LogOut,
  Menu
} from "lucide-react";
import { cn } from "@/lib/utils";

const NAV_ITEMS = [
  { href: "/", label: "Dashboard", icon: LayoutDashboard },
  { href: "/leads", label: "Leads HUD", icon: Users },
  { href: "/clients", label: "Client Portal", icon: Building2 },
  { href: "/internal", label: "God View", icon: Shield },
  { href: "/attribution", label: "Attribution", icon: LinkIcon },
  { href: "/settings", label: "Settings", icon: Settings },
];

export function AppLayout({ children }: { children: React.ReactNode }) {
  const [location] = useLocation();
  const [isMobileOpen, setIsMobileOpen] = React.useState(false);

  return (
    <div className="flex h-screen overflow-hidden bg-background">
      {/* Mobile sidebar toggle */}
      <button 
        className="md:hidden fixed top-4 left-4 z-50 p-2 bg-card rounded-md border border-white/10"
        onClick={() => setIsMobileOpen(!isMobileOpen)}
      >
        <Menu className="w-5 h-5 text-white" />
      </button>

      {/* Sidebar */}
      <aside className={cn(
        "fixed md:static inset-y-0 left-0 z-40 w-64 bg-card/80 backdrop-blur-2xl border-r border-white/5 transition-transform duration-300 ease-in-out flex flex-col",
        isMobileOpen ? "translate-x-0" : "-translate-x-full md:translate-x-0"
      )}>
        <div className="p-6 flex items-center gap-3">
          <div className="w-8 h-8 rounded-lg bg-primary flex items-center justify-center shadow-[0_0_15px_rgba(242,5,5,0.5)]">
            <span className="font-display text-white text-xl leading-none pt-1">M</span>
          </div>
          <span className="font-display text-xl tracking-widest text-white mt-1">MARKETING OS</span>
        </div>

        <nav className="flex-1 px-4 space-y-2 mt-4">
          {NAV_ITEMS.map((item) => {
            const isActive = location === item.href;
            return (
              <Link 
                key={item.href} 
                href={item.href}
                onClick={() => setIsMobileOpen(false)}
                className={cn(
                  "flex items-center gap-3 px-4 py-3 rounded-lg text-sm font-medium transition-all duration-200 group relative",
                  isActive 
                    ? "text-white bg-white/5" 
                    : "text-muted-foreground hover:text-white hover:bg-white/5"
                )}
              >
                {isActive && (
                  <span className="absolute left-0 top-1/2 -translate-y-1/2 w-1 h-6 bg-primary rounded-r-full shadow-[0_0_10px_rgba(242,5,5,0.5)]" />
                )}
                <item.icon className={cn("w-5 h-5 transition-colors", isActive ? "text-primary" : "text-muted-foreground group-hover:text-white")} />
                {item.label}
              </Link>
            );
          })}
        </nav>

        <div className="p-4 border-t border-white/5">
          <button className="flex items-center gap-3 px-4 py-3 w-full rounded-lg text-sm font-medium text-muted-foreground hover:text-white hover:bg-white/5 transition-all">
            <LogOut className="w-5 h-5" />
            Sign Out
          </button>
        </div>
      </aside>

      {/* Main Content */}
      <main className="flex-1 overflow-y-auto relative">
        <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_top_right,_var(--tw-gradient-stops))] from-secondary/20 via-background to-background pointer-events-none" />
        <div className="relative z-10 p-6 md:p-10 min-h-full">
          {children}
        </div>
      </main>
    </div>
  );
}
