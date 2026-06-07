export const CHALLENGE_JOB_ATTRIBUTION_WINDOW_DAYS = 90;
export const CHALLENGE_JOB_LEAD_GRACE_DAYS = 1;

const DAY_MS = 24 * 60 * 60 * 1000;

function toDate(value: Date | string | null | undefined): Date | null {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

export function getChallengeJobAttributionAt(job: {
  stJobOriginAt?: Date | string | null;
  completedAt?: Date | string | null;
  createdAt?: Date | string | null;
  status?: string | null;
}): Date | null {
  return toDate(job.stJobOriginAt)
    ?? toDate(job.completedAt)
    ?? (job.status === "pending" || job.status === "in_progress" ? toDate(job.createdAt) : null);
}

export function getLeadSearchWindowForJob(jobOriginAt: Date): {
  earliestLeadAt: Date;
  latestLeadAt: Date;
} {
  return {
    earliestLeadAt: new Date(jobOriginAt.getTime() - CHALLENGE_JOB_ATTRIBUTION_WINDOW_DAYS * DAY_MS),
    latestLeadAt: new Date(jobOriginAt.getTime() + CHALLENGE_JOB_LEAD_GRACE_DAYS * DAY_MS),
  };
}

export function isJobWithinChallengeLeadWindow(
  leadCreatedAt: Date | string | null | undefined,
  jobAttributionAt: Date | string | null | undefined,
): boolean {
  const leadDate = toDate(leadCreatedAt);
  const jobDate = toDate(jobAttributionAt);
  if (!leadDate || !jobDate) return false;

  const earliestJobAt = leadDate.getTime() - CHALLENGE_JOB_LEAD_GRACE_DAYS * DAY_MS;
  const latestJobAt = leadDate.getTime() + CHALLENGE_JOB_ATTRIBUTION_WINDOW_DAYS * DAY_MS;
  return jobDate.getTime() >= earliestJobAt && jobDate.getTime() <= latestJobAt;
}

export function compareLeadCandidatesForJob(
  jobOriginAt: Date,
  aLeadCreatedAt: Date,
  bLeadCreatedAt: Date,
): number {
  const aIsAfterJob = aLeadCreatedAt.getTime() > jobOriginAt.getTime();
  const bIsAfterJob = bLeadCreatedAt.getTime() > jobOriginAt.getTime();
  if (aIsAfterJob !== bIsAfterJob) return aIsAfterJob ? 1 : -1;
  return bLeadCreatedAt.getTime() - aLeadCreatedAt.getTime();
}
