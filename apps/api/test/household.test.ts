import { and, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { db } from "../src/db/client.js";
import { auditLogs } from "../src/db/schema/index.js";
import { agent, signUp, uniqueEmail } from "./helpers.js";

describe("family details", () => {
  it("can be edited, cleared and validated, and every change is audited", async () => {
    const a = agent();
    await signUp(a, uniqueEmail("family-edit"));
    const created = await a.post("/api/v1/households").send({ displayName: "The Smiths", phone: "904-555-0100", state: "", postalCode: "" });
    expect(created.status).toBe(201);
    expect(created.body.household).toMatchObject({ displayName: "The Smiths", state: null, postalCode: null });

    const edit = await a.patch("/api/v1/households/me").send({
      displayName: "The Smith-Jones Family",
      phone: "",
      addressLine1: "1 Main St",
      city: "Jacksonville",
      state: "fl",
      postalCode: "32202",
    });
    expect(edit.status).toBe(200);
    expect(edit.body.household).toMatchObject({
      displayName: "The Smith-Jones Family",
      phone: null,
      addressLine1: "1 Main St",
      city: "Jacksonville",
      state: "FL",
      postalCode: "32202",
    });

    expect((await a.patch("/api/v1/households/me").send({ displayName: "X", state: "Florida" })).status).toBe(400);
    expect((await a.patch("/api/v1/households/me").send({ displayName: "X", postalCode: "322" })).status).toBe(400);
    expect((await a.patch("/api/v1/households/me").send({ displayName: "" })).status).toBe(400);

    const id = created.body.household.id;
    const logs = await db.select().from(auditLogs).where(and(eq(auditLogs.targetId, id), eq(auditLogs.action, "household.update")));
    expect(logs.length).toBe(1);
  });
});
