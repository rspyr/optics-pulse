import { Switch, Route, Router as WouterRouter, useLocation, Redirect } from "wouter";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import NotFound from "@/pages/not-found";

import { AuthProvider, useAuth } from "@/components/auth-context";
import { AppLayout } from "@/components/layout";
import Login from "@/pages/login";
import Dashboard from "@/pages/dashboard";
import Leads from "@/pages/leads";
import Clients from "@/pages/clients";
import Internal from "@/pages/internal";
import Attribution from "@/pages/attribution";
import Settings from "@/pages/settings";
import AdminTenants from "@/pages/admin-tenants";
import AdminUsers from "@/pages/admin-users";
import AdminTraining from "@/pages/admin-training";
import TrainingResources from "@/pages/training-resources";
import Leaderboards from "@/pages/leaderboards";
import Automation from "@/pages/automation";
import AdminChangeLogs from "@/pages/admin-change-logs";
import AdminFunnels from "@/pages/admin-funnels";
import AdminScripts from "@/pages/admin-scripts";

import soehneExtra from '@assets/soehne-extrafett_1773849837050.woff2';
import soehneDrei from '@assets/soehne-dreiviertelfett_1773849837042.woff2';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: false,
      refetchOnWindowFocus: false,
    },
  },
});

function AgencyGuard({ children }: { children: React.ReactNode }) {
  const { isAgency } = useAuth();
  if (!isAgency) return <Redirect to="/" />;
  return <>{children}</>;
}

function AuthenticatedRoutes() {
  const { user, loading, isAgency } = useAuth();
  const [location] = useLocation();

  if (loading) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <div className="text-center">
          <div className="w-12 h-12 rounded-xl bg-primary flex items-center justify-center shadow-[0_0_25px_rgba(242,5,5,0.5)] mx-auto mb-4 animate-pulse">
            <span className="font-display text-white text-2xl leading-none pt-1">M</span>
          </div>
          <p className="text-muted-foreground text-sm">Loading...</p>
        </div>
      </div>
    );
  }

  if (!user) {
    return <Login />;
  }

  const agencyOnlyPaths = ["/internal", "/clients", "/admin/tenants", "/admin/users", "/admin/training", "/admin/change-logs", "/admin/funnels", "/leaderboards", "/automation"];
  if (!isAgency && agencyOnlyPaths.includes(location)) {
    return <Redirect to="/" />;
  }

  if (isAgency && location === "/settings") {
    return <Redirect to="/admin/tenants" />;
  }

  return (
    <AppLayout>
      <Switch>
        <Route path="/">{() => isAgency ? <Dashboard key="dashboard" /> : <Clients key="clients" />}</Route>
        <Route path="/leads" component={Leads} />
        <Route path="/attribution" component={Attribution} />
        <Route path="/settings" component={Settings} />
        <Route path="/internal">{() => <AgencyGuard><Internal /></AgencyGuard>}</Route>
        <Route path="/clients">{() => <AgencyGuard><Clients /></AgencyGuard>}</Route>
        <Route path="/admin/tenants">{() => <AgencyGuard><AdminTenants /></AgencyGuard>}</Route>
        <Route path="/admin/users">{() => <AgencyGuard><AdminUsers /></AgencyGuard>}</Route>
        <Route path="/admin/training">{() => <AgencyGuard><AdminTraining /></AgencyGuard>}</Route>
        <Route path="/leaderboards">{() => <AgencyGuard><Leaderboards /></AgencyGuard>}</Route>
        <Route path="/automation">{() => <AgencyGuard><Automation /></AgencyGuard>}</Route>
        <Route path="/admin/change-logs">{() => <AgencyGuard><AdminChangeLogs /></AgencyGuard>}</Route>
        <Route path="/admin/funnels">{() => <AgencyGuard><AdminFunnels /></AgencyGuard>}</Route>
        <Route path="/admin/scripts" component={AdminScripts} />
        <Route path="/training" component={TrainingResources} />
        <Route component={NotFound} />
      </Switch>
    </AppLayout>
  );
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <style>{`
        @font-face {
          font-family: 'Soehne Extrafett';
          src: url('${soehneExtra}') format('woff2');
          font-weight: bold;
          font-style: normal;
          font-display: swap;
        }
        @font-face {
          font-family: 'Soehne Dreiviertelfett';
          src: url('${soehneDrei}') format('woff2');
          font-weight: 600;
          font-style: normal;
          font-display: swap;
        }
      `}</style>
      <TooltipProvider>
        <AuthProvider>
          <WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, "")}>
            <AuthenticatedRoutes />
          </WouterRouter>
        </AuthProvider>
        <Toaster />
      </TooltipProvider>
    </QueryClientProvider>
  );
}

export default App;
