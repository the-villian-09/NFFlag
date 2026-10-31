"use client";

import { useEffect, useRef, type ReactNode } from "react";

/**
 * Accessible pop-up built on the native <dialog>: traps focus, closes on Escape,
 * the Close button, or a click on the backdrop.
 */
export function Modal({ open, title, onClose, children }: { open: boolean; title: string; onClose: () => void; children: ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);
  return (
    <dialog
      ref={ref}
      className="modal"
      aria-label={title}
      onClose={onClose}
      onClick={(e) => {
        if (e.target === ref.current) onClose();
      }}
    >
      <div className="modal-body">
        <div className="modal-head">
          <h2>{title}</h2>
          <button className="btn ghost small" onClick={onClose} autoFocus>
            Close
          </button>
        </div>
        {children}
      </div>
    </dialog>
  );
}
