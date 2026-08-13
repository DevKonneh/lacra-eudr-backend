
import { AppDataSource } from "./data-source";
import { Farm } from "./entities/Farm";
import { Farmer } from "./entities/Farmer";
import { RiskService } from "./services/RiskService";
import { User, UserRole } from "./entities/User";

const verifyRiskAnalysis = async () => {
    try {
        await AppDataSource.initialize();
        console.log("Database connected for verification.");

        const riskService = new RiskService();
        const farmRepo = AppDataSource.getRepository(Farm);
        const farmerRepo = AppDataSource.getRepository(Farmer);
        const userRepo = AppDataSource.getRepository(User);

        // 1. Create a Farmer
        let user = await userRepo.findOne({ where: { email: "risktest@example.com" } });
        if (!user) {
            user = userRepo.create({
                email: "risktest@example.com",
                password: "password123", // Encryption handled by entity/subscriber ideally, or raw for test
                role: UserRole.FARMER,
                name: "Risk Test Farmer",
                status: "ACTIVE" as any // UserStatus.ACTIVE
            });
            await userRepo.save(user);
        }

        let farmer = await farmerRepo.findOne({ where: { email: "risktest@example.com" } });
        if (!farmer) {
            farmer = farmerRepo.create({
                firstName: "Risk",
                lastName: "Tester",
                email: "risktest@example.com",
                phoneNumber: "1234567890",
                user: user
            });
            await farmerRepo.save(farmer);
        }

        // 2. Create a "Risky" Farm (Name contains "risk" to trigger mock deforestation check)
        const farmName = "High Risk Cocoa Plot";
        let farm = await farmRepo.findOne({ where: { name: farmName } });
        if (!farm) {
            farm = farmRepo.create({
                name: farmName,
                cropType: "Cocoa" as any,
                farmer: farmer,
                location: {
                    type: "Polygon",
                    coordinates: [[[0, 0], [0, 1], [1, 1], [1, 0], [0, 0]]]
                }
            });
            await farmRepo.save(farm);
        }

        console.log(`Farm created: ${farm.id}`);

        // 3. Run Risk Analysis
        console.log("Running risk assessment...");
        const assessment = await riskService.analyzeFarm(farm.id);

        console.log("Assessment Result:", assessment);

        // 4. Assertions
        if (assessment.overallRisk === "High" && assessment.deforestationRisk === true) {
            console.log("SUCCESS: High risk correctly identified.");
        } else {
            console.error("FAILURE: Expected High risk with deforestation flag.");
            process.exit(1);
        }

        process.exit(0);

    } catch (error) {
        console.error("Verification failed:", error);
        process.exit(1);
    }
};

verifyRiskAnalysis();
