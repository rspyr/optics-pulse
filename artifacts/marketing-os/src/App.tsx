import { Switch, Route, Router as WouterRouter } from "wouter";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import NotFound from "@/pages/not-found";

import { AppLayout } from "@/components/layout";
import Dashboard from "@/pages/dashboard";
import Leads from "@/pages/leads";
import Clients from "@/pages/clients";
import Internal from "@/pages/internal";
import Attribution from "@/pages/attribution";
import Settings from "@/pages/settings";

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

function Router() {
  return (
    <AppLayout>
      <Switch>
        <Route path="/" component={Dashboard} />
        <Route path="/leads" component={Leads} />
        <Route path="/clients" component={Clients} />
        <Route path="/internal" component={Internal} />
        <Route path="/attribution" component={Attribution} />
        <Route path="/settings" component={Settings} />
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
        <WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, "")}>
          <Router />
        </WouterRouter>
        <Toaster />
      </TooltipProvider>
    </QueryClientProvider>
  );
}

export default App;
