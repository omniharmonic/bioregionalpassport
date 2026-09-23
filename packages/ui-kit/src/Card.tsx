import type { HTMLAttributes, ReactNode } from 'react';
import { cn } from './cn.js';

export interface CardProps extends HTMLAttributes<HTMLDivElement> {
  children?: ReactNode;
}

/** A rounded-2xl surface with a soft border — the base container used across the kit. */
export function Card({ className, children, style, ...rest }: CardProps) {
  return (
    <div
      className={cn('rounded-2xl p-6', className)}
      style={{
        background: 'var(--bp-bg)',
        color: 'var(--bp-fg)',
        border: '1px solid color-mix(in srgb, var(--bp-fg) 12%, transparent)',
        ...style,
      }}
      {...rest}
    >
      {children}
    </div>
  );
}

export interface CardHeaderProps extends HTMLAttributes<HTMLDivElement> {
  children?: ReactNode;
}

export function CardHeader({ className, children, ...rest }: CardHeaderProps) {
  return (
    <div className={cn('mb-4 flex items-start justify-between gap-4', className)} {...rest}>
      {children}
    </div>
  );
}

export interface CardTitleProps extends HTMLAttributes<HTMLHeadingElement> {
  children?: ReactNode;
}

export function CardTitle({ className, children, ...rest }: CardTitleProps) {
  return (
    <h3 data-display className={cn('text-lg font-semibold', className)} {...rest}>
      {children}
    </h3>
  );
}

export interface CardBodyProps extends HTMLAttributes<HTMLDivElement> {
  children?: ReactNode;
}

export function CardBody({ className, children, ...rest }: CardBodyProps) {
  return (
    <div className={cn('text-sm leading-relaxed', className)} {...rest}>
      {children}
    </div>
  );
}
