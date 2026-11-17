import { UserRole } from "../../entities/User";
import {
    PERMISSIONS,
    ALL_PERMISSIONS,
    WILDCARD_PERMISSION,
    DEFAULT_ROLE_PERMISSIONS,
    getEffectivePermissions,
    hasPermission,
    hasAllPermissions,
    isSubsetOfActorPermissions,
} from "../permissions";

describe("config/permissions", () => {
    describe("getEffectivePermissions", () => {
        it("always resolves ADMIN to the wildcard, regardless of assignedRole", () => {
            const admin = { role: UserRole.ADMIN, assignedRole: { permissions: [] } };
            expect(getEffectivePermissions(admin)).toEqual([WILDCARD_PERMISSION]);

            const adminNoRole = { role: UserRole.ADMIN, assignedRole: null };
            expect(getEffectivePermissions(adminNoRole)).toEqual([WILDCARD_PERMISSION]);
        });

        it("falls back to DEFAULT_ROLE_PERMISSIONS when no assignedRole is set (migration-safety path)", () => {
            const commercial = { role: UserRole.COMMERCIAL, assignedRole: null };
            expect(getEffectivePermissions(commercial)).toEqual(DEFAULT_ROLE_PERMISSIONS[UserRole.COMMERCIAL]);

            const inspector = { role: UserRole.INSPECTOR, assignedRole: undefined };
            expect(getEffectivePermissions(inspector)).toEqual(DEFAULT_ROLE_PERMISSIONS[UserRole.INSPECTOR]);
        });

        it("uses EXACTLY the assignedRole's permissions when present (narrowing, not unioned with role defaults)", () => {
            // A COMMERCIAL account's default includes LICENSE_CREATE, but a
            // custom Role might grant only LICENSE_VIEW - the narrower set
            // must win entirely, not be unioned with the coarse-role default.
            const narrowed = {
                role: UserRole.COMMERCIAL,
                assignedRole: { permissions: [PERMISSIONS.LICENSE_VIEW] },
            };
            const effective = getEffectivePermissions(narrowed);
            expect(effective).toEqual([PERMISSIONS.LICENSE_VIEW]);
            expect(effective).not.toContain(PERMISSIONS.LICENSE_CREATE);
        });

        it("allows an assignedRole to even restrict access below the default (empty permissions array)", () => {
            const locked = { role: UserRole.DG, assignedRole: { permissions: [] } };
            expect(getEffectivePermissions(locked)).toEqual([]);
        });

        it("returns an empty array for a role with no entry (defensive fallback)", () => {
            const unknown = { role: "SOMETHING_UNEXPECTED" as UserRole, assignedRole: null };
            expect(getEffectivePermissions(unknown)).toEqual([]);
        });
    });

    describe("hasPermission / hasAllPermissions", () => {
        it("grants everything when the wildcard is present", () => {
            expect(hasPermission([WILDCARD_PERMISSION], PERMISSIONS.USER_DELETE)).toBe(true);
            expect(hasAllPermissions([WILDCARD_PERMISSION], [PERMISSIONS.USER_DELETE, PERMISSIONS.ROLE_EDIT])).toBe(true);
        });

        it("checks exact permission membership without the wildcard", () => {
            expect(hasPermission([PERMISSIONS.FARMER_VIEW], PERMISSIONS.FARMER_VIEW)).toBe(true);
            expect(hasPermission([PERMISSIONS.FARMER_VIEW], PERMISSIONS.FARMER_DELETE)).toBe(false);
        });

        it("hasAllPermissions requires every listed permission to be present", () => {
            const granted = [PERMISSIONS.LICENSE_VIEW, PERMISSIONS.LICENSE_APPROVE];
            expect(hasAllPermissions(granted, [PERMISSIONS.LICENSE_VIEW])).toBe(true);
            expect(hasAllPermissions(granted, [PERMISSIONS.LICENSE_VIEW, PERMISSIONS.LICENSE_ISSUE])).toBe(false);
        });
    });

    describe("isSubsetOfActorPermissions (privilege-escalation guard)", () => {
        it("an actor holding the wildcard can grant anything, including the wildcard itself", () => {
            expect(isSubsetOfActorPermissions([PERMISSIONS.USER_DELETE], [WILDCARD_PERMISSION])).toBe(true);
            expect(isSubsetOfActorPermissions([WILDCARD_PERMISSION], [WILDCARD_PERMISSION])).toBe(true);
        });

        it("an actor WITHOUT the wildcard can never grant the wildcard", () => {
            expect(isSubsetOfActorPermissions([WILDCARD_PERMISSION], [PERMISSIONS.USER_DELETE, PERMISSIONS.USER_EDIT])).toBe(false);
        });

        it("an actor can grant any subset of their own permissions", () => {
            const actor = [PERMISSIONS.LICENSE_VIEW, PERMISSIONS.LICENSE_APPROVE, PERMISSIONS.LICENSE_ISSUE];
            expect(isSubsetOfActorPermissions([PERMISSIONS.LICENSE_VIEW], actor)).toBe(true);
            expect(isSubsetOfActorPermissions([PERMISSIONS.LICENSE_VIEW, PERMISSIONS.LICENSE_APPROVE], actor)).toBe(true);
        });

        it("an actor CANNOT grant a permission they themselves do not hold (the core self-escalation guard)", () => {
            const actor = [PERMISSIONS.LICENSE_VIEW];
            expect(isSubsetOfActorPermissions([PERMISSIONS.LICENSE_VIEW, PERMISSIONS.USER_DELETE], actor)).toBe(false);
            expect(isSubsetOfActorPermissions([PERMISSIONS.USER_DELETE], actor)).toBe(false);
        });

        it("an empty candidate permission set is always a valid subset", () => {
            expect(isSubsetOfActorPermissions([], [])).toBe(true);
            expect(isSubsetOfActorPermissions([], [PERMISSIONS.USER_VIEW])).toBe(true);
        });
    });

    describe("catalog integrity", () => {
        it("every DEFAULT_ROLE_PERMISSIONS entry (except the ADMIN wildcard) only references known permissions", () => {
            for (const [role, perms] of Object.entries(DEFAULT_ROLE_PERMISSIONS)) {
                for (const p of perms) {
                    if (p === WILDCARD_PERMISSION) continue;
                    expect(ALL_PERMISSIONS).toContain(p);
                }
            }
        });

        it("has a DEFAULT_ROLE_PERMISSIONS entry for every UserRole value", () => {
            for (const role of Object.values(UserRole)) {
                expect(DEFAULT_ROLE_PERMISSIONS[role]).toBeDefined();
            }
        });
    });

    // Business/Batch/Transfer/Shipment enforcement (added when
    // business.routes.ts / batch.routes.ts / transfer.routes.ts /
    // shipment.routes.ts gained their first requirePermission(...) checks
    // — previously these four route files had NO fine-grained permission
    // enforcement at all, only (in business.routes.ts's case) a coarse
    // role allow-list, or (batch/transfer/shipment) no restriction
    // whatsoever beyond being logged in).
    describe("Business/Batch/Transfer/Shipment permissions", () => {
        it("PERMISSIONS catalog defines BUSINESS_VIEW and BUSINESS_CREATE", () => {
            expect(PERMISSIONS.BUSINESS_VIEW).toBe("business.view");
            expect(PERMISSIONS.BUSINESS_CREATE).toBe("business.create");
            expect(ALL_PERMISSIONS).toContain(PERMISSIONS.BUSINESS_VIEW);
            expect(ALL_PERMISSIONS).toContain(PERMISSIONS.BUSINESS_CREATE);
        });

        it("every internal staff role that could already reach the business/batch/transfer/shipment routes keeps VIEW access (zero regression)", () => {
            // Matches business.routes.ts's existing
            // authMiddleware([ADMIN, COMMERCIAL, DG]) allow-list on GET /.
            expect(hasPermission(DEFAULT_ROLE_PERMISSIONS[UserRole.COMMERCIAL], PERMISSIONS.BUSINESS_VIEW)).toBe(true);
            expect(hasPermission(DEFAULT_ROLE_PERMISSIONS[UserRole.DG], PERMISSIONS.BUSINESS_VIEW)).toBe(true);

            // batch/transfer/shipment routes had NO role restriction
            // before this change — every existing internal staff role
            // must keep VIEW access.
            for (const role of [
                UserRole.INSPECTOR, UserRole.BUYER, UserRole.EXPORTER,
                UserRole.FINANCE, UserRole.TECHNICAL, UserRole.IT, UserRole.DG,
            ]) {
                expect(hasPermission(DEFAULT_ROLE_PERMISSIONS[role], PERMISSIONS.BATCH_VIEW)).toBe(true);
                expect(hasPermission(DEFAULT_ROLE_PERMISSIONS[role], PERMISSIONS.TRANSFER_VIEW)).toBe(true);
                expect(hasPermission(DEFAULT_ROLE_PERMISSIONS[role], PERMISSIONS.SHIPMENT_VIEW)).toBe(true);
            }

            // FARMER and FIELD_SUPERVISOR never had a legitimate reason to
            // browse this registry — they are correctly NOT granted VIEW.
            expect(hasPermission(DEFAULT_ROLE_PERMISSIONS[UserRole.FARMER], PERMISSIONS.BATCH_VIEW)).toBe(false);
            expect(hasPermission(DEFAULT_ROLE_PERMISSIONS[UserRole.FIELD_SUPERVISOR], PERMISSIONS.BATCH_VIEW)).toBe(false);
        });

        it("SECURITY FIX: only ADMIN (wildcard) and DG hold SHIPMENT_APPROVE — closes the self-approval loophole on shipment validate()/DDS issuance", () => {
            expect(hasPermission(DEFAULT_ROLE_PERMISSIONS[UserRole.DG], PERMISSIONS.SHIPMENT_APPROVE)).toBe(true);

            // Every other role — crucially EXPORTER, who OWNS the shipment
            // being validated and previously had no restriction stopping
            // them from issuing their own official DDS — must NOT hold
            // SHIPMENT_APPROVE.
            for (const role of [
                UserRole.EXPORTER, UserRole.INSPECTOR, UserRole.BUYER,
                UserRole.FARMER, UserRole.COMMERCIAL, UserRole.FINANCE,
                UserRole.TECHNICAL, UserRole.IT, UserRole.FIELD_SUPERVISOR,
            ]) {
                expect(hasPermission(DEFAULT_ROLE_PERMISSIONS[role], PERMISSIONS.SHIPMENT_APPROVE)).toBe(false);
            }
        });

        it("EXPORTER keeps self-service SHIPMENT_CREATE (bundling their own batches for export is not a staff approval action)", () => {
            expect(hasPermission(DEFAULT_ROLE_PERMISSIONS[UserRole.EXPORTER], PERMISSIONS.SHIPMENT_CREATE)).toBe(true);
        });

        it("INSPECTOR and BUYER keep TRANSFER_CREATE (recording a handover/purchase is an existing legitimate workflow for both)", () => {
            expect(hasPermission(DEFAULT_ROLE_PERMISSIONS[UserRole.INSPECTOR], PERMISSIONS.TRANSFER_CREATE)).toBe(true);
            expect(hasPermission(DEFAULT_ROLE_PERMISSIONS[UserRole.BUYER], PERMISSIONS.TRANSFER_CREATE)).toBe(true);
        });
    });
});
