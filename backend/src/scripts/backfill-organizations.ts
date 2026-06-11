/**
 * Idempotent backfill: ensures every user has an org + admin membership
 * and every workflow has organization_id set.
 */
import { Prisma } from "@prisma/client";
import { v4 as uuidv4 } from "uuid";
import { prisma } from "../lib/prisma.js";
import { permissionsForRole } from "../lib/permissions.js";
import { slugFromEmail } from "../lib/slug.js";

async function uniqueSlug(base: string): Promise<string> {
  let slug = base.slice(0, 60);
  let n = 0;
  while (true) {
    const candidate = n === 0 ? slug : `${slug}-${n}`;
    const existing = await prisma.organization.findUnique({ where: { slug: candidate } });
    if (!existing) return candidate;
    n += 1;
  }
}

async function main() {
  const users = await prisma.user.findMany();

  for (const user of users) {
    let membership = await prisma.organizationMember.findFirst({
      where: { userId: user.id },
      include: { organization: true },
    });

    if (!membership) {
      const slug = await uniqueSlug(slugFromEmail(user.email));
      const orgId = uuidv4();
      const perms = permissionsForRole("admin");

      await prisma.organization.create({
        data: {
          id: orgId,
          name: `${user.name}'s Organization`,
          slug,
          members: {
            create: {
              id: uuidv4(),
              userId: user.id,
              role: "admin",
              permissions: perms as unknown as Prisma.InputJsonValue,
              status: "active",
            },
          },
        },
      });

      membership = await prisma.organizationMember.findFirst({
        where: { userId: user.id },
        include: { organization: true },
      });
      console.log(`Created org "${slug}" for user ${user.email}`);
    }

    if (!membership) continue;

    const updated = await prisma.workflow.updateMany({
      where: { userId: user.id, organizationId: { not: membership.organizationId } },
      data: { organizationId: membership.organizationId },
    });

    if (updated.count > 0) {
      console.log(`Updated ${updated.count} workflows for ${user.email}`);
    }
  }

  console.log("Backfill complete.");
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
