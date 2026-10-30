import { useState } from "react";
import { mockDocuments } from "../data/Documents";

// Reuses the Maintenance page's list + detail layout
export function DocumentsPage() {
  const documents = mockDocuments;
  const [selectedId, setSelectedId] = useState<string | null>(documents[0]?.id ?? null);
  const selected = documents.find((doc) => doc.id === selectedId) ?? null;

  if (documents.length === 0) {
    return (
      <div className="maintenance-grid">
        <div className="maintenance-detail" style={{ gridColumn: "1 / -1" }}>
          <div className="maintenance-empty">
            No documents yet. Your lease will appear here once the office adds it.
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="maintenance-grid">
      <div className="maintenance-list" role="list" aria-label="Your documents">
        {documents.map((doc) => (
          <button
            key={doc.id}
            type="button"
            role="listitem"
            className="maintenance-item"
            aria-current={selectedId === doc.id}
            onClick={() => setSelectedId(doc.id)}
          >
            <div className="maintenance-item-top">
              <span className="maintenance-item-title">{doc.title}</span>
              <span className="status-badge status-badge--file">PDF</span>
            </div>
            <div className="maintenance-item-date">{doc.description}</div>
          </button>
        ))}
      </div>

      <div className="maintenance-detail">
        {selected ? (
          <>
            <div className="document-toolbar">
              <div>
                <h2>{selected.title}</h2>
                <div className="maintenance-detail-date">
                  Added {selected.addedDate} · PDF · {selected.sizeLabel}
                </div>
              </div>
              <div className="document-actions">
                <a className="btn btn--outline" href={selected.url} target="_blank" rel="noopener noreferrer">
                  Open in new tab
                </a>
                <a className="btn btn--primary" href={selected.url} download={selected.fileName}>
                  Download PDF
                </a>
              </div>
            </div>

            {/* Some phones show only the first page of an embedded PDF, so the
                buttons above are always the dependable way to read all of it. */}
            <iframe className="document-frame" src={selected.url} title={`${selected.title} (PDF)`} />

            <p className="document-note">
              This is the copy the office has on file. To ask about a change to your lease, contact the property
              office.
            </p>
          </>
        ) : (
          <div className="maintenance-empty">Select a document to view it.</div>
        )}
      </div>
    </div>
  );
}
