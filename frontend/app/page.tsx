import Link from "next/link";
import styles from "./page.module.css";

export default function Home() {
  return (
    <div className={styles.page}>
      <main className={styles.main}>
        <h1 className={styles.title}>FMCV Agentic</h1>
        <p className={styles.subtitle}>
          Manage your OpenAI-compatible model connections from one place.
        </p>
        <div className={styles.ctas}>
          <Link className={styles.primary} href="/agent">
            Open Agent
          </Link>
          <Link className={styles.primary} href="/settings">
            Open Settings
          </Link>
        </div>
      </main>
    </div>
  );
}
