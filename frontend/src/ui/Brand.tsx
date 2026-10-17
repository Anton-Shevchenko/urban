import { Link } from 'react-router-dom';

type MarkProps = {
  size?: number;
};

export function BrandMark({ size = 22 }: MarkProps) {
  return (
    <svg className="brand-mark" width={size} height={size} viewBox="0 0 32 32" aria-hidden>
      <path
        className="brand-mark-outer"
        d="M16 2.6 28.4 9.7v12.6L16 29.4 3.6 22.3V9.7Z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinejoin="round"
      />
      <path
        className="brand-mark-inner"
        d="M16 9.2 22.1 12.7v7.1L16 23.3 9.9 19.8v-7.1Z"
        fill="currentColor"
      />
    </svg>
  );
}

type BrandProps = {
  className?: string;
};

export function Brand({ className }: BrandProps) {
  return (
    <Link to="/" className={className ? `brand ${className}` : 'brand'}>
      <BrandMark />
      <span className="brand-word">Wohnindex</span>
    </Link>
  );
}
