import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Button } from './Button.js';

describe('Button', () => {
  it('renders a <button> when no href is given', () => {
    render(<Button>Click me</Button>);
    const el = screen.getByText('Click me');
    expect(el.tagName).toBe('BUTTON');
  });

  it('renders an <a> when href is given', () => {
    render(<Button href="/wallet/join/boulder">Join</Button>);
    const el = screen.getByText('Join');
    expect(el.tagName).toBe('A');
    expect(el).toHaveAttribute('href', '/wallet/join/boulder');
  });
});
