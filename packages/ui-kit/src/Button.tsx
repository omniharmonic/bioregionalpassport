import type { AnchorHTMLAttributes, ButtonHTMLAttributes, CSSProperties, ReactNode } from 'react';
import { cn } from './cn.js';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';
export type ButtonSize = 'sm' | 'md' | 'lg';

const SIZE_CLASSES: Record<ButtonSize, string> = {
  sm: 'px-3 py-1.5 text-sm',
  md: 'px-4 py-2 text-base',
  lg: 'px-6 py-3 text-lg',
};

const BASE_CLASSES =
  'inline-flex items-center justify-center gap-2 rounded-2xl font-medium transition-colors duration-150 ' +
  'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 ' +
  'disabled:cursor-not-allowed disabled:opacity-50';

function variantStyle(variant: ButtonVariant): CSSProperties {
  switch (variant) {
    case 'primary':
      return { background: 'var(--bp-primary)', color: '#fff', border: '1px solid var(--bp-primary)' };
    case 'secondary':
      return { background: 'var(--bp-bg)', color: 'var(--bp-fg)', border: '1px solid var(--bp-fg)' };
    case 'ghost':
      return { background: 'transparent', color: 'var(--bp-fg)', border: '1px solid transparent' };
    case 'danger':
      return { background: '#b3261e', color: '#fff', border: '1px solid #b3261e' };
    default:
      return {};
  }
}

interface CommonProps {
  variant?: ButtonVariant;
  size?: ButtonSize;
  className?: string;
  children?: ReactNode;
}

export type ButtonProps = CommonProps &
  (
    | ({ href: string } & Omit<AnchorHTMLAttributes<HTMLAnchorElement>, 'className' | 'color'>)
    | ({ href?: undefined } & Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'className' | 'color'>)
  );

/** Themeable button. Renders `<a>` when `href` is given, `<button>` otherwise. */
export function Button(props: ButtonProps) {
  const { variant = 'primary', size = 'md', className, children, ...rest } = props;
  const classes = cn(BASE_CLASSES, SIZE_CLASSES[size], className);
  const style = variantStyle(variant);

  if ('href' in rest && rest.href !== undefined) {
    const { href, ...anchorRest } = rest as { href: string } & AnchorHTMLAttributes<HTMLAnchorElement>;
    return (
      <a href={href} className={classes} style={style} {...anchorRest}>
        {children}
      </a>
    );
  }

  const buttonRest = rest as ButtonHTMLAttributes<HTMLButtonElement>;
  return (
    <button className={classes} style={style} {...buttonRest}>
      {children}
    </button>
  );
}
