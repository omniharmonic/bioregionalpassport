import {
  forwardRef,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
} from 'react';
import { cn } from './cn.js';

export interface FieldProps {
  label: string;
  hint?: string;
  error?: string;
  children: ReactNode;
  className?: string;
  htmlFor?: string;
}

/** Wraps a form control with a label, optional hint, and optional error text. */
export function Field({ label, hint, error, children, className, htmlFor }: FieldProps) {
  return (
    <div className={cn('flex flex-col gap-1.5', className)}>
      <label htmlFor={htmlFor} className="text-sm font-medium">
        {label}
      </label>
      {children}
      {error ? (
        <p className="text-xs" style={{ color: '#b3261e' }}>
          {error}
        </p>
      ) : hint ? (
        <p className="text-xs opacity-60">{hint}</p>
      ) : null}
    </div>
  );
}

const CONTROL_CLASSES =
  'w-full rounded-2xl px-3 py-2 text-sm outline-none transition-colors ' +
  'focus:ring-2 disabled:cursor-not-allowed disabled:opacity-50';

const CONTROL_STYLE = {
  background: 'var(--bp-bg)',
  color: 'var(--bp-fg)',
  border: '1px solid color-mix(in srgb, var(--bp-fg) 20%, transparent)',
} as const;

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(function Input(
  { className, style, ...rest },
  ref,
) {
  return (
    <input
      ref={ref}
      className={cn(CONTROL_CLASSES, className)}
      style={{ ...CONTROL_STYLE, ...style }}
      {...rest}
    />
  );
});

export const Select = forwardRef<HTMLSelectElement, SelectHTMLAttributes<HTMLSelectElement>>(function Select(
  { className, style, children, ...rest },
  ref,
) {
  return (
    <select
      ref={ref}
      className={cn(CONTROL_CLASSES, className)}
      style={{ ...CONTROL_STYLE, ...style }}
      {...rest}
    >
      {children}
    </select>
  );
});

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(
  function Textarea({ className, style, ...rest }, ref) {
    return (
      <textarea
        ref={ref}
        className={cn(CONTROL_CLASSES, 'min-h-24', className)}
        style={{ ...CONTROL_STYLE, ...style }}
        {...rest}
      />
    );
  },
);
