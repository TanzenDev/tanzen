/**
 * Paginator — prev/next controls with "X–Y of Z" summary.
 * Usage:
 *   const { page, setPage, paged, pageCount } = usePagination(filteredItems, PAGE_SIZE);
 *   <Paginator page={page} pageCount={pageCount} total={filteredItems.length} pageSize={PAGE_SIZE} onChange={setPage} />
 */

export const PAGE_SIZE = 20;

export interface PaginatorProps {
  page: number;
  pageCount: number;
  total: number;
  pageSize: number;
  onChange: (page: number) => void;
}

export function Paginator({ page, pageCount, total, pageSize, onChange }: PaginatorProps) {
  if (pageCount <= 1) return null;
  const from = page * pageSize + 1;
  const to = Math.min((page + 1) * pageSize, total);
  return (
    <div className="flex items-center justify-between px-1 pt-2 text-xs text-slate-400">
      <span>{from}–{to} of {total}</span>
      <div className="flex gap-1">
        <button
          onClick={() => onChange(page - 1)}
          disabled={page === 0}
          className="rounded bg-slate-700 px-2.5 py-1 font-medium text-white hover:bg-slate-600 disabled:opacity-40"
        >
          ← Prev
        </button>
        <span className="px-2 py-1">
          {page + 1} / {pageCount}
        </span>
        <button
          onClick={() => onChange(page + 1)}
          disabled={page >= pageCount - 1}
          className="rounded bg-slate-700 px-2.5 py-1 font-medium text-white hover:bg-slate-600 disabled:opacity-40"
        >
          Next →
        </button>
      </div>
    </div>
  );
}
