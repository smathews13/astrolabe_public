/**
 * Adding and removing the assets the agent may consider.
 *
 * THE CARD'S JOB IS PARTLY TO CORRECT AN ASSUMPTION. A customer reads "add a
 * connection" as "grant access", so `CONNECTION_SCOPE_NOTE` sits under the heading
 * once, and removal asks for confirmation carrying what actually stops working
 * rather than a generic warning.
 *
 * Removal is never destructive: a removed asset stays listed as removed with a way
 * to put it back, because this app is usually mid demonstration when somebody
 * removes the wrong thing.
 *
 * THE PALETTE IS NO LONGER IN THIS FILE, and neither is the operating system's
 * menu. Both arrived with the plane as working markup to be restyled: the colours
 * were inline style objects written hex by hex, and the kind picker was a native
 * `<select>`, which opens a menu the platform draws and the app cannot style. The
 * geometry is now `.plane-*` in `connections.css` and the picker is the same Radix
 * Select the rest of the app opens, through `./ui`.
 *
 * None of what the card DOES moved. Every string is still
 * `declared-connection-view.ts`'s, the list is still addable and removable, a
 * removal still offers "Put back", and adding still grants nobody anything.
 */
import { useState } from 'react';
import { Select, SelectContent, SelectItem, SelectTrigger } from './ui';
import {
  ADDABLE_KINDS,
  CONNECTION_LIST_TITLE,
  CONNECTION_SCOPE_NOTE,
  REMOVE_LABEL,
  RESTORE_LABEL,
  connectionCounts,
  orderConnections,
} from './declared-connection-view';
import type { ConnectionEntry } from './connection-model';

export interface DeclaredConnectionsCardProps {
  entries?: ConnectionEntry[];
  /** Whether the store that holds these is answering. */
  storeAvailable?: boolean;
  onChanged: () => void;
}

export function DeclaredConnectionsCard({
  entries,
  storeAvailable = true,
  onChanged,
}: DeclaredConnectionsCardProps) {
  const [adding, setAdding] = useState(false);
  const [id, setId] = useState('');
  const [label, setLabel] = useState('');
  const [kind, setKind] = useState(ADDABLE_KINDS[0].kind);
  const [value, setValue] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  /** The id awaiting a confirmed removal, so the impact is read before it happens. */
  const [confirming, setConfirming] = useState('');

  const listed = orderConnections(entries ?? []);
  const counts = connectionCounts(listed);
  const chosenKind = ADDABLE_KINDS.find((entry) => entry.kind === kind) ?? ADDABLE_KINDS[0];

  async function add() {
    setBusy(true);
    setError('');
    try {
      const response = await fetch('/api/settings/connections', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: id.trim(), label: label.trim(), kind, value: value.trim() }),
      });
      if (!response.ok) {
        const body = (await response.json().catch(() => ({}))) as { detail?: string };
        setError(body.detail ?? 'The asset was not added.');
        return;
      }
      setId('');
      setLabel('');
      setValue('');
      setAdding(false);
      onChanged();
    } finally {
      setBusy(false);
    }
  }

  async function act(entryId: string, method: 'DELETE' | 'POST', suffix = '') {
    setBusy(true);
    setError('');
    try {
      const response = await fetch(`/api/settings/connections/${encodeURIComponent(entryId)}${suffix}`, {
        method,
      });
      if (!response.ok) {
        const body = (await response.json().catch(() => ({}))) as { detail?: string };
        setError(body.detail ?? 'That did not take effect.');
        return;
      }
      setConfirming('');
      onChanged();
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="plane-card" aria-label={CONNECTION_LIST_TITLE}>
      <div className="plane-card-head">
        <span>{CONNECTION_LIST_TITLE}</span>
        <span className="plane-card-head-aside">
          {/* Zero never renders: `connectionCounts` returns an empty string for a
              list with nothing in either state, and an empty span beside the
              heading reads as a count that failed to load. */}
          {counts ? <span className="plane-count ast-num">{counts}</span> : null}
          <button type="button" className="plane-button-quiet" onClick={() => setAdding((open) => !open)}>
            {adding ? 'Cancel' : 'Add'}
          </button>
        </span>
      </div>

      <div className="plane-card-body">
        {/* The most important string in the feature, said once, under the heading:
            listing an asset lets the agent consider it and grants nobody
            anything. Asserted by a test rather than trusted to survive editing. */}
        <span className="plane-note">{CONNECTION_SCOPE_NOTE}</span>

        {!storeAvailable ? (
          <span className="plane-error">
            The store that holds this list is not answering, so nothing can be added or removed.
          </span>
        ) : null}

        {adding ? (
          <div className="plane-form">
            <div className="plane-form-pair">
              <input
                className="plane-field"
                value={id}
                onChange={(event) => setId(event.target.value)}
                placeholder="name"
                aria-label="Name"
              />
              {/* The app's own menu rather than the platform's. The trigger is a
                  combobox whose accessible name is "Kind" and whose value is the
                  chosen label, so a reader hears the same thing the native
                  control said. */}
              <Select value={kind} onValueChange={setKind}>
                <SelectTrigger className="plane-field plane-field-select" aria-label="Kind">
                  <span>{chosenKind.label}</span>
                </SelectTrigger>
                <SelectContent position="popper" align="start" sideOffset={4}>
                  {ADDABLE_KINDS.map((entry) => (
                    <SelectItem key={entry.kind} value={entry.kind}>
                      {entry.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <input
              className="plane-field ast-mono"
              value={value}
              onChange={(event) => setValue(event.target.value)}
              placeholder="catalog.schema.table"
              aria-label="Identifier"
            />
            <input
              className="plane-field"
              value={label}
              onChange={(event) => setLabel(event.target.value)}
              placeholder="label"
              aria-label="Label"
            />
            <span>
              <button
                type="button"
                className="plane-button"
                disabled={busy || !id.trim() || !value.trim() || !storeAvailable}
                onClick={() => void add()}
              >
                Add
              </button>
            </span>
          </div>
        ) : null}

        {error ? <span className="plane-error">{error}</span> : null}

        {listed.map((entry) => {
          const removed = entry.connection.state === 'withdrawn';
          return (
            <div key={entry.connection.id} className="plane-stack">
              <div className="plane-row" data-state={entry.connection.state}>
                <span className="plane-row-name">{entry.connection.label}</span>
                <span className="plane-row-value ast-mono" title={entry.connection.value}>
                  {entry.connection.value}
                </span>
                {/* A removed asset keeps its way back. This app is usually mid
                    demonstration when somebody removes the wrong thing, so the
                    row stays and offers "Put back" rather than disappearing. */}
                {removed ? (
                  <button
                    type="button"
                    className="plane-button-quiet"
                    disabled={busy || !storeAvailable}
                    onClick={() => void act(entry.connection.id, 'POST', '/restore')}
                  >
                    {RESTORE_LABEL}
                  </button>
                ) : (
                  <button
                    type="button"
                    className="plane-button-quiet"
                    disabled={busy || !storeAvailable}
                    onClick={() => setConfirming(entry.connection.id)}
                  >
                    {REMOVE_LABEL}
                  </button>
                )}
              </div>

              {confirming === entry.connection.id ? (
                <div className="plane-confirm">
                  <span className="plane-confirm-headline">{entry.impact.headline}</span>
                  <ul className="plane-confirm-list">
                    {entry.impact.consequences.map((line) => (
                      <li key={line}>{line}</li>
                    ))}
                  </ul>
                  <span className="plane-confirm-actions">
                    <button
                      type="button"
                      className="plane-button-quiet"
                      disabled={busy}
                      onClick={() => void act(entry.connection.id, 'DELETE')}
                    >
                      {REMOVE_LABEL}
                    </button>
                    <button
                      type="button"
                      className="plane-button-quiet"
                      disabled={busy}
                      onClick={() => setConfirming('')}
                    >
                      Keep
                    </button>
                  </span>
                </div>
              ) : null}
            </div>
          );
        })}
      </div>
    </section>
  );
}
