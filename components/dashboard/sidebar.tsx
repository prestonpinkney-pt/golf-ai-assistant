import Link from "next/link";

const navItems = [
  { label: "Dashboard", href: "/dashboard" },
  { label: "Opportunities", href: "/opportunities" },
  { label: "Outbound", href: "/outbound" },
  { label: "Messages", href: "/messages" },
  { label: "Settings", href: "/settings" },
];

export function Sidebar() {
  return (
    <aside className="hidden min-h-screen w-64 shrink-0 border-r border-slate-200 bg-white lg:block">
      <div className="flex h-full flex-col">
        <div className="border-b border-slate-200 px-6 py-5">
          <div className="text-lg font-bold tracking-tight text-slate-950">
            CloseOS
          </div>
          <div className="mt-1 text-xs font-medium text-slate-500">
            Revenue Operating System
          </div>
        </div>

        <nav className="flex-1 space-y-1 px-3 py-4">
          {navItems.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              className="block rounded-xl px-3 py-2.5 text-sm font-medium text-slate-600 transition hover:bg-slate-100 hover:text-slate-950"
            >
              {item.label}
            </Link>
          ))}
        </nav>

        <div className="border-t border-slate-200 px-6 py-4">
          <div className="text-xs font-semibold uppercase tracking-[0.16em] text-slate-400">
            Workspace
          </div>
          <div className="mt-1 text-sm font-semibold text-slate-800">
            Primetime Golf
          </div>
        </div>
      </div>
    </aside>
  );
}