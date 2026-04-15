import { render, screen } from '@testing-library/react';
import { describe, it, expect } from 'vitest';

describe('display value', () => {
  it('finds number input by display value', () => {
    render(<input type="number" value="10" onChange={() => {}} />);
    expect(screen.getByDisplayValue('10')).toBeInTheDocument();
  });
});
