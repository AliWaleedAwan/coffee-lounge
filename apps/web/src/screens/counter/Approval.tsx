/** The manager's username and PIN, entered on this device (step-up, RBAC.md §1.4). */
import { Field } from '../../components/Field.tsx';

export interface ApprovalState {
  username: string;
  pin: string;
}

export const noApproval: ApprovalState = { username: '', pin: '' };

export const approvalReady = (a: ApprovalState): boolean =>
  a.username.trim() !== '' && /^\d{4,6}$/.test(a.pin);

export function ApprovalFields({
  legend,
  value,
  onChange,
}: {
  legend: string;
  value: ApprovalState;
  onChange: (value: ApprovalState) => void;
}) {
  return (
    <fieldset className="stack">
      <legend>{legend}</legend>
      <div className="row">
        <Field
          label="Manager username"
          autoComplete="off"
          value={value.username}
          onChange={(e) => {
            onChange({ ...value, username: e.target.value });
          }}
        />
        <Field
          label="Manager PIN"
          type="password"
          inputMode="numeric"
          autoComplete="off"
          value={value.pin}
          onChange={(e) => {
            onChange({ ...value, pin: e.target.value });
          }}
        />
      </div>
    </fieldset>
  );
}
