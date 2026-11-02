import { useEffect, useState } from "react";
import type { NoticeType } from "../types";
import { useTenantData } from "../data/tenantData";
import { messageFor, tenantApi, type OfficeNotice } from "../api/tenant";

//icons will be improved
const icon: Record<NoticeType, string> = {
  payment: "✓",
  due: "!",
  maintenance: "🔧",
};

const day = (iso: string) => new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });

export function NoticesPage() {
  const { notices } = useTenantData();
  // 009: what the office wrote to the tenant, above the account notices. Opening the page marks them read.
  const [office, setOffice] = useState<OfficeNotice[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    tenantApi.officeNotices().then(
      (list) => {
        if (!live) return;
        setOffice(list);
        for (const n of list.filter((x) => !x.readAt)) tenantApi.markNoticeRead(n.id).catch(() => undefined);
      },
      (e) => live && setError(messageFor(e)),
    );
    return () => {
      live = false;
    };
  }, []);

  return (
    <>
      {error && <div className="portal-panel text-error" role="alert">{error}</div>}
      {office && office.length > 0 && (
        <section className="office-notices" aria-labelledby="office-notices">
          <h2 id="office-notices">From the office</h2>
          {office.map((n) => (
            <article key={n.id} className={`portal-panel office-notice${n.readAt ? "" : " office-notice--unread"}`}>
              <div className="office-notice__head">
                <div className="notice-title">
                  {n.subject}
                  {!n.readAt && <span className="office-notice__new">New</span>}
                </div>
                <div className="office-notice__meta">{day(n.createdAt)}</div>
              </div>
              <p className="office-notice__body">{n.body}</p>
            </article>
          ))}
        </section>
      )}
      {office && office.length > 0 && notices.length > 0 && <h2 className="notice-section-title">Your account</h2>}
      <div className="notice-grid">
        {notices.map((notice) => (
          <div className="portal-panel notice-card" key={notice.id}>
            <div className={`notice-icon notice-icon--${notice.type}`} aria-hidden="true">
              {icon[notice.type]}
            </div>
            <div>
              <div className="notice-title">{notice.title}</div>
              <div className="notice-body">{notice.body}</div>
              <div className="notice-next-step">{notice.nextStep}</div>
              <div className="notice-timestamp">{notice.timestamp}</div>
            </div>
          </div>
        ))}
      </div>
    </>
  );
}
