/**
 * One-shot: copy conversation_workflow (MySQL) → prisma/susha.db (SQLite).
 * Run: npx tsx src/scripts/mysql-to-sqlite.ts
 */
import mysql from "mysql2/promise";
import { PrismaClient, Prisma } from "@prisma/client";

function asJson(v: unknown): Prisma.InputJsonValue {
  if (v == null) return {} as Prisma.InputJsonValue;
  if (typeof v === "string") {
    try {
      return JSON.parse(v) as Prisma.InputJsonValue;
    } catch {
      return v as Prisma.InputJsonValue;
    }
  }
  if (Buffer.isBuffer(v)) {
    return JSON.parse(v.toString("utf8")) as Prisma.InputJsonValue;
  }
  return v as Prisma.InputJsonValue;
}

function asJsonOpt(v: unknown): Prisma.InputJsonValue | undefined {
  if (v == null) return undefined;
  return asJson(v);
}

const prisma = new PrismaClient();

async function main() {
  const conn = await mysql.createConnection({
    host: process.env.MYSQL_HOST ?? "127.0.0.1",
    port: Number(process.env.MYSQL_PORT ?? 3306),
    user: process.env.MYSQL_USER ?? "app",
    password: process.env.MYSQL_PASSWORD ?? "app_secret",
    database: process.env.MYSQL_SOURCE_DB ?? "conversation_workflow",
  });

  const [orgs] = await conn.query<mysql.RowDataPacket[]>("SELECT * FROM organizations");
  const [users] = await conn.query<mysql.RowDataPacket[]>("SELECT * FROM users");
  const [members] = await conn.query<mysql.RowDataPacket[]>("SELECT * FROM organization_members");
  const [sessions] = await conn.query<mysql.RowDataPacket[]>("SELECT * FROM auth_sessions");
  const [workflows] = await conn.query<mysql.RowDataPacket[]>("SELECT * FROM workflows");
  const [locks] = await conn.query<mysql.RowDataPacket[]>("SELECT * FROM workflow_locks");
  const [versions] = await conn.query<mysql.RowDataPacket[]>("SELECT * FROM workflow_versions");
  const [voice] = await conn.query<mysql.RowDataPacket[]>("SELECT * FROM voice_sessions");
  const [turns] = await conn.query<mysql.RowDataPacket[]>("SELECT * FROM call_turns");
  const [events] = await conn.query<mysql.RowDataPacket[]>("SELECT * FROM session_events");

  console.log("mysql counts", {
    orgs: orgs.length,
    users: users.length,
    members: members.length,
    sessions: sessions.length,
    workflows: workflows.length,
    locks: locks.length,
    versions: versions.length,
    voice: voice.length,
    turns: turns.length,
    events: events.length,
  });

  if (orgs.length) {
    await prisma.organization.createMany({
      data: orgs.map((r) => ({
        id: r.id,
        name: r.name,
        slug: r.slug,
        createdAt: new Date(r.created_at),
        updatedAt: new Date(r.updated_at),
      })),
    });
  }

  if (users.length) {
    await prisma.user.createMany({
      data: users.map((r) => ({
        id: r.id,
        email: r.email,
        passwordHash: r.password_hash,
        name: r.name,
        createdAt: new Date(r.created_at),
        updatedAt: new Date(r.updated_at),
      })),
    });
  }

  if (members.length) {
    await prisma.organizationMember.createMany({
      data: members.map((r) => ({
        id: r.id,
        organizationId: r.organization_id,
        userId: r.user_id,
        role: r.role,
        permissions: asJson(r.permissions),
        status: r.status,
        createdAt: new Date(r.created_at),
        updatedAt: new Date(r.updated_at),
      })),
    });
  }

  if (sessions.length) {
    await prisma.authSession.createMany({
      data: sessions.map((r) => ({
        id: r.id,
        userId: r.user_id,
        refreshTokenHash: r.refresh_token_hash,
        expiresAt: new Date(r.expires_at),
        createdAt: new Date(r.created_at),
        revokedAt: r.revoked_at ? new Date(r.revoked_at) : null,
      })),
    });
  }

  if (workflows.length) {
    await prisma.workflow.createMany({
      data: workflows.map((r) => ({
        id: r.id,
        userId: r.user_id,
        organizationId: r.organization_id,
        name: r.name,
        context: r.context ?? "",
        script: r.script ?? "",
        tools: asJson(r.tools),
        nodes: asJson(r.nodes),
        edges: asJson(r.edges),
        status: r.status,
        createdAt: new Date(r.created_at),
        updatedAt: new Date(r.updated_at),
      })),
    });
  }

  if (locks.length) {
    await prisma.workflowLock.createMany({
      data: locks.map((r) => ({
        workflowId: r.workflow_id,
        userId: r.user_id,
        lockedAt: new Date(r.locked_at),
        expiresAt: new Date(r.expires_at),
      })),
    });
  }

  if (versions.length) {
    await prisma.workflowVersion.createMany({
      data: versions.map((r) => ({
        id: r.id,
        workflowId: r.workflow_id,
        versionNumber: r.version_number,
        snapshot: asJson(r.snapshot),
        publishedBy: r.published_by,
        createdAt: new Date(r.created_at),
      })),
    });
  }

  if (voice.length) {
    await prisma.voiceSession.createMany({
      data: voice.map((r) => ({
        id: r.id,
        userId: r.user_id,
        workflowId: r.workflow_id ?? null,
        workflowVersionId: r.workflow_version_id ?? null,
        context: r.context ?? "",
        example: r.example ?? "",
        endPoints: asJson(r.end_points),
        greeting: r.greeting ?? null,
        graph: asJson(r.graph),
        status: r.status,
        startedAt: r.started_at ? new Date(r.started_at) : null,
        endedAt: r.ended_at ? new Date(r.ended_at) : null,
        expiresAt: new Date(r.expires_at),
        createdAt: new Date(r.created_at),
      })),
    });
  }

  if (turns.length) {
    await prisma.callTurn.createMany({
      data: turns.map((r) => ({
        id: BigInt(r.id),
        sessionId: r.session_id,
        turnIndex: r.turn_index,
        speaker: r.speaker,
        nodeId: r.node_id ?? null,
        content: r.content ?? "",
        isComplete: Boolean(r.is_complete),
        completionStatus: r.completion_status,
        metadata: asJsonOpt(r.metadata),
        createdAt: new Date(r.created_at),
      })),
    });
  }

  if (events.length) {
    await prisma.sessionEvent.createMany({
      data: events.map((r) => ({
        id: BigInt(r.id),
        sessionId: r.session_id,
        eventType: r.event_type,
        nodeId: r.node_id ?? null,
        payload: asJsonOpt(r.payload),
        createdAt: new Date(r.created_at),
      })),
    });
  }

  await conn.end();
  console.log("done → prisma/susha.db");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
