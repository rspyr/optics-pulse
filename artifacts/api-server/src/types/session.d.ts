import "express-session";

declare module "express-session" {
  interface SessionData {
    userId: number;
    userRole: string;
    tenantId: number | null;
    googleOAuthState?: string;
    googleOAuthTenantId?: number;
    metaOAuthState?: string;
    metaOAuthTenantId?: number;
  }
}
