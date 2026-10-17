"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

/**
 * Two navigations, because one does not fit both contexts.
 *
 * On a phone the five links do not fit across the top (they overflowed the
 * document, which left a gutter beside every scroll), and the top of the screen
 * is the worst place for a thumb. So phones get a bottom tab bar with icon and
 * label, and the top bar keeps just the brand. From `sm` up it is the original
 * top nav.
 */
const LINKS = [
  { href: "/", label: "Discover", icon: "M12 3.5a8.5 8.5 0 1 0 0 17 8.5 8.5 0 0 0 0-17Zm3 5.5-1.8 4.2L9 15l1.8-4.2L15 9Z" },
  { href: "/library", label: "Library", icon: "M4 4.75A1.75 1.75 0 0 1 5.75 3h2.5A1.75 1.75 0 0 1 10 4.75v14.5A1.75 1.75 0 0 1 8.25 21h-2.5A1.75 1.75 0 0 1 4 19.25V4.75Zm10 0A1.75 1.75 0 0 1 15.75 3h2.5A1.75 1.75 0 0 1 20 4.75v14.5A1.75 1.75 0 0 1 18.25 21h-2.5A1.75 1.75 0 0 1 14 19.25V4.75Z" },
  { href: "/requests", label: "Requests", icon: "M12 3.5v10m0 0 3.75-3.75M12 13.5 8.25 9.75M4.5 17.5v1.25A1.75 1.75 0 0 0 6.25 20.5h11.5a1.75 1.75 0 0 0 1.75-1.75V17.5" },
  { href: "/status", label: "Status", icon: "M3.5 12.5h3.2l2.3-5.5 3.4 10 2.3-6.2h5.8" },
  { href: "/settings", label: "Settings", icon: "M4 8h5.2m3.6 0H20M4 16h8.2m3.6 0H20M11 5.5a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5Zm5 8a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5Z" },
];

function isActive(pathname: string, href: string): boolean {
  return href === "/" ? pathname === "/" : pathname.startsWith(href);
}

function Icon({ path, className = "" }: { path: string; className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      aria-hidden
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
    >
      <path d={path} />
    </svg>
  );
}

export default function Nav() {
  const pathname = usePathname();

  return (
    <>
      <header className="sticky top-0 z-20 border-b border-white/5 bg-ink-950/80 backdrop-blur">
        <div className="mx-auto flex max-w-6xl items-center justify-between gap-4 px-4 py-2.5 sm:px-5 sm:py-3">
          <Link href="/" className="flex min-w-0 items-center gap-2 font-semibold tracking-tight">
            <span className="grid h-8 w-8 shrink-0 place-items-center rounded-md bg-accent/20 text-accent-soft ring-1 ring-accent/40">
              ♫
            </span>
            <span className="truncate">
              music<span className="text-accent-soft">seer</span>
            </span>
          </Link>

          <nav className="hidden items-center gap-1 text-sm sm:flex">
            {LINKS.map((l) => (
              <Link
                key={l.href}
                href={l.href}
                aria-current={isActive(pathname, l.href) ? "page" : undefined}
                className={`rounded-md px-3 py-2 transition ${
                  isActive(pathname, l.href)
                    ? "bg-white/10 text-white"
                    : "text-white/55 hover:bg-white/5 hover:text-white/90"
                }`}
              >
                {l.label}
              </Link>
            ))}
          </nav>
        </div>
      </header>

      {/* Phones only. 56px tall targets, thumb-reachable, above the home bar. */}
      <nav
        aria-label="Main"
        className="pb-safe fixed inset-x-0 bottom-0 z-30 border-t border-white/5 bg-ink-950/95 backdrop-blur sm:hidden"
      >
        <ul className="mx-auto flex max-w-md items-stretch">
          {LINKS.map((l) => {
            const active = isActive(pathname, l.href);
            return (
              <li key={l.href} className="flex-1">
                <Link
                  href={l.href}
                  aria-current={active ? "page" : undefined}
                  className={`flex min-h-14 flex-col items-center justify-center gap-1 px-1 pt-2 text-[11px] leading-none transition ${
                    active ? "text-accent-soft" : "text-white/50"
                  }`}
                >
                  <Icon path={l.icon} className="h-5 w-5" />
                  <span>{l.label}</span>
                </Link>
              </li>
            );
          })}
        </ul>
      </nav>
    </>
  );
}
