import React from "react";
import { cn } from "@/lib/utils";
import { motion, HTMLMotionProps } from "framer-motion";

export const PremiumCard = React.forwardRef<HTMLDivElement, HTMLMotionProps<"div">>(
  ({ className, children, ...props }, ref) => {
    return (
      <motion.div
        ref={ref}
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        className={cn(
          "bg-card/50 backdrop-blur-xl border border-white/5 rounded-xl p-6 shadow-2xl",
          "hover:border-white/10 transition-colors duration-300",
          className
        )}
        {...props}
      >
        {children}
      </motion.div>
    );
  }
);
PremiumCard.displayName = "PremiumCard";

export const GradientHeading = ({ children, className }: { children: React.ReactNode; className?: string }) => (
  <h2 className={cn("font-display text-transparent bg-clip-text bg-gradient-to-r from-white to-white/60", className)}>
    {children}
  </h2>
);

export const Badge = ({ children, variant = "default", className }: { children: React.ReactNode, variant?: "default" | "success" | "danger" | "warning" | "neutral", className?: string }) => {
  const variants = {
    default: "bg-primary/10 text-primary border-primary/20",
    success: "bg-emerald-500/10 text-emerald-400 border-emerald-500/20",
    danger: "bg-red-500/10 text-red-400 border-red-500/20",
    warning: "bg-amber-500/10 text-amber-400 border-amber-500/20",
    neutral: "bg-white/5 text-muted-foreground border-white/10"
  };
  
  return (
    <span className={cn("px-2.5 py-0.5 rounded-full text-xs font-medium border", variants[variant], className)}>
      {children}
    </span>
  );
};
