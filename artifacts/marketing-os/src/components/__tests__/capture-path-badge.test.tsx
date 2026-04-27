import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { CapturePathBadge } from "../capture-path-badge";

describe("CapturePathBadge — shared chip used by live feed and historical side-peek", () => {
  it("renders nothing for null/undefined formType", () => {
    const { container: c1 } = render(<CapturePathBadge formType={null} />);
    expect(c1.firstChild).toBeNull();
    const { container: c2 } = render(<CapturePathBadge formType={undefined} />);
    expect(c2.firstChild).toBeNull();
  });

  it("renders nothing for the native capture path (no chip needed)", () => {
    const { container } = render(<CapturePathBadge formType="native" />);
    expect(container.firstChild).toBeNull();
  });

  it("renders nothing for unknown form types so we don't create stray chips", () => {
    const { container } = render(<CapturePathBadge formType="something-new" />);
    expect(container.firstChild).toBeNull();
  });

  it("renders an amber honeypot-rescue badge with the wide-scan tooltip", () => {
    render(<CapturePathBadge formType="honeypot-rescue" />);
    const badge = screen.getByTestId("capture-path-badge-honeypot-rescue");
    expect(badge).toHaveTextContent(/honeypot-rescue/);
    expect(badge.getAttribute("title") ?? "").toMatch(/wide-scan|honeypot/i);
    expect(badge.className).toMatch(/amber/);
  });

  it("renders a purple leadconnector badge with its own tooltip wording", () => {
    render(<CapturePathBadge formType="leadconnector" />);
    const badge = screen.getByTestId("capture-path-badge-leadconnector");
    expect(badge).toHaveTextContent(/leadconnector/);
    expect(badge.getAttribute("title") ?? "").toMatch(/GoHighLevel|LeadConnector/);
    expect(badge.className).toMatch(/purple/);
  });

  it("renders gravity and wpcf7 badges with their builder-specific tooltips", () => {
    const { unmount } = render(<CapturePathBadge formType="gravity" />);
    const gravity = screen.getByTestId("capture-path-badge-gravity");
    expect(gravity).toHaveTextContent(/gravity/);
    expect(gravity.getAttribute("title") ?? "").toMatch(/Gravity Forms/);
    unmount();

    render(<CapturePathBadge formType="wpcf7" />);
    const wpcf7 = screen.getByTestId("capture-path-badge-wpcf7");
    expect(wpcf7).toHaveTextContent(/wpcf7/);
    expect(wpcf7.getAttribute("title") ?? "").toMatch(/Contact Form 7/);
  });
});
