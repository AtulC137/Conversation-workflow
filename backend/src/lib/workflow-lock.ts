import { prisma } from "./prisma.js";

export const LOCK_TTL_MS = 2 * 60 * 1000;

export function lockExpiresAt(from = Date.now()): Date {
  return new Date(from + LOCK_TTL_MS);
}

export async function purgeExpiredLocks(): Promise<void> {
  await prisma.workflowLock.deleteMany({
    where: { expiresAt: { lt: new Date() } },
  });
}

export async function getActiveLock(workflowId: string) {
  await purgeExpiredLocks();
  return prisma.workflowLock.findUnique({
    where: { workflowId },
    include: { user: { select: { id: true, name: true } } },
  });
}

export type AcquireLockResult =
  | { ok: true; expiresAt: Date }
  | { ok: false; lockedBy: { userId: string; userName: string; expiresAt: Date } };

export async function acquireOrExtendLock(
  workflowId: string,
  userId: string,
): Promise<AcquireLockResult> {
  await purgeExpiredLocks();

  const existing = await prisma.workflowLock.findUnique({
    where: { workflowId },
    include: { user: { select: { id: true, name: true } } },
  });

  const expiresAt = lockExpiresAt();

  if (!existing) {
    await prisma.workflowLock.create({
      data: { workflowId, userId, expiresAt },
    });
    return { ok: true, expiresAt };
  }

  if (existing.userId === userId) {
    await prisma.workflowLock.update({
      where: { workflowId },
      data: { expiresAt, lockedAt: new Date() },
    });
    return { ok: true, expiresAt };
  }

  if (existing.expiresAt > new Date()) {
    return {
      ok: false,
      lockedBy: {
        userId: existing.userId,
        userName: existing.user.name,
        expiresAt: existing.expiresAt,
      },
    };
  }

  await prisma.workflowLock.update({
    where: { workflowId },
    data: { userId, expiresAt, lockedAt: new Date() },
  });
  return { ok: true, expiresAt };
}

export async function releaseLock(workflowId: string, userId: string): Promise<boolean> {
  const existing = await prisma.workflowLock.findUnique({ where: { workflowId } });
  if (!existing || existing.userId !== userId) return false;
  await prisma.workflowLock.delete({ where: { workflowId } });
  return true;
}

export function lockToClient(lock: {
  userId: string;
  user: { id: string; name: string };
  expiresAt: Date;
} | null) {
  if (!lock || lock.expiresAt <= new Date()) return null;
  return {
    userId: lock.userId,
    userName: lock.user.name,
    expiresAt: lock.expiresAt.getTime(),
  };
}
