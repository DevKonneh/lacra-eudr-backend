/**
 * AgencyStaffingService — the single shared implementation of the Agency
 * staffing requirement: at least three DISTINCT active Agents and exactly
 * one active Clerk.
 *
 * Used in three places, all of which must agree:
 *   1. The /apply wizard's Step3OwnersPersonnel.tsx client-side validation
 *      (mirrored, not literally shared code, since that's a separate
 *      frontend repo — see countWizardPersonnel()'s doc comment for the
 *      exact parity contract).
 *   2. ApplicationController's server-side enforcement before an AGENCY
 *      application can be given final DG approval or have its certificate
 *      issued (validateWizardPersonnel()) — the backend must never trust
 *      the frontend's gating alone, exactly like REQUIRED_DOCUMENT_KEYS.
 *   3. AgencyImportService / AgencyController's post-issuance staffing
 *      flag (computeAndRefreshStaffingFlag()) — covers BOTH the historical
 *      import (where the flag is expected to be set on every single
 *      imported Agency, since the source package has zero confirmed
 *      Clerks) and live ongoing staffing drift after issuance (an Agent
 *      or Clerk later deactivated, dropping the Agency below the
 *      requirement).
 *
 * IMPORTANT — renewal: the spec requires enforcing this "before approving,
 * issuing, OR RENEWING" an Agency permit, but no renewal endpoint exists
 * anywhere in this codebase yet (Certificate.predecessorCertificateId and
 * Application's isRenewal/previousNumber fields are currently passive
 * display-only fields — nothing ever creates a renewal). assertStaffingMet()
 * is written as a standalone, reusable guard specifically so a future
 * renewal endpoint can call it directly without any changes here; it is
 * NOT otherwise wired into a renewal flow in this phase because there is
 * no renewal flow to wire it into. This gap is called out explicitly to
 * the project owner rather than silently assumed away.
 */

import { EntityManager } from "typeorm";
import { AppDataSource } from "../data-source";
import { Certificate } from "../entities/Certificate";
import { AgentPersonnel, AgentPersonnelRole, AgentPersonnelStatus } from "../entities/AgentPersonnel";

export const REQUIRED_ACTIVE_AGENTS = 3;
export const REQUIRED_ACTIVE_CLERKS = 1;

type Manager = typeof AppDataSource | EntityManager;

// ---------------------------------------------------------------------
// 1. Wizard-stage (pre-issuance) validation — operates on the
//    PersonnelRecord[] shape collected by the /apply wizard's Step 3 and
//    stored verbatim in Application.data.personnel. Only ACTIVE records
//    count toward the requirement (a PENDING or INACTIVE entry in the
//    roster does not satisfy it) — mirrors the frontend's countPersonnel()
//    except this additionally filters by status, since the frontend
//    PersonnelManager always creates new rows as ACTIVE and has no UI to
//    mark one otherwise; this backend guard is written to be correct
//    even if that ever changes.
// ---------------------------------------------------------------------
export interface WizardPersonnelLike {
    role?: string | null;
    status?: string | null;
    fullName?: string | null;
    nationalId?: string | null;
}

export function countWizardPersonnel(personnel: WizardPersonnelLike[] | null | undefined): { agents: number; clerks: number; distinctAgentKeys: string[] } {
    const list = Array.isArray(personnel) ? personnel : [];
    const isActive = (p: WizardPersonnelLike) => !p.status || p.status === "ACTIVE";
    const agentRecords = list.filter((p) => p.role === "Agent" && isActive(p));
    const clerkRecords = list.filter((p) => p.role === "Clerk" && isActive(p));
    // "Distinct" agents — dedupe by nationalId when present, else by
    // fullName — so three rows accidentally describing the same person
    // cannot be miscounted as three distinct Agents.
    const distinctAgentKeys = Array.from(
        new Set(agentRecords.map((p) => (p.nationalId && p.nationalId.trim()) || (p.fullName && p.fullName.trim()) || Math.random().toString(36)))
    );
    return { agents: distinctAgentKeys.length, clerks: clerkRecords.length, distinctAgentKeys };
}

export interface WizardStaffingResult {
    ok: boolean;
    agents: number;
    clerks: number;
    message?: string;
}

export function validateWizardStaffing(personnel: WizardPersonnelLike[] | null | undefined): WizardStaffingResult {
    const { agents, clerks } = countWizardPersonnel(personnel);
    if (agents < REQUIRED_ACTIVE_AGENTS || clerks !== REQUIRED_ACTIVE_CLERKS) {
        return {
            ok: false,
            agents,
            clerks,
            message: `At least ${REQUIRED_ACTIVE_AGENTS} distinct active Agents and exactly ${REQUIRED_ACTIVE_CLERKS} active Clerk are required. Currently: ${agents} agent(s), ${clerks} clerk(s).`,
        };
    }
    return { ok: true, agents, clerks };
}

// ---------------------------------------------------------------------
// 2. Post-issuance (persisted AgentPersonnel) staffing — operates on the
//    real, individually-identified AgentPersonnel rows linked to an
//    issued Agency's Certificate. This is what the Agency profile page's
//    "2 of 3 required Agents · 1 of 1 Clerk" display and the staffing
//    completeness filter on the register are both driven by.
// ---------------------------------------------------------------------
export interface AgencyStaffingSummary {
    activeAgents: number;
    activeClerks: number;
    requiredAgents: number;
    requiredClerks: number;
    meetsRequirement: boolean;
}

export async function computeAgencyStaffing(manager: Manager, agencyCertificateId: string): Promise<AgencyStaffingSummary> {
    const personnelRepo = manager.getRepository(AgentPersonnel);
    const rows = await personnelRepo.find({ where: { agencyCertificateId, status: AgentPersonnelStatus.ACTIVE } });
    const activeAgents = rows.filter((r) => r.role === AgentPersonnelRole.AGENT).length;
    const activeClerks = rows.filter((r) => r.role === AgentPersonnelRole.CLERK).length;
    return {
        activeAgents,
        activeClerks,
        requiredAgents: REQUIRED_ACTIVE_AGENTS,
        requiredClerks: REQUIRED_ACTIVE_CLERKS,
        meetsRequirement: activeAgents >= REQUIRED_ACTIVE_AGENTS && activeClerks === REQUIRED_ACTIVE_CLERKS,
    };
}

/**
 * Recomputes staffing for the given Agency certificate and writes the
 * result to Certificate.staffingFlagged / staffingFlagReason. Called:
 *   - once per Agency at the end of the historical import's apply() (every
 *     one of the 11 is expected to come out flagged, since the source
 *     package has zero confirmed Clerks — see AgencyImportService)
 *   - every time a live Agency's Agent/Clerk roster changes (appointment,
 *     replacement, deactivation) via AgencyController
 *   - right after a live AGENCY application's certificate is issued and
 *     its initial AgentPersonnel rows are created from the wizard roster
 *
 * Never changes Application.status or Certificate.isPubliclyBlocked —
 * per spec, incomplete staffing is flagged for review, it never
 * retroactively un-issues or blocks public verification of an
 * already-issued permit.
 */
export async function computeAndRefreshStaffingFlag(manager: Manager, agencyCertificateId: string): Promise<AgencyStaffingSummary> {
    const certRepo = manager.getRepository(Certificate);
    const summary = await computeAgencyStaffing(manager, agencyCertificateId);
    const certificate = await certRepo.findOne({ where: { id: agencyCertificateId } });
    if (certificate) {
        certificate.staffingFlagged = !summary.meetsRequirement;
        certificate.staffingFlagReason = summary.meetsRequirement
            ? null
            : `Staffing incomplete: ${summary.activeAgents} of ${summary.requiredAgents} required Agents, ${summary.activeClerks} of ${summary.requiredClerks} required Clerk. Flagged for staff review — the Agency's issued permit status is unaffected.`;
        await certRepo.save(certificate);
    }
    return summary;
}

/**
 * Standalone guard for an action that must be BLOCKED (not merely
 * flagged) while staffing is incomplete — approval, issuance, and (once
 * it exists) renewal. Throws rather than returning a boolean so callers
 * get a single, consistent error message across all three call sites.
 */
export class AgencyStaffingRequirementError extends Error {
    constructor(public readonly agents: number, public readonly clerks: number) {
        super(
            `This Agency application cannot proceed: at least ${REQUIRED_ACTIVE_AGENTS} distinct active Agents and exactly ${REQUIRED_ACTIVE_CLERKS} active Clerk are required. Currently registered: ${agents} agent(s), ${clerks} clerk(s).`
        );
        this.name = "AgencyStaffingRequirementError";
    }
}

export function assertWizardStaffingMet(personnel: WizardPersonnelLike[] | null | undefined): void {
    const result = validateWizardStaffing(personnel);
    if (!result.ok) {
        throw new AgencyStaffingRequirementError(result.agents, result.clerks);
    }
}
