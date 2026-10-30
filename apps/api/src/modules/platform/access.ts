/**
 * Loads a user's roles and effective permissions, and answers
 * "can this user do X (in scope Y)?" Every route uses this, never role names.
 */
import { ROLE_KEYS, type Permission, type RoleKey } from "@nffl/shared";
import { and, eq, isNull } from "drizzle-orm";
import type { DbOrTx } from "../../db/client.js";
import { rolePermissions, roles, twoFactor, userRoleAssignments } from "../../db/schema/index.js";

export interface Scope {
  type: "season" | "team";
  id: string;
}

export interface Grant {
  role: RoleKey;
  scope: Scope | null;
  permissions: Set<Permission>;
}

export interface Access {
  userId: string;
  grants: Grant[];
  roles: RoleKey[];
  /** Union of league-wide permissions (scope = null). */
  leagueWide: Set<Permission>;
  /** True if any held role requires an authenticator app. */
  requiresTotp: boolean;
  /** True if the user has a confirmed authenticator app. */
  hasVerifiedTotp: boolean;
}

export async function loadAccess(conn: DbOrTx, userId: string): Promise<Access> {
  const rows = await conn
    .select({
      role: userRoleAssignments.roleKey,
      scopeType: userRoleAssignments.scopeType,
      scopeId: userRoleAssignments.scopeId,
      requiresTotp: roles.requiresTotp,
      permission: rolePermissions.permissionKey,
    })
    .from(userRoleAssignments)
    .innerJoin(roles, eq(roles.key, userRoleAssignments.roleKey))
    .leftJoin(rolePermissions, eq(rolePermissions.roleKey, userRoleAssignments.roleKey))
    .where(and(eq(userRoleAssignments.userId, userId), isNull(userRoleAssignments.revokedAt)));

  const byGrant = new Map<string, Grant>();
  let requiresTotp = false;
  for (const r of rows) {
    if (!(ROLE_KEYS as readonly string[]).includes(r.role)) continue;
    const key = `${r.role}|${r.scopeType ?? ""}|${r.scopeId ?? ""}`;
    let g = byGrant.get(key);
    if (!g) {
      g = {
        role: r.role as RoleKey,
        scope: r.scopeType && r.scopeId ? { type: r.scopeType as Scope["type"], id: r.scopeId } : null,
        permissions: new Set(),
      };
      byGrant.set(key, g);
    }
    if (r.permission) g.permissions.add(r.permission as Permission);
    if (r.requiresTotp) requiresTotp = true;
  }

  const grants = [...byGrant.values()];
  const leagueWide = new Set<Permission>();
  for (const g of grants) if (!g.scope) g.permissions.forEach((p) => leagueWide.add(p));

  const [tf] = await conn
    .select({ verified: twoFactor.verified })
    .from(twoFactor)
    .where(eq(twoFactor.userId, userId))
    .limit(1);

  return {
    userId,
    grants,
    roles: [...new Set(grants.map((g) => g.role))],
    leagueWide,
    requiresTotp,
    hasVerifiedTotp: tf?.verified === true,
  };
}

/**
 * League-wide grants satisfy any scope. A scoped grant satisfies only its own
 * scope (e.g. head coach of team X can read roster of team X, not team Y).
 */
export function can(access: Access, permission: Permission, scope?: Scope): boolean {
  if (access.leagueWide.has(permission)) return true;
  if (!scope) return false;
  return access.grants.some(
    (g) => g.scope && g.scope.type === scope.type && g.scope.id === scope.id && g.permissions.has(permission),
  );
}

export function allPermissions(access: Access): Permission[] {
  const all = new Set<Permission>();
  access.grants.forEach((g) => g.permissions.forEach((p) => all.add(p)));
  return [...all].sort();
}
