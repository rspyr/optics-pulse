import { db, usersTable } from "./src";
import bcrypt from "bcryptjs";

async function seedUsers() {
  console.log("Seeding users...");

  const passwordHash = await bcrypt.hash("demo1234", 10);

  const users = [
    { email: "admin@hvaclaunch.com", name: "Aaron Mitchell", passwordHash, role: "super_admin" as const, tenantId: null },
    { email: "yoojin@hvaclaunch.com", name: "YooJin Park", passwordHash, role: "agency_user" as const, tenantId: null },
    { email: "ben@hvaclaunch.com", name: "Ben Carter", passwordHash, role: "agency_user" as const, tenantId: null },
    { email: "brandon@apexhvac.com", name: "Brandon Hayes", passwordHash, role: "client_admin" as const, tenantId: 1 },
    { email: "dan@apexhvac.com", name: "Dan Collins", passwordHash, role: "client_user" as const, tenantId: 1 },
    { email: "corey@apexhvac.com", name: "Corey Mitchell", passwordHash, role: "client_user" as const, tenantId: 1 },
    { email: "owner@nordicclimate.com", name: "Erik Johansson", passwordHash, role: "client_admin" as const, tenantId: 2 },
  ];

  for (const user of users) {
    await db.insert(usersTable).values(user).onConflictDoNothing();
  }

  console.log(`Seeded ${users.length} users (password: demo1234)`);
  process.exit(0);
}

seedUsers().catch((err) => {
  console.error("Seed users failed:", err);
  process.exit(1);
});
