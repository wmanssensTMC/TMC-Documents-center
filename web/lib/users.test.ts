import { beforeEach, describe, expect, it } from "vitest";
import type { Actor } from "./audit";
import { verifyPassword } from "./auth/password";
import { createPgliteDb, type Db } from "./db";
import { changeOwnPassword, createUser, findUserByEmail, listUsers, resetPassword, updateUser, UserError } from "./users";

const admin: Actor = { email: "wilman@transmare.com", name: "Willem", role: "admin" };
let db: Db;

beforeEach(async () => {
  db = await createPgliteDb();
});

const kars = { email: " Kars@Transmare.com ", name: "Kars Groen", role: "approver", password: "temporary-pass-1" };

describe("users", () => {
  it("creates a user with a lower-case e-mail who must change the password", async () => {
    await createUser(db, admin, kars);
    const u = await findUserByEmail(db, "kars@transmare.com");
    expect(u).toMatchObject({ email: "kars@transmare.com", role: "approver", mustChangePassword: true, active: true });
    expect(u!.passwordHash).not.toContain("temporary");
    expect(await verifyPassword("temporary-pass-1", u!.passwordHash)).toBe(true);
  });

  it("refuses duplicates, bad e-mails, short passwords and unknown roles", async () => {
    await createUser(db, admin, kars);
    await expect(createUser(db, admin, kars)).rejects.toThrow(UserError);
    await expect(createUser(db, admin, { ...kars, email: "not-an-email" })).rejects.toThrow(UserError);
    await expect(createUser(db, admin, { ...kars, email: "x@y.com", password: "short" })).rejects.toThrow(UserError);
    await expect(createUser(db, admin, { ...kars, email: "x@y.com", role: "superuser" })).rejects.toThrow(UserError);
  });

  it("an admin cannot block or demote themselves", async () => {
    await createUser(db, admin, { ...kars, email: admin.email, role: "admin" });
    const [me] = await listUsers(db);
    await expect(updateUser(db, admin, me.id, { active: false })).rejects.toThrow(/own admin/);
    await expect(updateUser(db, admin, me.id, { role: "user" })).rejects.toThrow(/own admin/);
  });

  it("blocks a user and resets a password (must change again)", async () => {
    await createUser(db, admin, kars);
    const [u] = await listUsers(db);
    await updateUser(db, admin, u.id, { active: false });
    expect((await findUserByEmail(db, kars.email))!.active).toBe(false);
    await resetPassword(db, admin, u.id, "another-temp-pass");
    expect((await findUserByEmail(db, kars.email))!.mustChangePassword).toBe(true);
    await expect(updateUser(db, admin, "not-a-uuid", { active: true })).rejects.toThrow(UserError);
  });

  it("changing your own password needs the current one and clears must-change", async () => {
    await createUser(db, admin, kars);
    const me: Actor = { email: "kars@transmare.com", name: "Kars", role: "approver" };
    await expect(changeOwnPassword(db, me, "wrong", "brand-new-password")).rejects.toThrow(/not correct/);
    await expect(changeOwnPassword(db, me, "temporary-pass-1", "temporary-pass-1")).rejects.toThrow(/different/);
    await changeOwnPassword(db, me, "temporary-pass-1", "brand-new-password");
    const u = await findUserByEmail(db, me.email);
    expect(u!.mustChangePassword).toBe(false);
    expect(await verifyPassword("brand-new-password", u!.passwordHash)).toBe(true);
  });
});
