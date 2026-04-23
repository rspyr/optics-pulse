# Pulse / Marketing OS — Brand & Styling Guide

A complete, copy-paste-ready brand and styling reference for the Marketing OS app. Drop this whole file into another project and instruct the AI to "redesign the app to match this brand guide" — it contains every token, font, color, component pattern, and CSS file needed to reproduce the look.

---

## 1. Brand Identity

**Name:** Pulse / Marketing OS
**Vibe:** High-contrast, premium, confident. A dark "operator console" aesthetic — think mission control for marketers. Rebellious red accents on a deep midnight background, cut with industrial uppercase display type.

**Design principles**
- **Dark-first.** The product lives on a near-black midnight blue. Never a white background.
- **High contrast.** Pure white type on deep navy. Red is reserved for primary actions, alerts, and key data.
- **Industrial typography.** Display headings are uppercase, tight-tracked, and heavy-weight. Body copy is clean, neutral sans.
- **Flat with subtle depth.** Minimal shadows (`shadow-xs`, `shadow-sm`). Borders define structure more than drop shadows. Hover/active states use `hover-elevate` / `active-elevate-2` rather than color shifts.
- **Rounded but not soft.** `--radius: 0.5rem` (8px) on most controls, `rounded-xl` (12px) on cards.
- **No gratuitous gradients or glow.** Color does the talking.

---

## 2. Color System

All colors are defined as HSL channels in CSS variables, then exposed to Tailwind via `@theme`. This is a shadcn-style token system.

### 2.1 Brand palette (raw)

| Token             | Hex       | HSL                | Usage                                            |
| ----------------- | --------- | ------------------ | ------------------------------------------------ |
| Midnight Sky      | `#0A0F1F` | `231 51% 8%`       | App background                                   |
| Card Midnight     | `#0F1525` | `226 47% 11%`      | Cards, popovers, elevated surfaces               |
| Rebel Red         | `#F20505` | `0 96% 48%`        | Primary action, destructive, focus ring, accents |
| Stratos Blue      | `#002D5E` | `211 100% 18%`     | Secondary buttons, "total cost" data series      |
| Steel             | `~#8693A0` | `207 8% 56%`       | Muted foreground / secondary text                |
| Gunmetal          | `~#252B36` | `215 28% 17%`      | Borders, inputs, muted surfaces, accents         |
| White             | `#FFFFFF` | `0 0% 100%`        | Primary foreground                               |

### 2.2 Semantic tokens (shadcn-style)

```
background           231 51% 8%      Midnight Sky
foreground           0   0% 100%     White
card                 226 47% 11%     Card Midnight
card-foreground      0   0% 100%
popover              226 47% 11%
popover-foreground   0   0% 100%
primary              0   96% 48%     Rebel Red
primary-foreground   0   0% 100%
secondary            211 100% 18%    Stratos
secondary-foreground 0   0% 100%
muted                215 28% 17%     Gunmetal
muted-foreground     207 8%  56%     Steel
accent               215 28% 17%
accent-foreground    0   0% 100%
destructive          0   96% 48%     (same as primary — red)
destructive-foreground 0 0% 100%
border               215 28% 17%
input                215 28% 17%
ring                 0   96% 48%     Rebel Red focus ring
radius               0.5rem
```

### 2.3 Data-viz / platform colors

Used in charts and platform badges (Recharts, etc.):

```ts
export const PLATFORM_COLORS = {
  google:    "#34A853",  // Google green
  meta:      "#1877F2",  // Meta blue
  revenue:   "#F20505",  // Rebel Red
  totalCost: "#002D5E",  // Stratos
} as const;
```

---

## 3. Typography

### 3.1 Font families

| Role      | Family                        | Weight | Notes                                 |
| --------- | ----------------------------- | ------ | ------------------------------------- |
| Body/UI   | `Inter`                       | 400–700 | Loaded from Google Fonts              |
| Display   | `Soehne Extrafett`            | Heavy  | Headings (h1–h6). Uppercase, tight.   |
| Sub       | `Soehne Dreiviertelfett`      | Bold   | Subheads / display secondary          |

> Soehne is a licensed family. If you don't have it, fall back to a heavy industrial sans like `"Neue Haas Grotesk Display Pro"`, `"Inter"` 800/900, or `"Archivo Black"`.

### 3.2 Type rules

- **All headings (`h1`–`h6`):** `font-family: Soehne Extrafett`, `text-transform: uppercase`, `letter-spacing: tight` (`tracking-tight`).
- **Body:** Inter, `antialiased`.
- **Selection:** `bg-primary/30 text-white` (red wash on red brand).

### 3.3 Scale (Tailwind defaults — no custom sizes)

Use Tailwind's defaults. Conventional pairings:

- `text-xs` (12px) — badges, kbd, labels in tight UI.
- `text-sm` (14px) — body, table cells, buttons.
- `text-base` (16px) — inputs (mobile), default paragraph.
- `text-lg` / `text-xl` — section intros.
- `text-2xl`–`text-4xl` — page titles.
- `text-5xl`+ — hero / marketing.

---

## 4. Spacing, Radius, Shadows

- **Radius:** `--radius: 0.5rem` (`rounded-md` ≈ 6px, `rounded-lg` ≈ 8px, `rounded-xl` ≈ 12px).
  - Buttons / inputs / badges: `rounded-md`.
  - Cards: `rounded-xl`.
- **Borders:** 1px, color `hsl(var(--border))` (Gunmetal). Borders carry the structure — prefer them over shadows.
- **Shadows:** keep them tiny.
  - `shadow-xs` for subtle lift (badges, outline buttons).
  - `shadow-sm` for inputs.
  - `shadow` for cards.
- **Elevation on interaction:** use Replit's `hover-elevate` and `active-elevate-2` utility pattern instead of swapping background colors. (If you don't have those utilities, a 4–8% white overlay on hover is a fine fallback.)
- **Focus ring:** 1px, `--ring` (Rebel Red), no offset on most controls; 2px with offset on badges.

---

## 5. The complete CSS (drop-in)

This is the entire `src/index.css`. It assumes Tailwind v4 (`@import "tailwindcss"` + `@theme`). For Tailwind v3, see §10.

```css
@import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap');
@import "tailwindcss";

@theme inline {
  --font-sans: 'Inter', sans-serif;
  --font-display: 'Soehne Extrafett', sans-serif;
  --font-sub: 'Soehne Dreiviertelfett', sans-serif;

  --color-background: hsl(var(--background));
  --color-foreground: hsl(var(--foreground));
  --color-card: hsl(var(--card));
  --color-card-foreground: hsl(var(--card-foreground));
  --color-popover: hsl(var(--popover));
  --color-popover-foreground: hsl(var(--popover-foreground));
  --color-primary: hsl(var(--primary));
  --color-primary-foreground: hsl(var(--primary-foreground));
  --color-secondary: hsl(var(--secondary));
  --color-secondary-foreground: hsl(var(--secondary-foreground));
  --color-muted: hsl(var(--muted));
  --color-muted-foreground: hsl(var(--muted-foreground));
  --color-accent: hsl(var(--accent));
  --color-accent-foreground: hsl(var(--accent-foreground));
  --color-destructive: hsl(var(--destructive));
  --color-destructive-foreground: hsl(var(--destructive-foreground));
  --color-border: hsl(var(--border));
  --color-input: hsl(var(--input));
  --color-ring: hsl(var(--ring));
}

:root {
  /* Midnight Sky - #0A0F1F */
  --background: 231 51% 8%;
  --foreground: 0 0% 100%;

  /* Slightly lighter for cards */
  --card: 226 47% 11%;
  --card-foreground: 0 0% 100%;

  --popover: 226 47% 11%;
  --popover-foreground: 0 0% 100%;

  /* Rebel Red - #F20505 */
  --primary: 0 96% 48%;
  --primary-foreground: 0 0% 100%;

  /* Stratos - #002D5E */
  --secondary: 211 100% 18%;
  --secondary-foreground: 0 0% 100%;

  /* Borders and muted */
  --muted: 215 28% 17%;
  --muted-foreground: 207 8% 56%; /* Steel */

  --accent: 215 28% 17%;
  --accent-foreground: 0 0% 100%;

  --destructive: 0 96% 48%;
  --destructive-foreground: 0 0% 100%;

  --border: 215 28% 17%;
  --input: 215 28% 17%;
  --ring: 0 96% 48%;

  --radius: 0.5rem;
}

@layer base {
  * {
    @apply border-border;
  }
  body {
    @apply bg-background text-foreground font-sans antialiased
           selection:bg-primary/30 selection:text-white;
  }
  h1, h2, h3, h4, h5, h6 {
    font-family: var(--font-display);
    @apply uppercase tracking-tight;
  }
}

/* Custom Scrollbar for a premium feel */
::-webkit-scrollbar {
  width: 8px;
  height: 8px;
}
::-webkit-scrollbar-track {
  background: hsl(var(--background));
}
::-webkit-scrollbar-thumb {
  background: hsl(var(--muted));
  border-radius: 4px;
}
::-webkit-scrollbar-thumb:hover {
  background: hsl(var(--muted-foreground));
}
```

---

## 6. Component patterns

The app uses **shadcn/ui (New York style)** with light Replit-flavored tweaks: borders instead of hover color shifts, smaller shadows, `hover-elevate`/`active-elevate-2` for interactivity.

### 6.1 Button (cva)

```tsx
const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0 hover-elevate active-elevate-2",
  {
    variants: {
      variant: {
        default:     "bg-primary text-primary-foreground border border-primary-border",
        destructive: "bg-destructive text-destructive-foreground shadow-sm border-destructive-border",
        outline:     "border [border-color:var(--button-outline)] shadow-xs active:shadow-none",
        secondary:   "border bg-secondary text-secondary-foreground border-secondary-border",
        ghost:       "border border-transparent",
        link:        "text-primary underline-offset-4 hover:underline",
      },
      size: {
        default: "min-h-9 px-4 py-2",
        sm:      "min-h-8 rounded-md px-3 text-xs",
        lg:      "min-h-10 rounded-md px-8",
        icon:    "h-9 w-9",
      },
    },
    defaultVariants: { variant: "default", size: "default" },
  }
);
```

Notes:
- No color-shift hovers — uses `hover-elevate` (a transparent overlay).
- Buttons have a visible border that matches their fill family (e.g. `--primary-border`). If you don't define those, fall back to `border-primary` etc.

### 6.2 Card

```tsx
<div className="rounded-xl border bg-card text-card-foreground shadow">
  <header className="flex flex-col space-y-1.5 p-6">
    <div className="font-semibold leading-none tracking-tight">Title</div>
    <div className="text-sm text-muted-foreground">Description</div>
  </header>
  <div className="p-6 pt-0">…content…</div>
  <footer className="flex items-center p-6 pt-0">…actions…</footer>
</div>
```

### 6.3 Badge

```tsx
const badgeVariants = cva(
  "whitespace-nowrap inline-flex items-center rounded-md border px-2.5 py-0.5 text-xs font-semibold transition-colors focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 hover-elevate",
  {
    variants: {
      variant: {
        default:     "border-transparent bg-primary text-primary-foreground shadow-xs",
        secondary:   "border-transparent bg-secondary text-secondary-foreground",
        destructive: "border-transparent bg-destructive text-destructive-foreground shadow-xs",
        outline:     "text-foreground border [border-color:var(--badge-outline)]",
      },
    },
    defaultVariants: { variant: "default" },
  }
);
```

### 6.4 Input

```tsx
<input
  className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1
             text-base shadow-sm transition-colors
             file:border-0 file:bg-transparent file:text-sm file:font-medium file:text-foreground
             placeholder:text-muted-foreground
             focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring
             disabled:cursor-not-allowed disabled:opacity-50 md:text-sm"
/>
```

Inputs are **transparent** — they pick up the surface they sit on (card or background), with a Gunmetal border.

### 6.5 `cn` utility

```ts
import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
```

---

## 7. Iconography

- **Primary set:** [`lucide-react`](https://lucide.dev). Stroke icons, default size 16px (`[&_svg]:size-4` in buttons).
- **Brand/3rd-party logos:** `react-icons` (e.g. for Google, Meta).
- Icons inherit `currentColor` — never hard-code a hex.

---

## 8. Motion

- **Library:** `framer-motion` for component-level animation; `tw-animate-css` for utility keyframes (used by Radix-based primitives).
- **Defaults:** short, snappy transitions (`transition-colors`, ~150ms). No long bouncy springs in core UI.
- **Hover/active:** the `hover-elevate` / `active-elevate-2` pattern is purely a CSS overlay — no transform.

---

## 9. Component library stack

If you're starting fresh, install:

```
shadcn/ui (New York style)  + Radix primitives
tailwindcss                 (v4 preferred)
class-variance-authority
clsx
tailwind-merge
lucide-react
framer-motion
sonner                      (toasts)
recharts                    (charts — use PLATFORM_COLORS)
react-hook-form + zod       (forms)
@tanstack/react-query       (data)
date-fns                    (dates)
next-themes                 (only if you add light mode — current app is dark-only)
```

`components.json` (shadcn config) used here:

```json
{
  "$schema": "https://ui.shadcn.com/schema.json",
  "style": "new-york",
  "rsc": false,
  "tsx": true,
  "tailwind": {
    "config": "",
    "css": "src/index.css",
    "baseColor": "neutral",
    "cssVariables": true,
    "prefix": ""
  },
  "aliases": {
    "components": "@/components",
    "utils": "@/lib/utils",
    "ui": "@/components/ui",
    "lib": "@/lib",
    "hooks": "@/hooks"
  }
}
```

---

## 10. Tailwind v3 fallback

If your target app uses Tailwind v3, replace the `@theme` block with a `tailwind.config.js`:

```js
/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  darkMode: "class",
  theme: {
    extend: {
      colors: {
        border:      "hsl(var(--border))",
        input:       "hsl(var(--input))",
        ring:        "hsl(var(--ring))",
        background:  "hsl(var(--background))",
        foreground:  "hsl(var(--foreground))",
        primary:     { DEFAULT: "hsl(var(--primary))",     foreground: "hsl(var(--primary-foreground))" },
        secondary:   { DEFAULT: "hsl(var(--secondary))",   foreground: "hsl(var(--secondary-foreground))" },
        destructive: { DEFAULT: "hsl(var(--destructive))", foreground: "hsl(var(--destructive-foreground))" },
        muted:       { DEFAULT: "hsl(var(--muted))",       foreground: "hsl(var(--muted-foreground))" },
        accent:      { DEFAULT: "hsl(var(--accent))",      foreground: "hsl(var(--accent-foreground))" },
        popover:     { DEFAULT: "hsl(var(--popover))",     foreground: "hsl(var(--popover-foreground))" },
        card:        { DEFAULT: "hsl(var(--card))",        foreground: "hsl(var(--card-foreground))" },
      },
      borderRadius: {
        lg: "var(--radius)",
        md: "calc(var(--radius) - 2px)",
        sm: "calc(var(--radius) - 4px)",
      },
      fontFamily: {
        sans:    ["Inter", "sans-serif"],
        display: ["'Soehne Extrafett'", "sans-serif"],
        sub:     ["'Soehne Dreiviertelfett'", "sans-serif"],
      },
    },
  },
  plugins: [require("tailwindcss-animate"), require("@tailwindcss/typography")],
};
```

Keep the `:root` block from §5 in your CSS.

---

## 11. Quick "redesign my app to match" prompt

Paste this into another AI builder:

> Restyle this app to match the **Pulse / Marketing OS** brand. Use the CSS from section 5 of `BRAND_GUIDE.md` as the base stylesheet. Set the body to the dark midnight background, white foreground, Inter for body, and an uppercase heavy display font for all `h1`–`h6`. Use Rebel Red (`#F20505`) only for primary CTAs, destructive actions, and the focus ring. Use Stratos (`#002D5E`) for secondary buttons. Cards are `rounded-xl` on Card Midnight (`#0F1525`) with a 1px Gunmetal border and a tiny `shadow`. Inputs are transparent with a Gunmetal border. Replace any colored hover states with a subtle elevation overlay. Keep shadows minimal, borders crisp, and never introduce a white background.

---

*Generated from the live `artifacts/marketing-os` source — `src/index.css`, `components.json`, and the shadcn UI primitives in `src/components/ui/`.*
