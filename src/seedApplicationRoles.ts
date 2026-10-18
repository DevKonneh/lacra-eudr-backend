import { AppDataSource } from "./data-source";
import { User, UserRole, UserStatus } from "./entities/User";
import bcrypt from "bcryptjs";

// Seeds the internal staff accounts needed to exercise the new
// Application workflow's stages: Commercial and Marketing Officer
// (verifies applications), Director-General (first + second approval),
// and Technical Services Officer (assigns inspectors, verifies warehouse
// assessment findings). Same pattern as seedInspector.ts — idempotent,
// run manually with `npx ts-node src/seedApplicationRoles.ts`.
const accounts = [
    { email: "commercial@lacra.gov.lr", password: "Commercial123!", role: UserRole.COMMERCIAL, name: "Commercial and Marketing Officer" },
    { email: "dg@lacra.gov.lr", password: "DirectorGeneral123!", role: UserRole.DG, name: "Director-General" },
    { email: "technical@lacra.gov.lr", password: "Technical123!", role: UserRole.TECHNICAL, name: "Technical Services Officer" },
    // Added for Phase 4 (Billing + Payment + Final DG Approval +
    // Certificate Issuance).
    { email: "finance@lacra.gov.lr", password: "Finance123!", role: UserRole.FINANCE, name: "Finance Officer" },
    { email: "it@lacra.gov.lr", password: "ItOfficer123!", role: UserRole.IT, name: "IT Officer" },
];

const seedApplicationRoles = async () => {
    try {
        await AppDataSource.initialize();
        const userRepository = AppDataSource.getRepository(User);

        for (const acc of accounts) {
            const existing = await userRepository.findOneBy({ email: acc.email });
            if (!existing) {
                const hashedPassword = await bcrypt.hash(acc.password, 10);
                const user = userRepository.create({
                    email: acc.email,
                    password: hashedPassword,
                    role: acc.role,
                    status: UserStatus.ACTIVE,
                    name: acc.name,
                });
                await userRepository.save(user);
                console.log(`Seeded: ${acc.email} / ${acc.password} (role: ${acc.role})`);
            } else {
                console.log(`Already exists: ${acc.email}`);
            }
        }
        process.exit(0);
    } catch (error) {
        console.error("Error seeding application-workflow roles", error);
        process.exit(1);
    }
};

seedApplicationRoles();
