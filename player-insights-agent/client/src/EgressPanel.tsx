/**
 * What leaves this deployment, what an administrator may turn off, and what the
 * catalog says about the tables behind it.
 *
 * Three cards on the Settings page, behind the experimental toggle, and mounted
 * only for an administrator. The server refuses the two admin routes whatever is
 * drawn here, so hiding the panel is about not offering dead controls rather than
 * about the permission itself.
 *
 * ── THE PANEL'S ONE JOB IS TO NOT OVERSTATE ITSELF ──
 *
 * A control surface listing eight switches reads as eight controls. Two of them
 * bite today. So every row carries what the app can actually do about that path,
 * the paths that cannot be controlled are listed WITHOUT switches rather than
 * omitted, and the words for all of it come from `egress-panel.ts`, where a test
 * pins them. Omitting the uncontrollable paths would be the more flattering
 * design and the dishonest one: an administrator is entitled to know that
 * selecting an answer and screenshotting a chart are ways out that no switch on
 * this page touches.
 */

import { useCallback, useEffect, useState } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle, Switch } from './ui';
import {
  EGRESS_PATHS,
  egressAllowed,
  type EgressChannel,
  type EgressClassificationPayload,
  type EgressControls,
  type EgressControlsPayload,
  type EgressLogPayload,
  type EgressPath,
} from '../../shared/egress-contract';
import { adoptEgressControls, egressControlsSnapshot } from './egress-policy';
import {
  classificationFacts,
  classificationPill,
  CLASSIFICATION_CAPTION,
  controlAccessibleName,
  CONTROL_WRITE_FAILED,
  emptyLogNote,
  enforcementPill,
  eventFacts,
  OUTCOME_PILL,
  pathMeta,
  readStateTone,
  type Pill,
} from './egress-panel';
import { whenLabel } from './monitoring-view';

/** The separator, written once. The design allows this one and no em dash. */
function Facts({ facts }: { facts: readonly string[] }) {
  if (facts.length === 0) return null;
  return <p className="egress-facts">{facts.join(' · ')}</p>;
}

function PillChip({ pill }: { pill: Pill }) {
  return <span className={`ast-pill ast-pill--${pill.tone}`}>{pill.label}</span>;
}

/* ── Controls ──────────────────────────────────────────────────────────────── */

function ControlRow({
  path,
  allowed,
  failed,
  onChange,
}: {
  path: EgressPath;
  allowed: boolean;
  failed: boolean;
  onChange: (allowed: boolean) => void;
}) {
  return (<div className="settings-row egress-row">
      <div className="egress-row-body">
        <p className="settings-row-label">
          {path.label} <PillChip pill={enforcementPill(path)} />
          {failed ? <span className="ast-pill ast-pill--neg">{CONTROL_WRITE_FAILED}</span> : null}
        </p>
        <Facts facts={pathMeta(path)} />
      </div>
      <Switch
        checked={allowed}
        onCheckedChange={onChange}
        aria-label={controlAccessibleName(path)}
      />
    </div>
  );
}

/**
 * A path with no switch, because there is nothing to switch.
 *
 * Same row shape, no control. The absence is the statement: a disabled toggle
 * would read as something that could be enabled by somebody with more authority,
 * and no authority closes these.
 */
function UncontrollableRow({ path }: { path: EgressPath }) {
  return (<div className="settings-row egress-row">
      <div className="egress-row-body">
        <p className="settings-row-label">
          {path.label} <PillChip pill={enforcementPill(path)} />
        </p>
        <Facts facts={pathMeta(path)} />
      </div>
    </div>
  );
}

/* ── The panel ─────────────────────────────────────────────────────────────── */

export function EgressPanel() {
  const [controls, setControls] = useState<EgressControls>(() => egressControlsSnapshot());
  const [stored, setStored] = useState(false);
  const [failed, setFailed] = useState<EgressChannel | null>(null);
  const [log, setLog] = useState<EgressLogPayload | null>(null);
  const [classification, setClassification] = useState<EgressClassificationPayload | null>(null);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    let live = true;
    void (async () => {
      try {
        const response = await fetch('/api/egress/controls', { headers: { Accept: 'application/json' } });
        if (!response.ok || !live) return;
        const payload = (await response.json()) as EgressControlsPayload;
        if (!live || !payload?.controls) return;
        setControls(payload.controls);
        setStored(Boolean(payload.stored));
        adoptEgressControls(payload.controls);
      } catch {
        // The snapshot the panel opened with stands. It is the build's defaults,
        // and `stored` stays false, which is what the card says.
      }
    })();
    return () => {
      live = false;
    };
  }, []);

  useEffect(() => {
    let live = true;
    void (async () => {
      try {
        const response = await fetch('/api/egress/admin/events?limit=50', {
          headers: { Accept: 'application/json' },
        });
        if (!response.ok || !live) return;
        const payload = (await response.json()) as EgressLogPayload;
        if (live) {
          setLog(payload);
          setNow(Date.now());
        }
      } catch {
        if (live) setLog({ events: [], readState: 'unavailable', limit: 0, truncated: false, readAt: '' });
      }
    })();
    return () => {
      live = false;
    };
  }, []);

  useEffect(() => {
    let live = true;
    void (async () => {
      try {
        const response = await fetch('/api/egress/admin/classification', {
          headers: { Accept: 'application/json' },
        });
        if (!response.ok || !live) return;
        const payload = (await response.json()) as EgressClassificationPayload;
        if (live) setClassification(payload);
      } catch {
        // Left null. The card renders nothing rather than claiming the catalog is
        // silent, which is the distinction the whole classification design turns on.
      }
    })();
    return () => {
      live = false;
    };
  }, []);

  const move = useCallback(async (channel: EgressChannel, allowed: boolean) => {
    // Moved on screen first. A switch that waits for a round trip before it moves
    // reads as an unresponsive control, and the failure is reported beside it.
    const optimistic = { ...controls, [channel]: allowed };
    setControls(optimistic);
    setFailed(null);
    try {
      const response = await fetch('/api/egress/admin/controls', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ channel, allowed }),
      });
      if (!response.ok) {
        setControls(controls);
        setFailed(channel);
        return;
      }
      const payload = (await response.json()) as EgressControlsPayload;
      if (payload?.controls) {
        setControls(payload.controls);
        setStored(Boolean(payload.stored));
        adoptEgressControls(payload.controls);
      }
    } catch {
      setControls(controls);
      setFailed(channel);
    }
  }, [controls]);

  const controllable = EGRESS_PATHS.filter((path) => path.enforcement !== 'uncontrollable');
  const uncontrollable = EGRESS_PATHS.filter((path) => path.enforcement === 'uncontrollable');
  const events = log?.events ?? [];

  return (<>
      <Card>
        <CardHeader>
          <CardTitle>What may leave</CardTitle>
          <CardDescription>
            {stored ? 'This deployment' : 'Build defaults'}
          </CardDescription>
        </CardHeader>
        <CardContent>
          {controllable.map((path) => (
            <ControlRow
              key={path.channel}
              path={path}
              allowed={egressAllowed(controls, path.channel)}
              failed={failed === path.channel}
              onChange={(allowed) => void move(path.channel, allowed)}
            />
          ))}
          {uncontrollable.map((path) => (
            <UncontrollableRow key={path.channel} path={path} />
          ))}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>What has left</CardTitle>
          {/* The count is a fact, and zero never renders as a count. */}
          <CardDescription>
            {events.length > 0 ? (
              <>
                <span className="ast-num">{events.length}</span>
                {log?.truncated ? ' most recent' : ''}
              </>
            ) : (
              <span className={`ast-pill ast-pill--${readStateTone(log?.readState ?? 'read')}`}>
                {emptyLogNote(log?.readState ?? 'read')}
              </span>
            )}
          </CardDescription>
        </CardHeader>
        {events.length > 0 ? (
          <CardContent>
            <ul className="egress-log">
              {events.map((event) => (
                <li key={event.id} className="egress-log-row">
                  <div className="egress-row-body">
                    <p className="settings-row-label">
                      <span className="ast-mono">{event.actor}</span>{' '}
                      <PillChip pill={OUTCOME_PILL[event.outcome]} />
                    </p>
                    <Facts facts={eventFacts(event)} />
                  </div>
                  <span className="egress-when ast-num">{whenLabel(event.occurredAt, now)}</span>
                </li>
              ))}
            </ul>
          </CardContent>
        ) : null}
      </Card>

      {classification ? (
        <Card>
          <CardHeader>
            <CardTitle>What the catalog says</CardTitle>
            <CardDescription>{CLASSIFICATION_CAPTION}</CardDescription>
          </CardHeader>
          <CardContent>
            {classification.blocked ? (
              <p className="egress-facts">{classification.blocked}</p>
            ) : (
              classification.tables.map((table) => (
                <div key={table.table} className="settings-row egress-row">
                  <div className="egress-row-body">
                    <p className="settings-row-label">
                      <span className="ast-mono">{table.table}</span>{' '}
                      <PillChip pill={classificationPill(table)} />
                    </p>
                    <Facts facts={classificationFacts(table)} />
                  </div>
                </div>
              ))
            )}
          </CardContent>
        </Card>
      ) : null}
    </>
  );
}
