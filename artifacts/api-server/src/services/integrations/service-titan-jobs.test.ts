import { describe, expect, it } from "vitest";
import { formatSTJobForSync, getServiceTitanJobCancelledAt, type STJob } from "./service-titan";

function makeJob(jobStatus: string): STJob {
  return {
    id: 123,
    number: "J123",
    customerId: 456,
    locationId: 789,
    jobStatus,
    summary: "Estimate",
    total: 0,
    createdOn: "2026-06-01T10:00:00.000Z",
    completedOn: null,
  };
}

describe("ServiceTitan job formatting", () => {
  it("maps ServiceTitan Canceled jobs to the local cancelled status", () => {
    expect(formatSTJobForSync(makeJob("Canceled")).status).toBe("cancelled");
  });

  it("maps active ServiceTitan jobs into local non-completed statuses", () => {
    expect(formatSTJobForSync(makeJob("InProgress")).status).toBe("in_progress");
    expect(formatSTJobForSync(makeJob("Dispatched")).status).toBe("in_progress");
    expect(formatSTJobForSync(makeJob("Scheduled")).status).toBe("pending");
    expect(formatSTJobForSync(makeJob("Hold")).status).toBe("pending");
  });

  it("stores ServiceTitan createdOn separately as the job origin date", () => {
    expect(formatSTJobForSync(makeJob("Completed")).stJobOriginAt?.toISOString()).toBe("2026-06-01T10:00:00.000Z");
  });

  it("uses the newest active ServiceTitan canceled-log createdOn as the cancellation date", () => {
    const job = makeJob("Canceled");
    job.completedOn = "2026-06-04T20:00:00.000Z";
    job.modifiedOn = "2026-06-05T20:00:00.000Z";

    expect(getServiceTitanJobCancelledAt(job, [
      { id: 1, jobId: 123, createdOn: "2026-06-04T19:00:00.000Z", active: true },
      { id: 2, jobId: 123, createdOn: "2026-06-05T19:00:00.000Z", active: true },
      { id: 3, jobId: 123, createdOn: "2026-06-06T19:00:00.000Z", active: false },
    ])?.toISOString()).toBe("2026-06-05T19:00:00.000Z");
  });

  it("falls back to completedOn then modifiedOn only for canceled jobs", () => {
    const canceled = makeJob("Canceled");
    canceled.completedOn = "2026-06-04T20:00:00.000Z";
    canceled.modifiedOn = "2026-06-05T20:00:00.000Z";
    expect(getServiceTitanJobCancelledAt(canceled)?.toISOString()).toBe("2026-06-04T20:00:00.000Z");

    const canceledWithoutCompleted = makeJob("Canceled");
    canceledWithoutCompleted.modifiedOn = "2026-06-05T20:00:00.000Z";
    expect(getServiceTitanJobCancelledAt(canceledWithoutCompleted)?.toISOString()).toBe("2026-06-05T20:00:00.000Z");

    expect(getServiceTitanJobCancelledAt(makeJob("Completed"))).toBeNull();
  });
});
