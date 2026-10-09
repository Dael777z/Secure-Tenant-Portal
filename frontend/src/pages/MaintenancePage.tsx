import { useState } from "react";
import type { MaintenanceRequest, MaintenanceStatus } from "../types";
import { useTenantData } from "../data/tenantData";
import { messageFor, tenantApi } from "../api/tenant";

const statusLabel: Record<MaintenanceStatus, string> = {
  open: "Open",
  in_progress: "In progress",
  resolved: "Resolved",
};

export function MaintenancePage() {
  const { maintenanceRequests, refresh } = useTenantData();
  const [requests, setRequests] = useState<MaintenanceRequest[]>(maintenanceRequests);
  const [selectedId, setSelectedId] = useState<string | null>(requests[0]?.id ?? null);
  const [showForm, setShowForm] = useState(false);

  const selected = requests.find((r) => r.id === selectedId) ?? null;

  function handleSelect(id: string) {
    setShowForm(false);
    setSelectedId(id);
  }

  function handleNewRequest(newRequest: Omit<MaintenanceRequest, "id" | "submittedDate" | "status">) {
    // Saved on the server; the reply is the stored request.
    tenantApi
      .newMaintenanceRequest(newRequest.title, newRequest.description)
      .then((request) => {
        setRequests((prev) => [request, ...prev]);
        setSelectedId(request.id);
        setShowForm(false);
        void refresh();
      })
      .catch((caught) => window.alert(messageFor(caught)));
  }

  return (
    <div className="maintenance-grid">
      <div className="maintenance-list">
        <button type="button" className="maintenance-action" onClick={() => setShowForm(true)}>
          + New Request
        </button>
        <button type="button" className="maintenance-action maintenance-action--secondary">
          Text Property Management
        </button>

        {requests.map((req) => (
          <button
            key={req.id}
            type="button"
            className="maintenance-item"
            aria-current={selectedId === req.id && !showForm}
            onClick={() => handleSelect(req.id)}
          >
            <div className="maintenance-item-top">
              <span className="maintenance-item-title">{req.title}</span>
              <span className={`status-badge status-badge--${req.status}`}>
                {statusLabel[req.status]}
              </span>
            </div>
            <div className="maintenance-item-date">Submitted {req.submittedDate}</div>
          </button>
        ))}
      </div>

      <div className="maintenance-detail">
        {showForm ? (
          <NewRequestForm onSubmit={handleNewRequest} onCancel={() => setShowForm(false)} />
        ) : selected ? (
          <>
            <h2>{selected.title}</h2>
            <div className="maintenance-detail-date">Submitted {selected.submittedDate}</div>
            <p className="maintenance-detail-desc">{selected.description}</p>
          </>
        ) : (
          <div className="maintenance-empty">No requests yet. Use "+ New Request" to report an issue.</div>
        )}
      </div>
    </div>
  );
}

interface NewRequestFormProps {
  onSubmit: (request: { title: string; description: string }) => void;
  onCancel: () => void;
}

//Structured fields
function NewRequestForm({ onSubmit, onCancel }: NewRequestFormProps) {
  const [title, setTitle] = useState("");
  const [category, setCategory] = useState("plumbing");
  const [urgency, setUrgency] = useState("routine");
  const [details, setDetails] = useState("");

  function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (!title.trim()) return;
    const description = `Category: ${category} | Urgency: ${urgency}${
      details ? ` | ${details}` : ""
    }`;
    onSubmit({ title: title.trim(), description });
  }

  return (
    <form onSubmit={handleSubmit}>
      <h2 style={{ marginBottom: 16 }}>Submit a request</h2>

      <div className="form-group">
        <label className="field-label" htmlFor="req-title">
          What needs attention?
        </label>
        <input
          id="req-title"
          className="field-input"
          type="text"
          placeholder="e.g., Kitchen faucet leaking"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
        />
      </div>

      <div className="form-group">
        <label className="field-label" htmlFor="req-category">
          Category
        </label>
        <select
          id="req-category"
          className="field-select"
          value={category}
          onChange={(e) => setCategory(e.target.value)}
        >
          <option value="plumbing">Plumbing</option>
          <option value="electrical">Electrical</option>
          <option value="appliance">Appliance</option>
          <option value="hvac">Heating / Cooling</option>
          <option value="other">Other</option>
        </select>
      </div>

      <div className="form-group">
        <label className="field-label" htmlFor="req-urgency">
          Urgency
        </label>
        <select
          id="req-urgency"
          className="field-select"
          value={urgency}
          onChange={(e) => setUrgency(e.target.value)}
        >
          <option value="routine">Routine - can wait a few days</option>
          <option value="soon">Needs attention soon</option>
          <option value="urgent">Urgent - safety or major issue</option>
        </select>
      </div>

      <div className="form-group">
        <label className="field-label" htmlFor="req-details">
          Additional details
        </label>
        <textarea
          id="req-details"
          className="field-textarea"
          placeholder="Where it is, when it started, anything else we should know"
          value={details}
          onChange={(e) => setDetails(e.target.value)}
        />
      </div>

      <div style={{ display: "flex", gap: 10 }}>
        <button type="submit" className="btn btn--primary">
          Submit request
        </button>
        <button type="button" className="btn btn--outline" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}
