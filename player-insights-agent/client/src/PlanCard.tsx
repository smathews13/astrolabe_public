/**
 * The plan the agent proposes before it runs anything, and the two answers to
 * it.
 *
 * Split out of App.tsx when the pages became modules. Ask PIA is its only
 * caller: it is a turn in the transcript, drawn wherever an assistant message
 * carries a plan.
 */
import {
  Alert,
  AlertDescription,
  Badge,
  Button,
  Card,
  CardDescription,
  CardContent,
  CardHeader,
  CardTitle,
} from './ui';
import { useMemo } from 'react';
import { Play, Shield, ShieldCheck } from 'lucide-react';
import { PlanText } from './DataEntityLinks';
import { BrandIcon } from './BrandIcon';
import { productForPlanKind } from './brand-icons';
import { declaredColumns } from './data-entities';
import { AstrolabeMark } from './AstrolabeMark';
import type { AnalysisPlan } from './app-types';

export function PlanCard({
  plan,
  loading,
  resolved,
  onApprove,
  onRevise,
}: {
  plan: AnalysisPlan;
  loading: boolean;
  resolved: boolean;
  onApprove: () => void;
  onRevise: () => void;
}) {
  /**
   * The columns this plan says it will read, taken from the plan's own
   * `Columns: …` lists and applied to every line of it.
   *
   * Collected across the whole plan rather than per step, because the summary
   * names the measure a step further down lists as a column -- "Aggregate
   * active_players … by title" over "Columns: event_date, title_code,
   * active_players" -- and a reader should not see the same identifier set as
   * data in one line and as a word in the line above it.
   */
  const columns = useMemo(() => declaredColumns([plan.summary, ...plan.steps.flatMap((step) => [step.title, step.description])]),
    [plan]
  );
  return (<Card className={`plan-card ${resolved ? 'resolved' : ''}`}>
      <CardHeader>
        <div className="flex items-start gap-3">
          {/* The agent's mark, as on every other turn it takes. It was a workflow
              glyph, which said "plan" rather than "the agent" -- and a mark that
              changes with the kind of turn is not a mark. What kind of turn this
              is has two louder statements of its own directly to the right: the
              badge, and a title reading "Proposed analysis plan". */}
          <div className="agent-avatar">
            <AstrolabeMark size={32} />
          </div>
          {/* `min-w-0`, because a flex child's floor is its content and this
              plan's content is a fully-qualified table name with no spaces in
              it. Without this the header column cannot shrink to the card and
              the row it is in overflows, which on the widest name in the demo
              catalog is about forty pixels of the summary hidden past the edge. */}
          <div className="min-w-0 space-y-2">
            {/* Amber while it waits and green once it is answered, which is the
                one place in this card evaluation and reachability are the right
                two colours: the badge is a verdict on the plan's state, not a
                control, and the buttons that ARE controls are blue below. Both
                are tinted pills with a deep-rung label, because neither hue can
                be type at full strength. */}
            {/* The app's one pill recipe, in the family the state picks: warning
                while the plan is waiting on a decision, positive once it has
                one. It used to declare its own size, weight, radius and padding
                and then a fill per state, which is one of the twenty-one chip
                recipes the astrolabe pass collapses into this one. */}
            <Badge
              variant="outline"
              className={`ast-pill plan-state ast-pill--${resolved ? 'pos' : 'warn'}`}
              data-state={resolved ? 'approved' : 'review'}
            >
              {resolved ? 'Approved' : 'Review needed'}
            </Badge>
            <CardTitle className="plan-title">Proposed analysis plan</CardTitle>
            {/* Inline Markdown, not blocks. The plan is already structured --
                the steps below are its sections -- so what is left for Markdown
                here is a backticked column name in a sentence, and a heading
                would be a second sectioning of something already sectioned.

                The plan names the tables it proposes to read and the columns it
                proposes to read from them, and it names them in prose. Passing
                `sources={[]}` left every one of them as grey text a reader had
                to copy out and look up by hand. PlanText links the tables this
                deployment tracks and bolds the rest; see DataEntityLinks.tsx for
                why a plan's candidate set is the tracked list rather than the
                sources an answer declared. */}
            <CardDescription>
              <PlanText text={plan.summary} columns={columns} />
            </CardDescription>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="plan-steps">
          {plan.steps.map((step, index) => {
            const product = productForPlanKind(step.kind);
            return (<div className="plan-step" key={step.id}>
              {/* Mono, because these are read down a column: one numeral per
                  step at the same offset, so the digits of 9 and 10 sit under
                  each other. The stylesheet used to ask DM Sans for tabular
                  figures instead, which does nothing -- the face declares no
                  `tnum` feature and its digits are proportional. */}
              <span className="ast-num">{index + 1}</span>
              <div>
                {/* The title on its own line rather than run into the sentence
                    after it. The agent writes these unpunctuated -- "Confirm
                    metric definitions" -- so setting the two inline produces one
                    run-on line whose first clause has no full stop, and the lead
                    stops reading as a lead.

                    Titles name tables as often as the detail under them does --
                    "Read <your_catalog>.….gold_title_daily_summary" is a
                    title, not a sentence -- so the same treatment applies here.
                    A linked name inside the bold lead keeps the link's own 500
                    rather than the lead's 700; it is still the only blue,
                    underlined run in the line, which is what marks it. */}
                {/* The product this step will call, where the step's kind names
                    one. Decorative: the line it sits on says what the step does,
                    and the mark is there so a reader can see at a glance that
                    the plan reaches the dictionary before it reaches the
                    warehouse. Context and synthesis steps carry none, because
                    neither is a call on a Databricks product -- see
                    productForPlanKind. */}
                <strong>
                  {product && <BrandIcon product={product} size={14} />}
                  <PlanText text={step.title} columns={columns} />
                </strong>
                <p>
                  <PlanText text={step.description} columns={columns} />
                </p>
              </div>
            </div>
            );
          })}
        </div>
        <div className="plan-context">
          {plan.uses_conversation_context && <Badge variant="secondary">Uses conversation context</Badge>}
          {plan.uses_attachment_context && <Badge variant="secondary">Uses attached reports</Badge>}
        </div>
        {/* Green: what this alert reports is that nothing has run, or that what
            ran is what you approved. The check arrives with the approval, so an
            unanswered plan gets the plain shield -- a tick over "no query has
            run yet" would be claiming something had been confirmed. */}
        <Alert className="plan-reassurance">
          {resolved ? <ShieldCheck /> : <Shield />}
          <AlertDescription>
            <p>
              {resolved
                ? 'You approved this plan. The analysis below was produced by running these steps.'
                : 'No analytical query runs until you approve this plan. You can revise the request first.'}
            </p>
          </AlertDescription>
        </Alert>
        {!resolved && (<div className="plan-actions">
            <Button type="button" variant="outline" onClick={onRevise} disabled={loading}>
              Revise request
            </Button>
            <Button type="button" onClick={onApprove} disabled={loading}>
              <Play /> Approve and run
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
