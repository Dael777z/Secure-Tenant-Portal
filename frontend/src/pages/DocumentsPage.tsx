import { useEffect, useState } from "react";
import { messageFor, tenantApi, type DocumentGroup } from "../api/tenant";

const day = (iso: string) => new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });

/** 009: the tenant's signed lease and the documents the office shared with them, by kind. */
export function DocumentsPage() {
  const [groups, setGroups] = useState<DocumentGroup[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    tenantApi.documents().then(
      (g) => live && setGroups(g),
      (e) => live && setError(messageFor(e)),
    );
    return () => {
      live = false;
    };
  }, []);

  if (!groups) {
    return (
      <div className="portal-panel docs-note" role={error ? "alert" : undefined}>
        {error ?? "Loading documents…"}
      </div>
    );
  }
  const filled = groups.filter((g) => g.documents.length > 0);
  if (filled.length === 0) {
    return <div className="portal-panel docs-note">No documents yet. When the office shares your lease, an inspection report or a notice, it appears here.</div>;
  }
  return (
    <div className="docs-groups">
      {filled.map((g) => (
        <section key={g.category} className="portal-panel docs-group" aria-labelledby={`docs-${g.category}`}>
          <h2 id={`docs-${g.category}`}>{g.label}</h2>
          <ul className="docs-list">
            {g.documents.map((d) => (
              <li key={`${d.kind}-${d.id}`}>
                <div>
                  <div className="docs-title">{d.title}</div>
                  <div className="docs-meta">
                    {d.filename} · added {day(d.uploadedAt)}
                  </div>
                </div>
                <a className="btn btn--outline" href={d.href} target="_blank" rel="noopener noreferrer">
                  Open
                </a>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}
