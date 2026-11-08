/**
 * ComplianceActionService — applies a compliance action (Warning, Fine,
 * Suspend, Revoke, Reinstate) against either a Certificate (Agency or
 * Local Produce Buyer permit) or an individual AgentPersonnel record, and
 * records an immutable ComplianceAction audit row for it.
 *
 * Centralised here (rather than duplicated inside AgencyController and
 * LocalProduceBuyerController) so both registers apply IDENTICAL rules for
 * what each action type does to the subject's live status, and so a
 * future third register automatically gets the same behaviour for free.
 */
import { AppDataSource } from "../data-source";
import { Certificate } from "../entities/Certificate";
import { Application, ApplicationStatus } from "../entities/Application";
import { AgentPersonnel, AgentPersonnelStatus } from "../entities/AgentPersonnel";
import { ComplianceAction, ComplianceActionType, ComplianceSubjectType } from "../entities/ComplianceAction";

export class ComplianceActionError extends Error {}

interface ApplyParams {
    subjectType: ComplianceSubjectType;
    subjectId: string;
    actionType: ComplianceActionType;
    reason: string;
    fineAmount?: number;
    fineCurrency?: string;
    performedByUserId?: string;
    performedByName?: string;
}

const certificateRepo = () => AppDataSource.getRepository(Certificate);
const applicationRepo = () => AppDataSource.getRepository(Application);
const personnelRepo = () => AppDataSource.getRepository(AgentPersonnel);
const actionRepo = () => AppDataSource.getRepository(ComplianceAction);

export async function applyComplianceAction(params: ApplyParams): Promise<{ action: ComplianceAction; subject: Certificate | AgentPersonnel }> {
    const { subjectType, subjectId, actionType, reason, performedByUserId, performedByName } = params;

    if (!reason || !reason.trim()) {
        throw new ComplianceActionError("A reason is required for every compliance action.");
    }
    if (actionType === ComplianceActionType.FINE) {
        if (params.fineAmount === undefined || params.fineAmount === null || Number.isNaN(Number(params.fineAmount)) || Number(params.fineAmount) <= 0) {
            throw new ComplianceActionError("A positive fineAmount is required when actionType is FINE.");
        }
    }

    if (subjectType === ComplianceSubjectType.CERTIFICATE) {
        return applyToCertificate(params);
    }
    return applyToAgentPersonnel(params);
}

async function applyToCertificate(params: ApplyParams) {
    const certificate = await certificateRepo().findOne({ where: { id: params.subjectId } });
    if (!certificate) throw new ComplianceActionError("Certificate not found");

    const application = await applicationRepo().findOne({ where: { id: certificate.applicationId } });
    if (!application) throw new ComplianceActionError("Underlying application record not found");

    const previousStatus = application.status;
    let newStatus: ApplicationStatus | null = null;

    switch (params.actionType) {
        case ComplianceActionType.SUSPEND:
            if (application.status === ApplicationStatus.REVOKED) {
                throw new ComplianceActionError("Cannot suspend a revoked permit. Revocation is final.");
            }
            newStatus = ApplicationStatus.SUSPENDED;
            break;
        case ComplianceActionType.REVOKE:
            newStatus = ApplicationStatus.REVOKED;
            break;
        case ComplianceActionType.REINSTATE:
            if (application.status !== ApplicationStatus.SUSPENDED) {
                throw new ComplianceActionError(`Cannot reinstate a permit in status ${application.status}. Only a currently SUSPENDED permit can be reinstated.`);
            }
            newStatus = ApplicationStatus.ISSUED;
            break;
        case ComplianceActionType.WARNING:
        case ComplianceActionType.FINE:
            // Neither changes the certificate's live status — recorded as
            // a pure audit entry only.
            break;
    }

    if (newStatus) {
        application.status = newStatus;
        await applicationRepo().save(application);
    }

    const action = actionRepo().create({
        subjectType: ComplianceSubjectType.CERTIFICATE,
        subjectId: certificate.id,
        subjectName: certificate.buyerDisplayName,
        subjectPermitNumber: certificate.certificateNumber || certificate.stagedPermitNumber,
        actionType: params.actionType,
        reason: params.reason.trim(),
        fineAmount: params.actionType === ComplianceActionType.FINE ? Number(params.fineAmount) : null,
        fineCurrency: params.actionType === ComplianceActionType.FINE ? (params.fineCurrency || "LRD") : null,
        performedByUserId: params.performedByUserId,
        performedByName: params.performedByName,
        previousStatus: newStatus ? previousStatus : undefined,
        newStatus: newStatus || undefined,
    });
    await actionRepo().save(action);

    return { action, subject: certificate };
}

async function applyToAgentPersonnel(params: ApplyParams) {
    const person = await personnelRepo().findOne({ where: { id: params.subjectId } });
    if (!person) throw new ComplianceActionError("Personnel record not found");

    const previousStatus = person.status;
    let newStatus: AgentPersonnelStatus | null = null;

    switch (params.actionType) {
        case ComplianceActionType.SUSPEND:
            // AgentPersonnel has no SUSPENDED status of its own (only
            // ACTIVE/INACTIVE/REPLACED) — suspending an individual Agent is
            // modelled as setting them INACTIVE plus the ComplianceAction
            // audit trail recording WHY (distinct from a plain
            // deactivation, which has no reason requirement and isn't a
            // compliance action). Their public verification page already
            // shows AGENT_NOT_ACTIVE the moment status leaves ACTIVE.
            if (person.status !== AgentPersonnelStatus.ACTIVE) {
                throw new ComplianceActionError(`Cannot suspend this person while status is ${person.status}. Only an ACTIVE Agent/Clerk can be suspended.`);
            }
            newStatus = AgentPersonnelStatus.INACTIVE;
            person.isPubliclyBlocked = true;
            person.publicBlockReason = `Suspended: ${params.reason.trim()}`;
            break;
        case ComplianceActionType.REVOKE:
            newStatus = AgentPersonnelStatus.INACTIVE;
            person.isPubliclyBlocked = true;
            person.publicBlockReason = `Revoked: ${params.reason.trim()}`;
            break;
        case ComplianceActionType.REINSTATE:
            if (person.status !== AgentPersonnelStatus.INACTIVE) {
                throw new ComplianceActionError(`Cannot reinstate this person while status is ${person.status}. Only an INACTIVE record can be reinstated.`);
            }
            newStatus = AgentPersonnelStatus.ACTIVE;
            person.isPubliclyBlocked = false;
            person.publicBlockReason = null;
            break;
        case ComplianceActionType.WARNING:
        case ComplianceActionType.FINE:
            break;
    }

    person.historyLog = [
        ...(person.historyLog || []),
        {
            action: `COMPLIANCE_${params.actionType}`,
            date: new Date().toISOString(),
            note: params.reason.trim(),
            performedByName: params.performedByName || "Staff",
        },
    ];

    if (newStatus) {
        person.status = newStatus;
    }
    await personnelRepo().save(person);

    const action = actionRepo().create({
        subjectType: ComplianceSubjectType.AGENT_PERSONNEL,
        subjectId: person.id,
        subjectName: person.fullName,
        subjectPermitNumber: person.permitNumber,
        actionType: params.actionType,
        reason: params.reason.trim(),
        fineAmount: params.actionType === ComplianceActionType.FINE ? Number(params.fineAmount) : null,
        fineCurrency: params.actionType === ComplianceActionType.FINE ? (params.fineCurrency || "LRD") : null,
        performedByUserId: params.performedByUserId,
        performedByName: params.performedByName,
        previousStatus: newStatus ? previousStatus : undefined,
        newStatus: newStatus || undefined,
    });
    await actionRepo().save(action);

    return { action, subject: person };
}

export async function getComplianceHistory(subjectType: ComplianceSubjectType, subjectId: string) {
    return actionRepo().find({ where: { subjectType, subjectId }, order: { createdAt: "DESC" } });
}

export async function markFinePaid(actionId: string) {
    const action = await actionRepo().findOne({ where: { id: actionId } });
    if (!action) throw new ComplianceActionError("Compliance action not found");
    if (action.actionType !== ComplianceActionType.FINE) {
        throw new ComplianceActionError("Only a FINE action can be marked as paid");
    }
    action.finePaid = true;
    action.finePaidAt = new Date();
    await actionRepo().save(action);
    return action;
}
