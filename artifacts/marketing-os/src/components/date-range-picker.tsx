import { useState } from "react";
import { format } from "date-fns";
import type { DateRange } from "react-day-picker";
import { CalendarDays } from "lucide-react";
import { Calendar } from "@/components/ui/calendar";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";

export type DateRangePreset = "thisMonth" | "last30" | "lastMonth" | "custom";

// Serialize a Date using its LOCAL calendar fields, not UTC. Using
// toISOString() here would shift the date by a day for users east/west of UTC
// (e.g. picking the 1st could send the 30th), so format the local Y/M/D.
function ymd(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

// Resolve a preset to a concrete {startDate, endDate} pair in YYYY-MM-DD form.
// Custom is the only preset that doesn't compute its own dates — callers pass
// the user-picked range through unchanged.
export function resolvePreset(preset: DateRangePreset, custom?: { startDate?: string; endDate?: string }): { startDate?: string; endDate?: string } {
  const now = new Date();
  const end = ymd(now);
  switch (preset) {
    case "thisMonth": {
      const s = new Date(now.getFullYear(), now.getMonth(), 1);
      return { startDate: ymd(s), endDate: end };
    }
    case "lastMonth": {
      const s = new Date(now.getFullYear(), now.getMonth() - 1, 1);
      const e = new Date(now.getFullYear(), now.getMonth(), 0);
      return { startDate: ymd(s), endDate: ymd(e) };
    }
    case "custom":
      return { startDate: custom?.startDate, endDate: custom?.endDate };
    default: {
      const s = new Date(now.getTime() - 30 * 86400000);
      return { startDate: ymd(s), endDate: end };
    }
  }
}

const PRESET_LABELS: Record<Exclude<DateRangePreset, "custom">, string> = {
  thisMonth: "This Month",
  last30: "Last 30 Days",
  lastMonth: "Last Month",
};

// Parse a YYYY-MM-DD string into a local Date (midday avoids TZ off-by-one).
function parseYmd(s?: string): Date | undefined {
  if (!s) return undefined;
  const [y, m, d] = s.split("-").map(Number);
  if (!y || !m || !d) return undefined;
  return new Date(y, m - 1, d, 12);
}

interface DateRangePickerProps {
  preset: DateRangePreset;
  startDate?: string;
  endDate?: string;
  onChange: (preset: DateRangePreset, custom?: { startDate: string; endDate: string }) => void;
  className?: string;
}

export function DateRangePicker({ preset, startDate, endDate, onChange, className }: DateRangePickerProps) {
  const [open, setOpen] = useState(false);
  const selectedRange: DateRange | undefined =
    startDate || endDate ? { from: parseYmd(startDate), to: parseYmd(endDate) } : undefined;

  const triggerLabel =
    preset === "custom"
      ? startDate && endDate
        ? `${format(parseYmd(startDate)!, "MMM d, yyyy")} – ${format(parseYmd(endDate)!, "MMM d, yyyy")}`
        : "Custom Range"
      : PRESET_LABELS[preset];

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className={cn(
            "flex items-center gap-2 bg-card border border-white/10 rounded-lg px-3 py-2 text-white text-sm hover:border-white/20 transition-colors focus:outline-none focus:ring-1 focus:ring-primary/50",
            className,
          )}
        >
          <CalendarDays className="w-4 h-4 text-muted-foreground" />
          <span>{triggerLabel}</span>
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-auto p-0" align="end">
        <div className="flex flex-col sm:flex-row">
          <div className="flex flex-row sm:flex-col gap-1 p-3 border-b sm:border-b-0 sm:border-r border-white/10">
            {(Object.keys(PRESET_LABELS) as Array<Exclude<DateRangePreset, "custom">>).map((key) => (
              <button
                key={key}
                type="button"
                onClick={() => {
                  onChange(key);
                  setOpen(false);
                }}
                className={cn(
                  "text-left whitespace-nowrap rounded-md px-3 py-1.5 text-sm transition-colors",
                  preset === key
                    ? "bg-primary/20 text-white"
                    : "text-muted-foreground hover:bg-white/5 hover:text-white",
                )}
              >
                {PRESET_LABELS[key]}
              </button>
            ))}
          </div>
          <div className="p-3">
            <Calendar
              mode="range"
              numberOfMonths={2}
              defaultMonth={selectedRange?.from}
              selected={selectedRange}
              onSelect={(range) => {
                if (range?.from && range?.to) {
                  onChange("custom", { startDate: ymd(range.from), endDate: ymd(range.to) });
                  setOpen(false);
                }
              }}
            />
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}
