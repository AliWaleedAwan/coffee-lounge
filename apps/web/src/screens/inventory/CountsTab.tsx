/**
 * Stock counts (RECIPE_INVENTORY.md §9, D-18, P4-5; AT-108). Start a count of everything
 * or one category; count each item (each lot for lot-tracked items) without seeing the
 * book quantity when blind; submit. Within the thresholds it posts at once; otherwise
 * someone other than the submitter with `inventory.count_approve` approves or sends lines
 * back, here or by PIN on this device. Counting during service is fine: each line's
 * variance is posted as a delta (P4-5).
 */
import { Decimal, unitsFor, type UnitCode } from '@cl/shared';
import { useState, type SubmitEvent } from 'react';
import { CheckField, Field, SelectField } from '../../components/Field.tsx';
import { Loading } from '../../components/Loading.tsx';
import { useWritesAllowed } from '../../connection/ConnectionBanner.tsx';
import { writeMessage } from '../menu/menu-api.ts';
import {
  ApprovalFields,
  approvalReady,
  noApproval,
  type ApprovalState,
} from '../counter/Approval.tsx';
import { approve } from '../counter/useCommand.ts';
import {
  formatQty,
  rupees,
  useCount,
  useCounts,
  useInventoryCommand,
  useInventoryWrite,
  useItems,
  type CountDetail,
  type CountItem,
  type CountLine,
  type CountStatus,
} from './inventory-api.ts';

const STATUS: Record<CountStatus, { label: string; chip: string }> = {
  draft: { label: 'Counting', chip: 'chip-info' },
  submitted: { label: 'Waiting for approval', chip: 'chip-warning' },
  posted: { label: 'Posted', chip: 'chip-ok' },
  cancelled: { label: 'Cancelled', chip: '' },
};

export function CountsTab({ canCount, canApprove }: { canCount: boolean; canApprove: boolean }) {
  const counts = useCounts();
  const [open, setOpen] = useState<string | null>(null);
  if (open) {
    return (
      <CountView
        id={open}
        canCount={canCount}
        canApprove={canApprove}
        onClose={() => {
          setOpen(null);
        }}
      />
    );
  }
  const list = counts.data?.items ?? [];
  const current = list.find((c) => c.status === 'draft' || c.status === 'submitted');
  return (
    <>
      {canCount && counts.data && !current ? <StartCount onStarted={setOpen} /> : null}
      <section className="card stack" aria-labelledby="counts-head">
        <h2 id="counts-head">Stock counts</h2>
        {counts.isPending ? <Loading label="Loading counts" /> : null}
        {counts.isError ? (
          <div role="alert" className="banner banner-danger">
            {writeMessage(counts.error)}
          </div>
        ) : null}
        {counts.data && list.length === 0 ? <p className="muted">No counts yet.</p> : null}
        {list.length > 0 ? (
          <table className="data">
            <thead>
              <tr>
                <th scope="col">Count</th>
                <th scope="col">What</th>
                <th scope="col">Started</th>
                <th scope="col">Lines</th>
                <th scope="col">
                  <span className="visually-hidden">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {list.map((c) => (
                <tr key={c.id}>
                  <td>
                    {c.countNo}{' '}
                    <span className={`chip ${STATUS[c.status].chip}`}>
                      {STATUS[c.status].label}
                    </span>
                  </td>
                  <td>
                    {c.scope === 'category'
                      ? c.category
                      : c.scope === 'all'
                        ? 'Everything'
                        : 'Chosen items'}
                  </td>
                  <td>
                    {c.startedBy}
                    <div className="muted">{new Date(c.startedAt).toLocaleString('en-GB')}</div>
                  </td>
                  <td>{c.lineCount}</td>
                  <td>
                    <button
                      type="button"
                      className="btn btn-ghost"
                      onClick={() => {
                        setOpen(c.id);
                      }}
                    >
                      Open <span className="visually-hidden">{c.countNo}</span>
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : null}
      </section>
    </>
  );
}

function StartCount({ onStarted }: { onStarted: (id: string) => void }) {
  const writes = useWritesAllowed();
  const items = useItems({ q: '', category: '', includeArchived: false });
  const [scope, setScope] = useState<'all' | 'category'>('all');
  const [category, setCategory] = useState('');
  const [blind, setBlind] = useState(true);
  const start = useInventoryCommand<{ id: string }>((r) => {
    onStarted(r.id);
  });
  const categories = items.data?.categories ?? [];
  const ok = scope === 'all' || category !== '';
  return (
    <section className="card stack" aria-labelledby="count-start">
      <h2 id="count-start">Start a count</h2>
      <p className="muted">
        Count perishables before opening if you can. Counting during service is fine: what sells
        while you count is kept.
      </p>
      <div className="row">
        <SelectField
          label="Count"
          value={scope}
          options={[
            { value: 'all', label: 'Everything in stock control' },
            { value: 'category', label: 'One category' },
          ]}
          onChange={(v) => {
            setScope(v as 'all' | 'category');
          }}
        />
        {scope === 'category' ? (
          <SelectField
            label="Category"
            value={category}
            options={[
              { value: '', label: 'Choose…' },
              ...categories.map((c) => ({ value: c, label: c })),
            ]}
            onChange={setCategory}
          />
        ) : null}
        <CheckField label="Blind (hide what the book says)" checked={blind} onChange={setBlind} />
      </div>
      <div className="row">
        <button
          type="button"
          className="btn btn-primary"
          disabled={!ok || !writes || start.isPending}
          onClick={() => {
            start.mutate({
              path: '/stock-counts',
              body: { scope, ...(scope === 'category' ? { category } : {}), blind },
            });
          }}
        >
          Start count
        </button>
      </div>
      {start.isError ? (
        <div role="alert" className="banner banner-danger">
          {writeMessage(start.error)}
        </div>
      ) : null}
    </section>
  );
}

function CountView({
  id,
  canCount,
  canApprove,
  onClose,
}: {
  id: string;
  canCount: boolean;
  canApprove: boolean;
  onClose: () => void;
}) {
  const count = useCount(id);
  const c = count.data;
  return (
    <section className="card stack" aria-labelledby="count-head">
      <div className="section-head">
        <h2 id="count-head">{c ? `Count ${c.countNo}` : 'Count'}</h2>
        {c ? (
          <span className={`chip ${STATUS[c.status].chip}`}>{STATUS[c.status].label}</span>
        ) : null}
        <button type="button" className="btn btn-ghost" onClick={onClose}>
          Back to counts
        </button>
      </div>
      {count.isError ? (
        <div role="alert" className="banner banner-danger">
          {writeMessage(count.error)}
        </div>
      ) : null}
      {!c ? <Loading label="Loading the count" /> : null}
      {c?.sentBackReason && c.status === 'draft' ? (
        <div role="status" className="banner banner-warning">
          Sent back for a recount: {c.sentBackReason}
        </div>
      ) : null}
      {c && c.status === 'draft' && canCount ? <Counting count={c} onCancelled={onClose} /> : null}
      {c && c.status !== 'draft' ? <Results count={c} /> : null}
      {c && c.status === 'submitted' ? <Decide count={c} canApprove={canApprove} /> : null}
    </section>
  );
}

function lineFor(count: CountDetail, itemId: string, lotId: string | null): CountLine | undefined {
  return count.lines.find((l) => l.itemId === itemId && l.lotId === lotId);
}

function Counting({ count, onCancelled }: { count: CountDetail; onCancelled: () => void }) {
  const writes = useWritesAllowed();
  const submit = useInventoryCommand();
  const cancel = useInventoryCommand(onCancelled);
  const counted = new Set(count.lines.map((l) => l.itemId)).size;
  return (
    <>
      <p>
        {counted} of {count.items.length} items counted.
        {count.blind ? ' Blind count: enter what is on the shelf.' : ''}
      </p>
      {count.items.map((item) => (
        <ItemToCount key={item.id} countId={count.id} item={item} count={count} />
      ))}
      <div className="row">
        <button
          type="button"
          className="btn btn-primary"
          disabled={count.lines.length === 0 || !writes || submit.isPending}
          onClick={() => {
            submit.mutate({ path: `/stock-counts/${count.id}/submit` });
          }}
        >
          Submit count
        </button>
        <button
          type="button"
          className="btn btn-ghost"
          disabled={!writes || cancel.isPending}
          onClick={() => {
            cancel.mutate({ path: `/stock-counts/${count.id}/cancel` });
          }}
        >
          Cancel count
        </button>
      </div>
      {submit.isError || cancel.isError ? (
        <div role="alert" className="banner banner-danger">
          {writeMessage(submit.error ?? cancel.error)}
        </div>
      ) : null}
    </>
  );
}

function ItemToCount({
  countId,
  item,
  count,
}: {
  countId: string;
  item: CountItem;
  count: CountDetail;
}) {
  return (
    <fieldset className="card stack" aria-label={`Count ${item.name}`}>
      <legend className="visually-hidden">{item.name}</legend>
      <strong>
        {item.name} <span className="muted">{item.sku}</span>
      </strong>
      {item.trackLots ? (
        <>
          {item.lots.map((lot) => (
            <CountInput
              key={lot.id}
              countId={countId}
              item={item}
              lotId={lot.id}
              label={`Lot ${lot.lotCode ?? 'without code'} · expires ${lot.expiryDate ?? 'unknown'}${
                lot.qtyRemaining === null
                  ? ''
                  : ` · book ${formatQty(lot.qtyRemaining, item.baseUom)}`
              }`}
              line={lineFor(count, item.id, lot.id)}
            />
          ))}
          <CountInput
            countId={countId}
            item={item}
            lotId={null}
            newLot
            label="Found in no lot above"
            line={lineFor(count, item.id, null)}
          />
        </>
      ) : (
        <CountInput
          countId={countId}
          item={item}
          lotId={null}
          label={`Counted ${item.name}`}
          line={lineFor(count, item.id, null)}
        />
      )}
    </fieldset>
  );
}

function CountInput({
  countId,
  item,
  lotId,
  label,
  line,
  newLot = false,
}: {
  countId: string;
  item: CountItem;
  lotId: string | null;
  label: string;
  line: CountLine | undefined;
  newLot?: boolean;
}) {
  const writes = useWritesAllowed();
  const [qty, setQty] = useState(line ? String(Number(line.countedQty)) : '');
  const [uom, setUom] = useState<UnitCode>(item.baseUom);
  const [expiry, setExpiry] = useState(line?.newLotExpiry ?? '');
  const save = useInventoryWrite();
  const remove = useInventoryWrite();
  const ok = /^\d{1,10}(\.\d{1,4})?$/.test(qty);
  const submit = (event: SubmitEvent): void => {
    event.preventDefault();
    if (!ok || !writes) return;
    save.mutate({
      path: `/stock-counts/${countId}/lines`,
      body: {
        itemId: item.id,
        ...(lotId ? { lotId } : {}),
        countedQty: qty,
        uom,
        ...(newLot && expiry ? { newLotExpiry: expiry } : {}),
      },
    });
  };
  return (
    <form className="row" onSubmit={submit} noValidate>
      <Field
        label={label}
        inputMode="decimal"
        value={qty}
        error={qty && !ok ? 'A quantity such as 0, 500 or 2.5' : null}
        hint={
          line
            ? `Saved: ${formatQty(line.countedQty, item.baseUom)} by ${line.enteredBy}`
            : undefined
        }
        onChange={(e) => {
          setQty(e.target.value.trim());
        }}
      />
      <SelectField
        label={`Unit for ${label}`}
        value={uom}
        options={unitsFor(item.baseUom).map((u) => ({ value: u, label: u }))}
        onChange={(v) => {
          setUom(v as UnitCode);
        }}
      />
      {newLot ? (
        <Field
          label={`Expiry of stock found in no lot (${item.name})`}
          type="date"
          value={expiry}
          onChange={(e) => {
            setExpiry(e.target.value);
          }}
        />
      ) : null}
      <button
        type="submit"
        className="btn btn-secondary"
        disabled={!ok || !writes || save.isPending}
      >
        Save <span className="visually-hidden">{label}</span>
      </button>
      {line ? (
        <button
          type="button"
          className="btn btn-ghost"
          disabled={!writes || remove.isPending}
          onClick={() => {
            setQty('');
            remove.mutate({ path: `/stock-counts/${countId}/lines/${line.id}`, method: 'DELETE' });
          }}
        >
          Clear <span className="visually-hidden">{label}</span>
        </button>
      ) : null}
      {save.isError ? <span className="field-error">{writeMessage(save.error)}</span> : null}
    </form>
  );
}

function Results({ count }: { count: CountDetail }) {
  const name = (l: CountLine) => {
    const item = count.items.find((i) => i.id === l.itemId);
    const lot = item?.lots.find((x) => x.id === l.lotId);
    const what = item?.name ?? `Item ${l.itemId}`;
    return item?.trackLots ? `${what} · ${lot ? `lot ${lot.lotCode ?? '—'}` : 'no lot'}` : what;
  };
  const uom = (l: CountLine) => count.items.find((i) => i.id === l.itemId)?.baseUom ?? 'pcs';
  const showValue = count.lines.some((l) => l.varianceValue !== null);
  return (
    <table className="data">
      <thead>
        <tr>
          <th scope="col">Item</th>
          <th scope="col">Book</th>
          <th scope="col">Counted</th>
          <th scope="col">Difference</th>
          {showValue ? <th scope="col">Value</th> : null}
          <th scope="col">
            <span className="visually-hidden">Approval</span>
          </th>
        </tr>
      </thead>
      <tbody>
        {count.lines.map((l) => (
          <tr key={l.id}>
            <td>{name(l)}</td>
            <td>{l.bookQty === null ? '—' : formatQty(l.bookQty, uom(l))}</td>
            <td>{formatQty(l.countedQty, uom(l))}</td>
            <td>
              {l.varianceQty === null
                ? '—'
                : `${new Decimal(l.varianceQty).greaterThan(0) ? '+' : ''}${formatQty(l.varianceQty, uom(l))}`}
              {l.postedQty !== null && l.varianceQty !== null && l.postedQty !== l.varianceQty ? (
                <div className="muted">posted {formatQty(l.postedQty, uom(l))} (sold since)</div>
              ) : null}
            </td>
            {showValue ? <td>{l.varianceValue === null ? '—' : rupees(l.varianceValue)}</td> : null}
            <td>
              {l.needsApproval ? <span className="chip chip-warning">Over the limit</span> : null}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** Approve or send back: here with the right, else by an approver's PIN on this device. */
function Decide({ count, canApprove }: { count: CountDetail; canApprove: boolean }) {
  const writes = useWritesAllowed();
  const [approval, setApproval] = useState<ApprovalState>(noApproval);
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const decide = useInventoryCommand();
  const flagged = count.lines.filter((l) => l.needsApproval).length;

  const act = async (kind: 'approve' | 'send-back'): Promise<void> => {
    setError(null);
    let stepUpId: string | undefined;
    if (!canApprove) {
      try {
        stepUpId = await approve({
          action: 'count.variance',
          entityType: 'stock_count',
          entityId: count.id,
          username: approval.username,
          pin: approval.pin,
          reason: reason.trim() || `Count ${count.countNo}`,
        });
      } catch (e) {
        setError(writeMessage(e));
        return;
      }
    }
    decide.mutate({
      path: `/stock-counts/${count.id}/${kind}`,
      body: {
        ...(kind === 'send-back' ? { reason: reason.trim() } : {}),
        ...(stepUpId ? { stepUpId } : {}),
      },
    });
  };
  const ready = writes && !decide.isPending && (canApprove || approvalReady(approval));

  return (
    <div className="stack">
      <p>
        {flagged} line{flagged === 1 ? '' : 's'} over the approval limits (Settings, D-18). Someone
        other than {count.submittedBy ?? 'the submitter'} approves, or sends lines back for a
        recount.
      </p>
      {!canApprove ? (
        <ApprovalFields
          legend="Owner or manager approval"
          value={approval}
          onChange={setApproval}
        />
      ) : null}
      <Field
        label="Reason (needed to send back)"
        maxLength={200}
        value={reason}
        onChange={(e) => {
          setReason(e.target.value);
        }}
      />
      <div className="row">
        <button
          type="button"
          className="btn btn-primary"
          disabled={!ready}
          onClick={() => {
            void act('approve');
          }}
        >
          Approve and post
        </button>
        <button
          type="button"
          className="btn btn-secondary"
          disabled={!ready || reason.trim().length < 3}
          onClick={() => {
            void act('send-back');
          }}
        >
          Send back for recount
        </button>
      </div>
      {error || decide.isError ? (
        <div role="alert" className="banner banner-danger">
          {error ?? writeMessage(decide.error)}
        </div>
      ) : null}
    </div>
  );
}
