import React from "react";
import { Link, useLocation } from "wouter";
import ChatDrawer from "./chat-drawer";
import { 
  LayoutDashboard, 
  Users, 
  Building2, 
  Shield, 
  Link as LinkIcon, 
  Settings,
  LogOut,
  Menu,
  UserCog,
  Building,
  GraduationCap,
  BookOpen,
  Trophy,
  Zap,
  ClipboardList,
  GitBranch,
  FileText,
  BarChart3,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useAuth } from "@/components/auth-context";

const PulseIcon = ({ className }: { className?: string }) => (
  <img src="/pulse-logo.png" alt="" className={className} style={{ objectFit: "contain" }} />
);

const AGENCY_NAV = [
  { href: "/", label: "Command Center", icon: LayoutDashboard },
  { href: "/internal", label: "God View", icon: Shield },
  { href: "/leads", label: "Pulse", icon: PulseIcon },
  { href: "/sales-manager", label: "Sales Manager", icon: BarChart3 },
  { href: "/clients", label: "Client Portal", icon: Building2 },
  { href: "/attribution", label: "Attribution", icon: LinkIcon },
  { href: "/admin/tenants", label: "Tenants", icon: Building },
  { href: "/admin/users", label: "Users", icon: UserCog },
  { href: "/leaderboards", label: "Leaderboards", icon: Trophy },
  { href: "/automation", label: "Automation", icon: Zap },
  { href: "/admin/scripts", label: "Scripts", icon: FileText },
  { href: "/admin/change-logs", label: "Change Log", icon: ClipboardList },
  { href: "/admin/funnels", label: "Funnels & Scripts", icon: GitBranch },
  { href: "/admin/training", label: "Training & LMS", icon: GraduationCap },
];

const CLIENT_NAV_ADMIN_BASE = [
  { href: "/", label: "Dashboard", icon: LayoutDashboard },
  { href: "/leads", label: "Pulse", icon: PulseIcon },
  { href: "/sales-manager", label: "Sales Manager", icon: BarChart3 },
  { href: "/attribution", label: "Attribution", icon: LinkIcon },
  { href: "/training", label: "Training", icon: BookOpen },
  { href: "/settings", label: "Client Settings", icon: Settings },
];

const CLIENT_NAV_BASE = [
  { href: "/", label: "Dashboard", icon: LayoutDashboard },
  { href: "/leads", label: "Pulse", icon: PulseIcon },
  { href: "/attribution", label: "Attribution", icon: LinkIcon },
  { href: "/training", label: "Training", icon: BookOpen },
  { href: "/settings", label: "Client Settings", icon: Settings },
];

function getClientNav(isAdmin: boolean, leaderboardVisible: boolean) {
  const base = isAdmin ? [...CLIENT_NAV_ADMIN_BASE] : [...CLIENT_NAV_BASE];
  if (leaderboardVisible) {
    const settingsIdx = base.findIndex(item => item.href === "/settings");
    base.splice(settingsIdx >= 0 ? settingsIdx : base.length, 0, { href: "/leaderboards", label: "Leaderboards", icon: Trophy });
  }
  return base;
}

export function AppLayout({ children }: { children: React.ReactNode }) {
  const [location] = useLocation();
  const [isMobileOpen, setIsMobileOpen] = React.useState(false);
  const { user, logout, isAgency } = useAuth();

  const leaderboardVisible = user?.leaderboardConfig?.visible ?? false;
  const navItems = isAgency ? AGENCY_NAV : getClientNav(user?.role === "client_admin", leaderboardVisible);

  return (
    <div className="flex h-screen overflow-hidden bg-background">
      <button 
        className="md:hidden fixed top-4 left-4 z-50 p-2 bg-card rounded-md border border-white/10"
        onClick={() => setIsMobileOpen(!isMobileOpen)}
      >
        <Menu className="w-5 h-5 text-white" />
      </button>

      <aside className={cn(
        "fixed md:static inset-y-0 left-0 z-40 w-64 bg-card/80 backdrop-blur-2xl border-r border-white/5 transition-transform duration-300 ease-in-out flex flex-col",
        isMobileOpen ? "translate-x-0" : "-translate-x-full md:translate-x-0"
      )}>
        <div className="p-6 flex items-center gap-3">
          <img src="/optics-logo.png" alt="Optics" className="w-8 h-8" />
          <span className="font-display text-xl tracking-widest text-white mt-1">OPTICS</span>
        </div>

        {user && (
          <div className="px-6 pb-4">
            <div className="bg-white/5 rounded-lg px-3 py-2 border border-white/5">
              <p className="text-sm font-medium text-white truncate">{user.name}</p>
              <p className="text-xs text-muted-foreground truncate">
                {user.role === "super_admin" ? "Super Admin" :
                 user.role === "agency_user" ? "Agency User" :
                 user.role === "client_admin" ? "Client Admin" : "Client User"}
                {user.tenantName ? ` · ${user.tenantName}` : ""}
              </p>
            </div>
          </div>
        )}

        <nav className="flex-1 px-4 space-y-1 overflow-y-auto">
          {navItems.map((item) => {
            const isActive = location === item.href || (item.href !== "/" && location.startsWith(item.href));
            return (
              <Link 
                key={item.href} 
                href={item.href}
                onClick={() => setIsMobileOpen(false)}
                className={cn(
                  "flex items-center gap-3 px-4 py-2.5 rounded-lg text-sm font-medium transition-all duration-200 group relative",
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
          <button 
            onClick={logout}
            className="flex items-center gap-3 px-4 py-3 w-full rounded-lg text-sm font-medium text-muted-foreground hover:text-white hover:bg-white/5 transition-all"
          >
            <LogOut className="w-5 h-5" />
            Sign Out
          </button>
        </div>
      </aside>

      <main className="flex-1 overflow-y-auto relative">
        <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_top_right,_var(--tw-gradient-stops))] from-secondary/20 via-background to-background pointer-events-none" />
        <div className="relative z-10 p-6 md:p-10 min-h-full">
          {children}
        </div>
      </main>

      <ChatDrawer tenantId={user?.tenantId ?? undefined} />
    </div>
  );
}
