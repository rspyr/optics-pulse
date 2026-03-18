import type { Request, Response, NextFunction } from "express";

export function requireAuth(req: Request, res: Response, next: NextFunction) {
  if (!req.session.userId) {
    res.status(401).json({ error: "Authentication required" });
    return;
  }
  next();
}

export function requireRole(...roles: string[]) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!req.session.userId) {
      res.status(401).json({ error: "Authentication required" });
      return;
    }
    if (!req.session.userRole || !roles.includes(req.session.userRole)) {
      res.status(403).json({ error: "Insufficient permissions" });
      return;
    }
    next();
  };
}

export function enforceTenantScope(req: Request, res: Response, next: NextFunction) {
  if (!req.session.userId) {
    res.status(401).json({ error: "Authentication required" });
    return;
  }

  const role = req.session.userRole;
  if (role === "super_admin" || role === "agency_user") {
    next();
    return;
  }

  const userTenantId = req.session.tenantId;
  if (!userTenantId) {
    res.status(403).json({ error: "No tenant assigned" });
    return;
  }

  const requestedTenantId = req.query.tenantId ? Number(req.query.tenantId) : (req.body?.tenantId ? Number(req.body.tenantId) : null);
  const paramTenantId = req.params.tenantId ? Number(req.params.tenantId) : null;

  if (requestedTenantId && requestedTenantId !== userTenantId) {
    res.status(403).json({ error: "Access denied to this tenant" });
    return;
  }
  if (paramTenantId && paramTenantId !== userTenantId) {
    res.status(403).json({ error: "Access denied to this tenant" });
    return;
  }

  if (!requestedTenantId && !paramTenantId) {
    req.query.tenantId = String(userTenantId);
    if (req.body && typeof req.body === "object") {
      req.body.tenantId = userTenantId;
    }
  }

  next();
}
