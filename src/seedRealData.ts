
import "reflect-metadata";
import { AppDataSource } from "./data-source";
import { User, UserRole } from "./entities/User";
import { License, LicenseType, LicenseStatus } from "./entities/License";
import { Farmer } from "./entities/Farmer";
import { Farm, CropType } from "./entities/Farm";
import { Forest, RiskLevel } from "./entities/Forest";
import * as bcrypt from "bcryptjs";
import QRCode from 'qrcode';

async function seed() {
    await AppDataSource.initialize();
    console.log("Database connected for seeding");

    // 1. Create Admin
    const adminRepo = AppDataSource.getRepository(User);
    let admin = await adminRepo.findOneBy({ email: "admin@eudr.com" });
    if (!admin) {
        admin = new User();
        admin.email = "admin@eudr.com";
        admin.password = await bcrypt.hash("admin123", 10);
        admin.role = UserRole.ADMIN;
        admin.name = "Super Admin";
        await adminRepo.save(admin);
        console.log("Admin created");
    }

    // 2. Create Licensed Buyer (User + License)
    let buyer = await adminRepo.findOneBy({ email: "buyer@eudr.com" });
    if (!buyer) {
        buyer = new User();
        buyer.email = "buyer@eudr.com";
        buyer.password = await bcrypt.hash("buyer123", 10);
        buyer.role = UserRole.BUYER; // Using COMPANY for buyer
        buyer.name = "Global Cocoa Buyers Ltd";
        await adminRepo.save(buyer);

        const licenseRepo = AppDataSource.getRepository(License);
        const license = new License();
        license.user = buyer;
        license.holderName = buyer.name;
        license.type = LicenseType.AGENCY;
        license.status = LicenseStatus.ACTIVE;
        license.licenseNumber = "LIC-REF-2024";
        license.validFrom = new Date();
        license.validTo = new Date(new Date().setFullYear(new Date().getFullYear() + 1));
        await licenseRepo.save(license);
        console.log("Buyer & License created");
    }

    // 3. Create Forests (Protected Areas)
    const forestRepo = AppDataSource.getRepository(Forest);

    // Forest 1: Kakum National Park Area (Approx)
    // Coords: ~ -1.35, 5.35 center
    const forest1 = new Forest();
    forest1.name = "Kakum National Reserve";
    forest1.riskLevel = RiskLevel.HIGH;
    forest1.geom = {
        type: "MultiPolygon",
        coordinates: [[
            [
                [-1.50, 5.30],
                [-1.30, 5.30],
                [-1.30, 5.45],
                [-1.50, 5.45],
                [-1.50, 5.30]
            ]
        ]]
    };
    await forestRepo.save(forest1);
    console.log("Forest 1 seeded (Kakum)");

    // 4. Create Farmers
    const farmerRepo = AppDataSource.getRepository(Farmer);
    const farmRepo = AppDataSource.getRepository(Farm);

    // Farmer A: SAFE (Outside Forest)
    // Location: -1.60, 5.20 (South West of Kakum)
    let farmerA = new Farmer();
    farmerA.firstName = "Kofi";
    farmerA.lastName = "Mensah";
    farmerA.phoneNumber = "+233555000111";
    farmerA.farmerId = "FARMER-SAFE-001";
    await farmerRepo.save(farmerA);

    const farmA = new Farm();
    farmA.name = "Mensah Cocoa Farm";
    farmA.cropType = CropType.COCOA;
    farmA.farmer = farmerA;
    farmA.location = {
        type: "Point",
        coordinates: [-1.60, 5.20]
    };
    await farmRepo.save(farmA);
    console.log("Farmer A (Safe) created");

    // Farmer B: RISKY (Inside Kakum Forest)
    // Location: -1.40, 5.40 (Inside the box defined above)
    let farmerB = new Farmer();
    farmerB.firstName = "Kwame";
    farmerB.lastName = "Addo";
    farmerB.phoneNumber = "+233555000222";
    farmerB.farmerId = "FARMER-RISK-002";
    await farmerRepo.save(farmerB);

    const farmB = new Farm();
    farmB.name = "Addo Deep Forest Farm";
    farmB.cropType = CropType.COCOA;
    farmB.farmer = farmerB;
    farmB.location = {
        type: "Point",
        coordinates: [-1.40, 5.40]
    };
    await farmRepo.save(farmB);
    console.log("Farmer B (Risky) created");

    console.log("Seeding Complete!");
    process.exit(0);
}

seed().catch(err => {
    console.error(err);
    process.exit(1);
});
