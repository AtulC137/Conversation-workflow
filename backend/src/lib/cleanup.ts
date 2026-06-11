import { prisma } from "./prisma.js";
import { purgeExpiredLocks } from "./workflow-lock.js";

const RETENTION_DAYS = Number(process.env.RETENTION_DAYS ?? "90");

export async function runRetentionCleanup(): Promise<void> {
  const now = new Date();

  await purgeExpiredLocks();

  await prisma.voiceSession.updateMany({
    where: { status: "active", expiresAt: { lt: now } },
    data: { status: "expired" },
  });

  await prisma.authSession.deleteMany({
    where: {
      OR: [{ expiresAt: { lt: now } }, { revokedAt: { not: null } }],
    },
  });

  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - RETENTION_DAYS);

  const oldSessions = await prisma.voiceSession.findMany({
    where: { createdAt: { lt: cutoff } },
    select: { id: true },
  });

  if (oldSessions.length > 0) {
    const ids = oldSessions.map((s) => s.id);
    await prisma.sessionEvent.deleteMany({ where: { sessionId: { in: ids } } });
    await prisma.callTurn.deleteMany({ where: { sessionId: { in: ids } } });
    await prisma.voiceSession.deleteMany({ where: { id: { in: ids } } });
  }
}

export function startCleanupScheduler(intervalMs = 60 * 60 * 1000): NodeJS.Timeout {
  const tick = () => {
    runRetentionCleanup().catch((err) => console.error("[cleanup]", err));
  };
  tick();
  return setInterval(tick, intervalMs);
}
