import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PinPad } from './PinPad.tsx';

afterEach(cleanup);

const press = (name: string) => {
  fireEvent.click(screen.getByRole('button', { name }));
};
const entered = () => screen.getByRole('status').getAttribute('aria-label');

describe('PIN pad', () => {
  it('enters digits by tapping, deletes, and submits only from the minimum length', () => {
    const onSubmit = vi.fn();
    render(<PinPad label="PIN for Sara" onSubmit={onSubmit} />);
    expect(screen.getByRole('button', { name: 'Enter' })).toHaveProperty('disabled', true);
    for (const d of ['2', '5', '8']) press(d);
    expect(entered()).toBe('3 of up to 6 digits entered');
    press('Enter'); // still disabled
    expect(onSubmit).not.toHaveBeenCalled();
    press('0');
    press('Delete last digit');
    press('0');
    press('Enter');
    expect(onSubmit).toHaveBeenCalledWith('2580');
  });

  it('accepts the keyboard on the counter PC and stops at the maximum length', () => {
    const onSubmit = vi.fn();
    render(<PinPad label="PIN" onSubmit={onSubmit} maxLength={6} />);
    const group = screen.getByRole('group', { name: 'PIN' });
    for (const key of ['1', '3', '5', '7', '9', '2', '4', 'a']) fireEvent.keyDown(group, { key });
    expect(entered()).toBe('6 of up to 6 digits entered');
    fireEvent.keyDown(group, { key: 'Backspace' });
    fireEvent.keyDown(group, { key: 'Enter' });
    expect(onSubmit).toHaveBeenCalledWith('13579');
  });

  it('clears the digits when told to (after a wrong PIN), and is inert when disabled', () => {
    const onSubmit = vi.fn();
    const { rerender } = render(<PinPad label="PIN" onSubmit={onSubmit} resetKey={0} />);
    for (const d of ['1', '2', '3', '4']) press(d);
    rerender(<PinPad label="PIN" onSubmit={onSubmit} resetKey={1} />);
    expect(entered()).toBe('0 of up to 6 digits entered');
    rerender(<PinPad label="PIN" onSubmit={onSubmit} resetKey={1} disabled />);
    fireEvent.keyDown(screen.getByRole('group'), { key: '1' });
    expect(entered()).toBe('0 of up to 6 digits entered');
  });
});
