// Messages: the office's conversations with residents (src/routes/messages.ts).
// The list on the left (Inbox / Archived), the open conversation on the right.
// Opening a conversation is the receipt the resident sees ("Seen by the office").
// No live connection: the list and the open conversation check for new
// messages every few seconds while the page is visible.
import { useCallback, useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { byDay, clockTime, lastIndexFrom, listTime, receiptText } from "../components/messageTime";
import { MESSAGE_MAX_LENGTH, managerApi, managerMessage, type Conversation, type ThreadSummary } from "./api";
import { Empty, Loading, Modal, PageHeader, initials, useManager } from "./ui";

const LIST_EVERY_MS = 15_000;
const THREAD_EVERY_MS = 10_000;

/** Run `load` now, whenever `deps` change, and every `everyMs` while the tab is visible. */
function usePolling<T>(load: (() => Promise<T>) | null, everyMs: number, deps: unknown[]) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const loadRef = useRef(load);
  loadRef.current = load;

  const reload = useCallback(async () => {
    const run = loadRef.current;
    if (!run) return;
    try {
      setData(await run());
      setError(null);
    } catch (e) {
      setError(managerMessage(e));
    }
  }, []);

  useEffect(() => {
    setData(null);
    setError(null);
    if (!loadRef.current) return;
    void reload();
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") void reload();
    }, everyMs);
    return () => clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  return { data, error, reload, setData };
}

export function MessagesPage({ tenantId, onUnreadChange }: { tenantId?: number; onUnreadChange: () => void }) {
  const { go, version } = useManager();
  const [box, setBox] = useState<"inbox" | "archived">("inbox");
  const [search, setSearch] = useState("");
  const [picking, setPicking] = useState(false);

  const list = usePolling(() => managerApi.threads(box), LIST_EVERY_MS, [box, version]);
  const q = search.trim().toLowerCase();
  const threads = (list.data ?? []).filter(
    (t) => !q || t.tenantName.toLowerCase().includes(q) || (t.unitLabel ?? "").toLowerCase().includes(q) || t.lastMessage.body.toLowerCase().includes(q),
  );
  const inboxUnread = box === "inbox" ? (list.data ?? []).filter((t) => t.unread > 0).length : null;

  const refreshList = useCallback(() => {
    void list.reload();
    onUnreadChange();
  }, [list, onUnreadChange]);

  return (
    <>
      <PageHeader
        title="Messages"
        subtitle="Conversations with residents. Replies appear in the resident's portal, and each side sees when the other has read a message."
        actions={
          <button type="button" className="mgr-btn mgr-btn--primary" onClick={() => setPicking(true)}>
            + New message
          </button>
        }
      />
      <div className={`mgr-msg${tenantId ? " mgr-msg--open" : ""}`}>
        <section className="mgr-card mgr-msg__list" aria-label="Conversations">
          <div className="mgr-msg__list-head">
            <div className="mgr-tabs" role="tablist" aria-label="Conversations">
              {(["inbox", "archived"] as const).map((value) => (
                <button
                  key={value}
                  type="button"
                  role="tab"
                  aria-selected={box === value}
                  className={`mgr-tab${box === value ? " mgr-tab--active" : ""}`}
                  onClick={() => setBox(value)}
                >
                  {value === "inbox" ? "Inbox" : "Archived"}
                  {value === "inbox" && inboxUnread ? <span className="mgr-msg__count">{inboxUnread}</span> : null}
                </button>
              ))}
            </div>
            <input
              type="search"
              className="mgr-msg__search"
              aria-label="Search conversations"
              placeholder="Search name, unit or message"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
          {!list.data ? (
            <Loading error={list.error} />
          ) : threads.length === 0 ? (
            <Empty>{q ? "No conversations match." : box === "inbox" ? "No conversations yet. Residents' messages arrive here." : "Nothing archived."}</Empty>
          ) : (
            <ul className="mgr-msg__threads">
              {threads.map((t) => (
                <ThreadRow key={t.tenantId} thread={t} active={t.tenantId === tenantId} onOpen={() => go({ name: "messages", tenantId: t.tenantId })} />
              ))}
            </ul>
          )}
        </section>

        <section className="mgr-card mgr-msg__pane" aria-label="Conversation">
          {tenantId ? (
            <ConversationPane
              key={tenantId}
              tenantId={tenantId}
              onBack={() => go({ name: "messages" })}
              onActivity={refreshList}
              onArchivedChange={(archived) => {
                setBox(archived ? "archived" : "inbox");
                refreshList();
              }}
              showBox={(archived) => setBox(archived ? "archived" : "inbox")}
            />
          ) : (
            <div className="mgr-msg__placeholder">
              <span className="mgr-msg__placeholder-mark" aria-hidden="true">✉</span>
              <p className="mgr-h3">Select a conversation</p>
              <p className="mgr-muted">Or start one with any resident using New message.</p>
            </div>
          )}
        </section>
      </div>
      {picking && <NewMessagePicker onClose={() => setPicking(false)} onPick={(id) => { setPicking(false); go({ name: "messages", tenantId: id }); }} />}
    </>
  );
}

function ThreadRow({ thread: t, active, onOpen }: { thread: ThreadSummary; active: boolean; onOpen: () => void }) {
  const unread = t.unread > 0;
  return (
    <li>
      <button
        type="button"
        className={`mgr-msg__thread${active ? " mgr-msg__thread--active" : ""}${unread ? " mgr-msg__thread--unread" : ""}`}
        aria-current={active ? "true" : undefined}
        onClick={onOpen}
      >
        <span className="mgr-msg__avatar" aria-hidden="true">{initials(t.tenantName)}</span>
        <span className="mgr-msg__thread-text">
          <span className="mgr-msg__thread-top">
            <strong>{t.tenantName}</strong>
            <time dateTime={t.lastMessage.sentAt}>{listTime(t.lastMessage.sentAt)}</time>
          </span>
          {t.unitLabel && <span className="mgr-msg__unit">{t.unitLabel}</span>}
          <span className="mgr-msg__preview">
            {t.lastMessage.from === "office" && <span className="mgr-muted">You: </span>}
            {t.lastMessage.body}
          </span>
        </span>
        {unread && (
          <span className="mgr-msg__unread" aria-label={`${t.unread} unread`}>
            {t.unread}
          </span>
        )}
      </button>
    </li>
  );
}

function ConversationPane({
  tenantId,
  onBack,
  onActivity,
  onArchivedChange,
  showBox,
}: {
  tenantId: number;
  onBack: () => void;
  onActivity: () => void;
  onArchivedChange: (archived: boolean) => void;
  showBox: (archived: boolean) => void;
}) {
  const { go, changed } = useManager();
  const convo = usePolling<Conversation>(() => managerApi.conversation(tenantId), THREAD_EVERY_MS, [tenantId]);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  const [archiving, setArchiving] = useState(false);
  const threadRef = useRef<HTMLDivElement>(null);
  const shownBox = useRef(false);
  const data = convo.data;
  const count = data?.messages.length ?? 0;

  // Opening the conversation is the receipt: mark the resident's unread messages read.
  const unreadFromTenant = data?.messages.some((m) => m.from === "tenant" && !m.readAt) ?? false;
  useEffect(() => {
    if (!unreadFromTenant) return;
    managerApi.markMessagesRead(tenantId).then(
      () => {
        void convo.reload();
        onActivity();
      },
      () => undefined,
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [unreadFromTenant, tenantId]);

  // An archived conversation opened from a link: show the Archived list beside it.
  useEffect(() => {
    if (data && !shownBox.current) {
      shownBox.current = true;
      showBox(data.archived);
    }
  }, [data, showBox]);

  useEffect(() => {
    const el = threadRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [count]);

  async function send() {
    const body = draft.trim();
    if (!body || sending) return;
    setSending(true);
    setFailed(null);
    try {
      const message = await managerApi.sendMessage(tenantId, body);
      convo.setData((c) => (c ? { ...c, messages: [...c.messages, message] } : c));
      setDraft("");
      onActivity();
    } catch (e) {
      setFailed(managerMessage(e));
    } finally {
      setSending(false);
    }
  }

  async function setArchived(archived: boolean) {
    setArchiving(true);
    setFailed(null);
    try {
      await managerApi.archiveConversation(tenantId, archived);
      changed(archived ? "Conversation archived. It returns to the inbox if the resident writes again." : "Conversation moved to the inbox.");
      if (archived) onBack();
      else void convo.reload();
      onArchivedChange(archived);
    } catch (e) {
      setFailed(managerMessage(e));
    } finally {
      setArchiving(false);
    }
  }

  if (!data) return <div className="mgr-msg__pad"><Loading error={convo.error} /></div>;

  const { tenant, messages } = data;
  const firstName = tenant.name.split(/\s+/)[0] || tenant.name;
  const receiptAt = lastIndexFrom(messages, "office");
  const remaining = MESSAGE_MAX_LENGTH - draft.length;

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      void send();
    }
  }

  return (
    <div className="mgr-msg__convo">
      <header className="mgr-msg__convo-head">
        <button type="button" className="mgr-btn mgr-btn--link mgr-msg__back" onClick={onBack}>
          ← All conversations
        </button>
        <div className="mgr-msg__who">
          <span className="mgr-msg__avatar mgr-msg__avatar--large" aria-hidden="true">{initials(tenant.name)}</span>
          <div>
            <h2 className="mgr-h2">{tenant.name}</h2>
            <p className="mgr-muted">
              {[tenant.unitLabel ?? "No current lease", tenant.email, tenant.phone].filter(Boolean).join(" · ")}
            </p>
          </div>
        </div>
        <div className="mgr-row-actions">
          {tenant.leaseId !== null && (
            <button type="button" className="mgr-btn mgr-btn--secondary mgr-btn--small" onClick={() => go({ name: "lease", id: tenant.leaseId! })}>
              View lease
            </button>
          )}
          {messages.length > 0 &&
            (data.archived ? (
              <button type="button" className="mgr-btn mgr-btn--ghost mgr-btn--small" disabled={archiving} onClick={() => void setArchived(false)}>
                Move to inbox
              </button>
            ) : (
              <button type="button" className="mgr-btn mgr-btn--ghost mgr-btn--small" disabled={archiving} onClick={() => void setArchived(true)}>
                Archive
              </button>
            ))}
        </div>
      </header>
      {data.archived && <p className="mgr-msg__banner">Archived. It moves back to the inbox when {firstName} writes again.</p>}

      <div className="mgr-msg__log" ref={threadRef} role="log" aria-live="polite" aria-label={`Messages with ${tenant.name}`}>
        {messages.length === 0 ? (
          <p className="mgr-msg__empty">No messages yet. Write to {firstName} below; it appears in their portal.</p>
        ) : (
          byDay(messages).map((group) => (
            <div key={group.day} className="mgr-msg__day">
              <p className="mgr-msg__day-label"><span>{group.day}</span></p>
              {group.messages.map((m) => {
                const index = messages.indexOf(m);
                return (
                  <div key={m.id} className={`mgr-msg__bubble-row mgr-msg__bubble-row--${m.from}`}>
                    <div className={`mgr-msg__bubble mgr-msg__bubble--${m.from}`}>{m.body}</div>
                    <div className="mgr-msg__meta">
                      {m.from === "office" ? `${m.senderName ?? "Office"} · ` : ""}
                      <time dateTime={m.sentAt}>{clockTime(m.sentAt)}</time>
                    </div>
                    {index === receiptAt && (
                      <div className={`mgr-msg__receipt${m.readAt ? " mgr-msg__receipt--seen" : ""}`}>{receiptText(m.readAt, firstName)}</div>
                    )}
                  </div>
                );
              })}
            </div>
          ))
        )}
      </div>

      <form
        className="mgr-msg__composer"
        onSubmit={(e: FormEvent) => {
          e.preventDefault();
          void send();
        }}
      >
        {failed && <p className="mgr-alert mgr-alert--error" role="alert">{failed}</p>}
        <label className="mgr-sr" htmlFor="mgr-msg-draft">Reply to {tenant.name}</label>
        <textarea
          id="mgr-msg-draft"
          rows={3}
          maxLength={MESSAGE_MAX_LENGTH}
          placeholder={`Write to ${firstName}…`}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={onKeyDown}
        />
        <div className="mgr-msg__composer-foot">
          <span className="mgr-muted">{remaining < 200 ? `${remaining} characters left` : "Enter sends · Shift+Enter adds a line"}</span>
          <button type="submit" className="mgr-btn mgr-btn--primary" disabled={!draft.trim() || sending}>
            {sending ? "Sending…" : "Send"}
          </button>
        </div>
      </form>
    </div>
  );
}

function NewMessagePicker({ onClose, onPick }: { onClose: () => void; onPick: (tenantId: number) => void }) {
  const [tenants, setTenants] = useState<Awaited<ReturnType<typeof managerApi.tenants>> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  useEffect(() => {
    managerApi.tenants().then(setTenants, (e) => setError(managerMessage(e)));
  }, []);
  const q = search.trim().toLowerCase();
  const rows = (tenants ?? []).filter((t) => !q || t.name.toLowerCase().includes(q) || t.email.includes(q) || (t.unitLabel ?? "").toLowerCase().includes(q));

  return (
    <Modal title="New message" onClose={onClose}>
      <div className="mgr-form">
        <input type="search" aria-label="Find a resident" placeholder="Find a resident by name, email or unit" value={search} onChange={(e) => setSearch(e.target.value)} />
        {!tenants ? (
          <Loading error={error} />
        ) : rows.length === 0 ? (
          <Empty>No residents match.</Empty>
        ) : (
          <ul className="mgr-msg__picker">
            {rows.map((t) => (
              <li key={t.id}>
                <button type="button" className="mgr-msg__picker-row" onClick={() => onPick(t.id)}>
                  <span className="mgr-msg__avatar" aria-hidden="true">{initials(t.name)}</span>
                  <span>
                    <strong>{t.name}</strong>
                    <span className="mgr-muted">{t.unitLabel ?? "No lease"}{t.signedUp ? "" : " · not signed up yet (they see it once they do)"}</span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Modal>
  );
}
