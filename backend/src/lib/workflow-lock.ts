import { Prisma } from "@prisma/client";
import { prisma } from "./prisma.js";

export const LOCK_TTL_MS = 2 * 60 * 1000;
const MAX_LOCK_ACQUIRE_ATTEMPTS = 3;

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

function isUniqueViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002";
}

async function acquireOrExtendLockOnce(
  workflowId: string,
  userId: string,
): Promise<AcquireLockResult> {
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

async function readLockConflict(workflowId: string): Promise<AcquireLockResult | null> {
  const existing = await prisma.workflowLock.findUnique({
    where: { workflowId },
    include: { user: { select: { id: true, name: true } } },
  });

  if (!existing || existing.expiresAt <= new Date()) {
    return null;
  }

  return {
    ok: false,
    lockedBy: {
      userId: existing.userId,
      userName: existing.user.name,
      expiresAt: existing.expiresAt,
    },
  };
}

export async function acquireOrExtendLock(
  workflowId: string,
  userId: string,
): Promise<AcquireLockResult> {
  for (let attempt = 0; attempt < MAX_LOCK_ACQUIRE_ATTEMPTS; attempt++) {
    await purgeExpiredLocks();
    try {
      return await acquireOrExtendLockOnce(workflowId, userId);
    } catch (error) {
      if (!isUniqueViolation(error) || attempt === MAX_LOCK_ACQUIRE_ATTEMPTS - 1) {
        const conflict = await readLockConflict(workflowId);
        if (conflict) {
          return conflict;
        }
        throw error;
      }
    }
  }

  const conflict = await readLockConflict(workflowId);
  if (conflict) {
    return conflict;
  }

  throw new Error(`Failed to acquire workflow lock for ${workflowId}`);
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
