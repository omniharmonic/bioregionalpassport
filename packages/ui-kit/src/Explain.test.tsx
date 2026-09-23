import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Explain } from './Explain.js';

describe('Explain', () => {
  it('renders its one-sentence gate explanation', () => {
    render(<Explain>You need to be a Trusted neighbor (T2) to propose a project.</Explain>);
    expect(
      screen.getByText('You need to be a Trusted neighbor (T2) to propose a project.'),
    ).toBeInTheDocument();
  });
});
