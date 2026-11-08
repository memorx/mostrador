"use client";

import { useEffect, useRef, useState } from "react";
import { collapseCartCards } from "@/lib/feed";
import type { Snapshot } from "@/lib/runtime";

type Feed = Snapshot["feed"][number];

const money = (cents: number, currency: string) =>
  new Intl.NumberFormat("es-MX", { style: "currency", currency, currencyDisplay: "symbol" }).format(cents / 100) + ` ${currency}`;

const SUGGESTIONS = ["Hola, ¿qué tienen hoy?", "Two lattes and a concha for pickup, I'm Ana", "Quiero chocolate de metate a domicilio", "What's sold out?"];

async function openSession(): Promise<Snapshot> {
  const id = readSession();
  if (id) {
    const r = await fetch(`/api/session?id=${encodeURIComponent(id)}`);
    if (r.ok) return r.json();
  }
  const r = await fetch("/api/session", { method: "POST" });
  const s: Snapshot = await r.json();
  try { sessionStorage.setItem("mostrador-session", s.id); } catch {}
  return s;
}

function readSession(): string | null {
  try {
    return new URLSearchParams(window.location.search).get("s") ?? sessionStorage.getItem("mostrador-session");
  } catch {
    return null;
  }
}

export default function Chat() {
  const [snap, setSnap] = useState<Snapshot | null>(null);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Back from PayPal without a session: the server restarted (sessions live in memory) and nothing was captured.
  // Only read on the client; the first render shows "Opening the shop…" either way, so hydration matches.
  const [lostCheckout] = useState(() => {
    if (typeof window === "undefined") return false;
    const q = new URLSearchParams(window.location.search);
    return q.get("payment") === "error" && !q.get("s");
  });
  const feedRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let alive = true;
    void openSession().then((s) => { if (alive) setSnap(s); });
    return () => { alive = false; };
  }, []);
  useEffect(() => { feedRef.current?.scrollTo({ top: feedRef.current.scrollHeight, behavior: "smooth" }); }, [snap?.feed.length, busy]);

  async function send(msg: string) {
    if (!snap || !msg.trim() || busy) return;
    setBusy(true); setError(null); setText("");
    const optimistic = { ...snap, feed: [...snap.feed, { id: "tmp", at: 0, kind: "customer", text: msg } as Feed] };
    setSnap(optimistic);
    const r = await fetch("/api/chat", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ sessionId: snap.id, text: msg }) });
    setBusy(false);
    if (r.ok) setSnap(await r.json());
    else { setSnap(snap); setError((await r.json().catch(() => ({}))).error ?? "Something went wrong"); }
  }

  async function confirm(quoteId: string, action: "confirm" | "cancel") {
    if (!snap) return;
    setBusy(true); setError(null);
    const r = await fetch("/api/confirm", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ sessionId: snap.id, quoteId, action }) });
    const body = await r.json();
    setBusy(false);
    if (body.session) setSnap(body.session);
    if (body.ok && body.approveUrl) window.location.href = body.approveUrl;
    else if (!body.ok && body.reason) setError(body.reason);
  }

  if (!snap) return <main className="app"><div className="chat"><p className="typing" style={{ padding: 18 }}>Opening the shop…</p></div></main>;

  const cur = snap.shop.currency;
  const quote = (id: string) => snap.quotes.find((q) => q.id === id);
  const payment = (id: string) => snap.payments.find((p) => p.orderId === id);

  return (
    <main className="app">
      <section className="chat" aria-label="Chat with the shop">
        <header className="chat-head">
          <div>
            <h1>{snap.shop.name}</h1>
            <span className="tag">{snap.shop.disclaimer} · {snap.shop.city}</span>
          </div>
          <span className="tag">AI assistant · pay with PayPal</span>
        </header>

        <div className="feed" ref={feedRef} aria-live="polite">
          {lostCheckout && <p className="notice warn">That PayPal checkout couldn&apos;t be completed and nothing was charged: the demo server restarted while you were in PayPal. Please place the order again.</p>}
          {snap.feed.length === 0 && <p className="note">Order like you would on WhatsApp: tell the assistant what you want. It builds the order, the shop computes the prices, and you pay with PayPal right here.</p>}
          {collapseCartCards(snap.feed).map((f) => <FeedItemView key={f.id} f={f} cur={cur} quote={quote} payment={payment} orderNumber={snap.orderNumber} busy={busy} onConfirm={confirm} stage={snap.stage} />)}
          {busy && <p className="typing">The assistant is typing…</p>}
          {error && <p className="notice warn">{error}</p>}
        </div>

        {snap.feed.length === 0 && (
          <div className="chips">{SUGGESTIONS.map((s) => <button key={s} onClick={() => send(s)}>{s}</button>)}</div>
        )}
        <form className="composer" onSubmit={(e) => { e.preventDefault(); void send(text); }}>
          <input value={text} onChange={(e) => setText(e.target.value)} placeholder="Escribe tu pedido… / Type your order…" aria-label="Message" maxLength={1000} />
          <button className="btn primary" disabled={busy || !text.trim()}>Send</button>
        </form>
      </section>

      <aside className="hood" aria-label="Under the hood">
        <div className="hood-head">
          <h2>Under the hood</h2>
          <span className="tag">stage: {snap.stage} · Claude calls: {snap.claudeCalls}</span>
        </div>
        <ol className="trace">
          {snap.trace.length === 0 && <li>Tool calls, guards and PayPal events appear here.</li>}
          {[...snap.trace].reverse().map((t) => (
            <li key={t.id} className={t.ok ? "" : "bad"}><span className="k">{t.kind}</span>{t.name} — {t.summary}</li>
          ))}
        </ol>
      </aside>
    </main>
  );
}

function FeedItemView({ f, cur, quote, payment, orderNumber, busy, onConfirm, stage }: {
  f: Feed; cur: string; busy: boolean; stage: string; orderNumber: string | null;
  quote: (id: string) => Snapshot["quotes"][number] | undefined;
  payment: (id: string) => Snapshot["payments"][number] | undefined;
  onConfirm: (quoteId: string, action: "confirm" | "cancel") => void;
}) {
  switch (f.kind) {
    case "customer": return <div className="msg me">{f.text}</div>;
    case "agent": return <div className="msg bot">{plain(f.text)}</div>;
    case "notice": return <p className={`notice ${f.tone === "warn" ? "warn" : ""}`}>{f.text}</p>;
    case "cart": {
      const p = f.priced;
      if (p.lines.length === 0) return <p className="notice">Cart is empty</p>;
      return (
        <div className="card">
          <h3>Cart</h3>
          {p.lines.map((l) => <div className="row" key={l.lineId}><span>{l.quantity} × {l.name}{l.notes ? <span className="note"> · {l.notes}</span> : null}</span><span>{money(l.lineCents, cur)}</span></div>)}
          {p.deliveryCents > 0 && <div className="row"><span>Delivery</span><span>{money(p.deliveryCents, cur)}</span></div>}
          <div className="row total"><span>Total</span><span>{money(p.totalCents, cur)}</span></div>
        </div>
      );
    }
    case "quote": {
      const q = quote(f.quoteId);
      if (!q) return null;
      const live = q.status === "open" && stage === "awaiting_confirmation";
      return (
        <div className="card">
          <h3>Order summary {q.status !== "open" && <span className="note">({q.status})</span>}</h3>
          {q.priced.lines.map((l) => <div className="row" key={l.lineId}><span>{l.quantity} × {l.name}</span><span>{money(l.lineCents, cur)}</span></div>)}
          {q.priced.deliveryCents > 0 && <div className="row"><span>Delivery</span><span>{money(q.priced.deliveryCents, cur)}</span></div>}
          <div className="row total"><span>Total</span><span>{money(q.priced.totalCents, cur)}</span></div>
          <p className="note">{q.details.customerName} · {q.details.fulfillment === "delivery" ? `Delivery to ${q.details.deliveryAddress}` : "Pickup"}</p>
          {live && (
            <div className="actions">
              <button className="btn paypal" disabled={busy} onClick={() => onConfirm(q.id, "confirm")}>Confirm &amp; pay with PayPal</button>
              <button className="btn" disabled={busy} onClick={() => onConfirm(q.id, "cancel")}>Change order</button>
            </div>
          )}
        </div>
      );
    }
    case "pay": {
      const p = payment(f.orderId);
      if (!p) return null;
      return (
        <div className="card">
          <h3>PayPal payment · {p.status}</h3>
          <div className="row total"><span>Amount</span><span>{money(p.amountCents, p.currency)}</span></div>
          {p.status === "created" && <div className="actions"><a className="btn paypal" href={p.approveUrl}>Open PayPal to approve</a></div>}
          <p className="note">{p.provider === "simulated" ? "Payment simulator (no PayPal credentials set)" : "PayPal sandbox"} · order {p.orderId}</p>
        </div>
      );
    }
    case "receipt": {
      const p = payment(f.orderId);
      return (
        <div className="card receipt">
          <h3>Paid ✓ Order {orderNumber}</h3>
          {p && <div className="row"><span>Captured with PayPal</span><span>{money(p.amountCents, p.currency)}</span></div>}
          {p?.captureId && <p className="note">Capture {p.captureId}</p>}
        </div>
      );
    }
  }
}

// The prompt asks for plain text; strip any Markdown bold the model still sends.
function plain(text: string): string {
  return text.replace(/\*\*(.+?)\*\*/g, "$1");
}
