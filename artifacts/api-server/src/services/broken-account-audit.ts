import { db, usersTable } from "@workspace/db";
import { and, isNull, sql } from "drizzle-orm";

/**
 * Tenant-scoped roles. Any user with one of these roles MUST have a
 * `tenantId` — otherwise every list endpoint protected by
 * `resolveListTenantScope` (see `lib/tenant-scope.ts`) will 403 with
 * "No tenant assigned" and the user has no working pages.
 *
 * This list is the canonical inverse of the cross-tenant admin roles
 * (`super_admin`, `agency_user`).
 */
const ADMIN_ROLES = ["super_admin", "agency_user"] as const;

export interface BrokenAccount {
  id: number;
  email: string;
  role: string;
  isActive: boolean;
}

export interface BrokenAccountAuditReport {
  brokenCount: number;
  brokenAccounts: BrokenAccount[];
  scannedAt: Date;
}

/**
 * Find every user whose role requires a tenant but who has no
 * tenantId. These accounts are broken: every list endpoint will 403
 * for them. Operators should either reassign a tenantId or
 * deactivate the account.
 *
 * Uses `notInArray(role, ADMIN_ROLES)` rather than
 * `inArray(role, TENANT_SCOPED_ROLES)` so any *future* tenant-scoped
 * role added to the enum is automatically caught by the audit
 * without needing a code change here.
 */
export async function findUsersWithoutTenant(): Promise<BrokenAccount[]> {
  const rows = await db
    .select({
      id: usersTable.id,
      email: usersTable.email,
      role: usersTable.role,
      isActive: usersTable.isActive,
    })
    .from(usersTable)
    .where(
      and(
        isNull(usersTable.tenantId),
        sql`${usersTable.role} NOT IN (${sql.join(
          ADMIN_ROLES.map((r) => sql`${r}`),
          sql`, `,
        )})`,
      ),
    );
  return rows.map((r) => ({
    id: r.id,
    email: r.email,
    role: r.role,
    isActive: r.isActive,
  }));
}

/**
 * Run the audit and log a structured report. Called once at API
 * server startup from `index.ts`. Operators tail the API server logs
 * for `[broken-account-audit]` to find users that need attention.
 *
 * Failure here is non-fatal: the audit is observability only, never
 * a startup gate.
 */
export async function auditUsersWithoutTenant(): Promise<BrokenAccountAuditReport | null> {
  try {
    const broken = await findUsersWithoutTenant();
    const report: BrokenAccountAuditReport = {
      brokenCount: broken.length,
      brokenAccounts: broken,
      scannedAt: new Date(),
    };
    if (broken.length === 0) {
      console.log("[broken-account-audit] OK — no non-admin users missing a tenantId");
    } else {
      const activeBroken = broken.filter((u) => u.isActive);
      console.warn(
        `[broken-account-audit] Found ${broken.length} non-admin user(s) without a tenantId (${activeBroken.length} active). These accounts will 403 on every list endpoint until either tenantId is set or the account is deactivated.`,
      );
      for (const u of broken) {
        console.warn(
          `[broken-account-audit]   user_id=${u.id} email=${u.email} role=${u.role} active=${u.isActive}`,
        );
      }
    }
    return report;
  } catch (err) {
    console.error("[broken-account-audit] Audit failed:", err);
    return null;
  }
}

