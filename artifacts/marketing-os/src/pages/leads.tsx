import { useListLeads } from "@workspace/api-client-react";
import { PremiumCard, GradientHeading, Badge } from "@/components/ui-helpers";
import { cn } from "@/lib/utils";
import { format } from "date-fns";
import { Search, Filter, Phone, Mail, MessageSquare } from "lucide-react";
import { useState } from "react";

export default function Leads() {
  const [statusFilter, setStatusFilter] = useState<string>("all");
  
  const { data, isLoading } = useListLeads({ limit: 50 });

  // Fallback data when API is unavailable
  const leads = data?.leads || [
    { id: 1, firstName: "John", lastName: "Smith", source: "Google Ads", interestType: "Heat Pump", status: "new", createdAt: new Date().toISOString(), phone: "(555) 123-4567" },
    { id: 2, firstName: "Sarah", lastName: "Johnson", source: "Meta Leads", interestType: "AC Repair", status: "contacted", createdAt: new Date(Date.now() - 3600000).toISOString(), phone: "(555) 987-6543" },
    { id: 3, firstName: "Michael", lastName: "Brown", source: "Organic Search", interestType: "Full System", status: "booked", createdAt: new Date(Date.now() - 86400000).toISOString(), phone: "(555) 456-7890" },
    { id: 4, firstName: "Emily", lastName: "Davis", source: "Google Ads", interestType: "Furnace", status: "sold", createdAt: new Date(Date.now() - 172800000).toISOString(), phone: "(555) 234-5678" },
    { id: 5, firstName: "David", lastName: "Wilson", source: "Direct", interestType: "Maintenance", status: "lost", createdAt: new Date(Date.now() - 259200000).toISOString(), phone: "(555) 876-5432" },
  ];

  const filteredLeads = statusFilter === "all" ? leads : leads.filter(l => l.status === statusFilter);

  const getStatusBadge = (status: string) => {
    switch(status) {
      case 'new': return <Badge variant="danger" className="animate-pulse">NEW LEAD</Badge>;
      case 'contacted': return <Badge variant="warning">CONTACTED</Badge>;
      case 'booked': return <Badge variant="success">BOOKED</Badge>;
      case 'sold': return <Badge variant="default" className="bg-primary/20 text-white border-primary/50">SOLD</Badge>;
      case 'lost': return <Badge variant="neutral">LOST</Badge>;
      default: return <Badge variant="neutral">{status.toUpperCase()}</Badge>;
    }
  };

  return (
    <div className="space-y-6">
      <header className="flex flex-col md:flex-row md:items-end justify-between gap-4">
        <div>
          <GradientHeading className="text-3xl md:text-4xl mb-2">Leads HUD</GradientHeading>
          <p className="font-sub text-muted-foreground text-sm tracking-wide">SPEED-TO-LEAD COMMAND CENTER</p>
        </div>
      </header>

      <PremiumCard className="p-0 overflow-hidden">
        <div className="p-4 border-b border-white/5 flex flex-col sm:flex-row gap-4 justify-between items-center bg-white/[0.02]">
          <div className="relative w-full sm:w-96">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
            <input 
              type="text" 
              placeholder="Search leads by name, phone..." 
              className="w-full bg-background border border-white/10 text-white text-sm rounded-lg pl-10 pr-4 py-2.5 focus:outline-none focus:border-primary/50 focus:ring-1 focus:ring-primary/50 transition-all"
            />
          </div>
          <div className="flex gap-2 w-full sm:w-auto overflow-x-auto pb-2 sm:pb-0">
            {['all', 'new', 'contacted', 'booked', 'sold'].map(s => (
              <button 
                key={s}
                onClick={() => setStatusFilter(s)}
                className={cn(
                  "px-4 py-2 text-xs font-medium rounded-lg uppercase tracking-wider transition-colors whitespace-nowrap",
                  statusFilter === s 
                    ? "bg-white/10 text-white border border-white/20" 
                    : "text-muted-foreground hover:text-white hover:bg-white/5 border border-transparent"
                )}
              >
                {s}
              </button>
            ))}
          </div>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse">
            <thead>
              <tr className="border-b border-white/5 bg-background/50">
                <th className="p-4 text-xs font-medium text-muted-foreground uppercase tracking-wider">Lead</th>
                <th className="p-4 text-xs font-medium text-muted-foreground uppercase tracking-wider">Source</th>
                <th className="p-4 text-xs font-medium text-muted-foreground uppercase tracking-wider">Interest</th>
                <th className="p-4 text-xs font-medium text-muted-foreground uppercase tracking-wider">Status</th>
                <th className="p-4 text-xs font-medium text-muted-foreground uppercase tracking-wider">Time</th>
                <th className="p-4 text-xs font-medium text-muted-foreground uppercase tracking-wider text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-white/5">
              {isLoading && leads.length === 0 ? (
                <tr><td colSpan={6} className="p-8 text-center text-muted-foreground">Loading leads...</td></tr>
              ) : filteredLeads.map((lead) => (
                <tr key={lead.id} className="group hover:bg-white/[0.02] transition-colors">
                  <td className="p-4">
                    <div className="font-medium text-white">{lead.firstName} {lead.lastName}</div>
                    <div className="text-xs text-muted-foreground mt-1">{lead.phone}</div>
                  </td>
                  <td className="p-4 text-sm text-gray-300">{lead.source}</td>
                  <td className="p-4 text-sm text-gray-300">{lead.interestType || '-'}</td>
                  <td className="p-4">{getStatusBadge(lead.status)}</td>
                  <td className="p-4 text-sm text-muted-foreground">
                    {format(new Date(lead.createdAt), 'MMM d, h:mm a')}
                  </td>
                  <td className="p-4 text-right">
                    <div className="flex items-center justify-end gap-2 opacity-0 group-hover:opacity-100 transition-opacity">
                      <button className="p-2 bg-white/5 hover:bg-primary/20 hover:text-primary rounded-md text-muted-foreground transition-colors" title="Call">
                        <Phone className="w-4 h-4" />
                      </button>
                      <button className="p-2 bg-white/5 hover:bg-primary/20 hover:text-primary rounded-md text-muted-foreground transition-colors" title="SMS">
                        <MessageSquare className="w-4 h-4" />
                      </button>
                      <button className="p-2 bg-white/5 hover:bg-primary/20 hover:text-primary rounded-md text-muted-foreground transition-colors" title="Email">
                        <Mail className="w-4 h-4" />
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </PremiumCard>
    </div>
  );
}
