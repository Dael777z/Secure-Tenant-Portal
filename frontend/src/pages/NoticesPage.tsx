import type { NoticeType } from "../types";
import { mockNotices } from "../data/mockData";

//icons will be improved
const icon: Record<NoticeType, string> = {
  payment: "✓",
  due: "!",
  maintenance: "🔧",
};

export function NoticesPage() {
  return (
    <div className="notice-grid">
      {mockNotices.map((notice) => (
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
  );
}
