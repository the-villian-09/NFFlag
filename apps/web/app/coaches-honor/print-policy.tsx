"use client";

/** Opens every standard, then prints, so the paper copy has all of it. */
export function PrintPolicy() {
  return (
    <button
      type="button"
      className="btn ghost"
      onClick={() => {
        document.querySelectorAll<HTMLDetailsElement>(".honor-list details").forEach((d) => (d.open = true));
        window.print();
      }}
    >
      Print the full policy
    </button>
  );
}
