import { useEffect } from "react";
import { useAuth } from "../components/auth-context";

export function useBranding() {
  const { user } = useAuth();

  useEffect(() => {
    const isClientUser = user?.role === "client_user";
    const title = isClientUser ? "Pulse" : "Optics";
    const faviconHref = isClientUser ? "/pulse-logo.png" : "/optics-logo.png";

    document.title = title;

    let link = document.querySelector<HTMLLinkElement>('link[rel="icon"]')
      || document.querySelector<HTMLLinkElement>('link[rel="shortcut icon"]');
    if (!link) {
      link = document.createElement("link");
      link.rel = "icon";
      document.head.appendChild(link);
    }
    link.type = "image/png";
    link.href = faviconHref;
  }, [user?.role]);
}
