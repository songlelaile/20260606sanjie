import styles from "./BrandIdentity.module.css";

type BrandIdentityProps = {
  subtitle?: string;
  variant?: "default" | "compact" | "hero" | "mobileLogin";
};

export function BrandIdentity({ subtitle, variant = "default" }: BrandIdentityProps) {
  return (
    <span className={`${styles.identity} ${styles[variant]}`} data-sanjie-brand-identity="true">
      <span className={styles.row}>
        <strong className={styles.primary}>少壮AI自动化</strong>
        <span className={styles.divider} aria-hidden="true" />
        <span className={styles.partner} role="img" aria-label="联合开发：智篆" title="联合开发：智篆" />
      </span>
      {subtitle ? <small className={styles.subtitle}>{subtitle}</small> : null}
    </span>
  );
}
