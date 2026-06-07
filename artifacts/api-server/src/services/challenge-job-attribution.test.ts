import { describe, expect, it } from "vitest";
import {
  compareLeadCandidatesForJob,
  getChallengeJobAttributionAt,
  getLeadSearchWindowForJob,
  isJobWithinChallengeLeadWindow,
} from "./challenge-job-attribution";

describe("Challenge job attribution window", () => {
  it("uses ServiceTitan job origin before falling back to completion date", () => {
    expect(getChallengeJobAttributionAt({
      stJobOriginAt: "2026-06-02T10:00:00.000Z",
      completedAt: "2026-06-15T10:00:00.000Z",
      createdAt: "2026-06-20T10:00:00.000Z",
      status: "completed",
    })?.toISOString()).toBe("2026-06-02T10:00:00.000Z");

    expect(getChallengeJobAttributionAt({
      stJobOriginAt: null,
      completedAt: "2026-06-15T10:00:00.000Z",
      createdAt: "2026-06-20T10:00:00.000Z",
      status: "completed",
    })?.toISOString()).toBe("2026-06-15T10:00:00.000Z");
  });

  it("uses local createdAt only as a transition fallback for active jobs", () => {
    expect(getChallengeJobAttributionAt({
      stJobOriginAt: null,
      completedAt: null,
      createdAt: "2026-06-05T10:00:00.000Z",
      status: "pending",
    })?.toISOString()).toBe("2026-06-05T10:00:00.000Z");

    expect(getChallengeJobAttributionAt({
      stJobOriginAt: null,
      completedAt: null,
      createdAt: "2026-06-05T10:00:00.000Z",
      status: "cancelled",
    })).toBeNull();
  });

  it("counts jobs created within the 90-day downstream window for a lead", () => {
    expect(isJobWithinChallengeLeadWindow(
      "2026-06-01T12:00:00.000Z",
      "2026-08-30T12:00:00.000Z",
    )).toBe(true);

    expect(isJobWithinChallengeLeadWindow(
      "2026-06-01T12:00:00.000Z",
      "2026-08-31T12:00:01.000Z",
    )).toBe(false);
  });

  it("allows one day of lead/job timing grace but excludes older historical jobs", () => {
    expect(isJobWithinChallengeLeadWindow(
      "2026-06-01T12:00:00.000Z",
      "2026-05-31T12:00:00.000Z",
    )).toBe(true);

    expect(isJobWithinChallengeLeadWindow(
      "2026-06-01T12:00:00.000Z",
      "2026-05-31T11:59:59.000Z",
    )).toBe(false);
  });

  it("searches only the prior 90 days plus one forward grace day when matching jobs to leads", () => {
    const bounds = getLeadSearchWindowForJob(new Date("2026-06-15T09:00:00.000Z"));

    expect(bounds.earliestLeadAt.toISOString()).toBe("2026-03-17T09:00:00.000Z");
    expect(bounds.latestLeadAt.toISOString()).toBe("2026-06-16T09:00:00.000Z");
  });

  it("prefers the closest prior lead over a slightly later import-grace lead", () => {
    const jobAt = new Date("2026-06-15T09:00:00.000Z");
    const priorLead = new Date("2026-06-14T09:00:00.000Z");
    const laterGraceLead = new Date("2026-06-15T10:00:00.000Z");

    expect(compareLeadCandidatesForJob(jobAt, priorLead, laterGraceLead)).toBeLessThan(0);
    expect(compareLeadCandidatesForJob(jobAt, new Date("2026-06-12T09:00:00.000Z"), priorLead)).toBeGreaterThan(0);
  });
});
