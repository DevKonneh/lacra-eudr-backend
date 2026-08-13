import { AppDataSource } from "./data-source";
import { Role } from "./entities/Role";
import { UserRole } from "./entities/User";

const permissions = {
    commercial: [
        "business.view",
        "business.create",
        "license.view",
        "license.create", // On behalf of exporter? Or just review? Usually exporter creates.
        // Wait, request says "Commercial staff creates an Exporter profile" and "Commercial starts a License Application"
        // So Commercial needs create permissions.
        "license.review",
        "permit.view",
        "permit.create",
        "permit.review"
    ],
    dg: [
        "license.view",
        "license.approve",
        "permit.view",
        "permit.approve"
    ],
    finance: [
        "license.view",
        "license.issue",
        "permit.view",
        "permit.issue"
    ],
    exporter: [
        "license.create", // If they can self-serve? Request says "Commercial opens License Management... and starts a License Application". 
        // "Step 2 — Create a License Application. Commercial opens..."
        // So maybe Exporter doesn't create it themselves in this system version?
        // But "Step 9 ... exporter can proceed with export shipment".
        // Use "shipment.conditionally_create"
        "shipment.conditionally_create"
    ],
    local_buyer: [
        "permit.create" // If self-serve? Request says "Commercial goes to Permit Management... and starts an application".
        // So primarily Commercial does the data entry.
    ]
};

export const seedPermissions = async () => {
    const roleRepo = AppDataSource.getRepository(Role);

    const roles = [
        { name: "Commercial", permissions: permissions.commercial },
        { name: "DG", permissions: permissions.dg },
        { name: "Finance", permissions: permissions.finance },
        { name: "Exporter", permissions: permissions.exporter },
        { name: "Local Buyer", permissions: permissions.local_buyer },
        { name: "Admin", permissions: [...Object.values(permissions).flat(), "all"] } // Admin gets everything
    ];

    for (const r of roles) {
        let role = await roleRepo.findOneBy({ name: r.name });
        if (!role) {
            role = roleRepo.create({ name: r.name });
        }
        role.permissions = [...new Set(r.permissions)]; // Dedupe
        await roleRepo.save(role);
        console.log(`Seeded role: ${r.name} with ${r.permissions.length} permissions`);
    }
};

if (require.main === module) {
    AppDataSource.initialize().then(async () => {
        await seedPermissions();
        console.log("Permissions seeded successfully");
        process.exit(0);
    }).catch(error => console.log(error));
}
