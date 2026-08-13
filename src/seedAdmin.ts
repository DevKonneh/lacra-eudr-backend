import { AppDataSource } from "./data-source";
import { User, UserRole } from "./entities/User";
import bcrypt from "bcryptjs";

const seedAdmin = async () => {
    try {
        await AppDataSource.initialize();
        const userRepository = AppDataSource.getRepository(User);

        const email = "admin@eudr.com";
        const existingAdmin = await userRepository.findOneBy({ email });

        if (!existingAdmin) {
            const hashedPassword = await bcrypt.hash("admin123", 10);
            const admin = userRepository.create({
                email,
                password: hashedPassword,
                role: UserRole.ADMIN,
                name: "System Admin"
            });
            await userRepository.save(admin);
            console.log("Admin user seeded: admin@eudr.com / admin123");
        } else {
            console.log("Admin user already exists.");
        }
        process.exit(0);
    } catch (error) {
        console.error("Error seeding admin", error);
        process.exit(1);
    }
};

seedAdmin();
