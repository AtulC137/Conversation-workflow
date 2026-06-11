import type { Prisma } from "@prisma/client";
import type { AuthedUser } from "../middleware/auth.js";
import {
  canDeleteWorkflow,
  canEditWorkflow,
  canViewWorkflow,
  hasPermission,
  type MemberContext,
} from "./permissions.js";

export function toMemberContext(user: AuthedUser): MemberContext {
  return {
    userId: user.id,
    organizationId: user.organizationId,
    role: user.role,
    permissions: user.permissions,
  };
}

export function workflowListWhere(user: AuthedUser): Prisma.WorkflowWhereInput {
  const member = toMemberContext(user);
  const base: Prisma.WorkflowWhereInput = {
    organizationId: user.organizationId,
    status: { not: "archived" },
  };

  if (hasPermission(member, "workflows.view_all")) {
    return base;
  }

  return { ...base, userId: user.id };
}

export function canAccessWorkflowRead(
  user: AuthedUser,
  workflow: { userId: string; organizationId: string },
): boolean {
  return canViewWorkflow(toMemberContext(user), workflow);
}

export function canAccessWorkflowWrite(
  user: AuthedUser,
  workflow: { userId: string; organizationId: string },
): boolean {
  return canEditWorkflow(toMemberContext(user), workflow);
}

export function canAccessWorkflowDelete(
  user: AuthedUser,
  workflow: { userId: string; organizationId: string },
): boolean {
  return canDeleteWorkflow(toMemberContext(user), workflow);
}
