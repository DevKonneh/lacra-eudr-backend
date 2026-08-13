import { AppDataSource } from "./data-source";
import { User, UserRole, UserStatus } from "./entities/User";
import bcrypt from "bcryptjs";

const seedInspector = async () => {
    try {
        await AppDataSource.initialize();
        const userRepository = AppDataSource.getRepository(User);

        const email = "inspector@eudr.com";
        const existing = await userRepository.findOneBy({ email });

        if (!existing) {
            const hashedPassword = await bcrypt.hash("Inspector123!", 10);
            const inspector = userRepository.create({
                email,
                password: hashedPassword,
                role: UserRole.INSPECTOR,
                status: UserStatus.ACTIVE,
                name: "John Inspector"
            });
            await userRepository.save(inspector);
            console.log("Inspector user seeded: inspector@eudr.com / Inspector123!");
        } else {
            console.log("Inspector user already exists.");
        }
        process.exit(0);
    } catch (error) {
        console.error("Error seeding inspector", error);
        process.exit(1);
    }
};

seedInspector();
