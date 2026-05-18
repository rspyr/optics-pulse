import { useEffect } from "react";

const LAST_UPDATED = "May 18, 2026";
const CONTACT_EMAIL = "legal@hvaclaunch.ai";
const COMPANY = "HVAC Launch";
const PRODUCT = "Optics";

export default function Privacy() {
  useEffect(() => {
    document.title = `Privacy Policy — ${PRODUCT} by ${COMPANY}`;
  }, []);

  return (
    <div className="min-h-screen bg-background text-white">
      <div className="max-w-3xl mx-auto px-6 py-12">
        <header className="mb-10 pb-6 border-b border-white/10">
          <p className="text-xs uppercase tracking-widest text-muted-foreground mb-2">{COMPANY}</p>
          <h1 className="text-4xl font-bold mb-2">Privacy Policy</h1>
          <p className="text-sm text-muted-foreground">Last updated: {LAST_UPDATED}</p>
        </header>

        <div className="prose prose-invert max-w-none space-y-8 text-sm leading-relaxed">
          <section>
            <p>
              This Privacy Policy explains how {COMPANY} (&ldquo;{COMPANY},&rdquo; &ldquo;we,&rdquo;
              &ldquo;us,&rdquo; or &ldquo;our&rdquo;) collects, uses, shares, and protects
              information in connection with {PRODUCT}, our software platform that helps
              home-services businesses manage marketing performance, lead intake, and
              customer-relationship workflows (the &ldquo;Service&rdquo;). By using the Service, you
              agree to the practices described here.
            </p>
          </section>

          <section>
            <h2 className="text-xl font-semibold mb-3">1. Who this policy applies to</h2>
            <p>
              {PRODUCT} is sold to businesses (&ldquo;Customers&rdquo;). This policy covers:
            </p>
            <ul className="list-disc pl-6 space-y-1">
              <li>Customer employees who log in to use {PRODUCT};</li>
              <li>Visitors to our marketing website;</li>
              <li>End users (such as homeowners) whose information our Customers upload, sync, or capture through {PRODUCT}.</li>
            </ul>
            <p className="mt-3">
              When we process end-user information on behalf of a Customer, we act as a data
              processor and the Customer is the data controller. If you are an end user and want
              to exercise rights over your information, please contact the Customer first; we will
              support them in responding to your request.
            </p>
          </section>

          <section>
            <h2 className="text-xl font-semibold mb-3">2. Information we collect</h2>

            <h3 className="font-semibold mt-4 mb-2">a. Information you provide directly</h3>
            <ul className="list-disc pl-6 space-y-1">
              <li><strong>Account information:</strong> name, email address, phone number, role, and password (stored hashed).</li>
              <li><strong>Business information:</strong> company name, addresses, billing details, team members, and configuration preferences.</li>
              <li><strong>Support communications:</strong> messages you send to us by email or in-app.</li>
            </ul>

            <h3 className="font-semibold mt-4 mb-2">b. Information collected automatically</h3>
            <ul className="list-disc pl-6 space-y-1">
              <li><strong>Usage data:</strong> pages viewed, features used, actions taken, timestamps, and referring URLs.</li>
              <li><strong>Device and log data:</strong> IP address, browser type and version, operating system, device identifiers, and crash logs.</li>
              <li><strong>Cookies and similar technologies:</strong> session cookies for authentication, and limited analytics cookies. See Section 8.</li>
            </ul>

            <h3 className="font-semibold mt-4 mb-2">c. Information collected from connected third-party services</h3>
            <p>
              With explicit authorization from a Customer, {PRODUCT} connects to third-party
              platforms and retrieves data on the Customer&rsquo;s behalf. Depending on which
              integrations a Customer enables, this may include:
            </p>
            <ul className="list-disc pl-6 space-y-1">
              <li><strong>Meta (Facebook &amp; Instagram):</strong> ad-account IDs, page IDs, campaign and ad-set metadata, ad spend, impressions, clicks, conversions, lead-form submissions, and access tokens needed to read this data. We use Meta data solely to display marketing performance to the connecting Customer.</li>
              <li><strong>Google Ads:</strong> customer IDs, campaign and keyword metadata, spend, impressions, clicks, and conversions.</li>
              <li><strong>ServiceTitan:</strong> jobs, invoices, estimates, customer records (name, address, phone), and technician assignments needed to attribute revenue to marketing sources.</li>
              <li><strong>CallRail:</strong> call records, caller phone number, call recordings (where the Customer has enabled them), call duration, and tracking-number metadata.</li>
              <li><strong>Podium:</strong> message threads, contact phone numbers, and review-request status.</li>
              <li><strong>Web push and mobile push tokens:</strong> device tokens used to send notifications you have opted into.</li>
            </ul>
            <p className="mt-3">
              We only access the scopes that you authorize during the connection flow, and you can
              revoke that access at any time (see Section 7).
            </p>
          </section>

          <section>
            <h2 className="text-xl font-semibold mb-3">3. How we use information and why</h2>
            <ul className="list-disc pl-6 space-y-2">
              <li><strong>Deliver the Service:</strong> authenticate users, display dashboards, run lead routing, sync data from connected platforms, and send notifications you have requested.</li>
              <li><strong>Operate, secure, and improve the Service:</strong> diagnose problems, prevent abuse, monitor performance, and develop new features.</li>
              <li><strong>Communicate with Customers:</strong> respond to support requests, send service announcements, and provide onboarding assistance.</li>
              <li><strong>Comply with legal obligations:</strong> respond to lawful requests, enforce our terms, and protect the rights and safety of {COMPANY}, our Customers, and the public.</li>
            </ul>
            <p className="mt-3">
              We do <strong>not</strong> sell personal information. We do not use data obtained
              through the Meta Marketing API, Google Ads API, ServiceTitan, CallRail, or Podium to
              build advertising profiles or to target advertising to anyone.
            </p>
          </section>

          <section>
            <h2 className="text-xl font-semibold mb-3">4. Legal bases for processing</h2>
            <p>
              Where required (for example, under GDPR), we rely on the following legal bases:
              performance of a contract with the Customer; our legitimate interests in operating
              and improving the Service; consent (which you may withdraw at any time); and
              compliance with legal obligations.
            </p>
          </section>

          <section>
            <h2 className="text-xl font-semibold mb-3">5. How we share information</h2>
            <p>We share information only as described below:</p>
            <ul className="list-disc pl-6 space-y-2">
              <li><strong>With the Customer that owns the data:</strong> authorized users at the Customer account can view information associated with that account.</li>
              <li><strong>With service providers (subprocessors):</strong> cloud hosting, database, error monitoring, email delivery, push notification delivery, and customer-support tools, each bound by contractual confidentiality and data-protection obligations.</li>
              <li><strong>With third-party platforms you connect:</strong> when you authorize a connection (e.g., Meta, Google Ads), we exchange the credentials and data necessary to fulfill the integration.</li>
              <li><strong>For legal reasons:</strong> when required by law, regulation, legal process, or governmental request, or to protect rights, property, or safety.</li>
              <li><strong>Business transfers:</strong> in connection with a merger, acquisition, financing, or sale of assets, subject to standard confidentiality protections.</li>
            </ul>
          </section>

          <section>
            <h2 className="text-xl font-semibold mb-3">6. Data retention</h2>
            <p>
              We retain account and operational data for as long as a Customer&rsquo;s account is
              active, and for a reasonable period afterward to comply with legal obligations,
              resolve disputes, and enforce agreements. Logs and diagnostic data are typically
              retained for up to 12 months. When you delete data through the Service (or we delete
              it on your request under Section 7), we remove it from active systems and from
              backups on our standard backup-rotation schedule.
            </p>
          </section>

          <section>
            <h2 className="text-xl font-semibold mb-3">7. Your rights and how to delete your data</h2>
            <p>
              Depending on your jurisdiction, you may have the right to access, correct, export,
              restrict, or delete your personal information, and to object to certain processing.
              To exercise any of these rights, including a request to delete your data, contact us
              at <a className="text-yellow-400 underline" href={`mailto:${CONTACT_EMAIL}`}>{CONTACT_EMAIL}</a>.
            </p>
            <p className="mt-3">
              <strong>To request deletion of your data:</strong> send an email to{" "}
              <a className="text-yellow-400 underline" href={`mailto:${CONTACT_EMAIL}?subject=Data%20Deletion%20Request`}>{CONTACT_EMAIL}</a>{" "}
              with the subject &ldquo;Data Deletion Request&rdquo; and include the email address
              or account associated with the data. We will confirm receipt within 7 days and
              complete the deletion within 30 days, except where we are required to retain
              information by law.
            </p>
            <p className="mt-3">
              <strong>Disconnecting third-party integrations:</strong> you can revoke access at any
              time from within the Service&rsquo;s integration settings, or by removing {PRODUCT}{" "}
              from your connected account on the third-party platform&rsquo;s settings page (for
              example, at <a className="text-yellow-400 underline" href="https://www.facebook.com/settings?tab=business_tools" target="_blank" rel="noreferrer">Facebook&rsquo;s Business Integrations</a> or{" "}
              <a className="text-yellow-400 underline" href="https://myaccount.google.com/permissions" target="_blank" rel="noreferrer">Google Account Permissions</a>). Revoking access stops further data sync; to also delete previously synced data, submit a deletion request as described above.
            </p>
          </section>

          <section>
            <h2 className="text-xl font-semibold mb-3">8. Cookies and similar technologies</h2>
            <p>
              We use a small number of strictly necessary cookies to keep you signed in and to
              protect against cross-site request forgery. We may also use limited first-party
              analytics to understand aggregate product usage. We do not use third-party
              advertising cookies on the Service. You can block or delete cookies in your browser
              settings, but doing so may break sign-in functionality.
            </p>
          </section>

          <section>
            <h2 className="text-xl font-semibold mb-3">9. Security</h2>
            <p>
              We use industry-standard measures to protect information, including encryption in
              transit (HTTPS/TLS), encryption at rest for sensitive credentials and tokens, scoped
              access controls, and audit logging. No method of transmission or storage is 100%
              secure, and we cannot guarantee absolute security.
            </p>
          </section>

          <section>
            <h2 className="text-xl font-semibold mb-3">10. International data transfers</h2>
            <p>
              {PRODUCT} is operated from the United States. If you access the Service from
              outside the United States, your information will be transferred to, stored, and
              processed in the United States or other countries where our service providers
              operate. We use appropriate safeguards for such transfers where required by law.
            </p>
          </section>

          <section>
            <h2 className="text-xl font-semibold mb-3">11. Children</h2>
            <p>
              The Service is not directed to children under 16, and we do not knowingly collect
              personal information from children. If you believe a child has provided us with
              personal information, please contact us so we can delete it.
            </p>
          </section>

          <section>
            <h2 className="text-xl font-semibold mb-3">12. Changes to this policy</h2>
            <p>
              We may update this Privacy Policy from time to time. When we make material changes,
              we will update the &ldquo;Last updated&rdquo; date above and, where appropriate,
              notify Customers through the Service or by email. Your continued use of the Service
              after the changes take effect constitutes acceptance of the updated policy.
            </p>
          </section>

          <section>
            <h2 className="text-xl font-semibold mb-3">13. Contact us</h2>
            <p>
              If you have questions about this Privacy Policy or our privacy practices, or to
              exercise any of your rights, please contact us at{" "}
              <a className="text-yellow-400 underline" href={`mailto:${CONTACT_EMAIL}`}>{CONTACT_EMAIL}</a>.
            </p>
          </section>
        </div>

        <footer className="mt-12 pt-6 border-t border-white/10 text-xs text-muted-foreground">
          &copy; {new Date().getFullYear()} {COMPANY}. All rights reserved.
        </footer>
      </div>
    </div>
  );
}
