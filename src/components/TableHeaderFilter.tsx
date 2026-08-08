"use client";

import clsx from "clsx";
import { ArrowDown, ArrowUp, ArrowUpDown, Filter, X } from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";

export type SortDirection = "asc" | "desc";

export function TableHeaderFilter({
  label,
  active,
  children,
  onClear,
  onSort,
  sortDirection,
  align = "left"
}: {
  label: string;
  active?: boolean;
  children?: ReactNode;
  onClear?: () => void;
  onSort?: () => void;
  sortDirection?: SortDirection | null;
  align?: "left" | "right";
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const SortIcon = sortDirection === "asc" ? ArrowUp : sortDirection === "desc" ? ArrowDown : ArrowUpDown;

  useEffect(() => {
    if (!open) return;
    function closeWhenOutside(event: MouseEvent) {
      if (ref.current && !ref.current.contains(event.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", closeWhenOutside);
    return () => document.removeEventListener("mousedown", closeWhenOutside);
  }, [open]);

  return (
    <div className="th-filter" ref={ref}>
      <span className="th-filter-label">{label}</span>
      <span className="th-filter-actions">
        {onSort ? (
          <button
            type="button"
            className={clsx("th-filter-button", "sort", sortDirection && "active")}
            aria-label={`${label}排序`}
            onClick={onSort}
          >
            <SortIcon size={11} />
          </button>
        ) : null}
        {children ? (
          <button
            type="button"
            className={clsx("th-filter-button", active && "active")}
            aria-label={`${label}筛选`}
            aria-expanded={open}
            onClick={() => setOpen((current) => !current)}
          >
            <Filter size={11} />
          </button>
        ) : null}
      </span>
      {open && children ? (
        <div className={clsx("th-filter-popover", align === "right" && "align-right")}>
          <div className="th-filter-popover-head">
            <strong>{label}</strong>
            {onClear ? (
              <button type="button" onClick={onClear} aria-label={`清空${label}筛选`}>
                <X size={12} />
              </button>
            ) : null}
          </div>
          <div className="th-filter-fields">{children}</div>
        </div>
      ) : null}
    </div>
  );
}
