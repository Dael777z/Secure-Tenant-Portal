// The public "Homes for rent" page at /listings: published listings, no
// sign-in. "Ask about this home" sends an inquiry that reaches the office as a
// lead (Listings → the listing's leads).
import { useEffect, useState, type FormEvent } from "react";
import "./public.css";

interface PublicListing {
  id: number;
  title: string;
  description: string | null;
  askingRent: number;
  availableOn: string | null;
  beds: number | null;
  baths: number | null;
  sqft: number | null;
  amenities: string[];
  pets: string | null;
  city: string | null;
  photoIds: number[];
}

const rent = (n: number) => n.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: n % 1 ? 2 : 0 });

function availability(day: string | null): string {
  if (!day) return "Available now";
  const d = new Date(`${day}T12:00:00Z`);
  return d.getTime() <= Date.now() ? "Available now" : `Available ${d.toLocaleDateString("en-US", { month: "long", day: "numeric", timeZone: "UTC" })}`;
}

function rooms(l: PublicListing): string {
  return [
    l.beds === null ? null : l.beds === 0 ? "Studio" : `${l.beds} bed`,
    l.baths === null ? null : `${l.baths} bath`,
    l.sqft ? `${l.sqft.toLocaleString("en-US")} sq ft` : null,
  ]
    .filter(Boolean)
    .join(" · ");
}

export function PublicListingsPage() {
  const [listings, setListings] = useState<PublicListing[] | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    document.title = "Homes for rent";
    fetch("/api/public/listings")
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((body: { listings: PublicListing[] }) => setListings(body.listings))
      .catch(() => setFailed(true));
  }, []);

  return (
    <div className="pub">
      <header className="pub-head">
        <div className="pub-wrap">
          <p className="pub-eyebrow">Now leasing</p>
          <h1>Homes for rent</h1>
          <p className="pub-lede">Every listing here is available from the owner's office directly. Ask about one and the office will get back to you.</p>
        </div>
      </header>
      <main className="pub-wrap pub-main">
        {failed ? (
          <p className="pub-empty" role="alert">Listings couldn't load right now. Please try again in a few minutes.</p>
        ) : listings ? (
          listings.length === 0 ? (
            <p className="pub-empty">Nothing is listed right now. Please check back soon.</p>
          ) : (
            <div className="pub-list">
              {listings.map((l) => (
                <ListingCard key={l.id} listing={l} />
              ))}
            </div>
          )
        ) : (
          <p className="pub-empty">Loading listings…</p>
        )}
      </main>
      <footer className="pub-wrap pub-foot">
        <p>Equal Housing Opportunity. Rents and availability can change; the office confirms both before any application.</p>
      </footer>
    </div>
  );
}

function ListingCard({ listing: l }: { listing: PublicListing }) {
  const [photo, setPhoto] = useState(0);
  const [asking, setAsking] = useState(false);
  const meta = rooms(l);
  return (
    <article className="pub-card" aria-labelledby={`listing-${l.id}`}>
      <div className="pub-photo">
        {l.photoIds.length ? (
          <>
            <img src={`/api/public/listings/${l.id}/photos/${l.photoIds[photo]}`} alt={`${l.title}, photo ${photo + 1} of ${l.photoIds.length}`} loading="lazy" />
            {l.photoIds.length > 1 && (
              <div className="pub-photo__nav">
                <button type="button" aria-label="Previous photo" onClick={() => setPhoto((photo - 1 + l.photoIds.length) % l.photoIds.length)}>‹</button>
                <span>{photo + 1} / {l.photoIds.length}</span>
                <button type="button" aria-label="Next photo" onClick={() => setPhoto((photo + 1) % l.photoIds.length)}>›</button>
              </div>
            )}
          </>
        ) : (
          <div className="pub-photo__none">Photos coming soon</div>
        )}
      </div>
      <div className="pub-body">
        <div className="pub-price">
          {rent(l.askingRent)}
          <span>/month</span>
        </div>
        <h2 id={`listing-${l.id}`}>{l.title}</h2>
        <p className="pub-meta">{[meta, l.city].filter(Boolean).join(" · ")}</p>
        <p className="pub-avail">{availability(l.availableOn)}</p>
        {l.description && <p className="pub-desc">{l.description}</p>}
        {l.amenities.length > 0 && (
          <ul className="pub-tags" aria-label="Amenities">
            {l.amenities.map((a) => (
              <li key={a}>{a}</li>
            ))}
          </ul>
        )}
        {l.pets && <p className="pub-meta">Pets: {l.pets}</p>}
        {asking ? (
          <InquiryForm listingId={l.id} onCancel={() => setAsking(false)} />
        ) : (
          <button type="button" className="pub-btn" onClick={() => setAsking(true)}>
            Ask about this home
          </button>
        )}
      </div>
    </article>
  );
}

function InquiryForm({ listingId, onCancel }: { listingId: number; onCancel: () => void }) {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [message, setMessage] = useState("");
  // Hidden from people; form-filling bots fill it in and are quietly ignored.
  const [website, setWebsite] = useState("");
  const [state, setState] = useState<"idle" | "sending" | "sent">("idle");
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (!name.trim()) return setError("Please add your name.");
    if (!email.trim() && !phone.trim()) return setError("Please add an email address or a phone number so the office can reach you.");
    if (email.trim() && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email.trim())) return setError("That email address doesn't look right.");
    if (phone.trim() && !/^[0-9+().\-\s]{7,40}$/.test(phone.trim())) return setError("Please enter the phone number with digits, like (201) 555-0100.");
    setState("sending");
    try {
      const res = await fetch(`/api/public/listings/${listingId}/inquire`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: name.trim(), email: email.trim() || null, phone: phone.trim() || null, message: message.trim() || null, website }),
      });
      if (res.ok) return setState("sent");
      setState("idle");
      setError(
        res.status === 404
          ? "This home was just taken off the market."
          : res.status === 429
            ? "Too many messages from here in a short time. Please try again later."
            : "Your message didn't go through. Please check it and try again.",
      );
    } catch {
      setState("idle");
      setError("Your message didn't go through. Please check your connection and try again.");
    }
  }

  if (state === "sent") {
    return (
      <p className="pub-sent" role="status">
        Thanks, {name.trim().split(" ")[0]}. The office has your message and will be in touch.
      </p>
    );
  }
  return (
    <form className="pub-form" onSubmit={submit} noValidate>
      <label>
        <span>Your name</span>
        <input value={name} maxLength={120} autoComplete="name" onChange={(e) => setName(e.target.value)} />
      </label>
      <div className="pub-form__row">
        <label>
          <span>Email</span>
          <input type="email" value={email} maxLength={254} autoComplete="email" onChange={(e) => setEmail(e.target.value)} />
        </label>
        <label>
          <span>Phone</span>
          <input type="tel" value={phone} maxLength={40} autoComplete="tel" onChange={(e) => setPhone(e.target.value)} />
        </label>
      </div>
      <label>
        <span>Message (optional)</span>
        <textarea rows={3} maxLength={2000} value={message} onChange={(e) => setMessage(e.target.value)} placeholder="When can I see it?" />
      </label>
      <label className="pub-hp" aria-hidden="true">
        <span>Website</span>
        <input tabIndex={-1} autoComplete="off" value={website} onChange={(e) => setWebsite(e.target.value)} />
      </label>
      {error && <p className="pub-error" role="alert">{error}</p>}
      <p className="pub-fine">The office uses your details only to answer you about this home.</p>
      <div className="pub-form__actions">
        <button type="button" className="pub-btn pub-btn--ghost" onClick={onCancel}>
          Cancel
        </button>
        <button type="submit" className="pub-btn" disabled={state === "sending"}>
          {state === "sending" ? "Sending…" : "Send"}
        </button>
      </div>
    </form>
  );
}
