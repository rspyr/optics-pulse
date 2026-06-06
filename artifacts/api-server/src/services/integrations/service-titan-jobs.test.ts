import { describe, expect, it } from "vitest";
import { formatSTJobForSync, type STJob } from "./service-titan";

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
});
