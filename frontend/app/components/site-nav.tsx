"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import styles from "./site-nav.module.css";

const LINKS = [
  { href: "/", label: "Home" },
  { href: "/agent", label: "Agent" },
  { href: "/files", label: "Files" },
  { href: "/buckets", label: "Buckets" },
  { href: "/settings", label: "Settings" },
];

export default function SiteNav() {
  const pathname = usePathname();
  const isActive = (href: string) =>
    href === "/" ? pathname === "/" : pathname.startsWith(href);

  return (
    <nav className={styles.nav} aria-label="Main">
      <Link className={styles.brand} href="/">
        FMCV <span className={styles.brandShort}>Agentic</span>
      </Link>
      <div className={styles.links}>
        {LINKS.map(({ href, label }) => {
          const active = isActive(href);
          return (
            <Link
              key={href}
              className={active ? `${styles.link} ${styles.active}` : styles.link}
              href={href}
              aria-current={active ? "page" : undefined}
            >
              {label}
            </Link>
          );
        })}
      </div>
    </nav>
  );
}
