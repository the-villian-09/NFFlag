"use client";

/**
 * Uploading required documents and headshots. Photos are shrunk in the
 * browser before upload (phone photos are often 5–10 MB), and the server
 * re-saves them without hidden data such as GPS location.
 */
import { useCallback, useEffect, useId, useState } from "react";
import { ApiError } from "@/lib/api";

export interface DocView {
  id: string;
  contentType: string;
  uploadedAt: string;
  url: string;
}
interface PlayerDocItem {
  kind: "birth_certificate" | "insurance_card" | "player_photo";
  label: string;
  perSeason: boolean;
  /** Accepted by the league: only an admin can change it now. */
  locked?: boolean;
  document: DocView | null;
}

const HINT: Record<string, string> = {
  birth_certificate: "A photo or PDF of the birth certificate. Kept on file for future seasons.",
  insurance_card: "A photo or PDF of the front of the card. Needed each season.",
  player_photo: "A clear photo of your child's face, like a school photo. Used by coaches for game-day check-in.",
  staff_photo: "A clear photo of your face, like an ID photo. Needed each season.",
};
const MAX_BYTES = 4 * 1024 * 1024;

/** Shrinks a photo to fit within `max` pixels and returns a JPEG (the original if it can't be read here). */
export async function shrink(file: File, max: number): Promise<Blob> {
  try {
    const bmp = await createImageBitmap(file, { imageOrientation: "from-image" });
    const scale = Math.min(1, max / Math.max(bmp.width, bmp.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(bmp.width * scale);
    canvas.height = Math.round(bmp.height * scale);
    canvas.getContext("2d")!.drawImage(bmp, 0, 0, canvas.width, canvas.height);
    bmp.close();
    return await new Promise<Blob>((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("encode"))), "image/jpeg", 0.85));
  } catch {
    return file;
  }
}

async function upload(path: string, body: Blob): Promise<DocView> {
  const res = await fetch(`/api/v1${path}`, {
    method: "PUT",
    credentials: "include",
    headers: { "content-type": body.type || "application/octet-stream" },
    body,
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : {};
  if (!res.ok) {
    const err = data.error ?? {};
    throw new ApiError(res.status, err.code ?? "ERROR", res.status === 413 ? "That file is too large. The limit is 4 MB." : (err.message ?? "The upload didn't work. Please try again."), err);
  }
  return data.document as DocView;
}

/** One file to upload, with what's on file now. */
export function DocUpload({
  kind,
  label,
  current,
  path,
  photoOnly,
  locked,
  onUploaded,
}: {
  kind: string;
  label: string;
  current: DocView | null;
  path: string;
  photoOnly: boolean;
  locked?: boolean;
  onUploaded: (d: DocView) => void;
}) {
  const id = useId();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function pick(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    setError(null);
    const isPdf = file.type === "application/pdf" || /\.pdf$/i.test(file.name);
    if (isPdf && photoOnly) return setError("This needs to be a photo (JPG or PNG), not a PDF.");
    setBusy(true);
    try {
      const body = isPdf ? file : await shrink(file, photoOnly ? 1600 : 2400);
      if (body.size > MAX_BYTES) throw new Error("That file is too large. The limit is 4 MB; try a photo instead of a scan.");
      onUploaded(await upload(path, body));
    } catch (err) {
      setError(err instanceof Error ? err.message : "The upload didn't work. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  const isPhoto = current && current.contentType.startsWith("image/");
  return (
    <div className={`doc-upload${current ? " done" : ""}`}>
      <div className="doc-thumb" aria-hidden="true">
        {current ? isPhoto ? <img src={current.url} alt="" /> : <span>PDF</span> : <span>+</span>}
      </div>
      <div className="doc-body">
        <strong>
          {label} {current && <span className="status ok">{locked ? "Accepted" : "Uploaded"}</span>}
        </strong>
        <span className="hint">{HINT[kind]}</span>
        {error && (
          <span className="doc-error" role="alert">
            {error}
          </span>
        )}
        {locked && <span className="hint">The league has accepted this registration. To change this file, contact the league.</span>}
        <span className="doc-actions">
          {!locked && (
            <>
          <input
            id={id}
            type="file"
            className="sr-only"
            accept={photoOnly ? "image/jpeg,image/png,image/webp,image/heic,image/heif" : "image/jpeg,image/png,image/webp,image/heic,image/heif,application/pdf"}
            disabled={busy}
            onChange={pick}
          />
          <label htmlFor={id} className={`btn small${current ? " ghost" : ""}`} aria-disabled={busy}>
            {busy ? "Uploading…" : current ? "Replace" : photoOnly ? "Add photo" : "Add photo or PDF"}
          </label>
            </>
          )}
          {current && (
            <a href={current.url} target="_blank" rel="noreferrer" className="link-small">
              View
            </a>
          )}
        </span>
      </div>
    </div>
  );
}

/** A child's three required files. `onChange(complete)` reports whether all are in. */
export function PlayerDocuments({ playerId, onChange, onlyWhenRequired }: { playerId: string; onChange?: (complete: boolean) => void; onlyWhenRequired?: boolean }) {
  const [items, setItems] = useState<PlayerDocItem[] | null>(null);
  const [required, setRequired] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    fetch(`/api/v1/players/${playerId}/documents`, { credentials: "include" })
      .then(async (r) => {
        if (!r.ok) throw new Error("Couldn't load this child's documents.");
        return r.json();
      })
      .then((d: { items: PlayerDocItem[]; required: boolean }) => {
        setItems(d.items);
        setRequired(d.required);
      })
      .catch((err: Error) => setError(err.message));
  }, [playerId]);
  useEffect(load, [load]);
  useEffect(() => {
    if (items) onChange?.(items.every((i) => i.document));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items]);

  if (error) return <div className="alert error">{error}</div>;
  if (!items) return <p className="muted">Loading…</p>;
  if (onlyWhenRequired && !required) return null;
  return (
    <div className="doc-list">
      {items.map((i) => (
        <DocUpload
          key={i.kind}
          kind={i.kind}
          label={i.label}
          current={i.document}
          path={`/players/${playerId}/documents/${i.kind}`}
          photoOnly={i.kind === "player_photo"}
          locked={i.locked}
          onUploaded={(d) => setItems((list) => list?.map((x) => (x.kind === i.kind ? { ...x, document: d } : x)) ?? null)}
        />
      ))}
    </div>
  );
}

/** The signed-in person's headshot (coaches, team moms, referees). */
export function MyPhoto({ onChange }: { onChange?: (state: { required: boolean; done: boolean }) => void }) {
  const [state, setState] = useState<{ required: boolean; document: DocView | null } | null>(null);
  useEffect(() => {
    fetch("/api/v1/me/photo", { credentials: "include" })
      .then((r) => (r.ok ? r.json() : { required: false, document: null }))
      .then(setState)
      .catch(() => setState({ required: false, document: null }));
  }, []);
  useEffect(() => {
    if (state) onChange?.({ required: state.required, done: !!state.document });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state]);
  if (!state || !state.required) return null;
  return (
    <DocUpload
      kind="staff_photo"
      label="Your headshot"
      current={state.document}
      path="/me/photo"
      photoOnly
      onUploaded={(d) => setState({ required: true, document: d })}
    />
  );
}

/** Admins: replace a file (e.g. after the family is locked out). Reports the new file. */
export function AdminReplace({ path, photoOnly, label, onUploaded }: { path: string; photoOnly: boolean; label: string; onUploaded: (d: DocView) => void }) {
  const id = useId();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function pick(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    setError(null);
    const isPdf = file.type === "application/pdf" || /\.pdf$/i.test(file.name);
    if (isPdf && photoOnly) return setError("This needs to be a photo, not a PDF.");
    setBusy(true);
    try {
      onUploaded(await upload(path, isPdf ? file : await shrink(file, photoOnly ? 1600 : 2400)));
    } catch (err) {
      setError(err instanceof Error ? err.message : "The upload didn't work.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <span className="doc-actions">
      <input id={id} type="file" className="sr-only" accept={photoOnly ? "image/*" : "image/*,application/pdf"} disabled={busy} onChange={pick} />
      <label htmlFor={id} className="link-btn" aria-disabled={busy} aria-label={`Replace ${label}`}>
        {busy ? "Uploading…" : "Replace"}
      </label>
      {error && <span className="doc-error">{error}</span>}
    </span>
  );
}
