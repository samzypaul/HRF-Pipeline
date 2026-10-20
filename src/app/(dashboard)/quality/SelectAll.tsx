"use client";

/** Ticks or clears every row checkbox that belongs to the bulk form. */
export default function SelectAll() {
  return (
    <input
      type="checkbox"
      aria-label="Select all rows on this page"
      onChange={(e) => {
        for (const box of document.querySelectorAll<HTMLInputElement>('input[name="codes"][form="bulk"]')) box.checked = e.currentTarget.checked;
      }}
    />
  );
}
