import { useEffect, useRef, useState } from "react";
import type { MaintenanceRequest, MaintenanceStatus } from "../types";
import { mockMaintenanceRequests } from "../data/mockData";

const statusLabel: Record<MaintenanceStatus, string> = {
  open: "Open",
  in_progress: "In progress",
  resolved: "Resolved",
};

type DetailView = "detail" | "form" | "text";


export function MaintenancePage() {
  const [requests, setRequests] = useState<MaintenanceRequest[]>(mockMaintenanceRequests);
  const [selectedId, setSelectedId] = useState<string | null>(requests[0]?.id ?? null);
  // const [showForm, setShowForm] = useState(false);
  const [view, setView] = useState<DetailView>("detail");


  const selected = requests.find((r) => r.id === selectedId) ?? null;

  function handleSelect(id: string) {
    // setShowForm(false);
    setView("detail");
    setSelectedId(id);
  }

  function handleNewRequest(newRequest: Omit<MaintenanceRequest, "id" | "submittedDate" | "status">) {
    const request: MaintenanceRequest = {
      id: `mr_${Date.now()}`,
      submittedDate: new Date().toLocaleDateString("en-US", {
        month: "short",
        day: "numeric",
        year: "numeric",
      }),
      status: "open",
      ...newRequest,
    };
    setRequests((prev) => [request, ...prev]);
    setSelectedId(request.id);
    setView("detail");
    // setShowForm(false);
  }

  return (
    <div className="maintenance-grid">
      <div className="maintenance-list">
        <button type="button" className="maintenance-action" aria-pressed={view === "form"} onClick={() => setView("form")}>
          + New Request
        </button>
        <button type="button" className="maintenance-action maintenance-action--secondary" aria-pressed={view === "text"} onClick={() => setView("text")}>
          Message Property Management 
        </button>

        {requests.map((req) => (
          <button
            key={req.id}
            type="button"
            className="maintenance-item"
            aria-current={selectedId === req.id && view === "detail"}
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
        {view === "form" ? (
          <NewRequestForm onSubmit={handleNewRequest} onCancel={() => setView("detail")} />
        ) : view === "text" ? (
          <TextManagementPanel onClose={() => setView("detail")} />
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
          <option value="Appliance">Appliance</option>
          <option value="Electricity">Electricity</option>
          <option value="Heat/AC">Heating/AC</option>
          <option value="Property">Property</option>
          <option value="Security">Security</option>
          <option value="Sidewalk/Parking">Sidewalk/Parking</option>
          <option value="Water">Water</option>
          <option value="Other">Other</option>
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

interface TextMessage {
  id: string;
  from: "tenant" | "office";
  body: string;
  time: string;
}

interface TextManagement {
  onClose: () => void;
}

function TextManagementPanel({ onClose }: TextManagement) {
  const [messages, setMessages] = useState<TextMessage[]>([
    {
      id: "m_welcome",
      from: "office",
      body: "Hi. Message the property office here about a repair or any quesitons.",
      time: "",

    },
  ]);
  const [draft, setDraft] = useState("");
  const threadRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const thread = threadRef.current;
    if (thread) thread.scrollTop = thread.scrollHeight;
  }, [messages]);

  function handleSend() {
    const body = draft.trim();
    if (!body) return;
    setMessages((prev) => [
      ...prev,
      {
        id: 'm_${Date.now()}',
        from: "tenant",
        body,
        time: new Date().toLocaleDateString([], { hour: "numeric", minute: "2-digit"}),
      },
    ]);
    setDraft("");
    }

    function handleSubmit(event: React.FormEvent) {
      event.preventDefault();
      handleSend();
    }

    function handleKeyDown(event: React.KeyboardEvent<HTMLTextAreaElement>) {
      if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault();
        handleSend();
      }
    }

    return (
      <div className="text-panel">
        <div className="text-panel-header">
          <h2>Property Management</h2>
          <button type="button" className="btn btn--outline" onClick={onClose}>
            Close
          </button>
        </div>

        <div className="text-thread" ref={threadRef} role="log" aria-live="polite" aria-label="messages">
          {messages.map((message) => (
            <div key={message.id} className={'text-bubble text-bubble--${message.from}'}>
              <div>{message.body}</div>
              {message.time && <div className="text-bubble-time">{message.time}</div>}
            </div>
          ))}
        </div>

        <form className="text-composer" onSubmit={handleSubmit}>
          <label className="sr-only" htmlFor="text-draft">
            Message to Property Management
          </label>
          <textarea
            id="text-draft"
            className="field-textarea text-composer-input"
            placeholder="Type a message"
            rows={3}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={handleKeyDown}
          />
          <button type="submit" className="btn btn-primary" disabled={!draft.trim()}>
            Send
          </button>
        </form>
      </div>
    );
  }
