import { useEffect, useRef, useState } from "react";
import type { MaintenanceRequest, MaintenanceStatus } from "../types";
import { useTenantData } from "../data/tenantData";
import { MESSAGE_MAX_LENGTH, messageFor, tenantApi, type OfficeMessage } from "../api/tenant";
import { byDay, clockTime, lastIndexFrom, receiptText } from "../components/messageTime";

const statusLabel: Record<MaintenanceStatus, string> = {
  open: "Open",
  in_progress: "In progress",
  resolved: "Resolved",
};

type DetailView = "detail" | "form" | "text";

export function MaintenancePage() {
  const { maintenanceRequests, refresh } = useTenantData();
  const [requests, setRequests] = useState<MaintenanceRequest[]>(maintenanceRequests);
  const [selectedId, setSelectedId] = useState<string | null>(requests[0]?.id ?? null);
  const [view, setView] = useState<DetailView>("detail");

  const selected = requests.find((r) => r.id === selectedId) ?? null;

  // Replies from the office the tenant has not opened: a badge on "Text Property Management".
  const [unreadReplies, setUnreadReplies] = useState(0);
  useEffect(() => {
    const check = () => tenantApi.messages().then((r) => setUnreadReplies(r.unread), () => undefined);
    void check();
    const timer = setInterval(() => document.visibilityState === "visible" && void check(), 30_000);
    return () => clearInterval(timer);
  }, []);

  function handleSelect(id: string) {
    setView("detail");
    setSelectedId(id);
  }

  function handleNewRequest(newRequest: Omit<MaintenanceRequest, "id" | "submittedDate" | "status">) {
    // Saved on the server; the reply is the stored request.
    tenantApi
      .newMaintenanceRequest(newRequest.title, newRequest.description)
      .then((request) => {
        setRequests((prev) => [request, ...prev]);
        setSelectedId(request.id);
        setView("detail");
        void refresh();
      })
      .catch((caught) => window.alert(messageFor(caught)));
  }

  return (
    <div className="maintenance-grid">
      <div className="maintenance-list">
        <button type="button" className="maintenance-action" aria-pressed={view === "form"} onClick={() => setView("form")}>
          + New Request
        </button>
        <button type="button" className="maintenance-action maintenance-action--secondary" aria-pressed={view === "text"} onClick={() => setView("text")}>
          Text Property Management
          {unreadReplies > 0 && view !== "text" && (
            <span className="maintenance-action-badge" aria-label={`${unreadReplies} new from the office`}>
              {unreadReplies}
            </span>
          )}
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
          <TextManagementPanel onClose={() => setView("detail")} onRead={() => setUnreadReplies(0)} />
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

// Juan's "Text Property Management" screen (tenant-side-ui f2e3beb), now the
// real conversation with the office (src/routes/messages.ts). Opening it marks
// the office's messages read, which is the receipt the manager sees. New
// replies are checked for every few seconds while it is open.
const THREAD_EVERY_MS = 10_000;

interface TextManagement {
  onClose: () => void;
  /** The office's messages were just read (the button's badge goes away). */
  onRead: () => void;
}

function TextManagementPanel({ onClose, onRead }: TextManagement) {
  const [messages, setMessages] = useState<OfficeMessage[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const threadRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let live = true;
    const load = async () => {
      try {
        const result = await tenantApi.messages();
        if (!live) return;
        setLoadError(null);
        if (result.unread > 0) {
          await tenantApi.markMessagesRead();
          onRead();
          const fresh = await tenantApi.messages();
          if (live) setMessages(fresh.messages);
        } else {
          setMessages(result.messages);
        }
      } catch (caught) {
        if (live) setLoadError(messageFor(caught));
      }
    };
    void load();
    const timer = setInterval(() => document.visibilityState === "visible" && void load(), THREAD_EVERY_MS);
    return () => {
      live = false;
      clearInterval(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const count = messages?.length ?? 0;
  useEffect(() => {
    const thread = threadRef.current;
    if (thread) thread.scrollTop = thread.scrollHeight;
  }, [count]);

  async function handleSend() {
    const body = draft.trim();
    if (!body || sending) return;
    setSending(true);
    setSendError(null);
    try {
      const sent = await tenantApi.sendMessage(body);
      setMessages((prev) => [...(prev ?? []), sent]);
      setDraft("");
    } catch (caught) {
      setSendError(messageFor(caught));
    } finally {
      setSending(false);
    }
  }

    function handleSubmit(event: React.FormEvent) {
      event.preventDefault();
      void handleSend();
    }

    function handleKeyDown(event: React.KeyboardEvent<HTMLTextAreaElement>) {
      if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault();
        void handleSend();
      }
    }

    const receiptAt = messages ? lastIndexFrom(messages, "tenant") : -1;

    return (
      <div className="text-panel">
        <div className="text-panel-header">
          <div>
            <h2>Property Management</h2>
            <p className="text-panel-sub">The leasing office usually replies within one business day.</p>
          </div>
          <button type="button" className="btn btn--outline" onClick={onClose}>
            Close
          </button>
        </div>

        <div className="text-thread" ref={threadRef} role="log" aria-live="polite" aria-label="messages">
          {messages === null ? (
            <div className="text-thread-note">{loadError ?? "Loading messages…"}</div>
          ) : messages.length === 0 ? (
            <div className="text-bubble text-bubble--office">
              <div>Hi. Message the property office here about a repair or any questions.</div>
            </div>
          ) : (
            byDay(messages).map((group) => (
              <div key={group.day} className="text-day">
                <div className="text-day-label">{group.day}</div>
                {group.messages.map((message) => {
                  const index = messages.indexOf(message);
                  return (
                    <div key={message.id} className={`text-bubble-row text-bubble-row--${message.from}`}>
                      <div className={`text-bubble text-bubble--${message.from}`}>
                        {message.from === "office" && message.senderName && <div className="text-bubble-sender">{message.senderName}</div>}
                        <div>{message.body}</div>
                        <div className="text-bubble-time">{clockTime(message.sentAt)}</div>
                      </div>
                      {index === receiptAt && (
                        <div className={`text-receipt${message.readAt ? " text-receipt--seen" : ""}`}>{receiptText(message.readAt, "the office")}</div>
                      )}
                    </div>
                  );
                })}
              </div>
            ))
          )}
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
            maxLength={MESSAGE_MAX_LENGTH}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={handleKeyDown}
          />
          <button type="submit" className="btn btn--primary" disabled={!draft.trim() || sending}>
            {sending ? "Sending…" : "Send"}
          </button>
        </form>
        {sendError && (
          <div className="text-error" role="alert">
            {sendError}
          </div>
        )}
      </div>
    );
  }
