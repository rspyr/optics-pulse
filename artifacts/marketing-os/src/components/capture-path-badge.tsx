// Task #294 — surface non-`native` capture paths as a small chip so operators
// can tell at a glance when pulse.js had to fall back to a builder-specific
// or wide-scan rescue path (which usually means the customer's HTML is worth
// investigating). Originally lived in `verify-tracker.tsx` for the live feed;
// extracted in Task #299 so the historical attribution side-peek renders the
// same chip with identical wording.
export const CAPTURE_PATH_BADGES: Record<string, { label: string; tooltip: string; classes: string }> = {
  "honeypot-rescue": {
    label: "honeypot-rescue",
    tooltip:
      "Captured via pulse.js's wide-scan rescue path because the form's only named inputs were anti-bot decoys (e.g. company_url). The visible inputs likely bind via React state without a name= attribute. Worth investigating the customer's HTML.",
    classes: "bg-amber-500/15 text-amber-200 border-amber-400/30",
  },
  leadconnector: {
    label: "leadconnector",
    tooltip:
      "Captured from a GoHighLevel / LeadConnector embed (msgsndr.com / leadconnectorhq.com / ghl.io). Pulse.js used the LeadConnector-specific path instead of native FormData.",
    classes: "bg-purple-500/15 text-purple-200 border-purple-400/30",
  },
  gravity: {
    label: "gravity",
    tooltip: "Captured from a Gravity Forms (WordPress) submission via the gravity-specific path.",
    classes: "bg-cyan-500/15 text-cyan-200 border-cyan-400/30",
  },
  wpcf7: {
    label: "wpcf7",
    tooltip: "Captured from a Contact Form 7 (WordPress) submission via the wpcf7-specific path.",
    classes: "bg-cyan-500/15 text-cyan-200 border-cyan-400/30",
  },
};

export function CapturePathBadge({ formType }: { formType: string | null | undefined }) {
  if (!formType) return null;
  const cfg = CAPTURE_PATH_BADGES[formType];
  if (!cfg) return null;
  return (
    <span
      className={`text-[11px] px-2 py-0.5 rounded border cursor-help ${cfg.classes}`}
      title={cfg.tooltip}
      data-testid={`capture-path-badge-${cfg.label}`}
    >
      capture: {cfg.label}
    </span>
  );
}
